from contract_rag.llm import LLM


def test_custom_chat_object_sets_temperature():
    chat = LLM().get_custom_chat_object("gemini-2.5-flash", temperature=0)
    assert chat.temperature == 0


def test_custom_chat_object_default_temperature_unset():
    chat = LLM().get_custom_chat_object("gemini-2.5-flash")
    # Observed default: this langchain version surfaces 0.7 when no temperature
    # is passed (not None). We assert the real default rather than None so the
    # test stays honest. The implementation must NOT force any value when the
    # caller omits the argument — langchain's own default (0.7) is intentional.
    assert chat.temperature == 0.7
