from contract_rag.config import load_config
from contract_rag.llm import LLM


def test_get_chat_object_uses_configured_generate_model():
    chat = LLM().get_chat_object()
    assert chat.model.endswith(load_config().models.rag_generate)
