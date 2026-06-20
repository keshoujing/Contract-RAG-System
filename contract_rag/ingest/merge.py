"""Element-layer merge of MinerU + Gemini-OCR output into one ordered stream.

Per-page routing (architecture A): each page is wholly handled by one engine,
so merging is purely page-sequencing — there is no within-page reconciliation.
The merged element list is fed to the *single* section-aware chunker, which is
what actually decides chunk boundaries; because `page_idx` is never a flush
trigger there, page boundaries (including the digital/scan seam) are transparent
and cross-page clauses are stitched back together automatically.

Two things this module is responsible for (the only deterministic merge steps):
  1. Drop MinerU's output for scan-bare pages (it ran on the whole PDF and that
     page is garbage) and use the OCR elements instead.
  2. Own absolute page numbering: stamp `page_idx` (0-indexed) onto OCR elements
     so the OCR provider can stay page-local.
"""
from __future__ import annotations

from contract_rag.ingest.router import PageRoute

BLOCKING_CLASSES = frozenset({"scan-bare"})


def merge_page_elements(
    mineru_elements: list[dict],
    ocr_elements_by_page: dict[int, list[dict]],
    routes: list[PageRoute],
) -> list[dict]:
    """Interleave MinerU and OCR elements in absolute page order.

    Args:
        mineru_elements: MinerU content_list (each element 0-indexed `page_idx`).
        ocr_elements_by_page: OCR elements keyed by 1-indexed page_no; their
            `page_idx` is (re)stamped here, so callers need not set it.
        routes: per-page classification (1-indexed `page_no`).

    Returns a new list; inputs are not mutated.
    """
    # Bucket MinerU elements by their (0-indexed) page, preserving order.
    by_page: dict[int, list[dict]] = {}
    for el in mineru_elements:
        by_page.setdefault(el.get("page_idx", 0), []).append(el)

    out: list[dict] = []
    for route in sorted(routes, key=lambda r: r.page_no):
        page_idx = route.page_no - 1
        if route.page_class in BLOCKING_CLASSES:
            for el in ocr_elements_by_page.get(route.page_no, []):
                out.append({**el, "page_idx": page_idx})
        else:
            out.extend(by_page.get(page_idx, []))
    return out
