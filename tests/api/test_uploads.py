import fitz
import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.api.routes import uploads
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    return TestClient(create_app())


def _pdf_bytes(n_pages=3):
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page(width=300, height=400)
    data = doc.tobytes()
    doc.close()
    return data


def _full_extraction(**over):
    fields = {
        "contract_number": "JSUS2026099", "counterparty": "OC", "amount": 100.0,
        "currency": "USD", "project_name": "P", "department": "UD",
        "petitioner": "王立", "petition_date": "2026-04-12", "contract_type": "Supply",
        "_per_field_confidence": {"project_name": 0.6},
        "_per_field_source_span": {"project_name": "UD Glass..."},
    }
    fields.update(over)
    return fields


def test_ingest_flow(client, monkeypatch):
    monkeypatch.setattr(uploads, "extract_approval", lambda pdf, page_no, **kw: _full_extraction())

    resp = client.post("/api/ingest/upload", files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")})
    assert resp.status_code == 200
    task_id = resp.json()["task_id"]
    assert resp.json()["page_count"] == 3

    # synchronous page-tags extraction
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {
        "1": "approval", "2": "contract", "3": "other"}})
    assert r.status_code == 200

    status = client.get(f"/api/ingest/{task_id}").json()
    assert status["stage"] == "awaiting_user_confirmation"
    # flat field shape; contract_id derived from contract_number
    assert status["fields"]["contract_id"] == "JSUS2026099"
    assert status["fields"]["counterparty"] == "OC"
    assert "_per_field_confidence" not in status["fields"]
    assert status["_per_field_confidence"]["project_name"] == 0.6
    assert status["_per_field_source_span"]["project_name"] == "UD Glass..."

    # confirm sends only the surfaced fields; backend merges over stored extraction
    resp = client.post(f"/api/ingest/{task_id}/confirm", json={
        "fields": {"contract_id": "JSUS2026099", "counterparty": "OC", "amount": "$100.00",
                   "project_name": "P", "department": "UD", "petitioner": "王立"},
        "effective_date": "2026-04-15", "expiration_date": "2027-04-14",
        "category": "default",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["contract_id"] == "JSUS2026099"
    assert body["file_no"] == "2026001"
    assert body["amount"] == 100.0  # "$100.00" coerced to number
    row = db.get_contract("JSUS2026099")
    assert row.get("page_count") == 3
    # fields NOT on the confirm form survive from the stored extraction
    assert row.get("currency") == "USD"
    assert row.get("petition_date") == "2026-04-12"
    assert row.get("contract_type") == "Supply"


def test_confirm_duplicate_then_overwrite(client, monkeypatch):
    db.upsert_contract("JSUS2026099", status="active", counterparty="OLD")
    monkeypatch.setattr(uploads, "extract_approval",
                        lambda pdf, page_no, **kw: {"contract_number": "JSUS2026099"})
    task_id = client.post("/api/ingest/upload", files={"file": ("c.pdf", _pdf_bytes(2), "application/pdf")}).json()["task_id"]
    client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "contract"}})
    body = {"fields": {"contract_id": "JSUS2026099", "counterparty": "NEW"},
            "effective_date": "2026-04-15", "expiration_date": "2027-04-14", "category": "default"}
    assert client.post(f"/api/ingest/{task_id}/confirm", json=body).status_code == 409
    body["overwrite"] = True
    assert client.post(f"/api/ingest/{task_id}/confirm", json=body).status_code == 200
    assert db.get_contract("JSUS2026099").get("counterparty") == "NEW"


def test_upload_rejects_non_pdf(client):
    resp = client.post("/api/ingest/upload", files={"file": ("c.txt", b"hello", "text/plain")})
    assert resp.status_code == 400


def test_page_tags_rejects_incomplete(client):
    task_id = client.post("/api/ingest/upload", files={"file": ("c.pdf", _pdf_bytes(2), "application/pdf")}).json()["task_id"]
    # page 2 untagged
    assert client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval"}}).status_code == 422
    # invalid role value
    assert client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "bad_role"}}).status_code == 422


def test_extract_failure_returns_502_and_marks_failed(client, monkeypatch):
    def boom(pdf, page_no, **kw):
        raise RuntimeError("LLM down")
    monkeypatch.setattr(uploads, "extract_approval", boom)
    task_id = client.post("/api/ingest/upload", files={"file": ("c.pdf", _pdf_bytes(2), "application/pdf")}).json()["task_id"]
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "contract"}})
    assert r.status_code == 502
    assert client.get(f"/api/ingest/{task_id}").json()["stage"] == "failed"


def test_page_tags_extracts_from_first_approval_page(client, monkeypatch):
    seen = {}
    def fake(pdf, page_no, **kw):
        seen["page_no"] = page_no
        return {"contract_number": "JSUS2026200"}
    monkeypatch.setattr(uploads, "extract_approval", fake)
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(4), "application/pdf")}).json()["task_id"]
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {
        "1": "contract", "2": "approval", "3": "contract", "4": "other"}})
    assert r.status_code == 200
    assert seen["page_no"] == 2     # first approval page feeds extraction
    assert client.get(f"/api/ingest/{task_id}").json()["stage"] == "awaiting_user_confirmation"


def test_page_tags_requires_approval_and_contract(client):
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(2), "application/pdf")}).json()["task_id"]
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "contract", "2": "other"}})
    assert r.status_code == 422   # no approval page
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "other"}})
    assert r.status_code == 422   # no contract page


def test_page_tags_requires_every_page_tagged(client):
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")}).json()["task_id"]
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "contract"}})
    assert r.status_code == 422   # page 3 untagged


def test_confirm_persists_page_roles(client, monkeypatch):
    monkeypatch.setattr(uploads, "extract_approval",
                        lambda pdf, page_no, **kw: {"contract_number": "JSUS2026201"})
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")}).json()["task_id"]
    client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {
        "1": "approval", "2": "contract", "3": "other"}})
    r = client.post(f"/api/ingest/{task_id}/confirm", json={
        "fields": {"contract_id": "JSUS2026201", "amount": "100"},
        "effective_date": "2026-01-01", "expiration_date": "2027-01-01"})
    assert r.status_code == 200
    pages = db.get_pages("JSUS2026201")
    roles = {p["page_no"]: p["page_type"] for p in pages}
    assert roles == {1: "approval", 2: "contract", 3: "other"}
