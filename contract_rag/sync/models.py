"""Domain model for the Excel ledger sync (decision 15).

Defines the sync state machine, the column-ownership split (the thing that keeps
the user's "confirm every conflict" load sane), the field<->Excel-header mapping,
and the immutable result types produced by the pure merge.

Column ownership (decision 10 + 13):
  - SYSTEM fields  : the system extracts/maintains them; only the system writes.
  - HUMAN fields   : the human curates them in the ledger; the human is
                     authoritative and the system absorbs their edits.
A single-side change on a field its owner made is NOT a conflict. Only a human
edit to a SYSTEM field, or both sides changing the same field, is a conflict.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final

# The immutable join key — never a conflict, never overwritten.
KEY_FIELD: Final = "contract_id"

# Owner partitions (KEY excluded; it is structural).
SYSTEM_FIELDS: Final[tuple[str, ...]] = (
    "counterparty",      # 供应商
    "amount",            # 合同金额
    "currency",          # 币种
    "project_name",      # 合同内容 (Request Description)
    "contract_type",     # 合同版本 (Contract Type / Version)
    "petitioner",        # 经办人&制单人 (Buyer)
    "petition_date",     # 登记日期 (Registered Date)
    "file_no",           # 存档编号 (File No.) — rule-assigned, see file_no.py
    "file_name",         # File Name — derived: {file_no}-{contract_id}-{project_name}
)
HUMAN_FIELDS: Final[tuple[str, ...]] = (
    "effective_date",    # Contract Start Date
    "expiration_date",   # 合同到期日 (Contract Exp. Date)
)
# Every field that participates in the ledger row, in column order.
SYNCED_FIELDS: Final[tuple[str, ...]] = (KEY_FIELD, *SYSTEM_FIELDS, *HUMAN_FIELDS)

# Contract fields kept in SQLite but NOT synced to the ledger (no column for them):
#   department (审批表有, 台账无), brief_description (合同内容列用的是 project_name)
# Ledger columns the system never writes (human-only; left blank, never compared):
#   合同审批日期, Agreement number, Yearly Contract Amount, + all unused columns.
# Open: 合同版本 (Contract Type) is a used column but not extracted yet (see memory 决策15).


class SyncState:
    """States surfaced to the "处理中" page (decision 15, frontend reads these)."""

    SYNCED = "synced"        # ledger matches the agreed baseline
    PENDING = "pending"      # changes computed, not yet written (e.g. file locked)
    RETRYING = "retrying"    # write failed; a retry is scheduled
    CONFLICT = "conflict"    # divergence needs user confirmation (merge page)
    DISABLED = "disabled"    # Excel sync turned off in settings


# Field -> a DISTINCTIVE substring of the real ledger column header (the adapter
# matches whitespace-insensitively and by substring). Chinese tokens are used
# where unique; English tokens disambiguate the two "存档编号" columns (File No.
# vs File Name) and the English-only "Contract Start Date".
DEFAULT_EXCEL_COLUMNS: Final[dict[str, str]] = {
    "contract_id": "合同编号",        # Contract No.
    "counterparty": "供应商",         # Supplier
    "amount": "合同金额",             # Contract Amount
    "currency": "币种",               # Currency
    "project_name": "合同内容",       # Request Description
    "contract_type": "合同版本",      # Contract Type / Version
    "petitioner": "经办人",           # Buyer (经办人&制单人)
    "petition_date": "登记日期",      # Registered Date
    "effective_date": "Contract Start Date",
    "expiration_date": "合同到期日",  # Contract Exp. Date
    "file_no": "File No.",            # 存档编号 (English token avoids the File Name clash)
    "file_name": "File Name",
}


@dataclass(frozen=True)
class FieldConflict:
    """One field the user must adjudicate on the merge page (three-way view)."""

    field: str
    baseline: object  # last-exported value (the "who changed it" reference)
    system: object    # current SQLite value
    excel: object     # current ledger value


@dataclass(frozen=True)
class MergePlan:
    """Pure result of a three-way merge — what to do, no I/O performed yet."""

    pushes_to_excel: dict[str, object] = field(default_factory=dict)   # system -> ledger
    absorbs_to_system: dict[str, object] = field(default_factory=dict)  # ledger -> SQLite
    conflicts: list[FieldConflict] = field(default_factory=list)
    settled_baseline: dict[str, object] = field(default_factory=dict)   # new baseline (no conflicts)

    @property
    def has_conflict(self) -> bool:
        return bool(self.conflicts)

    @property
    def state(self) -> str:
        return SyncState.CONFLICT if self.has_conflict else SyncState.SYNCED
