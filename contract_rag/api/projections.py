"""Pure mappers from SQLite rows to the frontend's types.ts shapes.

No I/O. Every function takes plain dicts and returns plain dicts/lists so it is
trivially unit-tested. See frontend/src/api/types.ts for the target shapes.
"""
from __future__ import annotations

from datetime import date, datetime

from contract_rag.sync import compose_file_name
from contract_rag.sync.file_no import format_file_no
from contract_rag.sync.models import HUMAN_FIELDS, SYSTEM_FIELDS

# Fields copied straight from the contracts row onto ContractRow.
_DIRECT = (
    "contract_id", "counterparty", "amount", "currency", "project_name",
    "contract_type", "petitioner", "petition_date", "file_no",
    "effective_date", "expiration_date", "department", "brief_description",
    "term_months",
)


def derive_yearly_amount(amount, term_months) -> float | None:
    """Annualized contract value, or None when it does not apply.

    term_months: None=unspecified, 0=one-time (no time dimension), N=N months.
    Only N>0 yields a yearly figure: amount / (N / 12).
    """
    if not term_months or term_months <= 0 or not amount:
        return None
    try:
        return round(float(amount) / (float(term_months) / 12), 2)
    except (TypeError, ValueError, ZeroDivisionError):
        return None


def derive_status(effective_date, expiration_date, today: date) -> str:
    """active / expired / pending (see design spec status rule)."""
    if not effective_date or not expiration_date:
        return "pending"
    try:
        exp = date.fromisoformat(str(expiration_date)[:10])
    except ValueError:
        return "active"
    return "expired" if exp < today else "active"


def format_size(num_bytes) -> str:
    if not num_bytes:
        return "—"
    return f"{num_bytes / 1024 / 1024:.1f} MB"


def format_ts(iso) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso)).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(iso)


def to_contract_row(contract: dict, *, signed_pdf_size, today: date) -> dict:
    row = {k: contract.get(k) for k in _DIRECT}
    row["amount"] = contract.get("amount") or 0
    row["currency"] = contract.get("currency") or ""
    row["file_name"] = compose_file_name(
        contract.get("file_no"), contract.get("contract_id"), contract.get("project_name")
    ) or ""
    row["pages"] = contract.get("page_count") or 0
    row["size"] = format_size(signed_pdf_size)
    row["archived_at"] = format_ts(contract.get("created_at"))
    row["status"] = derive_status(
        contract.get("effective_date"), contract.get("expiration_date"), today
    )
    row["term_months"] = contract.get("term_months")
    row["yearly_amount"] = derive_yearly_amount(row["amount"], contract.get("term_months"))
    # Frontend expects strings for these; coalesce null-ish to "".
    for k in ("counterparty", "project_name", "contract_type", "petitioner",
              "petition_date", "file_no", "department", "brief_description"):
        row[k] = row.get(k) or ""
    return row


def to_conflict_fields(conflicts: list[dict]) -> list[dict]:
    out = []
    for c in conflicts:
        owner = "human" if c["field"] in HUMAN_FIELDS else "system"
        # suggest the side that diverged from baseline; default to system.
        suggested = "system"
        if owner == "human" and c.get("excel") != c.get("baseline"):
            suggested = "excel"
        out.append({**c, "owner": owner, "suggested": suggested})
    return out


def to_config_state(
    *,
    excel_enabled: bool,
    file_no_rules: dict,
    year: int,
    contract_versions: list[str] | None = None,
    rag_enabled: bool = False,
    backup_enabled: bool = True,
    lock_check_enabled: bool = True,
) -> dict:
    rules = [
        {
            "category": category,
            "prefix": (rule or {}).get("prefix", ""),
            "example": format_file_no(year, 1, category, file_no_rules),
        }
        for category, rule in file_no_rules.items()
    ]
    return {
        "ragEnabled": bool(rag_enabled),
        "excelEnabled": bool(excel_enabled),
        "backupEnabled": bool(backup_enabled),
        "lockCheckEnabled": bool(lock_check_enabled),
        "fileNoRules": rules,
        "contractVersions": contract_versions or [],
    }


def to_processing_row(*, contract: dict, task: dict | None, sync_status: dict | None) -> dict:
    ingest = {
        "stage": (task or {}).get("stage", "done"),
        "status": (task or {}).get("status", "done"),
    }
    if (task or {}).get("error_message"):
        ingest["last_error"] = task["error_message"]
    sync = {
        "state": (sync_status or {}).get("state", "disabled"),
        "attempts": (sync_status or {}).get("attempts", 0),
        "updated_at": format_ts((sync_status or {}).get("updated_at")),
    }
    for k in ("last_error", "last_attempt_at"):
        if (sync_status or {}).get(k):
            sync[k] = sync_status[k]
    return {
        "contract_id": contract["contract_id"],
        "counterparty": contract.get("counterparty") or "",
        "ingest": ingest,
        "sync": sync,
        "updated_at": format_ts((sync_status or {}).get("updated_at") or contract.get("updated_at")),
    }


def apply_contract_query(rows, *, q, department, status, year, sort, today: date) -> list:
    """Mirror frontend applyContractQuery (filter by q/dept/status/year, sort)."""
    result = list(rows)
    if q:
        term = q.strip().lower()
        result = [
            r for r in result
            if any(term in str(r.get(k, "")).lower()
                   for k in ("contract_id", "counterparty", "project_name"))
        ]
    if department and department != "all":
        result = [r for r in result if r.get("department") == department]
    if status and status != "all":
        result = [
            r for r in result
            if derive_status(r.get("effective_date"), r.get("expiration_date"), today) == status
        ]
    if year and year != "all":
        result = [r for r in result if str(r.get("petition_date", "")).startswith(year)]
    if sort == "amount_desc":
        result.sort(key=lambda r: r.get("amount") or 0, reverse=True)
    elif sort == "amount_asc":
        result.sort(key=lambda r: r.get("amount") or 0)
    elif sort == "date_desc":
        result.sort(key=lambda r: str(r.get("petition_date", "")), reverse=True)
    return result
