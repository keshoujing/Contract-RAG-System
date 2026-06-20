import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    db.upsert_contract("JSUS2026004", status="active", counterparty="OC", amount=100.0,
                       currency="USD", project_name="UD", department="UD",
                       petition_date="2026-04-12", effective_date="2026-04-15",
                       expiration_date="2027-04-14", file_no="2026004", page_count=14)
    return TestClient(create_app())


def test_list_contracts(client):
    resp = client.get("/api/contracts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["data"][0]["file_name"] == "2026004-JSUS2026004-UD"


def test_list_contracts_search(client):
    assert client.get("/api/contracts?q=oc").json()["total"] == 1
    assert client.get("/api/contracts?q=zzz").json()["total"] == 0


def test_get_contract(client):
    resp = client.get("/api/contracts/JSUS2026004")
    assert resp.status_code == 200
    assert resp.json()["pages"] == 14


def test_get_contract_404(client):
    assert client.get("/api/contracts/NOPE").status_code == 404


def test_export_returns_xlsx(client):
    resp = client.get("/api/contracts/export")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]


def test_download_contract_404(client):
    assert client.get("/api/contracts/JSUS2026004/file").status_code == 404


def test_download_contract_serves_pdf(client):
    cdir = sp.contract_dir("JSUS2026004")
    cdir.mkdir(parents=True, exist_ok=True)
    sp.signed_pdf(cdir).write_bytes(b"%PDF-1.4 test")
    resp = client.get("/api/contracts/JSUS2026004/file")
    assert resp.status_code == 200
    assert resp.headers["content-type"] == "application/pdf"


def test_get_contract_page_png_serves_archived_page(client):
    cdir = sp.contract_dir("JSUS2026004")
    pages = sp.pages_dir(cdir)
    pages.mkdir(parents=True, exist_ok=True)
    sp.page_png(cdir, 2).write_bytes(b"\x89PNG\r\n\x1a\nfake")

    resp = client.get("/api/contracts/JSUS2026004/pages/2")

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "image/png"


def test_get_contract_page_png_rejects_bad_page(client):
    resp = client.get("/api/contracts/JSUS2026004/pages/0")

    assert resp.status_code == 400


def test_get_contract_page_png_404_when_missing(client):
    resp = client.get("/api/contracts/JSUS2026004/pages/9")

    assert resp.status_code == 404


def test_delete_contract(client):
    assert client.delete("/api/contracts/JSUS2026004").status_code == 204
    assert client.get("/api/contracts/JSUS2026004").status_code == 404


def test_delete_contract_404(client):
    assert client.delete("/api/contracts/NOPE").status_code == 404


def test_patch_contract(client):
    resp = client.patch("/api/contracts/JSUS2026004", json={"counterparty": "NEWCO", "amount": 999.0})
    assert resp.status_code == 200
    assert resp.json()["counterparty"] == "NEWCO"
    assert resp.json()["amount"] == 999.0
    # derived/system fields in the payload are ignored, not applied
    resp2 = client.patch("/api/contracts/JSUS2026004", json={"file_no": "HACKED", "pages": 999})
    assert resp2.json()["file_no"] == "2026004"
    assert resp2.json()["pages"] == 14


def test_patch_contract_404(client):
    assert client.patch("/api/contracts/NOPE", json={"counterparty": "X"}).status_code == 404


def test_batch_export(client):
    resp = client.post("/api/contracts/batch", json={"ids": ["JSUS2026004"], "action": "export"})
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]


def test_batch_delete(client):
    resp = client.post("/api/contracts/batch", json={"ids": ["JSUS2026004"], "action": "delete"})
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 1
    assert client.get("/api/contracts/JSUS2026004").status_code == 404


def test_batch_rejects_bad_action(client):
    assert client.post("/api/contracts/batch", json={"ids": [], "action": "nuke"}).status_code == 422


# ---------------------------------------------------------------------------
# scope=contract tests (Task 3.2)
# ---------------------------------------------------------------------------

import fitz  # noqa: E402 — placed after existing imports to avoid disrupting them


def _seed_contract_with_pages(cid: str, roles: list[str]) -> None:
    """Create a stored PDF (one page per role) and insert matching page rows."""
    cdir = sp.contract_dir(cid)
    cdir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open()
    for _ in roles:
        doc.new_page(width=200, height=300)
    # If no roles, write a minimal 1-page placeholder so signed.pdf exists
    if not roles:
        doc.new_page(width=200, height=300)
    sp.signed_pdf(cdir).write_bytes(doc.tobytes())
    db.upsert_contract(cid, status="active")
    if roles:
        db.insert_pages(
            cid,
            [
                {"page_no": i + 1, "page_type": r, "route": None, "avg_confidence": None}
                for i, r in enumerate(roles)
            ],
        )


def test_download_contract_scope_returns_subset(client):
    _seed_contract_with_pages("SCOPE001", ["approval", "contract", "other"])
    full = client.get("/api/contracts/SCOPE001/file")
    sub = client.get("/api/contracts/SCOPE001/file?scope=contract")
    assert sub.status_code == 200
    assert sub.headers["content-type"] == "application/pdf"
    assert fitz.open(stream=sub.content, filetype="pdf").page_count == 1
    assert len(full.content) != len(sub.content)


def test_download_contract_scope_falls_back_when_no_contract_pages(client):
    # PDF has 2 pages, but NO 'contract' page rows — must fall back to full file
    _seed_contract_with_pages("SCOPE002", ["other", "other"])
    full = client.get("/api/contracts/SCOPE002/file")
    sub = client.get("/api/contracts/SCOPE002/file?scope=contract")
    assert sub.status_code == 200
    # Fallback → same bytes as full
    assert len(sub.content) == len(full.content)
