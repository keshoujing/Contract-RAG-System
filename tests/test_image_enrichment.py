"""Tests for the embedded-image enrichment pre-pass.

`enrich_images` walks a MinerU content_list and, for every `type=image`
element, asks an injected classifier whether the image carries information:
  - valid  (table/chart/diagram/scanned_text) -> attach the markdown describing
            it so the chunk has real, searchable content;
  - invalid (logo/signature/decorative)       -> drop the element entirely so it
            never becomes a junk "[image]" chunk in the vector store.

The classifier is injected so this logic is testable without any Gemini call.
"""
from __future__ import annotations

from contract_rag.ingest.image_enrichment import (
    ImageVerdict,
    enrich_images,
    parse_verdict,
)


def _img(img_path: str, page_idx: int = 0, bbox: list | None = None) -> dict:
    # Default to a content-sized bbox so size pre-filtering doesn't drop it.
    return {
        "type": "image",
        "img_path": img_path,
        "page_idx": page_idx,
        "bbox": bbox if bbox is not None else [0, 0, 200, 150],
    }


def test_invalid_image_is_dropped() -> None:
    content_list = [_img("logo.png")]
    out = enrich_images(content_list, classify=lambda p: ImageVerdict(False, "logo", ""))
    assert out == []


def test_valid_image_keeps_element_and_attaches_markdown() -> None:
    content_list = [_img("chart.png")]
    out = enrich_images(
        content_list,
        classify=lambda p: ImageVerdict(True, "chart", "| Q1 | Q2 |\n| 1 | 2 |"),
    )
    assert len(out) == 1
    assert out[0]["type"] == "image"
    assert out[0]["enriched_markdown"] == "| Q1 | Q2 |\n| 1 | 2 |"


def test_non_image_elements_pass_through_untouched() -> None:
    text_el = {"type": "text", "text": "hello", "page_idx": 0}
    table_el = {"type": "table", "table_body": "<table></table>", "page_idx": 1}
    out = enrich_images([text_el, table_el], classify=lambda p: ImageVerdict(False, "x", ""))
    assert out == [text_el, table_el]


def test_input_list_and_dicts_are_not_mutated() -> None:
    original = _img("chart.png")
    content_list = [original]
    enrich_images(content_list, classify=lambda p: ImageVerdict(True, "chart", "desc"))
    assert content_list == [_img("chart.png")]  # list unchanged
    assert "enriched_markdown" not in original  # original dict unchanged


def test_too_small_image_is_dropped_without_calling_classifier() -> None:
    calls: list[str] = []

    def classify(p):
        calls.append(p)
        return ImageVerdict(True, "chart", "x")

    # 36x28 icon (like 2026004 p10's audit decoration) — obviously not content.
    tiny = _img("icon.png", bbox=[78, 90, 114, 118])
    out = enrich_images([tiny], classify=classify)
    assert out == []
    assert calls == []  # never spent a Gemini call on an obvious icon


def test_content_sized_image_still_goes_to_classifier() -> None:
    calls: list[str] = []

    def classify(p):
        calls.append(p)
        return ImageVerdict(True, "chart", "desc")

    # 142x105 (like 2026004 p3's logo) — big enough that only Gemini can judge.
    img = _img("logo.png", bbox=[439, 400, 581, 505])
    out = enrich_images([img], classify=classify)
    assert calls == ["logo.png"]
    assert len(out) == 1


def test_image_without_bbox_is_left_to_classifier() -> None:
    calls: list[str] = []

    def classify(p):
        calls.append(p)
        return ImageVerdict(False, "logo", "")

    out = enrich_images([{"type": "image", "img_path": "x.png", "page_idx": 0}], classify=classify)
    assert calls == ["x.png"]  # can't measure -> don't pre-filter, let Gemini decide
    assert out == []


def test_image_without_img_path_is_dropped_without_calling_classifier() -> None:
    calls: list[str | None] = []

    def classify(p):
        calls.append(p)
        return ImageVerdict(True, "chart", "x")

    out = enrich_images([{"type": "image", "page_idx": 0}], classify=classify)
    assert out == []
    assert calls == []  # never tried to classify an image with no file


# --- parse_verdict: Gemini JSON -> ImageVerdict (used by the real classifier) ---

def test_parse_verdict_valid_table() -> None:
    raw = '{"valid": true, "type": "table", "content": "| a | b |"}'
    v = parse_verdict(raw)
    assert v == ImageVerdict(True, "table", "| a | b |")


def test_parse_verdict_invalid_logo() -> None:
    v = parse_verdict('```json\n{"valid": false, "type": "logo", "content": ""}\n```')
    assert v == ImageVerdict(False, "logo", "")


def test_parse_verdict_unparseable_defaults_to_safe_drop() -> None:
    v = parse_verdict("the model rambled and returned no json")
    assert v.valid is False
    assert v.content == ""


def test_parse_verdict_missing_valid_key_defaults_false() -> None:
    v = parse_verdict('{"type": "chart", "content": "x"}')
    assert v.valid is False
