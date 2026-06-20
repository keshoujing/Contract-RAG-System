"""Tools the Q&A agent calls — it owns the SQL-vs-Weaviate choice (§5).

- ``query_ledger(filters)``  — structured lookup over the SQLite ``contracts``
  ledger. ``filters`` come from the LLM (not regex-guessed); reuses the proven
  ``_row_matches_filters`` matcher.
- ``search_clauses(query, contract_id)`` — hybrid chunk search over Weaviate,
  projected to the clause shape (contract_id/page/section/snippet/bbox).
- ``attach_clause_provenance(items, chunks)`` — back-fill ``page``/``bbox`` on
  LLM-authored clause evidence by matching its snippet to the real retrieved
  chunk (the LLM can't author a reliable float bbox).

Filter keys understood by ``query_ledger`` (all optional; describe these to the
LLM in the tool schema): ``identifier`` (contract/file/number, exact for digits),
``name`` (counterparty substring), ``department`` (exact), ``contract_type``
(substring), ``amount_min`` (number), ``year`` (appears in any date).
"""
from __future__ import annotations

import difflib

from langchain_core.documents import Document

from contract_rag.retrieval.graph import (
    _ENTITY_FIELDS,
    _doc_to_source,
    _row_matches_filters,
    retrieve,
)
from contract_rag.storage import db


def query_ledger(filters: dict | None = None) -> list[dict]:
    """Return ledger rows matching ``filters`` (empty/None -> all), projected to
    the entity fields the LLM should reason over."""
    rows = db.list_contracts()
    matched = [r for r in rows if _row_matches_filters(r, filters or {})]
    return [{k: r.get(k) for k in _ENTITY_FIELDS} for r in matched]


def _clause_view(source: dict) -> dict:
    return {
        "contract_id": source.get("contract_id", ""),
        "page": source.get("page"),
        "section": source.get("section_path", ""),
        "snippet": source.get("content", ""),
        "bbox": source.get("bbox"),
    }


def search_clauses(
    query: str,
    contract_id: str | None = None,
    *,
    contract_ids: list[str] | None = None,
    top_n: int | None = None,
) -> list[dict]:
    """Hybrid search over clause/table chunks, projected to the clause shape."""
    docs: list[Document] = retrieve(query, contract_id=contract_id, contract_ids=contract_ids, top_n=top_n)
    return [_clause_view(_doc_to_source(d)) for d in docs]


def _norm(s) -> str:
    """Drop all whitespace so matching survives the LLM re-spacing the snippet."""
    return "".join(str(s or "").split())


def _find_source_chunk(item: dict, chunks: list[dict], *, min_coverage: float = 0.6) -> dict | None:
    """Match an LLM clause item to the chunk it came from.

    The LLM rarely reproduces a snippet byte-for-byte (it re-spaces / lightly
    trims), so after an exact (whitespace-normalized) substring check we fall
    back to the same-contract chunk that covers the most of the snippet.
    """
    snip = _norm(item.get("snippet"))
    cid = str(item.get("contract_id") or "").strip()
    if not snip:
        return None
    same = [c for c in chunks if not cid or str(c.get("contract_id") or "").strip() == cid]

    for c in same:
        t = _norm(c.get("snippet"))
        if t and (snip in t or t in snip):
            return c

    best, best_cov = None, 0.0
    for c in same:
        t = _norm(c.get("snippet"))
        if not t:
            continue
        matched = sum(b.size for b in difflib.SequenceMatcher(None, snip, t).get_matching_blocks())
        cov = matched / len(snip)
        if cov > best_cov:
            best, best_cov = c, cov
    return best if best_cov >= min_coverage else None


def attach_clause_provenance(items: list[dict], chunks: list[dict]) -> list[dict]:
    """Copy ``page``/``bbox`` onto clause items from the matching retrieved chunk.

    Record items pass through untouched; clause items with no matching chunk keep
    whatever (possibly None) page/bbox they already had.
    """
    out = []
    for item in items:
        if item.get("kind") != "clause":
            out.append(item)
            continue
        match = _find_source_chunk(item, chunks)
        if match is not None:
            item = {**item, "page": match.get("page"), "bbox": match.get("bbox")}
        out.append(item)
    return out
