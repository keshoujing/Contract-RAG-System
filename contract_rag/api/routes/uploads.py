"""Contract ingest wizard: upload -> tag approval page -> extract -> confirm.

Pure-archive V1: no body parsing. The approval-page step runs the LLM extraction
**synchronously** so the front end can read the extracted fields immediately
afterwards (it does not poll). Page thumbnails render best-effort in the
background; they back the optional ``/pages`` endpoint (the wizard itself uses
page icons). Endpoints are mounted under ``/api/ingest`` to match the front-end
client (``frontend/src/api/client.ts``).
"""
from __future__ import annotations

import json
import logging
from datetime import date

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse

from contract_rag.api import projections, rendering
from contract_rag.api import storage_paths as sp
from contract_rag.api.schemas import ConfirmRequest, PageTagsRequest
from contract_rag.ingest.approval import extract_approval
from contract_rag.ingest.approval_store import persist_approval, resolve_contract_id
from contract_rag.registry import assign_file_no
from contract_rag.storage import db

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_META_KEYS = ("_per_field_confidence", "_per_field_source_span")


def _coerce_amount(value):
    """Best-effort parse of an amount that may arrive as a formatted string."""
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        cleaned = value.replace("$", "").replace(",", "").replace("¥", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return value
    return value


def _coerce_term_months(value):
    """Pricing term in months: None=unspecified, 0=one-time, N=N months.

    Accepts the wizard's string form ("" / "0" / "<n>"); rejects negatives.
    """
    if value in (None, "", "null"):
        return None
    try:
        months = int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return None
    return months if months >= 0 else None


def _render_thumbnails(task_id: str, pdf_path) -> None:
    """Best-effort background render of page thumbnails (the wizard uses icons)."""
    try:
        rendering.render_thumbnails(pdf_path, sp.pages_dir(sp.upload_dir(task_id)))
    except Exception:  # noqa: BLE001 — thumbnails are optional; never fail ingest on them
        logger.exception("thumbnail render failed for task %s", task_id)


@router.post("/ingest/upload")
async def upload_ingest(file: UploadFile, background: BackgroundTasks) -> dict:
    name = (file.filename or "").lower()
    if not name.endswith(".pdf") and file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="PDF only")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="File too large (50MB max)")

    task_id = db.create_task()
    udir = sp.upload_dir(task_id)
    udir.mkdir(parents=True, exist_ok=True)
    pdf_path = sp.signed_pdf(udir)
    pdf_path.write_bytes(data)
    try:
        n = rendering.page_count(pdf_path)
    except Exception:  # noqa: BLE001
        logger.exception("could not read uploaded PDF for task %s", task_id)
        db.update_task_stage(task_id, "failed", status="failed", error_message="Could not read PDF")
        raise HTTPException(status_code=400, detail="Could not read PDF")

    background.add_task(_render_thumbnails, task_id, pdf_path)
    return {"task_id": task_id, "page_count": n, "filename": file.filename}


@router.post("/ingest/{task_id}/page-tags")
def submit_page_tags(task_id: str, body: PageTagsRequest) -> dict:
    """Accept per-page role tags, validate coverage, extract from first approval page SYNCHRONOUSLY.

    The front end calls this then immediately reads ``GET /ingest/{task_id}``,
    so extraction must complete before this returns.
    """
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    pdf = sp.signed_pdf(sp.upload_dir(task_id))
    n = rendering.page_count(pdf)
    tagged = {int(p) for p in body.tags}
    if tagged != set(range(1, n + 1)):
        raise HTTPException(status_code=422, detail="Every page must be tagged with a role")
    approval_pages = sorted(int(p) for p, r in body.tags.items() if r == "approval")
    contract_pages = [int(p) for p, r in body.tags.items() if r == "contract"]
    if not approval_pages:
        raise HTTPException(status_code=422, detail="Tag at least one approval page")
    if not contract_pages:
        raise HTTPException(status_code=422, detail="Tag at least one contract page")

    db.update_task_stage(task_id, "llm_extraction", status="running")
    try:
        fields = extract_approval(pdf, approval_pages[0])
    except Exception:  # noqa: BLE001
        logger.exception("approval extraction failed for task %s", task_id)
        db.update_task_stage(task_id, "failed", status="failed", error_message="Extraction failed")
        raise HTTPException(status_code=502, detail="Approval-page extraction failed, please retry")
    db.set_task_extraction(task_id, approval_page=approval_pages[0], extraction=fields)
    db.set_task_page_tags(task_id, body.tags)
    db.update_task_stage(task_id, "awaiting_user_confirmation")
    return {"task_id": task_id, "stage": "awaiting_user_confirmation"}


@router.get("/ingest/{task_id}")
def get_ingest(task_id: str) -> dict:
    """Poll/read task state. Returns the flat field shape the front end expects."""
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    out = {
        "task_id": task_id,
        "stage": task["stage"],
        "status": task["status"],
        "error": task.get("error_message"),
        "fields": {},
        "_per_field_confidence": {},
        "_per_field_source_span": {},
    }
    if task.get("extraction"):
        extraction = json.loads(task["extraction"])
        out["_per_field_confidence"] = extraction.get("_per_field_confidence", {}) or {}
        out["_per_field_source_span"] = extraction.get("_per_field_source_span", {}) or {}
        fields = {k: v for k, v in extraction.items() if k not in _META_KEYS}
        # the front end keys registration fields by contract_id, not contract_number
        fields["contract_id"] = resolve_contract_id(extraction) or ""
        out["fields"] = fields
    return out


@router.get("/ingest/{task_id}/pages/{page_no}")
def get_ingest_page(task_id: str, page_no: int) -> FileResponse:
    try:
        path = sp.page_png(sp.upload_dir(task_id), page_no)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad page")
    if not path.exists():
        raise HTTPException(status_code=404, detail="page not found")
    return FileResponse(str(path), media_type="image/png")


@router.post("/ingest/{task_id}/confirm")
def confirm_ingest(task_id: str, body: ConfirmRequest) -> dict:
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")

    # Merge user-confirmed fields over the stored extraction so fields the form
    # does not surface (currency, petition_date, contract_type, ...) survive.
    stored = json.loads(task["extraction"]) if task.get("extraction") else {}
    merged = {**stored, **dict(body.fields)}
    if "amount" in merged:
        merged["amount"] = _coerce_amount(merged["amount"])
    if "term_months" in merged:
        merged["term_months"] = _coerce_term_months(merged["term_months"])

    contract_id = str(merged.get("contract_id") or "").strip()
    if not contract_id:
        raise HTTPException(status_code=400, detail="Missing contract number")

    exists = db.contract_exists(contract_id)
    if exists and not body.overwrite:
        raise HTTPException(status_code=409, detail={"conflict": "duplicate", "contract_id": contract_id})
    if exists and body.overwrite:
        db.delete_contract(contract_id)
        sp.remove_contract_dir(contract_id)

    pdf = sp.signed_pdf(sp.upload_dir(task_id))
    page_count = rendering.page_count(pdf) if pdf.exists() else None

    persist_approval(merged, fallback_id=contract_id)
    db.upsert_contract(
        contract_id,
        status="active",
        effective_date=body.effective_date,
        expiration_date=body.expiration_date,
        page_count=page_count,
    )

    if task.get("page_tags"):
        tags = json.loads(task["page_tags"])
        db.insert_pages(contract_id, [
            {"page_no": int(p), "page_type": role, "route": None, "avg_confidence": None}
            for p, role in tags.items()
        ])

    assign_file_no(contract_id, category=body.category)

    sp.promote_upload(task_id, contract_id)
    db.update_task_stage(task_id, "done", status="done", contract_id=contract_id)

    contract = db.get_contract(contract_id)
    signed = sp.signed_pdf(sp.contract_dir(contract_id))
    size = signed.stat().st_size if signed.exists() else None
    return projections.to_contract_row(contract, signed_pdf_size=size, today=date.today())
