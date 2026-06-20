"""Persist approval-page extraction into the SQLite ``contracts`` table.

Bridges ``approval.extract_approval`` (which returns raw extracted fields) to the
real-source store (``storage.db``). Per decision 4 the extracted
``contract_number`` becomes the system ``contract_id`` — the filename is never
trusted. The full extraction (incl. per-field confidence/source span) is kept in
``raw_extraction`` so the front-end can drive field-level confirmation later.

The pure mapper (``contract_row_from_approval``) is unit-tested; ``persist_approval``
is the thin DB write.
"""
from __future__ import annotations

from contract_rag.storage import db

# Approval fields that map 1:1 onto ``contracts`` columns (decision 4 / decision 10).
_CONTRACT_FIELDS = (
    "contract_number",
    "counterparty",
    "amount",
    "currency",
    "project_name",
    "department",
    "petitioner",
    "petition_date",
    "brief_description",
    "contract_type",
    "term_months",
)


def resolve_contract_id(fields: dict, *, fallback: str | None = None) -> str | None:
    """The system contract_id = the extracted ``contract_number`` (never the filename).

    Returns ``fallback`` (e.g. the task_id placeholder) when the number could not
    be extracted, matching decision 4's "unfilled -> placeholder" rule.
    """
    number = fields.get("contract_number")
    if isinstance(number, str) and number.strip():
        return number.strip()
    return fallback


def contract_row_from_approval(fields: dict) -> dict:
    """Project raw approval fields onto the ``contracts`` column subset.

    Unknown keys are dropped; the full payload is preserved separately in
    ``raw_extraction`` by ``persist_approval``. Returns a new dict.
    """
    return {key: fields.get(key) for key in _CONTRACT_FIELDS}


def persist_approval(fields: dict, *, fallback_id: str | None = None, db_path=None) -> str | None:
    """Upsert the extracted contract metadata; return the resolved ``contract_id``.

    Returns ``None`` only when no contract_number was extracted and no fallback
    was given (caller must then obtain an id before storing chunks).
    """
    contract_id = resolve_contract_id(fields, fallback=fallback_id)
    if contract_id is None:
        return None

    db.init_db(db_path)
    row = contract_row_from_approval(fields)
    db.upsert_contract(
        contract_id,
        db_path=db_path,
        status="active",
        raw_extraction=fields,
        **row,
    )
    return contract_id
