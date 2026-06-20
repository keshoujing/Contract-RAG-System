import fitz
from contract_rag.api.pdf_subset import subset_pdf_bytes


def _pdf(n):
    doc = fitz.open()
    for _ in range(n):
        doc.new_page(width=200, height=300)
    return doc.tobytes()


def test_subset_keeps_only_requested_pages(tmp_path):
    src = tmp_path / "s.pdf"
    src.write_bytes(_pdf(5))
    out = subset_pdf_bytes(src, [2, 4])           # 1-indexed
    doc = fitz.open(stream=out, filetype="pdf")
    assert doc.page_count == 2


def test_subset_empty_pages_raises(tmp_path):
    src = tmp_path / "s.pdf"
    src.write_bytes(_pdf(3))
    import pytest
    with pytest.raises(ValueError):
        subset_pdf_bytes(src, [])


def test_subset_out_of_range_pages_raises(tmp_path):
    src = tmp_path / "s.pdf"
    src.write_bytes(_pdf(2))
    import pytest
    with pytest.raises(ValueError):
        subset_pdf_bytes(src, [5, 6])             # all out of range
