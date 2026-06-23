"""Export user-feedback answers as reviewable gold candidates (flywheel close).

Reads persisted 👍/👎 (``db.list_feedback``), pairs each with its question, and
writes candidates to ``evals/feedback_candidates.jsonl`` for a human to triage.
Defaults to 👎 only — those are the regression cases worth chasing. The output is
NOT a gold set: ``ground_truth`` is blank by design; fix the answer, fill it, then
merge the keepers into ``evals/dataset_*.jsonl``.

    .venv/bin/python -m scripts.feedback_to_gold            # 👎 only
    .venv/bin/python -m scripts.feedback_to_gold --all      # 👍 and 👎
"""
from __future__ import annotations

import argparse
import json
import pathlib

from contract_rag.storage import db
from evals.feedback_gold import question_for, to_gold_candidate

_OUT = pathlib.Path(__file__).resolve().parent.parent / "evals" / "feedback_candidates.jsonl"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--all", action="store_true", help="include 👍 (default: 👎 only)")
    args = parser.parse_args()

    messages_by_conv: dict[str, list[dict]] = {}
    candidates = []
    for fb in db.list_feedback():
        if not args.all and fb.get("score") != "down":
            continue
        conv = fb["conversation_id"]
        if conv not in messages_by_conv:
            messages_by_conv[conv] = db.get_conversation_messages(conv)
        question = question_for(fb["message_id"], messages_by_conv[conv])
        candidates.append(to_gold_candidate(fb, question))

    _OUT.write_text(
        "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in candidates),
        encoding="utf-8",
    )
    print(f"[feedback->gold] wrote {len(candidates)} candidate(s) -> {_OUT}")
    print("review, fix the answer, fill ground_truth, then merge keepers into evals/dataset_*.jsonl")


if __name__ == "__main__":
    main()
