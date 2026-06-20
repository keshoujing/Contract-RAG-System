"""PDF page-count + thumbnail rendering (fitz). Pages are 1-indexed PNGs."""
from __future__ import annotations

import pathlib

import fitz

THUMBNAIL_DPI = 110


def page_count(pdf_path: str | pathlib.Path) -> int:
    with fitz.open(str(pdf_path)) as doc:
        return doc.page_count


def render_thumbnails(
    pdf_path: str | pathlib.Path,
    out_dir: str | pathlib.Path,
    *,
    dpi: int = THUMBNAIL_DPI,
) -> int:
    """Render every page to ``{out_dir}/{n}.png`` (n starts at 1). Returns page count."""
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    with fitz.open(str(pdf_path)) as doc:
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=matrix)
            pix.save(str(out / f"{i}.png"))
        return doc.page_count
