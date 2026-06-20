"""Per-page digital/scan router for the ingestion pipeline.

Productionized from ``_probe_digital_pages.py``. Classifies every page of a PDF
from fast fitz (PyMuPDF) metadata — image coverage + text-layer char count —
per ``memory/ingestion_pipeline.md`` decision 3:

    cover >= threshold & chars == 0  -> scan-bare       (no text layer; MUST OCR)
    cover >= threshold & chars >  0  -> scan-with-text  (OCR'd scan; treat as digital)
    cover <  0.05      & chars >  0  -> digital         (best case)
    otherwise                        -> mixed           (e.g. text + signature image)

Routing role in the current slice: MinerU runs on the *whole* PDF, so this
module is a gate. Only ``scan-bare`` pages require the (not-yet-built) Gemini
OCR path; ``scan-with-text`` is processed as digital (decision 3) and ``mixed``
pages (text layer present, e.g. 2026004 p1's bilingual approval table with an
e-signature) are handled fine by MinerU. See ``has_blocking_scan()``.
"""
from __future__ import annotations

import pathlib
from dataclasses import dataclass

import fitz  # PyMuPDF

from contract_rag.config import load_config

# Page classes that the current (digital-only) slice cannot handle and that
# must wait for the scanned-page OCR path.
BLOCKING_CLASSES = frozenset({"scan-bare"})

# A page is "digital-ish" (cover essentially zero) below this coverage.
_DIGITAL_COVER_MAX = 0.05


@dataclass(frozen=True)
class PageRoute:
    page_no: int      # 1-indexed for human display / pages table
    cover: float      # image-coverage ratio in [0, 1]
    chars: int        # text-layer character count
    page_class: str   # digital | scan-bare | scan-with-text | mixed


def union_image_area_ratio(page: fitz.Page) -> float:
    """Image-coverage ratio = (clipped image bbox area) / page area, capped at 1.

    NOTE: this is an *approximation* of the true bbox union — overlapping image
    rects are summed then capped at 1.0 rather than geometrically unioned. The
    PoC found this is accurate enough for triage (the signal is bimodal: digital
    pages sit near 0, scans near 1). A true union is only worth it if a real
    sample lands ambiguously in the middle.
    """
    page_rect = page.rect
    page_area = page_rect.width * page_rect.height
    if page_area == 0:
        return 0.0
    merged_area = 0.0
    for img in page.get_images(full=True):
        for r in page.get_image_rects(img[0]):
            r = r & page_rect  # clip to page
            merged_area += r.width * r.height
    return min(merged_area / page_area, 1.0)


def classify_page(cover: float, chars: int, cover_threshold: float) -> str:
    if cover >= cover_threshold and chars == 0:
        return "scan-bare"
    if cover >= cover_threshold and chars > 0:
        return "scan-with-text"
    if cover < _DIGITAL_COVER_MAX and chars > 0:
        return "digital"
    return "mixed"


def route_pdf(pdf_path: str | pathlib.Path, cover_threshold: float | None = None) -> list[PageRoute]:
    """Classify every page of ``pdf_path``. Threshold defaults to config."""
    if cover_threshold is None:
        cover_threshold = load_config().router.cover_threshold
    routes: list[PageRoute] = []
    doc = fitz.open(pdf_path)
    try:
        for i, page in enumerate(doc):
            cover = union_image_area_ratio(page)
            chars = len(page.get_text("text"))
            routes.append(
                PageRoute(
                    page_no=i + 1,
                    cover=cover,
                    chars=chars,
                    page_class=classify_page(cover, chars, cover_threshold),
                )
            )
    finally:
        doc.close()
    return routes


def has_blocking_scan(routes: list[PageRoute]) -> bool:
    """True if any page needs the scanned-page OCR path (not built this slice)."""
    return any(r.page_class in BLOCKING_CLASSES for r in routes)


def class_counts(routes: list[PageRoute]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for r in routes:
        counts[r.page_class] = counts.get(r.page_class, 0) + 1
    return counts


def main() -> None:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Route a PDF's pages (digital/scan)")
    parser.add_argument("pdf", help="path to PDF")
    args = parser.parse_args()
    routes = route_pdf(args.pdf)
    print(json.dumps(
        {
            "counts": class_counts(routes),
            "blocking_scan": has_blocking_scan(routes),
            "pages": [r.__dict__ for r in routes],
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
