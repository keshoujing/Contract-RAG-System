"""Reranker A/B: does the Vertex Ranking API improve retrieval over hybrid-only?

Isolates the reranker (retrieval only, NO answer generation): for each gold query
it pulls the k=20 hybrid candidates ONCE, then compares three views of them —
  off      : top-5 in hybrid order (= what ships today, use_reranker=false)
  on       : top-5 after reranker.rerank() over the same 20
  ceiling  : all 20 (headroom probe — if off ≈ ceiling there's no room to gain,
             so a reranker can't help no matter how good it is)

Metrics (mean over cases):
  retrieval_coverage   max cos(embed(ground_truth), embed(context))
  contract recall@5    |expected ∩ contracts(top-5)| / |expected|

Sync embedding only (no ragas async — see memory/retrieval_eval.md). Open
retrieval (no contract scoping) so it's a fair test of ranking quality alone.

Run (live Gemini + Weaviate + Ranking API):
    .venv/bin/python -m evals.run_reranker_compare
"""
from __future__ import annotations

import json
import pathlib

from contract_rag.llm import LLM
from contract_rag.retrieval import reranker
from contract_rag.retrieval.graph import retrieve
from contract_rag.storage import vector_store
from evals.metrics import retrieval_coverage

_DATA = pathlib.Path(__file__).parent / "dataset_sql_gated_agent.jsonl"
_K = 20
_TOP_N = 5


def _mean(xs):
    xs = list(xs)
    return sum(xs) / len(xs) if xs else 0.0


def _load():
    out = []
    for line in _DATA.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _memoized_embed():
    """One embed call per unique text (gemini-embedding-2 forces batch_size=1)."""
    raw = LLM().get_embedding_object().embed_query
    cache: dict[str, list] = {}

    def embed(text: str):
        if text not in cache:
            cache[text] = raw(text)
        return cache[text]

    return embed


def _contracts(docs):
    return [str((d.metadata or {}).get("contract_id") or "") for d in docs]


def _recall(docs, expected):
    exp = set(expected)
    return len(set(_contracts(docs)) & exp) / len(exp) if exp else 0.0


def main():
    embed = _memoized_embed()
    rows = []
    print(f"{'id':<32}{'cov@5 off':>11}{'cov@5 on':>10}{'cov@20':>9}{'Δcov':>8}   rec@5 off→on")
    print("-" * 90)
    for c in _load():
        q, gt = c["question"], c["ground_truth"]
        expected = c.get("expected_contract_ids", [])
        candidates = retrieve(q, k=_K, top_n=_K, use_reranker=False)  # 20 hybrid
        baseline = candidates[:_TOP_N]
        reranked = reranker.rerank(q, candidates, top_n=_TOP_N)
        cov_off = retrieval_coverage(gt, [d.page_content for d in baseline], embed)
        cov_on = retrieval_coverage(gt, [d.page_content for d in reranked], embed)
        cov_ceil = retrieval_coverage(gt, [d.page_content for d in candidates], embed)
        rec_off, rec_on = _recall(baseline, expected), _recall(reranked, expected)
        rows.append((cov_off, cov_on, cov_ceil, rec_off, rec_on))
        print(f"{c['id']:<32}{cov_off:>11.3f}{cov_on:>10.3f}{cov_ceil:>9.3f}"
              f"{cov_on - cov_off:>+8.3f}   {rec_off:.2f}→{rec_on:.2f}")
    print("-" * 90)
    print(f"{'MEAN':<32}{_mean(r[0] for r in rows):>11.3f}{_mean(r[1] for r in rows):>10.3f}"
          f"{_mean(r[2] for r in rows):>9.3f}{_mean(r[1] - r[0] for r in rows):>+8.3f}"
          f"   {_mean(r[3] for r in rows):.2f}→{_mean(r[4] for r in rows):.2f}")
    vector_store.close_client()


if __name__ == "__main__":
    main()
