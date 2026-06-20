"""Cross-contract retrieval set runner logic (all live calls mocked)."""
import json

import pytest
from langchain_core.documents import Document

from evals import run_cross_contract_sets as rcc


def _doc(contract_id, text="x"):
    return Document(page_content=text, metadata={"contract_id": contract_id, "chunk_type": "clause"})


def test_score_case_computes_set_metrics():
    case = {
        "id": "q1",
        "category": "find_all",
        "question": "which contracts mention 30 days",
        "expected_contract_ids": ["A", "B"],
        "note": "n",
    }
    docs = [_doc("A"), _doc("C"), _doc("A"), _doc("B")]

    row = rcc._score_case(case, docs)

    assert row["retrieved_contract_ids"] == ["A", "C", "B"]
    assert row["top1_in_expected"] is True
    assert row["all_expected_hit"] is True
    assert row["expected_hit_count"] == 2
    assert row["set_recall"] == 1.0
    assert row["set_precision"] == pytest.approx(2 / 3)
    assert row["set_f1"] == pytest.approx(0.8)


def test_summarize_groups_by_category():
    rows = [
        {"category": "find_all", "top1_in_expected": True, "all_expected_hit": True,
         "set_recall": 1.0, "set_precision": 0.5, "set_f1": 2 / 3},
        {"category": "find_all", "top1_in_expected": False, "all_expected_hit": False,
         "set_recall": 0.0, "set_precision": 0.0, "set_f1": 0.0},
        {"category": "negative_exclusion", "top1_in_expected": True, "all_expected_hit": True,
         "set_recall": 1.0, "set_precision": 1.0, "set_f1": 1.0},
    ]

    summary = rcc._summarize(rows)

    assert summary["overall"]["n_cases"] == 3
    assert summary["overall"]["set_recall"] == pytest.approx(2 / 3)
    assert summary["by_category"]["find_all"]["n_cases"] == 2
    assert summary["by_category"]["find_all"]["top1_in_expected_rate"] == 0.5
    assert summary["by_category"]["negative_exclusion"]["set_precision"] == 1.0


def test_main_writes_report(monkeypatch, tmp_path):
    closed = {"value": False}
    cases = [{
        "id": "q1",
        "category": "negative_exclusion",
        "question": "propane",
        "expected_contract_ids": ["JSUS2024059"],
        "note": "n",
    }]
    dataset = tmp_path / "cross.jsonl"
    dataset.write_text("\n".join(json.dumps(c) for c in cases), encoding="utf-8")

    monkeypatch.setattr(rcc, "_REPORTS", tmp_path)
    monkeypatch.setattr(rcc, "_preflight", lambda cases: None)
    monkeypatch.setattr(rcc, "retrieve", lambda q, **kw: [_doc("JSUS2024059")])
    monkeypatch.setattr(rcc.vector_store, "close_client", lambda: closed.update(value=True))

    rcc.main(["--dataset", str(dataset)])

    reports = [p for p in tmp_path.glob("*.json") if p.name != dataset.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "cross-contract-retrieval-sets"
    assert report["summary"]["overall"]["set_recall"] == 1.0
    assert report["cases"][0]["all_expected_hit"] is True
    assert closed["value"] is True
