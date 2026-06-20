"""Open-corpus retrieval evaluation over the multi-contract local index.

This runner measures retrieval only: no answer generation, no LLM judge. It asks
queries without ``contract_id`` and checks whether the expected contract appears
in the top-k results. It also computes synchronous embedding coverage against
the gold answer, both over all retrieved contexts and over contexts from the
expected contract only.

    .venv/bin/python -m evals.run_open_retrieval
"""
from __future__ import annotations

import argparse
import functools
import pathlib
import sys

from langchain_core.documents import Document

from contract_rag.llm import LLM
from contract_rag.retrieval.graph import retrieve
from contract_rag.storage import vector_store
from evals.dataset import GoldCase, load_dataset
from evals.metrics import retrieval_coverage
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_open_retrieval.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"


def _embed_fn():
    return LLM().get_embedding_object().embed_query


def _mean(values) -> float:
    vals = list(values)
    return sum(vals) / len(vals) if vals else 0.0


def _preflight(cases: list[GoldCase]) -> None:
    missing = {}
    try:
        for cid in sorted({c.contract_id for c in cases}):
            n = vector_store.count_contract(cid)
            if n == 0:
                missing[cid] = n
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if missing:
        sys.exit(f"[preflight] missing indexed chunks for contract(s): {sorted(missing)}")
    print(f"[preflight] {len(set(c.contract_id for c in cases))} contract(s) indexed — OK")


def _contract_ids(docs: list[Document]) -> list[str]:
    return [str((d.metadata or {}).get("contract_id") or "") for d in docs]


def _score_case(case: GoldCase, docs: list[Document], embed) -> dict:
    contracts = _contract_ids(docs)
    top_contract = contracts[0] if contracts else None
    expected_contexts = [
        d.page_content for d in docs
        if str((d.metadata or {}).get("contract_id") or "") == case.contract_id
    ]
    rank = None
    for i, cid in enumerate(contracts, 1):
        if cid == case.contract_id:
            rank = i
            break
    contexts = [d.page_content for d in docs]
    return {
        "question": case.question,
        "expected_contract_id": case.contract_id,
        "top_contract_id": top_contract,
        "retrieved_contract_ids": contracts,
        "top1_contract_match": top_contract == case.contract_id,
        "contract_hit": rank is not None,
        "expected_contract_rank": rank,
        "retrieval_coverage": retrieval_coverage(case.ground_truth, contexts, embed),
        "expected_contract_coverage": retrieval_coverage(case.ground_truth, expected_contexts, embed),
        "note": case.note,
    }


def _summarize(rows: list[dict]) -> dict:
    hit_ranks = [r["expected_contract_rank"] for r in rows if r["expected_contract_rank"] is not None]
    return {
        "n_cases": len(rows),
        "top1_contract_accuracy": _mean(1.0 if r["top1_contract_match"] else 0.0 for r in rows),
        "contract_hit_rate": _mean(1.0 if r["contract_hit"] else 0.0 for r in rows),
        "mean_expected_contract_rank": _mean(hit_ranks),
        "retrieval_coverage": _mean(r["retrieval_coverage"] for r in rows),
        "expected_contract_coverage": _mean(r["expected_contract_coverage"] for r in rows),
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=str(_DATASET), help="open-retrieval JSONL dataset")
    ap.add_argument("--top-n", type=int, default=5, help="number of retrieved chunks to score")
    args = ap.parse_args(argv)

    cases = load_dataset(args.dataset)
    if not cases:
        sys.exit("[error] gold dataset is empty")
    _preflight(cases)
    embed = functools.lru_cache(maxsize=None)(_embed_fn())

    try:
        rows = []
        for c in cases:
            docs = retrieve(c.question, top_n=args.top_n, use_reranker=False)
            rows.append(_score_case(c, docs, embed))

        report = {
            "experiment": "open-corpus-retrieval",
            "dataset": pathlib.Path(args.dataset).name,
            "top_n": args.top_n,
            "summary": _summarize(rows),
            "cases": rows,
        }
        out = write_report(report, out_dir=_REPORTS)

        print("\n=== open-corpus retrieval ===")
        for k, v in report["summary"].items():
            print(f"  {k}: {v}")
        misses = [r for r in rows if not r["contract_hit"]]
        if misses:
            print("\nmisses:")
            for r in misses:
                print(f"  expected={r['expected_contract_id']} top={r['top_contract_id']} q={r['question']}")
        print(f"[open-retrieval] report written: {out}")
    finally:
        vector_store.close_client()


if __name__ == "__main__":
    main()
