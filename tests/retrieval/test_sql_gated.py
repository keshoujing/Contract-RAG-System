from langchain_core.documents import Document

from contract_rag.retrieval import graph


def _doc(contract_id, text="x"):
    return Document(page_content=text, metadata={"contract_id": contract_id, "chunk_type": "clause"})


def test_match_indexed_contract_ids_uses_archive_id_not_contract_number():
    rows = [{"contract_id": "2026004", "file_no": "2026004", "contract_number": "JSUS2026004",
             "counterparty": "ChemAqua"}]

    matched = graph._match_indexed_contract_ids(rows, ["2026004", "JSUS2024059"])

    assert matched == ["2026004"]


def test_sql_candidate_rows_can_filter_by_contract_number(monkeypatch):
    rows = [{"contract_id": "2026002", "file_no": "2026002", "contract_number": "JSUS2024059",
             "counterparty": "Linde"}]

    monkeypatch.setattr(graph.db, "list_contracts", lambda: rows)
    matched_rows, diagnostics = graph._sql_candidate_rows("What is the propane rental fee in JSUS2024059?")

    assert [r["contract_id"] for r in matched_rows] == ["2026002"]
    assert diagnostics["filters"]["identifier"] == "JSUS2024059"


def test_sql_candidate_rows_numeric_file_no_is_exact_not_suffix(monkeypatch):
    rows = [
        {"contract_id": "2026002", "file_no": "2026002", "contract_number": "JSUS2024059"},
        {"contract_id": "CN2026002", "file_no": "CN2026002", "contract_number": "JSEGRCXS20260003"},
    ]
    monkeypatch.setattr(graph.db, "list_contracts", lambda: rows)

    matched_rows, _ = graph._sql_candidate_rows("What is the propane rental fee in 2026002?")

    assert [r["contract_id"] for r in matched_rows] == ["2026002"]


def test_sql_candidate_rows_applies_amount_and_department_filters(monkeypatch):
    rows = [
        {"contract_id": "A", "amount": 147664.05, "department": "UD", "contract_type": "Purchase Contract"},
        {"contract_id": "B", "amount": 70904.55, "department": "PD", "contract_type": "Purchase Contract"},
        {"contract_id": "C", "amount": None, "department": "PD", "contract_type": "Service Contract"},
    ]
    monkeypatch.setattr(graph.db, "list_contracts", lambda: rows)

    amount_rows, amount_diag = graph._sql_candidate_rows("Which contracts over $100,000 contain price adjustment clauses?")
    dept_rows, dept_diag = graph._sql_candidate_rows("What is the propane fee in PD department purchase contracts?")

    assert [r["contract_id"] for r in amount_rows] == ["A"]
    assert amount_diag["filters"]["amount_min"] == 100000
    assert [r["contract_id"] for r in dept_rows] == ["B"]
    assert dept_diag["filters"]["department"] == "PD"
    assert dept_diag["filters"]["contract_type"] == "Purchase Contract"


def test_sql_gated_retrieve_limits_to_matched_candidate_ids(monkeypatch):
    rows = [{"contract_id": "2026004", "file_no": "2026004", "contract_number": "JSUS2026004",
             "counterparty": "ChemAqua"}]
    seen = {}

    monkeypatch.setattr(graph, "_sql_candidate_rows", lambda q: (rows, {"filters": {"counterparty": "ChemAqua"}}))
    monkeypatch.setattr(graph, "_indexed_contract_ids", lambda: ["2026004", "JSUS2024059"])

    def _fake_retrieve(q, **kw):
        seen.update(kw)
        return [_doc("2026004")]

    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    res = graph.sql_gated_retrieve("What are the payment terms in the ChemAqua contract?")

    assert seen["contract_ids"] == ["2026004"]
    assert res.documents[0].metadata["contract_id"] == "2026004"
    assert res.diagnostics["used_sql_gate"] is True
    assert res.diagnostics["candidate_contract_ids"] == ["2026004"]
    assert res.diagnostics["matched_contract_ids"] == ["2026004"]


def test_sql_gated_retrieve_falls_back_when_sql_has_no_candidates(monkeypatch):
    seen = {}
    monkeypatch.setattr(graph, "_sql_candidate_rows", lambda q: ([], {"filters": {"department": "PD"}}))

    def _fake_retrieve(q, **kw):
        seen.update(kw)
        return [_doc("OPEN")]

    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    res = graph.sql_gated_retrieve("What clauses appear in PD department contracts?")

    assert seen["contract_ids"] is None
    assert res.documents[0].metadata["contract_id"] == "OPEN"
    assert res.diagnostics["used_sql_gate"] is False
    assert res.diagnostics["fallback_reason"] == "no_sql_candidates"


def test_sql_gated_retrieve_does_not_supplement_open_search_for_structured_filters(monkeypatch):
    rows = [{"contract_id": "2026002", "file_no": "2026002", "contract_number": "JSUS2024059",
             "contract_type": "Purchase Contract", "expiration_date": "2026-10-02"}]
    calls = []

    monkeypatch.setattr(graph, "_sql_candidate_rows", lambda q: (rows, {"filters": {"contract_type": "Purchase Contract", "year": "2026"}}))
    monkeypatch.setattr(graph, "_indexed_contract_ids", lambda: ["2026002", "CN2026002"])

    def _fake_retrieve(q, **kw):
        calls.append(kw)
        if kw.get("contract_ids"):
            return [_doc("2026002", "thirty days notice")]
        return [_doc("CN2026002", "within thirty (30) days"), _doc("2026002", "duplicate")]

    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    res = graph.sql_gated_retrieve("Which purchase contracts effective or expiring in 2026 mention 30 days?")

    assert calls[0]["contract_ids"] == ["2026002"]
    assert len(calls) == 1
    assert [d.metadata["contract_id"] for d in res.documents] == ["2026002"]
    assert res.diagnostics["used_sql_gate"] is True
    assert res.diagnostics["supplemented_open_search"] is False


def test_sql_gated_retrieve_uses_metadata_question_for_sql_filters(monkeypatch):
    rows = [{"contract_id": "2026004", "file_no": "2026004", "amount": 147664.05}]
    calls = []

    monkeypatch.setattr(graph, "_sql_candidate_rows",
                        lambda q: (rows, {"filters": {"amount_min": 100000}, "seen_question": q}))
    monkeypatch.setattr(graph, "_indexed_contract_ids", lambda: ["2026004", "2026002"])

    def _fake_retrieve(q, **kw):
        calls.append((q, kw))
        return [_doc("2026004", "price adjustment")]

    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    res = graph.sql_gated_retrieve(
        "rewritten price adjustment query",
        metadata_question="Which contracts over $100,000 contain price adjustment clauses?",
    )

    assert calls[0][0] == "rewritten price adjustment query"
    assert calls[0][1]["contract_ids"] == ["2026004"]
    assert res.diagnostics["metadata_question"] == "Which contracts over $100,000 contain price adjustment clauses?"
    assert res.diagnostics["filters"] == {"amount_min": 100000}


def test_diversify_documents_by_contract_round_robins_evidence():
    docs = [
        _doc("A", "a1"), _doc("A", "a2"), _doc("A", "a3"),
        _doc("B", "b1"),
        _doc("C", "c1"),
    ]

    out = graph._diversify_documents_by_contract(docs)

    assert [(d.metadata["contract_id"], d.page_content) for d in out] == [
        ("A", "a1"), ("B", "b1"), ("C", "c1"), ("A", "a2"), ("A", "a3"),
    ]


def test_sql_gated_answer_uses_chunks_for_comparison_that_needs_clause_evidence(monkeypatch):
    docs = [_doc("2026004", "Prices shall be adjusted annually.")]
    seen = {}

    monkeypatch.setattr(graph, "classify_query", lambda q: "comparison")

    def _fake_sql_gated_retrieve(q, **kw):
        seen.update(question=q, **kw)
        return graph.SQLGatedRetrievalResult(
            docs,
            {
                "used_sql_gate": True,
                "candidate_contract_ids": ["JSUS2026004"],
                "matched_contract_ids": ["2026004"],
                "filters": {"amount_min": 100000},
            },
        )

    class _FakeOut:
        content = "2026004 has a price adjustment clause."

    class _FakeChat:
        def invoke(self, prompt):
            seen["prompt"] = prompt
            return _FakeOut()

    monkeypatch.setattr(graph, "sql_gated_retrieve", _fake_sql_gated_retrieve)
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _FakeChat())

    res = graph.sql_gated_answer_with_sources("Which contracts over $100,000 contain price adjustment clauses?")

    assert seen["question"] == "Which contracts over $100,000 contain price adjustment clauses?"
    assert res.question_class == "comparison"
    assert res.answer == "2026004 has a price adjustment clause."
    assert res.contexts == ["Prices shall be adjusted annually."]
    assert res.sources[0]["contract_id"] == "2026004"
    assert res.diagnostics["used_sql_gate"] is True
    assert "[source 1 contract_id=2026004" in seen["prompt"]
    assert "SQL gate matched vector contract IDs: 2026004" in seen["prompt"]


def test_sql_gated_answer_keeps_pure_entity_questions_on_sql(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "entity")
    monkeypatch.setattr(graph, "entity_lookup", lambda q: "The contract amount is 100.")
    monkeypatch.setattr(graph.db, "list_contracts", lambda: [{"contract_id": "A"}])

    res = graph.sql_gated_answer_with_sources("What is the contract amount?")

    assert res.question_class == "entity"
    assert res.contexts == []
    assert res.sources == [{"contract_id": "A"}]
