"""SQL-gated agent-vs-baseline runner logic (all live calls mocked)."""
import json

from contract_rag.retrieval.graph import RAGResult
from evals import run_sql_gated_agent_compare as rsga


def _res(question, *, qclass="clause", answer="Net 30 days.", contexts=None, sources=None, diagnostics=None):
    return RAGResult(
        question,
        qclass,
        answer,
        contexts if contexts is not None else ["Net 30 days."],
        sources if sources is not None else [{"contract_id": "2026004"}],
        diagnostics or {},
    )


def test_score_case_tracks_expected_sources_and_precision(monkeypatch):
    case = {
        "id": "q1",
        "question": "Which contracts mention 30 days?",
        "ground_truth": "2026004 mentions Net 30 days.",
        "expected_contract_ids": ["2026004"],
    }
    embed = lambda text: [1.0, 0.0]

    monkeypatch.setattr(rsga, "answer_with_sources", lambda q, **kw: _res(
        q,
        sources=[{"contract_id": "2026004"}, {"contract_id": "2026002"}],
    ))

    row = rsga._score_case(case, "baseline", embed)

    assert row["source_contract_ids"] == ["2026004", "2026002"]
    assert row["top1_expected"] is True
    assert row["all_expected_hit"] is True
    assert row["expected_hit_count"] == 1
    assert row["source_precision"] == 0.5
    assert row["llm_calls_est"] == 2


def test_summary_groups_by_arm_and_includes_precision():
    rows = [
        {"arm": "baseline", "answer_similarity": 0.5, "retrieval_coverage": 0.0,
         "top1_expected": True, "all_expected_hit": True, "source_precision": 0.25,
         "llm_calls_est": 2, "iterations": 0},
        {"arm": "agent", "answer_similarity": 0.9, "retrieval_coverage": 0.8,
         "top1_expected": True, "all_expected_hit": True, "source_precision": 1.0,
         "llm_calls_est": 3, "iterations": 1},
    ]

    summary = rsga._summary(rows)

    assert summary["baseline"]["n_cases"] == 1
    assert summary["baseline"]["source_precision"] == 0.25
    assert summary["agent"]["retrieval_coverage"] == 0.8
    assert summary["agent"]["mean_iterations"] == 1.0


def test_main_writes_report(monkeypatch, tmp_path):
    closed = {"value": False}
    dataset = tmp_path / "sql_agent.jsonl"
    dataset.write_text(json.dumps({
        "id": "q1",
        "question": "What are ChemAqua's payment terms?",
        "ground_truth": "Net 30 days.",
        "expected_contract_ids": ["2026004"],
    }) + "\n", encoding="utf-8")

    monkeypatch.setattr(rsga, "_REPORTS", tmp_path)
    monkeypatch.setattr(rsga, "_preflight", lambda cases: None)
    monkeypatch.setattr(rsga, "_embed_fn", lambda: (lambda text: [1.0, 0.0]))
    monkeypatch.setattr(rsga, "answer_with_sources", lambda q, **kw: _res(q))
    monkeypatch.setattr(rsga, "agent_answer_with_sources", lambda q, **kw: _res(
        q,
        diagnostics={"iterations": 1, "used_sql_gate": True},
    ))
    monkeypatch.setattr(rsga.vector_store, "close_client", lambda: closed.update(value=True))

    rsga.main(["--dataset", str(dataset)])

    reports = [p for p in tmp_path.glob("*.json") if p.name != dataset.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "sql-gated-agent-vs-baseline"
    assert report["summary"]["baseline"]["top1_expected_rate"] == 1.0
    assert report["summary"]["agent"]["mean_iterations"] == 1.0
    assert closed["value"] is True
