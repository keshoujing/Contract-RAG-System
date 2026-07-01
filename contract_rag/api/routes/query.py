"""Retrieval Q&A endpoint — tool-calling agentic RAG (§5 unified evidence)."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from fastapi import Response

from contract_rag.api.schemas import FeedbackRequest, QueryRequest, QueryResponse
from contract_rag.retrieval import observability
from contract_rag.retrieval.agent import answer_with_evidence, history_limit
from contract_rag.storage import db

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/qa/conversations")
def list_qa_conversations() -> list[dict]:
    return db.list_conversations()


@router.post("/qa/conversations")
def create_qa_conversation() -> dict:
    conversation = db.create_conversation()
    return {**conversation, "message_count": 0}


@router.get("/qa/conversations/{conversation_id}")
def get_qa_conversation(conversation_id: str) -> dict:
    conversation = db.get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    messages = db.get_conversation_messages(conversation_id)
    return {
        **conversation,
        "messages": messages,
        # Full once the cap is reached -> UI forces a new conversation.
        "full": len(messages) >= history_limit(),
    }


@router.delete("/qa/conversations/{conversation_id}", status_code=204)
def delete_qa_conversation(conversation_id: str) -> Response:
    if db.get_conversation(conversation_id) is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    db.delete_conversation(conversation_id)
    return Response(status_code=204)


@router.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    if not req.question.strip():
        raise HTTPException(status_code=422, detail="question must not be blank")
    contract_id, supplier_name = _scope_from_request(req)
    conversation = db.ensure_conversation(req.conversation_id)
    conversation_id = conversation["conversation_id"]
    # Prior turns (the current question is appended only after answering), so the
    # agent can resolve follow-up references like "when does it expire".
    history = db.get_conversation_messages(conversation_id)
    try:
        result = answer_with_evidence(
            req.question,
            contract_id=contract_id,
            supplier_name=supplier_name,
            history=history,
        )
    except Exception:  # Weaviate down / empty collection / LLM failure
        logger.exception("query failed for question=%r", req.question)
        raise HTTPException(status_code=502, detail="retrieval backend unavailable")
    db.rename_conversation_if_default(conversation_id, req.question)
    db.append_conversation_message(conversation_id, role="user", content=req.question)
    assistant = db.append_conversation_message(
        conversation_id,
        role="assistant",
        content=result.answer,
        evidence=result.evidence,
        run_id=result.diagnostics.get("run_id"),
    )
    # This turn added 2 messages (user + assistant) to the prior history.
    conversation_full = (len(history) + 2) >= history_limit()
    return QueryResponse(
        question=result.question,
        answer=result.answer,
        conversation_id=conversation_id,
        message_id=assistant["message_id"],
        conversation_full=conversation_full,
        evidence=result.evidence,
    )


@router.post("/qa/messages/{message_id}/feedback")
def submit_feedback(message_id: str, req: FeedbackRequest) -> dict:
    """Record a 👍/👎 on an assistant answer: persist it (gold flywheel source)
    and forward it to the query's LangSmith run (best-effort)."""
    feedback = db.add_message_feedback(message_id, req.score, req.comment)
    if feedback is None:
        raise HTTPException(status_code=404, detail="message not found")
    observability.record_user_feedback(feedback["run_id"], req.score, req.comment)
    return feedback


def _scope_from_request(req: QueryRequest) -> tuple[str | None, str | None]:
    scope_value = (req.scope_value or "").strip()
    if req.scope_type == "supplier":
        return None, scope_value or None
    if req.scope_type == "contract":
        return scope_value or req.contract_id, None
    return req.contract_id, None
