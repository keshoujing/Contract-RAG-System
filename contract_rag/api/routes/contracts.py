"""Ledger read endpoints, spreadsheet export, and signed.pdf download."""
from __future__ import annotations

import io
import logging
from datetime import date

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response

from contract_rag.api import projections
from contract_rag.api import rendering
from contract_rag.api import storage_paths as sp
from contract_rag.api.schemas import BatchRequest, PatchContractRequest
from contract_rag.storage import db

logger = logging.getLogger(__name__)

router = APIRouter()

_EXPORT_HEADERS = [
    "Contract No.", "Counterparty", "Project Name", "Amount", "Currency",
    "Department", "Petitioner", "Registered Date", "Effective Date",
    "Expiration Date", "File No.", "File Name", "Status",
]

_EDITABLE = (
    "counterparty", "project_name", "department", "petitioner",
    "contract_type", "amount", "currency", "effective_date",
    "expiration_date", "brief_description",
)


def _signed_size(contract_id: str) -> int | None:
    pdf = sp.signed_pdf(sp.contract_dir(contract_id))
    return pdf.stat().st_size if pdf.exists() else None


def _row(contract: dict) -> dict:
    return projections.to_contract_row(
        contract, signed_pdf_size=_signed_size(contract["contract_id"]), today=date.today()
    )


def _build_ledger_xlsx(rows: list[dict]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(_EXPORT_HEADERS)
    for c in rows:
        r = _row(c)
        ws.append([
            r["contract_id"], r["counterparty"], r["project_name"], r["amount"], r["currency"],
            r["department"], r["petitioner"], r["petition_date"], r["effective_date"] or "",
            r["expiration_date"] or "", r["file_no"], r["file_name"], r["status"],
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _xlsx_response(data: bytes) -> Response:
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="contract-ledger.xlsx"'},
    )


@router.get("/contracts")
def list_contracts(q: str | None = None, department: str | None = None,
                   status: str | None = None, year: str | None = None,
                   sort: str | None = None) -> dict:
    rows = db.list_contracts()
    filtered = projections.apply_contract_query(
        rows, q=q, department=department, status=status, year=year, sort=sort, today=date.today()
    )
    data = [_row(c) for c in filtered]
    return {"data": data, "total": len(data)}


@router.get("/contracts/export")
def export_contracts(q: str | None = None, department: str | None = None,
                     status: str | None = None, year: str | None = None,
                     sort: str | None = None) -> Response:
    rows = db.list_contracts()
    filtered = projections.apply_contract_query(
        rows, q=q, department=department, status=status, year=year, sort=sort, today=date.today()
    )
    return _xlsx_response(_build_ledger_xlsx(filtered))


# NOTE: /contracts/batch must be declared before /contracts/{contract_id} so
# that "batch" is not captured as a contract_id path parameter.
@router.post("/contracts/batch")
def batch_contracts(body: BatchRequest) -> Response:
    selected = set(body.ids)
    rows = [c for c in db.list_contracts() if c["contract_id"] in selected]
    if body.action == "export":
        return _xlsx_response(_build_ledger_xlsx(rows))
    for c in rows:
        db.delete_contract(c["contract_id"])
        sp.remove_contract_dir(c["contract_id"])
    return JSONResponse({"deleted": len(rows)})


@router.patch("/contracts/{contract_id}")
def patch_contract(contract_id: str, body: PatchContractRequest) -> dict:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    changes = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k in _EDITABLE}
    if changes:
        db.upsert_contract(contract_id, **changes)
    return _row(db.get_contract(contract_id))


@router.delete("/contracts/{contract_id}", status_code=204)
def delete_contract_endpoint(contract_id: str) -> None:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    db.delete_contract(contract_id)
    sp.remove_contract_dir(contract_id)
    return None


@router.get("/contracts/{contract_id}")
def get_contract(contract_id: str) -> dict:
    contract = db.get_contract(contract_id)
    if contract is None:
        raise HTTPException(status_code=404, detail="contract not found")
    return _row(contract)


@router.get("/contracts/{contract_id}/pages/{page_no}")
def get_contract_page(contract_id: str, page_no: int) -> FileResponse:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")

    cdir = sp.contract_dir(contract_id)
    try:
        page = sp.page_png(cdir, page_no)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad page")

    if not page.exists():
        pdf = sp.signed_pdf(cdir)
        if pdf.exists():
            try:
                rendering.render_thumbnails(pdf, sp.pages_dir(cdir))
            except Exception:  # noqa: BLE001 - page preview is best-effort
                logger.exception("page render failed for %s page %s", contract_id, page_no)
        if not page.exists():
            raise HTTPException(status_code=404, detail="page not found")

    return FileResponse(str(page), media_type="image/png")


@router.get("/contracts/{contract_id}/file")
def download_contract(contract_id: str, scope: str = "full") -> Response:
    from contract_rag.api.pdf_subset import subset_pdf_bytes

    pdf = sp.signed_pdf(sp.contract_dir(contract_id))
    if not pdf.exists():
        raise HTTPException(status_code=404, detail="file not found")

    if scope == "contract":
        contract_pages = [
            p["page_no"] for p in db.get_pages(contract_id) if p["page_type"] == "contract"
        ]
        if contract_pages:
            try:
                data = subset_pdf_bytes(pdf, contract_pages)
            except ValueError:
                data = None
            if data is not None:
                return Response(
                    content=data,
                    media_type="application/pdf",
                    headers={
                        "Content-Disposition": f'attachment; filename="{contract_id}-contract.pdf"'
                    },
                )

    return FileResponse(str(pdf), media_type="application/pdf", filename=f"{contract_id}.pdf")
