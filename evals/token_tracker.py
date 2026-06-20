"""Per-query token accounting for the agent-vs-oneshot comparison.

The agent makes several LLM calls per user query (classify -> sufficiency ->
rewrite -> generate, the loop repeating). To compare true cost against one-shot
RAG we need the *real* token total per query, not the derived call-count proxy
(see docs/superpowers/specs/2026-06-15-agentic-rag-eval-design.md §2, which
deferred token-level accounting).

``track_query_usage(query_id)`` is a context manager that captures the
``usage_metadata`` of every chat-model call made inside the block — including
nested agent-node ``.invoke()`` calls that pass no ``config`` — and merges them
into one :class:`QueryUsage` keyed by the query id. Capture works via a
contextvar hook (the same mechanism langchain's ``get_usage_metadata_callback``
uses), so the agent graph needs no changes.

Unlike langchain's built-in handler this records *per call* (not per model) and
does not require ``response_metadata['model_name']`` to be present — the Vertex
stack does not always populate it, and dropping usage silently would understate
cost.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Generator, Optional, Sequence

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult
from langchain_core.tracers.context import register_configure_hook


@dataclass(frozen=True)
class CallUsage:
    """Token usage reported by one chat-model call."""

    input_tokens: int
    output_tokens: int
    total_tokens: int


@dataclass(frozen=True)
class QueryUsage:
    """Merged token usage of every LLM call made within one user query."""

    query_id: str
    input_tokens: int
    output_tokens: int
    total_tokens: int
    n_calls: int


def usage_from_response(response: LLMResult) -> Optional[CallUsage]:
    """Extract one call's usage from an ``LLMResult``; ``None`` if absent."""
    try:
        generation = response.generations[0][0]
    except IndexError:
        return None
    if not isinstance(generation, ChatGeneration):
        return None
    message = generation.message
    if not isinstance(message, AIMessage):
        return None
    usage = message.usage_metadata
    if not usage:
        return None
    return CallUsage(
        input_tokens=usage.get("input_tokens", 0),
        output_tokens=usage.get("output_tokens", 0),
        total_tokens=usage.get("total_tokens", 0),
    )


def merge_usage(query_id: str, calls: Sequence[CallUsage]) -> QueryUsage:
    """Merge per-call usages within one query into a single total."""
    return QueryUsage(
        query_id=query_id,
        input_tokens=sum(c.input_tokens for c in calls),
        output_tokens=sum(c.output_tokens for c in calls),
        total_tokens=sum(c.total_tokens for c in calls),
        n_calls=len(calls),
    )


class _QueryUsageCollector(BaseCallbackHandler):
    """Callback that records every chat-model call's usage for one query."""

    def __init__(self, query_id: str) -> None:
        super().__init__()
        self._query_id = query_id
        self._lock = threading.Lock()
        self.calls: list[CallUsage] = []

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        usage = usage_from_response(response)
        if usage is not None:
            with self._lock:
                self.calls.append(usage)

    def result(self) -> QueryUsage:
        with self._lock:
            return merge_usage(self._query_id, list(self.calls))


# One contextvar + hook registered once at import. The hook makes whatever
# handler the var holds inheritable into every runnable run's callbacks, so
# nested ``.invoke()`` calls are captured without threading ``config`` through
# the agent graph.
_collector_var: ContextVar[Optional[_QueryUsageCollector]] = ContextVar(
    "contract_rag_query_usage", default=None
)
register_configure_hook(_collector_var, inheritable=True)


@contextmanager
def track_query_usage(query_id: str) -> Generator[_QueryUsageCollector, None, None]:
    """Capture token usage of every LLM call made within the block.

    Yields the collector; call ``.result()`` for the merged :class:`QueryUsage`.
    Nesting is supported — the previous collector is restored on exit.
    """
    collector = _QueryUsageCollector(query_id)
    token = _collector_var.set(collector)
    try:
        yield collector
    finally:
        _collector_var.reset(token)
