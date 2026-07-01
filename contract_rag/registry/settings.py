"""User-settable runtime settings persisted as key-value JSON in SQLite."""
from __future__ import annotations

import json

from contract_rag.storage.db import _now, connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS registry_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def init(db_path=None) -> None:
    with connect(db_path) as conn:
        conn.executescript(_SCHEMA)


def get_setting(key: str, default=None, db_path=None):
    init(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT value_json FROM registry_settings WHERE key = ?", (key,)
        ).fetchone()
    return json.loads(row["value_json"]) if row else default


def set_setting(key: str, value, db_path=None) -> None:
    init(db_path)
    payload = json.dumps(value, ensure_ascii=False)
    now = _now()
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO registry_settings (key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value_json=excluded.value_json,
                updated_at=excluded.updated_at
            """,
            (key, payload, now),
        )
