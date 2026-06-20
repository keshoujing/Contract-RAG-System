from contract_rag.config import load_config


def test_rag_model_tiers_present():
    models = load_config().models
    assert models.rag_generate == "gemini-3-flash-preview"
    assert models.rag_light == "gemini-2.5-flash-lite"
    assert models.rag_judge == "gemini-2.5-flash"


def test_ocr_parallelism_config_present():
    assert load_config().models.ocr_max_workers == 3


def test_reranker_model_present():
    assert load_config().models.rerank == "semantic-ranker-default@latest"
