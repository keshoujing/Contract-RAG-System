"""Resume / max-runs / report logic for the agent-vs-oneshot runner (all live calls mocked)."""
import json

from evals import run_agent_compare as rac
from evals.dataset import GoldCase
from contract_rag.retrieval.graph import RAGResult


def _setup(monkeypatch, tmp_path):
    monkeypatch.setattr(rac, "_REPORTS", tmp_path)
    monkeypatch.setattr(rac, "_CACHE", tmp_path / "_agent_compare_cache.json")
    monkeypatch.setattr(rac, "_preflight", lambda: None)
    monkeypatch.setattr(rac, "load_dataset",
                        lambda _p: [GoldCase("What are the payment terms?", "Net 30 days.", "2026004")])
    # deterministic embed: identical text -> sim 1.0
    monkeypatch.setattr(rac, "_embed_fn", lambda: (lambda t: [1.0, 0.0]))

    monkeypatch.setattr(rac, "answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}]))
    monkeypatch.setattr(rac, "agent_answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}], {"iterations": 1}))


def test_max_runs_caps_invocation(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    rac.main(["--reset", "--max-runs", "1"])     # only 1 of the 2 arms this call
    cache = json.loads((tmp_path / "_agent_compare_cache.json").read_text())
    assert len(cache) == 1


def test_resume_then_report(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    rac.main(["--reset", "--max-runs", "1"])     # arm 1
    rac.main(["--max-runs", "1"])                # arm 2 -> both cached -> report
    reports = [p for p in tmp_path.glob("*.json") if "cache" not in p.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "agent-vs-oneshot"
    assert report["arms"]["oneshot"]["answer_similarity"] == 1.0
    assert report["arms"]["agent"]["answer_similarity"] == 1.0
    assert report["arms"]["agent"]["mean_iterations"] == 1.0


def test_llm_calls_cost_proxy():
    assert rac._llm_calls("oneshot", "clause", 0) == 2
    assert rac._llm_calls("oneshot", "entity", 0) == 2
    assert rac._llm_calls("agent", "entity", 0) == 2
    assert rac._llm_calls("agent", "clause", 1) == 3
    assert rac._llm_calls("agent", "clause", 2) == 5


def test_repeats_adds_significance(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    rac.main(["--reset", "--repeats", "2"])
    reports = [p for p in tmp_path.glob("*.json") if "cache" not in p.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["repeats"] == 2
    assert "agent_significant_vs_oneshot" in report
    # aggregate_runs -> (mean, std) serialized as [mean, std]; constant 1.0 -> [1.0, 0.0]
    assert report["arms"]["agent"]["answer_similarity"] == [1.0, 0.0]
