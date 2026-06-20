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
    return TestClient(create_app())


def test_config_shape(client):
    cfg = client.get("/api/config").json()
    assert cfg["ragEnabled"] is False
    assert "excelEnabled" in cfg
    assert isinstance(cfg["fileNoRules"], list)
    assert {"category", "prefix", "example"} <= set(cfg["fileNoRules"][0].keys())


def test_patch_config_persists_toggles(client):
    resp = client.patch("/api/config", json={"excelEnabled": True, "backupEnabled": False})
    assert resp.status_code == 200
    assert resp.json()["excelEnabled"] is True
    assert resp.json()["backupEnabled"] is False
    # persisted across a fresh GET
    again = client.get("/api/config").json()
    assert again["excelEnabled"] is True
    assert again["backupEnabled"] is False


def test_excel_toggle_controls_sync(client):
    from contract_rag.sync.service import _enabled

    client.patch("/api/config", json={"excelEnabled": True})
    assert _enabled() is True
    client.patch("/api/config", json={"excelEnabled": False})
    assert _enabled() is False


def test_patch_file_no_rules(client):
    resp = client.patch("/api/config/file-no-rules", json={"ordinary": {"prefix": ""}, "cn": {"prefix": "CN"}})
    assert resp.status_code == 200
    assert resp.json()["cn"]["prefix"] == "CN"
    categories = {rule["category"] for rule in client.get("/api/config").json()["fileNoRules"]}
    assert {"ordinary", "cn"} <= categories


def test_config_exposes_contract_versions(client):
    body = client.get("/api/config").json()
    assert isinstance(body["contractVersions"], list)
    assert "Supply Agreement" in body["contractVersions"]


def test_patch_contract_versions_persists(client):
    r = client.patch("/api/config/contract-versions", json={"versions": ["采购合同", "销售合同"]})
    assert r.status_code == 200
    assert r.json() == ["采购合同", "销售合同"]
    assert client.get("/api/config").json()["contractVersions"] == ["采购合同", "销售合同"]
