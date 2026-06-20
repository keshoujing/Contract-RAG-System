"""Tool-calling agent — pure parts (final-JSON parse + evidence assembly).

The live agent (Gemini tool-calling loop) is an integration entry point, not in
the unit gate. Here we test the deterministic glue: parsing the model's final
JSON and assembling/back-filling evidence.
"""
from contract_rag.retrieval import agent


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
    # (observed: a bare 「洞察」 between the array and the closing brace).
    raw = ('{"answer": "A", "evidence": '
           '[{"kind":"record","contract_id":"c","fields":{}}]洞察}')
    parsed = agent._parse_final(raw)
    assert parsed["answer"] == "A"
    assert parsed["evidence"][0]["contract_id"] == "c"


def test_assemble_backfills_clause_and_keeps_record():
    parsed = {
        "answer": "结论。",
        "evidence": [
            {"kind": "clause", "contract_id": "c1", "section": "付款",
             "snippet": "逾期按万分之五"},
            {"kind": "record", "contract_id": "c2", "fields": {"金额": "¥1"}},
        ],
    }
    chunks = [{"contract_id": "c1", "page": 2, "section": "付款",
               "snippet": "审计费用分两期支付，逾期按万分之五。",
               "bbox": [1.0, 2.0, 3.0, 4.0]}]

    res = agent._assemble("q", parsed, chunks)

    assert res.answer == "结论。"
    assert res.evidence[0]["kind"] == "clause"
    assert res.evidence[0]["page"] == 2
    assert res.evidence[0]["bbox"] == [1.0, 2.0, 3.0, 4.0]
    assert res.evidence[1] == {"kind": "record", "contract_id": "c2",
                               "title": None, "fields": {"金额": "¥1"}}


def test_assemble_drops_malformed_evidence():
    parsed = {"answer": "A", "evidence": [{"kind": "clause"}, "junk"]}
    res = agent._assemble("q", parsed, [])
    assert res.evidence == []


def test_history_messages_maps_roles():
    hist = [
        {"role": "user", "content": "水处理合同是哪一份"},
        {"role": "assistant", "content": "JSUS2026004。", "evidence": [{"kind": "clause"}]},
    ]
    msgs = agent._history_messages(hist)
    assert [type(m).__name__ for m in msgs] == ["HumanMessage", "AIMessage"]
    assert msgs[0].content == "水处理合同是哪一份"
    assert msgs[1].content == "JSUS2026004。"


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


def test_system_prompt_treats_ledger_counterparty_as_authoritative():
    prompt = agent._SYSTEM_PROMPT
    assert "合同对方/供应商/合同主体" in prompt
    assert "query_ledger" in prompt
    assert "counterparty" in prompt
    assert "比价对象" in prompt
    assert "不得当作该合同的供应商" in prompt
