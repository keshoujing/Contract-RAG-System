# V1 合同上传 Pipeline 后端设计（纯录入模式）

> 状态：设计已确认（2026-06-03），已逐行对照 `frontend/` 现状核验。下一步进实现计划。
> 关联：`memory/ingestion_pipeline.md`（决策 4/7/8/10/15）、`docs/INTERFACE.md`、
> `docs/plans/2026-06-03-frontend-implementation.md`。

## 目标与边界

为前端提供 V1 后端：一条**纯存档**的合同上传 pipeline + 把已有函数接成完整 REST。
**V1 明确不做** RAG 相关：不解析正文、不 OCR/MinerU、不分块、不嵌入、不写向量库。
只有审批页走一次 LLM 抽取；其余页整份 PDF 原样存档。

四项已敲定的产品决策：
1. **非审批页 = 纯存档**，完全不解析（对齐 UI 文案「纯录入模式下不解析正文」）。
2. **上传走异步 task + 轮询**（沿用决策 7，为 V2 RAG 对齐前端轮询逻辑）。
3. **重传 = 覆盖式 + 前端确认**（决策 8）。
4. **REST 表面全量铺齐**（含 Excel 同步端点，Excel 关着时返回 `disabled`）。
5. **工作范围**：后端 FastAPI 层 + 前端上传向导从 mock 重接为真调用。

## 现状盘点（已存在，无需重写业务逻辑）

- `ingest/approval.py` — `extract_approval(pdf, page_no)` → 字段 + `_per_field_confidence` + `_per_field_source_span`
- `ingest/approval_store.py` — `persist_approval()` / `resolve_contract_id()` / `contract_row_from_approval()`
- `storage/db.py` — SQLite `contracts`/`tasks`/`pages` 三表 + `create_task`/`update_task_stage`/`get_task`/`upsert_contract`/`contract_exists`/`get_contract`/`list_contracts`
- `sync/` — Excel 同步全套：`sync_contract`/`resolve_conflict`/`get_status`/`list_statuses`/`get_conflict`（service.py）、`file_no.py`（`assign_file_no`/`get_file_no_rules`/`set_file_no_rules`/`compose_file_name`/`next_seq`）、`state.py`/`merge.py`/`normalize.py`/`excel_adapter.py`/`settings.py`/`models.py`
- **不存在**：任何 HTTP/FastAPI 层。

## 架构

FastAPI + uvicorn，单机部署。慢步用 `BackgroundTasks`（缩略图渲染、审批页 LLM 抽取）。
SQLite 仍是真源，前端轮询 task stage。不上 Celery/Redis（决策 7）。所有端点挂在 `/api` 下
（前端 `client.ts` 默认 `VITE_API_BASE || "/api"`）。

### 新增包结构 `contract_rag/api/`

```
contract_rag/api/
  app.py            # FastAPI 工厂：CORS、挂路由、(prod) StaticFiles 托管前端构建产物
  schemas.py        # Pydantic 模型，对齐 frontend/src/api/types.ts
  projections.py    # 纯函数：contracts行→ContractRow、sync+task→ProcessingRow、
                    #         FieldConflict→ConflictField、config→ConfigState
  rendering.py      # fitz: PDF→每页 PNG 缩略图（纯 I/O helper）
  storage_paths.py  # _uploads/{task_id} ↔ storage/{contract_id} 路径 + 移动 + 路径穿越防护
  routes/
    uploads.py      # 上传流五端点 + 缩略图/原件文件服务
    contracts.py    # GET /contracts、/contracts/:id、/contracts/export、文件下载
    processing.py   # GET /processing、POST /contracts/:id/sync/retry
    conflicts.py    # GET /contracts/:id/conflict、POST /contracts/:id/resolve
    config.py       # GET /config
```

`projections.py` 是纯函数，单测覆盖；端点用 FastAPI `TestClient` 集成测试，外部 I/O
（Gemini 抽取）按现有测试风格 mock。

## 数据模型改动（additive migration，复用 `_migrate_contracts` 风格）

- `tasks` 表：`+ approval_page INTEGER`、`+ extraction TEXT`(JSON) —— 暂存用户选的审批页与抽取结果，供轮询直接读
- `contracts` 表：`+ page_count INTEGER` —— 台账/详情需显示页数（纯存档模式 `pages` 表不填，故存合同行上）
- 文件大小不加列，读取时 `os.stat(signed.pdf)` 派生

## 上传流（异步状态机）

走 `IngestStage` 子集：`uploaded → tagging → llm_extraction → awaiting_user_confirmation → done`（+`failed`）。
`tagging`/`awaiting_user_confirmation` 是**等人**步，`llm_extraction` 是后台步。

| # | 端点 | 行为 |
|---|---|---|
| 1 | `POST /api/uploads`（multipart `file`） | 校验 PDF + ≤50MB → `create_task()`(uploaded) → 存 `storage/_uploads/{task_id}/signed.pdf` → **后台**渲染每页 PNG，完成置 `tagging` → 即时返回 `{task_id, page_count, filename}`（fitz 取页数无需渲染） |
| 2 | `GET /api/uploads/{task_id}` | 轮询：`{task_id, stage, status, page_count, error?, fields?}`；`fields` 仅在 `awaiting_user_confirmation` 时带：`{contract_id_guess, values, per_field_confidence, per_field_source_span}` |
| 3 | `GET /api/uploads/{task_id}/pages/{n}` | FileResponse 缩略图 PNG（路径穿越防护） |
| 4 | `POST /api/uploads/{task_id}/extract` `{approval_page}` | 记审批页 → `llm_extraction` → **后台** `extract_approval()` → 结果写 task → `awaiting_user_confirmation`；即时返回 202 |
| 5 | `POST /api/uploads/{task_id}/confirm` `{values, effective_date, expiration_date, category, overwrite?}` | 见下方确认逻辑；返回 200 ContractRow 或 **409** `{conflict:"duplicate", contract_id}` |
| — | `GET /api/contracts/{id}/file` | 原件 signed.pdf 下载 |

**确认（#5）逻辑：**
1. 取用户最终 `contract_id`（用户可在确认表里改）
2. 去重：`contract_exists()` 且非 `overwrite` → **409** `{conflict:"duplicate"}` → 前端弹覆盖确认
3. `overwrite=true` → 删旧（`contracts` 行 + `storage/{contract_id}/` 目录；V1 无向量库要清）
4. `upsert_contract()` 写确认值 + 生效/到期日 + `status=active` + `page_count`
5. `assign_file_no(contract_id, category=...)` → file_no（file_name 派生）
6. 移 `storage/_uploads/{task_id}/` → `storage/{contract_id}/`；task.contract_id 回填，stage=`done`
7. `sync_contract(contract_id)` → Excel 推送（关着返回 `disabled`）
8. 返回新建 ContractRow

**渲染参数**：~110dpi PNG（够清晰认页、省体积），审批页确认时的预览复用同一张。

## 读 + 同步端点（投影已有函数）

| 端点 | 实现 | 投影补全 |
|---|---|---|
| `GET /api/contracts?q&department&status&year&sort` | `list_contracts()` + 服务端筛选/排序（镜像 `client.ts` 的 `applyContractQuery`） | → ContractRow（见下「ContractRow 投影」） |
| `GET /api/contracts/:id` | `get_contract()` | 同上 |
| `GET /api/contracts/export?...` | openpyxl 导出筛选结果为真 xlsx | — |
| `GET /api/processing` | `state.list_all()` ⋈ `tasks`(最新) ⋈ `contracts` | ingest=tasks{stage,status,error_message→last_error}；sync=state{state,attempts,last_error,last_attempt_at,updated_at}；不出 `next_retry_in_seconds`（前端从 `last_attempt_at+60s` 算） |
| `POST /api/contracts/:id/sync/retry` | `sync_contract()` 幂等重试 | — |
| `GET /api/contracts/:id/conflict` | `get_conflict()` | **补 `owner`**（查 `SYSTEM_FIELDS`/`HUMAN_FIELDS`）**+ `suggested`**（owner=human 且仅 excel 偏离 baseline → `"excel"`，否则 `"system"`） |
| `POST /api/contracts/:id/resolve` `{resolutions}` | `resolve_conflict()` | 直通；`"system"/"excel"/手填值` 已对齐 |
| `GET /api/config` | `config.excel.enabled` + `get_file_no_rules()` | 见下「ConfigState 投影」 |

### ContractRow 投影（contracts 行 → 前端 ContractRow）

- 直取列：`contract_id`/`counterparty`/`amount`/`currency`/`project_name`/`contract_type`/`petitioner`/`petition_date`/`file_no`/`effective_date`/`expiration_date`/`department`/`brief_description`
- `file_name` = `compose_file_name(file_no, contract_id, project_name)`
- `pages` = `page_count` 列
- `size` = `os.stat(signed.pdf)` → `f"{bytes/1024/1024:.1f} MB"` 字符串
- `archived_at` = `created_at` 格式化为 `"YYYY-MM-DD HH:MM"`（本地展示串）
- `status` 派生规则：
  - `effective_date` 或 `expiration_date` 为空 → `"pending"`
  - 否则 `expiration_date < 今天` → `"expired"`
  - 否则 → `"active"`（沿用列值）

### ConfigState 投影

- `excelEnabled` ← `config.excel.enabled`
- `ragEnabled` ← `false`（V1 固定）
- `backupEnabled`/`lockCheckEnabled` ← 默认 `true`（config 暂无此项，占位只读）
- `fileNoRules` ← `get_file_no_rules()`（`{category:{prefix}}`）reshape 成 `[{category, prefix, example}]`，`example = format_file_no(今年, 1, category)`

## 部署 / 边界

- **开发**：Vite :5173 + API :8000，CORS 放行 dev origin
- **生产**（可选）：FastAPI `StaticFiles` 同源托管前端构建产物 + `/api`
- **不做（V1）**：正文 OCR/MinerU/分块/嵌入；决策 7 的自动重试后台循环（重试改前端手动触发 `/sync/retry`）；鉴权；config 写接口（设置页开关 V1 仅本地 cache，不持久化）

## 前端重接（上传向导）

`UploadPage.tsx` 当前 100% mock（假进度、硬编码字段、图标占位缩略图、确认仅 toast）。重接工作：
1. `api/types.ts`：新增 `UploadResponse`/`TaskStatus`/`ExtractedFields`/`ConfirmPayload` 类型
2. `api/client.ts` + `api/hooks.ts`：新增 `postUpload`/`getUploadStatus`(轮询)/`postExtract`/`postConfirm` + 对应 hooks
3. `UploadPage.tsx`：
   - 真上传 → 轮询直到 `tagging`（缩略图就绪）
   - 缩略图网格渲染真 `<img src={.../pages/n}>`
   - 选审批页 → 调 `extract` → 轮询直到 `awaiting_user_confirmation`
   - 确认表单用抽取结果填充 + `<0.85` 置信度红高亮（用 `per_field_confidence`）
   - 「确认入账」调 `confirm`，处理 **409 → 覆盖确认弹窗** → 带 `overwrite=true` 重提
4. `FieldConfirmPage.tsx`：当前是未接入的重复 mock 页，确认删除或并入向导

## 6 条对齐项（实现时必须处理）

1. **存档分类词表统一**🔴：后端 seed `default/chinabuy/PD` vs 前端 `ordinary/china-buy/production`。
   方案：**分类词表以后端 `file_no` 规则为唯一来源**，前端上传向导的分类下拉改为从 `GET /config.fileNoRules` 动态填充（不再硬编码），confirm 提交后端的 category key。
2. **ConflictField** 补 `owner` + `suggested`（见上）。
3. **ContractRow 派生字段** + `page_count` 加列（见上）。
4. **时间显示**：后端 `updated_at`/`archived_at` 输出展示串（前端直接渲染原值）。
5. **设置页开关**：rag/excel/backup/lock 仅本地 cache，无持久化；Excel 真开关需改 `config.yaml`（V1 该开关不翻转后端行为）——文档/UI note 说明，不在 V1 修。
6. **行为提示**：`/processing` 的「处理中(running)」V1 几乎恒为 0（入库在 confirm 同步完成；未确认上传 task 无 contract_id，不进该页）。该页 V1 实质只反映 Excel 同步态。

## 测试策略（对齐仓库现有 38 单测风格）

- 纯函数单测：`projections.py`（ContractRow/ProcessingRow/ConflictField/ConfigState 投影）、`storage_paths.py`（路径解析/移动/穿越防护）、status 派生、size/时间格式化、分类 example 计算
- FastAPI `TestClient` 集成测试（临时 DB + tmp storage）：上传→轮询→extract（mock `extract_approval`）→confirm 全流程；重复→409→overwrite；Excel 关时同步端点返回 `disabled`，开时（tmp xlsx）走 pending/synced/conflict
- 外部 I/O 边界（Gemini/fitz）按现有风格 mock
