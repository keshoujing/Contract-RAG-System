import json

from evals.report import build_report, write_report


def test_build_report_shape():
    rep = build_report(
        dataset="dataset_2026004.jsonl", contract_id="2026004", n_cases=10,
        scores={"context_recall": 0.9, "faithfulness": 0.85},
    )
    assert rep["dataset"] == "dataset_2026004.jsonl"
    assert rep["contract_id"] == "2026004"
    assert rep["n_cases"] == 10
    assert rep["scores"]["context_recall"] == 0.9
    assert "timestamp" in rep


def test_write_report_writes_json(tmp_path):
    rep = {"dataset": "d", "scores": {"faithfulness": 0.8}}
    out = write_report(rep, out_dir=tmp_path)
    assert out.exists()
    assert json.loads(out.read_text(encoding="utf-8"))["scores"]["faithfulness"] == 0.8
    assert out.suffix == ".json"
