"""Baseline (one-shot RAG) vs Agentic (tool-calling) on the open question set.

Baseline : graph.answer_with_sources(q, temperature=0, use_reranker=False)
Agentic  : agent.answer_with_evidence(q, temperature=0)   # the live endpoint
Dataset  : evals/dataset_sql_gated_agent.jsonl

Metrics (per arm, mean over cases):
  answer_similarity    cos(embed(answer), embed(ground_truth))
  retrieval_coverage   max cos(embed(ground_truth), embed(snippet/context))
  top1_expected_rate   first returned contract in expected_contract_ids
  all_expected_hit     all expected ids present in returned contracts
  source_precision     |hit expected| / |distinct returned contracts|
  tool_rounds          agent only — tool-calling rounds (diagnostics)

Run (live Gemini + Weaviate):
    .venv/bin/python -m evals.run_baseline_vs_agent
"""
from __future__ import annotations

import functools
import json
import pathlib

from contract_rag.llm import LLM
from contract_rag.retrieval.agent import answer_with_evidence
from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import vector_store
from evals.metrics import answer_similarity, retrieval_coverage
from evals.report import write_report

_DATA = pathlib.Path(__file__).parent / "dataset_sql_gated_agent.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def _distinct(ids):
    return [c for c in dict.fromkeys(c for c in ids if c)]


def _scores(answer, gt, contexts, contracts, expected, embed):
    distinct = _distinct(contracts)
    hit = set(distinct) & set(expected)
    return {
        "answer_similarity": answer_similarity(answer, gt, embed) if (answer or "").strip() else 0.0,
        "empty_answer": not (answer or "").strip(),
        "retrieval_coverage": retrieval_coverage(gt, contexts, embed),
        "top1_expected": bool(contracts and contracts[0] in expected),
        "all_expected_hit": set(expected) <= set(distinct),
        "source_precision": (len(hit) / len(distinct)) if distinct else 0.0,
    }


def _nonempty(xs):
    return [x for x in xs if x and x.strip()]


def _baseline_views(res):
    contracts = [str(s.get("contract_id") or "") for s in res.sources]
    contexts = list(res.contexts) or [s.get("content", "") for s in res.sources]
    return contracts, _nonempty(contexts)


def _agent_views(res):
    contracts = [str(e.get("contract_id") or "") for e in res.evidence]
    contexts = [
        e.get("snippet", "") if e.get("kind") == "clause"
        else json.dumps(e.get("fields", {}), ensure_ascii=False)
        for e in res.evidence
    ]
    return contracts, _nonempty(contexts)


def main() -> None:
    cases = [json.loads(l) for l in _DATA.read_text().splitlines() if l.strip()]
    embed = functools.lru_cache(maxsize=None)(LLM().get_embedding_object().embed_query)

    rows = []
    try:
        for c in cases:
            q, gt, exp = c["question"], c["ground_truth"], c["expected_contract_ids"]

            b = answer_with_sources(q, temperature=0, use_reranker=False)
            bc, bx = _baseline_views(b)
            bs = _scores(b.answer, gt, bx, bc, exp, embed)

            a = answer_with_evidence(q, temperature=0)
            ac, ax = _agent_views(a)
            as_ = _scores(a.answer, gt, ax, ac, exp, embed)
            as_["tool_rounds"] = a.diagnostics.get("tool_rounds", 0)

            rows.append({"id": c["id"], "question": q, "expected": exp,
                         "baseline": {**bs, "contracts": _distinct(bc)},
                         "agent": {**as_, "contracts": _distinct(ac)}})
            print(f"[done] {c['id']}", flush=True)
    finally:
        vector_store.close_client()

    def agg(arm, key):
        return _mean(float(r[arm][key]) for r in rows)

    base_keys = ("answer_similarity", "retrieval_coverage", "top1_expected",
                 "all_expected_hit", "source_precision", "empty_answer")
    summary = {
        "n_cases": len(rows),
        "baseline": {k: agg("baseline", k) for k in base_keys},
        "agent": {**{k: agg("agent", k) for k in base_keys},
                  "tool_rounds": agg("agent", "tool_rounds")},
    }
    out = write_report({"experiment": "baseline-vs-agent", "summary": summary, "cases": rows},
                       out_dir=_REPORTS)

    print("\n=== baseline vs agent (n=%d) ===" % len(rows))
    cols = list(base_keys)
    print(f"{'metric':<20} {'baseline':>10} {'agent':>10}")
    for k in cols:
        print(f"{k:<20} {summary['baseline'][k]:>10.3f} {summary['agent'][k]:>10.3f}")
    print(f"{'tool_rounds':<20} {'-':>10} {summary['agent']['tool_rounds']:>10.3f}")
    print(f"\n[report] {out}")


if __name__ == "__main__":
    main()
