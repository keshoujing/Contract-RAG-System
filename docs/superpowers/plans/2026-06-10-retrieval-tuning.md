# Retrieval Tuning Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a controlled, low-noise experiment that compares retrieval knobs (`alpha` sweep + cross-encoder reranker) against the 2026004 RAGAS baseline, pick a significant winner, and make it the config-driven default.

**Architecture:** Make retrieval params config-driven (`config.yaml` `retrieval:`). Add temperature control to the chat factory so eval runs at `temperature=0`. A new `evals/run_grid.py` does a greedy 4-config search (3 cheap-metric runs to find best alpha, +1 for reranker) then confirms baseline-vs-winner with 3 full-metric runs each; pure aggregation/winner/significance logic lives in `evals/compare.py`. Concurrency is bounded (3 workers) to avoid Vertex `RESOURCE_EXHAUSTED`.

**Tech Stack:** Python 3.12, ragas 0.4.3, LangChain, Weaviate, Vertex Gemini, `BAAI/bge-reranker-v2-m3` (already in HF cache), pytest.

**Spec:** `docs/superpowers/specs/2026-06-10-retrieval-tuning-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `contract_rag/llm.py` | `get_custom_chat_object` gains optional `temperature` |
| `contract_rag/config.py` | new `RetrievalConfig` on `Config.retrieval` |
| `contract_rag/config.yaml` | new `retrieval:` section |
| `contract_rag/retrieval/graph.py` | `retrieve()` defaults read `config.retrieval`; `answer_with_sources` forwards `alpha`/`use_reranker`/`temperature` |
| `evals/compare.py` | pure: `mean_std`, `aggregate_runs`, `pick_winner`, `is_significant` |
| `evals/ragas_support.py` | shared: `build_judge`, `default_run_config`, `extract_scores`, `TokenCounter` |
| `evals/run_eval.py` | refactor to use `ragas_support` (DRY) |
| `evals/run_grid.py` | integration entrypoint: greedy grid + confirm |
| `tests/test_llm_temperature.py`, `tests/test_config_retrieval.py`, `tests/retrieval/test_retrieve_config.py`, `tests/evals/test_compare.py`, `tests/evals/test_ragas_support.py` | unit tests |
| `docs/INTERFACE.md` | one line: retrieval params are config-driven |
| `memory/retrieval_eval.md` | append experiment result |

---

## Task 1: `get_custom_chat_object` temperature

**Files:**
- Modify: `contract_rag/llm.py` (`get_custom_chat_object`)
- Test: `tests/test_llm_temperature.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_llm_temperature.py`:

```python
from contract_rag.llm import LLM


def test_custom_chat_object_sets_temperature():
    chat = LLM().get_custom_chat_object("gemini-2.5-flash", temperature=0)
    assert chat.temperature == 0


def test_custom_chat_object_default_temperature_unset():
    chat = LLM().get_custom_chat_object("gemini-2.5-flash")
    # default (None) must not force a value — langchain leaves it None
    assert chat.temperature is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_llm_temperature.py -v`
Expected: FAIL — `get_custom_chat_object() got an unexpected keyword argument 'temperature'`.

- [ ] **Step 3: Add the parameter**

In `contract_rag/llm.py`, replace `get_custom_chat_object`:

```python
    def get_custom_chat_object(self, model, *, temperature=None):
        kwargs = {}
        if temperature is not None:
            kwargs["temperature"] = temperature
        return ChatGoogleGenerativeAI(
                    model=model,
                    project=self.VERTEX_PROJECT_ID,
                    google_api_key=self.VERTEX_API_KEY,
                    vertexai=True,
                    **kwargs,
                )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_llm_temperature.py -v`
Expected: PASS (2 tests). If `chat.temperature` is `0.0` not `0`, the `== 0` assertion still holds; if the default surfaces as something other than `None` in this langchain version, change the second test to `assert chat.temperature in (None,)` after confirming with `.venv/bin/python -c "from contract_rag.llm import LLM; print(repr(LLM().get_custom_chat_object('gemini-2.5-flash').temperature))"`.

- [ ] **Step 5: Commit**

```bash
git add contract_rag/llm.py tests/test_llm_temperature.py
git commit -m "feat: optional temperature on get_custom_chat_object"
```

---

## Task 2: `RetrievalConfig`

**Files:**
- Modify: `contract_rag/config.py`
- Modify: `contract_rag/config.yaml`
- Test: `tests/test_config_retrieval.py` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/test_config_retrieval.py`:

```python
from contract_rag.config import load_config


def test_retrieval_config_defaults():
    r = load_config().retrieval
    assert r.alpha == 0.5
    assert r.use_reranker is False
    assert r.k == 20
    assert r.top_n == 5
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_config_retrieval.py -v`
Expected: FAIL — `Config` has no attribute `retrieval` (or `KeyError: 'retrieval'`).

- [ ] **Step 3: Add the YAML section**

In `contract_rag/config.yaml`, after the `weaviate:` block (before `mineru:`), add:

```yaml
retrieval:
  alpha: 0.5            # hybrid weight: 0=pure BM25, 1=pure vector (tuned by evals/run_grid.py)
  use_reranker: false   # bge-reranker-v2-m3 cross-encoder rerank of the k pool to top_n
  k: 20                 # candidates pulled from Weaviate before rerank/truncation
  top_n: 5              # final chunks kept
```

- [ ] **Step 4: Add the dataclass + loader wiring**

In `contract_rag/config.py`, add the dataclass (next to the other `@dataclass(frozen=True)` configs):

```python
@dataclass(frozen=True)
class RetrievalConfig:
    alpha: float
    use_reranker: bool
    k: int
    top_n: int
```

Add `retrieval: RetrievalConfig` to the `Config` dataclass (place it after `weaviate`):

```python
@dataclass(frozen=True)
class Config:
    chunking: ChunkingConfig
    router: RouterConfig
    paths: PathsConfig
    weaviate: WeaviateConfig
    retrieval: RetrievalConfig
    mineru: MineruConfig
    models: ModelsConfig
    excel: ExcelConfig
```

In `load_config()`, add the constructor arg (after `weaviate=...`):

```python
        retrieval=RetrievalConfig(**raw["retrieval"]),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest tests/test_config_retrieval.py -v`
Expected: PASS

- [ ] **Step 6: Run the full config test group to confirm no regression**

Run: `.venv/bin/python -m pytest tests/test_config_models.py tests/test_config_retrieval.py -v`
Expected: PASS (both files)

- [ ] **Step 7: Commit**

```bash
git add contract_rag/config.py contract_rag/config.yaml tests/test_config_retrieval.py
git commit -m "feat: config-driven retrieval params (alpha/use_reranker/k/top_n)"
```

---

## Task 3: config-driven `retrieve()` + `answer_with_sources` forwarding

**Files:**
- Modify: `contract_rag/retrieval/graph.py` (`retrieve`, `answer_with_sources`, `answer`)
- Modify: `tests/retrieval/test_graph_sources.py` (existing test's mock signature)
- Test: `tests/retrieval/test_retrieve_config.py` (create)

- [ ] **Step 1: Write the new failing tests**

Create `tests/retrieval/test_retrieve_config.py`:

```python
from contract_rag.retrieval import graph
from contract_rag.config import load_config


class _RecordingRetriever:
    """Stands in for WeaviateHybridRetriever; records construction kwargs."""
    last_kwargs = None

    def __init__(self, **kwargs):
        _RecordingRetriever.last_kwargs = kwargs

    def invoke(self, _query):
        return []


def test_retrieve_uses_config_defaults(monkeypatch):
    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _RecordingRetriever)
    graph.retrieve("q")
    cfg = load_config().retrieval
    assert _RecordingRetriever.last_kwargs["k"] == cfg.k
    assert _RecordingRetriever.last_kwargs["alpha"] == cfg.alpha


def test_retrieve_explicit_alpha_overrides_config(monkeypatch):
    monkeypatch.setattr(graph, "get_langchain_store", lambda: object())
    monkeypatch.setattr(graph, "WeaviateHybridRetriever", _RecordingRetriever)
    graph.retrieve("q", alpha=0.7)
    assert _RecordingRetriever.last_kwargs["alpha"] == 0.7


def test_answer_with_sources_forwards_alpha(monkeypatch):
    captured = {}

    def _fake_retrieve(q, **kw):
        captured.update(kw)
        return []

    monkeypatch.setattr(graph, "classify_query", lambda q: "clause")
    monkeypatch.setattr(graph, "retrieve", _fake_retrieve)

    class _FakeOut:
        content = "x"

    class _FakeChat:
        def invoke(self, _p):
            return _FakeOut()

    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _FakeChat())
    graph.answer_with_sources("q", contract_id="2026004", alpha=0.3, use_reranker=True)
    assert captured["alpha"] == 0.3
    assert captured["use_reranker"] is True
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/retrieval/test_retrieve_config.py -v`
Expected: FAIL — `retrieve` ignores config / `answer_with_sources` has no `alpha` param (TypeError).

- [ ] **Step 3: Make `retrieve()` config-driven**

In `contract_rag/retrieval/graph.py`, change `retrieve`'s signature defaults to `None` sentinels and resolve from config at the top of the body:

```python
def retrieve(
    question: str,
    *,
    k: int | None = None,
    top_n: int | None = None,
    alpha: float | None = None,
    contract_id: str | None = None,
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
    base = WeaviateHybridRetriever(
        vectorstore=store,
        k=k,
        alpha=alpha,
        filter=_chunk_type_filter(chunk_types, contract_id),
    )
    if use_reranker:
        from langchain_classic.retrievers import ContextualCompressionRetriever
        from langchain_classic.retrievers.document_compressors import CrossEncoderReranker

        reranker = CrossEncoderReranker(model=_reranker_model(), top_n=top_n)
        compression = ContextualCompressionRetriever(
            base_compressor=reranker, base_retriever=base
        )
        return compression.invoke(question)
    return base.invoke(question)[:top_n]
```

- [ ] **Step 4: Forward `alpha`/`use_reranker`/`temperature` through `answer_with_sources`**

Replace `answer_with_sources` with:

```python
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
```

Also update the legacy `answer()` wrapper signature so it stays config-driven (default `None`):

```python
def answer(question: str, *, contract_id: str | None = None, use_reranker: bool | None = None) -> str:
    """One-shot RAG: entity/comparison -> SQLite; clause -> Weaviate."""
    return answer_with_sources(
        question, contract_id=contract_id, use_reranker=use_reranker
    ).answer
```

- [ ] **Step 5: Fix the existing mock signature**

In `tests/retrieval/test_graph_sources.py`, the clause-path test monkeypatches `get_custom_chat_object` with a 2-arg lambda. `answer_with_sources` now calls it with a `temperature` kwarg. Update that line:

```python
    monkeypatch.setattr(graph.LLM, "get_custom_chat_object",
                        lambda self, model, temperature=None: _FakeChat())
```

- [ ] **Step 6: Run the retrieval tests**

Run: `.venv/bin/python -m pytest tests/retrieval/ -v`
Expected: PASS — both the new `test_retrieve_config.py` (3 tests) and the updated `test_graph_sources.py` (3 tests).

- [ ] **Step 7: Commit**

```bash
git add contract_rag/retrieval/graph.py tests/retrieval/test_retrieve_config.py tests/retrieval/test_graph_sources.py
git commit -m "feat: config-driven retrieve defaults + answer_with_sources alpha/temperature forwarding"
```

---

## Task 4: `evals/compare.py` (pure)

**Files:**
- Create: `evals/compare.py`
- Test: `tests/evals/test_compare.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/evals/test_compare.py`:

```python
import math

from evals.compare import mean_std, aggregate_runs, pick_winner, is_significant


def test_mean_std():
    m, s = mean_std([0.8, 0.9, 0.7])
    assert abs(m - 0.8) < 1e-9
    assert abs(s - math.sqrt(((0.0)**2 + 0.1**2 + 0.1**2) / 3)) < 1e-9


def test_aggregate_runs():
    runs = [{"a": 0.8, "b": 0.5}, {"a": 0.6, "b": 0.5}]
    agg = aggregate_runs(runs)
    assert abs(agg["a"][0] - 0.7) < 1e-9
    assert abs(agg["b"][0] - 0.5) < 1e-9


def test_pick_winner_respects_recall_floor():
    scores = {
        "cfgA": {"answer_correctness": 0.50, "context_recall": 0.90},
        "cfgB": {"answer_correctness": 0.60, "context_recall": 0.70},  # best correctness but recall too low
        "cfgC": {"answer_correctness": 0.55, "context_recall": 0.85},
    }
    # floor excludes cfgB (0.70 < 0.85)
    assert pick_winner(scores, metric="answer_correctness", recall_floor=0.85) == "cfgC"


def test_is_significant_non_overlapping():
    winner = [{"answer_correctness": 0.70}, {"answer_correctness": 0.72}, {"answer_correctness": 0.71}]
    baseline = [{"answer_correctness": 0.44}, {"answer_correctness": 0.45}, {"answer_correctness": 0.43}]
    assert is_significant(winner, baseline, metric="answer_correctness") is True


def test_is_significant_overlapping():
    winner = [{"answer_correctness": 0.50}, {"answer_correctness": 0.46}, {"answer_correctness": 0.48}]
    baseline = [{"answer_correctness": 0.44}, {"answer_correctness": 0.49}, {"answer_correctness": 0.47}]
    assert is_significant(winner, baseline, metric="answer_correctness") is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/evals/test_compare.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'evals.compare'`.

- [ ] **Step 3: Implement `evals/compare.py`**

```python
"""Pure aggregation / winner-selection / significance for the tuning experiment."""
from __future__ import annotations

import statistics


def mean_std(values: list[float]) -> tuple[float, float]:
    n = len(values)
    if n == 0:
        return 0.0, 0.0
    mean = sum(values) / n
    # population std (small fixed N; matches the spec's mean±std band)
    var = sum((v - mean) ** 2 for v in values) / n
    return mean, var ** 0.5


def aggregate_runs(runs: list[dict[str, float]]) -> dict[str, tuple[float, float]]:
    """[{metric: score}, ...] -> {metric: (mean, std)} across runs."""
    if not runs:
        return {}
    metrics = runs[0].keys()
    return {m: mean_std([r[m] for r in runs if m in r]) for m in metrics}


def pick_winner(
    scores_by_config: dict[str, dict[str, float]],
    *, metric: str, recall_floor: float,
    recall_metric: str = "context_recall",
) -> str:
    """Config with the highest `metric` among those whose recall >= floor."""
    eligible = {
        cfg: s for cfg, s in scores_by_config.items()
        if s.get(recall_metric, 0.0) >= recall_floor
    }
    pool = eligible or scores_by_config  # if nothing clears the floor, fall back to all
    return max(pool, key=lambda cfg: pool[cfg].get(metric, 0.0))


def is_significant(
    winner_runs: list[dict[str, float]],
    baseline_runs: list[dict[str, float]],
    *, metric: str,
) -> bool:
    """True iff winner's mean-std band sits entirely above baseline's mean+std."""
    wm, ws = mean_std([r[metric] for r in winner_runs])
    bm, bs = mean_std([r[metric] for r in baseline_runs])
    return (wm - ws) > (bm + bs)
```

- [ ] **Step 4: Run to verify they pass**

Run: `.venv/bin/python -m pytest tests/evals/test_compare.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add evals/compare.py tests/evals/test_compare.py
git commit -m "feat: pure compare helpers (mean_std/aggregate/pick_winner/is_significant)"
```

---

## Task 5: `evals/ragas_support.py` + refactor `run_eval.py` (DRY)

**Files:**
- Create: `evals/ragas_support.py`
- Modify: `evals/run_eval.py` (use the shared helpers)
- Test: `tests/evals/test_ragas_support.py` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/evals/test_ragas_support.py`:

```python
from evals.ragas_support import extract_scores, TokenCounter


class _FakeResult:
    # mimics a ragas EvaluationResult exposing a dict-like _repr_dict
    _repr_dict = {"faithfulness": 0.8563, "context_recall": 0.8}


def test_extract_scores_from_repr_dict():
    assert extract_scores(_FakeResult()) == {"faithfulness": 0.8563, "context_recall": 0.8}


class _Msg:
    def __init__(self, usage):
        self.usage_metadata = usage


class _Gen:
    def __init__(self, usage):
        self.message = _Msg(usage)


class _LLMResult:
    def __init__(self, usages):
        self.generations = [[_Gen(u)] for u in usages]


def test_token_counter_sums_usage():
    tc = TokenCounter()
    tc.on_llm_end(_LLMResult([
        {"input_tokens": 100, "output_tokens": 10},
        {"input_tokens": 50, "output_tokens": 5},
    ]))
    assert tc.input_tokens == 150
    assert tc.output_tokens == 15
    assert tc.calls == 1  # one on_llm_end call (one LLM round, 2 generations)
```

- [ ] **Step 2: Run to verify they fail**

Run: `.venv/bin/python -m pytest tests/evals/test_ragas_support.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'evals.ragas_support'`.

- [ ] **Step 3: Implement `evals/ragas_support.py`**

```python
"""Shared RAGAS wiring for the eval runners: judge, run config, score + token extraction."""
from __future__ import annotations

from langchain_core.callbacks import BaseCallbackHandler
from ragas import RunConfig
from ragas.embeddings import LangchainEmbeddingsWrapper
from ragas.llms import LangchainLLMWrapper

from contract_rag.config import load_config
from contract_rag.llm import LLM


def build_judge():
    """(judge_llm, judge_emb) at temperature=0. The judge must return plain-string
    content — gemini-3-flash-preview returns list-blocks RAGAS can't parse, so
    models.rag_judge pins gemini-2.5-flash (see memory/retrieval_eval.md)."""
    judge_model = load_config().models.rag_judge
    judge_llm = LangchainLLMWrapper(LLM().get_custom_chat_object(judge_model, temperature=0))
    judge_emb = LangchainEmbeddingsWrapper(LLM().get_embedding_object())
    return judge_llm, judge_emb


def default_run_config() -> RunConfig:
    # max_workers=3 + timeout=300 avoids Vertex RESOURCE_EXHAUSTED; max_retries/
    # max_wait keep RAGAS's defaults (10 / 60s exponential backoff), and the
    # default exception_types=(Exception,) already retries ResourceExhausted.
    return RunConfig(timeout=300, max_workers=3)


def extract_scores(result) -> dict:
    raw = dict(result._repr_dict) if hasattr(result, "_repr_dict") else dict(result)
    return {k: float(v) for k, v in raw.items()}


class TokenCounter(BaseCallbackHandler):
    """Sums LangChain usage_metadata across all LLM calls (best-effort token count)."""

    def __init__(self):
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0

    def on_llm_end(self, response, **kwargs):
        self.calls += 1
        for gen_list in getattr(response, "generations", []):
            for gen in gen_list:
                msg = getattr(gen, "message", None)
                usage = getattr(msg, "usage_metadata", None) if msg is not None else None
                if usage:
                    self.input_tokens += usage.get("input_tokens", 0)
                    self.output_tokens += usage.get("output_tokens", 0)
```

- [ ] **Step 4: Refactor `run_eval.py` to use the shared helpers**

In `evals/run_eval.py`, replace the judge/run_config/score block. Remove the now-unused direct imports (`RunConfig`, `LangchainLLMWrapper`, `LangchainEmbeddingsWrapper`, `load_config`, `LLM`) if they become unused, and add `from evals.ragas_support import build_judge, default_run_config, extract_scores`. The `main()` body becomes:

```python
    judge_llm, judge_emb = build_judge()
    result = evaluate(
        dataset, metrics=metrics, llm=judge_llm, embeddings=judge_emb,
        run_config=default_run_config(),
    )
    scores = extract_scores(result)
```

(Keep the rest of `run_eval.py` — preflight, dataset load, sample build, print, report write — unchanged. Verify the file still imports `evaluate`, `SingleTurnSample`, `EvaluationDataset`, and the metrics.)

- [ ] **Step 5: Run unit tests + import smoke**

Run: `.venv/bin/python -m pytest tests/evals/test_ragas_support.py -v`
Expected: PASS (2 tests)
Run: `.venv/bin/python -c "import evals.run_eval; print('import ok')"`
Expected: `import ok`

- [ ] **Step 6: Commit**

```bash
git add evals/ragas_support.py evals/run_eval.py tests/evals/test_ragas_support.py
git commit -m "refactor: shared ragas_support (judge/run_config/scores/token counter); run_eval uses it"
```

---

## Task 6: `evals/run_grid.py` (integration entrypoint)

**Files:**
- Create: `evals/run_grid.py`

> No unit test — orchestrates live Gemini + Weaviate + reranker. Pure logic is in `compare.py` (tested). Verification is an import smoke check + the real run in Task 7.

- [ ] **Step 1: Implement `evals/run_grid.py`**

```python
"""Greedy retrieval-tuning experiment over the 2026004 gold set.

Phase 1 (cheap, 2 metrics): sweep alpha at reranker=off, then reranker=on at the
best alpha -> 4 configs. Phase 2 (full 5 metrics, x3 each): confirm baseline vs
winner with mean±std + significance.

    .venv/bin/python -m evals.run_grid
"""
from __future__ import annotations

import pathlib
import sys

from ragas import EvaluationDataset, SingleTurnSample, evaluate
from ragas.metrics import (
    AnswerCorrectness,
    Faithfulness,
    LLMContextPrecisionWithReference,
    LLMContextRecall,
    ResponseRelevancy,
)

from contract_rag.retrieval.graph import answer_with_sources
from contract_rag.storage import vector_store
from evals.compare import aggregate_runs, is_significant, pick_winner
from evals.dataset import load_dataset
from evals.ragas_support import TokenCounter, build_judge, default_run_config, extract_scores
from evals.report import write_report

_DATASET = pathlib.Path(__file__).parent / "dataset_2026004.jsonl"
_REPORTS = pathlib.Path(__file__).parent / "reports"
_CONTRACT_ID = "2026004"
_ALPHAS = [0.3, 0.5, 0.7]
_BASELINE_ALPHA = 0.5
_RECALL_DROP = 0.05
_CONFIRM_REPEATS = 3


def _preflight() -> None:
    try:
        n = vector_store.count_contract(_CONTRACT_ID)
    except Exception as e:  # noqa: BLE001
        sys.exit(f"[preflight] cannot reach Weaviate: {e!r}\nStart Docker/Weaviate first.")
    if n == 0:
        sys.exit(f"[preflight] no chunks for {_CONTRACT_ID} — ingest the corpus first.")
    print(f"[preflight] {n} chunks for {_CONTRACT_ID} — OK")


def _run_config(cases, *, alpha, use_reranker, metrics, judge, run_config, counter):
    judge_llm, judge_emb = judge
    samples = []
    for c in cases:
        res = answer_with_sources(
            c.question, contract_id=c.contract_id,
            alpha=alpha, use_reranker=use_reranker, temperature=0,
        )
        samples.append(SingleTurnSample(
            user_input=c.question, retrieved_contexts=res.contexts,
            response=res.answer, reference=c.ground_truth,
        ))
    result = evaluate(
        EvaluationDataset(samples=samples), metrics=metrics,
        llm=judge_llm, embeddings=judge_emb, run_config=run_config,
        callbacks=[counter],
    )
    return extract_scores(result)


def main() -> None:
    _preflight()
    cases = load_dataset(_DATASET)
    judge = build_judge()
    run_config = default_run_config()
    counter = TokenCounter()
    grid_metrics = [LLMContextRecall(), AnswerCorrectness()]
    full_metrics = [
        LLMContextRecall(), LLMContextPrecisionWithReference(),
        Faithfulness(), ResponseRelevancy(), AnswerCorrectness(),
    ]

    # ---- Phase 1: greedy 4-config search (configs run sequentially) ----
    phase1 = {}
    for a in _ALPHAS:
        label = f"alpha={a},rerank=off"
        print(f"[phase1] {label}")
        phase1[label] = _run_config(
            cases, alpha=a, use_reranker=False,
            metrics=grid_metrics, judge=judge, run_config=run_config, counter=counter,
        )
    baseline_recall = phase1[f"alpha={_BASELINE_ALPHA},rerank=off"]["context_recall"]
    recall_floor = baseline_recall - _RECALL_DROP

    best_alpha_label = pick_winner(
        phase1, metric="answer_correctness", recall_floor=recall_floor)
    best_alpha = float(best_alpha_label.split("=")[1].split(",")[0])

    rerank_label = f"alpha={best_alpha},rerank=on"
    print(f"[phase1] {rerank_label}")
    phase1[rerank_label] = _run_config(
        cases, alpha=best_alpha, use_reranker=True,
        metrics=grid_metrics, judge=judge, run_config=run_config, counter=counter,
    )

    winner_label = pick_winner(phase1, metric="answer_correctness", recall_floor=recall_floor)
    winner_alpha = float(winner_label.split("=")[1].split(",")[0])
    winner_rerank = winner_label.endswith("on")
    baseline_label = f"alpha={_BASELINE_ALPHA},rerank=off"

    # ---- Phase 2: confirm baseline vs winner, full metrics, x3 ----
    def _repeat(alpha, use_reranker):
        return [
            _run_config(cases, alpha=alpha, use_reranker=use_reranker,
                        metrics=full_metrics, judge=judge, run_config=run_config, counter=counter)
            for _ in range(_CONFIRM_REPEATS)
        ]

    print(f"[phase2] baseline {baseline_label} x{_CONFIRM_REPEATS}")
    baseline_runs = _repeat(_BASELINE_ALPHA, False)
    if winner_label == baseline_label:
        winner_runs = baseline_runs
    else:
        print(f"[phase2] winner {winner_label} x{_CONFIRM_REPEATS}")
        winner_runs = _repeat(winner_alpha, winner_rerank)

    significant = is_significant(winner_runs, baseline_runs, metric="answer_correctness")

    report = {
        "experiment": "retrieval-tuning",
        "contract_id": _CONTRACT_ID,
        "n_cases": len(cases),
        "phase1_scores": phase1,
        "winner": winner_label,
        "baseline": baseline_label,
        "phase2_baseline_meanstd": aggregate_runs(baseline_runs),
        "phase2_winner_meanstd": aggregate_runs(winner_runs),
        "answer_correctness_significant": significant,
        "token_usage": {
            "input_tokens": counter.input_tokens,
            "output_tokens": counter.output_tokens,
            "llm_calls": counter.calls,
        },
    }
    out = write_report(report, out_dir=_REPORTS)

    print("\n=== phase1 (answer_correctness / context_recall) ===")
    for label, s in phase1.items():
        print(f"  {label:28s} correctness={s.get('answer_correctness', 0):.4f} "
              f"recall={s.get('context_recall', 0):.4f}")
    print(f"\nwinner: {winner_label}  significant_vs_baseline: {significant}")
    print(f"tokens: in={counter.input_tokens} out={counter.output_tokens} calls={counter.calls}")
    print(f"[grid] report written: {out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Import smoke check (no live run)**

Run: `.venv/bin/python -c "import evals.run_grid; print('import ok')"`
Expected: `import ok`

- [ ] **Step 3: Commit**

```bash
git add evals/run_grid.py
git commit -m "feat: greedy retrieval-tuning grid runner (alpha sweep + reranker, bounded concurrency)"
```

---

## Task 7: Run the experiment, apply the winner, record results

**Files:** `contract_rag/config.yaml` (maybe), `memory/retrieval_eval.md`, a new `evals/reports/grid-*.json`

> Manual/integration. Live Gemini + Weaviate + reranker.

- [ ] **Step 1: Verify reranker loads (one-time, cached)**

Run: `.venv/bin/python -c "from langchain_community.cross_encoders import HuggingFaceCrossEncoder; HuggingFaceCrossEncoder(model_name='BAAI/bge-reranker-v2-m3'); print('reranker ok')"`
Expected: `reranker ok` (model already in `~/.cache/huggingface`).

- [ ] **Step 2: Confirm prerequisites**

Run: `.venv/bin/python -c "from contract_rag.storage import vector_store as v; print('2026004 chunks:', v.count_contract('2026004')); v.close_client()"`
Expected: non-zero (≈45). Start Weaviate if not.

- [ ] **Step 3: Full unit suite green**

Run: `.venv/bin/python -m pytest tests/ -q`
Expected: all pass.

- [ ] **Step 4: Run the experiment**

Run: `.venv/bin/python -m evals.run_grid`
Expected: phase1 table (4 configs), a winner, phase2 significance, real token counts, and a `evals/reports/grid-<ts>.json`. Bounded to 3 workers — expect ~30-40 min; should not hit `RESOURCE_EXHAUSTED` (retries absorb transient 429s).

- [ ] **Step 5: Apply the winner (only if significant)**

If `answer_correctness_significant` is `true`, edit `contract_rag/config.yaml` `retrieval:` to the winner's `alpha`/`use_reranker`. If not significant, leave `retrieval:` at the baseline (`alpha: 0.5`, `use_reranker: false`).

- [ ] **Step 6: Record results in memory**

Append a section to `memory/retrieval_eval.md` with: date, the 4-config phase-1 table, the winner, phase-2 baseline-vs-winner mean±std on `answer_correctness`, whether it was significant, the decision (config changed or not), and the real token count. Keep it factual and short.

- [ ] **Step 7: Commit**

```bash
git add evals/reports/ memory/retrieval_eval.md contract_rag/config.yaml
git commit -m "chore: retrieval-tuning experiment results + winner config (2026004)"
```

---

## Task 8: Document config-driven retrieval in INTERFACE.md

**Files:** `docs/INTERFACE.md`

> ⚠️ `docs/INTERFACE.md` carries unrelated uncommitted WIP (a `term_months` section). Do NOT `git add docs/INTERFACE.md` wholesale. Stage only this change: `git stash push -- docs/INTERFACE.md`, make the edit on the clean file, commit, then `git stash pop` to restore the WIP. (Back up first: `git diff docs/INTERFACE.md > /tmp/interface_wip.patch`.)

- [ ] **Step 1: Stash the WIP**

```bash
git diff docs/INTERFACE.md > /tmp/interface_wip.patch
git stash push -- docs/INTERFACE.md
```

- [ ] **Step 2: Add one line to the `## 4. Retrieval Q&A` section**

In `docs/INTERFACE.md`, under the `## 4. Retrieval Q&A — POST /api/query` section's **Scope (V1)** paragraph, append:

```markdown
- **Retrieval params** (`alpha`, `use_reranker`, `k`, `top_n`) are config-driven via
  `contract_rag/config.yaml` `retrieval:`, tuned by `evals/run_grid.py`. `POST /api/query`
  uses these defaults; callers may still override `contract_id`.
```

- [ ] **Step 3: Commit, then restore WIP**

```bash
git add docs/INTERFACE.md
git commit -m "docs: note config-driven retrieval params in INTERFACE"
git stash pop
```

Confirm `git status` shows the `term_months` WIP restored and unstaged, with no conflict markers in `docs/INTERFACE.md`.

---

## Notes for the implementer

- Run every `pytest` with `.venv/bin/python -m pytest`.
- Commit after each task; targeted `git add` of the listed files only. `config.py`/`config.yaml`/`graph.py`/`run_eval.py` are clean (no pre-existing WIP), so `git add <file>` is safe for them; `docs/INTERFACE.md` is NOT (Task 8 handles it via stash).
- Tasks 7 is the only one needing live services; everything else is offline + unit-tested.
- Do not touch deferred scope (agent endpoint, two-step filtering, comparison, generation-prompt tuning, image chunks).
