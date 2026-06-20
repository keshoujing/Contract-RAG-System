# Agentic RAG 接通 + 增量评测 · 设计

> 日期：2026-06-15 · 状态：待评审 · 关联：[memory/retrieval_eval.md](../../../memory/retrieval_eval.md)（基线 + harness + 三个卡死/NaN/OOM 坑）、`contract_rag/retrieval/graph.py`、`evals/`。
> 前序：`docs/superpowers/specs/2026-06-08-rag-wiring-ragas-eval-design.md`（一次性 RAG 基线）、`docs/superpowers/specs/2026-06-10-retrieval-tuning-design.md`（alpha 扫描，结论保持 0.5）。

## 1. 背景与目标

`contract_rag/retrieval/graph.py` 里已有一个写好但**未接通**的 `ContractRAGAgent`：在 clause 路径上有一个 agentic 自评循环 —— 检索 → LLM 判断结果够不够（`_sufficiency_edge`）→ 不够就 LLM 改写问题再检索（`_rewrite_node`），最多 `MAX_REWRITES=3` 轮。entity/comparison 路径直接走 SQLite，无循环。

一次性 RAG（现 `POST /api/query`）只检索一次，检索不好也将就。agentic 版多了「不满意就换问法重试」的能力，但**也更贵**（每轮多 sufficiency + rewrite 两次 LLM 调用）。这个循环到底有没有真把质量提上去、还是白烧 token，现在是未知数。

**目标**：把现有 `ContractRAGAgent`（循环逻辑不动，`MAX_REWRITES=3` 保持）接成可量化的结构化能力，用与一次性 RAG **同一套口径**量出增量。先单跑一轮看信号，有正向再上 x3 + 显著性。

## 2. 范围与非目标

**做：**
- 让 `ContractRAGAgent` 能返回结构化 `RAGResult`（contexts/sources/diagnostics），与一次性 `answer_with_sources` 对称。
- 新增同步 embedding 双指标（answer-similarity + retrieval-coverage），**不走 ragas `evaluate()`**，彻底绕开 async 卡死坑。
- 新增对比 runner `evals/run_agent_compare.py`：oneshot vs agent，默认单跑一轮，断点续跑缓存；`--repeats N` 上 x3 + mean±std + 显著性。

**明确不做（留后续）：**
- **API 切换**：`POST /api/query` 保持一次性。是否切到 agent / 加 mode 开关，**门控在本轮数据之后**再决策。
- **改 agentic 循环本身**：不放开 `MAX_REWRITES`、不做 tool-calling agent、不让 LLM 自选数据源。本轮量的就是现成这版。
- **token 级成本核算**：本轮成本只报「平均改写轮数 + 派生 LLM 调用数」作代理；token 计数推迟到信号为正的 x3 轮。
- **LLM-judge 指标**（faithfulness / context_recall / answer_correctness 等）：async 卡死 + gemini judge 上 NaN（见 memory 三个坑），本轮只用同步 embedding 代理。

## 3. 组件设计

### 3.1 Agent 返回 `RAGResult`（`contract_rag/retrieval/graph.py`）

**State 扩展**（`ContractRAGState`）：
- `original_question`：保留原问（`question` 仍被 rewrite 改写，组装结果时用原问）。
- `question_class`：由新 `classify` 节点写入。
- 检索参数：`contract_id` / `alpha` / `use_reranker` / `temperature` —— 当前 `_clause_retrieve_node` 调 `retrieve(state["question"])` **不带任何参数**，导致 agent 无法 scope 到某合同；为与 2026004 scoped 基线公平对比，必须把这些参数穿进 state。

**图结构改动**：
- START → `classify` 节点（调一次 `classify_query` 把类别存进 `state["question_class"]`）→ 条件边读 `state["question_class"]` 路由 entity/clause。
  - 消除现有 `_classify_edge` 的二次分类（它现在每次路由都重算一遍 `classify_query`，且类别被丢弃）。
- `_clause_retrieve_node` / `_generate_node` 从 state 读检索参数与温度。

**新公共函数**：
```python
def agent_answer_with_sources(
    question, *, contract_id=None, alpha=None,
    use_reranker=None, temperature=None,
) -> RAGResult
```
跑编译好的图（`@lru_cache` 缓存编译后的 agent，避免每次调用重编译），从终态组装 `RAGResult`。组装逻辑抽成纯函数 `_state_to_result(state) -> RAGResult` 以便单测：
- `question = original_question`，`question_class`，`answer = generation`
- clause 路径：`contexts = [d.page_content]`，`sources = [_doc_to_source(d)]`（复用现有 helper）
- entity/comparison 路径：`contexts = []`，`sources = [{contract_id} for c in db.list_contracts()]`（同一次性）
- `diagnostics = {"iterations": <改写轮数>}`

**`RAGResult` 扩展**：加一个可选字段 `diagnostics: dict = field(default_factory=dict)`（frozen dataclass 兼容，默认空 → 一次性路径 `answer_with_sources` 不受影响）。

**`ContractRAGAgent.invoke() -> str`**：退化为 `return agent_answer_with_sources(question).answer`（DRY，与一次性 `answer`/`answer_with_sources` 对称）。

### 3.2 同步 embedding 双指标（`evals/metrics.py`，新增）

纯函数，**直接 embedding，不经 ragas `evaluate()`** —— 这正是 memory 坑 #1 的教训（ragas async 对任何指标包括纯 embedding SemanticSimilarity 都会偶发卡死几百秒~小时级；同步直算只要 1-2s）：

```python
def answer_similarity(answer: str, gold: str, embed) -> float
    # cos(embed(answer), embed(gold))
def retrieval_coverage(gold: str, contexts: list[str], embed) -> float
    # max over contexts of cos(embed(gold), embed(ctx)); 无 context 返回 0.0
```
- `embed = LLM().get_embedding_object().embed_query`（**逐条** embed，避开 `embed_documents` 在 Vertex 静默丢数据那个坑，见 embedding_pitfalls.md）。
- `answer_similarity`：答案 vs gold，照「答案质量」，口径同 grid 的 SemanticSimilarity（可与历史 0.749/0.773/0.765 对照）。
- `retrieval_coverage`：gold 答案 vs 检索到的 contexts，照「检索是否捞到了能支撑答案的内容」—— agentic 循环的价值主要在这里，answer_similarity 未必照得出。
- 单测用确定性 fake embed（不打网络）：cos 正确性 / 空 context→0.0 / 相同文本→1.0 / 正交→0.0。**进单元闸。**

### 3.3 对比 runner（`evals/run_agent_compare.py`，新增）

仿 `run_grid.py` 的断点续跑结构（本环境后台任务会被 kill，缓存让 kill 只丢在跑的那一格；用户终端跑）：

- 两个 arm：`oneshot`（`answer_with_sources`）、`agent`（`agent_answer_with_sources`），均 `temperature=0`、scoped `contract_id`。
- 每个 (arm, repeat)：逐 gold case 跑 → 算 `answer_similarity` + `retrieval_coverage`；agent 额外记 `diagnostics["iterations"]`。一格跑完立刻写 `evals/reports/_agent_compare_cache.json`。
- `--repeats N`（默认 1）、`--reset`，沿用 grid 的 CLI 习惯。
  - N=1：打印每 arm 两指标均值 + agent 成本（mean iterations + 派生 LLM 调用数）。
  - N≥2：复用 `evals/compare.py` 的 `aggregate_runs`（mean±std）+ `is_significant`（在 `answer_similarity` 上判 agent vs oneshot），写时间戳报告（`evals/report.py` 的 `write_report`）。

**派生 LLM 调用数**（成本代理，结构化推算，不打 callback）：
- oneshot clause = classify(1) + generate(1) = 2；entity = classify(1) + lookup(1) = 2。
- agent clause = classify(1) + iterations×[sufficiency(1)] + (iterations-1)×[rewrite(1)] + generate(1)；entity = classify(1) + lookup(1)。
- 用每 case 记录的 `question_class` + `iterations` 推算，报每 arm 总调用数。

**报告结构**（N=1 控制台 + JSON）：
```
arm       answer_sim  retr_cov   mean_iters  llm_calls
oneshot   0.7xx       0.xxx      —           2N
agent     0.7xx       0.xxx      1.x         ~?
```

## 4. 数据流

```
gold case (question, ground_truth, contract_id)
  ├─ oneshot: answer_with_sources(q, contract_id, temp=0) ─┐
  └─ agent:   agent_answer_with_sources(q, contract_id, temp=0) ─┤
                                                                 ↓
                          RAGResult(answer, contexts, diagnostics)
                                                                 ↓
              answer_similarity(answer, gold, embed)   ← 同步 embed_query
              retrieval_coverage(gold, contexts, embed)
                                                                 ↓
                    per-(arm,repeat) 缓存 → 汇总 → 报告
```

## 5. 错误处理 / 边界

- **空 contexts**（entity/comparison 路径，或检索空）：`retrieval_coverage` 返回 0.0（不崩）。entity 路径 answer_similarity 照常算（答案 vs gold）。
- **embedding 失败**：逐条 `embed_query`，单条异常向上抛，由 runner 的 per-格缓存兜底（重跑续上），不静默吞。
- **rewrite JSON 解析失败**：现有 `_rewrite_node` 已回退原问题，不变。
- **agent 跑挂**：与 run_grid 同策略 —— 缓存到格，kill/异常只丢在跑的那格，重跑续上。不靠短 timeout。

## 6. 测试

| 对象 | 类型 | 进单元闸 |
|---|---|---|
| `evals/metrics.py`（cos / 空 / 相同 / 正交，fake embed） | 单元 | ✅ |
| `graph._state_to_result`（fake state → RAGResult） | 单元 | ✅ |
| `agent_answer_with_sources` / runner | 集成入口（真实 Gemini+Weaviate） | ❌（同 run_eval/run_grid） |

`RAGResult.diagnostics` 默认空，确保现有一次性路径与其单测不受影响。

## 7. 运行（用户终端，长 eval）

```
.venv/bin/python -m evals.run_agent_compare              # 单跑，oneshot vs agent，看信号
.venv/bin/python -m evals.run_agent_compare --repeats 3  # 信号为正再上 x3 + 显著性
```
前置：Weaviate 在跑、2026004 已入库（45 chunk）。

## 8. 验收

- 单元闸绿（含新增 metrics / `_state_to_result` 测试），现有 175 测试不回归。
- `agent_answer_with_sources` 能对 clause / entity 两类问题返回结构化 `RAGResult`（手验）。
- runner 单跑一轮产出 oneshot vs agent 的双指标对比 + agent 成本，结论写回 `memory/retrieval_eval.md`。
