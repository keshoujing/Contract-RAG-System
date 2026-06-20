import json
from contract_rag.storage import db


def test_tasks_and_contracts_have_new_columns(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    with db.connect(p) as conn:
        task_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
        contract_cols = {r["name"] for r in conn.execute("PRAGMA table_info(contracts)")}
    assert {"approval_page", "extraction"} <= task_cols
    assert "page_count" in contract_cols


def test_set_task_extraction_roundtrip(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    task_id = db.create_task(db_path=p)
    db.set_task_extraction(task_id, approval_page=2, extraction={"contract_number": "X1"}, db_path=p)
    row = db.get_task(task_id, db_path=p)
    assert row["approval_page"] == 2
    assert json.loads(row["extraction"])["contract_number"] == "X1"


def test_delete_contract_removes_row(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    db.upsert_contract("C1", db_path=p, status="active")
    db.insert_pages("C1", [{"page_no": 1}], db_path=p)
    db.delete_contract("C1", db_path=p)
    assert db.get_contract("C1", db_path=p) is None
    assert db.get_pages("C1", db_path=p) == []


def test_tasks_has_page_tags_and_doc_kind_columns(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    with db.connect(p) as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    assert "page_tags" in cols
    assert "doc_kind" in cols


def test_tasks_page_tags_doc_kind_added_to_old_db(tmp_path):
    """_migrate_tasks must add page_tags/doc_kind to a DB that predates them."""
    import sqlite3

    p = tmp_path / "old.db"
    # Build a minimal tasks table without the new columns (simulates a pre-existing DB)
    conn = sqlite3.connect(str(p))
    conn.execute(
        "CREATE TABLE tasks ("
        "task_id TEXT PRIMARY KEY, contract_id TEXT, stage TEXT NOT NULL, "
        "status TEXT NOT NULL, error_message TEXT, approval_page INTEGER, "
        "extraction TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
    )
    conn.commit()
    conn.close()

    # Running init_db should apply the migration
    db.init_db(p)

    with db.connect(p) as conn:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    assert "page_tags" in cols
    assert "doc_kind" in cols


def test_set_and_read_page_tags(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    tid = db.create_task(db_path=p)
    db.set_task_page_tags(tid, {"1": "approval", "2": "contract"}, db_path=p)
    row = db.get_task(tid, db_path=p)
    assert json.loads(row["page_tags"]) == {"1": "approval", "2": "contract"}
