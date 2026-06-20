"""Parser turning a Gemini scanned-page OCR response into MinerU-compatible
elements (the pure half of the OCR provider).

The OCR model is prompted to return the same element shape MinerU emits so the
merged stream feeds one chunker: text elements (with `text_level` for headings)
and `table` elements (HTML `table_body`). This parser normalizes that output and
degrades to an empty page on malformed responses (one bad page must not crash a
whole ingest).
"""
from __future__ import annotations

import threading
import time

from contract_rag.ingest import ocr
from contract_rag.ingest.ocr import ocr_scan_pages, parse_ocr_elements


def test_parses_array_of_text_elements() -> None:
    raw = '[{"type": "text", "text": "Clause 1"}, {"type": "text", "text": "Clause 2"}]'
    els = parse_ocr_elements(raw)
    assert els == [
        {"type": "text", "text": "Clause 1"},
        {"type": "text", "text": "Clause 2"},
    ]


def test_parses_fenced_json_array() -> None:
    raw = '```json\n[{"type": "text", "text": "x"}]\n```'
    assert parse_ocr_elements(raw) == [{"type": "text", "text": "x"}]


def test_keeps_valid_text_level_for_headings() -> None:
    raw = '[{"type": "text", "text": "TERMS", "text_level": 2}]'
    assert parse_ocr_elements(raw) == [{"type": "text", "text": "TERMS", "text_level": 2}]


def test_drops_invalid_text_level() -> None:
    raw = '[{"type": "text", "text": "body", "text_level": 9}]'
    assert parse_ocr_elements(raw) == [{"type": "text", "text": "body"}]


def test_keeps_table_body_html() -> None:
    raw = '[{"type": "table", "table_body": "<table><tr><td>1</td></tr></table>"}]'
    assert parse_ocr_elements(raw) == [
        {"type": "table", "table_body": "<table><tr><td>1</td></tr></table>"}
    ]


def test_accepts_elements_wrapped_in_object() -> None:
    raw = '{"elements": [{"type": "text", "text": "x"}]}'
    assert parse_ocr_elements(raw) == [{"type": "text", "text": "x"}]


def test_drops_items_without_a_type() -> None:
    raw = '[{"text": "no type"}, {"type": "text", "text": "ok"}]'
    assert parse_ocr_elements(raw) == [{"type": "text", "text": "ok"}]


def test_malformed_response_yields_empty_page() -> None:
    assert parse_ocr_elements("the model said sorry, no json") == []


def test_ocr_scan_pages_can_run_pages_in_parallel(monkeypatch) -> None:
    active = 0
    max_active = 0
    lock = threading.Lock()

    def fake_render(_pdf_path, page_no, _dpi):
        return str(page_no).encode()

    def fake_ocr(png_bytes, *, model):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.05)
        with lock:
            active -= 1
        return [{"type": "text", "text": png_bytes.decode()}]

    monkeypatch.setattr(ocr, "render_page_png", fake_render)
    monkeypatch.setattr(ocr, "gemini_ocr_page", fake_ocr)

    out = ocr_scan_pages("contract.pdf", [1, 2, 3], model="m", dpi=200, max_workers=3)

    assert max_active > 1
    assert out == {
        1: [{"type": "text", "text": "1"}],
        2: [{"type": "text", "text": "2"}],
        3: [{"type": "text", "text": "3"}],
    }
