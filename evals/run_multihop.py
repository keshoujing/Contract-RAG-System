"""Baseline the CURRENT agent on hard multi-hop / analytical questions.

The reactive tool-loop has no query planner and ``query_ledger`` can't aggregate
(no max / min / sort / count) — so "largest / smallest / earliest contract" and
multi-hop "X of the largest contract" should land on the wrong contract or thrash
to the round cap and abstain. This measures how badly, to justify (or not)
building plan-and-execute (and/or adding aggregation to the structured tool).

Metrics (objective; no LLM judge for grounding):
  target_recall     fraction of the question's expected contract(s) cited
  target_precision  fraction of cited contracts that were expected (anti-dump)
  target_f1         harmonic mean of the two (headline)
  answer_similarity cos(embed(answer), embed(reference)) where a reference exists
  tool_rounds       agent tool-calling rounds (thrash signal)

Run (live Gemini + Weaviate; needs the 100-contract corpus loaded):
    .venv/bin/python -m evals.run_multihop                # 1 run/case
    .venv/bin/python -m evals.run_multihop --repeats 3    # denoise
"""
from __future__ import annotations

import argparse
import functools
import json
import pathlib

from contract_rag.llm import LLM
from contract_rag.retrieval.agent import answer_with_evidence
from contract_rag.storage import vector_store
from evals.metrics import answer_similarity
from evals.multihop import evidence_contract_ids, target_f1, target_precision, target_recall
from evals.report import write_report

_DATA = pathlib.Path(__file__).parent / "dataset_multihop.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _run_once(case, embed) -> dict:
    res = answer_with_evidence(case["question"], temperature=0)
    returned = evidence_contract_ids(res.evidence)
    expected = case["expected_contract_ids"]
    gt = case.get("ground_truth") or ""
    return {
        "recall": target_recall(expected, returned),
        "precision": target_precision(expected, returned),
        "f1": target_f1(expected, returned),
        "answer_similarity": answer_similarity(res.answer, gt, embed) if gt else None,
        "tool_rounds": res.diagnostics.get("tool_rounds"),
        "returned": returned,
        "answer": res.answer,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=1, help="runs per case (denoise)")
    args = parser.parse_args()

    cases = [json.loads(l) for l in _DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    embed = functools.lru_cache(maxsize=None)(LLM().get_embedding_object().embed_query)

    rows = []
    try:
        for c in cases:
            runs = [_run_once(c, embed) for _ in range(args.repeats)]
            row = {
                "id": c["id"], "kind": c["kind"],
                "recall": _mean(r["recall"] for r in runs),
                "precision": _mean(r["precision"] for r in runs),
                "f1": _mean(r["f1"] for r in runs),
                "answer_similarity": _mean(r["answer_similarity"] for r in runs),
                "tool_rounds": _mean(r["tool_rounds"] for r in runs),
                "expected": c["expected_contract_ids"],
                "sample_returned": runs[-1]["returned"],
                "sample_answer": runs[-1]["answer"],
            }
            rows.append(row)
            print(f"[f1={row['f1']:.2f} r={row['recall']:.2f} p={row['precision']:.2f}] "
                  f"{row['id']:<22} rounds~{row['tool_rounds']:.1f}", flush=True)
    finally:
        vector_store.close_client()

    summary = {
        "n_cases": len(rows), "repeats": args.repeats,
        "f1_mean": round(_mean(r["f1"] for r in rows), 3),
        "recall_mean": round(_mean(r["recall"] for r in rows), 3),
        "precision_mean": round(_mean(r["precision"] for r in rows), 3),
        "answer_similarity_mean": round(_mean(r["answer_similarity"] for r in rows) or 0, 3),
        "tool_rounds_mean": round(_mean(r["tool_rounds"] for r in rows), 2),
    }
    out = write_report({"experiment": "multihop-baseline", "summary": summary, "cases": rows},
                       out_dir=_REPORTS)

    print(f"\n=== multi-hop baseline (current agent, n={len(rows)}, repeats={args.repeats}) ===")
    for k, v in summary.items():
        print(f"  {k:<24} {v}")
    print("\nper-case f1 (by kind):")
    for r in sorted(rows, key=lambda x: x["f1"]):
        print(f"  f1={r['f1']:.2f}  {r['kind']:<22} {r['id']}")
    print(f"\n[report] {out}")


if __name__ == "__main__":
    main()
