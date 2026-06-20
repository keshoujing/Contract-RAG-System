"""Runtime config for the settings page: read + toggle persistence + file-no rules."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from contract_rag.api import projections
from contract_rag.api.schemas import ConfigPatchRequest
from contract_rag.config import load_config
from contract_rag.sync import (
    get_contract_versions,
    get_file_no_rules,
    set_contract_versions,
    set_file_no_rules,
    settings,
)

router = APIRouter()

_PREFS_KEY = "config_prefs"


def _current_config() -> dict:
    prefs = settings.get_setting(_PREFS_KEY, {}) or {}
    cfg = load_config()
    return projections.to_config_state(
        excel_enabled=prefs.get("excelEnabled", cfg.excel.enabled),
        rag_enabled=prefs.get("ragEnabled", False),
        backup_enabled=prefs.get("backupEnabled", True),
        lock_check_enabled=prefs.get("lockCheckEnabled", True),
        file_no_rules=get_file_no_rules(),
        contract_versions=get_contract_versions(),
        year=date.today().year,
    )


@router.get("/config")
def get_config() -> dict:
    return _current_config()


@router.patch("/config")
def patch_config(body: ConfigPatchRequest) -> dict:
    changes = body.model_dump(exclude_unset=True)
    prefs = {**(settings.get_setting(_PREFS_KEY, {}) or {}), **changes}
    settings.set_setting(_PREFS_KEY, prefs)
    return _current_config()


@router.patch("/config/file-no-rules")
def patch_file_no_rules(body: dict) -> dict:
    """Persist the File No. rule set ``{category: {prefix}}`` (front-end setter)."""
    set_file_no_rules(body)
    return get_file_no_rules()


@router.patch("/config/contract-versions")
def patch_contract_versions(body: dict) -> list[str]:
    """Persist the managed contract-version list (front-end setter)."""
    set_contract_versions(body.get("versions", []))
    return get_contract_versions()
