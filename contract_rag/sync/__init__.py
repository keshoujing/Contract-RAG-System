"""Excel ledger sync — detachable limb over the SQLite source of truth (decision 15).

Public backend interface (the front end connects only to these; see
``docs/INTERFACE.md``):

  Write / retry:
    sync_contract(contract_id)                 -> SyncResult
    resolve_conflict(contract_id, resolutions) -> SyncResult

  Read (processing page + merge page):
    get_status(contract_id)  -> dict | None
    list_statuses()          -> list[dict]
    get_conflict(contract_id) -> list[dict]

Disable the whole limb via ``excel.enabled: false`` in config — the core ingest
and retrieval never import or depend on this package.
"""
from contract_rag.sync.contract_versions import (
    get_contract_versions,
    set_contract_versions,
)
from contract_rag.sync.file_no import (
    assign_file_no,
    compose_file_name,
    get_file_no_rules,
    next_seq,
    set_file_no_rules,
)
from contract_rag.sync.service import (
    SyncResult,
    get_conflict,
    get_status,
    list_statuses,
    resolve_conflict,
    sync_contract,
)

__all__ = [
    "SyncResult",
    "sync_contract",
    "resolve_conflict",
    "get_status",
    "list_statuses",
    "get_conflict",
    # Contract versions — user-managed list (settings kv)
    "get_contract_versions",
    "set_contract_versions",
    # File No. rules — reserved setter/getter for the front end (decision 15)
    "get_file_no_rules",
    "set_file_no_rules",
    "assign_file_no",
    "next_seq",
    "compose_file_name",
]
