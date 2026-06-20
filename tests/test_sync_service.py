"""End-to-end Excel ledger sync over a temp SQLite DB + temp workbook (decision 15).

Exercises the real adapter + merge + state, with only the config seams
(``_enabled`` / ``_adapter``) monkeypatched so no real config/file is needed.
"""
from __future__ import annotations

import pytest

from contract_rag.storage import db
from contract_rag.sync import service
from contract_rag.sync.excel_adapter import ExcelAdapter, ExcelLocked
from contract_rag.sync.models import SyncState


@pytest.fixture
def env(tmp_path, monkeypatch):
    db_path = tmp_path / "t.db"
    xlsx = tmp_path / "ledger.xlsx"
    db.init_db(db_path)
    monkeypatch.setattr(service, "_enabled", lambda: True)
    monkeypatch.setattr(service, "_adapter", lambda db_path=None: ExcelAdapter(xlsx))
    return db_path, xlsx


def _seed(db_path, contract_id="JSEGRCXS20260003", **fields):
    db.upsert_contract(contract_id, db_path=db_path,
                       counterparty="Jushi Egypt", amount=39041.6, **fields)
    return contract_id


def test_disabled_returns_disabled(tmp_path, monkeypatch):
    db_path = tmp_path / "t.db"
    db.init_db(db_path)
    monkeypatch.setattr(service, "_enabled", lambda: False)
    cid = _seed(db_path)
    res = service.sync_contract(cid, db_path=db_path)
    assert res.state == SyncState.DISABLED


def test_append_new_writes_ledger_and_baseline(env):
    db_path, xlsx = env
    cid = _seed(db_path)
    res = service.sync_contract(cid, db_path=db_path)
    assert res.state == SyncState.SYNCED
    assert res.pushed["counterparty"] == "Jushi Egypt"
    # the row really landed in the workbook
    assert ExcelAdapter(xlsx).find_row(cid)["counterparty"] == "Jushi Egypt"
    # baseline recorded for future three-way merges
    assert service.get_status(cid, db_path=db_path)["baseline"]["counterparty"] == "Jushi Egypt"


def test_locked_ledger_degrades_to_pending(env, monkeypatch):
    db_path, xlsx = env
    cid = _seed(db_path)

    class Locked(ExcelAdapter):
        def find_row(self, contract_id):
            raise ExcelLocked("open in Excel")

    monkeypatch.setattr(service, "_adapter", lambda db_path=None: Locked(xlsx))
    res = service.sync_contract(cid, db_path=db_path)
    assert res.state == SyncState.PENDING
    assert res.error


def test_human_edit_to_system_field_conflicts_then_resolves(env):
    db_path, xlsx = env
    cid = _seed(db_path)
    service.sync_contract(cid, db_path=db_path)  # establishes baseline

    # simulate a human editing a SYSTEM column directly in the ledger
    ExcelAdapter(xlsx).upsert_row(cid, {"counterparty": "巨石埃及玻璃纤维"})

    res = service.sync_contract(cid, db_path=db_path)
    assert res.state == SyncState.CONFLICT
    conflicts = service.get_conflict(cid, db_path=db_path)
    assert conflicts[0]["field"] == "counterparty"

    # user picks the ledger value -> absorbed into SQLite, both converge
    resolved = service.resolve_conflict(cid, {"counterparty": "excel"}, db_path=db_path)
    assert resolved.state == SyncState.SYNCED
    assert db.get_contract(cid, db_path)["counterparty"] == "巨石埃及玻璃纤维"
    assert service.get_conflict(cid, db_path=db_path) == []


def test_derived_file_name_is_written_to_ledger(env):
    db_path, xlsx = env
    cid = _seed(db_path, project_name="埃及纸护角纸筒合同", file_no="F-1")
    service.sync_contract(cid, db_path=db_path)
    row = ExcelAdapter(xlsx).find_row(cid)
    assert row["file_no"] == "F-1"
    assert row["file_name"] == f"F-1-{cid}-埃及纸护角纸筒合同"


def test_human_edit_to_human_field_is_absorbed_not_conflict(env):
    db_path, xlsx = env
    cid = _seed(db_path)
    service.sync_contract(cid, db_path=db_path)

    ExcelAdapter(xlsx).upsert_row(cid, {"effective_date": "2026-03-15"})

    res = service.sync_contract(cid, db_path=db_path)
    assert res.state == SyncState.SYNCED
    assert res.absorbed["effective_date"] == "2026-03-15"
    assert db.get_contract(cid, db_path)["effective_date"] == "2026-03-15"
