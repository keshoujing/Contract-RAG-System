# RAG Wiring + RAGAS Eval Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing one-shot RAG into a `POST /api/query` endpoint that returns answers with cited sources, and stand up a regression-able RAGAS evaluation harness that produces a quality baseline on the 2026004 digital contract.

**Architecture:** Reuse `contract_rag/retrieval/graph.py`'s existing `retrieve()`/routing. Add a structured `RAGResult` return path so both the API (sources) and RAGAS (contexts) consume the same retrieval output. Model calls are tiered via config: cheap `gemini-2.5-flash-lite` for routing/judgments, `gemini-3-flash-preview` for answer generation and the RAGAS judge. Evaluation is scoped to `contract_id="2026004"` so the number is comparable to the old single-contract baseline.

**Tech Stack:** Python 3.12, FastAPI, LangChain/LangGraph, Weaviate (BYO vectors), `gemini-embedding-2`, Vertex Gemini chat models, **ragas 0.4.3**, pytest.

**Spec:** `docs/superpowers/specs/2026-06-08-rag-wiring-ragas-eval-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `contract_rag/config.yaml` | Add `models.rag_generate` + `models.rag_light` |
| `contract_rag/config.py` | `ModelsConfig` gains two fields |
| `contract_rag/llm.py` | `get_chat_object()` reads config instead of hardcoding |
| `contract_rag/retrieval/graph.py` | `RAGResult` + `answer_with_sources()`; per-step model tiering |
| `contract_rag/api/schemas.py` | `QueryRequest` / `QueryResponse` / `QuerySource` |
| `contract_rag/api/routes/query.py` | `POST /api/query` (new) |
| `contract_rag/api/app.py` | register the query router |
| `evals/__init__.py` | mark `evals` a package |
| `evals/dataset_2026004.jsonl` | 10 gold queries + reference answers (Claude drafts → user confirms) |
| `evals/dataset.py` | dataset loader (pure, testable) |
| `evals/report.py` | report builder/writer (pure, testable) |
| `evals/run_eval.py` | RAGAS runner (integration entrypoint) |
| `evals/reports/.gitkeep` | report output dir |
| `docs/INTERFACE.md` | add the retrieval endpoint contract |
| `tests/retrieval/test_graph_sources.py` | `RAGResult` / `answer_with_sources` unit tests |
| `tests/api/test_query.py` | endpoint unit tests (mocked) |
| `tests/evals/test_dataset.py` | loader unit tests |
| `tests/evals/test_report.py` | report writer unit tests |

---

## Task 1: Config — add RAG model tiers

**Files:**
- Modify: `contract_rag/config.yaml`
- Modify: `contract_rag/config.py:54-59` (`ModelsConfig`)
- Test: `tests/test_config_models.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_config_models.py`:

```python
from contract_rag.config import load_config


def test_rag_model_tiers_present():
    models = load_config().models
    assert models.rag_generate == "gemini-3-flash-preview"
    assert models.rag_light == "gemini-2.5-flash-lite"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_config_models.py -v`
Expected: FAIL — `TypeError: ModelsConfig.__init__() got an unexpected keyword argument 'rag_generate'` once YAML is edited, or `AttributeError` before. (It fails either way until both files are updated.)

- [ ] **Step 3: Add the YAML keys**

In `contract_rag/config.yaml`, under `models:`, append after `ocr_render_dpi: 200`:

```yaml
  rag_generate: gemini-3-flash-preview   # user-facing answer generation + RAGAS judge
  rag_light:    gemini-2.5-flash-lite    # classify / sufficiency / rewrite (cheap judgments)
```

- [ ] **Step 4: Add the dataclass fields**

In `contract_rag/config.py`, edit `ModelsConfig` to:

```python
@dataclass(frozen=True)
class ModelsConfig:
    vision: str
    ocr: str
    approval: str
    ocr_render_dpi: int
    rag_generate: str
    rag_light: str
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_config_models.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add contract_rag/config.yaml contract_rag/config.py tests/test_config_models.py
git commit -m "feat: add rag_generate/rag_light model tiers to config"
```

---

## Task 2: Fix `get_chat_object()` hardcoded model

**Files:**
- Modify: `contract_rag/llm.py:45-51`
- Test: `tests/test_llm_model.py` (create)

- [ ] **Step 1: Audit callers (no code change)**

Run: `grep -rn "get_chat_object" contract_rag/ src/`
Expected: confirm which modules call it. `contract_rag/retrieval/graph.py` will stop using it (Task 3). If any **ingest** module relies on `get_chat_object()`, leave that call site working — this change only redirects the default model from `gemini-3.5-flash` to the configured `rag_generate`, which is an equal-or-better model, so callers are not broken. Record findings in the commit body.

- [ ] **Step 2: Write the failing test**

Create `tests/test_llm_model.py`:

```python
from contract_rag.config import load_config
from contract_rag.llm import LLM


def test_get_chat_object_uses_configured_generate_model():
    chat = LLM().get_chat_object()
    assert chat.model == f"models/{load_config().models.rag_generate}"
```

> Note: `ChatGoogleGenerativeAI` normalizes `model="gemini-3-flash-preview"` to `chat.model == "models/gemini-3-flash-preview"`. If the local langchain version stores it unprefixed, assert `chat.model.endswith(load_config().models.rag_generate)` instead — verify with `.venv/bin/python -c "from contract_rag.llm import LLM; print(LLM().get_chat_object().model)"` and pick the matching assertion.

- [ ] **Step 3: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_llm_model.py -v`
Expected: FAIL — model is `gemini-3.5-flash`, not `gemini-3-flash-preview`.

- [ ] **Step 4: Read config in `get_chat_object`**

In `contract_rag/llm.py`, add at top of file (after existing imports):

```python
from contract_rag.config import load_config
```

Replace `get_chat_object`:

```python
    def get_chat_object(self):
        return ChatGoogleGenerativeAI(
                    model=load_config().models.rag_generate,
                    project=self.VERTEX_PROJECT_ID,
                    google_api_key=self.VERTEX_API_KEY,
                    vertexai=True,
                )
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_llm_model.py -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add contract_rag/llm.py tests/test_llm_model.py
git commit -m "fix: get_chat_object reads configured model instead of hardcoded gemini-3.5-flash"
```

---

## Task 3: `RAGResult` + `answer_with_sources()` with model tiering

**Files:**
- Modify: `contract_rag/retrieval/graph.py`
- Test: `tests/retrieval/test_graph_sources.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/retrieval/__init__.py` (empty), then `tests/retrieval/test_graph_sources.py`:

```python
from langchain_core.documents import Document

from contract_rag.retrieval import graph


def _doc(content, **meta):
    return Document(page_content=content, metadata=meta)


def test_doc_to_source_maps_metadata():
    d = _doc(
        "Net 30 days.",
        contract_id="2026004", chunk_type="clause",
        page_start=3, page_end=3, section_path="4 Payment",
    )
    assert graph._doc_to_source(d) == {
        "contract_id": "2026004",
        "chunk_type": "clause",
        "page_start": 3,
        "page_end": 3,
        "section_path": "4 Payment",
        "content": "Net 30 days.",
    }


def test_answer_with_sources_clause_path(monkeypatch):
    docs = [_doc("Net 30 days.", contract_id="2026004", chunk_type="clause",
                 page_start=3, page_end=3, section_path="4 Payment")]
    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "retrieve", lambda q, **kw: docs)

    class _FakeOut:
        content = "Net 30."

    class _FakeChat:
        def invoke(self, _prompt):
            return _FakeOut()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model: _FakeChat())

    res = graph.answer_with_sources("付款账期？", contract_id="2026004")
    assert res.question_class == "clause"
    assert res.answer == "Net 30."
    assert res.contexts == ["Net 30 days."]
    assert res.sources[0]["contract_id"] == "2026004"


def test_answer_with_sources_entity_path_has_no_contexts(monkeypatch):
    monkeypatch.setattr(graph, "classify_query", lambda q: "entity")
    monkeypatch.setattr(graph, "entity_lookup", lambda q: "买方是 China Jushi USA。")
    monkeypatch.setattr(graph.db, "list_contracts",
                        lambda: [{"contract_id": "2026004"}])

    res = graph.answer_with_sources("谁是买方？")
    assert res.question_class == "entity"
    assert res.contexts == []
    assert res.sources == [{"contract_id": "2026004"}]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_sources.py -v`
Expected: FAIL — `AttributeError: module 'contract_rag.retrieval.graph' has no attribute '_doc_to_source'`.

- [ ] **Step 3: Add config import + dataclass**

In `contract_rag/retrieval/graph.py`, add to imports:

```python
from dataclasses import dataclass

from contract_rag.config import load_config
```

After the `_ENTITY_FIELDS` tuple, add:

```python
@dataclass(frozen=True)
class RAGResult:
    question: str
    question_class: str          # "entity" | "clause" | "comparison"
    answer: str
    contexts: list[str]          # retrieved chunk text (RAGAS consumes this); [] for entity
    sources: list[dict]          # [{contract_id, chunk_type, page_start, page_end, section_path, content}]


def _doc_to_source(d) -> dict:
    m = d.metadata or {}
    return {
        "contract_id": m.get("contract_id", ""),
        "chunk_type": m.get("chunk_type", ""),
        "page_start": m.get("page_start"),
        "page_end": m.get("page_end"),
        "section_path": m.get("section_path", ""),
        "content": d.page_content,
    }
```

- [ ] **Step 4: Add `answer_with_sources` and tier the existing model calls**

Replace `classify_query` body's LLM line to use the light tier. Change:

```python
def classify_query(question: str) -> str:
    out = LLM().get_chat_object().invoke(_CLASSIFY_PROMPT.format(question=question))
```

to:

```python
def classify_query(question: str) -> str:
    out = LLM().get_custom_chat_object(load_config().models.rag_light).invoke(
        _CLASSIFY_PROMPT.format(question=question)
    )
```

In `entity_lookup`, change `LLM().get_chat_object()` to `LLM().get_custom_chat_object(load_config().models.rag_generate)`.

Add `answer_with_sources` directly after the existing `answer()` function:

```python
def answer_with_sources(
    question: str, *, contract_id: str | None = None, use_reranker: bool = False
) -> RAGResult:
    """One-shot RAG returning the answer plus its retrieved sources/contexts."""
    qclass = classify_query(question)
    if qclass in ("entity", "comparison"):
        ans = entity_lookup(question)
        sources = [{"contract_id": c["contract_id"]} for c in db.list_contracts()]
        return RAGResult(question, qclass, ans, [], sources)
    docs = retrieve(question, contract_id=contract_id, use_reranker=use_reranker)
    contexts = [d.page_content for d in docs]
    out = LLM().get_custom_chat_object(load_config().models.rag_generate).invoke(
        _ANSWER_PROMPT.format(document="\n\n".join(contexts), question=question)
    )
    return RAGResult(
        question, qclass, extract_text(out.content), contexts,
        [_doc_to_source(d) for d in docs],
    )
```

Make the old `answer()` delegate (DRY — keep one code path):

```python
def answer(question: str, *, contract_id: str | None = None, use_reranker: bool = False) -> str:
    """One-shot RAG: entity/comparison -> SQLite; clause -> Weaviate."""
    return answer_with_sources(
        question, contract_id=contract_id, use_reranker=use_reranker
    ).answer
```

Tier the agent nodes too: in `_generate_node` use `rag_generate`; in `_sufficiency_edge` and `_rewrite_node` use `rag_light`. Change each `LLM().get_chat_object()` to the matching `LLM().get_custom_chat_object(load_config().models.<tier>)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/retrieval/test_graph_sources.py -v`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/
git commit -m "feat: RAGResult + answer_with_sources with per-step model tiering"
```

---

## Task 4: API schemas for `/query`

**Files:**
- Modify: `contract_rag/api/schemas.py`
- Test: covered by Task 5

- [ ] **Step 1: Add schemas**

In `contract_rag/api/schemas.py`, append:

```python
class QuerySource(BaseModel):
    contract_id: str = ""
    chunk_type: str = ""
    page_start: int | None = None
    page_end: int | None = None
    section_path: str = ""
    content: str = ""


class QueryRequest(BaseModel):
    question: str = Field(min_length=1)
    contract_id: str | None = None


class QueryResponse(BaseModel):
    question: str
    question_class: str
    answer: str
    sources: list[QuerySource]
```

> If `Field` is not already imported in `schemas.py`, add `from pydantic import BaseModel, Field`. Verify the existing import line first.

- [ ] **Step 2: Sanity import check**

Run: `.venv/bin/python -c "from contract_rag.api.schemas import QueryRequest, QueryResponse, QuerySource; print('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add contract_rag/api/schemas.py
git commit -m "feat: add QueryRequest/QueryResponse schemas"
```

---

## Task 5: `POST /api/query` route

**Files:**
- Create: `contract_rag/api/routes/query.py`
- Modify: `contract_rag/api/app.py:9,32`
- Test: `tests/api/test_query.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/api/test_query.py`:

```python
from fastapi.testclient import TestClient

from contract_rag.api.app import create_app
from contract_rag.retrieval.graph import RAGResult
from contract_rag.api.routes import query as query_route


def _client():
    return TestClient(create_app())


def test_query_clause_returns_answer_and_sources(monkeypatch):
    result = RAGResult(
        question="付款账期？", question_class="clause", answer="Net 30.",
        contexts=["Net 30 days."],
        sources=[{"contract_id": "2026004", "chunk_type": "clause",
                  "page_start": 3, "page_end": 3,
                  "section_path": "4 Payment", "content": "Net 30 days."}],
    )
    monkeypatch.setattr(query_route, "answer_with_sources", lambda *a, **k: result)
    r = _client().post("/api/query", json={"question": "付款账期？", "contract_id": "2026004"})
    assert r.status_code == 200
    body = r.json()
    assert body["question_class"] == "clause"
    assert body["answer"] == "Net 30."
    assert body["sources"][0]["contract_id"] == "2026004"


def test_query_blank_question_is_422():
    r = _client().post("/api/query", json={"question": "   "})
    assert r.status_code == 422


def test_query_backend_error_is_502(monkeypatch):
    def _boom(*a, **k):
        raise RuntimeError("weaviate down")
    monkeypatch.setattr(query_route, "answer_with_sources", _boom)
    r = _client().post("/api/query", json={"question": "付款账期？"})
    assert r.status_code == 502
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/api/test_query.py -v`
Expected: FAIL — route does not exist (404), import error on `query_route`.

- [ ] **Step 3: Create the route**

Create `contract_rag/api/routes/query.py`:

```python
"""Retrieval Q&A endpoint — one-shot RAG over the contract corpus."""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from contract_rag.api.schemas import QueryRequest, QueryResponse
from contract_rag.retrieval.graph import answer_with_sources

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/query", response_model=QueryResponse)
def query(req: QueryRequest) -> QueryResponse:
    if not req.question.strip():
        raise HTTPException(status_code=422, detail="question must not be blank")
    try:
        result = answer_with_sources(req.question, contract_id=req.contract_id)
    except Exception:  # Weaviate down / empty collection / LLM failure
        logger.exception("query failed for question=%r", req.question)
        raise HTTPException(status_code=502, detail="retrieval backend unavailable")
    return QueryResponse(
        question=result.question,
        question_class=result.question_class,
        answer=result.answer,
        sources=result.sources,
    )
```

- [ ] **Step 4: Register the router**

In `contract_rag/api/app.py`, update the import line (currently line 9):

```python
from contract_rag.api.routes import conflicts, config, contracts, processing, query, uploads
```

and the registration loop (currently line 32):

```python
    for module in (uploads, contracts, processing, conflicts, config, query):
        app.include_router(module.router, prefix="/api")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/api/test_query.py -v`
Expected: PASS (3 tests). The blank-question test passes via Pydantic `min_length=1` returning 422 before the handler runs.

- [ ] **Step 6: Commit**

```bash
git add contract_rag/api/routes/query.py contract_rag/api/app.py tests/api/test_query.py
git commit -m "feat: POST /api/query retrieval endpoint"
```

---

## Task 6: Gold dataset (Claude drafts → user confirms)

**Files:**
- Create: `evals/__init__.py` (empty)
- Create: `evals/dataset_2026004.jsonl`
- Create: `evals/reports/.gitkeep` (empty)

- [ ] **Step 1: Print the 2026004 chunk inventory to ground the answers**

Run: `.venv/bin/python _retrieval_inventory.py`
Expected: a numbered list of all 2026004 chunks with section paths + previews. Use this (and the target-clause notes baked into `_retrieval_test3.py`) as the source for drafting reference answers. Do NOT invent facts — every reference answer must be traceable to a chunk's text.

- [ ] **Step 2: Create the empty package marker**

Create `evals/__init__.py` (empty file) and `evals/reports/.gitkeep` (empty file).

- [ ] **Step 3: Draft the 10 gold rows**

Create `evals/dataset_2026004.jsonl` — one JSON object per line. The 10 questions (migrated from `_retrieval_test3.py`) and their target clauses are fixed; the `ground_truth` text is **drafted from the chunk inventory** in Step 1:

```jsonl
{"question": "ChemAqua 水处理化学品的单价是多少？", "ground_truth": "<draft from price-table chunks idx 1/9/15>", "contract_id": "2026004", "note": "price tables"}
{"question": "付款账期是多少天？net payment terms", "ground_truth": "<draft from clause 4 Payment>", "contract_id": "2026004", "note": "clause 4 (net 30)"}
{"question": "合同可以怎样终止？termination", "ground_truth": "<draft from clause 17 Termination>", "contract_id": "2026004", "note": "clause 17"}
{"question": "卖方的责任上限 limitation of liability", "ground_truth": "<draft from clause 12>", "contract_id": "2026004", "note": "clause 12"}
{"question": "产品质保条款 warranty", "ground_truth": "<draft from clause 7>", "contract_id": "2026004", "note": "clause 7 Limited Warranties"}
{"question": "每年价格上涨/调价机制 price escalation", "ground_truth": "<draft from clauses 17/19>", "contract_id": "2026004", "note": "escalation / hyperinflation"}
{"question": "合同生效日期是什么时候？agreement effective date", "ground_truth": "<draft from effective-date table>", "contract_id": "2026004", "note": "effective-date table"}
{"question": "不可抗力条款 force majeure excusable delay", "ground_truth": "<draft from clause 10>", "contract_id": "2026004", "note": "clause 10 Excusable Delays"}
{"question": "适用法律和争议解决 governing law dispute", "ground_truth": "<draft from clause 18>", "contract_id": "2026004", "note": "clause 18 Governing Law"}
{"question": "保密和知识产权 confidentiality IP", "ground_truth": "<draft from clause 11>", "contract_id": "2026004", "note": "clause 11 Confidentiality & IP"}
```

Replace each `<draft ...>` with a concise factual answer pulled from the corresponding chunk text. Keep answers short (1-3 sentences) — they are reference points for the judge, not essays.

- [ ] **Step 4: USER CONFIRMATION GATE (blocking)**

Present the 10 drafted `ground_truth` answers to the user for line-by-line confirmation/correction. **Do not proceed to Task 7 until the user approves.** This is the one part of the eval that cannot be fabricated: LLM-drafted + human-verified = valid gold; unverified = invalid baseline.

- [ ] **Step 5: Commit (after user approval)**

```bash
git add evals/__init__.py evals/dataset_2026004.jsonl evals/reports/.gitkeep
git commit -m "feat: gold eval dataset for 2026004 (10 queries, user-verified)"
```

---

## Task 7: Dataset loader (pure)

**Files:**
- Create: `evals/dataset.py`
- Test: `tests/evals/test_dataset.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/evals/__init__.py` (empty), then `tests/evals/test_dataset.py`:

```python
from evals.dataset import GoldCase, load_dataset


def test_load_dataset_parses_jsonl(tmp_path):
    p = tmp_path / "ds.jsonl"
    p.write_text(
        '{"question": "Q1", "ground_truth": "A1", "contract_id": "2026004", "note": "n"}\n'
        '{"question": "Q2", "ground_truth": "A2", "contract_id": "2026004"}\n',
        encoding="utf-8",
    )
    cases = load_dataset(p)
    assert cases == [
        GoldCase(question="Q1", ground_truth="A1", contract_id="2026004", note="n"),
        GoldCase(question="Q2", ground_truth="A2", contract_id="2026004", note=""),
    ]


def test_load_dataset_rejects_missing_field(tmp_path):
    p = tmp_path / "bad.jsonl"
    p.write_text('{"question": "Q1", "contract_id": "2026004"}\n', encoding="utf-8")
    try:
        load_dataset(p)
        assert False, "expected ValueError"
    except ValueError as e:
        assert "ground_truth" in str(e)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/evals/test_dataset.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'evals.dataset'`.

- [ ] **Step 3: Implement the loader**

Create `evals/dataset.py`:

```python
"""Gold evaluation dataset loader (pure, no network)."""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass

_REQUIRED = ("question", "ground_truth", "contract_id")


@dataclass(frozen=True)
class GoldCase:
    question: str
    ground_truth: str
    contract_id: str
    note: str = ""


def load_dataset(path: str | pathlib.Path) -> list[GoldCase]:
    cases: list[GoldCase] = []
    for lineno, line in enumerate(pathlib.Path(path).read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        missing = [f for f in _REQUIRED if not row.get(f)]
        if missing:
            raise ValueError(f"line {lineno}: missing required field(s): {', '.join(missing)}")
        cases.append(GoldCase(
            question=row["question"],
            ground_truth=row["ground_truth"],
            contract_id=row["contract_id"],
            note=row.get("note", ""),
        ))
    return cases
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/evals/test_dataset.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/dataset.py tests/evals/__init__.py tests/evals/test_dataset.py
git commit -m "feat: gold dataset loader"
```

---

## Task 8: Report builder (pure)

**Files:**
- Create: `evals/report.py`
- Test: `tests/evals/test_report.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/evals/test_report.py`:

```python
import json

from evals.report import build_report, write_report


def test_build_report_shape():
    rep = build_report(
        dataset="dataset_2026004.jsonl", contract_id="2026004", n_cases=10,
        scores={"context_recall": 0.9, "faithfulness": 0.85},
    )
    assert rep["dataset"] == "dataset_2026004.jsonl"
    assert rep["contract_id"] == "2026004"
    assert rep["n_cases"] == 10
    assert rep["scores"]["context_recall"] == 0.9
    assert "timestamp" in rep


def test_write_report_writes_json(tmp_path):
    rep = {"dataset": "d", "scores": {"faithfulness": 0.8}}
    out = write_report(rep, out_dir=tmp_path)
    assert out.exists()
    assert json.loads(out.read_text(encoding="utf-8"))["scores"]["faithfulness"] == 0.8
    assert out.suffix == ".json"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/evals/test_report.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'evals.report'`.

- [ ] **Step 3: Implement the report module**

Create `evals/report.py`:

```python
"""Eval report builder + writer (pure logic; I/O confined to write_report)."""
from __future__ import annotations

import json
import pathlib
from datetime import datetime, timezone


def build_report(*, dataset: str, contract_id: str, n_cases: int, scores: dict) -> dict:
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "dataset": dataset,
        "contract_id": contract_id,
        "n_cases": n_cases,
        "scores": {k: round(float(v), 4) for k, v in scores.items()},
    }


def write_report(report: dict, *, out_dir: str | pathlib.Path) -> pathlib.Path:
    out_dir = pathlib.Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H%M%S")
    out = out_dir / f"{stamp}.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/evals/test_report.py -v`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/report.py tests/evals/test_report.py
git commit -m "feat: eval report builder/writer"
```

---

## Task 9: RAGAS runner (integration entrypoint)

**Files:**
- Create: `evals/run_eval.py`

> This task has no unit test — it orchestrates live Gemini + Weaviate. The pure pieces it depends on (loader, report) are already tested. Verification is the actual baseline run in Task 11.

- [ ] **Step 1: Implement the runner**

Create `evals/run_eval.py`:

```python
"""Run RAGAS evaluation over the gold dataset and write a timestamped report.

Requires a live Weaviate with the contract corpus ingested. Hits Vertex Gemini
for both answer generation and the RAGAS judge. Not a unit test — run manually:

    .venv/bin/python -m evals.run_eval
"""
from __future__ import annotations

import pathlib
import sys

from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.llms import LangchainLLMWrapper
from ragas.metrics import (
    Faithfulness,
    LLMContextPrecisionWithReference,
    LLMContextRecall,
    ResponseRelevancy,
    AnswerCorrectness,
)

from contract_rag.config import load_config
from contract_rag.llm import LLM
from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import vector_store
from evals.dataset import load_dataset
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

    gen_model = load_config().models.rag_generate
    judge_llm = LangchainLLMWrapper(LLM().get_custom_chat_object(gen_model))
    judge_emb = LangchainEmbeddingsWrapper(LLM().get_embedding_object())

    metrics = [
        LLMContextRecall(),
        LLMContextPrecisionWithReference(),
        Faithfulness(),
        ResponseRelevancy(),
        AnswerCorrectness(),
    ]
    result = evaluate(dataset, metrics=metrics, llm=judge_llm, embeddings=judge_emb)
    scores = dict(result._repr_dict) if hasattr(result, "_repr_dict") else dict(result)

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
```

> ⚠️ ragas 0.4.3 result object: `evaluate()` returns an `EvaluationResult`. The score-extraction line tries `_repr_dict` then `dict(result)`. Before the baseline run, confirm the exact accessor with a 1-case smoke run and adjust if neither yields a `{metric: float}` dict (e.g. use `result.to_pandas().mean(numeric_only=True).to_dict()`).

- [ ] **Step 2: Import smoke check (no live call)**

Run: `.venv/bin/python -c "import evals.run_eval; print('import ok')"`
Expected: `import ok` (imports resolve; nothing runs because of the `__main__` guard).

- [ ] **Step 3: Commit**

```bash
git add evals/run_eval.py
git commit -m "feat: RAGAS eval runner with Weaviate preflight"
```

---

## Task 10: Document the endpoint in INTERFACE.md

**Files:**
- Modify: `docs/INTERFACE.md`

- [ ] **Step 1: Add the retrieval section**

In `docs/INTERFACE.md`, add a new top-level section (after the upload-wizard section, before "Not built yet"):

```markdown
## 4. Retrieval Q&A — `POST /api/query`

One-shot RAG. `entity`/`comparison` questions are answered from SQLite (the real
source); `clause` questions hit Weaviate over clause+table chunks.

Request:
```json
{ "question": "付款账期是多少天？", "contract_id": "2026004" }
```
- `question` (required, non-blank). Blank → 422.
- `contract_id` (optional). When set, retrieval is scoped to that contract.

Response 200:
```json
{ "question": "...", "question_class": "clause",
  "answer": "...",
  "sources": [ { "contract_id": "2026004", "chunk_type": "clause",
                 "page_start": 3, "page_end": 3,
                 "section_path": "4 Payment", "content": "..." } ] }
```
- `entity`/`comparison` answers return `sources` as the contract rows consulted (contract_id only) and no chunk contexts.
- Weaviate unreachable / empty collection / LLM failure → 502.

**Scope (V1):** scoped single-contract retrieval. Open-corpus retrieval (filter a
contract_id set from SQLite, then vector search — decision 10) and real
cross-contract comparison (SQL aggregation) are not yet implemented.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INTERFACE.md
git commit -m "docs: document POST /api/query retrieval contract"
```

---

## Task 11: Produce the baseline (manual integration run)

**Files:** none (produces a report under `evals/reports/`)

- [ ] **Step 1: Confirm prerequisites**

Run: `.venv/bin/python -c "from contract_rag.storage import vector_store as v; print('2026004 chunks:', v.count_contract('2026004'))"`
Expected: a non-zero count (≈45). If 0 or connection error, start Weaviate (Docker) and ingest 2026004 first.

- [ ] **Step 2: Run the full test suite**

Run: `.venv/bin/python -m pytest tests/ -q`
Expected: all green (existing 38 + new unit tests). Eval integration is not in this suite.

- [ ] **Step 3: Run the baseline**

Run: `.venv/bin/python -m evals.run_eval`
Expected: prints 5 metric scores and writes `evals/reports/<timestamp>.json`. If the score-extraction line errors, apply the fallback from the Task 9 note and re-run.

- [ ] **Step 4: Record the baseline**

Update `memory/embedding_pitfalls.md` (or add a short note in `memory/`) with the live RAGAS baseline numbers + date, distinguishing them from the old offline cosine 90%/100%. Add a one-line pointer in `memory/MEMORY.md` if a new file is created.

- [ ] **Step 5: Commit**

```bash
git add evals/reports/ memory/
git commit -m "chore: record first RAGAS retrieval baseline for 2026004"
```

---

## Notes for the implementer

- Run every `pytest` with `.venv/bin/python -m pytest` (the project venv).
- Commit after each task — the history should read as one logical step per commit.
- Task 6 Step 4 and Task 11 are the only points needing the human/live services; everything else is offline and unit-tested.
- Do not touch the deferred scope (agent endpoint, two-step filtering, comparison, image chunks, LangSmith) — they belong to later specs.
