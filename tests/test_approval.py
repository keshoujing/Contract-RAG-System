"""Approval-page extraction parsing + projection to the contracts row (decision 4)."""
from __future__ import annotations

from contract_rag.ingest.approval import parse_approval_fields
from contract_rag.ingest.approval_store import (
    contract_row_from_approval,
    resolve_contract_id,
)


def test_parse_coerces_amount_and_keeps_known_fields() -> None:
    raw = '{"contract_number": "JSEGRCXS20260003", "amount": "$39,041.60", "currency": "USD"}'
    fields = parse_approval_fields(raw)
    assert fields["contract_number"] == "JSEGRCXS20260003"
    assert fields["amount"] == 39041.6
    assert fields["currency"] == "USD"


def test_parse_keeps_contract_type() -> None:
    raw = '{"contract_number": "X", "contract_type": "Standard"}'
    assert parse_approval_fields(raw)["contract_type"] == "Standard"


def test_parse_drops_unknown_keys() -> None:
    raw = '{"contract_number": "X", "document_code": "JSUS/04-1GS-126"}'
    fields = parse_approval_fields(raw)
    assert "document_code" not in fields
    assert fields["contract_number"] == "X"


def test_resolve_contract_id_uses_contract_number() -> None:
    assert resolve_contract_id({"contract_number": "JSEGRCXS20260003"}) == "JSEGRCXS20260003"


def test_resolve_contract_id_falls_back_when_missing() -> None:
    assert resolve_contract_id({"contract_number": None}, fallback="task-123") == "task-123"
    assert resolve_contract_id({"contract_number": "  "}, fallback="task-123") == "task-123"


def test_contract_row_projects_only_contract_columns() -> None:
    fields = {
        "contract_number": "X",
        "counterparty": "Jushi Egypt",
        "amount": 39041.6,
        "_per_field_confidence": {},      # internal, must be dropped
    }
    row = contract_row_from_approval(fields)
    assert row["contract_number"] == "X"
    assert row["counterparty"] == "Jushi Egypt"
    assert row["amount"] == 39041.6
    assert "_per_field_confidence" not in row
