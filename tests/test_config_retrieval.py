from contract_rag.config import load_config


def test_retrieval_config_defaults():
    r = load_config().retrieval
    assert r.alpha == 0.5
    assert r.use_reranker is False
    assert r.k == 20
    assert r.top_n == 5
    assert r.history_max_messages == 8
