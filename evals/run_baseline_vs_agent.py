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

import argparse
import contextlib
import functools
import json
import pathlib
import signal
import sys
from collections.abc import Callable

from contract_rag.llm import LLM
from contract_rag.retrieval.agent import answer_with_evidence
from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import db, vector_store
from evals.metrics import answer_similarity, retrieval_coverage
from evals.report import write_report

_DATA = pathlib.Path(__file__).parent / "dataset_sql_gated_agent.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CACHE = _REPORTS / "_baseline_vs_agent_cache.json"
_ARMS = ("baseline", "agent")


class CaseTimeout(TimeoutError):
    """Raised when one live eval arm exceeds the per-case timeout."""


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


def _embed_fn():
    return LLM().get_embedding_object().embed_query


def _load_cache() -> dict:
    cache = json.loads(_CACHE.read_text(encoding="utf-8")) if _CACHE.exists() else {}
    return {k: _normalize_payload(v) for k, v in cache.items()}


def _save_cache(cache: dict) -> None:
    _REPORTS.mkdir(parents=True, exist_ok=True)
    _CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


@contextlib.contextmanager
def _time_limit(seconds: int | None):
    if not seconds or seconds <= 0:
        yield
        return

    def _handler(_signum, _frame):
        raise CaseTimeout(f"case timed out after {seconds}s")

    previous = signal.getsignal(signal.SIGALRM)
    signal.signal(signal.SIGALRM, _handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _run_with_timeout(fn: Callable[[], dict], seconds: int | None) -> dict:
    with _time_limit(seconds):
        return fn()


def _is_timeout_error(exc: Exception | str | None) -> bool:
    if isinstance(exc, CaseTimeout):
        return True
    text = str(exc or "").lower()
    return "timed out" in text or "timeout" in text


def _normalize_payload(payload: dict) -> dict:
    if payload.get("error") and not payload.get("timed_out"):
        payload = dict(payload)
        payload["timed_out"] = _is_timeout_error(payload.get("error"))
    return payload


def _error_payload(exc: Exception) -> dict:
    return {
        "answer_similarity": 0.0,
        "empty_answer": True,
        "retrieval_coverage": 0.0,
        "top1_expected": False,
        "all_expected_hit": False,
        "source_precision": 0.0,
        "contracts": [],
        "error": str(exc),
        "timed_out": _is_timeout_error(exc),
        "tool_rounds": 0,
    }


def _run_baseline_case(q: str, gt: str, exp: list[str], embed) -> dict:
    res = answer_with_sources(q, temperature=0, use_reranker=False)
    contracts, contexts = _baseline_views(res)
    scores = _scores(res.answer, gt, contexts, contracts, exp, embed)
    return {**scores, "contracts": _distinct(contracts), "timed_out": False}


def _run_agent_case(q: str, gt: str, exp: list[str], embed) -> dict:
    res = answer_with_evidence(q, temperature=0)
    contracts, contexts = _agent_views(res)
    scores = _scores(res.answer, gt, contexts, contracts, exp, embed)
    return {
        **scores,
        "contracts": _distinct(contracts),
        "tool_rounds": res.diagnostics.get("tool_rounds", 0),
        "timed_out": False,
    }


def _cache_key(case: dict, arm: str) -> str:
    return f"{case['id']}:{arm}"


def _preflight_expected_ids(cases: list[dict]) -> None:
    corpus_ids = {str(row.get("contract_id")) for row in db.list_contracts()}
    expected_ids = {
        str(contract_id)
        for case in cases
        for contract_id in case.get("expected_contract_ids", [])
    }
    missing = sorted(expected_ids - corpus_ids)
    if missing:
        sample = ", ".join(missing[:10])
        suffix = "" if len(missing) <= 10 else f", ... ({len(missing)} total)"
        sys.exit(
            "[preflight] dataset expected contract IDs are not in the current "
            f"SQLite ledger: {sample}{suffix}. Load the matching corpus or update the dataset."
        )


def _case_arm_payload(case: dict, arm: str, embed, timeout: int | None) -> dict:
    q, gt, exp = case["question"], case["ground_truth"], case["expected_contract_ids"]
    fn = _run_baseline_case if arm == "baseline" else _run_agent_case
    try:
        return _normalize_payload(_run_with_timeout(lambda: fn(q, gt, exp, embed), timeout))
    except Exception as exc:  # noqa: BLE001 - errors are eval outcomes here
        return _error_payload(exc)


def _rows_from_cache(cases: list[dict], cache: dict) -> list[dict]:
    rows = []
    for case in cases:
        row = {
            "id": case["id"],
            "question": case["question"],
            "expected": case["expected_contract_ids"],
        }
        for arm in _ARMS:
            row[arm] = cache.get(_cache_key(case, arm), _error_payload(
                RuntimeError("missing cached result")
            ))
        rows.append(row)
    return rows


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--case-timeout", type=int, default=180,
                    help="seconds before one case arm is recorded as timed out; <=0 disables")
    ap.add_argument("--reset", action="store_true", help="discard cache and start over")
    args = ap.parse_args(argv)

    if args.reset and _CACHE.exists():
        _CACHE.unlink()

    cases = [json.loads(l) for l in _DATA.read_text().splitlines() if l.strip()]
    _preflight_expected_ids(cases)
    embed = functools.lru_cache(maxsize=None)(_embed_fn())
    cache = _load_cache()

    try:
        for case in cases:
            for arm in _ARMS:
                key = _cache_key(case, arm)
                if key in cache:
                    continue
                print(f"[run] {case['id']}:{arm}", flush=True)
                cache[key] = _case_arm_payload(case, arm, embed, args.case_timeout)
                _save_cache(cache)
                if cache[key].get("timed_out"):
                    print(f"[timeout] {case['id']}:{arm} {cache[key].get('error')}", flush=True)
                elif cache[key].get("error"):
                    print(f"[error] {case['id']}:{arm} {cache[key].get('error')}", flush=True)
                else:
                    print(f"[done] {case['id']}:{arm}", flush=True)
    finally:
        vector_store.close_client()

    rows = _rows_from_cache(cases, cache)

    def agg(arm, key):
        return _mean(float(r[arm][key]) for r in rows)

    base_keys = ("answer_similarity", "retrieval_coverage", "top1_expected",
                 "all_expected_hit", "source_precision", "empty_answer")
    summary = {
        "n_cases": len(rows),
        "baseline": {**{k: agg("baseline", k) for k in base_keys},
                     "timeout_rate": agg("baseline", "timed_out")},
        "agent": {**{k: agg("agent", k) for k in base_keys},
                  "timeout_rate": agg("agent", "timed_out"),
                  "tool_rounds": agg("agent", "tool_rounds")},
    }
    out = write_report({"experiment": "baseline-vs-agent", "summary": summary, "cases": rows},
                       out_dir=_REPORTS)

    print("\n=== baseline vs agent (n=%d) ===" % len(rows))
    cols = list(base_keys)
    print(f"{'metric':<20} {'baseline':>10} {'agent':>10}")
    for k in cols:
        print(f"{k:<20} {summary['baseline'][k]:>10.3f} {summary['agent'][k]:>10.3f}")
    print(f"{'timeout_rate':<20} {summary['baseline']['timeout_rate']:>10.3f} {summary['agent']['timeout_rate']:>10.3f}")
    print(f"{'tool_rounds':<20} {'-':>10} {summary['agent']['tool_rounds']:>10.3f}")
    print(f"\n[report] {out}")


if __name__ == "__main__":
    main()
