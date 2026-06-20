from fastapi.testclient import TestClient
import pytest

from contract_rag.api.app import create_app
from contract_rag.retrieval.agent import EvidenceResult
from contract_rag.api.routes import query as query_route
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_db_path", lambda: tmp_path / "t.db")
    return TestClient(create_app())


def test_query_returns_answer_and_evidence(client, monkeypatch):
    result = EvidenceResult(
        question="付款账期？", answer="Net 30.",
        evidence=[
            {"kind": "clause", "contract_id": "2026004", "page": 8,
             "section": "4 Payment", "snippet": "net thirty (30) days",
             "bbox": [1.0, 2.0, 3.0, 4.0]},
            {"kind": "record", "contract_id": "2026002", "title": "Linde",
             "fields": {"金额": "70,904.55"}},
        ],
    )
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)
    body = client.post("/api/query", json={"question": "付款账期？",
                                           "contract_id": "2026004"}).json()
    assert body["answer"] == "Net 30."
    clause = body["evidence"][0]
    assert clause["kind"] == "clause"
    assert clause["page"] == 8
    assert clause["bbox"] == [1.0, 2.0, 3.0, 4.0]
    assert body["evidence"][1]["kind"] == "record"


def test_query_accepts_supplier_scope(client, monkeypatch):
    calls = []
    result = EvidenceResult(question="付款条款？", answer="供应商范围回答。", evidence=[])

    def _answer(*args, **kwargs):
        calls.append((args, kwargs))
        return result

    monkeypatch.setattr(query_route, "answer_with_evidence", _answer)

    body = client.post("/api/query", json={
        "question": "付款条款？",
        "scope_type": "supplier",
        "scope_value": "Owens Corning",
    }).json()

    assert body["answer"] == "供应商范围回答。"
    assert calls[0][1]["supplier_name"] == "Owens Corning"
    assert calls[0][1]["contract_id"] is None


def test_query_passes_prior_history_to_agent(client, monkeypatch):
    captured = {}
    result = EvidenceResult(question="q", answer="A.", evidence=[])

    def _answer(question, *, contract_id=None, supplier_name=None, history=None, **kwargs):
        captured["history"] = history
        return result

    monkeypatch.setattr(query_route, "answer_with_evidence", _answer)

    first = client.post("/api/query", json={"question": "水处理合同是哪一份"}).json()
    conversation_id = first["conversation_id"]
    # Second turn in the same conversation must see turn 1 (user + assistant).
    client.post("/api/query", json={"question": "它什么时候到期呢",
                                     "conversation_id": conversation_id})

    history = captured["history"]
    assert [m["role"] for m in history] == ["user", "assistant"]
    assert history[0]["content"] == "水处理合同是哪一份"


def test_query_reports_conversation_full_at_threshold(client, monkeypatch):
    # Lock after the message count reaches the cap (here 4 = two full turns).
    monkeypatch.setattr(query_route, "history_limit", lambda: 4)
    result = EvidenceResult(question="q", answer="A.", evidence=[])
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)

    first = client.post("/api/query", json={"question": "第一问"}).json()
    assert first["conversation_full"] is False  # 2 messages < 4

    cid = first["conversation_id"]
    second = client.post("/api/query", json={"question": "第二问", "conversation_id": cid}).json()
    assert second["conversation_full"] is True  # 4 messages >= 4


def test_conversation_detail_reports_full(client, monkeypatch):
    monkeypatch.setattr(query_route, "history_limit", lambda: 4)
    result = EvidenceResult(question="q", answer="A.", evidence=[])
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)

    cid = client.post("/api/query", json={"question": "第一问"}).json()["conversation_id"]
    assert client.get(f"/api/qa/conversations/{cid}").json()["full"] is False
    client.post("/api/query", json={"question": "第二问", "conversation_id": cid})
    assert client.get(f"/api/qa/conversations/{cid}").json()["full"] is True


def test_query_creates_and_persists_conversation(client, monkeypatch):
    result = EvidenceResult(
        question="当前所有还在生效的合同是什么",
        answer="当前共有 3 份。",
        evidence=[{"kind": "record", "contract_id": "A", "fields": {"状态": "active"}}],
    )
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)

    body = client.post("/api/query", json={"question": "当前所有还在生效的合同是什么"}).json()

    conversation_id = body["conversation_id"]
    assert conversation_id

    listing = client.get("/api/qa/conversations").json()
    assert listing[0]["conversation_id"] == conversation_id
    assert listing[0]["title"] == "当前所有还在生效的合同是什么"
    assert listing[0]["message_count"] == 2

    detail = client.get(f"/api/qa/conversations/{conversation_id}").json()
    assert detail["conversation_id"] == conversation_id
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["messages"][0]["content"] == "当前所有还在生效的合同是什么"
    assert detail["messages"][1]["content"] == "当前共有 3 份。"
    assert detail["messages"][1]["evidence"] == [{"kind": "record", "contract_id": "A", "fields": {"状态": "active"}}]


def test_query_appends_to_existing_conversation(client, monkeypatch):
    created = client.post("/api/qa/conversations").json()
    cid = created["conversation_id"]
    result = EvidenceResult(question="付款期限？", answer="Net 30.", evidence=[])
    monkeypatch.setattr(query_route, "answer_with_evidence", lambda *a, **k: result)

    body = client.post("/api/query", json={"question": "付款期限？", "conversation_id": cid}).json()

    assert body["conversation_id"] == cid
    detail = client.get(f"/api/qa/conversations/{cid}").json()
    assert detail["title"] == "付款期限？"
    assert [m["content"] for m in detail["messages"]] == ["付款期限？", "Net 30."]


def test_delete_conversation_removes_history(client):
    created = client.post("/api/qa/conversations").json()
    cid = created["conversation_id"]

    assert client.delete(f"/api/qa/conversations/{cid}").status_code == 204
    assert client.get(f"/api/qa/conversations/{cid}").status_code == 404


def test_query_blank_question_is_422(client):
    r = client.post("/api/query", json={"question": "   "})
    assert r.status_code == 422


def test_query_backend_error_is_502(client, monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("weaviate down")
    monkeypatch.setattr(query_route, "answer_with_evidence", _boom)
    r = client.post("/api/query", json={"question": "付款账期？"})
    assert r.status_code == 502
