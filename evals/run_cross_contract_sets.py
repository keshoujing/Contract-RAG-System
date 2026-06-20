"""Cross-contract retrieval-set evaluation over the local multi-contract index.

This runner asks queries whose expected answer is a set of contract IDs. It does
not generate answers or call an LLM judge; it measures whether open retrieval
returns the expected contract set in top-N chunks.

    .venv/bin/python -m evals.run_cross_contract_sets --top-n 10
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import defaultdict

from langchain_core.documents import Document

from contract_rag.retrieval.graph import retrieve
from contract_rag.storage import vector_store
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_cross_contract_sets.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"


def _load_cases(path: str | pathlib.Path) -> list[dict]:
    cases = []
    for lineno, line in enumerate(pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        missing = [k for k in ("id", "category", "question", "expected_contract_ids") if not row.get(k)]
        if missing:
            raise ValueError(f"line {lineno}: missing required field(s): {', '.join(missing)}")
        row["expected_contract_ids"] = list(dict.fromkeys(str(x) for x in row["expected_contract_ids"]))
        row["note"] = row.get("note", "")
        cases.append(row)
    return cases


def _preflight(cases: list[dict]) -> None:
    expected_ids = sorted({cid for c in cases for cid in c["expected_contract_ids"]})
    missing = {}
    try:
        for cid in expected_ids:
            n = vector_store.count_contract(cid)
            if n == 0:
                missing[cid] = n
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if missing:
        sys.exit(f"[preflight] missing indexed chunks for contract(s): {sorted(missing)}")
    print(f"[preflight] {len(expected_ids)} expected contract(s) indexed — OK")


def _unique_contract_ids(docs: list[Document]) -> list[str]:
    out = []
    seen = set()
    for d in docs:
        cid = str((d.metadata or {}).get("contract_id") or "")
        if cid and cid not in seen:
            seen.add(cid)
            out.append(cid)
    return out


def _f1(precision: float, recall: float) -> float:
    return 0.0 if precision == 0.0 and recall == 0.0 else 2 * precision * recall / (precision + recall)


def _score_case(case: dict, docs: list[Document]) -> dict:
    expected = set(case["expected_contract_ids"])
    retrieved = _unique_contract_ids(docs)
    retrieved_set = set(retrieved)
    hits = expected & retrieved_set
    recall = len(hits) / len(expected)
    precision = len(hits) / len(retrieved_set) if retrieved_set else 0.0
    return {
        "id": case["id"],
        "category": case["category"],
        "question": case["question"],
        "expected_contract_ids": case["expected_contract_ids"],
        "retrieved_contract_ids": retrieved,
        "top1_contract_id": retrieved[0] if retrieved else None,
        "top1_in_expected": bool(retrieved and retrieved[0] in expected),
        "all_expected_hit": expected <= retrieved_set,
        "expected_hit_count": len(hits),
        "set_recall": recall,
        "set_precision": precision,
        "set_f1": _f1(precision, recall),
        "note": case.get("note", ""),
    }


def _mean(values) -> float:
    vals = list(values)
    return sum(vals) / len(vals) if vals else 0.0


def _summary_block(rows: list[dict]) -> dict:
    return {
        "n_cases": len(rows),
        "top1_in_expected_rate": _mean(1.0 if r["top1_in_expected"] else 0.0 for r in rows),
        "all_expected_hit_rate": _mean(1.0 if r["all_expected_hit"] else 0.0 for r in rows),
        "set_recall": _mean(r["set_recall"] for r in rows),
        "set_precision": _mean(r["set_precision"] for r in rows),
        "set_f1": _mean(r["set_f1"] for r in rows),
    }


def _summarize(rows: list[dict]) -> dict:
    grouped = defaultdict(list)
    for r in rows:
        grouped[r["category"]].append(r)
    return {
        "overall": _summary_block(rows),
        "by_category": {k: _summary_block(v) for k, v in sorted(grouped.items())},
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(_DATASET), help="cross-contract JSONL dataset")
    ap.add_argument("--top-n", type=int, default=10, help="number of retrieved chunks to score")
    args = ap.parse_args(argv)

    cases = _load_cases(args.dataset)
    if not cases:
        sys.exit("[error] dataset is empty")
    _preflight(cases)

    try:
        rows = []
        for c in cases:
            docs = retrieve(c["question"], top_n=args.top_n, use_reranker=False)
            rows.append(_score_case(c, docs))

        report = {
            "experiment": "cross-contract-retrieval-sets",
            "dataset": pathlib.Path(args.dataset).name,
            "top_n": args.top_n,
            "summary": _summarize(rows),
            "cases": rows,
        }
        out = write_report(report, out_dir=_REPORTS)

        print("\n=== cross-contract retrieval sets ===")
        for k, v in report["summary"]["overall"].items():
            print(f"  {k}: {v}")
        misses = [r for r in rows if not r["all_expected_hit"]]
        if misses:
            print("\nset misses:")
            for r in misses:
                print(
                    f"  {r['id']} expected={r['expected_contract_ids']} "
                    f"retrieved={r['retrieved_contract_ids']} q={r['question']}"
                )
        print(f"[cross-contract] report written: {out}")
    finally:
        vector_store.close_client()


if __name__ == "__main__":
    main()
