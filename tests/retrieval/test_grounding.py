"""Grounding guard — verify agent-authored evidence against the real retrieved
data: a strict clause-snippet gate (A), ledger-authoritative record projection
(D), and abstention when nothing survives (F). All pure/deterministic.
"""
from contract_rag.retrieval import grounding


# --- A: clause snippet gate -------------------------------------------------

def test_verify_clause_keeps_verbatim_substring():
    chunks = [{"contract_id": "c1", "page": 2,
               "snippet": "审计费用分两期支付，逾期按万分之五。"}]
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "逾期按万分之五"}]
    assert grounding.verify_clause_grounding(items, chunks) == items


def test_verify_clause_keeps_match_ignoring_whitespace():
    chunks = [{"contract_id": "c1", "snippet": "Net 30 days after invoice."}]
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "Net30 days"}]
    assert grounding.verify_clause_grounding(items, chunks) == items


def test_verify_clause_drops_swapped_number():
    # The damaging case: snippet keeps the sentence shape but swaps a figure.
    # Lenient fuzzy matching would tolerate it; the strict gate must not.
    chunks = [{"contract_id": "c1", "snippet": "逾期按万分之五计收违约金。"}]
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "逾期按万分之十计收违约金"}]
    assert grounding.verify_clause_grounding(items, chunks) == []


def test_verify_clause_drops_fabricated_snippet():
    chunks = [{"contract_id": "c1", "snippet": "完全不同的内容"}]
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "凭空捏造的条款"}]
    assert grounding.verify_clause_grounding(items, chunks) == []


def test_verify_clause_drops_snippet_from_other_contract():
    chunks = [{"contract_id": "c2", "snippet": "逾期按万分之五。"}]
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "逾期按万分之五"}]
    assert grounding.verify_clause_grounding(items, chunks) == []


def test_verify_clause_drops_empty_snippet():
    items = [{"kind": "clause", "contract_id": "c1", "snippet": ""}]
    assert grounding.verify_clause_grounding(items, []) == []


def test_verify_clause_passes_record_items_through():
    items = [{"kind": "record", "contract_id": "c1", "fields": {}}]
    assert grounding.verify_clause_grounding(items, []) == items


# --- D: record projection from the real ledger row --------------------------

_ROWS = [
    {"contract_id": "2026002", "counterparty": "Linde Gas & Equipment Inc.",
     "amount": 70904.55, "currency": "USD", "department": "OPS",
     "effective_date": "2026-01-01", "expiration_date": "2028-12-31"},
]


def test_verify_record_overwrites_value_from_ledger():
    # LLM swapped the amount; the real row value must win.
    items = [{"kind": "record", "contract_id": "2026002",
              "fields": {"金额": 99999.0}}]
    out = grounding.verify_record_grounding(items, _ROWS)
    assert out[0]["fields"]["金额"] == 70904.55
    assert out[0]["fields"]["对方公司"] == "Linde Gas & Equipment Inc."
    assert out[0]["title"] == "Linde Gas & Equipment Inc."


def test_verify_record_drops_unretrieved_contract():
    items = [{"kind": "record", "contract_id": "9999", "fields": {}}]
    assert grounding.verify_record_grounding(items, _ROWS) == []


def test_verify_record_omits_empty_ledger_fields():
    rows = [{"contract_id": "c1", "counterparty": "Acme", "amount": 10.0,
             "currency": "", "department": None}]
    items = [{"kind": "record", "contract_id": "c1", "fields": {}}]
    out = grounding.verify_record_grounding(items, rows)
    assert out[0]["fields"] == {"对方公司": "Acme", "金额": 10.0}


def test_verify_record_dedupes_same_contract():
    items = [{"kind": "record", "contract_id": "2026002", "fields": {}},
             {"kind": "record", "contract_id": "2026002", "fields": {}}]
    out = grounding.verify_record_grounding(items, _ROWS)
    assert len(out) == 1


def test_verify_record_passes_clause_items_through():
    items = [{"kind": "clause", "contract_id": "c1", "snippet": "x"}]
    assert grounding.verify_record_grounding(items, _ROWS) == items


# --- F: abstention ----------------------------------------------------------

def test_abstain_when_no_evidence_survives():
    answer, items = grounding.apply_abstention("编造的结论。", [])
    assert items == []
    assert answer == grounding.ABSTAIN_ANSWER


def test_no_abstention_when_evidence_present():
    ev = [{"kind": "record", "contract_id": "c1", "fields": {}}]
    answer, items = grounding.apply_abstention("有据的结论。", ev)
    assert answer == "有据的结论。"
    assert items == ev
