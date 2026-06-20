# 合同入库 Pipeline

> 本文件是合同入库主流程的设计方案。开发入库相关功能前先读此文件。
> 关联：[pdf_parsing.md](pdf_parsing.md)（PDF 解析底层方案）。

## 一、流程总图

```
用户上传一份 PDF (审批 + 合同 + 比价 预先合并成一份)
  ↓
缩略图 UI → 用户拖拽标页段类型 (审批 / 合同 / 比价 / 补充)
  ↓
异步任务入队 (task_id 占位) → 前端轮询 stage 显示进度
  ↓
按页段分流：
  ┌─────────────────────────────────────────────────────────────┐
  │ [审批页]   整页 (OCR文本 + 页图) → 小 LLM (JSON Schema 强制输出)│
  │           → 前端字段级确认 (low_confidence 红色高亮)           │
  │           → 抽出 contract_number → 作 contract_id              │
  │             (抽不到由用户手填)                                  │
  │           → 写 SQLite 合同 metadata (不进向量库)              │
  └─────────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────────┐
  │ [合同页]   逐页判: 图片覆盖率 + 文字层字符数                    │
  │                                                              │
  │   ├── 数字页 (覆盖率 ≈ 0%, 文字层 > 0)                        │
  │   │     → MinerU 解析                                        │
  │   │     → rechunk: 标题分段 + 大小封顶 + 表格独立              │
  │   │     → 嵌入 + 写 Weaviate                                 │
  │   │                                                          │
  │   └── 扫描页 (覆盖率 ≈ 100%)                                  │
  │         → 询问用户有无数字原件 (仅 PDF)                        │
  │                                                              │
  │         ├── 有 → 用户上传原件 → 存 ./storage/{contract_id}/    │
  │         │       → OCR 签字版                                  │
  │         │       → RapidFuzz 对齐原件                          │
  │         │           ≥ 90  → 用原件文本替换 (消除乱码)          │
  │         │           60-90 → flag 人工                         │
  │         │           < 60  → 标 unique_to_signed (保留 OCR)    │
  │         │       → rechunk + 嵌入 + 写 Weaviate                │
  │         │                                                    │
  │         └── 没 → OCR 签字版                                   │
  │                 → 全文 avg confidence < 0.80                  │
  │                   ├── 是 → 整份退回 (前端提示用户重传)         │
  │                   └── 否 → chunk 级编辑确认 → 嵌入 + 写 Weaviate│
  └─────────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────────┐
  │ [比价/补充] V1: 当通用文档存档, 不向量化                       │
  │             V2: 关键字段结构化抽取                             │
  └─────────────────────────────────────────────────────────────┘
  ↓
签字版 PDF   → ./storage/{contract_id}/signed.pdf  (永久存档, 可下载)
数字原件 PDF → ./storage/{contract_id}/original.pdf (可下载, 用户传了才有)
```

## 二、核心设计决策

### 决策 1：一份合同 = 一份 PDF（签字版）

用户预先把审批 / 合同 / 比价合成**一份签字版 PDF** 再上传，UI 不支持多文件上传。

**例外**：扫描页分支里用户可选传"数字原件 PDF"，这是**第二份独立 PDF**（不在页段标注流程里，只用于对齐校正）。

**Why**：避免"多文件归属同一合同"的状态管理复杂度。用户合并 PDF 是一次性操作，比系统维护文件组关系简单。

### 决策 1.5：`contract_number` vs `contract_id` 术语

- `contract_number` = 审批页上印的**合同编号字符串**（如 `JSUS2024030`），是 LLM 抽取出的字段
- `contract_id` = **系统主键**，直接采用 `contract_number` 的值（不另发 UUID）
- 抽不到 `contract_number` 时，前端确认环节让用户手填，未填前用 `task_id` 占位

### 决策 2：页段类型由用户标，不让 AI 猜

UI 暴露页面缩略图，用户拖拽分段：第 1 页 = 审批，2-12 页 = 合同，13 页 = 比价 …… 共 4 种类型。

**Why**：让 AI 猜**文档类型**（审批/合同/比价/补充）在 corner case 上必翻车，让用户标是确定性最高的方案。

> 注：早期观察"MinerU 标题层级识别不稳定（5 份样本上漏识别多）"主要发生在**扫描页**上；2026-05-28 在 2026004 数字 PDF 上 MinerU 的 `text_level` 字段稳定可用（见 [`digital_parsing_evaluation.md`](digital_parsing_evaluation.md)）。**但"用 MinerU 识别页段类型"仍然不靠谱**——这是个文档级语义分类问题，不是版面级问题，本来就不该用版面引擎做。

### 决策 3：扫描 vs 数字 = 图片覆盖率 + 文字层字符数 (per page)

判别信号（fitz 元数据，毫秒级，已在 5 份合同上验证）：

| 图片覆盖率 | 文字层字符数 | 判定 |
|---|---|---|
| ≈ 100% | 0 | **裸扫描页**（必须 OCR） |
| ≈ 100% | > 0 | **OCR 过的扫描件**（有文字层但质量未知，按数字页处理） |
| ≈ 0% | > 0 | **数字矢量页**（最佳） |

**关键**：**按页判别**，不按整份文档分类。已发现"逐页混合"样本（财务审计：页 1 数字 + 页 2-12 扫描 + 页 13 数字）。

### 决策 4：审批页结构化抽取走小 LLM，强制 JSON Schema

整页（OCR 文本 + 页图）一起喂 Haiku 4.5 级别的小模型，**输出 schema 严格约束**：

```json
// 字段已对真实样本核对：审批表是统一模板 "China Jushi USA Contract Approval Form"，版式固定
{
  "contract_number":   "string | null",     // Contract Number 格（⚠️不是 Document Code）
  "counterparty":      "string | null",      // Seller's Party
  "amount":            "number | null",       // Contract Amount（解析 "$147,664.05"）
  "currency":          "string | null",      // 金额符号判（$→USD）
  "project_name":      "string | null",      // Project Name
  "department":        "string | null",      // Requisition Department（UD/FPW）
  "petitioner":        "string | null",      // Petitioner（申请人）
  "petition_date":     "YYYY-MM-DD | null",  // Date（申请日，非合同签署日）
  "brief_description": "string | null",      // Brief Description / Modified Content
  "_per_field_confidence":  { "<field>": 0.0~1.0 },
  "_per_field_source_span": { "<field>": "原文片段" }
}
```

**强制 LLM 必须给"猜测值 + confidence"**：抽不到也要给最可能的值，标低 confidence，前端**字段级**红色高亮让用户改（不同于合同页 OCR 用的 chunk 级编辑）。这比让用户从零填错误率更低（人填空表更容易看错）。

**真实样本踩坑（已验证）**：
- `Document Code`（如 `JSUS/04-1GS-126`）是**模板编号**，所有合同都一样——LLM 别把它当合同号，要抓 `Contract Number` 格的值。
- **文件名 ≠ 合同号**：样本文件 `2026004-JSUS2026006-…`，审批表上 `Contract Number` 实为 `JSUS2026004`。→ `contract_id` 必须以审批页抽取为准，绝不信文件名。
- 审批页**没有**合同签署日 / 生效日 / 到期日。原 `signed_date` 砍掉；`effective_date` / `expiration_date` 改由用户在确认环节手填（见决策 11）。

**Why 不正则**：审批表版式各家不同，正则维护成本爆炸。LLM 抽取每份成本 ~$0.001。

**Why 不分流**："输入 token 便宜，贵在输出"——审批页直接整页喂，不省那点输入费。

### 决策 5：原件对齐用 RapidFuzz 三态判定

`fuzz.ratio` 基于 Levenshtein 编辑距离归一化（0-100），三态：

| 相似度 | 含义 | 处理 |
|---|---|---|
| ≥ 90 | 同段，仅 OCR 局部噪声 | 用原件文本替换 OCR 文本（自动消除乱码） |
| 60–90 | 可疑：可能手写改动或 OCR 大段错 | flag 人工 |
| < 60 | 没匹配上 | 标 `unique_to_signed`，保留 OCR 文本 |

**对齐流程**：先用锚点（章节标题、条款编号、合同编号、金额这些强信号）建立坐标系，再做段内细比，避免跨章节假匹配。

**Why 字符级算法适合**：OCR 错误是**字符级局部噪声**，不破坏段落"模糊指纹"。Levenshtein 不看语义，乱码越像越好对。

### 决策 6：质量闸——只用 OCR 置信度，不堆第二信号 (V1)

主闸：**全文 OCR 平均置信度 < 0.80 → 整份退回**。

**Why 不加第二信号 (V1)**：
- YAGNI：还没有 MinerU 在真实合同上的置信度分布数据，先跑起来再说
- "confident garbage" 在中文上较少（中文字形差异大，识错置信度通常会掉）
- 真漏网了，前端 chunk 级编辑可以兜底
- V2 真有需要再加 fastText LID

**实验结论（2026-05-22，blur 不能当闸，已实证）**

受控模糊实验：数字水处理 p7 渲染 @200dpi，逐级高斯模糊后跑 MinerU `-m ocr`：

| 拉普拉斯方差 @200dpi | OCR 字数 | 实际质量 |
|---|---|---|
| 22717(清晰) ~ 96 | ~1.7 万 | **词级正确**（只丢空格/标点；difflib 相似度掉到 0.5 是被空格惩罚的假象，非乱码）|
| ≈ 25 | 394 | **塌缩**，只剩零星字 |
| < 10 | 0 | 整页判成 image，**0 字** |

1. MinerU(PaddleOCR) 对模糊**比预期耐受**：词级正确撑到 var≈96（已很糊）；失败模式是**突然塌缩到几乎 0 字**，不是大段乱码 → 印证"中文 confident garbage 少"。
2. **拉普拉斯方差不能当闸**：强依赖 dpi/内容——清晰页 @200dpi=22717，而自然扫描的垃圾填埋 @150dpi 才 ~1200 却 OCR 正常。同一数字含义天差地别，设 `var<X 拒收` 会误杀好页。
3. **可复用的标准（= 决策 6 的落地形式）**：
   - **主闸：OCR 产出量** —— 一页墨水占比 > ~3% 但 OCR 字数 ≈ 0（或极少）→ 判 OCR 塌缩 → 退回 / 人工 / VLM 重读。确定性、与 dpi/内容无关，连"整页是照片"也一并抓到。
   - 辅：OCR 平均置信度 < 0.80。
   - blur 方差最多当**极弱预筛**（同 dpi 下 var<~30 几乎必崩），不做硬闸。

局限：单页**英文** + 合成高斯模糊；中文笔画更密可能更早塌缩；任何方差数都绑定渲染 dpi。

### 决策 7：异步任务 + 进度可观测

SQLite 任务表存 `task_id`、`stage`、`status`，FastAPI BackgroundTasks 跑 worker，前端轮询 stage。

**stage 枚举**：
```
uploaded → tagging → ocr_processing → alignment (如有) →
llm_extraction → awaiting_user_confirmation → chunking →
embedding → done
```
失败时 status = `failed`，记 error_message。**V1 不做自动重试**。

**Why 不上 Celery/Redis**：V1 单机部署，FastAPI BackgroundTasks 足够；要重试/分布式再演进。

### 决策 8：重传 = 覆盖式 + 前端确认

**触发时机**：审批页 LLM 抽出 `contract_number` 后，查 SQLite `contracts` 表，若已存在同 `contract_id` → 暂停 pipeline → 前端弹窗"将覆盖原数据，继续？" → 用户确认后删旧（向量库 chunks + SQLite 行 + 文件系统目录）并继续。**V1 不做版本管理**。

**Why 在 LLM 抽完后才检测**：上传时还没有 `contract_id`，只能通过审批页抽取建立。早于此的去重只能靠文件名 hash，不可靠（同合同改个名就漏检）。

### 决策 9：原件支持 PDF only（V1）

数字原件接受数字 PDF；docx 留 V2。

**Why**：docx 处理用 python-docx，逻辑跟 PDF 完全不同，V1 不引入第二条解析链路。

### 决策 10：关系库 = SQLite 三表，真源在 SQLite，Weaviate chunk 只放 contract_id

**为什么留 SQLite（即便合同 metadata 不多）**：判断依据不是"合同字段多不多"，而是——
- 真正需要它的是 `tasks`（管线运行态：stage/status，前端轮询、worker 高频更新）和 `pages`（每页 route/置信度）。这俩是**事务性状态**，不该塞进向量库（拿错工具）。既然为它们要有 SQLite，那 10 个合同字段顺带放进去近乎零成本，还白赚 SQL 做 comparison/聚合。
- SQLite 是**文件 + 标准库**，无服务、无运维，"多养一个 DB" 的成本对它不成立（那是 Postgres 的顾虑）。
- 架构定为「SQLite 真源 + Weaviate chunk 只带 contract_id」→ `contract_id` 不可变 → **几乎无双写同步**，比现状（vendor_name/日期 denormalize 到每个 chunk）同步风险更低。

**`contracts` 完整列**（对真实审批表逐字段核对）：
- 审批抽取：`contract_id`(PK，直接采用 Contract Number) | `counterparty` | `amount` | `currency` | `project_name` | `department` | `petitioner` | `petition_date` | `brief_description`（展示用，非查询列）
- 确认环节用户手填：`effective_date` | `expiration_date`（见决策 11）
- 系统：`status`（默认 active）| `created_at` | `updated_at` | `raw_extraction`（JSON：全字段 + `_per_field_confidence` + `_per_field_source_span`）
- **不建列、塞 `raw_extraction`**：Budget / Calculate Price / Past Price / Cost Saving Ratio / Deposit / Contract Version / Payment Method / Under Credit flags
- **不入库 → V2 合规 pipeline**：审批链 / 签字人 / 签字时间戳 / 签字完整性 / 到期合规校验
- **砍掉** `signed_date`：审批页没有合同签署日

**检索过滤架构**：纯元数据问题（谁/何时/多少钱/编号）直接查 SQLite；带过滤的语义检索两步走——SQLite 按条件筛出 `contract_id` 集合 → Weaviate 按 `contract_id` filter + 向量检索。
→ **代码影响**：`vectorDB.py` 去掉 chunk 上的 `vendor_name/effective_date/expiration_date/action_date`，改为 `contract_id`；`stateGraph.py` 的 entity/comparison 查询从查 `summary` chunk 改为查 SQLite。

### 决策 11：effective/expiration 在确认环节用户手填

审批页没有生效/到期日。利用**已有的 `awaiting_user_confirmation` 步骤**（审批抽取结果本就要给用户做字段级确认），在该确认表单上加两个日期输入框采集 `effective_date`/`expiration_date`——不新增步骤、近零负担。

到期**校验/提醒**那个动作是 V2 合规 pipeline 的事；这里只采集**日期值本身**供日期范围查询用。

### 决策 12：embedding = `gemini-embedding-2` @ 3072 维

> 2026-05-28 在 2026004（50 chunks）实测选定：recall@1=90% / recall@3=100%，中文 query 直接命中英文条款。代码见 [`src/llm.py`](../src/llm.py)，踩坑见 [`embedding_pitfalls.md`](embedding_pitfalls.md)。

- **模型**：Vertex `gemini-embedding-2`（2026-03 发布的原生多模态 embedding，MTEB 多语种榜首 69.9；中英合同强）。**不用 `gemini-embedding-001`**——见下方"为什么选 2 不选 001"。
- **维度**：3072（建 Weaviate collection 时**定死**，事后改要重建 collection + 全量重嵌）。MRL 训练，将来要省存储可截到 1536/768、质量损失小。
- **输入上限 8192 token**（是 001 的 4 倍）→ chunker 的 `HARD_CAP_CHARS` 远没到上限，超长 T&C 条款/价格表整块也装得下，**不会被静默截断**。
- **⚠️ Vertex 致命坑（必须 `batch_size=1`）**：`GoogleGenerativeAIEmbeddings.embed_documents()` 把整批文本作为一个 `contents` list 发出去，而 `gemini-embedding-2` 端点对 list 输入**只回 1 个向量** → 整份合同静默塌成几条向量、`np.array` 还不报错。已用 `_PerItemGoogleEmbeddings` 子类强制每条单独请求修复。详见 [`embedding_pitfalls.md`](embedding_pitfalls.md)。
- **⚠️ `task_type` 在 embedding-2 上是 no-op**（与 001 不同！）：langchain wrapper 默认已把 `embed_documents`→`RETRIEVAL_DOCUMENT`、`embed_query`→`RETRIEVAL_QUERY`，但实测 toggle 与否**字节一致**（见 [`embedding_pitfalls.md`](embedding_pitfalls.md)）——embedding-2 不吃这个参数。官方建议要非对称检索就在文本里写 `task: ...` 指令前缀；当前没做也有 90%/100% recall，属可选优化。
- **Weaviate**：`vectorizer=none`（自带向量 BYO），距离 `cosine`；不用 text2vec 模块免双份配置。
- **入库前清洗**：丢裸标题块/空块；批量 embed 做指数退避重试（Vertex 每请求 instance 数有限制）。

**为什么选 2 不选 001**：决定性因素是输入上限（8192 vs 2048），防的是和上面同类的"无声截断"——长条款/表格 chunk 在 001 上会超 2048 token 被截掉尾部。多语种也略强（69.9 vs 68.32），还白送多模态后路（将来可直接嵌表格图/印章图）。价格 $0.20/M vs $0.15/M 的差在本项目语料规模下是分分钱级（全语料一次性嵌入不到 1 块钱），真正烧钱的是扫描页 Gemini Vision OCR，不在这里省。

### 决策 13：扫描页/数字页在 **element 层**合并，喂同一个 chunker（不重建回 PDF）

按页路由（架构 A）落地方式：**每页整页只由一个引擎处理，输出在 element 层交错合并，再喂给同一个 section-aware chunker**。

- 数字 / mixed / scan-with-text 页 → MinerU（整份 PDF 跑，扫描页的垃圾输出在合并时丢弃）
- 裸扫描页（`scan-bare`）→ Gemini OCR，**产出与 MinerU 同构的 element**（`text`+`text_level`、`table`+HTML `table_body`）
- 合并：按绝对页号迭代，每页挑引擎、按引擎自身顺序 append；OCR element 的 `page_idx` 由合并步骤统一打戳（provider 保持页内本地）

**为什么不"把扫描页用 Gemini 重建成数字页再塞回 MinerU 重解析"**：那是一次有损来回——会把 Gemini 已读对的表格/结构拍平，再交给 MinerU 较弱的扫描页 CV 重新推（正是 OCR 评估里 MinerU 输掉的部分）。**真正把整条流缝成一体的是 chunker，不是 MinerU**：让两个引擎在 element 层平等喂给唯一的 chunker 即可。

**页边界为什么不会截断**：chunker 的 flush 触发器只有「标题 / 表格 / 图片 / 超 size cap」，`page_idx` 从不触发 flush（只记进 `page_start/page_end` 当 provenance）。所以正文跨页（含数字/扫描接缝）会被 `_ClauseBuffer` 自动缝成一个 chunk——**"分页合并"对正文不是要解的问题，正确做法就是不在页边界做决策**。已在真实数据验证：2026004 出现 (3,4)、(5,6) 等跨页 chunk。

**V1 残留限制（已知）**：
- **跨页表格仍切两半**（chunker 对 table 永远独立成块，MinerU 自身也这样）→ V2 做表格续接检测
- **接缝处 section 归属依赖 Gemini 把扫描页标题标对 `text_level`**——这是对 OCR 结构化输出质量的依赖，靠 prompt + spot-check 保证
- OCR 逐页串行调用（V2 可上 5 路并发，见 ocr_evaluation.md 成本表）

### 决策 14：数字页内嵌图走 `enrich_images`（Gemini Vision 判别 + 描述 + 丢无效图）

MinerU 把 logo/印章/装饰图也抽成 `type=image`，留着会变成内容为 `[image]` 的垃圾 chunk 污染向量库（见 embedding_pitfalls.md）。在 **MinerU 与 chunker 之间**插一道 `enrich_images`：

- **先做廉价尺寸预筛**（不花 Gemini 调用）：bbox 长边 `max(w,h) < 64`（MinerU 单位 ≈ px@96dpi）→ 判定为图标/印章/装饰，直接丢。用 `max`（长边）而非 `min`，最保守——只丢"每个方向都小"的图，绝不误伤宽幅信头/竖条。**2026004 校准**：audit 图标 36×28 丢；真 logo/图 142×105、410×124 留给 Gemini。实测 3 张图 → 预筛掉 1、送 Gemini 2。
- 过筛的每张 `type=image` 才过 Gemini Vision → `{valid, type, content}`（一次调用同时判别+描述）
- valid（table/chart/diagram/scanned_text）→ 给 element 挂 `enriched_markdown`，chunker 用它当 chunk 内容（可检索）
- invalid（logo/signature/decorative）→ 直接丢，不出 chunk
- 解析失败 / 读图失败 → 安全丢弃（不让一张坏图拖垮整份入库）
- **`img_path` 必须先解析成绝对路径**（`load_content_list` 已做）：MinerU 给的是 `images/<hash>.jpg` 相对路径，不解析则入库时读不到图、把好图也静默丢了

> ⚠️ 检索侧待办：描述后的图是 `chunk_type="image"`，而 `retrieval/graph.py` 的 `DEFAULT_CHUNK_TYPES=("clause","table")` 暂不含 image——若要让内嵌图表被检索到，需把 `image` 加进可检索类型（独立改动，未做）。

### 决策 15：Excel 台账同步 = SQLite 真源 + 可拆适配器 + 三方基线合并（过渡期）

业务用一份**多人手工维护的 Excel 台账**。原想"直接双写 Excel + 定期等值比对"，否决——
活台账是多写者环境：① 双写非原子，文件被人开着第二写就失败（常态非边缘）；② 等值 diff 只能
告诉你"差了"、永远说不清"谁对"，会退化成每条差异人肉裁决 + 格式差异（`$39,041.60` vs
`39041.6`）狂误报。

**最终方案**：
- **SQLite 是系统真源，Excel 是可拆下游**。核心入库/检索绝不依赖 Excel；`config.yaml`
  的 `excel.enabled: false` 即彻底断开。架构上 Excel 是一条**独立适配器**（`contract_rag/sync/`），
  核心不 import 它。
- **列归属分工**：系统列（counterparty/amount/currency/project_name/department/
  petitioner/petition_date/brief_description）只系统写；人工列（effective_date/
  expiration_date）人维护、系统吸收。**owner 单边改不算冲突**——只有"人改了系统列"或
  "两边都改同一格"才是冲突，交用户确认（决策对齐前端"逐字段确认合并"）。
- **三方基线合并**：存一份"上次导出值"baseline，三方比 `baseline/system/excel` 才能判
  "谁动了哪格"（纯逻辑 `sync/merge.plan_merge`，已单测）。配 `sync/normalize` 把金额/
  日期/空值归一，杀掉格式误报。
- **写入解耦 + 锁降级**：入库只对 SQLite 提交；Excel 由 `sync_contract()` 推送，文件被锁
  → 记 `pending/retrying` 可重试，**不抛错、不覆盖人的编辑**。状态机 `synced/pending/
  retrying/conflict/disabled` 给前端"处理中"页轮询。
- **入库态 vs 同步态分离**：合同入库 `done` 即检索可用；Excel `pending` 不代表合同不可用，
  前端两条状态分开显示。

**列映射已对真实台账确认**（28 列，大部分用、sample 空的列不用）：
- 系统写：合同编号→`contract_id`、供应商→`counterparty`、合同金额→`amount`、币种→`currency`、
  合同内容→`project_name`、合同版本→`contract_type`、经办人→`petitioner`、
  登记日期→`petition_date`、存档编号(File No.)→`file_no`、File Name→`file_name`（派生）
- 人工源（系统写入台账）：Contract Start Date→`effective_date`、合同到期日→`expiration_date`
- **File Name 派生** = `存档编号-合同号-合同内容`（`file_no.compose_file_name`，顺序固定）
- **File No. 规则分配** = `{前缀}{年}{3位序号}`，**按(类别,年)递增、跨年重置**：`2026001`(普通)/
  `CN2026001`(chinabuy)/`PD2026001`(PD)。**类别由用户提供**；前缀**前端可设**
  （`set_file_no_rules` 持久化在 `sync_settings` 表）。序号 `next_seq` 扫现存 file_no 取该
  前缀+年的最大值+1（若要改成全年共用一个计数器，只动 `next_seq` 一个函数）。
- **丢弃**（留 SQLite 不同步）：`department`、`brief_description`。台账纯人工列
  （Agreement number / Yearly Contract Amount / 合同审批日期 / 所有未用列）系统不碰、留空、不删。
- **格式不可变硬约束**：追加=整行全宽、空列留空、绝不删列/重排（`excel_adapter` 已焊死 + 测试）。
- 表头容错匹配：双语多行表头按"去空白 + 子串"寻列；`存档编号` 在 File No./File Name 重名 → 用英文 token 区分。
- `合同版本`(Contract Type) 已加入审批抽取（`contract_type` ← 审批表 "Contract Version" 格）→ 同步进台账该列。

**现已落地（无前端依赖）**：审批抽取→SQLite（`ingest/approval_store.py`）、`excel` 配置
开关、`sync/` 包（state 表 + 幂等 `sync_contract` + `resolve_conflict` + 读接口 + `file_no`
规则/派生 + `sync_settings` 用户设置表）。**未做（等决策 7 前端/worker）**：驱动 pending→重试的
后台循环、处理中页 + 冲突合并页 UI（都是读接口的薄消费层）。

> 对外接口契约见 [`docs/INTERFACE.md`](../docs/INTERFACE.md)（审批抽取 + Excel 同步），改对外函数须同步更新。

### 实现落点（代码地图）

| 模块 | 职责 |
|---|---|
| `ingest/router.py` | 逐页判数字/扫描（`scan-bare` 为唯一 blocking 类） |
| `ingest/ocr.py` | 扫描页渲染 PNG + Gemini OCR → MinerU 同构 element；`parse_ocr_elements` 纯解析可测 |
| `ingest/merge.py` | `merge_page_elements`：按页挑引擎、丢扫描页 MinerU 垃圾、打 `page_idx` |
| `ingest/image_enrichment.py` | `enrich_images`（纯）+ `gemini_image_verdict`（I/O）+ `parse_verdict`（纯） |
| `ingest/vision.py` | 共享纯工具：`extract_text` / `loads_lenient` / `parse_json_block` / 图片转 data-url |
| `ingest/assembly.py` | `build_chunks`：merge → enrich → chunk 的纯组合（离线可测） |
| `ingest/pipeline.py` | 编排 + SQLite stage 落库（薄 I/O 层，含 `ocr_processing` stage） |

测试：`tests/` 下 38 个单测覆盖全部确定性逻辑；未覆盖的只有 Gemini/MinerU/fitz 等外部 I/O 边界。

## 三、数据存储分层

```
┌─────────────────────────────────────────────────────────────┐
│ Weaviate (向量库, JushiContract collection)                 │
│   - 合同正文 chunks (语义检索用)                              │
│   - metadata: contract_id, page_range, chunk_type            │
│                (clause / table / summary / unique_to_signed) │
│   - 不存审批页内容、不存签字页元数据                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ SQLite (结构化真源)                                          │
│   contracts 表:  完整字段见决策 10                          │
│     (审批抽取列 + effective/expiration 手填 + raw_extraction │
│      JSON + status/created_at/updated_at；真源在此)          │
│                                                              │
│   tasks 表:                                                  │
│     task_id (PK) | contract_id (FK, nullable) | stage       │
│     | status | error_message | created_at | updated_at      │
│                                                              │
│   pages 表:                                                  │
│     page_id (PK) | contract_id | page_no | page_type        │
│     (审批/合同/比价/补充) | route (mineru/vlm/rapidfuzz) |   │
│     | avg_confidence                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 文件系统 ./storage/{contract_id}/                            │
│   signed.pdf    用户上传的签字版 (永久存档, 法律凭据)         │
│   original.pdf  用户上传的数字原件 (可选, 前端可下载)         │
│   pages/        每页渲染的 PNG (供前端缩略图 / chunk 编辑展示)│
└─────────────────────────────────────────────────────────────┘
```

## 四、关键阈值与参数

| 参数 | 起点值 | 说明 |
|---|---|---|
| 图片覆盖率阈值（判扫描页） | ≥ 95% | fitz 取每页图片 bbox 的**并集**面积 ÷ 页面面积（不能直接 sum，会重复计算重叠区） |
| 文字层判别阈值 | = 0 严格判扫描 | 大于 0 即视为有数字内容 |
| OCR 置信度退回阈值 | avg < 0.80 | 整份退回 |
| RapidFuzz 替换阈值 | ≥ 90 | 用原件替换 |
| RapidFuzz 人工 flag 阈值 | 60-90 | 标人工审 |
| LLM 字段 confidence 阈值 | < 0.85 红色高亮 | 前端提示用户重点检查 |

所有阈值都是**起点值**，跑实际数据后调。

## 五、设计原则（违反就改）

1. **确定性优先，AI 兜底**——能用规则/元数据/用户标的，绝不让 AI 猜
2. **输入大方喂，输出严格收**——LLM 调用：上下文随便给，输出 schema 死死约束
3. **质量门在入库前**——脏数据不进库，前端拒收。检索阶段不做内容修复
4. **入库 ≠ 合规**——合规是独立 pipeline (V2)，不阻塞入库
5. **逐页路由，不按整份文档分类**——已发现混合页样本，不能赌"整份同质"
6. **签字版是法律凭据，原件是检索权威**——双存储分离，各司其职

## 六、V2 推迟项（V1 明确不做）

- 合规检查 pipeline（签字完整性、内部一致性、必备条款检查）
- 数据飞轮（用户修正回流当 eval 集）
- 比价/补充文件结构化抽取
- docx 原件支持
- 多文件上传（一份合同多份 PDF）
- 版本管理
- 失败自动重试
- 任务队列升级（Celery/Redis）
- 对象存储（MinIO/S3）
- 第二乱码信号（fastText LID 等）
- 跨合同合规、对方公司尽调
