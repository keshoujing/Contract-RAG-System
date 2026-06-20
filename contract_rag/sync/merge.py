"""Pure three-way merge for the Excel ledger sync (decision 15).

Given three snapshots of a contract row — ``baseline`` (what we last exported to
the ledger), ``system`` (current SQLite), ``excel`` (current ledger) — decide,
per field, what should happen. The baseline is what makes "who changed it"
answerable; without it you can only see *that* two sides differ, not *who* edited.

Resolution rules (per field, after normalization):
  - both sides equal                      -> in sync, nothing to do
  - only the system changed               -> push system -> ledger
  - only the ledger changed, HUMAN field  -> absorb ledger -> SQLite (human owns it)
  - only the ledger changed, SYSTEM field -> CONFLICT (human edited a system field)
  - both sides changed                    -> CONFLICT
  - no baseline yet + sides differ        -> HUMAN field absorbs ledger; SYSTEM field
                                             is a CONFLICT (never silently clobber)

This module performs NO I/O; it returns a :class:`MergePlan` the service applies.
"""
from __future__ import annotations

from contract_rag.sync.models import (
    HUMAN_FIELDS,
    KEY_FIELD,
    SYNCED_FIELDS,
    FieldConflict,
    MergePlan,
)
from contract_rag.sync.normalize import equal

_MERGE_FIELDS = tuple(f for f in SYNCED_FIELDS if f != KEY_FIELD)
_SENTINEL = object()  # stands in for a missing baseline (never equals any value)


def plan_merge(
    baseline: dict | None,
    system: dict,
    excel: dict,
) -> MergePlan:
    """Three-way merge one contract row. Inputs are read-only; a plan is returned."""
    base = baseline or {}
    have_baseline = baseline is not None

    pushes: dict[str, object] = {}
    absorbs: dict[str, object] = {}
    conflicts: list[FieldConflict] = []
    settled: dict[str, object] = {}

    for f in _MERGE_FIELDS:
        s_val = system.get(f)
        e_val = excel.get(f)
        b_val = base.get(f) if have_baseline else _SENTINEL

        if equal(f, s_val, e_val):
            settled[f] = s_val  # already agree; lock the baseline to it
            continue

        system_changed = (b_val is _SENTINEL) or not equal(f, s_val, b_val)
        excel_changed = (b_val is _SENTINEL) or not equal(f, e_val, b_val)

        if excel_changed and not system_changed:
            # only the ledger moved
            if f in HUMAN_FIELDS:
                absorbs[f] = e_val
                settled[f] = e_val
            else:
                conflicts.append(FieldConflict(f, base.get(f), s_val, e_val))
        elif system_changed and not excel_changed:
            # only the system moved -> propagate to the ledger
            pushes[f] = s_val
            settled[f] = s_val
        else:
            # both moved (or no baseline to tell them apart) -> let the user decide,
            # except a HUMAN field with no baseline defers to the ledger value.
            if not have_baseline and f in HUMAN_FIELDS:
                absorbs[f] = e_val
                settled[f] = e_val
            else:
                conflicts.append(FieldConflict(f, base.get(f), s_val, e_val))

    return MergePlan(
        pushes_to_excel=pushes,
        absorbs_to_system=absorbs,
        conflicts=conflicts,
        settled_baseline=settled,
    )
