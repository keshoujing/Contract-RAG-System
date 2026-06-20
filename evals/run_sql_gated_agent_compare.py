"""Compare baseline one-shot RAG vs SQL-gated agentic RAG on open queries.

Unlike ``run_agent_compare``, this runner intentionally does NOT pass a
contract_id. The point is to measure whether the agent can use SQLite metadata
to narrow Weaviate retrieval by file_no / contract_number / supplier / amount.

    .venv/bin/python -m evals.run_sql_gated_agent_compare
"""
from __future__ import annotations

import argparse
import functools
import json
import pathlib
import signal
import sys

from contract_rag.llm import LLM
from contract_rag.retrieval.graph import answer_with_sources, agent_answer_with_sources
from contract_rag.storage import vector_store
from evals.metrics import answer_similarity, retrieval_coverage
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_sql_gated_agent.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_ARMS = ("baseline", "agent")


class CaseTimeout(RuntimeError):
    pass


def _timeout_handler(_signum, _frame):
    raise CaseTimeout("case timed out")


def _embed_fn():
    return LLM().get_embedding_object().embed_query


def _load_cases(path: str | pathlib.Path) -> list[dict]:
    cases = []
    for lineno, line in enumerate(pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        missing = [k for k in ("id", "question", "ground_truth", "expected_contract_ids") if not row.get(k)]
        if missing:
            raise ValueError(f"line {lineno}: missing required field(s): {', '.join(missing)}")
        row["expected_contract_ids"] = list(dict.fromkeys(str(x) for x in row["expected_contract_ids"]))
        cases.append(row)
    return cases


def _preflight(cases: list[dict]) -> None:
    missing = []
    for cid in sorted({cid for c in cases for cid in c["expected_contract_ids"]}):
        if vector_store.count_contract(cid) == 0:
            missing.append(cid)
    if missing:
        sys.exit(f"[preflight] missing indexed chunks for contract(s): {missing}")
    print(f"[preflight] {len(set(cid for c in cases for cid in c['expected_contract_ids']))} expected contract(s) indexed — OK")


def _source_contract_ids(res) -> list[str]:
    out = []
    seen = set()
    for s in res.sources:
        cid = str(s.get("contract_id") or "")
        if cid and cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def _score_case(case: dict, arm: str, embed) -> dict:
    fn = answer_with_sources if arm == "baseline" else agent_answer_with_sources
    res = fn(case["question"], temperature=0, use_reranker=False)
    expected = set(case["expected_contract_ids"])
    got = _source_contract_ids(res)
    got_set = set(got)
    iterations = res.diagnostics.get("iterations", 0)
    expected_hits = len(expected & got_set)
    return {
        "id": case["id"],
        "arm": arm,
        "question": case["question"],
        "question_class": res.question_class,
        "answer": res.answer,
        "answer_similarity": answer_similarity(res.answer, case["ground_truth"], embed),
        "retrieval_coverage": retrieval_coverage(case["ground_truth"], res.contexts, embed),
        "expected_contract_ids": case["expected_contract_ids"],
        "source_contract_ids": got,
        "top1_expected": bool(got and got[0] in expected),
        "all_expected_hit": expected <= got_set,
        "expected_hit_count": expected_hits,
        "source_precision": expected_hits / len(got_set) if got_set else 0.0,
        "iterations": iterations,
        "llm_calls_est": _llm_calls(arm, res.question_class, iterations),
        "diagnostics": res.diagnostics,
    }


def _llm_calls(arm: str, question_class: str, iterations: int) -> int:
    if arm == "baseline":
        return 2
    if question_class in ("entity", "comparison") and iterations == 0:
        return 2
    return 3 + 2 * max(iterations - 1, 0)


def _mean(rows: list[dict], key: str) -> float:
    return sum(float(r[key]) for r in rows) / len(rows) if rows else 0.0


def _summary(rows: list[dict]) -> dict:
    by_arm = {}
    for arm in _ARMS:
        arm_rows = [r for r in rows if r["arm"] == arm]
        by_arm[arm] = {
            "n_cases": len(arm_rows),
            "answer_similarity": _mean(arm_rows, "answer_similarity"),
            "retrieval_coverage": _mean(arm_rows, "retrieval_coverage"),
            "top1_expected_rate": _mean(arm_rows, "top1_expected"),
            "all_expected_hit_rate": _mean(arm_rows, "all_expected_hit"),
            "source_precision": _mean(arm_rows, "source_precision"),
            "llm_calls_est": sum(r["llm_calls_est"] for r in arm_rows),
            "mean_iterations": _mean(arm_rows, "iterations"),
        }
    return by_arm


def _score_case_with_timeout(case: dict, arm: str, embed, timeout_s: int) -> dict:
    if timeout_s <= 0:
        return _score_case(case, arm, embed)
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
    signal.alarm(timeout_s)
    try:
        return _score_case(case, arm, embed)
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(_DATASET))
    ap.add_argument("--case-timeout", type=int, default=180,
                    help="seconds before a single arm/case is interrupted; <=0 disables")
    args = ap.parse_args(argv)

    cases = _load_cases(args.dataset)
    if not cases:
        sys.exit("[error] dataset is empty")
    _preflight(cases)
    embed = functools.lru_cache(maxsize=None)(_embed_fn())

    try:
        rows = []
        for c in cases:
            for arm in _ARMS:
                print(f"[run] {arm}:{c['id']}", flush=True)
                rows.append(_score_case_with_timeout(c, arm, embed, args.case_timeout))
        report = {
            "experiment": "sql-gated-agent-vs-baseline",
            "dataset": pathlib.Path(args.dataset).name,
            "n_cases": len(cases),
            "summary": _summary(rows),
            "cases": rows,
        }
        out = write_report(report, out_dir=_REPORTS)
        print("\n=== SQL-gated agent vs baseline ===")
        for arm, stats in report["summary"].items():
            print(f"  {arm:8s} {stats}")
        print(f"[sql-agent-compare] report written: {out}")
    finally:
        vector_store.close_client()


if __name__ == "__main__":
    main()
