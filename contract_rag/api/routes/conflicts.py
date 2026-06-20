"""Conflict merge page: three-way view + resolution."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from contract_rag.api import projections
from contract_rag.api.schemas import ResolveRequest
from contract_rag.storage import db
from contract_rag import sync

router = APIRouter()


@router.get("/contracts/{contract_id}/conflict")
def get_conflict(contract_id: str) -> list[dict]:
    return projections.to_conflict_fields(sync.get_conflict(contract_id))


@router.post("/contracts/{contract_id}/resolve")
def resolve(contract_id: str, body: ResolveRequest) -> dict:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    result = sync.resolve_conflict(contract_id, body.resolutions)
    return {"contract_id": contract_id, "state": result.state}
