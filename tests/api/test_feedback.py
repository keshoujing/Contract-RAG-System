"""Q&A answer feedback — DB layer (store run_id, upsert thumbs, join for gold).

The route + LangSmith integration are tested further down with a TestClient.
"""
import pytest

from contract_rag.storage import db


@pytest.fixture
def dbp(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    return p


def _assistant_msg(dbp, *, run_id="run-1"):
    cid = db.create_conversation(db_path=dbp)["conversation_id"]
    db.append_conversation_message(cid, role="user", content="What are the payment terms?", db_path=dbp)
    a = db.append_conversation_message(
        cid, role="assistant", content="Net 30.",
        evidence=[{"kind": "clause", "contract_id": "c1"}],
        run_id=run_id, db_path=dbp,
    )
    return cid, a["message_id"]


def test_assistant_message_stores_run_id(dbp):
    cid, _ = _assistant_msg(dbp, run_id="run-xyz")
    assert db.get_conversation_messages(cid, db_path=dbp)[1]["run_id"] == "run-xyz"


def test_add_feedback_persists_and_returns_run_id(dbp):
    cid, mid = _assistant_msg(dbp, run_id="run-xyz")
    fb = db.add_message_feedback(mid, "up", db_path=dbp)
    assert fb["run_id"] == "run-xyz"
    assert fb["score"] == "up"
    assert db.get_conversation_messages(cid, db_path=dbp)[1]["feedback"] == "up"


def test_revote_replaces_feedback(dbp):
    _, mid = _assistant_msg(dbp)
    db.add_message_feedback(mid, "up", db_path=dbp)
    db.add_message_feedback(mid, "down", comment="wrong", db_path=dbp)
    rows = db.list_feedback(db_path=dbp)
    assert len(rows) == 1
    assert rows[0]["score"] == "down"
    assert rows[0]["comment"] == "wrong"


def test_add_feedback_unknown_message_returns_none(dbp):
    assert db.add_message_feedback("nope", "up", db_path=dbp) is None


def test_list_feedback_joins_answer_and_evidence(dbp):
    cid, mid = _assistant_msg(dbp)
    db.add_message_feedback(mid, "down", db_path=dbp)
    row = db.list_feedback(db_path=dbp)[0]
    assert row["answer"] == "Net 30."
    assert row["evidence"] == [{"kind": "clause", "contract_id": "c1"}]
    assert row["conversation_id"] == cid


def test_message_feedback_none_when_no_vote(dbp):
    cid, _ = _assistant_msg(dbp)
    assert db.get_conversation_messages(cid, db_path=dbp)[1]["feedback"] is None


# --- route + LangSmith integration -----------------------------------------

from fastapi.testclient import TestClient

from contract_rag.api.app import create_app
from contract_rag.api.routes import query as query_route
from contract_rag.retrieval.agent import EvidenceResult


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_db_path", lambda: tmp_path / "t.db")
    return TestClient(create_app())


def _ask(client, monkeypatch, *, run_id="run-1"):
    result = EvidenceResult(question="q", answer="A.", evidence=[],
                            diagnostics={"run_id": run_id})
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)
    return client.post("/api/query", json={"question": "q"}).json()


def test_query_returns_message_id(client, monkeypatch):
    assert _ask(client, monkeypatch)["message_id"]


def test_feedback_persists_and_forwards_to_langsmith(client, monkeypatch):
    sent = {}
    monkeypatch.setattr(query_route.observability, "record_user_feedback",
                        lambda run_id, score, comment=None: sent.update(
                            run_id=run_id, score=score, comment=comment))
    mid = _ask(client, monkeypatch, run_id="run-9")["message_id"]

    r = client.post(f"/api/qa/messages/{mid}/feedback",
                    json={"score": "down", "comment": "wrong"})

    assert r.status_code == 200
    assert r.json()["score"] == "down"
    assert sent == {"run_id": "run-9", "score": "down", "comment": "wrong"}


def test_feedback_unknown_message_is_404(client):
    r = client.post("/api/qa/messages/nope/feedback", json={"score": "up"})
    assert r.status_code == 404


def test_feedback_invalid_score_is_422(client, monkeypatch):
    mid = _ask(client, monkeypatch)["message_id"]
    r = client.post(f"/api/qa/messages/{mid}/feedback", json={"score": "meh"})
    assert r.status_code == 422
