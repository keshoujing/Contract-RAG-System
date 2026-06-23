"""Grounding guard for agent-authored evidence (see ``docs/INTERFACE.md`` §5).

The tool-calling agent authors its own ``evidence`` list, so before we trust it
we verify each item against the *real* retrieved data — not the model's say-so:

- **clause (A)** — the ``snippet`` must be a verbatim (whitespace-normalized)
  substring of a retrieved chunk *of the same contract*. This is deliberately
  stricter than provenance back-fill (``attach_clause_provenance``, which
  tolerates a fuzzy match just to recover a page): a paraphrase or a swapped
  figure is rejected here, because a citation must be a real copy.
- **record (D)** — the field *values* are discarded and re-projected from the
  real ledger row (looked up by ``contract_id``), so a mis-transcribed amount
  can't survive; a record naming a contract the agent never retrieved is dropped
  as fabricated. Duplicate rows for one contract collapse to one.
- **abstention (F)** — if nothing survives verification, the answer is replaced
  with a fixed "insufficient evidence" message rather than letting an
  unsupported answer stand.

All pure/deterministic and unit-tested; the live agent wires them in
``agent._assemble``.
"""
from __future__ import annotations

from contract_rag.retrieval.evidence import CLAUSE, RECORD, record_item
from contract_rag.retrieval.tools import _norm

ABSTAIN_ANSWER = "未找到足以支撑回答的合同依据。"

# Ledger columns surfaced as record evidence, in display order, with stable
# labels. Values always come from the real row (never the LLM), so a swapped
# value cannot survive. Restricted to fields ``query_ledger`` returns.
_RECORD_FIELDS: tuple[tuple[str, str], ...] = (
    ("counterparty", "对方公司"),
    ("amount", "金额"),
    ("currency", "币种"),
    ("department", "部门"),
    ("effective_date", "生效日期"),
    ("expiration_date", "到期日期"),
)


def _snippet_grounded(item: dict, chunks: list[dict]) -> bool:
    """True iff the clause snippet is a verbatim substring of a same-contract
    chunk (whitespace-normalized so the LLM re-spacing a copy still matches)."""
    snip = _norm(item.get("snippet"))
    if not snip:
        return False
    cid = str(item.get("contract_id") or "").strip()
    for c in chunks:
        if cid and str(c.get("contract_id") or "").strip() != cid:
            continue
        if snip in _norm(c.get("snippet")):
            return True
    return False


def verify_clause_grounding(items: list[dict], chunks: list[dict]) -> list[dict]:
    """Drop clause items whose snippet is not a real excerpt of a retrieved
    chunk. Non-clause items pass through untouched."""
    return [
        item for item in items
        if item.get("kind") != CLAUSE or _snippet_grounded(item, chunks)
    ]


def _row_for(contract_id, rows: list[dict]) -> dict | None:
    cid = str(contract_id or "").strip()
    if not cid:
        return None
    for r in rows:
        if str(r.get("contract_id") or "").strip() == cid:
            return r
    return None


def _project_record(row: dict) -> dict:
    fields = {
        label: row[col]
        for col, label in _RECORD_FIELDS
        if row.get(col) not in (None, "")
    }
    title = row.get("counterparty") or row.get("project_name") or None
    return record_item(str(row["contract_id"]), fields=fields, title=title)


def verify_record_grounding(items: list[dict], rows: list[dict]) -> list[dict]:
    """Re-project each record item's fields from the real ledger row. Records
    naming a contract the agent never retrieved are dropped; duplicates for one
    contract collapse to one. Non-record items pass through untouched."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in items:
        if item.get("kind") != RECORD:
            out.append(item)
            continue
        row = _row_for(item.get("contract_id"), rows)
        if row is None:
            continue
        cid = str(row["contract_id"]).strip()
        if cid in seen:
            continue
        seen.add(cid)
        out.append(_project_record(row))
    return out


def apply_abstention(answer: str, items: list[dict]) -> tuple[str, list[dict]]:
    """Replace the answer with a fixed message when no evidence survived."""
    if not items:
        return ABSTAIN_ANSWER, []
    return answer, items
