"""Open-corpus retrieval runner logic (all live calls mocked)."""
import json

import pytest
from langchain_core.documents import Document

from evals import run_open_retrieval as ror
from evals.dataset import GoldCase


def _doc(contract_id, text):
    return Document(page_content=text, metadata={"contract_id": contract_id, "chunk_type": "clause"})


def test_score_case_tracks_contract_hit_rank_and_expected_coverage():
    case = GoldCase("propane price", "propane rental fee", "JSUS2024059")
    docs = [
        _doc("2026004", "water treatment"),
        _doc("JSUS2024059", "propane rental fee"),
    ]
    embed = lambda text: {
        "propane rental fee": [1.0, 0.0],
        "water treatment": [0.0, 1.0],
    }.get(text, [1.0, 0.0])

    row = ror._score_case(case, docs, embed)

    assert row["top_contract_id"] == "2026004"
    assert row["top1_contract_match"] is False
    assert row["contract_hit"] is True
    assert row["expected_contract_rank"] == 2
    assert row["expected_contract_coverage"] == 1.0


def test_summarize_scores():
    rows = [
        {"top1_contract_match": True, "contract_hit": True, "expected_contract_rank": 1,
         "retrieval_coverage": 0.8, "expected_contract_coverage": 0.7},
        {"top1_contract_match": False, "contract_hit": True, "expected_contract_rank": 3,
         "retrieval_coverage": 0.6, "expected_contract_coverage": 0.5},
        {"top1_contract_match": False, "contract_hit": False, "expected_contract_rank": None,
         "retrieval_coverage": 0.4, "expected_contract_coverage": 0.0},
    ]

    summary = ror._summarize(rows)

    assert summary["top1_contract_accuracy"] == 1 / 3
    assert summary["contract_hit_rate"] == 2 / 3
    assert summary["mean_expected_contract_rank"] == 2.0
    assert summary["retrieval_coverage"] == 0.6
    assert summary["expected_contract_coverage"] == pytest.approx(0.4)


def test_main_writes_report(monkeypatch, tmp_path):
    closed = {"value": False}
    monkeypatch.setattr(ror, "_REPORTS", tmp_path)
    monkeypatch.setattr(ror, "_preflight", lambda cases: None)
    monkeypatch.setattr(ror, "load_dataset",
                        lambda _p: [GoldCase("propane price", "propane rental fee", "JSUS2024059")])
    monkeypatch.setattr(ror, "_embed_fn", lambda: (lambda text: [1.0, 0.0]))
    monkeypatch.setattr(ror, "retrieve",
                        lambda q, **kw: [_doc("JSUS2024059", "propane rental fee")])
    monkeypatch.setattr(ror.vector_store, "close_client", lambda: closed.update(value=True))

    ror.main([])

    reports = list(tmp_path.glob("*.json"))
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "open-corpus-retrieval"
    assert report["summary"]["top1_contract_accuracy"] == 1.0
    assert report["cases"][0]["contract_hit"] is True
    assert closed["value"] is True
