"""Scanned-page OCR provider: bare-scan page image -> MinerU-compatible elements.

Per the OCR evaluation (memory/ocr_evaluation.md) the V1 engine is Gemini 3
Flash via Vertex. The provider is prompted to emit the *same element shape*
MinerU produces (text with `text_level` for headings, `table` with HTML
`table_body`) so the merged stream feeds the single section-aware chunker — see
merge.py. The OCR provider is page-local; absolute page numbering is owned by
the merge step.

Pure part (`parse_ocr_elements`) is unit-tested; the rendering + Gemini call are
the untestable I/O boundary.
"""
from __future__ import annotations

import logging
import pathlib
from concurrent.futures import ThreadPoolExecutor, as_completed

from contract_rag.ingest.vision import encode_bytes_data_url, extract_text, loads_lenient

logger = logging.getLogger(__name__)


def _normalize_element(el: dict) -> dict | None:
    """Keep only the recognized MinerU-shaped keys; drop typeless items."""
    t = el.get("type")
    if not t:
        return None
    out: dict = {"type": t}
    if el.get("text") is not None:
        out["text"] = el["text"]
    if el.get("text_level") in (1, 2, 3):
        out["text_level"] = el["text_level"]
    if el.get("table_body"):
        out["table_body"] = el["table_body"]
    if el.get("img_path"):
        out["img_path"] = el["img_path"]
    return out


def parse_ocr_elements(raw: str) -> list[dict]:
    """Parse a Gemini OCR response into normalized elements for one page.

    Accepts a JSON array, a ``{"elements": [...]}`` wrapper, or either inside a
    fenced block. A malformed response yields an empty page rather than raising,
    so one unreadable page cannot abort the whole ingest.
    """
    try:
        data = loads_lenient(raw)
    except ValueError:
        return []
    if isinstance(data, dict):
        data = data.get("elements", [])
    if not isinstance(data, list):
        return []

    elements: list[dict] = []
    for el in data:
        if not isinstance(el, dict):
            continue
        norm = _normalize_element(el)
        if norm is not None:
            elements.append(norm)
    return elements


# --------------------------------------------------------------------------- #
# I/O boundary: render scan pages and OCR them with Gemini (Vertex)
# --------------------------------------------------------------------------- #

_OCR_PROMPT = """You are doing OCR on ONE scanned page of a contract.

Transcribe everything on the page into a JSON array of elements, in natural
reading order. Use EXACTLY this element shape (the same one a layout parser
emits):

- Body paragraph:  {"type": "text", "text": "<verbatim text>"}
- Heading:         {"type": "text", "text": "<heading>", "text_level": <1|2|3>}
                   (1 = top-level section title, 2 = subsection, 3 = sub-sub)
- Table:           {"type": "table", "table_body": "<HTML table with <tr>/<td>>"}
- Page header/footer (running title, page number, address line):
                   {"type": "header", "text": "..."} or {"type": "footer", ...}

Rules:
- Return ONLY the JSON array, no prose, no code fence.
- Preserve every number, $ sign, thousands separator, decimal and unit EXACTLY.
- Do NOT fill empty table cells with guesses; leave them empty.
- Mark every section/clause heading with the right text_level so structure is
  preserved.
"""


def render_page_png(pdf_path: str | pathlib.Path, page_no: int, dpi: int) -> bytes:
    """Render one 1-indexed page of a PDF to PNG bytes at ``dpi`` (via fitz)."""
    import fitz  # PyMuPDF (imported lazily to keep the module light)

    doc = fitz.open(pdf_path)
    try:
        page = doc[page_no - 1]
        pix = page.get_pixmap(dpi=dpi)
        return pix.tobytes("png")
    finally:
        doc.close()


def gemini_ocr_page(png_bytes: bytes, *, model: str) -> list[dict]:
    """OCR one rendered page image with Gemini; return normalized elements.

    A failed page degrades to ``[]`` (it contributes nothing) instead of
    aborting the whole ingest.
    """
    from langchain_core.messages import HumanMessage

    from contract_rag.llm import LLM

    try:
        chat = LLM().get_custom_chat_object(model)
        data_url = encode_bytes_data_url(png_bytes, fmt="png")
        resp = chat.invoke(
            [
                HumanMessage(
                    content=[
                        {"type": "image_url", "image_url": {"url": data_url}},
                        {"type": "text", "text": _OCR_PROMPT},
                    ]
                )
            ]
        )
        return parse_ocr_elements(extract_text(resp.content))
    except Exception as e:  # noqa: BLE001 - one bad page must not kill the ingest
        logger.warning("OCR failed for page: %s; treating page as empty", e)
        return []


def ocr_scan_pages(
    pdf_path: str | pathlib.Path,
    scan_page_nos: list[int],
    *,
    model: str | None = None,
    dpi: int | None = None,
    max_workers: int | None = None,
) -> dict[int, list[dict]]:
    """OCR the given 1-indexed scan pages; return elements keyed by page_no.

    Defaults for model/dpi come from config (``models.ocr`` / ``ocr_render_dpi``).
    The result is consumed by ``merge.merge_page_elements``.
    """
    from contract_rag.config import load_config

    cfg = load_config()
    model = model or cfg.models.ocr
    dpi = dpi or cfg.models.ocr_render_dpi
    max_workers = max(1, max_workers or cfg.models.ocr_max_workers)

    def _one(page_no: int) -> tuple[int, list[dict]]:
        png = render_page_png(pdf_path, page_no, dpi)
        elements = gemini_ocr_page(png, model=model)
        logger.info("OCR'd scan page %d -> %d elements", page_no, len(elements))
        return page_no, elements

    out: dict[int, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=min(max_workers, len(scan_page_nos) or 1)) as pool:
        futures = [pool.submit(_one, page_no) for page_no in scan_page_nos]
        for fut in as_completed(futures):
            page_no, elements = fut.result()
            out[page_no] = elements
    return dict(sorted(out.items()))
