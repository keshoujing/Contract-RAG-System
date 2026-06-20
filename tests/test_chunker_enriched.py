"""The chunker should prefer an image's `enriched_markdown` (from the image
enrichment pass) over MinerU's caption/placeholder, so a described embedded
image becomes a searchable chunk instead of a content-less `[image]`.
"""
from __future__ import annotations

from contract_rag.ingest.chunker import chunk_content_list


def test_image_chunk_uses_enriched_markdown_when_present() -> None:
    content_list = [
        {
            "type": "image",
            "img_path": "chart.png",
            "page_idx": 2,
            "bbox": [0, 0, 1, 1],
            "image_caption": ["Figure 1"],
            "enriched_markdown": "| Product | Price |\n| Solus | $3.17 |",
        }
    ]
    chunks = chunk_content_list(content_list, contract_id="C1")
    assert len(chunks) == 1
    assert chunks[0].chunk_type == "image"
    assert chunks[0].content == "| Product | Price |\n| Solus | $3.17 |"


def test_image_chunk_falls_back_to_caption_without_enrichment() -> None:
    content_list = [
        {"type": "image", "img_path": "x.png", "page_idx": 0, "image_caption": ["Figure 2"]}
    ]
    chunks = chunk_content_list(content_list, contract_id="C1")
    assert chunks[0].content == "Figure 2"
