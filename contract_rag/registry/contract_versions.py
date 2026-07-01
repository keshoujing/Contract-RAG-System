"""User-managed list of contract versions for registry forms."""
from __future__ import annotations

from contract_rag.registry import settings

_KEY = "contract_versions"
_SEED = ["Supply Agreement", "Service Agreement", "Framework", "Supplement"]


def get_contract_versions(db_path=None) -> list[str]:
    stored = settings.get_setting(_KEY, None, db_path=db_path)
    if not stored:
        return list(_SEED)
    return [v for v in stored if isinstance(v, str) and v.strip()]


def set_contract_versions(versions: list[str], db_path=None) -> None:
    seen: list[str] = []
    for v in versions:
        if isinstance(v, str) and v.strip() and v.strip() not in seen:
            seen.append(v.strip())
    settings.set_setting(_KEY, seen, db_path=db_path)
