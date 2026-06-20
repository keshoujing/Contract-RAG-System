"""Resume / max-runs logic for the grid runner (mocks all live calls)."""
import json

from evals import run_grid
from evals.dataset import GoldCase


def _setup(monkeypatch, tmp_path):
    """Point the runner at a tmp cache/reports dir and stub every live dependency."""
    monkeypatch.setattr(run_grid, "_REPORTS", tmp_path)
    monkeypatch.setattr(run_grid, "_CACHE", tmp_path / "_grid_cache.json")
    monkeypatch.setattr(run_grid, "_preflight", lambda: None)
    monkeypatch.setattr(run_grid, "build_judge", lambda: (None, None))
    monkeypatch.setattr(run_grid, "default_run_config", lambda: None)
    monkeypatch.setattr(run_grid, "load_dataset",
                        lambda _p: [GoldCase("q", "a", "2026004")])

    calls = []

    def _fake_run_config(cases, *, alpha, use_reranker, metrics, judge, run_config, counter):
        calls.append((alpha, use_reranker))
        # constant scores: clears recall floor, ties resolved to first config
        return {"semantic_similarity": 0.5, "context_recall": 0.85}

    monkeypatch.setattr(run_grid, "_run_config", _fake_run_config)
    return calls


def test_max_runs_caps_invocation(monkeypatch, tmp_path):
    calls = _setup(monkeypatch, tmp_path)
    run_grid.main(["--reset", "--max-runs", "2"])
    assert len(calls) == 2  # only 2 config-runs this invocation
    cache = json.loads((tmp_path / "_grid_cache.json").read_text())
    assert sum(1 for k in cache if k != "_tokens") == 2


def test_resume_skips_cached(monkeypatch, tmp_path):
    calls = _setup(monkeypatch, tmp_path)
    run_grid.main(["--reset", "--max-runs", "2"])
    run_grid.main(["--max-runs", "2"])  # resume
    assert len(calls) == 4  # 2 fresh + 2 more, none repeated
    cache = json.loads((tmp_path / "_grid_cache.json").read_text())
    assert sum(1 for k in cache if k != "_tokens") == 4


def test_full_run_writes_report(monkeypatch, tmp_path):
    calls = _setup(monkeypatch, tmp_path)
    run_grid.main(["--reset"])  # no budget cap -> run everything
    # phase1 alpha sweep (3 configs) + phase2 (baseline x3 + winner x3) = 9 config-runs
    # (reranker arm dropped — it OOMs on long chunks)
    assert len(calls) == 9
    reports = [p for p in tmp_path.glob("*.json") if p.name != "_grid_cache.json"]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "retrieval-tuning"
    assert report["winner_metric"] == "semantic_similarity"
    assert "winner_metric_significant" in report
