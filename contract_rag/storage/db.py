"""SQLite real-source store for contract metadata + pipeline run-state.

Per ``memory/ingestion_pipeline.md`` decision 10, SQLite is the real source of
truth (Weaviate chunks carry only ``contract_id`` and join back here). Three
tables:

  contracts  - one row per contract; real source for who/when/how-much queries
  tasks      - one row per ingestion run; stage/status for progress + future API
  pages      - one row per page; processing route + confidence

This slice populates ``contract_id/status/timestamps`` in ``contracts`` and
writes ``tasks``/``pages`` as the synchronous pipeline runs. The remaining
contract columns are created empty, to be filled by the approval-page
extraction slice (decision 4).
"""
from __future__ import annotations

import json
import pathlib
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from contract_rag.config import load_config

# Columns the caller may upsert into `contracts` (whitelist guards the dynamic
# SQL below against arbitrary column names).
_CONTRACT_COLS = (
    "contract_number", "counterparty", "amount", "currency", "project_name", "department",
    "petitioner", "petition_date", "brief_description", "contract_type",
    "effective_date", "expiration_date", "file_no", "status", "raw_extraction",
    "page_count", "term_months",
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS contracts (
    contract_id       TEXT PRIMARY KEY,
    contract_number   TEXT,          -- 合同编号 (Contract No. from approval/body)
    counterparty      TEXT,
    amount            REAL,
    currency          TEXT,
    project_name      TEXT,
    department        TEXT,
    petitioner        TEXT,
    petition_date     TEXT,
    brief_description TEXT,
    contract_type     TEXT,          -- 合同版本 (Contract Version, from the approval form)
    effective_date    TEXT,
    expiration_date   TEXT,
    file_no           TEXT,          -- 存档编号 (File No.) — rule-assigned, see sync/file_no.py
    status            TEXT DEFAULT 'active',
    page_count        INTEGER,
    term_months       INTEGER,        -- 计价期: NULL=未指定, 0=一次性, N=N个月 (用于年均价折算)
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    raw_extraction    TEXT          -- JSON: full fields + per-field confidence/source span
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id       TEXT PRIMARY KEY,
    contract_id   TEXT,                       -- nullable until approval extraction
    stage         TEXT NOT NULL,
    status        TEXT NOT NULL,              -- running | done | failed
    error_message TEXT,
    approval_page INTEGER,
    extraction    TEXT,
    page_tags     TEXT,
    doc_kind      TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
    page_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    contract_id    TEXT NOT NULL,
    page_no        INTEGER NOT NULL,
    page_type      TEXT,           -- 审批/合同/比价/补充 (user-tagged; not set this slice)
    route          TEXT,           -- mineru | vlm | rapidfuzz (processing engine)
    avg_confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_pages_contract ON pages(contract_id);

CREATE TABLE IF NOT EXISTS qa_conversations (
    conversation_id TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS qa_messages (
    message_id      TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    evidence        TEXT,
    run_id          TEXT,            -- LangSmith run id (assistant rows) -> feedback target
    created_at      TEXT NOT NULL,
    FOREIGN KEY(conversation_id) REFERENCES qa_conversations(conversation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_qa_messages_conversation ON qa_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS qa_feedback (
    message_id      TEXT PRIMARY KEY,   -- one vote per assistant message; re-vote replaces
    run_id          TEXT,               -- copied from the message so curation/LangSmith can join
    score           TEXT NOT NULL,      -- 'up' | 'down'
    comment         TEXT,
    created_at      TEXT NOT NULL,
    FOREIGN KEY(message_id) REFERENCES qa_messages(message_id) ON DELETE CASCADE
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _db_path() -> pathlib.Path:
    return load_config().paths.sqlite_path


def connect(db_path: str | pathlib.Path | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path or _db_path()))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db(db_path: str | pathlib.Path | None = None) -> None:
    """Create tables if they don't exist, and apply additive column migrations.

    Idempotent. ``CREATE TABLE IF NOT EXISTS`` does not add columns to a table
    that predates them, so new ``contracts`` columns are added defensively here.
    """
    path = pathlib.Path(db_path or _db_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    with connect(path) as conn:
        conn.executescript(_SCHEMA)
        _migrate_contracts(conn)
        _migrate_tasks(conn)
        _migrate_qa(conn)


def _migrate_contracts(conn: sqlite3.Connection) -> None:
    """Add any whitelisted `contracts` column missing from a pre-existing DB."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(contracts)")}
    types = {"amount": "REAL", "page_count": "INTEGER", "term_months": "INTEGER"}
    for col in _CONTRACT_COLS:
        if col not in existing:
            conn.execute(f"ALTER TABLE contracts ADD COLUMN {col} {types.get(col, 'TEXT')}")


def _migrate_tasks(conn: sqlite3.Connection) -> None:
    """Add task columns missing from a pre-existing DB (additive)."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    for col, decl in (
        ("approval_page", "INTEGER"),
        ("extraction", "TEXT"),
        ("page_tags", "TEXT"),
        ("doc_kind", "TEXT"),
    ):
        if col not in existing:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")


def _migrate_qa(conn: sqlite3.Connection) -> None:
    """Add the qa_messages.run_id column to a pre-existing DB (additive)."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(qa_messages)")}
    if "run_id" not in existing:
        conn.execute("ALTER TABLE qa_messages ADD COLUMN run_id TEXT")


# --------------------------------------------------------------------------- #
# tasks
# --------------------------------------------------------------------------- #

def create_task(contract_id: str | None = None, db_path=None) -> str:
    task_id = uuid.uuid4().hex
    now = _now()
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO tasks (task_id, contract_id, stage, status, created_at, updated_at) "
            "VALUES (?, ?, 'uploaded', 'running', ?, ?)",
            (task_id, contract_id, now, now),
        )
    return task_id


def update_task_stage(
    task_id: str,
    stage: str,
    *,
    status: str | None = None,
    error_message: str | None = None,
    contract_id: str | None = None,
    db_path=None,
) -> None:
    sets = ["stage = ?", "updated_at = ?"]
    vals: list[Any] = [stage, _now()]
    if status is not None:
        sets.append("status = ?")
        vals.append(status)
    if error_message is not None:
        sets.append("error_message = ?")
        vals.append(error_message)
    if contract_id is not None:
        sets.append("contract_id = ?")
        vals.append(contract_id)
    vals.append(task_id)
    with connect(db_path) as conn:
        conn.execute(f"UPDATE tasks SET {', '.join(sets)} WHERE task_id = ?", vals)


def get_task(task_id: str, db_path=None) -> dict | None:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def set_task_extraction(task_id: str, *, approval_page: int | None = None, extraction=None, db_path=None) -> None:
    """Stash the chosen approval page + raw extraction JSON on the task row."""
    payload = json.dumps(extraction, ensure_ascii=False) if isinstance(extraction, (dict, list)) else extraction
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET approval_page = ?, extraction = ?, updated_at = ? WHERE task_id = ?",
            (approval_page, payload, _now(), task_id),
        )


def set_task_page_tags(task_id: str, page_tags: dict, db_path=None) -> None:
    """Stash the per-page role map {page_no(str): role} on the task row."""
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET page_tags = ?, updated_at = ? WHERE task_id = ?",
            (json.dumps(page_tags, ensure_ascii=False), _now(), task_id),
        )


# --------------------------------------------------------------------------- #
# contracts
# --------------------------------------------------------------------------- #

def contract_exists(contract_id: str, db_path=None) -> bool:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT 1 FROM contracts WHERE contract_id = ?", (contract_id,)
        ).fetchone()
    return row is not None


def upsert_contract(contract_id: str, db_path=None, **fields: Any) -> None:
    """Insert or update a contract row. Unknown columns are rejected.

    ``raw_extraction`` may be passed as a dict; it is JSON-encoded.
    """
    bad = set(fields) - set(_CONTRACT_COLS)
    if bad:
        raise ValueError(f"unknown contract columns: {sorted(bad)}")
    if isinstance(fields.get("raw_extraction"), (dict, list)):
        fields["raw_extraction"] = json.dumps(fields["raw_extraction"], ensure_ascii=False)

    now = _now()
    cols = list(fields)
    with connect(db_path) as conn:
        if contract_exists(contract_id, db_path):
            if cols:
                assignments = ", ".join(f"{c} = ?" for c in cols)
                conn.execute(
                    f"UPDATE contracts SET {assignments}, updated_at = ? WHERE contract_id = ?",
                    [*[fields[c] for c in cols], now, contract_id],
                )
            else:
                conn.execute(
                    "UPDATE contracts SET updated_at = ? WHERE contract_id = ?", (now, contract_id)
                )
        else:
            all_cols = ["contract_id", *cols, "created_at", "updated_at"]
            placeholders = ", ".join("?" for _ in all_cols)
            conn.execute(
                f"INSERT INTO contracts ({', '.join(all_cols)}) VALUES ({placeholders})",
                [contract_id, *[fields[c] for c in cols], now, now],
            )


def get_contract(contract_id: str, db_path=None) -> dict | None:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM contracts WHERE contract_id = ?", (contract_id,)
        ).fetchone()
    return dict(row) if row else None


def delete_contract(contract_id: str, db_path=None) -> None:
    """Atomically remove a contract row and its page rows (used by overwrite re-ingest)."""
    with connect(db_path) as conn:
        with conn:
            conn.execute("DELETE FROM pages WHERE contract_id = ?", (contract_id,))
            conn.execute("DELETE FROM contracts WHERE contract_id = ?", (contract_id,))


def list_contracts(db_path=None) -> list[dict]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM contracts ORDER BY created_at").fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# pages
# --------------------------------------------------------------------------- #

def insert_pages(
    contract_id: str,
    rows: Iterable[dict[str, Any]],
    *,
    replace: bool = True,
    db_path=None,
) -> None:
    """Insert page rows. Each dict: {page_no, page_type?, route?, avg_confidence?}.

    ``replace=True`` clears existing rows for the contract first (re-ingest).
    """
    rows = list(rows)
    with connect(db_path) as conn:
        if replace:
            conn.execute("DELETE FROM pages WHERE contract_id = ?", (contract_id,))
        conn.executemany(
            "INSERT INTO pages (contract_id, page_no, page_type, route, avg_confidence) "
            "VALUES (?, ?, ?, ?, ?)",
            [
                (
                    contract_id,
                    r["page_no"],
                    r.get("page_type"),
                    r.get("route"),
                    r.get("avg_confidence"),
                )
                for r in rows
            ],
        )


def get_pages(contract_id: str, db_path=None) -> list[dict]:
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM pages WHERE contract_id = ? ORDER BY page_no", (contract_id,)
        ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- #
# Q&A conversations
# --------------------------------------------------------------------------- #

def create_conversation(title: str = "新会话", db_path=None) -> dict:
    init_db(db_path)
    conversation_id = uuid.uuid4().hex
    now = _now()
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO qa_conversations (conversation_id, title, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
            (conversation_id, title, now, now),
        )
    return {
        "conversation_id": conversation_id,
        "title": title,
        "created_at": now,
        "updated_at": now,
    }


def ensure_conversation(conversation_id: str | None = None, *, title: str = "新会话", db_path=None) -> dict:
    if conversation_id:
        existing = get_conversation(conversation_id, db_path=db_path)
        if existing is not None:
            return existing
    return create_conversation(title=title, db_path=db_path)


def list_conversations(db_path=None) -> list[dict]:
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT c.conversation_id, c.title, c.created_at, c.updated_at,
                   COUNT(m.message_id) AS message_count
            FROM qa_conversations c
            LEFT JOIN qa_messages m ON m.conversation_id = c.conversation_id
            GROUP BY c.conversation_id
            ORDER BY c.updated_at DESC
            """
        ).fetchall()
    return [dict(r) for r in rows]


def get_conversation(conversation_id: str, db_path=None) -> dict | None:
    init_db(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT c.conversation_id, c.title, c.created_at, c.updated_at,
                   COUNT(m.message_id) AS message_count
            FROM qa_conversations c
            LEFT JOIN qa_messages m ON m.conversation_id = c.conversation_id
            WHERE c.conversation_id = ?
            GROUP BY c.conversation_id
            """,
            (conversation_id,),
        ).fetchone()
    return dict(row) if row else None


def get_conversation_messages(conversation_id: str, db_path=None) -> list[dict]:
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT m.*, f.score AS feedback FROM qa_messages m "
            "LEFT JOIN qa_feedback f ON f.message_id = m.message_id "
            "WHERE m.conversation_id = ? ORDER BY m.created_at, m.message_id",
            (conversation_id,),
        ).fetchall()
    messages = []
    for row in rows:
        item = dict(row)
        item["evidence"] = json.loads(item["evidence"]) if item.get("evidence") else []
        messages.append(item)
    return messages


def append_conversation_message(
    conversation_id: str,
    *,
    role: str,
    content: str,
    evidence: list[dict] | None = None,
    run_id: str | None = None,
    db_path=None,
) -> dict:
    init_db(db_path)
    message_id = uuid.uuid4().hex
    now = _now()
    is_assistant = role == "assistant"
    evidence_payload = json.dumps(evidence or [], ensure_ascii=False) if is_assistant else None
    run_id = run_id if is_assistant else None
    with connect(db_path) as conn:
        conn.execute(
            "INSERT INTO qa_messages (message_id, conversation_id, role, content, evidence, run_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (message_id, conversation_id, role, content, evidence_payload, run_id, now),
        )
        conn.execute(
            "UPDATE qa_conversations SET updated_at = ? WHERE conversation_id = ?",
            (now, conversation_id),
        )
    return {
        "message_id": message_id,
        "conversation_id": conversation_id,
        "role": role,
        "content": content,
        "evidence": evidence or [],
        "run_id": run_id,
        "created_at": now,
    }


def add_message_feedback(
    message_id: str, score: str, comment: str | None = None, db_path=None
) -> dict | None:
    """Upsert a 👍/👎 on an assistant message (re-vote replaces). Returns the
    feedback dict (carrying the message's ``run_id``), or ``None`` if there is no
    such assistant message."""
    init_db(db_path)
    now = _now()
    with connect(db_path) as conn:
        msg = conn.execute(
            "SELECT run_id FROM qa_messages WHERE message_id = ? AND role = 'assistant'",
            (message_id,),
        ).fetchone()
        if msg is None:
            return None
        conn.execute(
            "INSERT OR REPLACE INTO qa_feedback (message_id, run_id, score, comment, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (message_id, msg["run_id"], score, comment, now),
        )
    return {"message_id": message_id, "run_id": msg["run_id"], "score": score,
            "comment": comment, "created_at": now}


def list_feedback(db_path=None) -> list[dict]:
    """All feedback joined to its answer + evidence (source for the gold flywheel)."""
    init_db(db_path)
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT f.message_id, f.run_id, f.score, f.comment, f.created_at, "
            "       m.conversation_id, m.content AS answer, m.evidence "
            "FROM qa_feedback f JOIN qa_messages m ON m.message_id = f.message_id "
            "ORDER BY f.created_at, f.message_id"
        ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        item["evidence"] = json.loads(item["evidence"]) if item.get("evidence") else []
        out.append(item)
    return out


def rename_conversation_if_default(conversation_id: str, title: str, db_path=None) -> None:
    init_db(db_path)
    title = title.strip()[:80] or "新会话"
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT title FROM qa_conversations WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
        if row and row["title"] == "新会话":
            conn.execute(
                "UPDATE qa_conversations SET title = ?, updated_at = ? WHERE conversation_id = ?",
                (title, _now(), conversation_id),
            )


def delete_conversation(conversation_id: str, db_path=None) -> None:
    init_db(db_path)
    with connect(db_path) as conn:
        conn.execute("DELETE FROM qa_conversations WHERE conversation_id = ?", (conversation_id,))
