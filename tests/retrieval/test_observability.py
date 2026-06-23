"""Per-query observability metrics — kind counts / abstention + token accrual."""
from contract_rag.retrieval import observability as obs


def test_evidence_metrics_counts_kinds():
    evidence = [
        {"kind": "clause", "contract_id": "c1"},
        {"kind": "clause", "contract_id": "c1"},
        {"kind": "record", "contract_id": "c2"},
    ]
    assert obs.evidence_metrics(evidence, tool_rounds=3) == {
        "n_clause": 2, "n_record": 1, "abstained": False, "tool_rounds": 3}


def test_evidence_metrics_empty_is_abstained():
    m = obs.evidence_metrics([], tool_rounds=1)
    assert m["n_clause"] == 0
    assert m["n_record"] == 0
    assert m["abstained"] is True


def test_add_usage_from_empty():
    assert obs.add_usage({}, {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}) == {
        "input_tokens": 3, "output_tokens": 2, "total_tokens": 5}


def test_add_usage_accumulates():
    acc = obs.add_usage({}, {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5})
    acc = obs.add_usage(acc, {"input_tokens": 1, "output_tokens": 4, "total_tokens": 5})
    assert acc == {"input_tokens": 4, "output_tokens": 6, "total_tokens": 10}


def test_add_usage_none_returns_unchanged_copy():
    acc = {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
    out = obs.add_usage(acc, None)
    assert out == acc
    assert out is not acc  # immutable: a new object, original untouched
