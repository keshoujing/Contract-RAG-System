"""Pure assembly stage: routed engine outputs -> final chunks.

This is the offline-testable core of the pipeline's new per-page flow. It
decides which pages need OCR, then composes the tested merge + image-enrichment
+ chunker steps. The pipeline wraps this with the actual I/O (MinerU subprocess,
Gemini calls, Weaviate, SQLite).
"""
from __future__ import annotations

from contract_rag.ingest.assembly import build_chunks, scan_page_numbers
from contract_rag.ingest.image_enrichment import ImageVerdict
from contract_rag.ingest.router import PageRoute


def _route(page_no: int, page_class: str) -> PageRoute:
    return PageRoute(page_no=page_no, cover=0.0, chars=0, page_class=page_class)


def test_scan_page_numbers_picks_only_bare_scans() -> None:
    routes = [
        _route(1, "digital"),
        _route(2, "scan-bare"),
        _route(3, "scan-with-text"),
        _route(4, "scan-bare"),
        _route(5, "mixed"),
    ]
    assert scan_page_numbers(routes) == [2, 4]


def test_build_chunks_merges_mineru_and_ocr_across_the_seam() -> None:
    # p1 digital (MinerU), p2 scan-bare (OCR). A clause heading on p1 with body
    # continuing onto p2 must end up in ONE clause chunk spanning both pages.
    mineru = [
        {"type": "text", "text": "7. Force Majeure", "text_level": 2, "page_idx": 0},
        {"type": "text", "text": "Neither party shall be liable", "page_idx": 0},
    ]
    ocr = {2: [{"type": "text", "text": "for events beyond its control."}]}
    routes = [_route(1, "digital"), _route(2, "scan-bare")]

    chunks = build_chunks(
        mineru, ocr, routes, contract_id="C1", classify=lambda p: ImageVerdict(False, "x", "")
    )

    clause = [c for c in chunks if c.chunk_type == "clause"]
    assert len(clause) == 1
    assert clause[0].page_start == 1 and clause[0].page_end == 2
    assert "Neither party shall be liable" in clause[0].content
    assert "for events beyond its control." in clause[0].content
    assert clause[0].section_path == ["7. Force Majeure"]


def test_build_chunks_drops_invalid_embedded_images() -> None:
    mineru = [
        {"type": "image", "img_path": "logo.png", "page_idx": 0},
        {"type": "text", "text": "real clause text here", "page_idx": 0},
    ]
    routes = [_route(1, "digital")]
    chunks = build_chunks(
        mineru, {}, routes, contract_id="C1", classify=lambda p: ImageVerdict(False, "logo", "")
    )
    assert all(c.chunk_type != "image" for c in chunks)


def test_build_chunks_keeps_and_describes_valid_embedded_image() -> None:
    mineru = [{"type": "image", "img_path": "chart.png", "page_idx": 0}]
    routes = [_route(1, "digital")]
    chunks = build_chunks(
        mineru,
        {},
        routes,
        contract_id="C1",
        classify=lambda p: ImageVerdict(True, "chart", "| a | b |"),
    )
    img = [c for c in chunks if c.chunk_type == "image"]
    assert len(img) == 1
    assert img[0].content == "| a | b |"
