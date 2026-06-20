"""Processing page: per-contract ingest (tasks) + Excel sync state."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from contract_rag.api import projections
from contract_rag.storage import db
from contract_rag import sync

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
    for status in sync.list_statuses():  # newest first
        cid = status["contract_id"]
        contract = db.get_contract(cid)
        if contract is None:
            continue
        out.append(projections.to_processing_row(
            contract=contract, task=_latest_task_for(cid), sync_status=status
        ))
    return out


@router.post("/contracts/{contract_id}/sync/retry")
def retry_sync(contract_id: str) -> dict:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    result = sync.sync_contract(contract_id)
    return {"contract_id": contract_id, "state": result.state}
