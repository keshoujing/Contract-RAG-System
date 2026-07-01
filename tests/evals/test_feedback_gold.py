"""Feedback → gold-candidate transforms (pure)."""
from evals import feedback_gold as fg


def test_question_for_returns_preceding_user_message():
    messages = [
        {"message_id": "u1", "role": "user", "content": "What are the payment terms?"},
        {"message_id": "a1", "role": "assistant", "content": "Net 30."},
    ]
    assert fg.question_for("a1", messages) == "What are the payment terms?"


def test_question_for_uses_nearest_preceding_user_turn():
    messages = [
        {"message_id": "u1", "role": "user", "content": "Q1"},
        {"message_id": "a1", "role": "assistant", "content": "A1"},
        {"message_id": "u2", "role": "user", "content": "Q2"},
        {"message_id": "a2", "role": "assistant", "content": "A2"},
    ]
    assert fg.question_for("a2", messages) == "Q2"


def test_question_for_missing_returns_empty():
    assert fg.question_for("zzz", []) == ""


def test_to_gold_candidate_pulls_contract_and_marks_for_review():
    feedback = {"score": "down", "answer": "wrong answer", "comment": "amount is wrong",
                "evidence": [{"kind": "record", "contract_id": "2026002"}]}
    c = fg.to_gold_candidate(feedback, "What is the amount?")
    assert c["question"] == "What is the amount?"
    assert c["contract_id"] == "2026002"
    assert c["ground_truth"] == ""        # human fills after fixing — vote != truth
    assert c["score"] == "down"
    assert c["answer_was"] == "wrong answer"
    assert c["comment"] == "amount is wrong"
