import fitz
from contract_rag.api import rendering


def _make_pdf(path, n_pages):
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page(width=300, height=400)
    doc.save(str(path))
    doc.close()


def test_page_count(tmp_path):
    pdf = tmp_path / "a.pdf"
    _make_pdf(pdf, 3)
    assert rendering.page_count(pdf) == 3


def test_render_thumbnails_writes_one_png_per_page(tmp_path):
    pdf = tmp_path / "a.pdf"
    _make_pdf(pdf, 2)
    out = tmp_path / "pages"
    count = rendering.render_thumbnails(pdf, out)
    assert count == 2
    assert (out / "1.png").exists()
    assert (out / "2.png").exists()
