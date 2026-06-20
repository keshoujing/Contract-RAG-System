# Agentic RAG 接通 + 增量评测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有 `ContractRAGAgent`（agentic 自评循环，逻辑不动）接成可返回结构化 `RAGResult` 的能力，并用同步 embedding 双指标量出它相对一次性 RAG 的增量。

**Architecture:** 三块。(1) `graph.py` 加 classify 节点 + 把检索参数穿进 LangGraph state + 新 `agent_answer_with_sources()` 从终态组装 `RAGResult`（组装抽成纯函数 `_state_to_result`）。(2) `evals/metrics.py` 同步 embedding 指标（answer_similarity / retrieval_coverage），直接 `embed_query`，不经 ragas `evaluate()`，绕开 async 卡死坑。(3) `evals/run_agent_compare.py` 断点续跑 runner，oneshot vs agent，默认单跑，`--repeats` 上 x3 复用 `evals/compare.py`。API 不动。

**Tech Stack:** Python 3.12, LangGraph, LangChain, Vertex Gemini embedding, pytest。

设计依据：`docs/superpowers/specs/2026-06-15-agentic-rag-eval-design.md`。

---

## File Structure

- **Modify** `contract_rag/retrieval/graph.py`：`RAGResult` 加 `diagnostics` 字段；`ContractRAGState` 加 `original_question`/`question_class`/检索参数；加 `_classify_node`、重连边；`_clause_retrieve_node`/`_generate_node` 从 state 读参数；加 `_state_to_result`、`agent_answer_with_sources`、`@lru_cache` 编译缓存；`ContractRAGAgent.invoke` 委托。
- **Create** `evals/metrics.py`：`_cosine`、`answer_similarity`、`retrieval_coverage`。
- **Create** `evals/run_agent_compare.py`：断点续跑对比 runner。
- **Create** `tests/evals/test_metrics.py`：双指标单测（fake embed）。
- **Create** `tests/retrieval/test_graph_agent.py`：`_state_to_result` + `agent_answer_with_sources` 单测（全 mock，离线）。
- **Create** `tests/evals/test_run_agent_compare.py`：resume/max-runs/report 单测（全 mock）。

测试基线：当前 175 测试全绿，新增测试不得破坏既有测试。运行单元闸：`.venv/bin/python -m pytest -q`。

---

## Task 1: 同步 embedding 双指标（`evals/metrics.py`）

纯函数、可离线单测。先做这块——它不依赖任何 graph 改动。

**Files:**
- Create: `evals/metrics.py`
- Test: `tests/evals/test_metrics.py`

- [ ] **Step 1: 写失败测试**

`tests/evals/test_metrics.py`：
```python
"""Synchronous embedding metrics — no network (fake embed fn)."""
import math

from evals.metrics import answer_similarity, retrieval_coverage


def _fake_embed(vectors):
    """Return an embed(text)->vector fn backed by a dict; unknown text -> zeros."""
    dim = len(next(iter(vectors.values())))
    return lambda text: vectors.get(text, [0.0] * dim)


def test_answer_similarity_identical_is_one():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [1.0, 0.0]})
    assert answer_similarity("a", "b", embed) == 1.0


def test_answer_similarity_orthogonal_is_zero():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [0.0, 1.0]})
    assert answer_similarity("a", "b", embed) == 0.0


def test_answer_similarity_opposite_is_negative_one():
    embed = _fake_embed({"a": [1.0, 0.0], "b": [-1.0, 0.0]})
    assert answer_similarity("a", "b", embed) == -1.0


def test_retrieval_coverage_takes_max_over_contexts():
    embed = _fake_embed({
        "gold": [1.0, 0.0],
        "c1": [0.0, 1.0],   # cos 0.0
        "c2": [1.0, 1.0],   # cos ~0.707
    })
    cov = retrieval_coverage("gold", ["c1", "c2"], embed)
    assert math.isclose(cov, 1 / math.sqrt(2), rel_tol=1e-9)


def test_retrieval_coverage_empty_contexts_is_zero():
    embed = _fake_embed({"gold": [1.0, 0.0]})
    assert retrieval_coverage("gold", [], embed) == 0.0
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/evals/test_metrics.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'evals.metrics'`

- [ ] **Step 3: 实现**

`evals/metrics.py`：
```python
"""Synchronous embedding metrics for agent-vs-oneshot comparison.

Deliberately does NOT use ragas ``evaluate()``: on this Vertex async stack it
intermittently hangs for hundreds of seconds even on embedding-only metrics
(see memory/retrieval_eval.md). Direct ``embed_query`` calls run in ~1-2s and
never hang. ``embed`` is injected (``LLM().get_embedding_object().embed_query``
in production, a fake in tests) so these stay pure and offline-testable.
"""
from __future__ import annotations

from typing import Callable, Sequence

Embed = Callable[[str], Sequence[float]]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


def answer_similarity(answer: str, gold: str, embed: Embed) -> float:
    """Cosine(embed(answer), embed(gold)) — answer-quality proxy vs reference."""
    return _cosine(embed(answer), embed(gold))


def retrieval_coverage(gold: str, contexts: Sequence[str], embed: Embed) -> float:
    """Max cosine(embed(gold), embed(ctx)) over retrieved contexts.

    Proxies 'did retrieval surface content that supports the reference answer'.
    Returns 0.0 when nothing was retrieved (entity path / empty result).
    """
    if not contexts:
        return 0.0
    g = embed(gold)
    return max(_cosine(g, embed(c)) for c in contexts)
```

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/evals/test_metrics.py -q`
Expected: PASS（5 passed）

- [ ] **Step 5: 提交**

```bash
git add evals/metrics.py tests/evals/test_metrics.py
git commit -m "feat: synchronous embedding metrics for agent eval (answer_similarity, retrieval_coverage)"
```

---

## Task 2: `RAGResult` 加 `diagnostics` 字段

让结果能携带 agent 诊断（改写轮数），默认空 → 一次性路径不受影响。

**Files:**
- Modify: `contract_rag/retrieval/graph.py:53-60`（`RAGResult` dataclass）
- Test: `tests/retrieval/test_graph_sources.py`（追加一条）

- [ ] **Step 1: 写失败测试**

在 `tests/retrieval/test_graph_sources.py` 末尾追加：
```python
def test_ragresult_diagnostics_defaults_empty():
    res = graph.RAGResult("q", "clause", "a", ["ctx"], [{"contract_id": "x"}])
    assert res.diagnostics == {}
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_sources.py::test_ragresult_diagnostics_defaults_empty -q`
Expected: FAIL — `AttributeError: 'RAGResult' object has no attribute 'diagnostics'`

- [ ] **Step 3: 实现**

`graph.py`，给 `RAGResult` 加字段（需 `from dataclasses import dataclass, field`，当前只 import 了 `dataclass`，补 `field`）：
```python
@dataclass(frozen=True)
class RAGResult:
    question: str
    question_class: str          # "entity" | "clause" | "comparison"
    answer: str
    contexts: list[str]          # retrieved chunk text (RAGAS consumes this); [] for entity
    sources: list[dict]          # [{contract_id, chunk_type, page_start, page_end, section_path, content}]
    diagnostics: dict = field(default_factory=dict)   # agent-only: {"iterations": <retrieval rounds>}
```
顶部 import 改：`from dataclasses import dataclass, field`。

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_sources.py -q`
Expected: PASS（含原有 4 条 + 新 1 条）

- [ ] **Step 5: 提交**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/test_graph_sources.py
git commit -m "feat: add optional diagnostics field to RAGResult (agent rewrite count)"
```

---

## Task 3: `_state_to_result` 纯组装函数

把「终态 → RAGResult」抽成纯函数，单测覆盖 clause / entity 两路。

**Files:**
- Modify: `contract_rag/retrieval/graph.py`（新增 `_state_to_result`，紧跟 `_doc_to_source` 之后）
- Test: `tests/retrieval/test_graph_agent.py`（新建）

- [ ] **Step 1: 写失败测试**

`tests/retrieval/test_graph_agent.py`：
```python
from langchain_core.documents import Document

from contract_rag.retrieval import graph


def _doc(content, **meta):
    return Document(page_content=content, metadata=meta)


def test_state_to_result_clause_path():
    docs = [_doc("Net 30 days.", contract_id="2026004", chunk_type="clause",
                 page_start=3, page_end=3, section_path="4 Payment")]
    state = {
        "original_question": "付款账期？",
        "question": "付款条款是几天？",   # rewritten — must NOT leak into result
        "question_class": "clause",
        "documents": docs,
        "generation": "Net 30.",
        "iterations": 2,
    }
    res = graph._state_to_result(state)
    assert res.question == "付款账期？"          # original, not rewritten
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"
    assert res.diagnostics == {"iterations": 2}


def test_state_to_result_entity_path(monkeypatch):
    monkeypatch.setattr(graph.db, "list_contracts",
                        lambda: [{"contract_id": "2026004"}])
    state = {
        "original_question": "谁是买方？",
        "question": "谁是买方？",
        "question_class": "entity",
        "documents": [],
        "generation": "China Jushi USA。",
        "iterations": 0,
    }
    res = graph._state_to_result(state)
    assert res.question_class == "entity"
    assert res.contexts == []
    assert res.sources == [{"contract_id": "2026004"}]
    assert res.diagnostics == {"iterations": 0}
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: FAIL — `AttributeError: module 'contract_rag.retrieval.graph' has no attribute '_state_to_result'`

- [ ] **Step 3: 实现**

`graph.py`，在 `_doc_to_source` 之后新增：
```python
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
    if qclass in ("entity", "comparison"):
        sources = [{"contract_id": c["contract_id"]} for c in db.list_contracts()]
        contexts: list[str] = []
    else:
        sources = [_doc_to_source(d) for d in docs]
        contexts = [d.page_content for d in docs]
    return RAGResult(
        state["original_question"], qclass, state["generation"],
        contexts, sources, diagnostics,
    )
```

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: PASS（2 passed）

- [ ] **Step 5: 提交**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/test_graph_agent.py
git commit -m "feat: _state_to_result — assemble RAGResult from agent final state"
```

---

## Task 4: classify 节点 + 把检索参数穿进 state

消除 `_classify_edge` 的二次分类；让 agent 能 scope 到合同（修 `_clause_retrieve_node` 现在不带任何参数的缺陷）。

**Files:**
- Modify: `contract_rag/retrieval/graph.py`（`ContractRAGState`、`_classify_node`、`_clause_retrieve_node`、`_generate_node`、`ContractRAGAgent._build`）
- Test: `tests/retrieval/test_graph_agent.py`（追加节点级单测）

- [ ] **Step 1: 写失败测试**

在 `tests/retrieval/test_graph_agent.py` 末尾追加：
```python
def test_classify_node_writes_question_class(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    out = graph._classify_node({"question": "付款账期？"})
    assert out == {"question_class": "clause"}


def test_clause_retrieve_node_threads_params(monkeypatch):
    captured = {}

    def _fake_retrieve(q, **kw):
        captured.update(question=q, **kw)
        return [_doc("Net 30 days.", contract_id="2026004")]

    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)
    state = {
        "question": "付款条款？", "iterations": 0,
        "contract_id": "2026004", "alpha": 0.7, "use_reranker": False,
    }
    out = graph._clause_retrieve_node(state)
    assert captured["question"] == "付款条款？"
    assert captured["contract_id"] == "2026004"
    assert captured["alpha"] == 0.7
    assert captured["use_reranker"] is False
    assert out["iterations"] == 1
    assert out["context"] == "Net 30 days."


def test_generate_node_reads_temperature(monkeypatch):
    seen = {}

    class _FakeOut:
        content = "Net 30."

    class _FakeChat:
        def invoke(self, _prompt):
            return _FakeOut()

    def _fake_get_chat(self, model, temperature=None):
        seen["temperature"] = temperature
        return _FakeChat()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object", _fake_get_chat)
    out = graph._generate_node({"context": "Net 30 days.", "question": "账期？",
                                "temperature": 0})
    assert out == {"generation": "Net 30."}
    assert seen["temperature"] == 0
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: FAIL — `_classify_node` 不存在 / `_clause_retrieve_node` 不读 `contract_id`（`TypeError` 或断言失败）。

- [ ] **Step 3: 实现**

`graph.py`。先扩 state（替换现有 `ContractRAGState`）：
```python
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
```

加 `_classify_node`，并把旧的 `_classify_edge` 改成读 state（替换现有 `_classify_edge`）：
```python
def _classify_node(state: ContractRAGState) -> dict:
    return {"question_class": classify_query(state["question"])}


def _route_after_classify(state: ContractRAGState) -> str:
    return "entity" if state["question_class"] in ("entity", "comparison") else "clause"
```

`_clause_retrieve_node` 改为穿参：
```python
def _clause_retrieve_node(state: ContractRAGState) -> dict:
    docs = retrieve(
        state["question"],
        contract_id=state.get("contract_id"),
        alpha=state.get("alpha"),
        use_reranker=state.get("use_reranker"),
    )
    return {
        "documents": docs,
        "context": "\n\n".join(d.page_content for d in docs),
        "iterations": state.get("iterations", 0) + 1,
    }
```

`_generate_node` 改为读 temperature：
```python
def _generate_node(state: ContractRAGState) -> dict:
    out = LLM().get_custom_chat_object(
        load_config().models.rag_generate, temperature=state.get("temperature")
    ).invoke(_ANSWER_PROMPT.format(document=state["context"], question=state["question"]))
    return {"generation": extract_text(out.content)}
```

`ContractRAGAgent._build` 改为先过 classify 节点（替换现有 `_build`）：
```python
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
```
删除旧的 `_classify_edge` 函数（已被 `_classify_node` + `_route_after_classify` 取代）。

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: PASS（5 passed：含 Task 3 的 2 条）

- [ ] **Step 5: 提交**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/test_graph_agent.py
git commit -m "feat: classify node + thread retrieve params through agent state"
```

---

## Task 5: `agent_answer_with_sources` + `invoke` 委托

对外入口：跑图 → `_state_to_result`。`@lru_cache` 缓存编译后的 agent。`invoke` 退化为取 `.answer`。

**Files:**
- Modify: `contract_rag/retrieval/graph.py`（新增 `_compiled_agent`、`agent_answer_with_sources`；改 `ContractRAGAgent.invoke`）
- Test: `tests/retrieval/test_graph_agent.py`（追加端到端 mock 测试）

- [ ] **Step 1: 写失败测试**

在 `tests/retrieval/test_graph_agent.py` 末尾追加（全 mock，离线跑真实 LangGraph）：
```python
def _fake_chat_by_prompt():
    """One fake chat: 'true' for the sufficiency prompt, else a canned answer."""
    class _Out:
        def __init__(self, content):
            self.content = content

    class _Chat:
        def invoke(self, prompt):
            text = prompt if isinstance(prompt, str) else str(prompt)
            return _Out("true" if "足够" in text else "Net 30.")
    return _Chat()


def test_agent_answer_with_sources_clause(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(
        graph, "retrieve",
        lambda q, **kw: [_doc("Net 30 days.", contract_id="2026004",
                              chunk_type="clause", page_start=3, page_end=3,
                              section_path="4 Payment")],
    )
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _fake_chat_by_prompt())
    graph._compiled_agent.cache_clear()

    res = graph.agent_answer_with_sources("付款账期？", contract_id="2026004")
    assert res.question == "付款账期？"
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"
    assert res.diagnostics["iterations"] == 1   # sufficient on first pass, no rewrite


def test_agent_invoke_returns_answer_string(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "retrieve",
                        lambda q, **kw: [_doc("Net 30 days.", contract_id="2026004")])
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _fake_chat_by_prompt())
    graph._compiled_agent.cache_clear()

    assert graph.ContractRAGAgent().invoke("付款账期？") == "Net 30."
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: FAIL — `agent_answer_with_sources` / `_compiled_agent` 不存在。

- [ ] **Step 3: 实现**

`graph.py`，在 `ContractRAGAgent` 类之后新增：
```python
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
    ))
    return _state_to_result(final)
```
并把 `ContractRAGAgent.invoke` 改为委托（替换现有 `invoke`）：
```python
    def invoke(self, question: str) -> str:
        return agent_answer_with_sources(question).answer
```
注：`ContractRAGAgent.__init__` 仍编译自有 `self.graph`（保留向后兼容）；`agent_answer_with_sources` 走 `_compiled_agent()` 共享缓存。

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_agent.py -q`
Expected: PASS（7 passed）

- [ ] **Step 5: 全量单元闸不回归**

Run: `.venv/bin/python -m pytest -q`
Expected: PASS（原 175 + 新增，全绿）

- [ ] **Step 6: 提交**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/test_graph_agent.py
git commit -m "feat: agent_answer_with_sources — structured agentic RAG result; invoke delegates"
```

---

## Task 6: 对比 runner（`evals/run_agent_compare.py`）

oneshot vs agent，同步双指标，断点续跑缓存。默认单跑；`--repeats N` 上 x3 复用 `compare.py`。

**Files:**
- Create: `evals/run_agent_compare.py`
- Test: `tests/evals/test_run_agent_compare.py`

**说明（成本代理）**：每 case 记 `question_class` + `iterations`，派生近似 LLM 调用数：entity/comparison=2（classify+lookup）；clause=`3 + 2*(iterations-1)`（base round = classify+sufficiency+generate=3，每多一轮检索 +1 sufficiency +1 rewrite）。命中 `MAX_REWRITES` 上限的那轮会少一次 sufficiency，此公式略高估（明确为近似）。

- [ ] **Step 1: 写失败测试**

`tests/evals/test_run_agent_compare.py`（全 mock，不打网络/Weaviate）：
```python
"""Resume / max-runs / report logic for the agent-vs-oneshot runner (all live calls mocked)."""
import json

from evals import run_agent_compare as rac
from evals.dataset import GoldCase
from contract_rag.retrieval.graph import RAGResult


def _setup(monkeypatch, tmp_path):
    monkeypatch.setattr(rac, "_REPORTS", tmp_path)
    monkeypatch.setattr(rac, "_CACHE", tmp_path / "_agent_compare_cache.json")
    monkeypatch.setattr(rac, "_preflight", lambda: None)
    monkeypatch.setattr(rac, "load_dataset",
                        lambda _p: [GoldCase("付款账期？", "Net 30 days.", "2026004")])
    # deterministic embed: identical text -> sim 1.0
    monkeypatch.setattr(rac, "_embed_fn", lambda: (lambda t: [1.0, 0.0]))

    monkeypatch.setattr(rac, "answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}]))
    monkeypatch.setattr(rac, "agent_answer_with_sources", lambda q, **kw: RAGResult(
        q, "clause", "Net 30 days.", ["Net 30 days."],
        [{"contract_id": "2026004"}], {"iterations": 1}))


def test_max_runs_caps_invocation(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    rac.main(["--reset", "--max-runs", "1"])     # only 1 of the 2 arms this call
    cache = json.loads((tmp_path / "_agent_compare_cache.json").read_text())
    assert len(cache) == 1


def test_resume_then_report(monkeypatch, tmp_path):
    _setup(monkeypatch, tmp_path)
    rac.main(["--reset", "--max-runs", "1"])     # arm 1
    rac.main(["--max-runs", "1"])                # arm 2 -> both cached -> report
    reports = [p for p in tmp_path.glob("*.json") if "cache" not in p.name]
    assert len(reports) == 1
    report = json.loads(reports[0].read_text())
    assert report["experiment"] == "agent-vs-oneshot"
    assert report["arms"]["oneshot"]["answer_similarity"] == 1.0
    assert report["arms"]["agent"]["answer_similarity"] == 1.0
    assert report["arms"]["agent"]["mean_iterations"] == 1.0
```

- [ ] **Step 2: 运行确认失败**

Run: `.venv/bin/python -m pytest tests/evals/test_run_agent_compare.py -q`
Expected: FAIL — `No module named 'evals.run_agent_compare'`

- [ ] **Step 3: 实现**

`evals/run_agent_compare.py`：
```python
"""Agent vs one-shot RAG comparison on the 2026004 gold set — RESUMABLE.

Two arms (oneshot, agent), each scored on synchronous embedding metrics
(answer_similarity + retrieval_coverage) — NOT ragas evaluate(), which hangs on
this Vertex async stack (see memory/retrieval_eval.md). Default single pass to
see signal; ``--repeats N`` runs each arm N times and adds mean±std +
significance (reusing evals/compare.py).

Each (arm, repeat) is cached to evals/reports/_agent_compare_cache.json the
moment it finishes, so a killed process only loses the in-flight cell. Run in
your own terminal (background tasks get killed here):

    .venv/bin/python -m evals.run_agent_compare              # single pass
    .venv/bin/python -m evals.run_agent_compare --repeats 3  # x3 + significance
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys

from contract_rag.llm import LLM
from contract_rag.retrieval.graph import answer_with_sources, agent_answer_with_sources
from contract_rag.storage import vector_store
from evals.compare import aggregate_runs, is_significant
from evals.dataset import load_dataset
from evals.metrics import answer_similarity, retrieval_coverage
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_2026004.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CACHE = _REPORTS / "_agent_compare_cache.json"
_CONTRACT_ID = "2026004"
_ARMS = ("oneshot", "agent")
_WINNER_METRIC = "answer_similarity"


def _embed_fn():
    return LLM().get_embedding_object().embed_query


def _preflight() -> None:
    try:
        n = vector_store.count_contract(_CONTRACT_ID)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if n == 0:
        sys.exit(f"[preflight] no chunks for {_CONTRACT_ID} — ingest the corpus first.")
    print(f"[preflight] {n} chunks for {_CONTRACT_ID} — OK")


def _load_cache() -> dict:
    return json.loads(_CACHE.read_text(encoding="utf-8")) if _CACHE.exists() else {}


def _save_cache(cache: dict) -> None:
    _REPORTS.mkdir(parents=True, exist_ok=True)
    _CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")


def _llm_calls(question_class: str, iterations: int) -> int:
    """Approximate LLM-call count (cost proxy). See module/plan note."""
    if question_class in ("entity", "comparison"):
        return 2
    return 3 + 2 * max(iterations - 1, 0)


def _run_arm(arm: str, cases, embed) -> dict:
    fn = answer_with_sources if arm == "oneshot" else agent_answer_with_sources
    sims, covs, iters, calls = [], [], [], []
    for c in cases:
        res = fn(c.question, contract_id=c.contract_id, temperature=0)
        sims.append(answer_similarity(res.answer, c.ground_truth, embed))
        covs.append(retrieval_coverage(c.ground_truth, res.contexts, embed))
        it = res.diagnostics.get("iterations", 0)
        iters.append(it)
        calls.append(_llm_calls(res.question_class, it))
    n = len(cases)
    return {
        "answer_similarity": sum(sims) / n,
        "retrieval_coverage": sum(covs) / n,
        "mean_iterations": sum(iters) / n,
        "llm_calls": sum(calls),
    }


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeats", type=int, default=1,
                    help="run each arm N times; N>=2 adds mean±std + significance")
    ap.add_argument("--max-runs", type=int, default=10_000,
                    help="run at most N pending (arm,repeat) cells this invocation")
    ap.add_argument("--reset", action="store_true", help="discard cache and start over")
    args = ap.parse_args(argv)

    if args.reset and _CACHE.exists():
        _CACHE.unlink()

    _preflight()
    cases = load_dataset(_DATASET)
    embed = _embed_fn()
    cache = _load_cache()
    ran = 0

    for rep in range(args.repeats):
        for arm in _ARMS:
            key = f"{arm}:{rep}"
            if key in cache:
                continue
            if ran >= args.max_runs:
                done = len(cache)
                print(f"[pause] budget {args.max_runs} spent; {done} cell(s) cached. Re-run to continue.")
                return
            print(f"[run] {key}")
            cache[key] = _run_arm(arm, cases, embed)
            _save_cache(cache)
            ran += 1

    # all cells cached -> assemble report
    by_arm_runs = {arm: [cache[f"{arm}:{r}"] for r in range(args.repeats)] for arm in _ARMS}
    arms = {arm: aggregate_runs(runs) if args.repeats > 1 else runs[0]
            for arm, runs in by_arm_runs.items()}
    report = {
        "experiment": "agent-vs-oneshot",
        "contract_id": _CONTRACT_ID,
        "n_cases": len(cases),
        "repeats": args.repeats,
        "winner_metric": _WINNER_METRIC,
        "arms": arms,
    }
    if args.repeats > 1:
        report["agent_significant_vs_oneshot"] = is_significant(
            by_arm_runs["agent"], by_arm_runs["oneshot"], metric=_WINNER_METRIC)

    out = write_report(report, out_dir=_REPORTS)

    print("\n=== agent vs oneshot ===")
    for arm in _ARMS:
        a = by_arm_runs[arm][0] if args.repeats == 1 else aggregate_runs(by_arm_runs[arm])
        print(f"  {arm:8s} {a}")
    if args.repeats > 1:
        print(f"agent significant vs oneshot ({_WINNER_METRIC}): "
              f"{report['agent_significant_vs_oneshot']}")
    print(f"[agent-compare] report written: {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: 运行确认通过**

Run: `.venv/bin/python -m pytest tests/evals/test_run_agent_compare.py -q`
Expected: PASS（2 passed）

- [ ] **Step 5: 全量单元闸不回归**

Run: `.venv/bin/python -m pytest -q`
Expected: PASS（全绿）

- [ ] **Step 6: 提交**

```bash
git add evals/run_agent_compare.py tests/evals/test_run_agent_compare.py
git commit -m "feat: agent-vs-oneshot comparison runner (resumable, sync dual metrics)"
```

---

## Task 7: 手动跑评测 + 结论写回 memory

代码完成后，由用户在自己终端跑（本环境后台任务会被 kill）。

**Files:**
- Modify: `memory/retrieval_eval.md`（新增一节记录 agent vs oneshot 结果）

- [ ] **Step 1: 用户在终端单跑一轮**

交给用户执行（前置：Weaviate 在跑、2026004 已入库 45 chunk）：
```
.venv/bin/python -m evals.run_agent_compare
```
读控制台两 arm 的 `answer_similarity` / `retrieval_coverage` / `mean_iterations` / `llm_calls`，以及写出的报告 JSON。

- [ ] **Step 2: 判断信号**

- 若 agent 的 `answer_similarity` 或 `retrieval_coverage` 明显高于 oneshot（超出噪声）→ 让用户再跑 `--repeats 3` 确认显著性。
- 若两者持平或 agent 更差 → 记录「现成 agent 循环对这份语料无正向增量」，API 维持一次性。

- [ ] **Step 3: 结论写回 memory**

在 `memory/retrieval_eval.md` 新增一节「Agent vs 一次性（2026-06-15）」，记录：双指标对比表、agent 成本（mean_iterations / llm_calls）、是否显著、API 切换决策（切 / 不切 / 加 mode 开关）。更新 `memory/MEMORY.md` 该文件的索引描述（若结论改变下一步走向）。

- [ ] **Step 4: 提交**

```bash
git add memory/retrieval_eval.md memory/MEMORY.md
git commit -m "docs: record agent-vs-oneshot eval result + API decision"
```

---

## Self-Review

**Spec coverage（§ → task）**：
- §3.1 Agent 返回 RAGResult → Task 2（diagnostics）+ Task 3（_state_to_result）+ Task 4（classify 节点/穿参）+ Task 5（agent_answer_with_sources/invoke）✅
- §3.2 同步双指标 → Task 1 ✅
- §3.3 对比 runner（单跑 + --repeats + 成本代理）→ Task 6 ✅
- §6 测试矩阵 → metrics 单测（T1）、_state_to_result 单测（T3）、节点单测（T4）、runner mock 单测（T6）；集成入口不进闸 ✅
- §7 运行 + §8 验收 + 结论写回 → Task 7 ✅
- §2 非目标（API 不动 / 不改循环 / token 推迟）→ 计划中无对应改动，符合 ✅

**Placeholder 扫描**：无 TBD/TODO；每个 code step 给了完整代码与确切命令/预期。✅

**类型一致性**：`RAGResult(question, question_class, answer, contexts, sources, diagnostics)` 字段顺序在 Task 2 定义、Task 3/6 构造一致；`agent_answer_with_sources(question, *, contract_id, alpha, use_reranker, temperature)` 签名在 Task 5 定义、Task 6 调用一致（runner 只传 `contract_id`/`temperature`，其余取默认）；`_state_to_result`/`_classify_node`/`_route_after_classify`/`_clause_retrieve_node`/`_generate_node`/`_compiled_agent` 命名跨 Task 一致。✅
