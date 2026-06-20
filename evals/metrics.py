"""Synchronous embedding metrics for agent-vs-oneshot comparison.

Deliberately does NOT use ragas ``evaluate()``: on this Vertex async stack it
intermittently hangs for hundreds of seconds even on embedding-only metrics
(see memory/retrieval_eval.md). Direct ``embed_query`` calls run in ~1-2s and
never hang. ``embed`` is injected (``LLM().get_embedding_object().embed_query``
in production, a fake in tests) so these stay pure and offline-testable.
"""
from __future__ import annotations

from typing import Callable, Sequence

Embed = Callable[[str], Sequence[float]]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        raise ValueError(f"vector dim mismatch: {len(a)} vs {len(b)}")
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def answer_similarity(answer: str, gold: str, embed: Embed) -> float:
    """Cosine(embed(answer), embed(gold)) — answer-quality proxy vs reference."""
    return _cosine(embed(answer), embed(gold))


def retrieval_coverage(gold: str, contexts: Sequence[str], embed: Embed) -> float:
    """Max cosine(embed(gold), embed(ctx)) over retrieved contexts.

    Proxies 'did retrieval surface content that supports the reference answer'.
    Returns 0.0 when nothing was retrieved (entity path / empty result).
    """
    if not contexts:
        return 0.0
    g = embed(gold)
    return max(_cosine(g, embed(c)) for c in contexts)
