"""Per-query token accounting — offline (fake chat model, no network).

Verifies that every LLM call made within one user query is captured and merged
into a single total, keyed by a query id. The capture path uses contextvar
propagation, so nested agent-node ``.invoke()`` calls are caught without passing
``config`` — proven here with ``GenericFakeChatModel`` (no Gemini, no Weaviate).
"""
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, LLMResult

from evals.token_tracker import (
    CallUsage,
    QueryUsage,
    merge_usage,
    track_query_usage,
    usage_from_response,
)


def _llm_result(usage):
    msg = AIMessage(content="x", usage_metadata=usage) if usage else AIMessage(content="x")
    return LLMResult(generations=[[ChatGeneration(message=msg)]])


def _fake_model(*usages):
    return GenericFakeChatModel(
        messages=iter(
            AIMessage(content="x", usage_metadata=u) for u in usages
        )
    )


# --- usage_from_response (pure extraction) --------------------------------- #

def test_usage_from_response_extracts_tokens():
    r = _llm_result({"input_tokens": 10, "output_tokens": 3, "total_tokens": 13})
    assert usage_from_response(r) == CallUsage(input_tokens=10, output_tokens=3, total_tokens=13)


def test_usage_from_response_none_when_no_usage_metadata():
    assert usage_from_response(_llm_result(None)) is None


def test_usage_from_response_none_on_empty_generations():
    assert usage_from_response(LLMResult(generations=[])) is None


# --- merge_usage (pure aggregation) ---------------------------------------- #

def test_merge_usage_sums_calls_and_counts():
    calls = [
        CallUsage(input_tokens=10, output_tokens=3, total_tokens=13),
        CallUsage(input_tokens=5, output_tokens=2, total_tokens=7),
    ]
    assert merge_usage("q1", calls) == QueryUsage(
        query_id="q1", input_tokens=15, output_tokens=5, total_tokens=20, n_calls=2
    )


def test_merge_usage_empty_is_zero():
    assert merge_usage("q1", []) == QueryUsage(
        query_id="q1", input_tokens=0, output_tokens=0, total_tokens=0, n_calls=0
    )


# --- track_query_usage (contextvar propagation, the key behavior) ---------- #

def test_track_query_usage_merges_nested_calls_without_config():
    model = _fake_model(
        {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13},
        {"input_tokens": 5, "output_tokens": 2, "total_tokens": 7},
    )
    with track_query_usage("case-3") as usage:
        model.invoke("first")   # no config passed — must be caught via contextvar
        model.invoke("second")
    assert usage.result() == QueryUsage(
        query_id="case-3", input_tokens=15, output_tokens=5, total_tokens=20, n_calls=2
    )


def test_track_query_usage_does_not_capture_after_exit():
    model = _fake_model(
        {"input_tokens": 10, "output_tokens": 3, "total_tokens": 13},
        {"input_tokens": 99, "output_tokens": 99, "total_tokens": 198},
    )
    with track_query_usage("case-a") as usage:
        model.invoke("inside")
    model.invoke("outside")  # after exit — must NOT be counted
    assert usage.result().total_tokens == 13
    assert usage.result().n_calls == 1
