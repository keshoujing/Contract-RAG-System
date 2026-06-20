# Tool-calling Agentic Q&A — 计划

> 日期：2026-06-16 · 关联契约：`docs/INTERFACE.md` §5（target）、前端原型 `docs/pencil-new.pen`、
> `memory/retrieval_eval.md` §六。前序（被本计划取代的启发式路由）：`graph.py` 的
> `classify_query` + `_extract_sql_filters` + `sql_gated_*`。

## 目标

把**系统启发式路由**换成 **LLM tool-calling agent**：agent 自己决定调 `query_ledger`（SQLite）
还是 `search_clauses`（Weaviate）还是两者，返回 §5 统一契约 `{answer, evidence[]}`，
其中 `evidence` 每条带 `kind`（`record` / `clause`），`clause` 带 `page` + `bbox`。

## 设计

### 工具（agent 可调用）
- `query_ledger(filters: dict) -> list[row]` —— 结构化查 SQLite `contracts`。filters 由 **LLM** 给（不再正则猜）。复用 `db.list_contracts` + 一个纯过滤函数。
- `search_clauses(query: str, contract_id: str | None) -> list[chunk]` —— 包 `retrieve()`，每条 chunk 映射成 `{contract_id, page, section, snippet, bbox}`（复用 `_doc_to_source`）。

### Agent
- `rag_generate` 模型 `bind_tools([query_ledger, search_clauses])`，tool-calling 循环，迭代上界（复用 `MAX_REWRITES` 量级）。
- 终态产出**结构化** `{answer, evidence[]}`（最后一跳 JSON 输出）。

### evidence 组装（关键决策）
- **record**：由 **LLM 返回** `{kind:"record", contract_id, title?, fields{}}` —— 遵循用户决定（record 更贴用户需求，保留 LLM 产出）。
- **clause**：LLM 给 `{kind:"clause", contract_id, section, snippet}`；**系统按 snippet 回查 `search_clauses` 的原始 chunk，回填 `page` + `bbox`** —— LLM 没法可靠产出浮点 bbox 数组，且 page/bbox 必须与原 chunk 一致。这是"LLM 选证据、系统供坐标"的最小必要折中（仅限 bbox/page，不碰 record 值）。

### 提示词
- 新系统提示：教工具用法 + §5 的 evidence/kind 规则（clause snippet 逐字、record 每个命中合同一条、只返回 JSON、禁编造）。

### 取舍
- **退休**启发式：`_extract_sql_filters` / `_has_structured_hint` / `sql_gated_*` / `classify_query` 的路由职责。`retrieve()`、`_doc_to_source`、`db` 原语保留。
- API：`POST /api/query` 增 `evidence` 字段（`answer_with_evidence()`）；`sources` 暂留兼容。

## TDD 切片（按序）
1. **evidence 数据模型** `contract_rag/retrieval/evidence.py`（`EvidenceItem` record/clause + 序列化）。纯函数，进单元闸。 ← 先做
2. **`query_ledger`** 过滤纯函数（fake db）。
3. **`search_clauses`** 映射（fake retrieve → clause dict 含 page/bbox）。
4. **clause bbox/page 回填**（snippet→chunk 匹配）纯函数。
5. **tool-calling agent**（bind_tools + 循环 + 结构化终态）—— 集成入口（真实 Gemini+Weaviate），不进单元闸。
6. **API** `answer_with_evidence` + schema `evidence` 字段（TDD）。
7. **提示词**落地 + 端到端手验。

## 验收
- 单元闸绿（1–4、6 的纯函数/schema 测试）。
- agent 对单合同 clause、跨合同 record、混合三类问题返回正确 `evidence`（手验）。
- `POST /api/query` 返回 `{answer, evidence[]}`，clause 带 page/bbox，前端可直接接。
