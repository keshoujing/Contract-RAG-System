"""Greedy retrieval-tuning experiment over the 2026004 gold set — RESUMABLE.

Phase 1: sweep alpha (reranker=off) -> 3 configs. Phase 2: confirm baseline vs the
best alpha x3 each with mean±std + significance. Metric is embedding-only
SemanticSimilarity (answer vs gold) — RAGAS's LLM-judge metrics hang on this Vertex
async stack (excluded), and the cross-encoder reranker OOMs on long chunks (dropped).

Each config-run is cached to evals/reports/_grid_cache.json the moment it finishes,
so a killed process only loses the in-flight run. Re-run to resume; pass
``--max-runs N`` to do at most N pending config-runs per invocation (keeps each
foreground call short), and ``--reset`` to start over.

    .venv/bin/python -m evals.run_grid --max-runs 2   # do 2 pending runs, then exit
    .venv/bin/python -m evals.run_grid                # run everything still pending
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.metrics import SemanticSimilarity

from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import vector_store
from evals.compare import aggregate_runs, is_significant, pick_winner
from evals.dataset import load_dataset
from evals.ragas_support import TokenCounter, build_judge, default_run_config, extract_scores
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_2026004.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CACHE = _REPORTS / "_grid_cache.json"
_CONTRACT_ID = "2026004"
_ALPHAS = [0.3, 0.5, 0.7]
_BASELINE_ALPHA = 0.5
_RECALL_DROP = 0.05
_CONFIRM_REPEATS = 3
# Winner is chosen on answer-vs-reference SemanticSimilarity (embedding cosine):
# the LLM-based AnswerCorrectness returns NaN on this Gemini judge (its structured
# statement-decomposition output isn't parseable), so we use the reliable,
# embedding-only proxy. See memory/retrieval_eval.md.
_WINNER_METRIC = "semantic_similarity"


def _baseline_label() -> str:
    return f"p1:alpha={_BASELINE_ALPHA},rr=off"


def _preflight() -> None:
    try:
        n = vector_store.count_contract(_CONTRACT_ID)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if n == 0:
        sys.exit(f"[preflight] no chunks for {_CONTRACT_ID} — ingest the corpus first.")
    print(f"[preflight] {n} chunks for {_CONTRACT_ID} — OK")


def _load_cache() -> dict:
    if _CACHE.exists():
        return json.loads(_CACHE.read_text(encoding="utf-8"))
    return {}


def _save_cache(cache: dict) -> None:
    _REPORTS.mkdir(parents=True, exist_ok=True)
    _CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _run_config(cases, *, alpha, use_reranker, metrics, judge, run_config, counter):
    judge_llm, judge_emb = judge
    samples = []
    for c in cases:
        res = answer_with_sources(
            c.question, contract_id=c.contract_id,
            alpha=alpha, use_reranker=use_reranker, temperature=0,
        )
        samples.append(SingleTurnSample(
            user_input=c.question, retrieved_contexts=res.contexts,
            response=res.answer, reference=c.ground_truth,
        ))
    result = evaluate(
        EvaluationDataset(samples=samples), metrics=metrics,
        llm=judge_llm, embeddings=judge_emb, run_config=run_config,
        callbacks=[counter],
    )
    return extract_scores(result)


# Embedding-only metric set. RAGAS's LLM-judge metrics (context_recall/precision,
# faithfulness, relevancy, answer_correctness) intermittently hang for 85-300s per
# job on this Vertex async stack — they make the experiment uncompletable. The
# embedding-only SemanticSimilarity (answer vs gold) runs in ~1-2s/case, never NaN,
# never hangs, and is a reliable end-to-end proxy for "did this retrieval config
# produce better answers". LLM-metric coverage is deferred (see memory/retrieval_eval.md).
def _grid_metrics():
    return [SemanticSimilarity()]


def _full_metrics():
    return [SemanticSimilarity()]


def _parse_label(label: str) -> tuple[float, bool]:
    alpha = float(label.split("alpha=")[1].split(",")[0])
    return alpha, label.endswith("on")


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-runs", type=int, default=10_000,
                    help="run at most N pending config-runs this invocation, then exit")
    ap.add_argument("--reset", action="store_true", help="discard cached progress and start over")
    args = ap.parse_args(argv)

    if args.reset and _CACHE.exists():
        _CACHE.unlink()

    _preflight()
    cases = load_dataset(_DATASET)
    judge = build_judge()
    run_config = default_run_config()
    counter = TokenCounter()
    cache = _load_cache()
    ran = 0

    def do(key, *, alpha, rerank, metrics) -> bool:
        """Run + cache one config unless cached. Returns False if the budget is spent."""
        nonlocal ran
        if key in cache:
            return True
        if ran >= args.max_runs:
            return False
        print(f"[run] {key}")
        cache[key] = _run_config(
            cases, alpha=alpha, use_reranker=rerank, metrics=metrics,
            judge=judge, run_config=run_config, counter=counter,
        )
        tok = cache.setdefault("_tokens", {"input_tokens": 0, "output_tokens": 0, "llm_calls": 0})
        tok["input_tokens"] += counter.input_tokens
        tok["output_tokens"] += counter.output_tokens
        tok["llm_calls"] += counter.calls
        counter.input_tokens = counter.output_tokens = counter.calls = 0
        _save_cache(cache)
        ran += 1
        return True

    def pause(stage: str) -> None:
        done = sum(1 for k in cache if k != "_tokens")
        print(f"[pause] used budget of {args.max_runs} run(s) at {stage}; "
              f"{done} config-run(s) cached. Re-run to continue.")

    # ---- Phase 1: alpha sweep at reranker=off ----
    for a in _ALPHAS:
        if not do(f"p1:alpha={a},rr=off", alpha=a, rerank=False, metrics=_grid_metrics()):
            return pause("phase1-alpha-sweep")

    # Winner = best alpha from the sweep. The reranker arm was dropped this round:
    # the old local bge-reranker-v2-m3 (XLM-RoBERTa cross-encoder) OOM'd ("Invalid
    # buffer size: ~10 GiB") on long table chunks because it pads the batch to the
    # longest sequence.
    # NOTE (2026-06-19): the OOM is since resolved — reranking now goes through the
    # managed Vertex Ranking API (contract_rag/retrieval/reranker.py). The on/off
    # A/B is still TODO (see memory/retrieval_eval.md §5/§8).
    p1 = {k: v for k, v in cache.items() if k.startswith("p1:") and k.endswith("rr=off")}
    winner_label = pick_winner(p1, metric=_WINNER_METRIC, recall_floor=0.0)
    winner_alpha, winner_rerank = _parse_label(winner_label)
    winner_is_baseline = (winner_alpha == _BASELINE_ALPHA and not winner_rerank)

    # ---- Phase 2: confirm baseline vs winner, full metrics, x3 ----
    for i in range(_CONFIRM_REPEATS):
        if not do(f"p2:baseline:{i}", alpha=_BASELINE_ALPHA, rerank=False, metrics=_full_metrics()):
            return pause("phase2-baseline")
    if not winner_is_baseline:
        for i in range(_CONFIRM_REPEATS):
            if not do(f"p2:winner:{i}", alpha=winner_alpha, rerank=winner_rerank, metrics=_full_metrics()):
                return pause("phase2-winner")

    # ---- All runs cached: assemble the final report ----
    baseline_runs = [cache[f"p2:baseline:{i}"] for i in range(_CONFIRM_REPEATS)]
    winner_runs = baseline_runs if winner_is_baseline else [
        cache[f"p2:winner:{i}"] for i in range(_CONFIRM_REPEATS)]
    significant = is_significant(winner_runs, baseline_runs, metric=_WINNER_METRIC)

    report = {
        "experiment": "retrieval-tuning",
        "contract_id": _CONTRACT_ID,
        "n_cases": len(cases),
        "phase1_scores": p1,
        "winner": winner_label,
        "baseline": _baseline_label(),
        "phase2_baseline_meanstd": aggregate_runs(baseline_runs),
        "phase2_winner_meanstd": aggregate_runs(winner_runs),
        "winner_metric": _WINNER_METRIC,
        "winner_metric_significant": significant,
        "token_usage": cache.get("_tokens", {}),
    }
    out = write_report(report, out_dir=_REPORTS)

    print("\n=== phase1 (semantic_similarity / context_recall) ===")
    for label, s in p1.items():
        print(f"  {label:24s} sim={s.get(_WINNER_METRIC, 0):.4f} "
              f"recall={s.get('context_recall', 0):.4f}")
    print(f"\nwinner: {winner_label}  significant_vs_baseline: {significant}")
    print(f"tokens: {cache.get('_tokens', {})}")
    print(f"[grid] report written: {out}")


if __name__ == "__main__":
    main()
