"""Evidence contract (§5) — builders + normalizer for LLM-authored evidence.

Pure, offline. The agent's final JSON carries a raw ``evidence`` list; we
normalize it into the stable shape the API/front-end consume (kind=clause/record,
clause carries page/bbox). Malformed items are dropped, not trusted.
"""
from contract_rag.retrieval import evidence as ev


def test_clause_item_shape():
    item = ev.clause_item("JSUS2024070", page=2, section="付款条款",
                          snippet="逐字原文", bbox=[1.0, 2.0, 3.0, 4.0])
    assert item == {
        "kind": "clause", "contract_id": "JSUS2024070", "page": 2,
        "section": "付款条款", "snippet": "逐字原文", "bbox": [1.0, 2.0, 3.0, 4.0],
    }


def test_clause_item_bbox_defaults_none():
    item = ev.clause_item("c", page=1, snippet="x")
    assert item["bbox"] is None
    assert item["section"] == ""


def test_record_item_shape():
    item = ev.record_item("2024030", fields={"付款期限": "60天"}, title="UniFirst")
    assert item == {
        "kind": "record", "contract_id": "2024030",
        "title": "UniFirst", "fields": {"付款期限": "60天"},
    }


def test_normalize_drops_unknown_kind():
    raw = [{"kind": "note", "contract_id": "c"}]
    assert ev.normalize_evidence(raw) == []


def test_normalize_drops_missing_contract_id():
    raw = [{"kind": "clause", "snippet": "x"}]
    assert ev.normalize_evidence(raw) == []


def test_normalize_clause_defaults_bbox_none():
    raw = [{"kind": "clause", "contract_id": "c", "page": 3, "snippet": "x"}]
    out = ev.normalize_evidence(raw)
    assert out[0]["kind"] == "clause"
    assert out[0]["bbox"] is None
    assert out[0]["page"] == 3


def test_normalize_record_keeps_fields():
    raw = [{"kind": "record", "contract_id": "c", "fields": {"金额": "¥1"}}]
    out = ev.normalize_evidence(raw)
    assert out[0] == {"kind": "record", "contract_id": "c", "title": None,
                      "fields": {"金额": "¥1"}}


def test_normalize_non_list_returns_empty():
    assert ev.normalize_evidence(None) == []
    assert ev.normalize_evidence("oops") == []


def test_normalize_skips_non_dict_items():
    raw = [{"kind": "record", "contract_id": "c", "fields": {}}, "junk", 42]
    out = ev.normalize_evidence(raw)
    assert len(out) == 1
