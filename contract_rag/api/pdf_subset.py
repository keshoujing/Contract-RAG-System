"""Build a new PDF containing only selected (1-indexed) pages, in order."""
from __future__ import annotations

import pathlib

import fitz


def subset_pdf_bytes(pdf_path: str | pathlib.Path, pages_1indexed: list[int]) -> bytes:
    if not pages_1indexed:
        raise ValueError("no pages selected for subset")
    with fitz.open(str(pdf_path)) as src:
        keep = [p - 1 for p in sorted(set(pages_1indexed)) if 1 <= p <= src.page_count]
        if not keep:
            raise ValueError("selected pages out of range")
        out = fitz.open()
        out.insert_pdf(src, from_page=keep[0], to_page=keep[0])
        for idx in keep[1:]:
            out.insert_pdf(src, from_page=idx, to_page=idx)
        return out.tobytes()
