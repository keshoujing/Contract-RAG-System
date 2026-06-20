"""Persistent Excel-sync state, one row per contract (decision 15).

Owns its own ``excel_sync`` table (created lazily) so the Excel limb stays
detachable — ``storage/db.py`` knows nothing about Excel. The "处理中" page reads
these rows to show per-contract sync status; the merge page reads ``conflict_json``.

Stored per contract:
  state           - SyncState.* (synced/pending/retrying/conflict/disabled)
  baseline_json   - last-exported field values (the three-way merge reference)
  conflict_json   - list of unresolved FieldConflicts when state == conflict
  attempts        - consecutive failed write attempts (drives retry/backoff)
  last_error      - last write failure message (e.g. "file locked")
"""
from __future__ import annotations

import json

from contract_rag.storage.db import _now, connect

_SCHEMA = """
CREATE TABLE IF NOT EXISTS excel_sync (
    contract_id    TEXT PRIMARY KEY,
    state          TEXT NOT NULL,
    baseline_json  TEXT,
    conflict_json  TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    last_attempt_at TEXT,
    updated_at     TEXT NOT NULL
);
"""


def init(db_path=None) -> None:
    """Create the ``excel_sync`` table if absent. Idempotent."""
    with connect(db_path) as conn:
        conn.executescript(_SCHEMA)


def get(contract_id: str, db_path=None) -> dict | None:
    """Return the sync row (baseline/conflict decoded), or None if never synced."""
    init(db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM excel_sync WHERE contract_id = ?", (contract_id,)
        ).fetchone()
    if not row:
        return None
    out = dict(row)
    out["baseline"] = json.loads(out["baseline_json"]) if out["baseline_json"] else None
    out["conflicts"] = json.loads(out["conflict_json"]) if out["conflict_json"] else []
    return out


def list_all(db_path=None) -> list[dict]:
    """All sync rows (for the processing page). Newest update first."""
    init(db_path)
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM excel_sync ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_baseline(contract_id: str, db_path=None) -> dict | None:
    row = get(contract_id, db_path)
    return row["baseline"] if row else None


def upsert(
    contract_id: str,
    *,
    state: str,
    baseline: dict | None = None,
    conflicts: list | None = None,
    attempts: int | None = None,
    last_error: str | None = None,
    db_path=None,
) -> None:
    """Insert/update the sync row. Only provided fields change (baseline/conflicts
    are written when passed; pass ``conflicts=[]`` to clear them)."""
    init(db_path)
    now = _now()
    existing = get(contract_id, db_path)

    baseline_json = (
        json.dumps(baseline, ensure_ascii=False)
        if baseline is not None
        else (existing["baseline_json"] if existing else None)
    )
    conflict_json = (
        json.dumps(conflicts, ensure_ascii=False)
        if conflicts is not None
        else (existing["conflict_json"] if existing else None)
    )
    attempts_val = attempts if attempts is not None else (existing["attempts"] if existing else 0)

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO excel_sync
                (contract_id, state, baseline_json, conflict_json, attempts,
                 last_error, last_attempt_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(contract_id) DO UPDATE SET
                state=excluded.state,
                baseline_json=excluded.baseline_json,
                conflict_json=excluded.conflict_json,
                attempts=excluded.attempts,
                last_error=excluded.last_error,
                last_attempt_at=excluded.last_attempt_at,
                updated_at=excluded.updated_at
            """,
            (
                contract_id, state, baseline_json, conflict_json, attempts_val,
                last_error, now, now,
            ),
        )
