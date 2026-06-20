"""Retrieval over the contract corpus.

Adapts the old ``src/stateGraph.py`` to the new schema (decisions 10 & 12):
  - chunks no longer have a ``summary`` type; entity/comparison questions
    (who / when / how-much / contract number) are answered from SQLite — the
    real source — not from a summary chunk;
  - clause / semantic questions hit Weaviate over ``clause`` + ``table`` chunks
    (price answers live in table chunks).

Public surface:
  retrieve(question, ...)              -> ranked Documents (used by eval + answer)
  answer(question, ...)                -> one-shot RAG (string) with entity/clause routing
  answer_with_sources(question, ...)   -> one-shot RAG -> RAGResult (answer + contexts + sources)
  agent_answer_with_sources(...)       -> agentic RAG (sufficiency/rewrite loop) -> RAGResult
  ContractRAGAgent                     -> the LangGraph agent class behind agent_answer_with_sources

When ``use_reranker=True`` the k candidate pool is re-scored by the managed
Vertex Ranking API (``contract_rag.retrieval.reranker``), imported lazily so this
module stays cheap and offline-safe. (This replaced the local bge-reranker-v2-m3
cross-encoder, which OOM'd on long table chunks — see ``memory/retrieval_eval.md``.)
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Annotated, Any, List, TypedDict

from langchain_core.documents import Document
from langchain_core.prompts import PromptTemplate
from langchain_core.retrievers import BaseRetriever
from langgraph.graph import END, START, StateGraph
from pydantic import SkipValidation
from weaviate.classes.query import Filter

from contract_rag.config import load_config
from contract_rag.ingest.vision import extract_text
from contract_rag.llm import LLM
from contract_rag.storage import db, vector_store
from contract_rag.storage.vector_store import get_langchain_store

logger = logging.getLogger(__name__)

DEFAULT_CHUNK_TYPES = ("clause", "table", "image")
MAX_REWRITES = 3

# Contract columns worth feeding the LLM for entity/comparison answers.
_ENTITY_FIELDS = (
    "contract_id", "counterparty", "amount", "currency", "project_name",
    "department", "petitioner", "petition_date", "effective_date",
    "expiration_date", "brief_description", "status",
)


@dataclass(frozen=True)
class RAGResult:
    question: str
    question_class: str          # "entity" | "clause" | "comparison"
    answer: str
    contexts: list[str]          # retrieved chunk text (RAGAS consumes this); [] for entity
    sources: list[dict]          # [{contract_id, chunk_type, page_start, page_end, section_path, content}]
    diagnostics: dict = field(default_factory=dict)   # agent-only: {"iterations": <retrieval rounds>}


@dataclass(frozen=True)
class SQLGatedRetrievalResult:
    documents: list[Document]
    diagnostics: dict


# MinerU's content_list bbox is normalized to a fixed 0–1000 page canvas (per
# axis), verified across documents of differing page sizes. Dividing by this
# recovers the true 0–1 page fraction independent of render DPI.
_BBOX_CANVAS = 1000.0


def _normalize_bbox(raw) -> list[float] | None:
    """Convert a stored MinerU box ``[x0, y0, x1, y1]`` (on the 0–1000 canvas)
    to the front-end's ``[x, y, w, h]`` fractions in 0–1.

    Returns ``None`` for a missing, malformed, or degenerate (zero-area /
    inverted) box. Coordinates are clamped so the highlight stays on the page.
    """
    if not isinstance(raw, (list, tuple)) or len(raw) < 4:
        return None
    try:
        x0, y0, x1, y1 = (float(raw[0]), float(raw[1]), float(raw[2]), float(raw[3]))
    except (TypeError, ValueError):
        return None
    if any(v != v for v in (x0, y0, x1, y1)):  # NaN guard
        return None
    if x1 <= x0 or y1 <= y0:
        return None
    x = min(1.0, max(0.0, x0 / _BBOX_CANVAS))
    y = min(1.0, max(0.0, y0 / _BBOX_CANVAS))
    w = min(1.0 - x, (x1 - x0) / _BBOX_CANVAS)
    h = min(1.0 - y, (y1 - y0) / _BBOX_CANVAS)
    return [x, y, w, h]


def _doc_to_source(d) -> dict:
    m = d.metadata or {}
    return {
        "contract_id": m.get("contract_id", ""),
        "file_no": m.get("file_no", ""),
        "contract_number": m.get("contract_number", ""),
        "chunk_type": m.get("chunk_type", ""),
        "page_start": m.get("page_start"),
        "page_end": m.get("page_end"),
        # `page` is the single jump target for the verify popup (= page_start);
        # `bbox` is the chunk's layout box normalized to [x, y, w, h] 0–1 for the
        # front-end highlight, or None when the chunk carries no usable bbox
        # (multi-element / legacy chunk).
        "page": m.get("page_start"),
        "section_path": m.get("section_path", ""),
        "bbox": _normalize_bbox(m.get("bbox")),
        "content": d.page_content,
    }


def _state_to_result(state: dict) -> RAGResult:
    """Assemble a RAGResult from the agent graph's final state.

    Uses ``original_question`` (the user's question) — never the rewritten
    ``question`` left in state by the rewrite loop. clause path carries
    retrieved docs as contexts/sources; entity/comparison carries SQLite
    contract ids (no contexts), mirroring ``answer_with_sources``.
    """
    qclass = state["question_class"]
    docs = state.get("documents") or []
    diagnostics = {"iterations": state.get("iterations", 0)}
    diagnostics.update(state.get("retrieval_diagnostics") or {})
    if docs:
        sources = [_doc_to_source(d) for d in docs]
        contexts = [d.page_content for d in docs]
    else:
        sources = [{"contract_id": c["contract_id"]} for c in db.list_contracts()]
        contexts: list[str] = []
    return RAGResult(
        state["original_question"], qclass, state["generation"],
        contexts, sources, diagnostics,
    )


# --------------------------------------------------------------------------- #
# Core retrieval
# --------------------------------------------------------------------------- #

class WeaviateHybridRetriever(BaseRetriever):
    vectorstore: Annotated[Any, SkipValidation]
    k: int = 20
    alpha: float = 0.5
    filter: Annotated[Any, SkipValidation] = None

    def _get_relevant_documents(self, query: str, *, run_manager=None) -> list[Document]:
        return self.vectorstore.similarity_search(
            query, k=self.k, alpha=self.alpha, filters=self.filter
        )


def _chunk_type_filter(
    chunk_types,
    contract_id: str | None = None,
    contract_ids: list[str] | tuple[str, ...] | None = None,
):
    f = Filter.any_of([Filter.by_property("chunk_type").equal(t) for t in chunk_types])
    if contract_id:
        f = f & Filter.by_property("contract_id").equal(contract_id)
    ids = [str(cid) for cid in (contract_ids or []) if str(cid)]
    if ids:
        f = f & Filter.any_of([Filter.by_property("contract_id").equal(cid) for cid in ids])
    return f


def retrieve(
    question: str,
    *,
    k: int | None = None,
    top_n: int | None = None,
    alpha: float | None = None,
    contract_id: str | None = None,
    contract_ids: list[str] | tuple[str, ...] | None = None,
    chunk_types=DEFAULT_CHUNK_TYPES,
    use_reranker: bool | None = None,
) -> list[Document]:
    """Hybrid (vector + BM25) search over clause+table chunks.

    Unset params (``None``) fall back to ``config.retrieval``.
    ``alpha=1.0`` is pure vector, ``0.0`` pure keyword. Reranker is optional.
    """
    rc = load_config().retrieval
    k = rc.k if k is None else k
    top_n = rc.top_n if top_n is None else top_n
    alpha = rc.alpha if alpha is None else alpha
    use_reranker = rc.use_reranker if use_reranker is None else use_reranker
    store = get_langchain_store()
    filters = (
        _chunk_type_filter(chunk_types, contract_id=contract_id, contract_ids=contract_ids)
        if contract_ids else
        _chunk_type_filter(chunk_types, contract_id=contract_id)
    )
    base = WeaviateHybridRetriever(
        vectorstore=store,
        k=k,
        alpha=alpha,
        filter=filters,
    )
    if use_reranker:
        # Managed Vertex Ranking API: pull the full k candidate pool, then
        # re-score down to top_n (lazy import keeps this module offline-safe).
        from contract_rag.retrieval import reranker as _reranker

        return _reranker.rerank(question, base.invoke(question), top_n=top_n)
    return base.invoke(question)[:top_n]


# --------------------------------------------------------------------------- #
# SQL-gated retrieval
# --------------------------------------------------------------------------- #

_STRUCTURED_QUERY_HINTS = (
    "合同", "供应商", "部门", "项目", "金额", "万美元", "美元", "生效", "到期",
    "采购", "服务", "状态", "file", "contract", "supplier", "vendor",
    "department", "amount", "effective", "expiration", "expires",
)


def _norm_text(v) -> str:
    return str(v or "").strip().lower()


def _digits(v) -> str:
    return "".join(re.findall(r"\d+", str(v or "")))


def _has_structured_hint(question: str) -> bool:
    q = question.lower()
    if re.search(r"\b[A-Z]{1,}[A-Z0-9]*\d{4,}\b", question):
        return True
    return any(h.lower() in q for h in _STRUCTURED_QUERY_HINTS)


def _extract_sql_filters(question: str) -> dict:
    q = question.strip()
    q_lower = q.lower()
    filters: dict[str, Any] = {}

    m = re.search(r"([A-Za-z]{1,10}\d{4,}|20\d{4,})", q)
    if m:
        filters["identifier"] = m.group(1)

    m = re.search(r"([A-Za-z][A-Za-z0-9& .-]{2,40})\s*这份合同", q)
    if m:
        filters["name"] = m.group(1).strip()

    if "chemaqua" in q_lower or "chem-aqua" in q_lower:
        filters["name"] = "ChemAqua"
    if "linde" in q_lower:
        filters["name"] = "Linde"
    if "unifirst" in q_lower or "uniform" in q_lower or "garment" in q_lower:
        filters["name"] = "UniFirst"

    m = re.search(r"\b([A-Z]{2,})\s*部门", q)
    if m:
        filters["department"] = m.group(1)

    if "采购合同" in q or "purchase contract" in q_lower:
        filters["contract_type"] = "采购合同"
    elif "服务合同" in q or "service contract" in q_lower or "service agreement" in q_lower:
        filters["contract_type"] = "服务合同"

    if re.search(r"(超过|大于|over|above|greater than)\s*10\s*万", q_lower):
        filters["amount_min"] = 100000
    else:
        m = re.search(r"(?:超过|大于|over|above|greater than)\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)", q_lower)
        if m:
            filters["amount_min"] = float(m.group(1).replace(",", ""))

    years = re.findall(r"20\d{2}", q)
    if years and ("生效" in q or "到期" in q or "effective" in q_lower or "expir" in q_lower):
        filters["year"] = years[0]

    return filters


def _row_matches_filters(row: dict, filters: dict) -> bool:
    if not filters:
        return True

    haystack = " ".join(
        _norm_text(row.get(k))
        for k in (
            "contract_id", "file_no", "contract_number", "counterparty", "project_name",
            "department", "contract_type", "brief_description", "status",
        )
    )
    if identifier := filters.get("identifier"):
        ident = _norm_text(identifier)
        exact_ids = {
            _norm_text(row.get(k))
            for k in ("contract_id", "file_no", "contract_number")
            if _norm_text(row.get(k))
        }
        if ident.isdigit():
            if ident not in exact_ids:
                return False
        elif ident not in haystack:
            return False
    if name := filters.get("name"):
        if _norm_text(name).replace("-", "") not in haystack.replace("-", ""):
            return False
    if department := filters.get("department"):
        if _norm_text(row.get("department")) != _norm_text(department):
            return False
    if contract_type := filters.get("contract_type"):
        if _norm_text(contract_type) not in _norm_text(row.get("contract_type")):
            return False
    if amount_min := filters.get("amount_min"):
        amount = row.get("amount")
        if amount is None or float(amount) <= float(amount_min):
            return False
    if year := filters.get("year"):
        dates = " ".join(_norm_text(row.get(k)) for k in ("effective_date", "expiration_date", "petition_date"))
        if str(year) not in dates:
            return False
    return True


def _sql_candidate_rows(question: str) -> tuple[list[dict], dict]:
    filters = _extract_sql_filters(question)
    if not filters and not _has_structured_hint(question):
        return [], {"filters": {}, "reason": "no_structured_hints"}
    rows = db.list_contracts()
    candidates = [r for r in rows if _row_matches_filters(r, filters)]
    return candidates, {"filters": filters}


def _is_set_retrieval_question(question: str) -> bool:
    q = question.lower()
    return any(t in q for t in ("哪些", "哪几份", "which contracts", "all contracts"))


def _has_strong_sql_filter(filters: dict) -> bool:
    return bool(filters)


def _should_supplement_open_search(question: str, filters: dict) -> bool:
    return _is_set_retrieval_question(question) and not _has_strong_sql_filter(filters)


def _merge_documents(primary: list[Document], supplemental: list[Document]) -> list[Document]:
    out = list(primary)
    seen = {
        (
            (d.metadata or {}).get("contract_id"),
            (d.metadata or {}).get("page_start"),
            d.page_content,
        )
        for d in out
    }
    for d in supplemental:
        key = ((d.metadata or {}).get("contract_id"), (d.metadata or {}).get("page_start"), d.page_content)
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def _diversify_documents_by_contract(docs: list[Document]) -> list[Document]:
    grouped: dict[str, list[Document]] = {}
    order = []
    for d in docs:
        cid = str((d.metadata or {}).get("contract_id") or "")
        if cid not in grouped:
            grouped[cid] = []
            order.append(cid)
        grouped[cid].append(d)

    out = []
    while any(grouped.values()):
        for cid in order:
            if grouped[cid]:
                out.append(grouped[cid].pop(0))
    return out


def _contract_id_aliases(row: dict) -> set[str]:
    val = str(row.get("contract_id") or "").strip()
    return {val.lower()} if val else set()


def _file_no_aliases(row: dict) -> set[str]:
    val = str(row.get("file_no") or "").strip()
    return {val.lower()} if val else set()


@lru_cache(maxsize=1)
def _indexed_contract_ids() -> list[str]:
    return vector_store.list_contract_ids()


def _match_indexed_contract_ids(rows: list[dict], indexed_ids: list[str]) -> list[str]:
    out = []
    seen = set()
    indexed = [str(cid) for cid in indexed_ids if str(cid)]
    for row in rows:
        contract_aliases = _contract_id_aliases(row)
        file_aliases = _file_no_aliases(row)
        for cid in indexed:
            cid_norm = cid.lower()
            if (
                cid_norm in contract_aliases
                or cid_norm in file_aliases
            ):
                if cid not in seen:
                    seen.add(cid)
                    out.append(cid)
    return out


def sql_gated_retrieve(
    question: str,
    *,
    metadata_question: str | None = None,
    k: int | None = None,
    top_n: int | None = None,
    alpha: float | None = None,
    contract_id: str | None = None,
    use_reranker: bool | None = None,
) -> SQLGatedRetrievalResult:
    if contract_id:
        docs = retrieve(
            question, k=k, top_n=top_n, alpha=alpha,
            contract_ids=[contract_id], use_reranker=use_reranker,
        )
        return SQLGatedRetrievalResult(docs, {
            "filters": {"identifier": contract_id},
            "candidate_contract_ids": [contract_id],
            "matched_contract_ids": [contract_id],
            "used_sql_gate": True,
            "fallback_reason": None,
            "supplemented_open_search": False,
        })

    gate_question = metadata_question or question
    rows, sql_diag = _sql_candidate_rows(gate_question)
    diagnostics = {
        **sql_diag,
        "metadata_question": gate_question,
        "candidate_contract_ids": [r.get("contract_id") for r in rows],
        "matched_contract_ids": [],
        "used_sql_gate": False,
        "fallback_reason": None,
        "supplemented_open_search": False,
    }
    if not rows:
        diagnostics["fallback_reason"] = "no_sql_candidates"
        docs = retrieve(question, k=k, top_n=top_n, alpha=alpha, contract_ids=None, use_reranker=use_reranker)
        return SQLGatedRetrievalResult(docs, diagnostics)

    matched_ids = _match_indexed_contract_ids(rows, _indexed_contract_ids())
    diagnostics["matched_contract_ids"] = matched_ids
    if not matched_ids:
        diagnostics["fallback_reason"] = "no_indexed_contract_ids"
        docs = retrieve(question, k=k, top_n=top_n, alpha=alpha, contract_ids=None, use_reranker=use_reranker)
        return SQLGatedRetrievalResult(docs, diagnostics)

    diagnostics["used_sql_gate"] = True
    docs = retrieve(question, k=k, top_n=top_n, alpha=alpha, contract_ids=matched_ids, use_reranker=use_reranker)
    if _should_supplement_open_search(question, sql_diag.get("filters") or {}):
        supplement_top_n = max(top_n or load_config().retrieval.top_n, 10)
        open_docs = retrieve(
            question, k=k, top_n=supplement_top_n, alpha=alpha, contract_ids=None,
            use_reranker=use_reranker,
        )
        docs = _merge_documents(docs, open_docs)
        docs = _diversify_documents_by_contract(docs)
        diagnostics["supplemented_open_search"] = True
    return SQLGatedRetrievalResult(docs, diagnostics)


# --------------------------------------------------------------------------- #
# Query routing + entity (SQLite) answers
# --------------------------------------------------------------------------- #

_CLASSIFY_PROMPT = PromptTemplate(
    template="""请判断用户问题属于哪种查询类型，只返回 JSON。

类型定义：
- "entity"：询问合同当事方、签约日期、合同编号、金额等文档级信息（Who/When/What）
- "clause"：询问具体条款内容，如付款期限、违约责任、交货条件等
- "comparison"：跨合同比较，如"哪份合同付款期限更长"

示例：
问题："谁是买方？" → {{"question_class": "entity"}}
问题："付款期限是多少天？" → {{"question_class": "clause"}}
问题："这两份合同的价格哪个更高？" → {{"question_class": "comparison"}}

用户问题：{question}

只返回 JSON，不要任何其他内容：""",
    input_variables=["question"],
)


def classify_query(question: str) -> str:
    out = LLM().get_custom_chat_object(load_config().models.rag_light).invoke(_CLASSIFY_PROMPT.format(question=question))
    text = extract_text(out.content).strip().lower()
    if "entity" in text:
        return "entity"
    if "comparison" in text:
        return "comparison"
    return "clause"


def _entity_context() -> str:
    contracts = db.list_contracts()
    if not contracts:
        return ""
    compact = [{k: c.get(k) for k in _ENTITY_FIELDS} for c in contracts]
    return json.dumps(compact, ensure_ascii=False, indent=2)


_ENTITY_PROMPT = PromptTemplate(
    template="""以下是合同元数据（SQLite 结构化真源）：
{context}

请仅根据上述数据回答用户问题。若数据中没有，请直接说明缺失。
问题：{question}""",
    input_variables=["context", "question"],
)


def entity_lookup(question: str) -> str:
    context = _entity_context()
    if not context:
        return "合同库为空，暂无可查询的元数据。"
    out = LLM().get_custom_chat_object(load_config().models.rag_generate).invoke(
        _ENTITY_PROMPT.format(context=context, question=question)
    )
    return extract_text(out.content)


_ANSWER_PROMPT = PromptTemplate(
    template="""请根据以下合同条款/表格内容回答用户问题。只用给定内容，不要编造。
{document}

问题：{question}""",
    input_variables=["document", "question"],
)

_SQL_GATED_ANSWER_PROMPT = PromptTemplate(
    template="""请根据以下 SQL gate 摘要和合同条款/表格内容回答用户问题。只用给定内容，不要编造。

SQL gate summary:
{gate_summary}

Evidence:
{document}

回答要求：
- 需要列举合同或比较合同的时候，优先按 source label 里的 contract_id 组织答案。
- SQL gate matched vector contract IDs 是结构化条件命中的候选合同。
- 如果 supplemented open search 为 true，开放补充证据只表示可能相关；不要忽略 SQL gate 命中的合同。

问题：{question}""",
    input_variables=["gate_summary", "document", "question"],
)


_CLAUSE_EVIDENCE_TERMS = (
    "条款", "提到", "写到", "约定", "付款", "账期", "违约", "价格调整",
    "price adjustment", "escalation", "30 days", "thirty days", "fee",
    "rental", "propane", "payment", "terms", "clause", "mention",
)


def _needs_clause_evidence(question: str) -> bool:
    q = question.lower()
    return any(t.lower() in q for t in _CLAUSE_EVIDENCE_TERMS)


def _format_docs_with_source_labels(docs: list[Document]) -> str:
    blocks = []
    for i, d in enumerate(docs, 1):
        m = d.metadata or {}
        label = (
            f"[source {i} contract_id={m.get('contract_id', '')} "
            f"chunk_type={m.get('chunk_type', '')} page={m.get('page_start', '')}]"
        )
        blocks.append(f"{label}\n{d.page_content}")
    return "\n\n".join(blocks)


def _format_sql_gate_summary(diagnostics: dict) -> str:
    filters = diagnostics.get("filters") or {}
    candidates = diagnostics.get("candidate_contract_ids") or []
    matched = diagnostics.get("matched_contract_ids") or []
    return "\n".join([
        f"SQL filters: {json.dumps(filters, ensure_ascii=False)}",
        f"SQL candidate contract IDs: {', '.join(str(x) for x in candidates) or '(none)'}",
        f"SQL gate matched vector contract IDs: {', '.join(str(x) for x in matched) or '(none)'}",
        f"supplemented open search: {bool(diagnostics.get('supplemented_open_search'))}",
    ])


def sql_gated_answer_with_sources(
    question: str, *, alpha: float | None = None, use_reranker: bool | None = None,
    temperature: float | None = None,
) -> RAGResult:
    """Answer with SQL metadata as a candidate-contract gate before chunk RAG.

    Structured metadata narrows the contract set; clause/table evidence still
    comes from Weaviate. Pure entity questions stay on SQLite-only lookup.
    """
    qclass = classify_query(question)
    if qclass in ("entity", "comparison") and not _needs_clause_evidence(question):
        ans = entity_lookup(question)
        sources = [{"contract_id": c["contract_id"]} for c in db.list_contracts()]
        return RAGResult(question, qclass, ans, [], sources)

    retrieved = sql_gated_retrieve(
        question, alpha=alpha, use_reranker=use_reranker,
    )
    contexts = [d.page_content for d in retrieved.documents]
    labeled_context = _format_docs_with_source_labels(retrieved.documents)
    gate_summary = _format_sql_gate_summary(retrieved.diagnostics)
    out = LLM().get_custom_chat_object(
        load_config().models.rag_generate, temperature=temperature
    ).invoke(_SQL_GATED_ANSWER_PROMPT.format(
        gate_summary=gate_summary, document=labeled_context, question=question,
    ))
    return RAGResult(
        question, qclass, extract_text(out.content), contexts,
        [_doc_to_source(d) for d in retrieved.documents],
        diagnostics=retrieved.diagnostics,
    )


def answer_with_sources(
    question: str, *, contract_id: str | None = None,
    alpha: float | None = None, use_reranker: bool | None = None,
    temperature: float | None = None,
) -> RAGResult:
    """One-shot RAG returning the answer plus its retrieved sources/contexts."""
    qclass = classify_query(question)
    if qclass in ("entity", "comparison"):
        ans = entity_lookup(question)
        sources = [{"contract_id": c["contract_id"]} for c in db.list_contracts()]
        return RAGResult(question, qclass, ans, [], sources)
    docs = retrieve(question, contract_id=contract_id, alpha=alpha, use_reranker=use_reranker)
    contexts = [d.page_content for d in docs]
    out = LLM().get_custom_chat_object(
        load_config().models.rag_generate, temperature=temperature
    ).invoke(_ANSWER_PROMPT.format(document="\n\n".join(contexts), question=question))
    return RAGResult(
        question, qclass, extract_text(out.content), contexts,
        [_doc_to_source(d) for d in docs],
    )


def answer(question: str, *, contract_id: str | None = None, use_reranker: bool | None = None) -> str:
    """One-shot RAG: entity/comparison -> SQLite; clause -> Weaviate."""
    return answer_with_sources(
        question, contract_id=contract_id, use_reranker=use_reranker
    ).answer


# --------------------------------------------------------------------------- #
# LangGraph agent (clause path has a sufficiency / rewrite loop)
# --------------------------------------------------------------------------- #

_SUFFICIENCY_PROMPT = PromptTemplate(
    template="""判断下面的内容是否足够回答用户问题。只返回 JSON：{{"sufficient": true/false}}

内容：{document}

问题：{question}""",
    input_variables=["document", "question"],
)

_REWRITE_PROMPT = PromptTemplate(
    template="""上一轮检索结果不足以回答问题。请改写问题以检索到更相关的信息。
只返回 JSON：{{"new_query": "改写后的问题"}}

原问题：{question}
上一轮检索结果：{document}""",
    input_variables=["question", "document"],
)


class ContractRAGState(TypedDict):
    question: str                 # mutated by the rewrite loop
    original_question: str        # preserved for the result
    question_class: str           # set by _classify_node
    documents: List[Document]
    context: str
    generation: str
    iterations: int
    # retrieve params threaded in at invoke time (None -> config defaults)
    contract_id: str | None
    alpha: float | None
    use_reranker: bool | None
    temperature: float | None
    retrieval_diagnostics: dict


def _classify_node(state: ContractRAGState) -> dict:
    return {"question_class": classify_query(state["question"])}


def _route_after_classify(state: ContractRAGState) -> str:
    if state["question_class"] in ("entity", "comparison") and _needs_clause_evidence(state["question"]):
        return "clause"
    return "entity" if state["question_class"] in ("entity", "comparison") else "clause"


def _entity_node(state: ContractRAGState) -> dict:
    return {"generation": entity_lookup(state["question"])}


def _clause_retrieve_node(state: ContractRAGState) -> dict:
    retrieved = sql_gated_retrieve(
        state["question"],
        metadata_question=state.get("original_question") or state["question"],
        contract_id=state.get("contract_id"),
        alpha=state.get("alpha"),
        use_reranker=state.get("use_reranker"),
    )
    docs = retrieved.documents
    return {
        "documents": docs,
        "context": _format_docs_with_source_labels(docs),
        "iterations": state.get("iterations", 0) + 1,
        "retrieval_diagnostics": retrieved.diagnostics,
    }


def _sufficiency_edge(state: ContractRAGState) -> str:
    if state["iterations"] >= MAX_REWRITES:
        return "generate"
    out = LLM().get_custom_chat_object(load_config().models.rag_light).invoke(
        _SUFFICIENCY_PROMPT.format(document=state["context"], question=state["question"])
    )
    return "generate" if "true" in extract_text(out.content).lower() else "rewrite"


def _rewrite_node(state: ContractRAGState) -> dict:
    out = LLM().get_custom_chat_object(load_config().models.rag_light).invoke(
        _REWRITE_PROMPT.format(question=state["question"], document=state["context"])
    )
    content = extract_text(out.content).strip().replace("```json", "").replace("```", "").strip()
    try:
        new_q = json.loads(content)["new_query"]
    except (json.JSONDecodeError, KeyError):
        new_q = state["question"]  # fall back to the original on parse failure
    return {"question": new_q}


def _generate_node(state: ContractRAGState) -> dict:
    prompt = _ANSWER_PROMPT.format(document=state["context"], question=state["question"])
    if state.get("retrieval_diagnostics"):
        prompt = _SQL_GATED_ANSWER_PROMPT.format(
            gate_summary=_format_sql_gate_summary(state["retrieval_diagnostics"]),
            document=state["context"],
            question=state["question"],
        )
    out = LLM().get_custom_chat_object(
        load_config().models.rag_generate, temperature=state.get("temperature")
    ).invoke(prompt)
    return {"generation": extract_text(out.content)}


class ContractRAGAgent:
    """Agentic RAG: routes to SQLite (entity) or Weaviate (clause, with a
    bounded retrieve -> sufficiency -> rewrite loop)."""

    @staticmethod
    def _build() -> StateGraph:
        g = StateGraph(ContractRAGState)
        g.add_node("classify", _classify_node)
        g.add_edge(START, "classify")
        g.add_conditional_edges(
            "classify", _route_after_classify,
            {"entity": "entity", "clause": "clause_retrieve"},
        )
        g.add_node("entity", _entity_node)
        g.add_edge("entity", END)
        g.add_node("clause_retrieve", _clause_retrieve_node)
        g.add_conditional_edges(
            "clause_retrieve", _sufficiency_edge,
            {"generate": "generate", "rewrite": "rewrite"},
        )
        g.add_node("rewrite", _rewrite_node)
        g.add_edge("rewrite", "clause_retrieve")
        g.add_node("generate", _generate_node)
        g.add_edge("generate", END)
        return g

    def invoke(self, question: str) -> str:
        return agent_answer_with_sources(question).answer


@lru_cache(maxsize=1)
def _compiled_agent():
    """Compiled agent graph, built once (compilation is not free)."""
    return ContractRAGAgent._build().compile()


def agent_answer_with_sources(
    question: str, *, contract_id: str | None = None, alpha: float | None = None,
    use_reranker: bool | None = None, temperature: float | None = None,
) -> RAGResult:
    """Agentic RAG (retrieve -> sufficiency -> rewrite loop) returning the answer
    plus its retrieved sources/contexts — the agentic counterpart of
    ``answer_with_sources``."""
    final = _compiled_agent().invoke(ContractRAGState(
        question=question, original_question=question, question_class="",
        documents=[], context="", generation="", iterations=0,
        contract_id=contract_id, alpha=alpha,
        use_reranker=use_reranker, temperature=temperature,
        retrieval_diagnostics={},
    ))
    return _state_to_result(final)
