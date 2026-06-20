"""Pure assembly stage: routed engine outputs -> final chunks.

This is the offline-testable core of the per-page ingestion flow. It composes
three already-tested steps in the order the design requires:

    merge_page_elements   (MinerU digital pages + Gemini OCR scan pages, by page)
        -> enrich_images  (describe/drop embedded images via injected classifier)
        -> chunk_content_list  (single section-aware chunker; page boundaries are
                                transparent, so cross-page/cross-seam clauses are
                                stitched into one chunk)

Keeping this separate from the pipeline means the I/O (MinerU subprocess, Gemini
calls, Weaviate, SQLite) stays at the edges and this logic is unit-tested.
"""
from __future__ import annotations

from contract_rag.ingest.chunker import Chunk, chunk_content_list, clean_chunks
from contract_rag.ingest.image_enrichment import Classifier, enrich_images
from contract_rag.ingest.merge import BLOCKING_CLASSES, merge_page_elements
from contract_rag.ingest.router import PageRoute


def scan_page_numbers(routes: list[PageRoute]) -> list[int]:
    """1-indexed page numbers that need the OCR path (bare scans)."""
    return [r.page_no for r in routes if r.page_class in BLOCKING_CLASSES]


def build_chunks(
    mineru_elements: list[dict],
    ocr_elements_by_page: dict[int, list[dict]],
    routes: list[PageRoute],
    *,
    contract_id: str,
    classify: Classifier,
    soft_target: int | None = None,
    hard_cap: int | None = None,
    overlap: int | None = None,
) -> list[Chunk]:
    """Merge engine outputs, enrich embedded images, and chunk — in one pass."""
    merged = merge_page_elements(mineru_elements, ocr_elements_by_page, routes)
    enriched = enrich_images(merged, classify=classify)
    kwargs: dict = {"contract_id": contract_id}
    if soft_target is not None:
        kwargs["soft_target"] = soft_target
    if hard_cap is not None:
        kwargs["hard_cap"] = hard_cap
    if overlap is not None:
        kwargs["overlap"] = overlap
    return clean_chunks(chunk_content_list(enriched, **kwargs))
