"""Tool-calling agent — pure parts (final-JSON parse + evidence assembly).

The live agent (Gemini tool-calling loop) is an integration entry point, not in
the unit gate. Here we test the deterministic glue: parsing the model's final
JSON and assembling/back-filling evidence.
"""
from types import SimpleNamespace

from contract_rag.retrieval import agent, grounding


def test_parse_final_plain_json():
    assert agent._parse_final('{"answer": "A", "evidence": []}') == {
        "answer": "A", "evidence": []}


def test_parse_final_strips_code_fence():
    raw = '```json\n{"answer": "A", "evidence": []}\n```'
    assert agent._parse_final(raw)["answer"] == "A"


def test_parse_final_list_content_block():
    # Gemini-3 may return content as a list of blocks; extract_text flattens it.
    raw = [{"type": "text", "text": '{"answer": "B", "evidence": []}'}]
    assert agent._parse_final(raw)["answer"] == "B"


def test_parse_final_garbage_returns_empty():
    assert agent._parse_final("not json at all") == {}


def test_parse_final_repairs_stray_token():
    # Gemini-3 occasionally injects a stray token into otherwise-valid JSON
    # (observed: a bare word between the array and the closing brace).
    raw = ('{"answer": "A", "evidence": '
           '[{"kind":"record","contract_id":"c","fields":{}}]insight}')
    parsed = agent._parse_final(raw)
    assert parsed["answer"] == "A"
    assert parsed["evidence"][0]["contract_id"] == "c"


def test_parse_final_recovers_when_stray_token_replaces_closing_brace():
    # Gemini-3 sometimes emits a stray token *in place of* the final brace, leaving
    # the object unclosed (observed on record-heavy answers). The parser must
    # re-balance and recover the (otherwise valid) answer instead of abstaining.
    raw = ('{"answer": "A", "evidence": '
           '[{"kind":"record","contract_id":"c","fields":{"Amount":1}}]X')
    parsed = agent._parse_final(raw)
    assert parsed["answer"] == "A"
    assert parsed["evidence"][0]["contract_id"] == "c"


def test_assemble_backfills_clause_and_projects_record():
    # Clause snippet is a real excerpt -> kept + page/bbox back-filled.
    # Record value is re-projected from the real ledger row: the LLM's bogus
    # 99.0 must not survive; the ledger's 12345.0 wins.
    parsed = {
        "answer": "Conclusion.",
        "evidence": [
            {"kind": "clause", "contract_id": "c1", "section": "Payment",
             "snippet": "late payment accrues 0.05% per day"},
            {"kind": "record", "contract_id": "c2", "fields": {"Amount": 99.0}},
        ],
    }
    chunks = [{"contract_id": "c1", "page": 2, "section": "Payment",
               "snippet": "Audit fees are paid in two installments; late payment accrues 0.05% per day.",
               "bbox": [1.0, 2.0, 3.0, 4.0]}]
    rows = [{"contract_id": "c2", "counterparty": "Party B Co.", "amount": 12345.0}]

    res = agent._assemble("q", parsed, chunks, rows)

    assert res.answer == "Conclusion."
    assert res.evidence[0]["kind"] == "clause"
    assert res.evidence[0]["page"] == 2
    assert res.evidence[0]["bbox"] == [1.0, 2.0, 3.0, 4.0]
    rec = res.evidence[1]
    assert rec["kind"] == "record"
    assert rec["title"] == "Party B Co."
    assert rec["fields"]["Amount"] == 12345.0


def test_assemble_abstains_when_all_evidence_ungrounded():
    # Snippet isn't in any retrieved chunk -> dropped -> nothing survives ->
    # the fabricated answer is replaced with the abstention message.
    parsed = {"answer": "Fabricated out of nowhere.", "evidence": [
        {"kind": "clause", "contract_id": "c1", "snippet": "a snippet not in the store"}]}
    chunks = [{"contract_id": "c1", "snippet": "real content that does not contain that snippet"}]
    res = agent._assemble("q", parsed, chunks, [])
    assert res.evidence == []
    assert res.answer == grounding.ABSTAIN_ANSWER


def test_assemble_drops_malformed_evidence():
    parsed = {"answer": "A", "evidence": [{"kind": "clause"}, "junk"]}
    res = agent._assemble("q", parsed, [])
    assert res.evidence == []


def test_history_messages_maps_roles():
    hist = [
        {"role": "user", "content": "which contract is the water-treatment one"},
        {"role": "assistant", "content": "JSUS2026004.", "evidence": [{"kind": "clause"}]},
    ]
    msgs = agent._history_messages(hist)
    assert [type(m).__name__ for m in msgs] == ["HumanMessage", "AIMessage"]
    assert msgs[0].content == "which contract is the water-treatment one"
    assert msgs[1].content == "JSUS2026004."


def test_history_messages_skips_blank_and_unknown_roles():
    hist = [
        {"role": "user", "content": "   "},
        {"role": "system", "content": "ignore me"},
        {"role": "assistant", "content": "ok"},
    ]
    assert [type(m).__name__ for m in agent._history_messages(hist)] == ["AIMessage"]


def test_history_limit_reads_config():
    # Configurable via retrieval.history_max_messages (default 8).
    assert agent.history_limit() == 8


def test_history_messages_caps_to_last_n():
    hist = [{"role": "user", "content": f"q{i}"} for i in range(20)]
    msgs = agent._history_messages(hist)
    assert len(msgs) == agent.history_limit()
    assert msgs[-1].content == "q19"


def test_history_messages_none_is_empty():
    assert agent._history_messages(None) == []


def test_tool_names_extracts_in_call_order():
    # Routing diagnostic: which tool(s) the model asked to call, in order, so a
    # later eval can assert the agent routed an aggregation question to the ledger.
    resp = SimpleNamespace(tool_calls=[
        {"name": "query_ledger", "args": {}, "id": "1"},
        {"name": "search_clauses", "args": {"query": "x"}, "id": "2"},
    ])
    assert agent._tool_names(resp) == ["query_ledger", "search_clauses"]


def test_tool_names_empty_when_no_tool_calls():
    # Final answer message carries no tool_calls; missing attr is also fine.
    assert agent._tool_names(SimpleNamespace(tool_calls=None)) == []
    assert agent._tool_names(SimpleNamespace(tool_calls=[])) == []
    assert agent._tool_names(SimpleNamespace()) == []


def test_system_prompt_documents_sort_and_limit():
    prompt = agent._SYSTEM_PROMPT
    assert "sort_by" in prompt
    assert "limit" in prompt


def test_system_prompt_treats_ledger_counterparty_as_authoritative():
    prompt = agent._SYSTEM_PROMPT
    assert "counterparty / supplier / principal" in prompt
    assert "query_ledger" in prompt
    assert "counterparty" in prompt
    assert "comparison/mentioned parties" in prompt
    assert "must not be treated as that contract's supplier" in prompt
