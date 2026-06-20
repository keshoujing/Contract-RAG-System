"""Evidence contract for agentic Q&A (see ``docs/INTERFACE.md`` §5).

The tool-calling agent answers with ``{answer, evidence[]}``. Each evidence item
is self-describing via ``kind``:

- ``record`` — structured ledger fields (from the ``query_ledger`` tool / SQLite).
- ``clause`` — a verbatim chunk with provenance (from ``search_clauses`` / Weaviate);
  carries ``page`` and an optional ``bbox`` so the front-end verify popup can jump
  to the page and highlight the cited region.

``normalize_evidence`` cleans the LLM-authored raw list into this stable shape —
malformed items are dropped, never trusted. ``clause`` bbox/page back-fill from
the real chunk happens elsewhere (it must match the retrieved chunk, not the LLM).
"""
from __future__ import annotations

from typing import Any

CLAUSE = "clause"
RECORD = "record"


def clause_item(
    contract_id: str,
    *,
    page: int | None = None,
    section: str = "",
    snippet: str = "",
    bbox: list[float] | None = None,
) -> dict:
    return {
        "kind": CLAUSE,
        "contract_id": contract_id,
        "page": page,
        "section": section,
        "snippet": snippet,
        "bbox": bbox,
    }


def record_item(
    contract_id: str,
    *,
    fields: dict | None = None,
    title: str | None = None,
) -> dict:
    return {
        "kind": RECORD,
        "contract_id": contract_id,
        "title": title,
        "fields": fields or {},
    }


def normalize_evidence(raw: Any) -> list[dict]:
    """Validate/clean an LLM-authored evidence list into the stable shape.

    Drops anything that is not a dict, lacks a known ``kind``, or lacks a
    non-empty ``contract_id``.
    """
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        contract_id = str(item.get("contract_id") or "").strip()
        if not contract_id:
            continue
        if kind == CLAUSE:
            bbox = item.get("bbox")
            out.append(clause_item(
                contract_id,
                page=item.get("page"),
                section=str(item.get("section") or ""),
                snippet=str(item.get("snippet") or ""),
                bbox=list(bbox) if isinstance(bbox, list) and bbox else None,
            ))
        elif kind == RECORD:
            fields = item.get("fields")
            out.append(record_item(
                contract_id,
                fields=fields if isinstance(fields, dict) else {},
                title=item.get("title"),
            ))
    return out
