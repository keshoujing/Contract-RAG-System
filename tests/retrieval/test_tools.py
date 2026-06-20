"""Agent tools — query_ledger (SQLite) + search_clauses (Weaviate) + provenance.

Offline: db.list_contracts and retrieve are monkeypatched. These are the two
functions the tool-calling agent invokes; filters/queries come from the LLM.
"""
from langchain_core.documents import Document

from contract_rag.retrieval import tools


_ROWS = [
    {"contract_id": "2026002", "counterparty": "Linde Gas & Equipment Inc.",
     "amount": 70904.55, "currency": "USD", "department": "OPS",
     "contract_type": "采购合同", "project_name": "gas supply"},
    {"contract_id": "2024030", "counterparty": "UniFirst Inc.",
     "amount": 30000.0, "currency": "USD", "department": "HR",
     "contract_type": "服务合同", "project_name": "uniform rental"},
]


def test_query_ledger_filters_by_name(monkeypatch):
    monkeypatch.setattr(tools.db, "list_contracts", lambda: _ROWS)
    out = tools.query_ledger({"name": "Linde"})
    assert [r["contract_id"] for r in out] == ["2026002"]
    assert out[0]["counterparty"] == "Linde Gas & Equipment Inc."


def test_query_ledger_empty_filters_returns_all(monkeypatch):
    monkeypatch.setattr(tools.db, "list_contracts", lambda: _ROWS)
    out = tools.query_ledger({})
    assert {r["contract_id"] for r in out} == {"2026002", "2024030"}


def test_query_ledger_amount_min(monkeypatch):
    monkeypatch.setattr(tools.db, "list_contracts", lambda: _ROWS)
    out = tools.query_ledger({"amount_min": 50000})
    assert [r["contract_id"] for r in out] == ["2026002"]


def _doc(content, **meta):
    return Document(page_content=content, metadata=meta)


def test_search_clauses_maps_chunks(monkeypatch):
    docs = [_doc("Net 30 days.", contract_id="2026004", chunk_type="clause",
                 page_start=3, page_end=3, section_path="4 Payment",
                 bbox=[66, 386, 931, 421])]
    monkeypatch.setattr(tools, "retrieve", lambda q, **kw: docs)
    out = tools.search_clauses("payment terms", contract_id="2026004")
    assert out == [{
        "contract_id": "2026004", "page": 3, "section": "4 Payment",
        "snippet": "Net 30 days.", "bbox": [0.066, 0.386, 0.865, 0.035],
    }]


def test_search_clauses_can_filter_multiple_contract_ids(monkeypatch):
    captured = {}
    docs = [_doc("Net 30 days.", contract_id="2026004", page_start=3)]
    monkeypatch.setattr(tools, "retrieve", lambda q, **kw: captured.update(question=q, **kw) or docs)

    tools.search_clauses("payment terms", contract_ids=["2026004", "2026005"])

    assert captured["contract_id"] is None
    assert captured["contract_ids"] == ["2026004", "2026005"]


def test_attach_clause_provenance_copies_page_and_bbox():
    chunks = [{"contract_id": "c1", "page": 2, "section": "付款",
               "snippet": "审计费用分两期支付，逾期按万分之五。",
               "bbox": [1.0, 2.0, 3.0, 4.0]}]
    items = [{"kind": "clause", "contract_id": "c1",
              "snippet": "逾期按万分之五", "page": None, "bbox": None}]
    out = tools.attach_clause_provenance(items, chunks)
    assert out[0]["page"] == 2
    assert out[0]["bbox"] == [1.0, 2.0, 3.0, 4.0]


def test_attach_clause_provenance_fuzzy_match_ignoring_whitespace():
    # LLM dropped spaces / lightly reworded — still the same passage, so page
    # must still attach (verify popup degrades badly if page is lost).
    chunks = [{"contract_id": "c1", "page": 7,
               "snippet": "基础 IT 服务响应时间不超过 2 小时，紧急故障响应不超过 1 小时。",
               "bbox": None}]
    items = [{"kind": "clause", "contract_id": "c1",
              "snippet": "基础IT服务响应时间不超过2小时", "page": None, "bbox": None}]
    out = tools.attach_clause_provenance(items, chunks)
    assert out[0]["page"] == 7


def test_attach_clause_provenance_no_match_leaves_none():
    chunks = [{"contract_id": "c1", "page": 2, "snippet": "完全不同的内容",
               "bbox": [1.0, 2.0, 3.0, 4.0]}]
    items = [{"kind": "clause", "contract_id": "c1",
              "snippet": "找不到的片段", "page": None, "bbox": None}]
    out = tools.attach_clause_provenance(items, chunks)
    assert out[0]["page"] is None
    assert out[0]["bbox"] is None


def test_attach_clause_provenance_ignores_record_items():
    chunks = [{"contract_id": "c1", "page": 2, "snippet": "x", "bbox": None}]
    items = [{"kind": "record", "contract_id": "c1", "fields": {}}]
    out = tools.attach_clause_provenance(items, chunks)
    assert out[0] == {"kind": "record", "contract_id": "c1", "fields": {}}
