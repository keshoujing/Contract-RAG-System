"""Per-query observability for the agent.

Pure helpers that summarize a finished query into the metadata attached to the
LangSmith run in ``agent.answer_with_evidence`` (tool rounds, token cost,
grounding outcome) — kept deterministic so they're unit-tested — plus
``record_user_feedback``, the (integration) forwarding of a user 👍/👎 to the
run's LangSmith feedback.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

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


def feedback_score_value(score: str) -> float:
    """Map a 👍/👎 to the LangSmith numeric score (1.0 = up, 0.0 = down)."""
    return 1.0 if score == "up" else 0.0


def record_user_feedback(run_id: str | None, score: str, comment: str | None = None) -> None:
    """Forward a user 👍/👎 to LangSmith as feedback on the query's run.

    Best-effort: no-op when there's no run_id or tracing is disabled, and any
    LangSmith error is swallowed (the user's vote is already persisted in our DB,
    which is the source of truth for the gold flywheel)."""
    import os

    if not run_id or os.getenv("LANGSMITH_TRACING", "").lower() != "true":
        return
    try:
        from langsmith import Client

        Client().create_feedback(
            run_id, key="user_score",
            score=feedback_score_value(score), comment=comment or None,
        )
    except Exception as e:  # noqa: BLE001 — telemetry must never break the request
        logger.warning("LangSmith feedback failed for run %s: %r", run_id, e)
