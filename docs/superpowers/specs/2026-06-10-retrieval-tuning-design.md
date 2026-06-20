# 检索调优实验（reranker × alpha）· 设计

> 日期：2026-06-10 · 状态：待评审 · 关联：[memory/retrieval_eval.md](../../../memory/retrieval_eval.md)（基线 + harness）、`contract_rag/retrieval/graph.py`、`evals/`。
> 前序：`docs/superpowers/specs/2026-06-08-rag-wiring-ragas-eval-design.md`（基线那一轮）。

## 1. 背景与目标

上一轮接通了 RAG（`POST /api/query`）并用 RAGAS 建了 2026004 的检索质量基线：
context_recall 0.80 / context_precision 0.69 / faithfulness 0.86 / answer_relevancy 0.81 / **answer_correctness 0.44**。

终极目标是 agentic RAG，但直接上 agent 有个混淆陷阱：分数若涨，分不清是「agent 聪明」还是「顺手把检索调好了」。本轮先用**便宜的确定性检索旋钮**探一探简单 RAG 的天花板，量出每个旋钮值多少，把最优固化为默认。这样后续上 agent 时是在干净、调过的起点上对比增量。

**目标**：在固定的 2026004 gold 集上，用网格实验比较 `reranker × alpha` 的检索 config，选出显著最优者并设为默认；产出可信（控噪声）的对比数据。

## 2. 范围与非目标

**做：**
- 检索旋钮实验（贪心坐标搜索，4 config）：`alpha ∈ {0.3, 0.5, 0.7}` 扫描 + 最佳 alpha 上 `use_reranker` 开关。
- 控噪声测量：生成 + judge temperature=0；网格各跑一次定方向，baseline vs 赢家各跑 3 次报 mean±std 确认。
- 把检索 config 做成 config 驱动（`config.yaml` `retrieval:` 段），赢家=改一处即生效。
- 结果写入 `memory/retrieval_eval.md`。

**明确不做（留后续）：**
- 生成 prompt 迭代（虽然 correctness 0.44 最低，但那是生成侧，混进来会污染「检索调优」这个变量）。
- agent（`ContractRAGAgent` 接 API / tool-calling agent）。
- image chunk 纳入检索（2026004 语料里没有 image chunk，对本评测无影响）。
- 决策 10 两步过滤 / 开放语料检索。
- top_n / k 扫描（本轮固定 k=20、top_n=5，留作后续）。
- 正经统计显著性检验（样本 10 题、重复 3 次，太小，用「mean±std 区间是否重叠」的朴素判据）。

## 3. 实验设计

固定项：`k=20`、`top_n=5`、scoped `contract_id="2026004"`、dataset `evals/dataset_2026004.jsonl`（同 10 题）。

**贪心坐标搜索（4 config，不做 2×3 全交叉）**：reranker 在检索之后对 k=20 池子重排，与 alpha（决定池子内容）基本独立，故分两步：

1. `use_reranker=off`，扫 `alpha ∈ {0.3, 0.5, 0.7}` → 选最佳 alpha（3 run；`alpha=0.5` 即上一轮基线 config，temp=0 下重测作参考点）
2. 在最佳 alpha 上开 `use_reranker=on`（`BAAI/bge-reranker-v2-m3`）（+1 run）

= **4 run**。

**测量纪律（控噪声 + 省调用）：**
- 答案生成（`rag_generate`）与 RAGAS judge（`rag_judge`）均 `temperature=0`，把 LLM 方差砍到最小。
- **阶段一（定方向，4 run）**：**只算 `answer_correctness`（选赢家）+ `context_recall`（守门约束）两个指标**，避开最贵的 `context_precision`（按 top_n 逐条判，~5 次/题）。
- **阶段二（确认，6 run）**：对 baseline 与阶段一赢家各跑 **3 次**，跑 **full 5 指标**，报每指标 mean±std。
- **赢家判据（明确）**：阶段一按 **`answer_correctness`** 取最高者为赢家候选，**约束** `context_recall` 不得低于 baseline 0.05 以上（避免为正确性牺牲召回）。阶段二确认该候选 vs baseline 的 `answer_correctness` 区间不重叠（赢家 mean−std > baseline mean+std）才算「显著提升」。

**并发与抗限流（关键）：**
- `RunConfig(max_workers=3, timeout=300, max_retries=10, max_wait=60)` —— 并发压到 3 + 指数退避，避免 Vertex `RESOURCE_EXHAUSTED`（429）。
- 把 `google.api_core.exceptions.ResourceExhausted` 纳入 RAGAS 重试的 `exception_types`（连同默认的超时类）。
- config 之间**串行**执行（不叠加并发）。

**成本（估算）**：网格 4 run（~50 调用/run）+ 确认 6 run（~130 调用/run）≈ **1000 次 LLM 调用、~1.3~1.6M token**（flash 档）。runner 挂 RAGAS `token_usage_parser` 打印真实 token 数，跑完落进报告。

## 4. 实现改动

| 文件 | 改动 |
|---|---|
| `contract_rag/llm.py` | `get_custom_chat_object(model, *, temperature=None)` —— 加可选温度；`None` 时保持现状（不传给构造器），传 0 时显式 `temperature=0`。 |
| `contract_rag/config.py` | 新增 `RetrievalConfig(alpha: float, use_reranker: bool, k: int, top_n: int)`，挂到 `Config.retrieval`。 |
| `contract_rag/config.yaml` | 新增 `retrieval:` 段（`alpha: 0.5`、`use_reranker: false`、`k: 20`、`top_n: 5` —— 即当前基线值，实验后改成赢家）。 |
| `contract_rag/retrieval/graph.py` | `retrieve()` 与 `answer_with_sources()` 的 `alpha`/`use_reranker`/`k`/`top_n` 默认值改为读 `config.retrieval`（不再硬编码 0.5/False）；`answer_with_sources` 把 `alpha` 透传给 `retrieve()`（目前没透传），并接受 `temperature` 透传给生成模型。 |
| `evals/compare.py`（新，纯函数） | 把「同一 config 的多次 run」聚合成 `{metric: (mean, std)}`；`pick_winner(configs_scores)` 选赢家；`is_significant(winner, baseline)` 按区间不重叠判定。 |
| `evals/run_grid.py`（新，集成入口） | 阶段一 4-config 贪心搜索（2 指标）+ 阶段二确认（full 5，×3）；`RunConfig(max_workers=3, timeout=300, max_retries=10, max_wait=60)` + `ResourceExhausted` 纳入重试；config 串行；复用 `dataset`/`report`/judge 装配；挂 `token_usage_parser`；写对比报告 `evals/reports/grid-<ts>.json`（每 config 分数 + 阶段二 mean±std + 赢家 + 是否显著 + 真实 token 数）。 |
| `evals/run_eval.py` | 不动（单 config 基线仍可用）。生成/judge 改为可传 temperature 的小重构（若与 grid 共用装配代码则抽到一处）。 |

**接口契约影响**：`answer_with_sources` 新增可选参数（`alpha`/`temperature`），向后兼容；`POST /api/query` 行为不变（默认从 config 读，自动用上赢家）。`docs/INTERFACE.md` §4 补一句「检索参数由 `config.yaml` `retrieval:` 段控制」。

## 5. 测试

- **单测（进 80% 闸，无 LLM/无网络）：**
  - `evals/compare.py`：给定假分数 dict → 正确的 mean/std、选对赢家、显著性判定（重叠 → 不显著，不重叠 → 显著）。
  - `get_custom_chat_object(temperature=0)`：构造对象的温度属性正确；`temperature=None` 时与原行为一致。
  - `answer_with_sources(alpha=X)`：monkeypatch `retrieve`，断言收到的 `alpha` == X（验证透传）。
  - `config.retrieval` 字段加载（`RetrievalConfig` dataclass 与 yaml 对齐）。
- **集成（不进闸，打真实 Gemini+Weaviate+reranker）：** `evals/run_grid.py`，手动触发。

## 6. 前置与风险

- **reranker 已就绪（风险消除）**：`BAAI/bge-reranker-v2-m3` 已在 HF 缓存（`~/.cache/huggingface/hub/models--BAAI--bge-reranker-v2-m3`），`sentence-transformers 5.5.0` 已装——正是 `graph.py` 写死要用的那个模型，**无需下载**。实现第一步仍 load 一次确认：
  `.venv/bin/python -c "from langchain_community.cross_encoders import HuggingFaceCrossEncoder; HuggingFaceCrossEncoder(model_name='BAAI/bge-reranker-v2-m3'); print('ok')"`
- **成本与耗时**：≈ 10 次真实 eval run、~1000 次 LLM 调用、~1.3~1.6M token（flash 档，量级 ~$1）。并发压到 3 + 退避会让总耗时偏长（约 30~40 分钟），换取不触发 `RESOURCE_EXHAUSTED`。
- **负结果也有价值**：若 reranker/alpha 均无显著提升 → 证明瓶颈在生成侧（correctness 0.44），直接指向下一轮做生成 prompt 或 agent，而非继续调检索。

## 7. 验收

1. `evals/run_grid.py` 跑通，产出 4-config 对比表 + baseline-vs-赢家 mean±std + 显著性结论 + 真实 token 数，落 `evals/reports/grid-<ts>.json`。
2. 若有显著赢家 → `config.yaml` `retrieval:` 更新为赢家值，`/api/query` 自动生效；若无 → 保持基线值并记录「检索旋钮在此语料上无显著提升」。
3. 单测全绿（compare 聚合/选赢家/显著性、temperature 透传、alpha 透传、retrieval config 加载）。
4. `memory/retrieval_eval.md` 追加本轮实验结果（config 对比 + 结论 + 日期），延续基线记录习惯。
5. `docs/INTERFACE.md` 与代码一致（检索参数 config 驱动那句）。
