from contract_rag.retrieval import graph
from contract_rag.config import load_config


class _RecordingRetriever:
    """Stands in for WeaviateHybridRetriever; records construction kwargs."""
    last_kwargs = None

    def __init__(self, **kwargs):
        _RecordingRetriever.last_kwargs = kwargs

    def invoke(self, _query):
        return []


def test_retrieve_uses_config_defaults(monkeypatch):
    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _RecordingRetriever)
    graph.retrieve("q")
    cfg = load_config().retrieval
    assert _RecordingRetriever.last_kwargs["k"] == cfg.k
    assert _RecordingRetriever.last_kwargs["alpha"] == cfg.alpha


def test_retrieve_default_chunk_types_include_enriched_images(monkeypatch):
    seen = {}

    def _fake_filter(chunk_types, contract_id=None):
        seen["chunk_types"] = tuple(chunk_types)
        seen["contract_id"] = contract_id
        return object()

    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _RecordingRetriever)
    monkeypatch.setattr(graph, "_chunk_type_filter", _fake_filter)

    graph.retrieve("diagram in contract")

    assert seen["chunk_types"] == ("clause", "table", "image")


def test_retrieve_explicit_alpha_overrides_config(monkeypatch):
    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _RecordingRetriever)
    graph.retrieve("q", alpha=0.7)
    assert _RecordingRetriever.last_kwargs["alpha"] == 0.7


def test_retrieve_with_reranker_reranks_candidates(monkeypatch):
    class _Retr:
        def __init__(self, **kw):
            pass

        def invoke(self, _q):
            return ["c1", "c2", "c3"]

    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _Retr)

    from contract_rag.retrieval import reranker as rr
    captured = {}

    def _fake_rerank(query, candidates, *, top_n=None, model=None):
        captured["query"] = query
        captured["candidates"] = candidates
        captured["top_n"] = top_n
        return candidates[:top_n] if top_n else candidates

    monkeypatch.setattr(rr, "rerank", _fake_rerank)

    out = graph.retrieve("q", use_reranker=True, top_n=2)
    assert captured["query"] == "q"
    assert captured["candidates"] == ["c1", "c2", "c3"]
    assert captured["top_n"] == 2
    assert out == ["c1", "c2"]


def test_answer_with_sources_forwards_alpha(monkeypatch):
    captured = {}

    def _fake_retrieve(q, **kw):
        captured.update(kw)
        return []

    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    class _FakeOut:
        content = "x"

    class _FakeChat:
        def invoke(self, _p):
            return _FakeOut()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _FakeChat())
    graph.answer_with_sources("q", contract_id="2026004", alpha=0.3, use_reranker=True)
    assert captured["alpha"] == 0.3
    assert captured["use_reranker"] is True
