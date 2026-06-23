"""Per-query observability metrics for the agent (STUB, TDD).

Pure helpers that summarize a finished query into the metadata we attach to the
LangSmith run in ``agent.answer_with_evidence`` (tool rounds, token cost,
grounding outcome). Kept pure/deterministic so they're unit-tested; the actual
trace attachment is the integration boundary.
"""
from __future__ import annotations

_TOKEN_KEYS = ("input_tokens", "output_tokens", "total_tokens")


def evidence_metrics(evidence: list[dict], tool_rounds: int) -> dict:
    """Summarize a finished answer's evidence into filterable run metadata."""
    return {
        "n_clause": sum(1 for e in evidence if e.get("kind") == "clause"),
        "n_record": sum(1 for e in evidence if e.get("kind") == "record"),
        "abstained": not evidence,
        "tool_rounds": tool_rounds,
    }


def add_usage(acc: dict, usage: dict | None) -> dict:
    """Accumulate an LLM call's ``usage_metadata`` into a running token total
    (immutably — returns a new dict, never mutates ``acc``)."""
    if not usage:
        return dict(acc)
    return {k: int(acc.get(k, 0)) + int(usage.get(k, 0) or 0) for k in _TOKEN_KEYS}
