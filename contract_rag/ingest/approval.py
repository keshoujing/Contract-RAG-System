"""Approval-page structured extraction: page image -> contract metadata JSON.

Per ``memory/ingestion_pipeline.md`` decision 4, the approval page (a fixed
"China Jushi USA Contract Approval Form") is fed *whole* (page image) to a small
LLM that must emit a strict JSON object. The extracted ``contract_number``
becomes the system ``contract_id`` (NOT the filename), and the other fields seed
the SQLite ``contracts`` row. The model is forced to always return a best-guess
value plus a per-field confidence so the front end can flag low-confidence
fields for user correction rather than make the user fill a blank form.

Cost note: this is a cheap structured task — it runs on the flash tier
(``models.approval``), never the pro chat model.

The pure part (``parse_approval_fields``) is unit-testable; the render + Gemini
call are the I/O boundary.
"""
from __future__ import annotations

import logging
import pathlib

from contract_rag.ingest.ocr import render_page_png
from contract_rag.ingest.vision import encode_bytes_data_url, extract_text, parse_json_block

logger = logging.getLogger(__name__)

# Fields we keep from the model response (decision 4 schema). Anything else the
# model invents is dropped so the SQLite row shape stays fixed.
_STR_FIELDS = (
    "contract_number",
    "counterparty",
    "currency",
    "project_name",
    "department",
    "petitioner",
    "petition_date",
    "brief_description",
    "contract_type",
)
_META_FIELDS = ("_per_field_confidence", "_per_field_source_span")


def _coerce_amount(value) -> float | None:
    """Parse an amount that may arrive as a number or a string like ``$39,041.60``."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = "".join(ch for ch in str(value) if ch.isdigit() or ch == ".")
    if not cleaned or cleaned == ".":
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_approval_fields(raw: str) -> dict:
    """Parse a Gemini approval-extraction response into the fixed field shape.

    Unknown keys are dropped; ``amount`` is coerced to a float. A malformed
    response raises ``ValueError`` (the caller decides how to degrade) — unlike
    OCR, a missing approval page means no ``contract_id``, so it should surface.
    """
    data = parse_json_block(raw)  # raises ValueError on unparseable input

    out: dict = {}
    for key in _STR_FIELDS:
        value = data.get(key)
        out[key] = value if (value is None or isinstance(value, str)) else str(value)
    out["amount"] = _coerce_amount(data.get("amount"))
    for key in _META_FIELDS:
        if isinstance(data.get(key), dict):
            out[key] = data[key]
    return out


# --------------------------------------------------------------------------- #
# I/O boundary: render the approval page and extract fields with Gemini (Vertex)
# --------------------------------------------------------------------------- #

_APPROVAL_PROMPT = """You are extracting structured metadata from ONE scanned
"China Jushi USA Contract Approval Form" page.

Return ONLY a JSON object with EXACTLY these keys (no prose, no code fence):

{
  "contract_number":   string | null,   // the "Contract Number" cell value
  "counterparty":      string | null,   // "Seller's Party"
  "amount":            number | null,    // "Contract Amount" as a number, no $ or commas
  "currency":          string | null,   // infer from the amount symbol ($ -> "USD")
  "project_name":      string | null,   // "Project Name"
  "department":        string | null,   // "Requisition Department"
  "petitioner":        string | null,   // "Petitioner"
  "petition_date":     string | null,   // the "Date" next to Petitioner, as YYYY-MM-DD
  "brief_description": string | null,   // "Brief Description" / modified content
  "contract_type":     string | null,   // "Contract Version" cell (合同版本)
  "_per_field_confidence":  { "<field>": 0.0-1.0 },
  "_per_field_source_span": { "<field>": "<verbatim source snippet>" }
}

Critical rules:
- "Document Code" (e.g. JSUS/04-1GS-126) is the TEMPLATE id, the SAME on every
  form — it is NOT the contract number. Read the "Contract Number" cell.
- Always give your single best guess for every field; if unsure, still fill it
  and lower its _per_field_confidence. Use null only when the cell is truly
  blank.
- Preserve every digit of amounts and ids exactly.
"""


def extract_approval(
    pdf_path: str | pathlib.Path,
    page_no: int,
    *,
    model: str | None = None,
    dpi: int | None = None,
) -> dict:
    """Extract metadata from the 1-indexed approval ``page_no`` of a contract PDF.

    Defaults for model/dpi come from config (``models.approval`` /
    ``ocr_render_dpi``). Raises if the model response is unparseable.
    """
    from langchain_core.messages import HumanMessage

    from contract_rag.config import load_config
    from contract_rag.llm import LLM

    cfg = load_config()
    model = model or cfg.models.approval
    dpi = dpi or cfg.models.ocr_render_dpi

    png = render_page_png(pdf_path, page_no, dpi)
    chat = LLM().get_custom_chat_object(model)
    data_url = encode_bytes_data_url(png, fmt="png")
    resp = chat.invoke(
        [
            HumanMessage(
                content=[
                    {"type": "image_url", "image_url": {"url": data_url}},
                    {"type": "text", "text": _APPROVAL_PROMPT},
                ]
            )
        ]
    )
    fields = parse_approval_fields(extract_text(resp.content))
    logger.info("approval extracted: contract_number=%s", fields.get("contract_number"))
    return fields
