"""Run RAGAS evaluation over the gold dataset and write a timestamped report.

Requires a live Weaviate with the contract corpus ingested. Hits Vertex Gemini
for both answer generation and the RAGAS judge. Not a unit test — run manually:

    .venv/bin/python -m evals.run_eval
"""
from __future__ import annotations

import pathlib
import sys

from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.metrics import (
    Faithfulness,
    LLMContextPrecisionWithReference,
    LLMContextRecall,
    ResponseRelevancy,
    AnswerCorrectness,
)

from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import vector_store
from evals.dataset import load_dataset
from evals.ragas_support import build_judge, default_run_config, extract_scores
from evals.report import build_report, write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_2026004.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CONTRACT_ID = "2026004"


def _preflight() -> None:
    try:
        n = vector_store.count_contract(_CONTRACT_ID)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if n == 0:
        sys.exit(f"[preflight] no chunks for {_CONTRACT_ID} in Weaviate — ingest the corpus first.")
    print(f"[preflight] {n} chunks for {_CONTRACT_ID} in Weaviate — OK")


def main() -> None:
    _preflight()
    cases = load_dataset(_DATASET)
    print(f"[eval] {len(cases)} gold cases")

    samples = []
    for c in cases:
        res = answer_with_sources(c.question, contract_id=c.contract_id)
        samples.append(SingleTurnSample(
            user_input=c.question,
            retrieved_contexts=res.contexts,
            response=res.answer,
            reference=c.ground_truth,
        ))
    dataset = EvaluationDataset(samples=samples)

    metrics = [
        LLMContextRecall(),
        LLMContextPrecisionWithReference(),
        Faithfulness(),
        ResponseRelevancy(),
        AnswerCorrectness(),
    ]
    judge_llm, judge_emb = build_judge()
    result = evaluate(
        dataset, metrics=metrics, llm=judge_llm, embeddings=judge_emb,
        run_config=default_run_config(),
    )
    scores = extract_scores(result)

    print("\n=== RAGAS scores ===")
    for k, v in scores.items():
        print(f"  {k:32s} {v:.4f}")

    report = build_report(
        dataset=_DATASET.name, contract_id=_CONTRACT_ID,
        n_cases=len(cases), scores=scores,
    )
    out = write_report(report, out_dir=_REPORTS)
    print(f"\n[eval] report written: {out}")


if __name__ == "__main__":
    main()
