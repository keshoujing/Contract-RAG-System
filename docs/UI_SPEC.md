# Contract-RAG 管理后台 · UI 交互规格（UI_SPEC）

> 本文件是**实现契约**：把每个可交互元素的「触发 → 反馈 → 结果」钉死，供实现方（人或模型）逐条照做。
> 设计稿在 `pencil-new.pen`；数据契约以 `docs/INTERFACE.md` 为准（本文件与之对齐，冲突时以 INTERFACE.md 为准）。
> 设计取舍背景见 `memory/ingestion_pipeline.md`。
>
> 阅读顺序：第 1 章 Token → 第 2 章 全局交互约定 → 第 3 章 组件库（先全部定义） → 第 4 章逐屏（引用前三章，**本次先交付 1–3 章**）。

---

## 0. 如何使用本规格 + 全局「不要做」清单

**怎么读每条规格**：组件按「全部视觉态」描述；屏幕按「交互地图表」描述，列固定为
`元素 | 触发 | 结果 | 精确文案 | 边界/禁用`。**所有中文文案均为最终文案，照抄，不要改写、不要自行翻译。**

**全局「不要做」（违反即视为实现错误）**：

1. **不要把「入库状态」和「Excel 同步状态」合并成一个总状态。** 二者独立，永远分两列展示。入库 `done` 即检索可用，与同步是否完成无关。
2. **不要让表格「操作列」常驻按钮。** 行操作走右键菜单；行 hover 时最右才显示一个淡 `⋯` 兜底入口。静止状态行尾为空。
3. **不要让 hover 浮出的内容遮挡单元格文本**（否则无法选中复制）。菜单一律在点击后于光标/按钮下方弹出。
4. **不要把 Excel 当数据库直接读写做"真源"逻辑。** SQLite 是真源；Excel 是单向同步下游。UI 所有读取走 `docs/INTERFACE.md` 的函数。
5. **不要新建后端没有的字段或状态枚举。** 状态值只能是 INTERFACE.md 定义的集合；字段名只能用 INTERFACE.md 的 field 名。
6. **不要省略四态。** 每个数据面必须实现 加载 / 空 / 错误 / 正常 四态；写操作必须实现 进行中 / 成功 / 失败 三态。
7. **不要自创颜色。** 只用第 1 章 Token；状态色按第 1.4 节映射表，不得换色。
8. **不要把合同编号（contract_id，主键）做成可随意改的普通输入。** 主键改动需二次确认（见组件库 Modal）。
9. **不要在 `department` / `brief_description` 上做同步/冲突相关 UI**——它们不同步（INTERFACE.md）。
10. **不要把审批页之外的页拿去做字段抽取**（纯录入模式只处理审批页）。

---

## 技术栈（实现锁定，不得替换）

> 后端假定为 **Python / FastAPI**（与 `docs/INTERFACE.md` 的函数一一对应，对外暴露 REST）。前端约定如下：

### 选型表

| 层 | 选型 | 约束要点 |
|---|---|---|
| 语言 | **TypeScript**（`strict: true`） | 类型即契约；禁止 `any` 兜底业务类型 |
| 框架/构建 | **Vite + React 18（SPA）** | 无 SSR；与 FastAPI 后端分离部署 |
| 路由 | **React Router v6**（data router） | 路由集中声明 |
| 表格 | **TanStack Table v8**（headless） | 列冻结/列显隐(列配置)/排序用原生 API；不引第二个表格库 |
| 大表性能 | **TanStack Virtual** | 行数 >200 必须行虚拟化 |
| 数据/缓存 | **TanStack Query v5** | 所有服务端读写经 Query；轮询、四态、乐观更新都由它承载 |
| 客户端态 | **Zustand**（最小化） | 仅 UI 态（列配置、多选、抽屉开合）；业务数据一律不放这里 |
| 样式 | **Tailwind CSS v4** | §1 Token 映射进 `@theme`；禁止行内硬编码色值 |
| 组件层 | **shadcn/ui（Radix + Tailwind）** | 组件复制进仓库 `src/components/ui/`，按 Token 改造；见下方映射 |
| 表单+校验 | **React Hook Form + Zod** | Zod schema 既校验表单又校验 API 边界 |
| 图标 | **lucide-react** | 图标名沿用 Pencil 稿，禁止换图标库 |
| Toast | **Sonner** | §3.11 |
| 日期 | **react-day-picker + date-fns** | 显示/解析统一 `YYYY-MM-DD` |
| API 类型 | **openapi-typescript**（从 FastAPI `/openapi.json` 生成） + 轻量 `openapi-fetch` | **前端业务类型一律来自生成产物**，不得手写后端 DTO |
| PDF | V1 原生 `<embed>` → 后期 **react-pdf**(pdf.js) | §3.13 |
| 测试 | **Vitest + React Testing Library + Playwright** | 单元/组件/E2E；关键用户流（上传登记、解决冲突）必有 E2E |
| 规范 | **ESLint + Prettier** | 提交前格式化 |

### shadcn/Radix 组件 → 本规格组件映射（§3）

| 规格组件 | 实现来源 | 备注 |
|---|---|---|
| Button(§3.1) | shadcn `Button` | 扩 `variant`: primary/secondary/danger/ghost/icon；`loading` 自定义 |
| Tag/Badge(§3.2) | shadcn `Badge` | 扩状态 variant，色按 §1.4 |
| Toggle(§3.3) | Radix `Switch` | |
| Radio(§3.4) | Radix `RadioGroup` | 「手动输入」选项联动展开 Input |
| Input/Select/Textarea(§3.5) | shadcn `Input`/`Select`/`Textarea` | Select 用 Radix Select |
| Date(§3.5) | `Popover` + react-day-picker `Calendar` | |
| Table(§3.6) | **TanStack Table** + shadcn `Table` 样式壳 | shadcn 只给样式，逻辑全在 TanStack |
| 下拉菜单(§3.7) | Radix `DropdownMenu` | 列配置/筛选 |
| 右键菜单(§3.8) | **Radix `ContextMenu`** | 原生支持右键 + `preventDefault`；hover ⋯ 复用同菜单内容 |
| 抽屉(§3.9) | shadcn `Sheet`(`side="right"`) | |
| Modal/确认(§3.10) | `Dialog`；危险确认用 `AlertDialog` | |
| Toast(§3.11) | **Sonner** | |
| 骨架/空/错误(§3.12) | shadcn `Skeleton` + 自定义 Empty/Error | 四态由 Query 的 `isLoading/isError/data` 驱动 |
| 错误悬浮(失败原因) | Radix `Tooltip` | 入库失败 hover 看 `last_error` |

### 项目约定

- **代码位置（已定）**：前端是**独立子项目**，置于仓库根的 **`frontend/`**，与 Python 后端 `contract_rag/` 并列；前端有自己的 `package.json` 与构建，**不与后端共用任何目录**。
  ```
  Contract-RAG/
    contract_rag/            # Python 后端（FastAPI，暴露 附录 A 端点）
    src/                     # 既有 Python 模块（与前端无关，勿混）
    frontend/                # ← 本前端（Vite + React + TypeScript）
      package.json  vite.config.ts  tailwind.config.ts  tsconfig.json  index.html
      src/
        api/                 # openapi 生成类型 + 各域 query/mutation hooks (useContracts, useSyncStatuses…)
        components/ui/       # shadcn 基础件（按 Token 改造）
        components/          # 业务组件（ContractTable, SyncStatusTag, ConflictRow…）
        features/<域>/       # 台账/上传/详情/设置/同步/冲突 各自的页面+局部组件
        routes/              # React Router 路由表
        lib/                 # 工具（格式化、日期、zod schema）
        stores/              # Zustand（仅 UI 态）
        main.tsx  App.tsx
  ```
  ⚠️ 前端代码一律在 `frontend/src/` 下；它与仓库根已有的 Python `src/` 是两回事，不要混放。
  开发期前端 `vite.config.ts` 把 `/api`、`/openapi.json` 代理到 FastAPI（默认 `http://localhost:8000`）。
- **状态边界**：服务端数据 = TanStack Query（含轮询/缓存/乐观更新）；UI 态 = Zustand/local；**两者不混**。
- **API 层**：每个 INTERFACE.md 函数对应一个 FastAPI REST 端点；前端只通过 `api/` 下的 typed hooks 调用，组件不直接 `fetch`。端点映射在 §4 各屏「数据契约」给出。
- **不可变 / 错误处理 / 输入校验** 遵循仓库全局规范（immutable 更新、Zod 边界校验、不吞错）。
- **可访问性**：Radix 原生保证 keyboard/focus/aria；自定义件需补齐 §2 的焦点与键盘约定。

---

## 1. 设计 Token

> 实现方必须把这些定义为变量/主题，不得散落硬编码。值取自 `pencil-new.pen`。

### 1.1 颜色

| Token | 值 | 用途 |
|---|---|---|
| `surface.primary` | `#FFFFFF` | 卡片/表格/顶栏底色 |
| `surface.page` | `#F4F5F7` | 页面背景 |
| `surface.sidebar` | `#0F1623` | 侧边栏 |
| `surface.muted` | `#F8F9FB` | 表头/分区底/次级填充 |
| `fg.primary` | `#1A1F29` | 主文本 |
| `fg.secondary` | `#6B7280` | 次文本/标签 |
| `fg.tertiary` | `#9CA3AF` | 占位符/弱化 |
| `fg.inverse` | `#FFFFFF` | 深底上的文本 |
| `border` | `#E5E7EB` | 常规分隔线/描边 |
| `border.strong` | `#D1D5DB` | 输入框/次按钮描边 |
| `accent` | `#2563EB` | 主操作/链接/进行中（蓝） |
| `accent.soft` | `#EAF1FE` | 主色浅底/选中行 |
| `success` | `#16A34A` | 完成/已同步（绿） |
| `success.soft` | `#E7F6EC` | 绿浅底 |
| `amber` | `#D97706` | 重试中（琥珀） |
| `amber.soft` | `#FEF3E2` | 琥珀浅底/重试行高亮 |
| `orange` | `#EA580C` | 冲突/警告（橙） |
| `orange.soft` | `#FDECE0` | 橙浅底/冲突行高亮 |
| `danger` | `#DC2626` | 失败/删除/低置信（红） |
| `danger.soft` | `#FDECEC` | 红浅底/低置信字段底 |
| `highlight.diff` | `#FCEFC7` | 三方对照「与基线不同」单元格底（浅黄） |

### 1.2 字体

| Token | 值 | 用途 |
|---|---|---|
| `font.sans` | `Inter` | 全局正文/标题/标签 |
| `font.mono` | `Geist Mono` | 合同编号、金额、日期、文件路径、存档编号 |

字号：H1 20 / H2 16 / H3 15 / body 13–14 / caption 11–12 / 统计大数 26。字重：常规 400 / 中 500 / 半粗 600 / 粗 700。

### 1.3 间距 / 圆角 / 阴影 / 层级

- 间距步进：4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24 / 32。
- 圆角：`radius` 8（卡片/输入/按钮）、`radius.sm` 6（小按钮/图标钮/Tag 容器）、20（药丸 Badge/Tag）、全圆（头像/单选圈）。
- 阴影：`shadow.menu`（下拉/右键菜单）`0 6 20 / #0F162329`；`shadow.drawer`（抽屉）`-8 0 32 / #0F162333`；`shadow.card-float`（PDF 页/浮卡）`0 4 16 / #00000040`。
- z-index 层级（从低到高）：内容 0 → 冻结列阴影 10 → sticky 顶栏 20 → 下拉/右键菜单 1000 → 抽屉+遮罩 1100 → Modal+遮罩 1200 → Toast 1300。

### 1.4 状态色映射（**唯一权威，不得改色**）

**入库状态**（来源：`tasks` 表 / `storage/db.py`，与同步无关）

| 语义 | 文案 | 色 | 图标(lucide) |
|---|---|---|---|
| 进行中 | `进行中 · {阶段}` | accent | `loader` |
| 完成 | `完成` | success | `circle-check` |
| 失败 | `失败` | danger | `circle-x` |

`{阶段}` 取值：`标注中 / 解析中 / OCR中 / 分块中 / 嵌入中`（对应 INTERFACE 之外的 ingest stage 枚举，见 `memory/ingestion_pipeline.md` 决策 7）。

**Excel 同步状态**（来源：`get_status().state` / `list_statuses()`，枚举固定）

| `state` | 文案 | 色 | 图标 | 备注 |
|---|---|---|---|---|
| `synced` | `已同步` | success | `circle-check` | |
| `pending` | `待同步` | fg.secondary（中性灰，底 surface.muted） | `hourglass` | 可「立即重试」 |
| `retrying` | `重试中` | amber | `refresh-cw` | 副行持续显示 `第 {attempts} 次 · 下次 {mm:ss} 后` |
| `conflict` | `待确认冲突` | orange | `triangle-alert` | 整行高亮；出现「解决冲突」按钮 |
| `disabled` | `已禁用 ⊘` | fg.tertiary（灰） | `ban` | 仅当设置里 Excel 同步关闭；整列灰禁用 |

---

## 2. 全局交互约定

- **导航**：左侧固定侧边栏，三项 `台账 / 入库与同步 / 设置`。当前页高亮（深底 `#1E2A3D` + 反白文字 600）。「上传合同」是**动作不是导航**，从台账页按钮进入。
- **转场时长**：抽屉/菜单/弹窗 进出 150–200ms ease-out；hover 反馈 ≤100ms；Toast 自动消失 4s。
- **焦点与键盘**：所有可点元素可 Tab 聚焦，聚焦态 = `accent` 2px 外环。`Enter/Space` 触发；`Esc` 关闭最上层浮层（菜单→抽屉→弹窗顺序）。表格行支持 `↑/↓` 移动选中、`Enter` 打开详情。
- **轮询/实时**：入库进行中、同步 `pending/retrying` 的行需轮询刷新（建议 5s）；`retrying` 的倒计时 `下次 mm:ss 后` 每秒本地递减。无 WebSocket 时用轮询，不要假设推送。
- **滚动**：页面级单一纵向滚动；宽表内部横向滚动（冻结列不参与）；抽屉/弹窗内部各自滚动，不嵌套页面滚动。
- **数字/日期**：金额右对齐、`font.mono`、千分位；日期 `YYYY-MM-DD`、`font.mono`；空值显示 `—`（fg.tertiary）。
- **乐观更新**：写操作（保存/重试/合并）先置「进行中」禁用按钮，成功后 Toast + 刷新该行，失败回滚并报错（见组件 Toast/Modal）。

---

## 3. 组件库（全状态）

> 每个组件给出**全部视觉态**与行为。屏幕章节只引用这些组件，不重复定义。

### 3.1 按钮 Button

变体：`primary` / `secondary` / `danger` / `ghost` / `icon-only`。统一高度 36（小号 30）、圆角 `radius.sm`、半粗文字、图标 15–16。

| 变体 | 默认 | hover | active(按下) | focus | disabled | loading |
|---|---|---|---|---|---|---|
| primary | 底 `accent`/反白字 | 底加深 8% | 底加深 14% | + accent 2px 外环 | 底 50% 透明/不可点 | 左侧 `loader` 旋转，文字保留，禁点 |
| secondary | 白底/`border.strong` 描边/主文字 | 底 `surface.muted` | 底再深 | + 外环 | 文字+描边 40% | 同上 |
| danger | 白底/`danger` 描边+字（或实心红，见用途） | 底 `danger.soft` | 再深 | 红 2px 外环 | 40% | 同上 |
| ghost | 透明/主文字，无描边 | 底 `surface.muted` | 再深 | 外环 | 40% | 同上 |
| icon-only | 透明/`border` 可选 | 底 `surface.muted` | 再深 | 外环 | 40% | 图标替换为 `loader` |

- **危险动作**（删除）用 danger，且**必经确认 Modal**。
- loading 期间按钮**宽度不跳动**（预留图标位）。

### 3.2 状态标签 Tag / 徽章 Badge

- **Tag**（状态用）：药丸，`图标 + 文字`，底=对应 `*.soft`，字/图标=对应主色。色严格按 §1.4。尺寸：高 24，内距 [4,10]，字 12/600。
- **Badge**（计数/属性）：纯文字药丸。如「系统列」(accent.soft/accent)、「人工列」(surface.muted/fg.secondary)、「开启中」(success.soft/success)、「已禁用」(danger.soft/danger)。
- Tag/Badge **不可点**（除非明确说明）；可点的是其旁边的按钮。

### 3.3 开关 Toggle

- 两态：开（底 `accent`，滑块右）/ 关（底 `border.strong`，滑块左）。尺寸 44×24，滑块 18。
- 切换为**即时生效**写操作：点击→乐观切换→调接口；失败回滚 + Toast 错误。
- 带说明的 Toggle（如设置页 RAG / Excel 同步）：标题 + 状态徽章（开启中/已关闭）+ 一行说明 + 右侧开关。关闭高风险开关（RAG/Excel 同步）→ 先弹确认 Modal 说明影响，确认后才切。

### 3.4 单选 Radio / 单选组

- 单选圈 16：未选=`border.strong` 1.5px 空心；选中=`accent` 实心环 + 文字转 600/`fg.primary`。
- 单选组用于三方合并「选择」列：选项 `用系统值 / 用台账值 / 手动输入`，**纵向排列**，互斥。
- 选「手动输入」→ 该选项下方**就地展开**一个文本输入框（聚焦），值即为最终值；切走则收起并丢弃输入。

### 3.5 输入框 Input

类型：`text / number / date / select / textarea`。高 36（textarea 自适应，最小 72）、`radius.sm`、`border.strong` 描边、内距 [11,12]。

| 态 | 表现 |
|---|---|
| 默认 | 描边 `border.strong`，占位符 `fg.tertiary` |
| focus | 描边 `accent` + 2px 外环 |
| 填写 | 文字 `fg.primary`（编号/金额/日期用 mono） |
| 校验错误 | 描边 `danger` + 下方一行 `danger` 错误文案 + `circle-alert` 图标 |
| 低置信（抽取场景） | 描边 `danger`/底 `danger.soft` + 标签右侧「置信度 {n}%」+ 下方提示原文 |
| 需手填（审批页无该值） | 描边 `amber`/底 `amber.soft` + 标签右「需手填」徽章 |
| disabled/只读 | 底 `surface.muted`，文字 `fg.secondary`，不可聚焦 |

- `select` 右侧 `chevron-down`；点击→下拉菜单（§3.7）。
- `date` 右侧 `calendar`；点击→日期选择器面板。
- 必填字段标题后加红 `*`。

### 3.6 表格 Table

层级：`表格(frame) → 行(frame) → 单元格(frame) → 内容`。

- **表头**：底 `surface.muted`，文字 12/600/`fg.secondary`，下边框 `border`。可排序列：表头可点，右侧出现 `↕/↑/↓`。
- **数据行**：高 48（宽表 48 / 列表 52 / 含副行 64–66）。
  - 默认：白底，下边框 `border`。
  - **hover**：底 `accent.soft` + 光标 pointer；行最右显示淡 `⋯`（§3.8 入口）。
  - **选中**（勾选框）：底 `accent.soft` + 左缘 3px `accent` 条。
  - **高亮行**（仅同步页）：`retrying`→`amber.soft` 底 + 左 amber 条；`conflict`→`orange.soft` 底 + 左 orange 条。
- **勾选框列**：表头勾选=全选当页；行勾选进入多选模式，顶部浮出批量操作条（导出/归档）。
- **冻结首列**（宽表）：合同编号+勾选列随横滚固定，右缘 `border.strong` + `shadow`(offset x 4)。
- **冻结尾列**（宽表，可选）：若放尾列操作入口则冻结贴右；本设计采用「右键 + hover ⋯」，故**不放常驻尾列**。
- **列分组表头**（宽表）：二级表头按组（基本信息/金额/归口/日期/状态），组间竖向细线。
- **横向滚动条**：宽表底部；冻结列对应区不滚动（留白对齐）。
- **列配置**：顶栏「列配置」按钮→弹出勾选面板，选显示列/拖动列序，偏好存 `localStorage`，每用户独立。

### 3.7 下拉菜单 Dropdown（select / 列配置 / 筛选）

- 触发：点击 `select`/筛选按钮/列配置。
- 弹出：锚点正下方，`shadow.menu`，`radius`，内距 6，项高 ~36，hover 项底 `surface.muted`。
- 关闭：选中后即关 / 点外部 / `Esc`。单选项选中显示 `check`。

### 3.8 行操作：右键菜单 + ⋯ 兜底（**统一规则**）

- **主入口 = 右键**：在任意数据行上右键 → 在光标处弹出上下文菜单（贴合 Excel 习惯）。**必须 `preventDefault` 屏蔽浏览器默认右键菜单。**
- **兜底入口 = hover ⋯**：行 hover 时最右显示一个淡 `⋯`，点击弹出**同一个**菜单（解决右键不可发现 + 触屏可用）。静止不显示。
- 菜单顶部灰显该行 `contract_id`；菜单项见各屏（典型：`查看详情 / 编辑 / 下载 PDF / 复制编号 / 删除`，删除红色置底，前有分隔线）。
- 菜单**只在点击后出现**，绝不 hover 自动浮出覆盖内容。

### 3.9 抽屉 Drawer（右滑编辑）

- 触发：左键点行（操作区/⋯除外）或菜单「编辑」。
- 结构：右侧定宽（合同编辑 564）从右滑入 150–200ms；左侧页面盖半透明遮罩 `#0F16238C`。
- 头部：`contract_id`(mono/700) + 状态 Tag + `✕`；副行对方·项目名。
- 体：分区表单（基本信息/金额/日期/状态与备注），字段用 §3.5 输入。
- 底：左 `删除`(danger ghost) | 右 `取消`(secondary) + `保存修改`(primary)。
- 关闭：`✕` / 点遮罩 / `Esc`。**有未保存改动时弹「放弃修改？」二次确认**。
- 保存：见各屏写回逻辑 + Toast。

### 3.10 弹窗 Modal / 确认对话框

- 居中卡片 + 全屏遮罩（z 1200）。用于：删除确认、覆盖重传确认、主键改动确认、关闭 RAG/Excel 同步确认、放弃未保存改动。
- 结构：标题 + 说明（讲清后果）+ `取消`(secondary) + 主操作（危险动作用 danger）。
- 危险确认文案必须**点名后果**（例：「将删除合同 {id} 及其存档 PDF，不可恢复」）。
- 关闭：`取消` / 点遮罩 / `Esc` = 取消（等同放弃，不执行）。

### 3.11 Toast 通知

- 右上角堆叠，4s 自动消失，可手动关。三型：成功(success+`circle-check`) / 错误(danger+`circle-x`) / 信息(accent+`info`)。
- 错误 Toast 提供「重试」或「查看详情」动作时，常驻不自动消失。
- 文案精确，含对象：`已保存 {id}` / `同步失败：Excel 文件被占用，请关闭后重试` / `已合并 {id}，生成新基线`。

### 3.12 系统态：骨架屏 / 空 / 错误

每个数据面（表格、详情、抽屉）必须实现：

| 态 | 表现 | 文案 |
|---|---|---|
| **加载** | 骨架屏（灰条占位行，禁止空白闪烁）；统计卡显占位 | — |
| **空** | 居中插画/图标 + 一行说明 + 主操作 | 台账空：`还没有合同，点「上传合同」开始登记`；筛选无结果：`没有匹配的合同，试试调整筛选` |
| **错误** | 居中 `circle-x` + 原因 + `重试` 按钮 | `加载失败：{原因}` |
| **正常** | 实际内容 | — |

### 3.13 PDF 查看器（详情页）

- V1：原生 `<embed>`/`<iframe>` 加载 `signed.pdf`（翻页/缩放/下载/打印用浏览器自带控件）。容器为深色（`#525659`），文档白页居中带 `shadow.card-float`。
- 文件经后端 `GET /contracts/{id}/file` 流式返回（带鉴权，不暴露真实路径）。
- RAG 阶段升级 PDF.js：点右侧字段 → 左侧跳转并高亮来源原文（用 `_per_field_source_span`）。本期只需占位说明，不实现高亮。

### 3.14 三步向导（上传流程）顶部步骤条

- 三步：`1 上传 / 2 指认审批页 / 3 确认字段`。当前步=`accent` 实心；已完成=`accent.soft` + `check`；未到=灰描边。步间连接线 `border.strong`。
- 仅展示进度，不可跳点未解锁步骤；上一步可返回。

---

## 4. 逐屏规格

> 每屏含：目的 / 区域 / 交互地图表 / 四态 / 边界用例 / 数据契约 / 不要做。
> 交互地图列固定：`元素 | 触发 | 结果 | 精确文案 | 边界/禁用`。
> REST 端点为前端期望，后端按 `docs/INTERFACE.md` 的函数实现；端点未在 INTERFACE 列出的标 `【需后端补】`。

---

### 4.1 台账列表 / 宽表

**目的**：替代 Excel 台账——浏览 / 搜索 / 筛选 / 排序 / 进入每份合同。同一表格支持「常规列表」与「宽表（15 列）」两种密度。

**区域**：侧栏 ｜ 顶栏（标题 + 计数 + `列配置` + `导出 Excel` + `上传合同`）｜ 工具栏（搜索框 + 筛选 chips + 右侧结果计数）｜ 表格（冻结首列 + 可选列分组 + 横向滚动 + 冻结尾列不放，见 §3.8）｜ 状态层（加载/空/错误）。

**交互地图**：

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| `上传合同`(primary) | click | 进入上传三步向导(§4.5) | `上传合同` | — |
| `导出 Excel`(secondary) | click | 导出**当前筛选结果**为 .xlsx 下载；导出中按钮 loading | `导出 Excel` | 结果为 0 时禁用 |
| `列配置`(secondary) | click | 下拉(§3.7)：勾选显示列 + 拖动列序，存 `localStorage`（每用户） | `列配置` | — |
| 搜索框 | 输入（debounce 300ms） | 服务端按 编号/对方/项目 过滤 | 占位 `搜索合同编号 / 对方公司 / 项目名` | 空结果→筛选空态 |
| 筛选 chip（部门/状态/年份） | click | 打开多选下拉，选完即筛 | `部门：全部` / `状态：生效中` / `年份：2026` | — |
| 表头（可排序列） | click | 排序循环 升→降→无；显示 `↑/↓` | — | 仅 编号/金额/日期/对方 可排序 |
| 表头勾选框 | click | 全选/取消当页 | — | — |
| 行勾选框 | click | 选中该行 + 进入多选模式（顶部浮出批量条，§4.2） | — | — |
| 数据行（点击非勾选区/非 ⋯） | 左键 click | 打开编辑抽屉(§4.3) | — | — |
| 数据行 | **右键** | 上下文菜单(§4.2)，光标处 | — | 必 `preventDefault` |
| 行 | hover | 行底 `accent.soft` + 最右淡 `⋯`（点击=同菜单） | — | — |
| 横向滚动条 | 拖动/滚轮 | 中间列横滚；冻结首列不动 | — | 仅宽表 |
| 行内长文本 | hover | 原生 `title` 显示全文 | — | — |

**四态**：

- **加载**：骨架 8 行 + 统计/工具栏占位，禁止白屏闪。
- **空（无任何合同）**：居中 + `还没有合同，点「上传合同」开始登记` + `上传合同` 按钮。
- **空（筛选无结果）**：`没有匹配的合同，试试调整筛选` + `清除筛选` 按钮。
- **错误**：`加载失败：{原因}` + `重试`。

**边界用例**：行数 >200 必虚拟滚动；金额右对齐 `mono` 千分位、空值 `—`；`状态` 列是**合同业务状态**（`生效中/已到期`），与入库/同步状态**无关**，不得混用其色与语义。

**数据契约**：
- `GET /contracts` 【需后端补】query: `q, department, status, year, sort, page, pageSize` → `{ data: ContractRow[], total }`。
- `ContractRow` 字段 = INTERFACE「field → ledger column」映射全集：`contract_id, counterparty, amount, currency, project_name, contract_type, petitioner, petition_date, file_no, file_name, effective_date, expiration_date` + 业务 `status`。`department/brief_description` 仅详情/编辑可见，不参与同步。
- `GET /contracts/export` 【需后端补】?(同上 filters) → `xlsx` 流。
- `status` 枚举：`active`(生效中) / `expired`(已到期)；由 `effective_date/expiration_date` 与当前日期推导，前端只读展示。

**不要做**：① 不放常驻操作列；② 不把入库/同步状态塞进 `status` 列；③ 不在前端做全表扫描排序/筛选（交服务端，前端只渲染当前页）。

---

### 4.2 行右键菜单 + 批量操作条

**目的**：行级操作的统一入口（右键为主，hover `⋯` 兜底）；多选时提供批量操作。

**右键/⋯ 菜单**（§3.8，二者弹出**同一菜单**；顶部灰显该行 `contract_id`）：

| 菜单项 | 图标 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 查看详情 | `eye` | 打开合同详情页(§4.4) | `查看详情` | — |
| 编辑 | `pencil` | 打开编辑抽屉(§4.3) | `编辑` | — |
| 下载 PDF | `download` | 下载 `signed.pdf` | `下载 PDF` | 无存档文件时禁用并提示 |
| 复制编号 | `copy` | 复制 `contract_id` 到剪贴板 + Toast | `复制编号` / Toast `已复制 {id}` | — |
| ——（分隔线） | | | | |
| 删除 | `trash-2`(danger) | 弹删除确认 Modal(§3.10) | `删除` | — |

删除确认 Modal：标题 `删除合同？`；正文 `将删除合同 {id} 及其存档 PDF，不可恢复。`；按钮 `取消` / `删除`(danger)。确认→`DELETE /contracts/{id}`→成功 Toast `已删除 {id}` + 行移除；失败回滚 + 错误 Toast。

**批量操作条**（任一行勾选后从顶部滑入，覆盖工具栏）：

| 元素 | 触发 | 结果 | 精确文案 | 边界 |
|---|---|---|---|---|
| 计数 | — | 显示已选数 | `已选 {n} 项` | — |
| 批量导出 | click | 导出选中为 .xlsx | `导出所选` | — |
| 批量删除 | click | 确认 Modal（列出数量）→ 批量删除 | `删除所选`(danger) | 破坏性，必确认 |
| 取消 | click / `Esc` | 清空选择，退出多选 | `取消选择` | — |

**四态**：菜单本身无加载态；批量动作进行中→按钮 loading；失败→错误 Toast 且不改本地状态。

**边界用例**：右键必须屏蔽浏览器默认菜单；菜单超出视口下边→向上翻转；多选跨分页时明确「仅当前页」或提供「选择全部 {total} 项」（建议仅当前页，避免误操作）。

**数据契约**：`DELETE /contracts/{id}`【需后端补】（含 `./storage/{id}/` 清理）；`POST /contracts/batch`【需后端补】 `{ ids, action: "delete"|"export" }`。批量删除确认文案：`将删除选中的 {n} 份合同及其存档 PDF，不可恢复。`

**不要做**：菜单 hover 自动弹出；菜单覆盖行文本导致无法复制；批量操作不给确认就执行破坏性动作。

---

### 4.3 编辑抽屉（Drawer）

**目的**：点行就地编辑该合同全部字段，写回 SQLite（系统字段改动会被 Excel 同步感知）。

**区域**（§3.9）：右侧 564 抽屉 + 遮罩。头部（`contract_id` + 状态 Tag + `✕`，副行 对方·项目）｜ 体（分区表单：基本信息 / 金额 / 日期 / 状态与备注）｜ 底（`删除` ｜ `取消` + `保存修改`）。

**字段与可编辑性**：

| 区 | 字段 | 控件 | 约束 |
|---|---|---|---|
| 基本信息 | `contract_id` | 只读文本（mono） | **主键不可直接改**；如需改走「更改编号」二次确认 Modal |
| | `counterparty` | text | 必填 |
| | `project_name` | text | — |
| | `department` | select | 仅本地，不同步 |
| | `petitioner` | text | — |
| | `petition_date` | date | `YYYY-MM-DD` |
| | `contract_type` | select | 同步字段（合同版本） |
| 金额 | `amount` | number | 必填；千分位显示，存裸数值；≥0 |
| | `currency` | select | 默认 USD |
| 日期 | `effective_date` | date | 人工字段 |
| | `expiration_date` | date | 人工字段；须 ≥ `effective_date` |
| 状态与备注 | `status` | select | 业务状态 |
| | `brief_description` | textarea | 仅本地，不同步 |

**交互地图**：

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 任一字段 | 修改 | 标记 dirty；底部 `保存修改` 由禁用转可点 | — | 无改动时 `保存修改` 禁用 |
| `保存修改`(primary) | click | 校验→`PATCH`→成功 Toast + 关抽屉 + 刷新行 | `保存修改` / Toast `已保存 {id}` | 校验不过→聚焦首个错误字段，不提交 |
| `取消`(secondary) | click | 有 dirty→「放弃修改？」确认；无→直接关 | `取消` | — |
| `✕` / 遮罩 / `Esc` | — | 同「取消」 | — | — |
| `删除`(danger ghost) | click | 删除确认 Modal（同 §4.2） | `删除` | — |
| `contract_id` 改键 | click「更改编号」 | 二次确认 Modal 说明影响（向量库/存档目录随迁） | — | 默认折叠，高级操作 |

**校验文案**（§3.5 错误态）：必填空 `此项必填`；金额非数 `请输入有效金额`；到期早于生效 `到期日不能早于生效日`；编号重复（改键时）`编号 {id} 已存在`。

**四态**：抽屉打开先 `GET /contracts/{id}` → 加载时体区骨架；保存中按钮 loading + 表单只读；保存失败→错误 Toast，抽屉保持打开、保留输入。

**边界用例**：保存为乐观更新（先更新列表行，失败回滚）；并发——保存时若服务端版本已变（`updated_at` 不一致）→提示 `该合同已被他处修改，请刷新后重试`，不静默覆盖。

**数据契约**：`GET /contracts/{id}`【需后端补】；`PATCH /contracts/{id}`【需后端补】 body=变更字段子集 → 更新 `contracts` 行；系统字段变更使该合同 Excel 同步产生新 delta（由 `sync_contract` 处理，见 §4.8）。改键 `POST /contracts/{id}/rename`【需后端补】。

**不要做**：① 主键当普通输入随意改；② 保存后不刷新行/不给 Toast；③ 静默覆盖他人改动；④ 对 `department/brief_description` 显示「同步/冲突」相关字样。

---

### 4.4 合同详情（在线查看）

**目的**：在线查看 `signed.pdf` + 只读字段；不在本页改字段，编辑入口转抽屉。

**区域**：顶栏（`返回` + `contract_id`+状态 Tag + `下载 PDF`/`编辑`/`⋯`）｜ 左 PDF 查看器(§3.13) ｜ 右 字段信息（只读分区）+ 底部「存档信息」。

**交互地图**：

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| `返回` | click / `Esc` | 回台账，**保留筛选与滚动位** | — | — |
| `下载 PDF`(secondary) | click | 下载 `signed.pdf` | `下载 PDF` | 无存档文件禁用 |
| `编辑`(primary) | click | 打开编辑抽屉(§4.3) | `编辑` | — |
| `⋯` | click | 菜单（同 §4.2，去掉「查看详情」） | — | — |
| PDF 查看器 | — | 原生翻页/缩放/打印/下载 | — | 加载失败→错误占位 |
| 右侧字段 | — | 只读展示，不可编辑 | — | — |

**四态**：加载=左右各骨架；PDF 失败=`无法加载 PDF：{原因}` + 「下载文件」兜底链接；字段失败=`重试`。

**存档信息**（默认决策 2：**不显示物理路径**）：`文件名`(file_name) · `存档编号`(file_no, mono) · `页数 / 大小` · `存档时间`。

**数据契约**：`GET /contracts/{id}`【需后端补】；`GET /contracts/{id}/file`（流式 + 鉴权，不暴露真实路径）。

**不要做**：① 显示 `./storage` 物理路径；② 在只读页直接改字段（必经编辑抽屉）；③ 把「下载」做成新标签打开真实文件 URL。

---

### 4.5 上传三步向导（纯录入模式登记）

**目的**：登记一份合同——`上传 PDF → 指认审批页 → 确认字段 → 入账`。入账 = 写 `contracts` + 整份存档 `signed.pdf` + 触发 Excel 同步。**纯录入模式只处理审批页，不解析正文。**

**步骤条**：§3.14，三步 `1 上传 / 2 指认审批页 / 3 确认字段`。

**Step 1 · 上传**

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 拖放区 | 拖入/点击选择 | 上传 `signed.pdf`，显示进度条 | `拖拽 PDF 到此处，或点击选择` | 仅 `application/pdf`；超限提示 `仅支持 PDF`/`文件过大（上限 {n}MB）` |
| 上传完成 | — | 显示 文件名·页数·大小；`下一步` 可点 | — | 上传失败→`重新上传` |

**Step 2 · 指认审批页**

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 缩略图网格 | — | 渲染各页缩略图 | 顶部提示 `点击标出审批页：系统只从审批页抽取字段，其余页整份存档不解析` | 渲染中=骨架 |
| 某页缩略图 | click | 标为审批页（accent 边 + 「审批页」角标），单选 | — | — |
| `下一步：抽取字段`(primary) | click | 触发审批页 OCR+小 LLM 抽取（异步任务），进 Step 3 | `下一步：抽取字段` | **未选页禁用** |
| `取消` | click | 弃用本次上传，回台账 | `取消` | — |

**Step 3 · 确认字段**

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 左：审批页预览 | — | 渲染审批页图，供核对 | — | — |
| 右：字段表单 | — | 抽取结果填入（§3.5 各态） | — | 抽取中=右侧骨架 + stage 文案 |
| 低置信字段 | — | 红边 + 置信度 + 原文提示 | `置信度 {n}%`；提示 `原文识别为「{span}」，请核对` | — |
| `contract_id` 抽不到 | — | 红字提示手填，入账前必填 | `未识别到合同编号，请手填` | 空则 `确认入账` 禁用 |
| 生效日 / 到期日 | 手填 | amber「需手填」 | `需手填` | 到期 ≥ 生效，否则 `到期日不能早于生效日` |
| `存档分类`(category) | select | 决定 `file_no` 前缀（见 INTERFACE file_no 规则） | `存档分类` | 必选；影响自动编号 |
| `上一步` | click | 回 Step 2（保留已选审批页） | `上一步` | — |
| `确认入账`(primary) | click | 校验→`confirm`→写库+存档+触发同步→Toast→跳详情页 | `确认入账` / Toast `已入账 {id}` | 校验不过→聚焦错误项 |
| 编号已存在 | 入账时检测 | 覆盖确认 Modal（决策 8 覆盖式） | `合同 {id} 已存在，入账将覆盖原数据（含向量库与存档），是否继续？` | 确认后删旧再写 |

**四态**：上传中/抽取中显进度（stage 文案见 §4.7 阶段映射）；**OCR 整份退回**=`识别质量过低，请重传更清晰的扫描件`（整份拒收，回 Step 1）；抽取服务失败=`抽取失败，请重试`。

**数据契约**：
- `POST /ingest/upload`（multipart）→ `{ task_id }`
- `POST /ingest/{task_id}/approval-page` `{ page_no }` → 触发 `extract_approval`
- `GET /ingest/{task_id}` → `{ stage, status, fields, _per_field_confidence, _per_field_source_span }`（前端轮询）
- `POST /ingest/{task_id}/confirm` `{ fields, effective_date, expiration_date, category }` → `persist_approval` + 存档 + `sync_contract` → `{ contract_id }`

**不要做**：① 让 AI 猜哪页是审批页（必须用户指认）；② 解析审批页以外的正文；③ 抽不到编号就静默用文件名当 `contract_id`（INTERFACE 明确禁止）；④ 低置信字段不提示直接入库；⑤ 跳过覆盖确认直接改写已存在合同。

---

### 4.6 设置

**目的**：运行模式开关（RAG / Excel 同步）+ 台账存储 + 文件存储 + AI 模型 + 存档编号规则。

**区域**：顶栏标题 ｜ 运行模式（RAG 卡 + Excel 同步卡，并列）｜ 台账存储 ｜ 文件存储 ｜ AI 模型 ｜ 存档编号规则。

**交互地图**：

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| RAG 检索模块 Toggle | 点击关闭 | **高风险**→确认 Modal | Modal：`关闭后为纯录入模式，仅抽取审批页字段并存档，不解析正文、不向量化。已入库数据不受影响。是否关闭？` | 即时生效；失败回滚 |
| Excel 同步 Toggle | 点击关闭 | 确认 Modal | Modal：`关闭后系统仅写入数据库，不再同步到 Excel；「入库与同步」页该列将整列变灰「已禁用 ⊘」。是否关闭？` | 即时生效；失败回滚 |
| 台账文件 `更改` | click | 文件路径选择 | `更改` | — |
| 写前自动备份 Toggle | click | 即时切换 | — | 默认开 |
| 打开占用检测 Toggle | click | 即时切换 | — | 默认开 |
| AI 模型 | — | 只读展示当前模型 | — | V1 只读 |
| 存档编号规则 | 编辑 category→prefix | `set_file_no_rules` | — | 校验 prefix 唯一 |

**四态**：配置加载=骨架；任一开关/字段保存失败→错误 Toast + 回滚到原值（不留中间态）。

**数据契约**：`GET /config` / `PATCH /config`【需后端补】（`rag.enabled` `excel.enabled` `backup` `lockCheck` `paths` `models`，对应 `config.yaml`）；`get_file_no_rules` / `set_file_no_rules`（INTERFACE）。

**不要做**：① 关闭 RAG/Excel 同步不弹影响说明直接切；② 把 AI 模型做成随意可改（V1 只读展示）；③ 开关用非即时（必须乐观即时 + 失败回滚）。

---

### 4.7 入库与同步状态

**目的**：让用户随时看到每份合同的「入库」与「Excel 同步」两个**独立**状态，并让「未收尾」（重试/冲突）最显眼。**核心：入库 `done` 即检索可用，与同步是否完成无关。**

**区域**：侧栏（`入库与同步` active）｜ 顶栏（标题 + 副标题，**不含同步开关**——已移至设置）｜ 概览卡 ×4 ｜ 表格（入库列 / Excel 同步列分开）｜ 四态。

**入库阶段映射表**（决策 2 的承诺：内部 stage → 用户可见文案，**实现方照此翻译，不得自创**）：

| 内部 stage | 用户文案 | 入库 Tag 色 |
|---|---|---|
| `uploaded` | 已上传 | accent |
| `tagging` | 标注中 | accent |
| `ocr_processing` | OCR 中 | accent |
| `alignment` | 对齐中 | accent |
| `llm_extraction` | 抽取中 | accent |
| `awaiting_user_confirmation` | 待确认 | accent |
| `chunking` | 分块中 | accent |
| `embedding` | 嵌入中 | accent |
| `done` | 完成 | success |
| `failed` | 失败 | danger |

进行中 Tag 文案 = `进行中 · {用户文案}`。

**交互地图**：

| 元素 | 触发 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 概览卡（处理中/待确认冲突/已完成/重试中） | click | 按该状态筛选下方表格 | `处理中` `待确认冲突` `已完成` `重试中` | 计数为 0 的卡不可点 |
| 入库 Tag（失败时） | hover | Tooltip 显示 `last_error` | — | 仅 `failed` 可悬浮 |
| 同步 Tag = `retrying` | — | 副行倒计时每秒递减 | `第 {attempts} 次 · 下次 {mm:ss} 后` | 倒计时到 0→自动重试并刷新 |
| 冲突行 | — | 整行 `orange.soft` 高亮 + 左 orange 条 + 右「解决冲突」 | — | 仅 `conflict` |
| `详情` | click | 合同详情页(§4.4) | `详情` | — |
| `立即重试` | click | `sync_contract` 重试；按钮 loading；成功刷新行 | `立即重试` | **仅 `pending`/`retrying` 可点** |
| `解决冲突` | click | 冲突合并页(§4.8) | `解决冲突` | **仅 `conflict` 行** |
| 行 | 轮询 5s | 刷新 ingest stage / sync state；`retrying` 倒计时本地每秒走 | — | `done`+`synced` 行可停轮询 |
| Excel 同步全局关闭 | — | 同步列**整列**灰「已禁用 ⊘」；`立即重试`/`解决冲突` 禁用 | `已禁用 ⊘` | 入库列不受影响 |

**四态**：加载=骨架行 + 概览卡占位；空=`还没有处理记录`；错误=`加载失败：{原因}` + 重试；正常=数据。

**边界用例**：`retrying` 倒计时纯前端递减、以服务端 `last_attempt_at`/`attempts` 为准对齐；重试请求进行中禁止重复点击；轮询与本地倒计时不要互相抖动（倒计时本地走，轮询只校正）。

**数据契约**：
- `GET /processing`【需后端补·聚合】→ 每行 `{ contract_id, counterparty, ingest: { stage, status }, sync: { state, attempts, last_error, last_attempt_at, updated_at } }`。
  - sync 部分来自 `list_statuses()`（INTERFACE）；ingest 部分来自 `tasks` 表（`storage/db.py`）。**建议后端提供该聚合端点**，避免前端两处拼接。
- `POST /contracts/{id}/sync/retry`【需后端补】→ `sync_contract(id)` → `SyncResult`。
- 全局开关读 `config.excel.enabled`。

**不要做**：① 把两状态合并成一个总状态/总列；② 任何「同步没完=合同不可用」的暗示；③ 倒计时不动或重置错乱；④ 失败不让看原因（必须 Tooltip 给 `last_error`）。

---

### 4.8 冲突合并（三方对照）

**目的**：当系统值与台账值对同一字段都变化时，让用户**逐字段**在「系统 / 台账 / 手动输入」间选定保留值；提交后**写回两边并成为新基线**。

**冲突判定（前端不自己判，照 `get_conflict` 返回；规则供理解，来自 INTERFACE）**：字段 owner 单方改动 **不算**冲突；只有「人工改了**系统**字段」或「两边都改了同一字段」才算冲突。`department/brief_description` 不同步、不会出现在此。

**区域**：顶栏（`返回` + `解决冲突` + 冲突计数 Tag + `contract_id`·对方）｜ 说明条 ｜ 冲突字段表（三方对照）｜ 无冲突字段折叠区 ｜ 底部（左实时汇总 + 右 `取消`/`确认合并`）。

**说明条文案**：`以下字段在数据库和 Excel 台账中出现不一致。基线 = 上次同步时的值，帮助你判断改动来自哪一方。请逐字段选择要保留的版本。`

**三方对照表**：列 = `字段(+列归属徽章) | 基线（上次导出） | 系统（数据库） | 台账（Excel） | 选择`。

| 元素 | 触发/态 | 结果 | 精确文案 | 边界/禁用 |
|---|---|---|---|---|
| 列归属徽章 | — | `owner=system`→「系统列」(蓝)；`owner=human`→「人工列」(灰) | `系统列` / `人工列` | — |
| 差异单元格 | — | 与基线不同的一侧 `highlight.diff` 浅黄底 | — | — |
| 基线列 | — | 最低视觉权重（灰），**仅参照、不可选** | — | — |
| 选择单选组 | click | `用系统值 / 用台账值 / 手动输入` 互斥 | `用系统值` `用台账值` `手动输入` | 默认预选 = `get_conflict` 的 `suggested`（若有） |
| `手动输入` | 选中 | 下方展开输入框并聚焦，值即最终值 | 占位 `输入要保留的值` | 切走收起并丢弃；选中后空值→`确认合并` 拦截 |
| 实时汇总（底部左） | 随选择更新 | chips 显示每字段最终取值 | `本次将采用：` + `{field}={用系统值/用台账值/手动}` | — |
| `展开全部字段` | click | 展开无冲突字段（灰显 + `一致` tag，只读） | `展开全部字段` ↔ `收起` | — |
| `取消` / `返回` / `Esc` | click | 回入库与同步页，**不写入** | `取消` | 选择是草稿，直接返回不拦截 |
| `确认合并`(primary) | click | `resolve_conflict(id, resolutions)`→写回两边+新基线→Toast→回列表该行转 `synced` | `确认合并` / Toast `已合并 {id}，生成新基线` | **有字段未选→拦截** `还有 {n} 个字段未选择` |

**`resolutions` 提交格式**（INTERFACE）：`{ field: "system" | "excel" | <手动输入的显式值> }`。

**四态**：加载=表格骨架；**该合同已无冲突**（并发被他人解决）=`该合同的冲突已被解决` + `返回`；提交中=`确认合并` loading + 表单只读；提交失败=错误 Toast，保留所有选择。

**边界用例**：① 全部冲突字段必须有选择才能确认；② 选「手动输入」则值不能为空；③ **并发**——提交时若基线已变（他处已改/已同步）→后端返回冲突，前端提示 `数据已更新，请重新核对` 并重新拉取 `get_conflict`，不盲目覆盖。

**数据契约**：
- `GET /contracts/{id}/conflict`【需后端补·薄封装 `get_conflict`】→ `[{ field, baseline, system, excel, owner, suggested? }]`。
- `POST /contracts/{id}/resolve`【需后端补·薄封装 `resolve_conflict`】 body=`{ resolutions }` → `SyncResult`。

**不要做**：① 把「基线」做成可选项（它只参照）；② 漏选字段就允许提交；③ 手动输入空值通过校验；④ 不高亮「谁改了」（差异侧必须浅黄底）；⑤ 前端自行判定冲突（一律以 `get_conflict` 为准）。

---

## 附录 A：前端期望的 REST 端点清单（供后端照补）

> INTERFACE.md 已实现的函数标注在右；其余为前端期望、需后端补的 REST 封装。

| 端点 | 方法 | 对应后端 | 用途 |
|---|---|---|---|
| `/contracts` | GET | 【需补】查 `contracts` | 台账列表（筛选/排序/分页） |
| `/contracts/export` | GET | 【需补】 | 导出筛选结果 xlsx |
| `/contracts/{id}` | GET | 【需补】 | 详情/编辑读取 |
| `/contracts/{id}` | PATCH | 【需补】更新 `contracts` | 编辑保存 |
| `/contracts/{id}` | DELETE | 【需补】+ storage 清理 | 删除 |
| `/contracts/{id}/rename` | POST | 【需补】 | 改主键（含迁移） |
| `/contracts/{id}/file` | GET | 【需补】流式 | 在线查看/下载 signed.pdf |
| `/contracts/batch` | POST | 【需补】 | 批量导出/删除 |
| `/ingest/upload` | POST | 【需补】 | 上传 PDF |
| `/ingest/{task}/approval-page` | POST | `extract_approval` | 指认审批页并抽取 |
| `/ingest/{task}` | GET | tasks 表 | 轮询 stage/抽取结果 |
| `/ingest/{task}/confirm` | POST | `persist_approval`+存档+`sync_contract` | 确认入账 |
| `/processing` | GET | `list_statuses` + tasks 聚合 | 入库与同步表 |
| `/contracts/{id}/sync/retry` | POST | `sync_contract` | 立即重试 |
| `/contracts/{id}/conflict` | GET | `get_conflict` | 三方对照数据 |
| `/contracts/{id}/resolve` | POST | `resolve_conflict` | 确认合并 |
| `/config` | GET/PATCH | `config.yaml` | 设置项 |
| `/config/file-no-rules` | GET/PATCH | `get/set_file_no_rules` | 存档编号规则 |

> 鉴权、错误响应体（`{ code, message }`）、分页约定由后端统一定义；前端类型一律由 `/openapi.json` 经 `openapi-typescript` 生成。

## 附录 B：状态枚举速查

- **入库 stage**（tasks）：`uploaded / tagging / ocr_processing / alignment / llm_extraction / awaiting_user_confirmation / chunking / embedding / done / failed` → 文案见 §4.7。
- **Excel 同步 state**（`get_status`）：`synced / pending / retrying / conflict / disabled` → 见 §1.4。
- **合同业务 status**：`active / expired`（日期推导，只读）。
- **字段 owner**：`system`（系统列）/ `human`（人工列）。

---

*（全文完。如需追加：组件尺寸 token 细化、动效曲线、i18n、暗色主题，可在此基础上扩展。）*
