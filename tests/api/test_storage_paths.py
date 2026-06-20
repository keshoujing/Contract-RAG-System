import pytest
from contract_rag.api import storage_paths as sp


def test_upload_and_contract_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    assert sp.upload_dir("T1") == tmp_path / "_uploads" / "T1"
    assert sp.contract_dir("C1") == tmp_path / "C1"
    assert sp.signed_pdf(sp.upload_dir("T1")).name == "signed.pdf"


def test_promote_upload_moves_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    up = sp.upload_dir("T1")
    (up / "pages").mkdir(parents=True)
    sp.signed_pdf(up).write_bytes(b"%PDF-1.4")
    sp.promote_upload("T1", "C1")
    assert not up.exists()
    assert sp.signed_pdf(sp.contract_dir("C1")).read_bytes() == b"%PDF-1.4"


def test_promote_upload_overwrites_existing_contract_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    cdir = sp.contract_dir("C1")
    cdir.mkdir(parents=True)
    (cdir / "old.txt").write_text("stale")
    up = sp.upload_dir("T1")
    up.mkdir(parents=True)
    sp.signed_pdf(up).write_bytes(b"new")
    sp.promote_upload("T1", "C1")
    assert not (sp.contract_dir("C1") / "old.txt").exists()
    assert sp.signed_pdf(sp.contract_dir("C1")).read_bytes() == b"new"


def test_page_png_rejects_bad_index(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    with pytest.raises(ValueError):
        sp.page_png(sp.upload_dir("T1"), 0)
    assert sp.page_png(sp.upload_dir("T1"), 3).name == "3.png"
