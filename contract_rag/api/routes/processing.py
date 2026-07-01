"""Processing page: per-contract ingest state."""
from __future__ import annotations

from fastapi import APIRouter

from contract_rag.api import projections
from contract_rag.storage import db

router = APIRouter()


def _latest_task_for(contract_id: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE contract_id = ? ORDER BY updated_at DESC LIMIT 1",
            (contract_id,),
        ).fetchone()
    return dict(row) if row else None


@router.get("/processing")
def list_processing() -> list[dict]:
    out = []
    for contract in db.list_contracts():
        out.append(projections.to_processing_row(
            contract=contract, task=_latest_task_for(contract["contract_id"])
        ))
    return out
