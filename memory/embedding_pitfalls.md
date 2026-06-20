# 向量化（Embedding）踩坑与检索质量

## 致命坑：`GoogleGenerativeAIEmbeddings.embed_documents()` 在 Vertex 上静默丢数据

> 2026-05-28 在 2026004（50 chunks）上测检索时发现。**这是会静默污染整个向量库的 P0 级 bug。**

### 现象
`LLM().get_embedding_object().embed_documents(texts)` 传 N 条文本，**返回的向量数 ≠ N**：
- 50 条合同 chunk → 只回 **3** 个向量
- 50 条短文本 → 只回 **1** 个向量

下游 `np.array(...)` 不会报错（shape 是 `(3, 3072)`），只有打印 `shape[0]` 才看得出来。检索时整个语料只有 3 条，导致**任何 query 都命中同样的前 3 个 chunk**（包括一个只有 `[image]` 7 个字符的图片 chunk）。`recall@1 = 0%`。

### 根因（已读源码确认 `langchain_google_genai/embeddings.py`）
`embed_documents` 用 `_prepare_batches` 按 token 预算（单批 ≤20000 token / ≤100 条）把文本打包，然后 `client.models.embed_content(contents=batch, ...)` **把整批作为一个 `contents` 列表传给 Vertex `gemini-embedding-2`**。该端点对 list 输入**只返回 1 个向量**（整批合成一个），wrapper 却假设一条文本一个向量。于是：
- 50 条长文本按 token 预算切成约 3 批 → 3 个向量
- 50 条短文本 1 批 → 1 个向量

`task_type`（RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY）**不是**原因——加不加结果字节一致；`embed_documents` 默认已是 RETRIEVAL_DOCUMENT、`embed_query` 默认 RETRIEVAL_QUERY，无需手动设。

### 修复（已落地 `src/llm.py`）
子类 `_PerItemGoogleEmbeddings` 覆盖 `embed_documents`，**强制 `batch_size=1`**——每个请求只发一条，端点就正确返回一条。`WeaviateVectorStore.add_documents` 调 `embed_documents` 时不传 `batch_size`，所以必须把默认值改掉，不能只在调用点传。
- 代价：每 chunk 一次 HTTP 请求（50 chunk 合同 = 50 次）。批量入库不敏感，V1 可接受。
- 检测手段：embed 后 `assert len(vecs) == len(texts)`，或建索引后查 collection 里 chunk 数对不对。

## 检索质量基线（修复后，2026004，gemini-embedding-2，dim=3072）

10 条中英混合 query（每条预先标注 ground-truth chunk），内存 cosine 排序：

| 指标 | 结果 |
|------|------|
| recall@1 | **9/10 = 90%** |
| recall@3 | **10/10 = 100%** |

唯一非 top-1：「付款账期」query 把条款 4（Payment）排到第 2（第 1 是 p3 一段含日期的签字段），仍 HIT@3。

**结论：chunker 输出向量后可用性高，问题从来不在 chunk，而在 embedding 调用。** 几个验证点：
- **跨语言可用**：中文 query 直接命中英文条款（「终止」→ clause 17 Termination top-1，sim 0.62；「单价」→ p2 价格表 top-1，sim 0.72）。section-aware 切分（每条编号条款独立成 chunk）让法律条款类 query 普遍 top-1。
- **表格可检索**：生效日期表 top-1、价格表 top-1/top-3，即使 query 是中文。
- 「调价机制」query 同时召回 escalation(17) + hyperinflation(19) 两条，符合预期。

> 复现脚本：`_retrieval_test3.py`（batch_size=1 正确版）、`_retrieval_inventory.py`（chunk 清单+ground truth）。`_retrieval_test.py` / `_test2.py` 是踩坑过程（0% recall），保留作对照。
