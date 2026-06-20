from langchain_core.documents import Document

from contract_rag.retrieval import graph


def _doc(content, **meta):
    return Document(page_content=content, metadata=meta)


def test_state_to_result_clause_path():
    docs = [_doc("Net 30 days.", contract_id="2026004", chunk_type="clause",
                 page_start=3, page_end=3, section_path="4 Payment")]
    state = {
        "original_question": "付款账期？",
        "question": "付款条款是几天？",   # rewritten — must NOT leak into result
        "question_class": "clause",
        "documents": docs,
        "generation": "Net 30.",
        "iterations": 2,
    }
    res = graph._state_to_result(state)
    assert res.question == "付款账期？"          # original, not rewritten
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"
    assert res.diagnostics == {"iterations": 2}


def test_state_to_result_entity_path(monkeypatch):
    monkeypatch.setattr(graph.db, "list_contracts",
                        lambda: [{"contract_id": "2026004"}])
    state = {
        "original_question": "谁是买方？",
        "question": "谁是买方？",
        "question_class": "entity",
        "documents": [],
        "generation": "China Jushi USA。",
        "iterations": 0,
    }
    res = graph._state_to_result(state)
    assert res.question_class == "entity"
    assert res.contexts == []
    assert res.sources == [{"contract_id": "2026004"}]
    assert res.diagnostics == {"iterations": 0}


def test_state_to_result_comparison_with_retrieved_docs_keeps_evidence():
    docs = [_doc("30 days notice.", contract_id="2026002", chunk_type="clause",
                 page_start=2, page_end=2, section_path="Termination")]
    state = {
        "original_question": "哪些合同提到30 days？",
        "question": "30 days clause",
        "question_class": "comparison",
        "documents": docs,
        "generation": "2026002 提到 30 days。",
        "iterations": 1,
    }

    res = graph._state_to_result(state)

    assert res.question_class == "comparison"
    assert res.contexts == ["30 days notice."]
    assert res.sources[0]["contract_id"] == "2026002"


def test_classify_node_writes_question_class(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    out = graph._classify_node({"question": "付款账期？"})
    assert out == {"question_class": "clause"}


def test_clause_retrieve_node_threads_params(monkeypatch):
    captured = {}

    def _fake_retrieve(q, **kw):
        captured.update(question=q, **kw)
        return graph.SQLGatedRetrievalResult(
            [_doc("Net 30 days.", contract_id="2026004")],
            {"used_sql_gate": True},
        )

    monkeypatch.setattr(graph, "sql_gated_retrieve", _fake_retrieve)
    state = {
        "question": "付款条款？", "iterations": 0,
        "contract_id": "2026004", "alpha": 0.7, "use_reranker": False,
    }
    out = graph._clause_retrieve_node(state)
    assert captured["question"] == "付款条款？"
    assert captured["contract_id"] == "2026004"
    assert captured["alpha"] == 0.7
    assert captured["use_reranker"] is False
    assert out["iterations"] == 1
    assert "[source 1 contract_id=2026004" in out["context"]
    assert "Net 30 days." in out["context"]
    assert out["retrieval_diagnostics"] == {"used_sql_gate": True}


def test_route_after_classify_sends_comparison_with_clause_evidence_to_clause_path():
    state = {"question_class": "comparison", "question": "哪些合同提到30 days？"}
    assert graph._route_after_classify(state) == "clause"


def test_route_after_classify_sends_entity_with_clause_evidence_to_clause_path():
    state = {"question_class": "entity", "question": "JSUS2024059 propane rental fee 是多少？"}
    assert graph._route_after_classify(state) == "clause"


def test_generate_node_reads_temperature(monkeypatch):
    seen = {}

    class _FakeOut:
        content = "Net 30."

    class _FakeChat:
        def invoke(self, _prompt):
            return _FakeOut()

    def _fake_get_chat(self, model, *, temperature=None):
        seen["temperature"] = temperature
        return _FakeChat()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object", _fake_get_chat)
    out = graph._generate_node({"context": "Net 30 days.", "question": "账期？",
                                "temperature": 0})
    assert out == {"generation": "Net 30."}
    assert seen["temperature"] == 0


def test_generate_node_uses_sql_gate_prompt_when_diagnostics_exist(monkeypatch):
    seen = {}

    class _FakeOut:
        content = "2026002 mentions 30 days."

    class _FakeChat:
        def invoke(self, prompt):
            seen["prompt"] = prompt
            return _FakeOut()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, *, temperature=None: _FakeChat())

    out = graph._generate_node({
        "context": "[source 1 contract_id=2026002]\n30 days notice.",
        "question": "哪些合同提到30 days？",
        "temperature": 0,
        "retrieval_diagnostics": {
            "filters": {"identifier": "2026002"},
            "candidate_contract_ids": ["2026002"],
            "matched_contract_ids": ["2026002"],
            "supplemented_open_search": False,
        },
    })

    assert out == {"generation": "2026002 mentions 30 days."}
    assert "SQL gate summary:" in seen["prompt"]
    assert "SQL gate matched vector contract IDs: 2026002" in seen["prompt"]
    assert "[source 1 contract_id=2026002]" in seen["prompt"]


def test_clause_retrieve_node_defaults_when_params_absent(monkeypatch):
    captured = {}

    def _fake_retrieve(q, **kw):
        captured.update(**kw)
        return graph.SQLGatedRetrievalResult([_doc("X", contract_id="2026004")], {})

    monkeypatch.setattr(graph, "sql_gated_retrieve", _fake_retrieve)
    out = graph._clause_retrieve_node({"question": "q", "iterations": 0})
    assert captured["contract_id"] is None
    assert captured["alpha"] is None
    assert captured["use_reranker"] is None
    assert out["iterations"] == 1


def _fake_chat_by_prompt():
    """One fake chat: 'true' for the sufficiency prompt, else a canned answer."""
    class _Out:
        def __init__(self, content):
            self.content = content

    class _Chat:
        def invoke(self, prompt):
            text = prompt if isinstance(prompt, str) else str(prompt)
            return _Out("true" if "足够" in text else "Net 30.")
    return _Chat()


def test_agent_answer_with_sources_clause(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(
        graph, "sql_gated_retrieve",
        lambda q, **kw: graph.SQLGatedRetrievalResult(
            [_doc("Net 30 days.", contract_id="2026004",
                  chunk_type="clause", page_start=3, page_end=3,
                  section_path="4 Payment")],
            {"used_sql_gate": True},
        ),
    )
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, *, temperature=None: _fake_chat_by_prompt())
    graph._compiled_agent.cache_clear()

    res = graph.agent_answer_with_sources("付款账期？", contract_id="2026004")
    assert res.question == "付款账期？"
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"
    assert res.diagnostics["iterations"] == 1   # sufficient on first pass, no rewrite


def test_agent_answer_with_sources_comparison_clause_path_preserves_sources(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "comparison")
    monkeypatch.setattr(
        graph, "sql_gated_retrieve",
        lambda q, **kw: graph.SQLGatedRetrievalResult(
            [_doc("30 days notice.", contract_id="2026002",
                  chunk_type="clause", page_start=2, page_end=2)],
            {"used_sql_gate": True, "matched_contract_ids": ["2026002"]},
        ),
    )
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, *, temperature=None: _fake_chat_by_prompt())
    graph._compiled_agent.cache_clear()

    res = graph.agent_answer_with_sources("哪些合同提到30 days？")

    assert res.question_class == "comparison"
    assert res.contexts == ["30 days notice."]
    assert res.sources[0]["contract_id"] == "2026002"
    assert res.diagnostics["matched_contract_ids"] == ["2026002"]


def test_agent_invoke_returns_answer_string(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "sql_gated_retrieve",
                        lambda q, **kw: graph.SQLGatedRetrievalResult(
                            [_doc("Net 30 days.", contract_id="2026004")], {}
                        ))
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, *, temperature=None: _fake_chat_by_prompt())
    graph._compiled_agent.cache_clear()

    assert graph.ContractRAGAgent().invoke("付款账期？") == "Net 30."
