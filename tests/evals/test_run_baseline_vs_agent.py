"""Resume / timeout logic for baseline-vs-agent eval runner (all live calls mocked)."""
import json

from contract_rag.retrieval.agent import EvidenceResult
from contract_rag.retrieval.graph import RAGResult
from evals import run_baseline_vs_agent as rbva


def _setup(monkeypatch, tmp_path):
    dataset = tmp_path / "dataset.jsonl"
    dataset.write_text(
        json.dumps({
            "id": "q1",
            "question": "What are the payment terms?",
            "ground_truth": "Net 30 days.",
            "expected_contract_ids": ["2026004"],
        }) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(rbva, "_DATA", dataset)
    monkeypatch.setattr(rbva, "_REPORTS", tmp_path)
    monkeypatch.setattr(rbva, "_CACHE", tmp_path / "_baseline_vs_agent_cache.json")
    monkeypatch.setattr(rbva, "_embed_fn", lambda: (lambda text: [1.0, 0.0]))
    monkeypatch.setattr(rbva.db, "list_contracts", lambda: [{"contract_id": "2026004"}])
    monkeypatch.setattr(rbva.vector_store, "close_client", lambda: None)


def test_main_caches_each_arm_and_writes_report(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(rbva, "answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}],
    ))
    monkeypatch.setattr(rbva, "answer_with_evidence", lambda q, **kw: EvidenceResult(
        q, "Net 30 days.",
        [{"kind": "clause", "contract_id": "2026004", "snippet": "Net 30 days."}],
        {"tool_rounds": 1},
    ))

    rbva.main(["--reset"])

    cache = json.loads((tmp_path / "_baseline_vs_agent_cache.json").read_text())
    assert sorted(cache) == ["q1:agent", "q1:baseline"]
    reports = [p for p in tmp_path.glob("*.json") if "cache" not in p.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "baseline-vs-agent"
    assert report["summary"]["agent"]["timeout_rate"] == 0.0
    assert report["summary"]["agent"]["tool_rounds"] == 1.0


def test_timeout_is_cached_and_reported(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    monkeypatch.setattr(rbva, "answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}],
    ))

    def _fake_agent_case(*_args, **_kwargs):
        raise rbva.CaseTimeout("case timed out after 1s")

    monkeypatch.setattr(rbva, "_run_agent_case", _fake_agent_case)
    rbva.main(["--reset", "--case-timeout", "1"])

    cache = json.loads((tmp_path / "_baseline_vs_agent_cache.json").read_text())
    assert cache["q1:agent"]["timed_out"] is True
    reports = [p for p in tmp_path.glob("*.json") if "cache" not in p.name]
    report = json.loads(reports[0].read_text())
    assert report["summary"]["agent"]["timeout_rate"] == 1.0
    assert report["cases"][0]["agent"]["error"] == "case timed out after 1s"


def test_timeout_text_is_classified_as_timeout():
    payload = rbva._error_payload(RuntimeError("case timed out after 180s"))
    assert payload["timed_out"] is True


def test_preflight_rejects_expected_ids_missing_from_current_corpus(monkeypatch):
    monkeypatch.setattr(rbva.db, "list_contracts", lambda: [{"contract_id": "A"}])
    try:
        rbva._preflight_expected_ids([
            {"id": "q1", "expected_contract_ids": ["A", "MISSING"]},
        ])
        assert False, "expected SystemExit"
    except SystemExit as exc:
        assert "MISSING" in str(exc)
