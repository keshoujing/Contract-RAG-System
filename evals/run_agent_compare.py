"""Agent vs one-shot RAG comparison on the 2026004 gold set — RESUMABLE.

Two arms (oneshot, agent), each scored on synchronous embedding metrics
(answer_similarity + retrieval_coverage) — NOT ragas evaluate(), which hangs on
this Vertex async stack (see memory/retrieval_eval.md). Default single pass to
see signal; ``--repeats N`` runs each arm N times and adds mean±std +
significance (reusing evals/compare.py).

Each (arm, repeat) is cached to evals/reports/_agent_compare_cache.json the
moment it finishes, so a killed process only loses the in-flight cell. Run in
your own terminal (background tasks get killed here):

    .venv/bin/python -m evals.run_agent_compare              # single pass
    .venv/bin/python -m evals.run_agent_compare --repeats 3  # x3 + significance
"""
from __future__ import annotations

import argparse
import functools
import json
import pathlib
import sys

from contract_rag.llm import LLM
from contract_rag.retrieval.graph import answer_with_sources, agent_answer_with_sources
from contract_rag.storage import vector_store
from evals.compare import aggregate_runs, is_significant
from evals.dataset import load_dataset
from evals.metrics import answer_similarity, retrieval_coverage
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_2026004.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CACHE = _REPORTS / "_agent_compare_cache.json"
_CONTRACT_ID = "2026004"
_ARMS = ("oneshot", "agent")
_WINNER_METRIC = "answer_similarity"


def _embed_fn():
    return LLM().get_embedding_object().embed_query


def _preflight() -> None:
    try:
        n = vector_store.count_contract(_CONTRACT_ID)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if n == 0:
        sys.exit(f"[preflight] no chunks for {_CONTRACT_ID} — ingest the corpus first.")
    print(f"[preflight] {n} chunks for {_CONTRACT_ID} — OK")


def _load_cache() -> dict:
    return json.loads(_CACHE.read_text(encoding="utf-8")) if _CACHE.exists() else {}


def _save_cache(cache: dict) -> None:
    _REPORTS.mkdir(parents=True, exist_ok=True)
    _CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _llm_calls(arm: str, question_class: str, iterations: int) -> int:
    """Approximate LLM-call count (cost proxy). oneshot = classify + 1 generation.
    agent clause = classify + per-round sufficiency + rewrites + generate; the
    round that hits MAX_REWRITES skips its sufficiency call, so this slightly
    over-counts at the cap. See plan note."""
    if arm == "oneshot":
        return 2
    if question_class in ("entity", "comparison"):
        return 2
    return 3 + 2 * max(iterations - 1, 0)


def _run_arm(arm: str, cases, embed) -> dict:
    fn = answer_with_sources if arm == "oneshot" else agent_answer_with_sources
    sims, covs, iters, calls = [], [], [], []
    for c in cases:
        res = fn(c.question, contract_id=c.contract_id, temperature=0)
        sims.append(answer_similarity(res.answer, c.ground_truth, embed))
        covs.append(retrieval_coverage(c.ground_truth, res.contexts, embed))
        it = res.diagnostics.get("iterations", 0)
        iters.append(it)
        calls.append(_llm_calls(arm, res.question_class, it))
    n = len(cases)
    return {
        "answer_similarity": sum(sims) / n,
        "retrieval_coverage": sum(covs) / n,
        "mean_iterations": sum(iters) / n,
        "llm_calls": sum(calls),
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=1,
                    help="run each arm N times; N>=2 adds mean±std + significance")
    ap.add_argument("--max-runs", type=int, default=10_000,
                    help="run at most N pending (arm,repeat) cells this invocation")
    ap.add_argument("--reset", action="store_true", help="discard cache and start over")
    args = ap.parse_args(argv)

    if args.reset and _CACHE.exists():
        _CACHE.unlink()

    _preflight()
    cases = load_dataset(_DATASET)
    if not cases:
        sys.exit("[error] gold dataset is empty")
    embed = functools.lru_cache(maxsize=None)(_embed_fn())
    cache = _load_cache()
    ran = 0

    for rep in range(args.repeats):
        for arm in _ARMS:
            key = f"{arm}:{rep}"
            if key in cache:
                continue
            if ran >= args.max_runs:
                done = len(cache)
                print(f"[pause] budget {args.max_runs} spent; {done} cell(s) cached. Re-run to continue.")
                return
            print(f"[run] {key}")
            cache[key] = _run_arm(arm, cases, embed)
            _save_cache(cache)
            ran += 1

    # all cells cached -> assemble report
    by_arm_runs = {arm: [cache[f"{arm}:{r}"] for r in range(args.repeats)] for arm in _ARMS}
    arms = {arm: aggregate_runs(runs) if args.repeats > 1 else runs[0]
            for arm, runs in by_arm_runs.items()}
    report = {
        "experiment": "agent-vs-oneshot",
        "contract_id": _CONTRACT_ID,
        "n_cases": len(cases),
        "repeats": args.repeats,
        "winner_metric": _WINNER_METRIC,
        "arms": arms,
    }
    if args.repeats > 1:
        report["agent_significant_vs_oneshot"] = is_significant(
            by_arm_runs["agent"], by_arm_runs["oneshot"], metric=_WINNER_METRIC)

    out = write_report(report, out_dir=_REPORTS)

    print("\n=== agent vs oneshot ===")
    for arm in _ARMS:
        print(f"  {arm:8s} {arms[arm]}")
    if args.repeats > 1:
        print(f"agent significant vs oneshot ({_WINNER_METRIC}): "
              f"{report['agent_significant_vs_oneshot']}")
    print(f"[agent-compare] report written: {out}")


if __name__ == "__main__":
    main()
