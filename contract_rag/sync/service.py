"""Excel ledger sync orchestration (decision 15) — the public backend interface.

Ties together the config toggle, the SQLite contract (system source of truth),
the persistent sync state/baseline, the pure three-way merge, and the Excel I/O
adapter. The front end (processing page + conflict-merge page) drives everything
through the functions here; see ``docs/INTERFACE.md``.

Design guarantees:
  - SQLite is authoritative; the core never depends on Excel succeeding.
  - A locked ledger degrades to ``pending`` (retryable), never an exception to
    the caller and never a clobbered human edit.
  - Only genuine same-field divergence on a system column (or both-sides edits)
    becomes a ``conflict`` the user must resolve.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from contract_rag.config import load_config
from contract_rag.storage import db
from contract_rag.sync import settings, state
from contract_rag.sync.excel_adapter import ExcelAdapter, ExcelLocked
from contract_rag.sync.file_no import compose_file_name
from contract_rag.sync.merge import plan_merge
from contract_rag.sync.models import (
    HUMAN_FIELDS,
    SYNCED_FIELDS,
    SYSTEM_FIELDS,
    FieldConflict,
    MergePlan,
    SyncState,
)


@dataclass(frozen=True)
class SyncResult:
    contract_id: str
    state: str
    pushed: dict = field(default_factory=dict)     # fields written system -> ledger
    absorbed: dict = field(default_factory=dict)   # fields absorbed ledger -> SQLite
    conflicts: list = field(default_factory=list)  # [{field, baseline, system, excel}]
    error: str | None = None


def _enabled() -> bool:
    """Excel sync on/off. A runtime settings override (set from the front end via
    PATCH /config) wins over the static ``config.yaml`` default when present."""
    prefs = settings.get_setting("config_prefs", {}) or {}
    if "excelEnabled" in prefs:
        return bool(prefs["excelEnabled"])
    return load_config().excel.enabled


def _adapter(db_path=None) -> ExcelAdapter:
    return ExcelAdapter(load_config().excel.path)


def _system_row(contract_id: str, db_path=None) -> dict | None:
    """Project the SQLite contract onto the synced-field subset.

    ``file_name`` has no SQLite column — it is derived here from file_no +
    contract_id + project_name so the ledger's File Name stays consistent.
    """
    contract = db.get_contract(contract_id, db_path)
    if contract is None:
        return None
    row = {f: contract.get(f) for f in SYNCED_FIELDS}
    row["contract_id"] = contract_id
    row["file_name"] = compose_file_name(
        contract.get("file_no"), contract_id, contract.get("project_name")
    )
    return row


def _conflict_dicts(conflicts: list[FieldConflict]) -> list[dict]:
    return [asdict(c) for c in conflicts]


# --------------------------------------------------------------------------- #
# write path (called after ingest, and by the future retry loop)
# --------------------------------------------------------------------------- #

def sync_contract(contract_id: str, *, db_path=None) -> SyncResult:
    """Sync one contract into the ledger. Idempotent; safe to call repeatedly."""
    if not _enabled():
        state.upsert(contract_id, state=SyncState.DISABLED, db_path=db_path)
        return SyncResult(contract_id, SyncState.DISABLED)

    system = _system_row(contract_id, db_path)
    if system is None:
        raise ValueError(f"unknown contract_id: {contract_id}")

    adapter = _adapter(db_path)
    try:
        excel_row = adapter.find_row(contract_id)
    except ExcelLocked as e:
        return _mark_pending(contract_id, str(e), db_path)

    if excel_row is None:
        return _append_new(contract_id, system, adapter, db_path)
    return _merge_existing(contract_id, system, excel_row, adapter, db_path)


def _append_new(contract_id, system, adapter, db_path) -> SyncResult:
    payload = {f: system.get(f) for f in (*SYSTEM_FIELDS, *HUMAN_FIELDS)}
    try:
        adapter.upsert_row(contract_id, payload)
    except ExcelLocked as e:
        return _mark_pending(contract_id, str(e), db_path)
    baseline = {f: system.get(f) for f in (*SYSTEM_FIELDS, *HUMAN_FIELDS)}
    state.upsert(contract_id, state=SyncState.SYNCED, baseline=baseline,
                 conflicts=[], attempts=0, db_path=db_path)
    return SyncResult(contract_id, SyncState.SYNCED, pushed=payload)


def _merge_existing(contract_id, system, excel_row, adapter, db_path) -> SyncResult:
    baseline = state.get_baseline(contract_id, db_path)
    plan = plan_merge(baseline, system, excel_row)

    # 1. absorb human edits into SQLite (system source of truth for those fields).
    for f, value in plan.absorbs_to_system.items():
        db.upsert_contract(contract_id, db_path=db_path, **{f: value})

    # 2. push system updates into the ledger (may be locked -> pending).
    if plan.pushes_to_excel:
        try:
            adapter.upsert_row(contract_id, plan.pushes_to_excel)
        except ExcelLocked as e:
            return _mark_pending(contract_id, str(e), db_path, absorbed=plan.absorbs_to_system)

    return _record_plan(contract_id, plan, db_path)


def _record_plan(contract_id, plan: MergePlan, db_path) -> SyncResult:
    conflicts = _conflict_dicts(plan.conflicts)
    state.upsert(
        contract_id,
        state=plan.state,
        baseline=plan.settled_baseline,
        conflicts=conflicts,
        attempts=0,
        db_path=db_path,
    )
    return SyncResult(
        contract_id, plan.state,
        pushed=plan.pushes_to_excel,
        absorbed=plan.absorbs_to_system,
        conflicts=conflicts,
    )


def _mark_pending(contract_id, error, db_path, absorbed=None) -> SyncResult:
    existing = state.get(contract_id, db_path)
    attempts = (existing["attempts"] if existing else 0) + 1
    new_state = SyncState.RETRYING if attempts > 1 else SyncState.PENDING
    state.upsert(contract_id, state=new_state, attempts=attempts,
                 last_error=error, db_path=db_path)
    return SyncResult(contract_id, new_state, absorbed=absorbed or {}, error=error)


# --------------------------------------------------------------------------- #
# read path (processing page + merge page)
# --------------------------------------------------------------------------- #

def get_status(contract_id: str, *, db_path=None) -> dict | None:
    """Per-contract sync status for the processing page (None if never synced)."""
    return state.get(contract_id, db_path)


def list_statuses(*, db_path=None) -> list[dict]:
    """All sync statuses for the processing page (newest first)."""
    return state.list_all(db_path)


def get_conflict(contract_id: str, *, db_path=None) -> list[dict]:
    """The unresolved field conflicts for the merge page (three-way view)."""
    row = state.get(contract_id, db_path)
    return row["conflicts"] if row else []


# --------------------------------------------------------------------------- #
# conflict resolution (merge page submits user choices here)
# --------------------------------------------------------------------------- #

def resolve_conflict(contract_id: str, resolutions: dict[str, object], *, db_path=None) -> SyncResult:
    """Apply the user's per-field merge choices and re-sync.

    ``resolutions`` maps field -> ``"system"`` | ``"excel"`` | an explicit value.
    The chosen value is written to BOTH SQLite and the ledger so they converge,
    and becomes the new baseline for that field.
    """
    system = _system_row(contract_id, db_path)
    if system is None:
        raise ValueError(f"unknown contract_id: {contract_id}")
    adapter = _adapter(db_path)
    try:
        excel_row = adapter.find_row(contract_id) or {}
    except ExcelLocked as e:
        return _mark_pending(contract_id, str(e), db_path)

    chosen = {f: _choose(choice, system.get(f), excel_row.get(f)) for f, choice in resolutions.items()}

    # write resolved values to SQLite (whitelisted contract columns only)
    for f, value in chosen.items():
        db.upsert_contract(contract_id, db_path=db_path, **{f: value})

    # write resolved values to the ledger
    try:
        if chosen:
            adapter.upsert_row(contract_id, chosen)
    except ExcelLocked as e:
        return _mark_pending(contract_id, str(e), db_path, absorbed=chosen)

    baseline = dict(state.get_baseline(contract_id, db_path) or {})
    baseline.update(chosen)
    state.upsert(contract_id, state=SyncState.SYNCED, baseline=baseline,
                 conflicts=[], attempts=0, db_path=db_path)
    return SyncResult(contract_id, SyncState.SYNCED, pushed=chosen, absorbed=chosen)


def _choose(choice: object, system_value: object, excel_value: object) -> object:
    if choice == "system":
        return system_value
    if choice == "excel":
        return excel_value
    return choice  # explicit user-entered value
