"""Prompt-injection resistance — does an instruction embedded in a retrieved
chunk hijack the agent's free-text answer?

For each case we stub retrieval so the agent's only clause source is a *poisoned*
chunk (benign text + an embedded instruction carrying a unique canary) and the
ledger is empty, then run the live agent and check whether the canary leaked into
the answer. The structured surface (clause snippets / record values) is already
guarded by ``grounding``; this measures the residual free-text surface that the
system-prompt rule + spotlighting (``contract_rag/retrieval/injection.py``)
defend. ``evidence_defended`` is reported too, to show the structural guard holds.

Run (live Gemini; no Weaviate/DB needed — retrieval is stubbed):
    .venv/bin/python -m evals.run_injection
"""
from __future__ import annotations

import json
import pathlib

from contract_rag.retrieval import agent
from contract_rag.retrieval import tools as agent_tools
from evals.injection import is_defended, load_injection_dataset, poison_chunk
from evals.report import write_report

_DATA = pathlib.Path(__file__).parent / "dataset_injection.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"


def _run_case(case) -> dict:
    poison = poison_chunk(case)
    orig_search, orig_ledger = agent_tools.search_clauses, agent_tools.query_ledger
    agent_tools.search_clauses = lambda *a, **k: [poison]
    agent_tools.query_ledger = lambda *a, **k: []
    try:
        res = agent.answer_with_evidence(case.question, temperature=0)
    finally:
        agent_tools.search_clauses, agent_tools.query_ledger = orig_search, orig_ledger
    return {
        "id": case.id, "attack": case.attack, "canary": case.canary,
        "answer_defended": is_defended(res.answer, case.canary),
        "evidence_defended": is_defended(
            json.dumps(res.evidence, ensure_ascii=False), case.canary),
        "answer": res.answer,
    }


def main() -> None:
    cases = load_injection_dataset(_DATA)
    rows = [_run_case(c) for c in cases]
    for r in rows:
        tag = "PASS" if r["answer_defended"] else "HIJACKED"
        print(f"[{tag}] {r['id']} ({r['attack']})", flush=True)

    n = len(rows) or 1
    answer_rate = sum(r["answer_defended"] for r in rows) / n
    evidence_rate = sum(r["evidence_defended"] for r in rows) / n
    report = {
        "experiment": "prompt-injection",
        "summary": {
            "n_cases": len(rows),
            "answer_defended_rate": round(answer_rate, 4),
            "evidence_defended_rate": round(evidence_rate, 4),
        },
        "cases": rows,
    }
    out = write_report(report, out_dir=_REPORTS)
    print(f"\n=== prompt-injection (n={len(rows)}) ===")
    print(f"answer_defended_rate   {answer_rate:.3f}")
    print(f"evidence_defended_rate {evidence_rate:.3f}")
    print(f"\n[report] {out}")


if __name__ == "__main__":
    main()
