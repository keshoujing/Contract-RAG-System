"""File No. assignment and File Name composition for the contract registry."""
from __future__ import annotations

from datetime import date

from contract_rag.registry import settings
from contract_rag.storage import db

_RULES_KEY = "file_no_rules"
_SEQ_WIDTH = 3

DEFAULT_FILE_NO_RULES: dict[str, dict] = {
    "default": {"prefix": ""},
    "chinabuy": {"prefix": "CN"},
    "PD": {"prefix": "PD"},
}


def get_file_no_rules(db_path=None) -> dict[str, dict]:
    return settings.get_setting(_RULES_KEY, dict(DEFAULT_FILE_NO_RULES), db_path=db_path)


def set_file_no_rules(rules: dict[str, dict], db_path=None) -> None:
    settings.set_setting(_RULES_KEY, rules, db_path=db_path)


def _prefix(category: str, rules: dict) -> str:
    rule = rules.get(category) or rules.get("default") or {}
    return rule.get("prefix", "")


def format_file_no(year: int, seq: int, category: str = "default", rules: dict | None = None) -> str:
    rules = rules if rules is not None else DEFAULT_FILE_NO_RULES
    return f"{_prefix(category, rules)}{year}{int(seq):0{_SEQ_WIDTH}d}"


def compose_file_name(file_no, contract_id, project_name) -> str | None:
    if not file_no or not contract_id:
        return None
    parts = [str(file_no), str(contract_id)]
    if project_name:
        parts.append(str(project_name))
    return "-".join(parts)


def next_seq(category: str, year: int, *, db_path=None) -> int:
    head = f"{_prefix(category, get_file_no_rules(db_path=db_path))}{year}"
    highest = 0
    for contract in db.list_contracts(db_path):
        fn = contract.get("file_no")
        if fn and fn.startswith(head):
            tail = fn[len(head):]
            if tail.isdigit():
                highest = max(highest, int(tail))
    return highest + 1


def assign_file_no(
    contract_id: str,
    *,
    category: str,
    year: int | None = None,
    seq: int | None = None,
    db_path=None,
) -> str:
    year = year or date.today().year
    if seq is None:
        seq = next_seq(category, year, db_path=db_path)
    file_no = format_file_no(year, seq, category, get_file_no_rules(db_path=db_path))
    db.upsert_contract(contract_id, db_path=db_path, file_no=file_no)
    return file_no
