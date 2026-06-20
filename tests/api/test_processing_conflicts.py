import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.storage import db
from contract_rag.sync import state


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    db.upsert_contract("C1", status="active", counterparty="OC")
    tid = db.create_task(contract_id="C1")
    db.update_task_stage(tid, "done", status="done")
    state.upsert("C1", state="conflict", conflicts=[
        {"field": "counterparty", "baseline": "A", "system": "A", "excel": "B"},
    ], db_path=dbp)
    return TestClient(create_app())


def test_processing_lists_rows(client):
    rows = client.get("/api/processing").json()
    assert rows[0]["contract_id"] == "C1"
    assert rows[0]["ingest"]["status"] == "done"
    assert rows[0]["sync"]["state"] == "conflict"


def test_conflict_has_owner_and_suggested(client):
    fields = client.get("/api/contracts/C1/conflict").json()
    assert fields[0]["owner"] == "system"
    assert fields[0]["suggested"] == "system"
