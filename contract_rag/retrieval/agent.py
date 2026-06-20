"""Tool-calling agentic Q&A (see ``docs/INTERFACE.md`` §5).

The LLM owns the SQL-vs-Weaviate choice: it is given two tools
(``query_ledger`` / ``search_clauses``) and decides which to call, then emits a
final ``{answer, evidence[]}`` JSON. We normalize that evidence and back-fill
each clause item's ``page``/``bbox`` from the chunk it came from (the LLM can't
author a reliable float bbox). This replaces the old heuristic ``classify_query``
+ ``sql_gated_*`` routing.

The live ``answer_with_evidence`` is an integration entry point (real Gemini +
Weaviate); the deterministic glue (``_parse_final`` / ``_assemble``) is unit-tested.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool

from contract_rag.config import load_config
from contract_rag.ingest.vision import extract_text
from contract_rag.llm import LLM
from contract_rag.retrieval import tools as agent_tools
from contract_rag.retrieval.evidence import normalize_evidence

logger = logging.getLogger(__name__)

def history_limit() -> int:
    """Max trailing transcript messages replayed as conversational context so the
    agent can resolve follow-up references ("它什么时候到期"). Config-driven
    (``retrieval.history_max_messages``); also the cap the UI locks at, so older
    turns never silently drop. Assistant answers are natural-language only
    (evidence is stored separately and not replayed)."""
    return load_config().retrieval.history_max_messages


def _history_messages(history: list[dict] | None, limit: int | None = None) -> list[Any]:
    """Map prior conversation turns to LangChain messages for the agent prompt.

    ``user`` -> ``HumanMessage``, ``assistant`` -> ``AIMessage``; blank-content
    and other roles (e.g. tool/system rows) are dropped. Only the last
    ``limit`` (default ``history_limit()``) are kept, preserving order.
    """
    limit = history_limit() if limit is None else limit
    out: list[Any] = []
    for m in (history or [])[-limit:]:
        content = (m.get("content") or "").strip()
        if not content:
            continue
        role = m.get("role")
        if role == "user":
            out.append(HumanMessage(content=content))
        elif role == "assistant":
            out.append(AIMessage(content=content))
    return out

MAX_TOOL_ROUNDS = 6

_SYSTEM_PROMPT = """你是合同问答助手。你有两个工具：
- query_ledger(filters): 查结构化合同台账（当事方/金额/部门/类型/日期等）。filters 可选键：identifier（合同编号/存档号，纯数字为精确匹配）、name（对方公司，子串）、department（精确）、contract_type（子串）、amount_min（数字）、year（出现在任一日期）。
- search_clauses(query, contract_id): 检索合同条款/表格原文片段；contract_id 可空表示全库检索。

请自行决定调用哪个/哪些工具来回答问题，可多次调用。拿到足够信息后，**只输出一个 JSON 对象**：
{"answer": "自然语言回答", "evidence": [ ... ]}

evidence 每项二选一：
- 用台账字段回答：{"kind":"record","contract_id":"...","title":"对方公司或项目名","fields":{"字段名":"值"}}。聚合/对比类问题，每个命中合同输出一条 record。
- 用原文片段回答：{"kind":"clause","contract_id":"...","section":"条款名","snippet":"逐字原文片段"}。

规则：
- 只使用工具返回的真实数据，禁止编造合同信息。
- 判断合同对方/供应商/合同主体时，以 query_ledger 返回的 counterparty/对方公司字段为准；search_clauses 原文里出现的第三方、报价方、比价对象、历史供应商等名称（例如 Veolia）只能表述为“比价对象/提及对象”，不得当作该合同的供应商。
- 当台账字段和原文片段中出现不同公司名时，优先使用台账 counterparty，并说明原文里的其他公司名只是比较、报价或被提及的对象。
- clause 的 snippet 必须逐字来自 search_clauses 的返回（不要改写）；page/bbox 不用你给，系统会回填。
- 不要输出 JSON 以外的任何文字、不要加 markdown 代码围栏。"""


@dataclass(frozen=True)
class EvidenceResult:
    question: str
    answer: str
    evidence: list[dict]
    diagnostics: dict = field(default_factory=dict)


def _loads_tolerant(s: str, max_fixes: int = 24) -> Any:
    """json.loads, but delete the offending character and retry on each error.

    Gemini-3 sometimes injects a stray token into otherwise-valid JSON (e.g. a
    bare 「洞察」 between the evidence array and the closing brace). Dropping the
    char at the decoder's reported error position repairs such garbage; the
    bounded loop keeps it safe, and downstream ``normalize_evidence`` filters any
    item the repair leaves malformed.
    """
    for _ in range(max_fixes):
        try:
            return json.loads(s)
        except json.JSONDecodeError as e:
            if not e.pos or e.pos >= len(s):
                return None
            s = s[:e.pos] + s[e.pos + 1:]
    return None


def _parse_final(content: Any) -> dict:
    """Parse the model's final message into a dict; {} on any failure."""
    text = extract_text(content).strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text[3:] else text
        text = text.lstrip("json").lstrip("JSON").strip().strip("`").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        return {}
    parsed = _loads_tolerant(text[start:end + 1])
    return parsed if isinstance(parsed, dict) else {}


def _assemble(question: str, parsed: dict, chunks: list[dict],
              diagnostics: dict | None = None) -> EvidenceResult:
    """Normalize LLM evidence and back-fill clause page/bbox from real chunks."""
    answer = str(parsed.get("answer") or "")
    items = normalize_evidence(parsed.get("evidence"))
    items = agent_tools.attach_clause_provenance(items, chunks)
    return EvidenceResult(question, answer, items, diagnostics or {})


def answer_with_evidence(
    question: str,
    *,
    contract_id: str | None = None,
    supplier_name: str | None = None,
    history: list[dict] | None = None,
    temperature: float | None = None,
    max_rounds: int = MAX_TOOL_ROUNDS,
) -> EvidenceResult:
    """Run the tool-calling agent and return ``{answer, evidence[]}`` (§5)."""
    collected_chunks: list[dict] = []
    scope_cid = contract_id
    supplier_scope = (supplier_name or "").strip()
    supplier_contract_ids = _supplier_contract_ids(supplier_scope) if supplier_scope else []

    @tool
    def query_ledger(filters: dict | None = None) -> list[dict]:
        """Query the structured contract ledger (SQLite). See system prompt for filter keys."""
        scoped_filters = dict(filters or {})
        if supplier_scope:
            scoped_filters["name"] = supplier_scope
        if scope_cid:
            scoped_filters["identifier"] = scope_cid
        return agent_tools.query_ledger(scoped_filters)

    @tool
    def search_clauses(query: str, contract_id: str | None = None) -> list[dict]:
        """Search contract clause/table text. Returns chunks with contract_id/page/section/snippet."""
        target_contract_id = contract_id or scope_cid
        if supplier_scope and not target_contract_id:
            res = agent_tools.search_clauses(query, contract_ids=supplier_contract_ids) if supplier_contract_ids else []
        else:
            res = agent_tools.search_clauses(query, target_contract_id)
        collected_chunks.extend(res)
        return res

    model = LLM().get_custom_chat_object(
        load_config().models.rag_generate, temperature=temperature
    ).bind_tools([query_ledger, search_clauses])
    fns = {"query_ledger": query_ledger, "search_clauses": search_clauses}

    if supplier_scope:
        scope = f"\n（本次问答限定在供应商名称包含「{supplier_scope}」的合同范围内。）"
    elif contract_id:
        scope = f"\n（本次问答限定在合同 {contract_id} 范围内。）"
    else:
        scope = ""
    messages: list[Any] = [
        SystemMessage(content=_SYSTEM_PROMPT + scope),
        *_history_messages(history),
        HumanMessage(content=question),
    ]

    rounds = 0
    response = model.invoke(messages)
    while getattr(response, "tool_calls", None) and rounds < max_rounds:
        rounds += 1
        messages.append(response)
        for call in response.tool_calls:
            fn = fns.get(call["name"])
            try:
                result = fn.invoke(call["args"]) if fn else f"unknown tool {call['name']}"
            except Exception as e:  # noqa: BLE001 — surface tool error to the model
                logger.warning("tool %s failed: %r", call.get("name"), e)
                result = f"tool error: {e}"
            messages.append(ToolMessage(
                content=json.dumps(result, ensure_ascii=False, default=str),
                tool_call_id=call["id"],
            ))
        response = model.invoke(messages)

    parsed = _parse_final(response.content)
    return _assemble(question, parsed, collected_chunks, {"tool_rounds": rounds})


def _supplier_contract_ids(supplier_name: str) -> list[str]:
    needle = supplier_name.strip().casefold()
    if not needle:
        return []
    return [
        str(row.get("contract_id"))
        for row in agent_tools.db.list_contracts()
        if needle in str(row.get("counterparty") or "").casefold()
    ]
