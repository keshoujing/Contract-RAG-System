"""Element-layer merge of MinerU (digital pages) + Gemini OCR (scan-bare pages).

The merge is the heart of per-page routing (architecture A, see the design
discussion in memory/ingestion_pipeline.md): each page is wholly produced by one
engine, and the merged stream is fed to the *single* section-aware chunker, so
page boundaries are never chunk-decision points. Per page (in absolute order):

  - scan-bare page -> Gemini OCR elements (MinerU's garbage for that page dropped)
  - any other page -> MinerU elements for that page_idx

The merge owns absolute page numbering: it stamps `page_idx` on OCR elements so
the OCR provider can stay page-local.
"""
from __future__ import annotations

from contract_rag.ingest.merge import merge_page_elements
from contract_rag.ingest.router import PageRoute


def _route(page_no: int, page_class: str) -> PageRoute:
    return PageRoute(page_no=page_no, cover=0.0, chars=0, page_class=page_class)


def test_all_digital_returns_mineru_in_order_ignoring_ocr() -> None:
    mineru = [
        {"type": "text", "text": "A", "page_idx": 0},
        {"type": "text", "text": "B", "page_idx": 1},
    ]
    routes = [_route(1, "digital"), _route(2, "digital")]
    out = merge_page_elements(mineru, ocr_elements_by_page={}, routes=routes)
    assert [e["text"] for e in out] == ["A", "B"]


def test_scan_page_uses_ocr_and_drops_mineru_garbage_for_that_page() -> None:
    mineru = [
        {"type": "text", "text": "digital-p1", "page_idx": 0},
        {"type": "text", "text": "MINERU-GARBAGE-p2", "page_idx": 1},  # scan page noise
        {"type": "text", "text": "digital-p3", "page_idx": 2},
    ]
    ocr = {2: [{"type": "text", "text": "ocr-p2-x"}, {"type": "text", "text": "ocr-p2-y"}]}
    routes = [_route(1, "digital"), _route(2, "scan-bare"), _route(3, "digital")]
    out = merge_page_elements(mineru, ocr_elements_by_page=ocr, routes=routes)
    assert [e["text"] for e in out] == ["digital-p1", "ocr-p2-x", "ocr-p2-y", "digital-p3"]


def test_ocr_elements_get_page_idx_stamped_zero_indexed() -> None:
    ocr = {2: [{"type": "text", "text": "x"}]}
    routes = [_route(1, "digital"), _route(2, "scan-bare")]
    out = merge_page_elements([], ocr_elements_by_page=ocr, routes=routes)
    assert out[0]["page_idx"] == 1  # page_no 2 -> page_idx 1


def test_intra_page_mineru_order_preserved() -> None:
    mineru = [
        {"type": "text", "text": "second", "page_idx": 0},
        {"type": "text", "text": "first", "page_idx": 0},
    ]
    routes = [_route(1, "digital")]
    out = merge_page_elements(mineru, ocr_elements_by_page={}, routes=routes)
    assert [e["text"] for e in out] == ["second", "first"]


def test_inputs_not_mutated() -> None:
    mineru = [{"type": "text", "text": "A", "page_idx": 0}]
    ocr = {2: [{"type": "text", "text": "x"}]}
    routes = [_route(1, "digital"), _route(2, "scan-bare")]
    merge_page_elements(mineru, ocr_elements_by_page=ocr, routes=routes)
    assert mineru == [{"type": "text", "text": "A", "page_idx": 0}]
    assert ocr == {2: [{"type": "text", "text": "x"}]}  # no page_idx leaked in
