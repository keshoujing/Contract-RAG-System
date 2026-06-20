"""Synchronous embedding metrics — no network (fake embed fn)."""
import math

import pytest

from evals.metrics import answer_similarity, retrieval_coverage


def _fake_embed(vectors):
    """Return an embed(text)->vector fn backed by a dict; unknown text -> zeros."""
    dim = len(next(iter(vectors.values())))
    return lambda text: vectors.get(text, [0.0] * dim)


def test_answer_similarity_identical_is_one():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [1.0, 0.0]})
    assert answer_similarity("a", "b", embed) == 1.0


def test_answer_similarity_orthogonal_is_zero():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [0.0, 1.0]})
    assert answer_similarity("a", "b", embed) == 0.0


def test_answer_similarity_opposite_is_negative_one():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [-1.0, 0.0]})
    assert answer_similarity("a", "b", embed) == -1.0


def test_retrieval_coverage_takes_max_over_contexts():
    embed = _fake_embed({
        "gold": [1.0, 0.0],
        "c1": [0.0, 1.0],   # cos 0.0
        "c2": [1.0, 1.0],   # cos ~0.707
    })
    cov = retrieval_coverage("gold", ["c1", "c2"], embed)
    assert math.isclose(cov, 1 / math.sqrt(2), rel_tol=1e-9)


def test_retrieval_coverage_empty_contexts_is_zero():
    embed = _fake_embed({"gold": [1.0, 0.0]})
    assert retrieval_coverage("gold", [], embed) == 0.0


def test_answer_similarity_zero_vector_is_zero():
    embed = _fake_embed({"a": [0.0, 0.0], "b": [1.0, 0.0]})
    assert answer_similarity("a", "b", embed) == 0.0


def test_answer_similarity_dim_mismatch_raises():
    embed = _fake_embed({"a": [1.0, 0.0, 0.0], "b": [1.0, 0.0]})
    with pytest.raises(ValueError):
        answer_similarity("a", "b", embed)
