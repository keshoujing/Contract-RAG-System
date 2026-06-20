"""Per-field value normalization for three-way comparison.

The point of this module is to stop *formatting* differences from masquerading
as *content* conflicts (decision 15): ``$39,041.60`` vs ``39041.6`` and
``3/9/2026`` vs ``2026-03-09`` must compare equal, and blank-vs-null must too.
All functions are pure and deterministic.
"""
from __future__ import annotations

import datetime as _dt

_AMOUNT_FIELDS = frozenset({"amount"})
_DATE_FIELDS = frozenset({"petition_date", "effective_date", "expiration_date"})


def _norm_amount(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = "".join(ch for ch in str(value) if ch.isdigit() or ch in ".-")
    if cleaned in ("", ".", "-"):
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _norm_date(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, (_dt.date, _dt.datetime)):
        return value.strftime("%Y-%m-%d")
    text = str(value).strip()
    if not text:
        return None
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%Y/%m/%d", "%d/%m/%Y", "%Y.%m.%d"):
        try:
            return _dt.datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text  # unparseable: compare the raw (stripped) string


def _norm_str(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None  # empty string treated as null so blank vs null never conflicts


def normalize_field(field: str, value: object) -> object:
    """Return a canonical, comparable form of ``value`` for the given field."""
    if field in _AMOUNT_FIELDS:
        return _norm_amount(value)
    if field in _DATE_FIELDS:
        return _norm_date(value)
    return _norm_str(value)


def equal(field: str, a: object, b: object) -> bool:
    """True if two raw values are equal after field-appropriate normalization."""
    return normalize_field(field, a) == normalize_field(field, b)
