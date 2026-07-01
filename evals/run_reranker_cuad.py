"""Reranker A/B on the 100-contract CUAD corpus (the headroom re-test).

The 4-contract test (memory/retrieval_eval.md §8) found no reranker gain because
cov@5 ≈ cov@20 (recall saturated — no headroom). This re-runs the same comparison
on a real 100-contract / 6.5k-chunk corpus with an expert-annotated gold set, to
see whether a bigger corpus finally gives the reranker something to do.

Per case (scoped to the gold contract): pull its k=20 hybrid candidates once, then
  off      : top-5 in hybrid order  (ships today)
  on       : top-5 after reranker.rerank()
  ceiling  : all 20 (headroom probe — if off ≈ ceiling, no room to gain)
Metric: retrieval_coverage = max cos(embed(ground_truth span), embed(context)).
Sync embedding (memoized), no ragas async.

    .venv/bin/python -m evals.run_reranker_cuad
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

from contract_rag.llm import LLM
from contract_rag.retrieval import reranker
from contract_rag.retrieval.graph import retrieve
from contract_rag.storage import vector_store
from evals.metrics import retrieval_coverage

_DATA = pathlib.Path(__file__).parent / "dataset_cuad_gold.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_K = 20
_TOP_N = 5
_HEADROOM_EPS = 0.02  # cov@20 exceeds cov@5 by this -> the right clause was beyond top-5


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def _memoized_embed():
    raw = LLM().get_embedding_object().embed_query
    cache: dict[str, list] = {}

    def embed(text: str):
        if text not in cache:
            cache[text] = raw(text)
        return cache[text]

    return embed


def main() -> None:
    embed = _memoized_embed()
    cases = [json.loads(l) for l in _DATA.read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = []
    for i, c in enumerate(cases, 1):
        q, gt = c["question"], c["ground_truth"]
        cid = c["expected_contract_ids"][0]
        candidates = retrieve(q, contract_id=cid, k=_K, top_n=_K, use_reranker=False)
        if not candidates:
            continue
        baseline = candidates[:_TOP_N]
        reranked = reranker.rerank(q, candidates, top_n=_TOP_N)
        cov_off = retrieval_coverage(gt, [d.page_content for d in baseline], embed)
        cov_on = retrieval_coverage(gt, [d.page_content for d in reranked], embed)
        cov_ceil = retrieval_coverage(gt, [d.page_content for d in candidates], embed)
        rows.append((cov_off, cov_on, cov_ceil))
        if i % 25 == 0:
            print(f"  ...{i}/{len(cases)} cov@5 off={_mean(r[0] for r in rows):.3f} on={_mean(r[1] for r in rows):.3f}")

    n = len(rows)
    summary = {
        "n_cases": n,
        "cov5_off": round(_mean(r[0] for r in rows), 4),
        "cov5_on": round(_mean(r[1] for r in rows), 4),
        "cov20_ceiling": round(_mean(r[2] for r in rows), 4),
        "delta_on_minus_off": round(_mean(r[1] - r[0] for r in rows), 4),
        "headroom_cases": sum(1 for r in rows if r[2] - r[0] > _HEADROOM_EPS),
        "reranker_closed_headroom": sum(1 for r in rows if r[2] - r[0] > _HEADROOM_EPS and r[1] - r[0] > _HEADROOM_EPS),
    }
    _REPORTS.mkdir(exist_ok=True)
    ts = dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")
    out = _REPORTS / f"reranker_cuad_{ts}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("=" * 70)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"report -> {out}")
    vector_store.close_client()


if __name__ == "__main__":
    main()
