"""Turn user 👍/👎 feedback into gold-eval candidates (STUB, TDD).

Pure transforms used by ``scripts/feedback_to_gold.py``. A 👎 means "the system
got this wrong" — a candidate *regression* case — but the user's vote is a
signal, NOT ground truth: each candidate is emitted with an empty ``ground_truth``
for a human to fill after fixing, never auto-merged into the gold set.
"""
from __future__ import annotations


def question_for(assistant_message_id: str, messages: list[dict]) -> str:
    """The user question this assistant message answered: the nearest preceding
    ``user`` turn in the ordered conversation. ``""`` if not found."""
    last_user = ""
    for m in messages:
        if m.get("role") == "user":
            last_user = m.get("content") or ""
        elif m.get("message_id") == assistant_message_id:
            return last_user
    return ""


def to_gold_candidate(feedback: dict, question: str) -> dict:
    """A reviewable gold candidate from one feedback row. ``ground_truth`` is left
    empty on purpose — a human fills it after fixing; the user's vote is signal,
    not truth."""
    evidence = feedback.get("evidence") or []
    contract_id = next((e.get("contract_id") for e in evidence if e.get("contract_id")), "")
    return {
        "question": question,
        "ground_truth": "",
        "contract_id": contract_id,
        "score": feedback.get("score"),
        "answer_was": feedback.get("answer", ""),
        "comment": feedback.get("comment") or "",
        "note": "from user feedback; verify and fill ground_truth before adding to gold",
    }
