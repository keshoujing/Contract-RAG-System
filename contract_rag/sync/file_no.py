"""File No. (存档编号) assignment + File Name composition (decision 15).

The archive File No. is ``{prefix}{year}{seq:03d}`` — a per-(category, year)
running sequence that resets each year (e.g. ``2026001`` for an ordinary contract,
``CN2026001`` for china-buy, ``PD2026001`` for category PD). The **category is
supplied by the user**; the per-category prefix is **user-settable from the front
end** via :func:`set_file_no_rules` (persisted), so new categories/prefixes need no
code change.

File Name is *derived* and must stay consistent with its parts (decision 15):

    File Name = {File No.}-{Contract No.}-{Request Description}
              =  存档编号  -   合同号    -    合同内容

Pure helpers (formatting/composition) are unit-tested; the rule store and the
sequence scan are the stateful parts.

NOTE on the sequence: ``next_seq`` counts **per category, per year** (so 2026001,
CN2026001, PD2026001 can coexist), derived from existing ``file_no`` values. If a
single shared per-year counter is wanted instead, that is the one knob to change.
"""
from __future__ import annotations

from datetime import date

from contract_rag.sync import settings
from contract_rag.storage import db

_RULES_KEY = "file_no_rules"
_SEQ_WIDTH = 3  # 3-digit yearly sequence: 001, 002, ...

# Seed rules (examples from the spec). The front end overrides via set_file_no_rules.
DEFAULT_FILE_NO_RULES: dict[str, dict] = {
    "default": {"prefix": ""},     # ordinary contract: 2026001
    "chinabuy": {"prefix": "CN"},  # china-buy:        CN2026001
    "PD": {"prefix": "PD"},         # category PD:      PD2026001
}


# --- rule store (front-end setter/getter) ---------------------------------- #

def get_file_no_rules(db_path=None) -> dict[str, dict]:
    """Current File No. rule set (falls back to the seed defaults)."""
    return settings.get_setting(_RULES_KEY, dict(DEFAULT_FILE_NO_RULES), db_path=db_path)


def set_file_no_rules(rules: dict[str, dict], db_path=None) -> None:
    """Reserved for the front end: replace the File No. rule set (persisted)."""
    settings.set_setting(_RULES_KEY, rules, db_path=db_path)


# --- pure helpers ---------------------------------------------------------- #

def _prefix(category: str, rules: dict) -> str:
    rule = rules.get(category) or rules.get("default") or {}
    return rule.get("prefix", "")


def format_file_no(year: int, seq: int, category: str = "default", rules: dict | None = None) -> str:
    """Format ``{prefix}{year}{seq:03d}`` for a category (e.g. ``CN2026001``)."""
    rules = rules if rules is not None else DEFAULT_FILE_NO_RULES
    return f"{_prefix(category, rules)}{year}{int(seq):0{_SEQ_WIDTH}d}"


def compose_file_name(file_no, contract_id, project_name) -> str | None:
    """Derive File Name = ``{file_no}-{contract_id}-{project_name}`` (fixed order).

    Returns None if the two required parts (file_no, contract_id) are missing —
    you cannot form an archive name without them.
    """
    if not file_no or not contract_id:
        return None
    parts = [str(file_no), str(contract_id)]
    if project_name:
        parts.append(str(project_name))
    return "-".join(parts)


# --- assignment (user supplies the category; sequence is auto, per year) ----- #

def next_seq(category: str, year: int, *, db_path=None) -> int:
    """Next per-(category, year) sequence = max existing for that prefix+year, +1."""
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
    """Assign + persist a File No. for a contract; return it.

    ``category`` is supplied by the user. ``year`` defaults to the current year;
    ``seq`` is auto-assigned (next per-category-per-year) unless given explicitly
    (e.g. to back-fill a specific number). Idempotent per contract_id — overwrites.
    """
    year = year or date.today().year
    if seq is None:
        seq = next_seq(category, year, db_path=db_path)
    file_no = format_file_no(year, seq, category, get_file_no_rules(db_path=db_path))
    db.upsert_contract(contract_id, db_path=db_path, file_no=file_no)
    return file_no
