# RAG 接通 + RAGAS 评测基线 · 设计

> 日期:2026-06-08 · 状态:待评审 · 关联:`memory/ingestion_pipeline.md`(决策 10/12)、`memory/embedding_pitfalls.md`、`contract_rag/retrieval/graph.py`、`docs/INTERFACE.md`

## 1. 背景与目标

入库 pipeline 骨架已完成,检索层 `contract_rag/retrieval/graph.py` 也有一个能跑的一次性 RAG(`answer()`)和一个 agentic 版本(`ContractRAGAgent`),但:

- 检索层**未接进 FastAPI**,前端/调用方无法访问;`docs/INTERFACE.md` 没有检索端点契约。
- **从未在真实 `retrieve()`/Weaviate 路径上评测过**。已有的 90%/100% recall 基线(`embedding_pitfalls.md`)是**离线内存 cosine、仅 2026004 数字件**测的,不代表线上检索质量。
- LLM 调用模型档位混乱:`LLM().get_chat_object()` 硬编码 `gemini-3.5-flash`,**无视 config.yaml** 的 `gemini-3-flash-preview`。

**本轮目标(路线 1 的第一档,渐进式 agentic 演进):**

1. 把一次性 `answer()` 接成 `POST /api/query` 端点,返回答案 + 引用来源。
2. 建立 **RAGAS** 评测 harness,产出**可回归的检索/生成质量基线**。
3. 模型分层走 config;修掉 `get_chat_object()` 硬编码。

**为什么先做简单版而非直接上 agentic:** 没有基线就重写成完全体 agent,无法回答"它比简单 RAG 好多少、值不值这些 LLM 调用"。先用确定性的 `answer()` 锚住数字,后续上 agent 时能用同一套 harness 对比增量。

## 2. 范围与非目标

**做:**

- `POST /api/query` 端点(一次性 RAG)。
- 检索结果结构化改造(答案 + 来源 + contexts)。
- 模型分层(config 驱动)+ 修 `get_chat_object` 硬编码。
- RAGAS eval harness + gold 数据集(2026004,10 条 query)。
- `docs/INTERFACE.md` 增补检索端点契约。

**明确不做(留后续 spec):**

- `ContractRAGAgent` 端点(路线 1 下一档)。
- 决策 10 两步过滤(SQLite 筛 contract_id 集合 → Weaviate)。
- 真 comparison(SQL 聚合)。
- 前端问答页。
- image chunk 检索(决策 14 待办)。
- LangSmith 集成(留作以后可视化层)。
- query 端点的 `rag.enabled` 开关(那是入库期的事,本端点只查现有向量)。
- 开放语料检索评测(随决策 10 一起做)。

## 3. 检索结果结构化改造

现状:`answer()` 只返回字符串,前端拿不到来源,RAGAS 拿不到 contexts。

**改造:** 在 `contract_rag/retrieval/graph.py` 新增一个返回结构化结果的函数,`answer()` 退化为它的字符串包装(向后兼容,现有调用不破)。

```python
@dataclass(frozen=True)
class RAGResult:
    question: str
    question_class: str          # "entity" | "clause" | "comparison"
    answer: str
    contexts: list[str]          # 检索到的 chunk 文本(RAGAS 吃这个;entity 路径为 [])
    sources: list[dict]          # [{contract_id, chunk_type, page_start, page_end, section_path, content}]
```

- **clause 路径**:`contexts` = 检索到的 docs 的 `page_content`;`sources` = 同一批 docs 的元数据 + 内容。
- **entity / comparison 路径**:走 SQLite,`contexts = []`;`sources` = 参与回答的合同行(至少含 `contract_id`)。

新函数签名(暂名 `answer_with_sources`,实现时可定名):

```python
def answer_with_sources(question: str, *, contract_id: str | None = None,
                        use_reranker: bool = False) -> RAGResult: ...
```

`sources` 的元数据来自 langchain `Document.metadata`(Weaviate 属性:`contract_id`/`chunk_type`/`page_start`/`page_end`/`section_path`)。

## 4. API 端点契约

新增路由模块 `contract_rag/api/routes/query.py`,在 `app.py` 的 `include_router` 列表里注册(统一 `/api` 前缀)。

```
POST /api/query
  请求体:
    { "question": str,                    # 必填,非空
      "contract_id": str | null }         # 可选,给定则检索限定到该合同
  响应 200:
    { "question": str,
      "question_class": "entity"|"clause"|"comparison",
      "answer": str,
      "sources": [ { "contract_id": str, "chunk_type": str,
                     "page_start": int, "page_end": int,
                     "section_path": str, "content": str } ] }
```

- 单端点、一次性 RAG。响应即 `RAGResult` 去掉内部用的 `contexts` 字段。
- **输入校验**:`question` 空白 → 422(Pydantic 模型约束 `min_length=1` after strip)。
- **错误处理**:Weaviate 连不上 / collection 不存在 → 502 + 明确 message(不裸抛 stack);LLM 调用异常 → 502。所有错误经统一 try/except 转成结构化错误响应,日志记完整上下文。
- Pydantic 请求/响应模型放 `contract_rag/api/schemas.py`(与现有 schema 同处)。

`docs/INTERFACE.md` 增补一节 "Retrieval — `POST /api/query`",描述请求/响应/错误码,标注本轮为 scoped 单合同检索、开放语料检索随决策 10 落地。

## 5. 模型分层(config 驱动)

**config.yaml** `models:` 下新增两个检索专用档位:

```yaml
models:
  vision: gemini-3-flash-preview
  ocr: gemini-3-flash-preview
  approval: gemini-3-flash-preview
  ocr_render_dpi: 200
  rag_generate: gemini-3-flash-preview   # 面向用户的答案生成 + RAGAS judge
  rag_light:    gemini-2.5-flash-lite    # classify / sufficiency / rewrite 等轻判断
```

**config.py** `ModelsConfig` dataclass 同步加字段(`ModelsConfig(**raw["models"])` 是关键字解包,不加字段会抛):

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

**graph.py** 各步骤按用途选档,改用现有的 `LLM().get_custom_chat_object(model_id)`:

| 步骤 | 档位 | config 键 |
|---|---|---|
| `classify_query` / `_sufficiency_edge` / `_rewrite_node` | light | `rag_light` |
| `entity_lookup` / clause `answer` 生成(`_generate_node` / `answer`) | generate | `rag_generate` |
| RAGAS judge | generate | `rag_generate` |

**修 `get_chat_object()` 硬编码:** 当前 `model="gemini-3.5-flash"` 改为读 `load_config().models.rag_generate`。

> ⚠️ 实现前置检查:`grep -rn "get_chat_object" contract_rag/` 确认所有调用方,改默认值不能破坏入库链路(approval 抽取等)。若入库别处依赖 `get_chat_object` 的旧行为,改为各自显式传 `get_custom_chat_object(...)`。

## 6. RAGAS 评测 harness(核心交付)

### 6.1 Ground-truth 来源与迁移

**问题:** 旧 GT 是 `_test_2026004_chunks.json` 的**数组下标**,对真实 Weaviate(UUID + 可能重切)无意义。

**解法:** RAGAS 不按 chunk ID 工作,**按文本 + 参考答案用 LLM/embedding 判定**。所以迁移方式是把"query → gt 下标"换成"query → 参考答案",**彻底与 chunk 索引解耦**,重切也不失效。

**gold 集来源(诚实声明 — 评测唯一不能凭空造的部分):**

- **本轮:** 复用旧 `_retrieval_test3.py` 里那 10 条**人工标注** query(每条已带注释指向正确条款,如 `clause 4 net 30`)。由 Claude 读 2026004 的 chunk **起草参考答案 → 用户(业务方)逐条确认/订正**。LLM 起草 + 人确认 = 合格金标准;不复核冒充 gold = 不行。
- **覆盖边界(写明,防误读):** gold 集仅覆盖 2026004 数字件。这是**建基线、够用**,不是"全量质量"。扫描件(CN2026002)与多合同对比本轮不做。
- **后续扩展路径(写进 spec、本轮不做):** 语料铺开后,用 RAGAS `TestsetGenerator`(`ragas.testset`)批量生成 question/参考答案/参考上下文,人抽检后并入。

### 6.2 数据集格式

`evals/dataset_2026004.jsonl`,每行一条:

```json
{"question": "付款账期是多少天？", "ground_truth": "<参考答案文本>", "contract_id": "2026004", "note": "clause 4 Payment"}
```

10 条 query(迁移自 `_retrieval_test3.py`):ChemAqua 单价 / 付款账期 / 终止 / 责任上限 / 质保 / 调价机制 / 生效日期 / 不可抗力 / 适用法律 / 保密与 IP。

### 6.3 检索范围(scoped)

评测对每条 query 调 `answer_with_sources(question, contract_id="2026004")`,**限定到 2026004**。

**为什么 scoped:** 库里混着 CN2026002 的 14 个 chunk,开放检索会引入干扰项;"跨合同找对合同"是决策 10 两步过滤的事(已 deferred)。scoped 隔离了这个变量,且与旧的单合同 90%/100% 基线**直接可比**。开放语料评测随决策 10 落地。

### 6.4 指标

| 维度 | 指标 | 需参考答案 | 评什么 |
|---|---|---|---|
| 检索 | `context_recall` | 是 | 该检索到的内容检索到了吗(对标旧 recall@k) |
| 检索 | `context_precision` | 是 | 检索结果里相关比例(噪声) |
| 生成 | `faithfulness` | 否 | 答案是否忠于检索内容、有无幻觉 |
| 生成 | `answer_relevancy` | 否 | 答案是否切题 |
| 生成 | `answer_correctness` | 是 | 答案对不对(对标准答案) |

> entity 路径 `contexts=[]`,检索类指标对这类样本不适用 —— gold 集这 10 条都是 clause 类问题,本轮不混入 entity 样本,避免指标语义混乱。

### 6.5 Judge 配置

```python
from ragas.llms import LangchainLLMWrapper
from ragas.embeddings import LangchainEmbeddingsWrapper

judge_llm = LangchainLLMWrapper(LLM().get_custom_chat_object("gemini-3-flash-preview"))
judge_emb = LangchainEmbeddingsWrapper(LLM().get_embedding_object())
```

> ragas **0.4.3** 的确切 API(`EvaluationDataset` / `SingleTurnSample` / `evaluate()` 签名、wrapper 导入路径)在实现时对着 `0.4.3` 源码钉死 —— 0.4.x 相对 0.1.x 改动较大,不照旧文档写。

### 6.6 runner

`evals/run_eval.py`:

1. **前置自检:** 连 Weaviate,查 `count_contract("2026004")`;为 0 则明确报错退出(提示先入库)。
2. 加载 `dataset_2026004.jsonl`。
3. 对每条 query 跑真实 `answer_with_sources(q, contract_id="2026004")`,收集 `{question, answer, contexts, ground_truth}`。
4. 组 RAGAS `EvaluationDataset` → `evaluate(metrics=[...], llm=judge_llm, embeddings=judge_emb)`。
5. 打印分数表 + 写时间戳报告 `evals/reports/<YYYY-MM-DD-HHMMSS>.json`(多次 run 可比 = 回归基线)。

`evals/` 目录(repo 根),与现有散落的 `_retrieval_*.py` 区分。`evals/reports/` 加 `.gitkeep`,报告本身可选 gitignore(实现时定)。

## 7. 测试策略

- **单测(进 80% 闸,无 LLM/无网络):**
  - 数据集 loader(解析 jsonl、字段校验)。
  - `RAGResult` 组装 / `sources` 序列化(给定 mock Document 列表 → 正确结构)。
  - 报告写出(给定分数 dict → 落盘 JSON 格式正确)。
  - `_chunk_type_filter` 等纯函数(已存在,补 contract_id 分支)。
  - 端点:FastAPI `TestClient` + **mock 掉 `answer_with_sources`**,测路由、请求校验、错误码;不打真服务。
- **集成脚本(不进单测闸,打 `@pytest.mark.eval` 默认跳过 或 独立脚本):**
  - 真实 RAGAS run(打真实 Gemini + Weaviate)—— 即 `evals/run_eval.py`,手动/CI 触发。

## 8. 文件落点

| 文件 | 改动 |
|---|---|
| `contract_rag/retrieval/graph.py` | 加 `RAGResult` + `answer_with_sources`;模型分层改 `get_custom_chat_object` |
| `contract_rag/llm.py` | `get_chat_object` 读 config(去硬编码) |
| `contract_rag/config.py` | `ModelsConfig` 加 `rag_generate`/`rag_light` |
| `contract_rag/config.yaml` | `models:` 加两个键 |
| `contract_rag/api/routes/query.py` | 新增,`POST /api/query` |
| `contract_rag/api/app.py` | 注册 query 路由 |
| `contract_rag/api/schemas.py` | 加 query 请求/响应模型 |
| `docs/INTERFACE.md` | 增补检索端点契约 |
| `evals/dataset_2026004.jsonl` | 新增,10 条 gold(参考答案待用户确认) |
| `evals/run_eval.py` | 新增,RAGAS runner |
| `tests/api/test_query.py` 等 | 新增单测 |

## 9. 前置依赖与验收

**前置:** Weaviate 在跑(`localhost:8080`),`JushiContract` collection 含 2026004 的 45 chunks(已确认在库,**无需重新入库**)。

**验收标准:**

1. `POST /api/query` 对 clause 类问题返回答案 + 非空 sources;对 entity 类返回 SQLite 答案 + 空 sources。
2. `evals/run_eval.py` 跑通,产出 5 个指标的分数 + 时间戳报告。
3. 单测全绿,新增确定性逻辑覆盖到位。
4. `get_chat_object` 不再硬编码,入库链路不回归。
5. `docs/INTERFACE.md` 与代码一致。

**这个数字代表什么(管理预期):** 本轮基线 = 2026004 单数字合同、scoped 检索、10 条 clause query 的质量。它锚住"简单 RAG 在干净数字件上的检索/生成质量",供后续上 agent / 做决策 10 时对比增量。**不代表**扫描件、跨合同、entity 查询的质量。
