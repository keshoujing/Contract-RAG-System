"""Unit tests for the Vertex Ranking API reranker (pure logic only).

The live ``_rank_via_api`` network call is exercised through integration, not
here — these tests stub it (monkeypatch) so the gate stays offline, matching the
project convention for live LLM/Vertex calls.
"""
from langchain_core.documents import Document

from contract_rag.config import load_config
from contract_rag.retrieval import reranker


def _doc(text: str, **meta) -> Document:
    return Document(page_content=text, metadata=meta)


# --------------------------------------------------------------------------- #
# _build_records
# --------------------------------------------------------------------------- #

def test_build_records_maps_list_index_to_id_and_content():
    records = reranker._build_records([_doc("alpha"), _doc("beta")])
    assert records == [
        {"id": "0", "content": "alpha"},
        {"id": "1", "content": "beta"},
    ]


# --------------------------------------------------------------------------- #
# _request_payload
# --------------------------------------------------------------------------- #

def test_request_payload_includes_model_query_records_and_topn():
    records = [{"id": "0", "content": "x"}]
    payload = reranker._request_payload("q", records, "semantic-ranker-default@latest", 5)
    assert payload["model"] == "semantic-ranker-default@latest"
    assert payload["query"] == "q"
    assert payload["records"] == records
    assert payload["topN"] == 5


def test_request_payload_omits_topn_when_none():
    assert "topN" not in reranker._request_payload("q", [], "m", None)


# --------------------------------------------------------------------------- #
# _reorder
# --------------------------------------------------------------------------- #

def test_reorder_sorts_by_score_desc_and_maps_back_to_docs():
    docs = [_doc("validity"), _doc("payment"), _doc("warranty")]
    ranked = [
        {"id": "0", "score": 0.07},
        {"id": "1", "score": 0.55},
        {"id": "2", "score": 0.03},
    ]
    out = reranker._reorder(docs, ranked, None)
    assert [d.page_content for d in out] == ["payment", "validity", "warranty"]


def test_reorder_truncates_to_top_n():
    docs = [_doc("a"), _doc("b"), _doc("c")]
    ranked = [{"id": "0", "score": 0.9}, {"id": "1", "score": 0.8}, {"id": "2", "score": 0.1}]
    out = reranker._reorder(docs, ranked, 2)
    assert [d.page_content for d in out] == ["a", "b"]


def test_reorder_drops_out_of_range_and_non_integer_ids():
    docs = [_doc("a"), _doc("b")]
    ranked = [
        {"id": "5", "score": 0.9},   # out of range -> dropped
        {"id": "x", "score": 0.8},   # non-integer -> dropped
        {"id": "1", "score": 0.7},   # valid
    ]
    out = reranker._reorder(docs, ranked, None)
    assert [d.page_content for d in out] == ["b"]


def test_reorder_empty_docs_returns_empty():
    assert reranker._reorder([], [], None) == []


# --------------------------------------------------------------------------- #
# rerank (composition; network stubbed)
# --------------------------------------------------------------------------- #

def test_rerank_empty_docs_skips_network(monkeypatch):
    def _boom(_payload):
        raise AssertionError("network must not be called for empty docs")

    monkeypatch.setattr(reranker, "_rank_via_api", _boom)
    assert reranker.rerank("q", []) == []


def test_rerank_reorders_using_api_scores(monkeypatch):
    docs = [_doc("validity"), _doc("payment"), _doc("warranty")]
    captured = {}

    def _fake_api(payload):
        captured["payload"] = payload
        return [
            {"id": "1", "score": 0.55},
            {"id": "0", "score": 0.07},
            {"id": "2", "score": 0.03},
        ]

    monkeypatch.setattr(reranker, "_rank_via_api", _fake_api)
    out = reranker.rerank("付款期限", docs, top_n=2, model="m")
    assert [d.page_content for d in out] == ["payment", "validity"]
    assert captured["payload"]["query"] == "付款期限"
    assert captured["payload"]["topN"] == 2


def test_rerank_defaults_model_from_config(monkeypatch):
    captured = {}

    def _fake_api(payload):
        captured.update(payload)
        return [{"id": "0", "score": 1.0}]

    monkeypatch.setattr(reranker, "_rank_via_api", _fake_api)
    reranker.rerank("q", [_doc("a")])
    assert captured["model"] == load_config().models.rerank
