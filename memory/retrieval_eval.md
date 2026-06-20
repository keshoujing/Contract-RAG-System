# 检索（RAG）接通 + RAGAS 评测基线

> 开发检索/问答相关功能前先读此文件。关联：[ingestion_pipeline.md](ingestion_pipeline.md) 决策 10/12、[embedding_pitfalls.md](embedding_pitfalls.md)。
> 设计/计划文档：`docs/superpowers/specs/2026-06-08-rag-wiring-ragas-eval-design.md`、`docs/superpowers/plans/2026-06-08-rag-wiring-ragas-eval.md`。

## 一、本轮做了什么（2026-06-08）

把检索层 `contract_rag/retrieval/graph.py` 接成对外能力 + 建立**可回归的 RAGAS 评测基线**。范围是「路线 1 第一档」：先用确定性的一次性 RAG 锚住数字，后续再演进到 agentic（agent 代码 `ContractRAGAgent` 已保留，本轮未接 API）。

- **API**：`POST /api/query`（`contract_rag/api/routes/query.py`），返回答案 + 来源 chunk。契约见 `docs/INTERFACE.md` §4。
- **结构化检索结果**：`graph.answer_with_sources()` 返回 `RAGResult(question, question_class, answer, contexts, sources)`；旧 `answer()` 退化为它的字符串包装（DRY）。clause 路径来源=检索 docs；entity/comparison 路径走 SQLite，`contexts=[]`。
- **模型分层（config 驱动）**：`config.yaml` `models:` 下
  - `rag_generate: gemini-3-flash-preview` —— 面向用户的答案生成（entity_lookup / clause 生成 / agent generate 节点）
  - `rag_light: gemini-2.5-flash-lite` —— 轻判断（classify_query / sufficiency / rewrite）
  - `rag_judge: gemini-2.5-flash` —— RAGAS LLM-as-judge（见踩坑）
  - 顺手修了 `LLM.get_chat_object()` 原先硬编码 `gemini-3.5-flash`，改读 `models.rag_generate`。

## 二、⚠️ 致命踩坑：RAGAS judge 不能用 `gemini-3-flash-preview`

**现象**：用 `gemini-3-flash-preview` 当 RAGAS judge，`faithfulness` 恒为 **0.0**，且 ~26% 的 judge job 报 `TimeoutError`（即使把 RunConfig 调到 max_workers=4 / timeout=300 也没用）。

**根因**：`gemini-3-flash-preview` 的 `response.content` 返回的是**结构化 block 列表**（带 reasoning signature）：
```python
[{'type': 'text', 'text': 'OK', 'extras': {'signature': '...'}}]
```
而不是普通字符串。RAGAS 的内部输出解析器假设 `.content` 是字符串 → faithfulness 的 statement 拆解读不到内容 → 判 0；解析重试的churn 把任务拖到超时。实测 `gemini-2.5-flash` / `gemini-2.5-flash-lite` 返回的是普通 `str`。**async 路径本身没问题**（sync 4.4s / async 8.0s 都正常，不是 async 不兼容）。

**修复**：judge 用 `models.rag_judge = gemini-2.5-flash`（capable + 返回 str）。**答案生成仍用 `gemini-3-flash-preview`**——业务代码侧 `ingest/vision.py: extract_text()` 已能展平 list-content，所以生成不受影响,只有第三方库 RAGAS 受影响。
> 推论：任何把 Gemini 3 preview 的 `.content` 直接当字符串用的**第三方库**都可能踩这个坑；自己代码一律走 `extract_text()`。

## 三、首个干净基线（2026-06-08，可回归）

- **范围**：2026004 单数字合同，**scoped 检索**（`contract_id="2026004"`，库里另有 CN2026002 14 chunk 作干扰被隔离），10 条人工核验的 clause 类 query。
- **检索**：Weaviate hybrid（vector+BM25，alpha=0.5，k=20→top_n=5），未开 reranker。
- **判分**：RAGAS 0.4.3，judge=gemini-2.5-flash，embedding=gemini-embedding-2。

| 指标 | 分数 |
|---|---|
| context_recall | 0.80 |
| context_precision (LLM, with reference) | 0.69 |
| faithfulness | 0.86 |
| answer_relevancy | 0.81 |
| answer_correctness | 0.44 |

**怎么读这个数**：这是**简单一次性 RAG 在干净数字件上**的质量,供后续上 agent / 做决策 10 时对比增量。`answer_correctness 0.44` 最低、headroom 最大（gold 答案精炼具体,RAG 答案偏泛/漏细节）。**不代表**扫描件、跨合同、entity 查询的质量。
> 与旧基线区分：`embedding_pitfalls.md` 的 recall@1=90%/recall@3=100% 是**离线内存 cosine、只测 embedding 命中**;本表是**真实 `retrieve()` + 生成 + LLM judge** 的端到端质量,两者口径不同,不可直接比。

## 四、复现

```
# 前置:Weaviate 在跑(docker)、2026004 已入库(45 chunk)
.venv/bin/python -m evals.run_eval        # 写时间戳报告到 evals/reports/<ts>.json
```
- gold 集:`evals/dataset_2026004.jsonl`(query/ground_truth/contract_id/note,人工核验)。Q7 的"有效期"故意保留了文档内部冲突(正文定价期 2026-01-01~2028-12-31 vs 汇总表 2026-03-01~2029-03-01),参考答案以正文为准并注明冲突。
- loader/report 是纯函数有单测;runner 是集成入口(打真实 Gemini+Weaviate),不进单测闸。
- runner 用 `RunConfig(max_workers=4, timeout=300)` 限并发,避免 Vertex 限流超时。

## 四点五、检索调优实验（2026-06-14，alpha 扫描）

> 设计/计划：`docs/superpowers/specs/2026-06-10-retrieval-tuning-design.md`、`docs/superpowers/plans/2026-06-10-retrieval-tuning.md`。runner：`evals/run_grid.py`（断点续跑 + `--max-runs`）。

**结论：保持默认 `alpha=0.5`，不改 config。** 2026004 上 alpha 扫描（embedding-only SemanticSimilarity，答案 vs gold，temp=0）：

| alpha | semantic_similarity |
|---|---|
| 0.3 | 0.7485 |
| **0.5** | **0.7733**（最高，= 现默认） |
| 0.7 | 0.7646 |

三者差异 ~0.01，在噪声内 → **调 alpha 对这份语料无实质提升**。最高恰为现默认 0.5，故 `config.yaml retrieval.alpha` 维持 0.5、`use_reranker: false` 不变。

**⚠️ 三个把这轮拖了好几天的大坑（务必记住）：**

1. **RAGAS `evaluate()` 的异步执行在这套 Vertex 栈上严重不可靠** —— 对 **任何** 指标（LLM judge 甚至纯 embedding 的 SemanticSimilarity）都会偶发卡死几百秒（实测单 job 20 分钟、5 job 6.8 小时），而同一个 embedding/chat 调用 **同步** 跑只要 1-8 秒。`RunConfig(timeout/max_workers)` 调参治不了。**教训：以后做 eval 别依赖 ragas 的 async `evaluate()`；要么自己同步算指标（如 cosine 相似度直接用 `LLM().get_embedding_object()` 算，proven 快），要么换框架。** 同步路径（`answer_with_sources` 里的生成/检索）一直正常。
2. **`AnswerCorrectness`（LLM judge）在 gemini judge 上恒返回 NaN** —— 它的结构化"语句拆解"输出 ragas 解析不了。曾导致 pick_winner 失效 + `while` 循环空转一整夜。**赢家判据改用 embedding-only 的 SemanticSimilarity。**（`compare.py` 已加 NaN 防护。）
3. **cross-encoder reranker（bge-reranker-v2-m3 / XLM-RoBERTa）在长 chunk 上 OOM** —— `RuntimeError: Invalid buffer size: ~10 GiB`，因为它把 batch padding 到最长序列，合同大表格 chunk 触发。**本轮直接砍掉 reranker 臂。** ✅ **已解决（2026-06-19）**：弃用本地 bge，改用托管 Vertex Ranking API（无本地模型→无 OOM），见下文八节。`_reranker_model` 已删。

**运行方式教训**：长 eval 后台任务在本环境总被 kill（合盖/回收）；改成"用户终端跑 + per-config 缓存断点续跑"才稳（见个人 memory `run-long-commands-in-user-terminal`）。

## 四点六、Agent vs 一次性 RAG（2026-06-16）

> 设计/计划：`docs/superpowers/specs/2026-06-15-agentic-rag-eval-design.md`、`docs/superpowers/plans/2026-06-15-agentic-rag-eval.md`。runner：`evals/run_agent_compare.py`（断点续跑 + 同步 embedding 指标）。

**结论：API 继续维持一次性 RAG，不切 agentic。** 现成 `ContractRAGAgent` 已接成内部结构化能力 `agent_answer_with_sources()`，但在 2026004 gold set 上没有质量增量，只有成本增加。

| arm | answer_similarity | retrieval_coverage | mean_iterations | llm_calls |
|---|---:|---:|---:|---:|
| oneshot | 0.7591399546 | 0.7112225946 | 0.0 | 20 |
| agent | 0.7590705134 | 0.7112225946 | 0.9 | 29 |

报告：`evals/reports/2026-06-16-015838.json`（本地运行产物）。

**怎么读这个数**：
- `retrieval_coverage` 逐位相同，说明 agent 的 sufficiency/rewrite 循环没有改变最终检索支撑内容。
- `answer_similarity` 基本持平且略低（-0.00007，噪声内）。
- `llm_calls` 从 20 到 29，成本代理增加 45%。按调用数反推：10 条里约 9 条 clause 首轮 sufficiency 即判足够，没有触发 rewrite；agent 只是多花了一次 sufficiency 判断。

按本轮 spec 的门控标准（持平或更差则不切 API；只有正向信号才跑 `--repeats 3`），不需要继续 x3 显著性。现成 agentic 循环对这份干净数字合同语料是纯开销。

## 四点七、Per-query 真实 token 计量（2026-06-16）

> spec §2 把 token 级成本核算推迟为代理（"派生 LLM 调用数"，如上表 20→29）。本轮补上**真实 token** 工具：`evals/token_tracker.py`。

`track_query_usage(query_id)` 上下文管理器：把一条 query 内**每次** chat-model 调用的 `AIMessage.usage_metadata`（模型回传真值，非估算）逐次落账，按 query_id 归并成 `QueryUsage(input/output/total_tokens, n_calls)`。

- **零改 graph.py**：用 `register_configure_hook` + ContextVar（langchain `get_usage_metadata_callback` 同款机制）让 callback 自动传播到节点内**不传 config** 的手动 `.invoke()`。这点很关键——graph.py 当前所有 LLM 调用都是 `LLM().get_custom_chat_object(m).invoke(prompt)`，不穿 config，靠 contextvar 才捕得全。
- **per-call、不依赖 `model_name`**：langchain 自带 `UsageMetadataCallbackHandler` 只按 model 聚合，且 `response_metadata['model_name']` 缺失时**静默丢 usage**；Vertex 栈不保证填它，故自写 collector 逐次记、不丢。
- **已在真实栈验证**（2026-06-16）：`agent_answer_with_sources('付款期限是多少天？', contract_id='2026004', temp=0)` → `input=5456 / output=1073 / total=6529 / n_calls=5`。证明 ① Gemini-3 on Vertex 确实填 `usage_metadata`；② **input_tokens 占大头**（rewrite 把改写 query+重检索 context 反复喂回 generate），这是纯"调用数"代理照不出的成本，真要算 agent 性价比必须用 token。
- 测试 `tests/evals/test_token_tracker.py` 全离线（`GenericFakeChatModel`，不打网络），进单元闸。
- **只计 query 期在线 token**，不含离线建库 embedding（成本对比本就只关心 query 期）。

接入：信号转正要上 x3 时，在 runner 每条 case 外层包 `with track_query_usage(case_id) as u:` 跑 arm，`u.result()` 即该 case 真 token；按 arm 汇总即得真实成本对比。

## 五、未做（后续 spec）
- ~~**reranker A/B**~~ ✅ 已测（2026-06-19，见八节）：当前 4 合同语料无 headroom（cov@5≈cov@20），reranker 零增量，保持 off。语料铺开后再复测。
- **eval 不走 ragas async**：agent 对比 runner 已改用同步 embedding 指标；后续其它 eval 也应沿用这个方向，或换评估框架。
- **开放语料/多合同检索评测**：现在结论只覆盖 scoped 单合同 2026004；下一步要测不指定 `contract_id` 时的候选合同过滤 + Weaviate 检索。
- 决策 10 两步过滤（SQLite 筛 contract_id 集合 → Weaviate）+ **开放语料检索评测**。
- 真 comparison（SQL 聚合,现状是把全部合同 dump 给 LLM）。
- image chunk 可检索（决策 14 待办:`DEFAULT_CHUNK_TYPES` 暂不含 image）。
- `TestsetGenerator` 自动扩 gold 集（语料铺开后,人抽检并入）。
- LangSmith 可视化层。

## 六、方向调整：tool-calling agent + 统一 evidence 契约（2026-06-16 设计决策）

> ⚠️ 这条**推翻**了 `docs/superpowers/specs/2026-06-15-agentic-rag-eval-design.md` §2 里"明确不做 tool-calling agent / 不让 LLM 自选数据源"。用户拍板要往这个方向走。

- **系统不再 `classify_query` 路由**。改由 agent 自己用工具决定：`sql()` 查 SQLite 台账、`search()` 查 Weaviate chunk，可只调一个、都调、或都不调。**一套接口、一套返回**。
- **返回统一为** `answer` + `evidence[]`，每条 evidence 带 `kind`（`record` / `clause`），一条回答里可混排。区分放在**证据条目层级**，不是整条回答层级（因为一次问答可能同时用到结构化字段 + 原文）。
- **clause 证据带 `page`（必填）+ `bbox`（可选，MinerU 版面坐标）**，前端据此弹出原页并高亮被引用段落做核实。
- 前端原型已画在 `docs/pencil-new.pen`：问答页（自适应回答卡：record→表、clause→原文卡）+ 原文核实弹窗（高亮 + 翻页）。Sidebar 加了「问答」导航。
- **契约文档**：`docs/INTERFACE.md` §5（标注 target / 未实现），取代 §4 的系统路由式 `POST /api/query`。
- 关联前序结论：[[retrieval_eval]] 四点六（现成 fixed-route agent 在干净数字件上零增量）——这也是为什么要换成 tool-calling：固定 classify→检索→生成的循环对简单语料没价值，真正的价值在 agent 自由编排 SQL+检索 + 跨合同。

### 已实现（2026-06-16）

tool-calling agent 已落地并接上 `POST /api/query`。计划：`docs/superpowers/plans/2026-06-16-agentic-toolcalling-qa.md`。

- `contract_rag/retrieval/agent.py` `answer_with_evidence()`：`rag_generate` 模型 `bind_tools([query_ledger, search_clauses])`，手写 tool-calling 循环（上界 `MAX_TOOL_ROUNDS=6`），终态产 `{answer, evidence[]}` JSON。
- `contract_rag/retrieval/tools.py`：`query_ledger`（复用 graph 的 `_row_matches_filters`，filters 由 LLM 给）、`search_clauses`（包 `retrieve()`，投影成 clause 视图）、`attach_clause_provenance`（按 snippet 回查 chunk 回填 page/bbox）。
- `contract_rag/retrieval/evidence.py`：`normalize_evidence` 清洗 LLM 产出（丢非法项）。
- **page/bbox 全程打通**：chunker→Weaviate `bbox`(NUMBER_ARRAY)→`_doc_to_source`(+page/bbox)→`search_clauses`→provenance 回填→`QuerySource`/evidence。**bbox 旧 chunk 要 re-ingest 才有值。**
- **真实栈验证**（2026-06-16）：clause 问题→2 条 clause evidence（page 8/9 回填）；"金额>5万"→2 条 record evidence（LLM 返回金额与 SQL 一致）。
- 单元闸：evidence/tools/agent 纯函数 + API 共 258 passed。agent 活体调用走集成（不进闸）。
- 旧 `classify_query`/`sql_gated_*`/`answer_with_sources` 留作 eval/内部 helper，**不再支撑 endpoint**。

### 数据状态 + 三个坑（2026-06-17 重置语料）

- **当前库 = 3 个新合同**（旧 4 个 2026004/CN2026002/2026002/2024030 已从 SQLite+Weaviate 删除）：`JSUS2025029`(IT运维 Goshen,37chunk)、`JS3042019US42`(自动售货机 Compass,29)、`JSEGRCXS20250008 / PO-6000001438`(埃及采购 Jushi Egypt,21)。入库 = `extract_approval(pdf,1)`→`persist_approval`(写 contracts 行) + `ingest_contract`(MinerU→chunk→Weaviate)。
- **坑1 · MinerU 缺 cv2**：venv 没装 `opencv-python`，MinerU 子进程 `ModuleNotFoundError: No module named 'cv2'` 退出 1。修：`uv pip install opencv-python-headless`（**未写进 pyproject**，重建环境会再犯）。
- **坑2 · bbox 只有数字件有**：bbox 来自 MinerU 版面坐标；扫描页走 Gemini OCR **不产出 bbox**。这 3 个新合同多为扫描件 → clause evidence 的 `bbox` 基本为 null（核实弹窗只能定位到页、画不出精确高亮）。要演示精确高亮需数字 PDF（如已删的 2026004）。`page` 不受影响。
- **坑3 · provenance 匹配要容错**：`attach_clause_provenance` 靠 LLM 的 snippet 回查 chunk 取 page/bbox；LLM 很少逐字照抄（会重排空格/轻改）→ 严格子串匹配会丢 page。已改为 `_find_source_chunk` 归一化空白 + difflib 覆盖度回退（阈值 0.6）。

## 七、奠基石：Baseline vs Agentic 对比（2026-06-18，困难混合 / 跨合同问题集）

> **这一节是把 `POST /api/query` 切成 tool-calling agentic RAG 的权威证据。** 以后任何相关改动想佐证「为什么用 agent」，都引这一节。runner：`evals/run_baseline_vs_agent.py`；报告：`evals/reports/2026-06-18-023218.json`；数据集：`evals/dataset_sql_gated_agent.jsonl`。

**两臂对比**：

- **baseline 臂**：`graph.answer_with_sources(q, temperature=0, use_reranker=False)` —— 旧的一次性 RAG，**系统侧路由**（`classify_query` → entity 查 SQLite / clause 查 Weaviate；**无 tool calling**；entity/comparison 问题把**所有合同**当 sources 堆上去）。
- **agent 臂**：`agent.answer_with_evidence(q, temperature=0)` —— **现网 `POST /api/query` 端点**。LLM `bind_tools` 两个工具（`query_ledger` 查 SQLite、`search_clauses` 查 Weaviate），**自己决定调哪个**，返回统一 `evidence[]`（kind=record/clause；clause 的 page/bbox 从真实 chunk 回填）。
- **语料**：4 合同（`JSUS2026004` ChemAqua 数字件 / `JSUS2025029` IT运维 / `JS3042019US42` 自动售货机 / `JSEGRCXS20250008` 埃及采购），8 条问题：2 条锚点（合同号→条款、供应商→金额，两臂都能做）+ 6 条**困难题**（SQL max(金额)+条款、金额过滤+逐合同条款、跨合同付款期对比、跨合同条款聚合、描述→合同→条款）。困难题刻意要求 **SQL+条款混合编排 / 跨合同**——baseline 的固定路由结构上做不到。

**结果（n=8，困难题版；已修 JSON 解析 bug、无空答）**：

| 指标 | baseline | agent |
|---|---:|---:|
| answer_similarity | 0.825 | 0.893 |
| retrieval_coverage | 0.296 | 0.771 |
| top1_expected | 0.875 | 1.000 |
| all_expected_hit | 0.875 | 1.000 |
| source_precision | 0.604 | 1.000 |
| empty_answer | 0.000 | 0.000 |
| tool_rounds | – | 2.000 |

> 对比 3 合同"较易"版（曾测 0.860/0.811/all_hit=1.0/rounds=1.375）：换困难题后 **answer_similarity 差距从 +0.036 拉大到 +0.068**，baseline 的 `all_expected_hit` 从 1.0 **跌到 0.875**（跨合同题漏召），agent `tool_rounds` 升到 2.0（混合题真的要先 query_ledger 再 search_clauses）。即**问题越难、差距越大**。

> 指标口径：answer_similarity（答案 vs ground_truth 的 embedding cos）、retrieval_coverage（ground_truth vs 证据片段/context 的 max cos）、top1_expected（首个返回合同在 expected ids 内）、all_expected_hit（expected ids 全部返回）、source_precision（命中 expected / 去重返回合同数）、tool_rounds（agent 工具调用轮数）、empty_answer（空答案率）。

**怎么读这个数（最关键的 WHY）**：

- **混合题**（如「金额最高的合同付款条款是什么」「金额超过5万的合同付款期分别多少」）baseline 结构上无解：走 entity 路径只有金额没条款（coverage=0），走 clause 路径又不会按金额过滤/排序。agent 先 `query_ledger` 选出合同、再 `search_clauses` 取条款（tool_rounds≈2），两类证据都给。
- **跨合同题**（如「对比 IT运维 和 水处理 的付款期」「每份合同的付款期」）baseline 的 `all_expected_hit` 跌到 0.875——它召不全多个目标合同；agent 1.000。
- 全程 baseline 的 entity/聚合路径 **retrieval_coverage≈0.30、source_precision≈0.60**：不返回 context、还把全部合同堆成 sources；agent **precision 1.00、coverage 0.77**，只返回相关合同 + 真实证据。
- 所以 agentic 的增量**恰好集中在 baseline 固定路由最弱的地方**，且**问题越难差距越大**（见上文对比）。

**与四点六的关系（不矛盾）**：四点六里「固定路由 agent 在 scoped 单干净数字件上零增量」的结论**仍然成立**——价值不在那里。价值恰恰出现在**开放、结构化、多合同**这套问题集上，而这才是真实工作负载。因此把端点切成 tool-calling agent 是**有证据支撑的决策**，本节即该决策的参考。

**评测期发现并修掉的真 bug**：Gemini-3 偶尔在终态 JSON 里注入一个游离 token；`agent._loads_tolerant` 现已修复（修复前曾导致 1/8 空答案，拖低了 agent 的 answer_similarity/top1/all_hit）。

## 八、Reranker 接入：托管 Vertex Ranking API（2026-06-19）

把检索的精排臂从「砍掉状态」重新接上，但**换了实现**——弃用会 OOM 的本地 bge，改用 **Google 托管 Vertex AI Ranking API**（`semantic-ranker`）。代码：`contract_rag/retrieval/reranker.py`。

- **为什么换**：本地 cross-encoder（bge-reranker-v2-m3）把 batch padding 到最长序列，合同大表格 chunk 触发 ~10 GiB OOM（四点五坑3）。托管 API **无本地模型→无 OOM**；长 record 超 1024 token 是截断而非崩溃。
- **是什么**：cross-encoder（交叉编码）——query+文档拼一起进 transformer，token 级交叉注意力，输出每对一个相关性分；和 embedding（双塔，分开编码）是接力不是替代。
- **接法**：`retrieve()` 的 `use_reranker` 开关（config `retrieval.use_reranker`，**默认 false**）。开则拉满 k 候选 → `reranker.rerank()` 重排到 top_n。模型走 config `models.rerank`（默认 `semantic-ranker-default@latest`，1024 token/record）。
- **认证/前置**：REST 调 `discoveryengine.googleapis.com/.../rankingConfigs/default_ranking_config:rank`。需 ① 启用 **Discovery Engine API** ② SA（`GOOGLE_APPLICATION_CREDENTIALS`）有 **Discovery Engine Editor** 角色（`rank` 权限不在 Viewer 里，曾因此 403）。project=`VERTEX_PROJECT_ID`，location=`global`。限流 500 rank req/min（不可调，但内部问答量级碰不到）；计费按「rank request」（每次调用）。
- **已验证（活体）**：中文 query 把放在中间的付款条款顶到第 1（0.46 vs 0.07/0.03）；**中↔英跨语言**也对（中文问「付款期限」→ 英文 "within thirty (30) days" 排第 1，0.55）。`reranker.rerank()` 端到端通。
- **测试**：纯函数（`_build_records`/`_request_payload`/`_reorder` + `rerank` 组合）进单元闸（`tests/retrieval/test_reranker.py`，网络 stub）；活体 `_rank_via_api` 走集成不进闸。全量 292 passed。
### A/B 结果（2026-06-19，检索维度，hard 集 8 题）

**结论：当前 4 合同语料上 reranker 无增量，保持 `use_reranker: false`。** runner：`evals/run_reranker_compare.py`（开放检索，拉 k=20 候选一次 → 对比 top5 hybrid vs top5 reranked vs top20 ceiling；同步 embedding 算 retrieval_coverage）。

| | cov@5 off | cov@5 on | cov@20 ceiling | Δcov | 合同 recall@5 |
|---|---:|---:|---:|---:|---:|
| MEAN(n=8) | 0.757 | 0.760 | 0.760 | **+0.002** | 0.69→0.69 |

**为什么没用（关键，已证实非假设）**：**cov@5 off (0.757) ≈ cov@20 ceiling (0.760)**——对的内容本来就在 top-5 里，扩到 top-20 几乎不加分，**没有 headroom 供 reranker 发挥**。8 题里 6 题 Δcov=0.000（top5 已等于 top20 上限）。根因是语料太小（4 合同 ~132 chunk）：top-20 早已覆盖大部分相关 chunk，召回提前饱和，相关 chunk 不会被挤到 5 名外。

**还有个轻微负面**：`over_50k_with_clause` 的合同 recall 1.00→**0.50**——reranker 按单 chunk 相关性重排，会把某个 expected 合同的 chunk 挤出 top5（多合同聚合/对比题尤其吃亏：精排追求单条最相关，牺牲合同多样性）。recall 净值持平（有升有降）。

**与四点五一致**：当年 alpha 扫描在干净数字件上是噪声 → 这里精排同理无增量，且现在**实测证实**了「小语料无 headroom」这一机制。**真要 reranker 有用，得等语料规模大到 recall@5 明显 < recall@20**（大库里相关 chunk 才会沉到 5 名外）。代码已就绪（默认 off），那天到了翻 `use_reranker` 即可。

### 100 合同 CUAD 重测（2026-06-19，scoped 检索，185 条 gold）

> 为了验「大语料是否给 reranker headroom」,灌了 **CUAD 100 份真实合同**（6499 chunk,见 [[ingestion_pipeline]] / `scripts/ingest_cuad.py`）,用 **CUAD 官方条款标注**建了 185 条 gold（`evals/dataset_cuad_gold.jsonl`,零 Gemini 生成,span 即 ground_truth）。runner：`evals/run_reranker_cuad.py`（**scoped 到 expected 合同**检索,k=20→top5,同步 embedding）。报告：`evals/reports/reranker_cuad_2026-06-19-223422.json`。

| | cov@5 off | cov@5 on | cov@20 ceiling | Δcov |
|---|---:|---:|---:|---:|
| MEAN(n=185) | 0.802 | 0.806 | 0.808 | **+0.0035** |

**结论：大语料也没翻盘,保持 `use_reranker: false`。** 但这次量化了原因:
- **headroom 依旧稀薄**:185 题里只 **13 题**（7%）的对 chunk 沉在 top-5 之外（cov@20−cov@5>0.02）;其余 93% hybrid 首轮就把对的条款放进 top-5,reranker 无事可做。cov@5 off(0.802)≈cov@20(0.808),和 4 合同那次同形。
- **有 headroom 时 reranker 确实管用**:那 13 题里 **9 题**被 reranker 拉回（69%）——所以不是 reranker 不行,是**可发挥的场合太少**。
- **为什么大语料也没造出 headroom**:本测 **scoped 到单合同**(每题只在该合同 ~20–100 chunk 里排),hybrid 在小池里已很强。**真正可能见效的是 open 跨合同检索**（6459 chunk 混排,精度才吃紧）——本轮**未测**（受 Gemini 调用预算约束,gold 已封顶 200 条）。若后续要测 open,指标要换成「expected 合同 chunk 是否进 top-5」(recall),不能用 cov(跨合同同类条款 cos 都高,cov 区分不出对错合同)。

**一句话**:scoped 设定下,100 合同 reranker 仍是噪声级增量(+0.0035);唯一未盖的缺口是 open 跨合同,留作后续。
