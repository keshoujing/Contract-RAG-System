"""Pure three-way merge + normalization for the Excel ledger sync (decision 15).

Covers the resolution table in ``merge.plan_merge`` and the formatting-vs-content
normalization that stops ``$39,041.60`` / ``39041.6`` and ``3/9/2026`` /
``2026-03-09`` from masquerading as conflicts.
"""
from __future__ import annotations

from contract_rag.sync.merge import plan_merge
from contract_rag.sync.normalize import equal, normalize_field


# --- normalization --------------------------------------------------------- #

def test_amount_format_differences_are_equal() -> None:
    assert equal("amount", "$39,041.60", 39041.6)
    assert normalize_field("amount", "$39,041.60") == 39041.6


def test_date_format_differences_are_equal() -> None:
    assert equal("petition_date", "3/9/2026", "2026-03-09")


def test_blank_and_null_are_equal() -> None:
    assert equal("counterparty", "", None)
    assert equal("counterparty", "  ", None)


# --- merge resolution table ------------------------------------------------ #

def _system(**kw):
    base = {"contract_id": "C1", "counterparty": "A", "amount": 100, "effective_date": None}
    return {**base, **kw}


def test_all_equal_no_actions() -> None:
    sysrow = _system()
    excel = _system()
    plan = plan_merge(baseline={"counterparty": "A", "amount": 100, "effective_date": None}, system=sysrow, excel=excel)
    assert not plan.has_conflict
    assert plan.pushes_to_excel == {}
    assert plan.absorbs_to_system == {}


def test_system_only_change_pushes_to_excel() -> None:
    baseline = {"counterparty": "A", "amount": 100}
    sysrow = _system(counterparty="A-new")
    excel = _system()  # ledger still at baseline
    plan = plan_merge(baseline, sysrow, excel)
    assert plan.pushes_to_excel == {"counterparty": "A-new"}
    assert not plan.has_conflict


def test_human_only_change_on_human_field_absorbs() -> None:
    baseline = {"effective_date": None}
    sysrow = _system()  # effective_date None
    excel = _system(effective_date="2026-03-15")
    plan = plan_merge(baseline, sysrow, excel)
    assert plan.absorbs_to_system == {"effective_date": "2026-03-15"}
    assert not plan.has_conflict


def test_human_edit_to_system_field_is_conflict() -> None:
    baseline = {"counterparty": "A"}
    sysrow = _system(counterparty="A")          # system unchanged
    excel = _system(counterparty="A-edited")     # human changed a SYSTEM field
    plan = plan_merge(baseline, sysrow, excel)
    assert plan.has_conflict
    assert plan.conflicts[0].field == "counterparty"
    assert plan.conflicts[0].system == "A"
    assert plan.conflicts[0].excel == "A-edited"


def test_both_sides_changed_is_conflict() -> None:
    baseline = {"counterparty": "A"}
    sysrow = _system(counterparty="A-sys")
    excel = _system(counterparty="A-xls")
    plan = plan_merge(baseline, sysrow, excel)
    assert plan.has_conflict


def test_no_baseline_system_field_diff_is_conflict() -> None:
    sysrow = _system(counterparty="A")
    excel = _system(counterparty="B")
    plan = plan_merge(baseline=None, system=sysrow, excel=excel)
    assert plan.has_conflict


def test_no_baseline_human_field_defers_to_ledger() -> None:
    sysrow = _system(effective_date=None)
    excel = _system(effective_date="2026-03-15")
    plan = plan_merge(baseline=None, system=sysrow, excel=excel)
    assert plan.absorbs_to_system == {"effective_date": "2026-03-15"}
    assert not plan.has_conflict
