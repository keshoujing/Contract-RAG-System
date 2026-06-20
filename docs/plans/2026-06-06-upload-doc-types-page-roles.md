# 上传文档类型 + 页角色标注 + 按需下载 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 让上传向导支持「两层文档类型选择(合同/其他文件 → 合同版本)」、合同内「页角色标注(审批/合同/其他)」,并据此提供「整份 / 仅合同」按需下载;合同版本由用户在设置页管理。

**Architecture:** 复用现有 `settings` kv + `file_no_rules` 的「配置可管理」模式承载合同版本列表;页角色先存到 `tasks.page_tags`,入账时 flush 进现成的 `pages` 表(`page_type` 列已预留);下载时用 fitz 按 `page_type='contract'` 实时抽页重组,不预生成。前后端契约改动同步进 `docs/INTERFACE.md`。

**Tech Stack:** FastAPI + SQLite(`contract_rag`)、PyMuPDF(fitz)、React + TanStack Query + Vitest、pytest TestClient。

---

## 锁定的产品决策(实现前必读)

1. **两层类型**:① 固定的 `合同 / 其他文件`;② 选「合同」才出现「合同版本」(采购合同/销售合同/Supply…,用户可管理)。
2. **其他文件**:直接过 —— 不分页、不选审批页、不抽取,纯归档。(Phase 4,后置)
3. **合同**:才进页角色标注(审批/合同/其他)。审批**可多页**;**每一页都必须显式标注一个角色,任一页未标注则不能进入下一步(没有默认桶/自动兜底)**;且**必须至少 1 审批页 + 1 合同页**。提供「其余设为合同」便捷按钮,把当前未标注页一次性显式标为合同(仍算显式标注),缓解长文档逐页点击。
4. **合同版本**:上传时由用户选择,审批抽取出的值作预填可改;落库进 `contracts.contract_type`(现有列,语义=合同版本)。
5. **归属主体**:不做,假设单主体,用合同版本区分。
6. **下载**:整份 / 仅合同;按需用 fitz 抽页,不预生成;Win 另存场景,不管签名完整性、暂不管误标。
7. **DB**:页角色按 `page_no` 存进 `pages` 表;向导期间暂存 `tasks.page_tags` JSON。
8. **前端两层选择必须优雅、不突兀**(见下「UX 设计」)。

## 现有可复用资产(不要重造轮子)

- `tasks` / `pages` 表已存在;`pages.page_type` 列注释已写明 `审批/合同/比价/补充 (user-tagged; not set this slice)`([db.py:74](../../contract_rag/storage/db.py))。
- `db.insert_pages(contract_id, rows)` / `db.get_pages(contract_id)` 已实现([db.py:257](../../contract_rag/storage/db.py))。
- `db.delete_contract` 已带 `DELETE FROM pages WHERE contract_id=?` 级联([db.py:243](../../contract_rag/storage/db.py))。
- `tasks` 的 additive 迁移钩子 `_migrate_tasks`([db.py:120](../../contract_rag/storage/db.py))。
- 配置可管理模式:`settings.get_setting/set_setting`([settings.py:28](../../contract_rag/sync/settings.py))、`get_file_no_rules/set_file_no_rules`([file_no.py:42](../../contract_rag/sync/file_no.py))、路由 `PATCH /config/file-no-rules`([config.py](../../contract_rag/api/routes/config.py))、前端 `updateFileNoRules` + SettingsPage 草稿编辑模式。
- confirm 已经「merge 用户字段 over 抽取」([uploads.py:145](../../contract_rag/api/routes/uploads.py)),所以 `contract_type` 走 `fields` 即可落库,无需新列。

## 文件改动地图

**后端**
- `contract_rag/sync/contract_versions.py`(新建)— 合同版本列表的 get/set,封装 settings kv。
- `contract_rag/api/routes/config.py`(改)— `GET /config` 增 `contractVersions`;新增 `PATCH /config/contract-versions`。
- `contract_rag/api/projections.py`(改)— `to_config_state` 增 `contractVersions` 字段。
- `contract_rag/storage/db.py`(改)— `tasks` 增列 `page_tags TEXT`、`doc_kind TEXT`;`set_task_page_tags`、`get_task` 已返回全行。
- `contract_rag/api/schemas.py`(改)— 新增 `PageTagsRequest`;`ConfirmRequest` 增 `contract_type`、`doc_kind`。
- `contract_rag/api/routes/uploads.py`(改)— 新增 `POST /ingest/{task_id}/page-tags`(取代 `/approval-page`);`confirm` flush 页角色进 `pages`。
- `contract_rag/api/routes/contracts.py`(改)— `GET /contracts/{id}/file` 增 `scope` 查询参数。
- `contract_rag/api/pdf_subset.py`(新建)— fitz 抽页重组(纯 I/O helper)。

**前端**
- `frontend/src/api/types.ts`(改)— `ConfigState.contractVersions`;`PageRole` 联合类型。
- `frontend/src/api/client.ts`(改)— `getConfig` 带 contractVersions;`updateContractVersions`;`submitPageTags`;`downloadContractFile(id, scope)`。
- `frontend/src/api/hooks.ts`(改)— 复用 `useConfig`(已存在)。
- `frontend/src/features/settings/SettingsPage.tsx`(改)— 合同版本管理 UI(镜像 file-no 规则)。
- `frontend/src/features/upload/UploadPage.tsx`(改)— 两层类型选择 + 页角色画刷标注 + submitPageTags。
- `frontend/src/features/ledger/LedgerPage.tsx`(改)— 下载菜单加「整份 / 仅合同」。
- `frontend/src/styles.css`(改)— 画刷按钮、页角色角标(3 色)、类型选择段控。

**文档**
- `docs/INTERFACE.md`(改)— ingest 端点(`/page-tags`)、`/config` 新字段、`/contracts/{id}/file?scope`。

## UX 设计:两层类型选择(优雅、不突兀)

放在 **Step 1「上传」卡片内、文件上传成功之后**淡入,而不是新开一步,避免步骤膨胀:

```
┌ 上传成功:xxx.pdf · 10 页 ────────────────────────┐
│  这份文件是?   [ 合同 ]  [ 其他文件 ]   ← 段控(默认 合同)│
│                                                     │
│  合同版本     [ 采购合同      ▾ ]   ← 仅「合同」时淡入  │
└─────────────────────────────────────────────────────┘
```

- 「合同 / 其他文件」用段控(segmented control),同 `chip-select` 风格,默认「合同」。
- 选「合同」→ 下方淡入「合同版本」下拉(数据来自 `useConfig().contractVersions`);「下一步」走指认审批页。
- 选「其他文件」→ 隐藏合同版本、隐藏 Step2;「下一步」直达入账(Phase 4)。
- **Phase 1-3 阶段只有「合同」一种路径**:段控可先只渲染「合同」一项或整体隐藏,但 `contractVersion` 下拉的 DOM 位置须按上图预留,Phase 4 加段控时不重排版面 → 不突兀。

---

# Phase 1 — 合同版本可管理 + 上传时选择

**交付:** 用户能在设置页增删改合同版本;上传合同时从该列表选版本,入账后落 `contracts.contract_type`。

### Task 1.1: 合同版本存取层

**Files:**
- Create: `contract_rag/sync/contract_versions.py`
- Modify: `contract_rag/sync/__init__.py`
- Test: `tests/test_contract_versions.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/test_contract_versions.py
from contract_rag.sync.contract_versions import get_contract_versions, set_contract_versions


def test_seed_defaults_when_unset(tmp_path, monkeypatch):
    monkeypatch.setattr("contract_rag.config.load_config", _cfg(tmp_path))
    versions = get_contract_versions()
    assert "Supply Agreement" in versions


def test_set_then_get_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr("contract_rag.config.load_config", _cfg(tmp_path))
    set_contract_versions(["采购合同", "销售合同"])
    assert get_contract_versions() == ["采购合同", "销售合同"]


def test_set_dedupes_and_drops_blanks(tmp_path, monkeypatch):
    monkeypatch.setattr("contract_rag.config.load_config", _cfg(tmp_path))
    set_contract_versions(["采购合同", "采购合同", "  ", "销售合同"])
    assert get_contract_versions() == ["采购合同", "销售合同"]


def _cfg(tmp_path):
    import types
    sqlite = tmp_path / "t.db"
    return lambda: types.SimpleNamespace(paths=types.SimpleNamespace(sqlite_path=sqlite))
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/test_contract_versions.py -v`
Expected: FAIL（`ModuleNotFoundError: contract_rag.sync.contract_versions`）

- [ ] **Step 3: 写实现**

```python
# contract_rag/sync/contract_versions.py
"""User-managed list of contract versions (合同版本), persisted in the settings kv.

Mirrors the file_no_rules pattern: seeded with the spec defaults, overridable
from the settings page. The value lands on ``contracts.contract_type``.
"""
from __future__ import annotations

from contract_rag.sync import settings

_KEY = "contract_versions"
_SEED = ["Supply Agreement", "Service Agreement", "Framework", "Supplement"]


def get_contract_versions(db_path=None) -> list[str]:
    stored = settings.get_setting(_KEY, None, db_path=db_path)
    if not stored:
        return list(_SEED)
    return [v for v in stored if isinstance(v, str) and v.strip()]


def set_contract_versions(versions: list[str], db_path=None) -> None:
    seen: list[str] = []
    for v in versions:
        if isinstance(v, str) and v.strip() and v.strip() not in seen:
            seen.append(v.strip())
    settings.set_setting(_KEY, seen, db_path=db_path)
```

- [ ] **Step 4: 导出符号**

```python
# contract_rag/sync/__init__.py — 在现有 from ... import 区块追加
from contract_rag.sync.contract_versions import (
    get_contract_versions,
    set_contract_versions,
)
# 并把这两个名字加进 __all__
```

- [ ] **Step 5: 跑测试确认通过**

Run: `.venv/bin/pytest tests/test_contract_versions.py -v`
Expected: PASS（3 passed）

- [ ] **Step 6: 提交**

```bash
git add contract_rag/sync/contract_versions.py contract_rag/sync/__init__.py tests/test_contract_versions.py
git commit -m "feat: user-managed contract version list (settings kv)"
```

### Task 1.2: /config 暴露 + 写入合同版本

**Files:**
- Modify: `contract_rag/api/projections.py`（`to_config_state`）
- Modify: `contract_rag/api/routes/config.py`
- Test: `tests/api/test_config.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_config.py — 追加
def test_config_exposes_contract_versions(client):
    body = client.get("/api/config").json()
    assert isinstance(body["contractVersions"], list)
    assert "Supply Agreement" in body["contractVersions"]


def test_patch_contract_versions_persists(client):
    r = client.patch("/api/config/contract-versions", json={"versions": ["采购合同", "销售合同"]})
    assert r.status_code == 200
    assert r.json() == ["采购合同", "销售合同"]
    assert client.get("/api/config").json()["contractVersions"] == ["采购合同", "销售合同"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_config.py -k contract_versions -v`
Expected: FAIL（`KeyError: 'contractVersions'` / 404）

- [ ] **Step 3: projections 增字段**

`contract_rag/api/projections.py` 的 `to_config_state(...)` 增加形参 `contract_versions: list[str]` 并在返回 dict 里加 `"contractVersions": contract_versions`。

- [ ] **Step 4: 路由接线**

```python
# contract_rag/api/routes/config.py
from contract_rag.sync import (
    get_contract_versions, set_contract_versions,
    get_file_no_rules, set_file_no_rules, settings,
)

# _current_config() 内 to_config_state(...) 调用追加:
#     contract_versions=get_contract_versions(),

@router.patch("/config/contract-versions")
def patch_contract_versions(body: dict) -> list[str]:
    """Persist the managed contract-version list (front-end setter)."""
    set_contract_versions(body.get("versions", []))
    return get_contract_versions()
```

- [ ] **Step 5: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_config.py -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add contract_rag/api/projections.py contract_rag/api/routes/config.py tests/api/test_config.py
git commit -m "feat: expose + persist contract versions via /config"
```

### Task 1.3: 前端类型 + client + 设置页管理 UI

**Files:**
- Modify: `frontend/src/api/types.ts`、`frontend/src/api/client.ts`
- Modify: `frontend/src/features/settings/SettingsPage.tsx`
- Test: `frontend/src/__tests__/app.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx — 追加(在 Settings 相关 describe 内)
it("manages the contract version list from settings", async () => {
  renderApp("/settings");
  await screen.findByText("编号规则");
  const input = await screen.findByLabelText("新增合同版本");
  await userEvent.type(input, "采购合同");
  await userEvent.click(screen.getByRole("button", { name: "添加版本" }));
  expect(await screen.findByText("采购合同")).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run -t "contract version"`
Expected: FAIL（找不到「新增合同版本」输入框）

- [ ] **Step 3: types + client**

```ts
// types.ts — ConfigState 内追加
contractVersions: string[];

// client.ts — getConfig 的 mock 回退 configState 也要补 contractVersions: [...]
export async function updateContractVersions(versions: string[]): Promise<string[]> {
  try {
    const response = await patchJson<unknown>("/config/contract-versions", { versions });
    return Array.isArray(response) ? response as string[] : versions;
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return versions;
  }
}
```

- [ ] **Step 4: SettingsPage 增「合同版本」区块**

在 file-no 规则卡片下方新增一张卡片:草稿 state `versionDrafts: string[]`、一个「新增合同版本」输入框 + 「添加版本」按钮(push 到草稿)、列表每项带删除按钮、「保存合同版本」按钮调用 `updateContractVersions`,成功后 `queryClient.setQueryData(["config"], …)`。镜像现有 `saveFileNoRules` 的结构。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd frontend && npx vitest run -t "contract version"`
Expected: PASS

- [ ] **Step 6: tsc + 提交**

```bash
cd frontend && npx tsc --noEmit
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/features/settings/SettingsPage.tsx frontend/src/__tests__/app.test.tsx
git commit -m "feat: manage contract versions in settings page"
```

### Task 1.4: 上传时选合同版本(Step 1 下拉)

**Files:**
- Modify: `frontend/src/features/upload/UploadPage.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/__tests__/app.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx — 在上传向导 describe 内追加
it("lets the user pick a contract version before tagging pages", async () => {
  renderApp("/upload");
  await uploadPdfFixture();                 // 既有 helper:上传并到 Step1 完成态
  const select = await screen.findByLabelText("合同版本");
  await userEvent.selectOptions(select, "Service Agreement");
  expect((select as HTMLSelectElement).value).toBe("Service Agreement");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run -t "contract version before tagging"`
Expected: FAIL（找不到「合同版本」下拉)

- [ ] **Step 3: 实现下拉**

`UploadPage` 增 state `const [contractVersion, setContractVersion] = useState("")`;`const { data: config } = useConfig();`。在 `UploadStep` 上传成功后渲染按 UX 设计的 `合同版本` `<select>`(aria-label「合同版本」,选项来自 `config?.contractVersions ?? []`,首项空占位「请选择合同版本」)。把 `contractVersion` 透传,confirm 时塞进 `fields.contract_type`(见 Step 4)。

- [ ] **Step 4: confirm 携带 contract_type**

`submitConfirmEntry` 的 `confirmIngest(... { fields: { ...confirmFields, contract_type: contractVersion || confirmFields.contract_type }, ... })`。

- [ ] **Step 5: 跑测试 + tsc 确认通过**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/src/features/upload/UploadPage.tsx frontend/src/styles.css frontend/src/__tests__/app.test.tsx
git commit -m "feat: select contract version during upload"
```

---

# Phase 2 — 页角色标注(审批/合同/其他)

**交付:** Step2 从「单选审批页」改为「三类画刷逐页标注」;后端存 `tasks.page_tags` 并在入账时 flush 进 `pages`。

### Task 2.1: tasks 表加 page_tags + 存取

**Files:**
- Modify: `contract_rag/storage/db.py`（schema、`_migrate_tasks`、新增 `set_task_page_tags`）
- Test: `tests/api/test_db_migrations.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_db_migrations.py — 追加
def test_tasks_has_page_tags_column(tmp_db):
    cols = {r["name"] for r in tmp_db.execute("PRAGMA table_info(tasks)")}
    assert "page_tags" in cols


def test_set_and_read_page_tags(tmp_db_path):
    from contract_rag.storage import db
    tid = db.create_task(db_path=tmp_db_path)
    db.set_task_page_tags(tid, {"1": "approval", "2": "contract"}, db_path=tmp_db_path)
    row = db.get_task(tid, db_path=tmp_db_path)
    import json
    assert json.loads(row["page_tags"]) == {"1": "approval", "2": "contract"}
```

（若 `tmp_db`/`tmp_db_path` fixture 不存在,按本文件既有 fixture 命名对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_db_migrations.py -k page_tags -v`
Expected: FAIL

- [ ] **Step 3: schema + 迁移 + setter**

```python
# db.py — tasks CREATE TABLE 内增两列
    page_tags     TEXT,
    doc_kind      TEXT,

# _migrate_tasks 的 additive 列元组里追加
    ("page_tags", "TEXT"), ("doc_kind", "TEXT"),

# 新增函数(放在 set_task_extraction 附近)
def set_task_page_tags(task_id: str, page_tags: dict, db_path=None) -> None:
    """Stash the per-page role map {page_no(str): role} on the task row."""
    import json
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET page_tags = ?, updated_at = ? WHERE task_id = ?",
            (json.dumps(page_tags, ensure_ascii=False), _now(), task_id),
        )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_db_migrations.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add contract_rag/storage/db.py tests/api/test_db_migrations.py
git commit -m "feat: tasks.page_tags + doc_kind columns and setter"
```

### Task 2.2: /ingest/{task_id}/page-tags 端点

**Files:**
- Modify: `contract_rag/api/schemas.py`、`contract_rag/api/routes/uploads.py`
- Test: `tests/api/test_uploads.py`

页角色规范化常量:`审批→"approval"`、`合同→"contract"`、`其他→"other"`(后端只认英文枚举;中文留前端展示)。

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_uploads.py — 追加
def test_page_tags_extracts_from_first_approval_page(client, monkeypatch):
    seen = {}
    def fake(pdf, page_no, **kw):
        seen["page_no"] = page_no
        return {"contract_number": "JSUS2026200"}
    monkeypatch.setattr(uploads, "extract_approval", fake)
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(4), "application/pdf")}).json()["task_id"]

    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {
        "1": "contract", "2": "approval", "3": "contract", "4": "other"}})
    assert r.status_code == 200
    assert seen["page_no"] == 2     # 取第一个审批页喂抽取
    assert client.get(f"/api/ingest/{task_id}").json()["stage"] == "awaiting_user_confirmation"


def test_page_tags_requires_approval_and_contract(client):
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(2), "application/pdf")}).json()["task_id"]
    # 缺审批页(两页都已标注,覆盖完整)
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "contract", "2": "other"}})
    assert r.status_code == 422
    # 缺合同页
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "other"}})
    assert r.status_code == 422


def test_page_tags_requires_every_page_tagged(client):
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")}).json()["task_id"]
    # 第 3 页未标注 -> 必须 422
    r = client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {"1": "approval", "2": "contract"}})
    assert r.status_code == 422
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_uploads.py -k page_tags -v`
Expected: FAIL（404 / 端点不存在）

- [ ] **Step 3: schema**

```python
# schemas.py
class PageTagsRequest(BaseModel):
    """Per-page role map {page_no(str): "approval"|"contract"|"other"}."""
    tags: dict[str, Literal["approval", "contract", "other"]]
```

- [ ] **Step 4: 路由**

```python
# uploads.py — import PageTagsRequest;新增端点(并删除旧 /approval-page)
@router.post("/ingest/{task_id}/page-tags")
def submit_page_tags(task_id: str, body: PageTagsRequest) -> dict:
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    pdf = sp.signed_pdf(sp.upload_dir(task_id))
    n = rendering.page_count(pdf)
    tagged = {int(p) for p in body.tags}
    if tagged != set(range(1, n + 1)):
        raise HTTPException(status_code=422, detail="每一页都需要标注角色")
    approval_pages = sorted(int(p) for p, r in body.tags.items() if r == "approval")
    contract_pages = [int(p) for p, r in body.tags.items() if r == "contract"]
    if not approval_pages:
        raise HTTPException(status_code=422, detail="至少标注一页审批页")
    if not contract_pages:
        raise HTTPException(status_code=422, detail="至少标注一页合同页")

    db.update_task_stage(task_id, "llm_extraction", status="running")
    try:
        fields = extract_approval(pdf, approval_pages[0])
    except Exception:  # noqa: BLE001
        logger.exception("approval extraction failed for task %s", task_id)
        db.update_task_stage(task_id, "failed", status="failed", error_message="抽取失败")
        raise HTTPException(status_code=502, detail="审批页抽取失败,请重试")
    db.set_task_extraction(task_id, approval_page=approval_pages[0], extraction=fields)
    db.set_task_page_tags(task_id, body.tags)
    db.update_task_stage(task_id, "awaiting_user_confirmation")
    return {"task_id": task_id, "stage": "awaiting_user_confirmation"}
```

更新既有用例 `test_ingest_flow`、`test_confirm_duplicate_then_overwrite`、`test_extract_failure_returns_502_and_marks_failed`、`test_approval_page_rejects_bad_page`:把 `/approval-page {"page_no":1}` 改为 `/page-tags {"tags":{"1":"approval","2":"contract"}}`(`_pdf_bytes` 至少 2 页);bad-page 用例改为校验缺审批/合同的 422。

- [ ] **Step 5: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_uploads.py -v`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add contract_rag/api/schemas.py contract_rag/api/routes/uploads.py tests/api/test_uploads.py
git commit -m "feat: /ingest/page-tags replaces /approval-page (multi-role tagging)"
```

### Task 2.3: confirm 时 flush 页角色进 pages 表

**Files:**
- Modify: `contract_rag/api/routes/uploads.py`（`confirm_ingest`）
- Test: `tests/api/test_uploads.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_uploads.py — 追加
def test_confirm_persists_page_roles(client, monkeypatch):
    monkeypatch.setattr(uploads, "extract_approval",
                        lambda pdf, page_no, **kw: {"contract_number": "JSUS2026201"})
    task_id = client.post("/api/ingest/upload",
        files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")}).json()["task_id"]
    client.post(f"/api/ingest/{task_id}/page-tags", json={"tags": {
        "1": "approval", "2": "contract", "3": "other"}})
    r = client.post(f"/api/ingest/{task_id}/confirm", json={
        "fields": {"contract_id": "JSUS2026201", "amount": "100"},
        "effective_date": "2026-01-01", "expiration_date": "2027-01-01"})
    assert r.status_code == 200
    pages = db.get_pages("JSUS2026201")
    roles = {p["page_no"]: p["page_type"] for p in pages}
    assert roles == {1: "approval", 2: "contract", 3: "other"}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_uploads.py -k page_roles -v`
Expected: FAIL（`db.get_pages` 返回空）

- [ ] **Step 3: confirm 内 flush**

```python
# uploads.py confirm_ingest 内,promote_upload 之前(此时 contract_id 已知)插入:
    if task.get("page_tags"):
        tags = json.loads(task["page_tags"])
        db.insert_pages(contract_id, [
            {"page_no": int(p), "page_type": role, "route": None, "avg_confidence": None}
            for p, role in tags.items()
        ])
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_uploads.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add contract_rag/api/routes/uploads.py tests/api/test_uploads.py
git commit -m "feat: flush tagged page roles into pages table on confirm"
```

### Task 2.4: 前端画刷标注 UI(取代单选)

**Files:**
- Modify: `frontend/src/api/types.ts`、`frontend/src/api/client.ts`
- Modify: `frontend/src/features/upload/UploadPage.tsx`
- Modify: `frontend/src/styles.css`
- Test: `frontend/src/__tests__/app.test.tsx`

页角色展示映射:`approval→审批`(蓝)、`contract→合同`(绿)、`other→其他`(灰)。

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx — 重写「指认审批页」相关用例
it("requires every page tagged plus an approval and contract page", async () => {
  renderApp("/upload");
  await uploadPdfFixture();                  // 10 页
  await userEvent.click(screen.getByRole("button", { name: "下一步" }));
  const next = screen.getByRole("button", { name: /下一步:抽取字段/ });
  expect(next).toBeDisabled();               // 全部未标注
  // 标第 1 页为审批
  await userEvent.click(screen.getByRole("button", { name: "审批" }));
  await userEvent.click(screen.getByRole("button", { name: /第 1 页/ }));
  expect(next).toBeDisabled();               // 仍有未标注页 → 不可过
  // 其余一次性设为合同
  await userEvent.click(screen.getByRole("button", { name: "其余设为合同" }));
  expect(next).toBeEnabled();                // 全部已标注 + 含审批 + 含合同
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run -t "paints page roles"`
Expected: FAIL

- [ ] **Step 3: types + client**

```ts
// types.ts
export type PageRole = "approval" | "contract" | "other";

// client.ts — 取代 submitApprovalPage
export async function submitPageTags(taskId: string, tags: Record<number, PageRole>): Promise<void> {
  try {
    const payload = Object.fromEntries(Object.entries(tags).map(([k, v]) => [String(k), v]));
    await postJson<unknown>(`/ingest/${encodeURIComponent(taskId)}/page-tags`, { tags: payload });
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
  }
}
```

- [ ] **Step 4: UploadPage 画刷标注**

- state:`const [pageRoles, setPageRoles] = useState<Record<number, PageRole>>({})`;`const [brush, setBrush] = useState<PageRole>("approval")`。
- **不做任何初始化** —— 进入 Step2 时所有页都是未标注(`pageRoles` 为空)。
- 顶部三个画刷按钮(`审批/合同/其他`,role=button,aria-label 用中文),高亮当前 brush;旁边一个「其余设为合同」按钮。
- 点缩略图 → `setPageRoles(r => ({ ...r, [page]: brush }))`(再点同 brush 同页保持;改 brush 再点即改类型)。
- 「其余设为合同」→ 把所有未标注页显式设为 contract:`setPageRoles(r => { const next = { ...r }; for (let p = 1; p <= pageCount; p++) if (!next[p]) next[p] = "contract"; return next; })`(`pageCount = uploadedFile?.pages ?? 0`)。
- 未标注的缩略图:不显示角标(或显示淡「未标注」提示);已标注的内部叠加角标 `<span className="page-role-badge role-{role}">{中文}</span>`,**不改缩略图结构**(角标 absolute 定位,同现有「审批页」角标位置)。
- **每页必须已标注**:`const allTagged = pageCount > 0 && Object.keys(pageRoles).length === pageCount;` `const hasApproval = Object.values(pageRoles).includes("approval");` `const hasContract = Object.values(pageRoles).includes("contract");` `const canExtract = allTagged && hasApproval && hasContract;`「下一步:抽取字段」`disabled={!canExtract}`。
- 底部状态文案提示未标注页数:`已标注 ${Object.keys(pageRoles).length}/${pageCount}`,缺审批/合同时给对应提示。
- `continueToConfirmStep` 改调 `submitPageTags(taskId, pageRoles)`。
- 移除旧 `approvalPage` 单选逻辑;`ConfirmStep` 的 `approvalPage` 改用第一个 approval 页计算:`const approvalPage = Number(Object.entries(pageRoles).find(([, r]) => r === "approval")?.[0])`。

- [ ] **Step 5: styles.css 角标 3 色 + 画刷按钮**

```css
.role-brushes { display: flex; gap: 8px; margin-bottom: 12px; }
.role-brush { height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface-primary); cursor: pointer; }
.role-brush.active { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.page-role-badge { position: absolute; top: 8px; left: 8px; border-radius: 999px; padding: 2px 7px; font-size: 11px; color: #fff; z-index: 1; }
.page-role-badge.role-approval { background: var(--accent); }
.page-role-badge.role-contract { background: #15924f; }
.page-role-badge.role-other { background: var(--fg-tertiary); }
```

- [ ] **Step 6: 跑测试 + tsc 确认通过**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS（全部用例）

- [ ] **Step 7: 提交**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/features/upload/UploadPage.tsx frontend/src/styles.css frontend/src/__tests__/app.test.tsx
git commit -m "feat: page-role painting UI (审批/合同/其他) replaces single approval select"
```

---

# Phase 3 — 按需下载(整份 / 仅合同)

**交付:** 后端按 `scope=contract` 用 fitz 抽出合同页重组 PDF;台账下载入口提供「整份 / 仅合同」。

### Task 3.1: fitz 抽页 helper

**Files:**
- Create: `contract_rag/api/pdf_subset.py`
- Test: `tests/api/test_pdf_subset.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_pdf_subset.py
import fitz
from contract_rag.api.pdf_subset import subset_pdf_bytes


def _pdf(n):
    doc = fitz.open()
    for _ in range(n):
        doc.new_page(width=200, height=300)
    return doc.tobytes()


def test_subset_keeps_only_requested_pages(tmp_path):
    src = tmp_path / "s.pdf"
    src.write_bytes(_pdf(5))
    out = subset_pdf_bytes(src, [2, 4])           # 1-indexed
    doc = fitz.open(stream=out, filetype="pdf")
    assert doc.page_count == 2


def test_subset_empty_pages_raises(tmp_path):
    src = tmp_path / "s.pdf"
    src.write_bytes(_pdf(3))
    import pytest
    with pytest.raises(ValueError):
        subset_pdf_bytes(src, [])
```

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_pdf_subset.py -v`
Expected: FAIL

- [ ] **Step 3: 实现**

```python
# contract_rag/api/pdf_subset.py
"""Build a new PDF containing only selected (1-indexed) pages, in order."""
from __future__ import annotations

import pathlib

import fitz


def subset_pdf_bytes(pdf_path: str | pathlib.Path, pages_1indexed: list[int]) -> bytes:
    if not pages_1indexed:
        raise ValueError("no pages selected for subset")
    with fitz.open(str(pdf_path)) as src:
        keep = [p - 1 for p in sorted(set(pages_1indexed)) if 1 <= p <= src.page_count]
        if not keep:
            raise ValueError("selected pages out of range")
        out = fitz.open()
        out.insert_pdf(src, from_page=keep[0], to_page=keep[0])
        for idx in keep[1:]:
            out.insert_pdf(src, from_page=idx, to_page=idx)
        return out.tobytes()
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_pdf_subset.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add contract_rag/api/pdf_subset.py tests/api/test_pdf_subset.py
git commit -m "feat: fitz pdf page-subset helper"
```

### Task 3.2: /contracts/{id}/file?scope=contract

**Files:**
- Modify: `contract_rag/api/routes/contracts.py`
- Test: `tests/api/test_contracts.py`

- [ ] **Step 1: 写失败测试**

```python
# tests/api/test_contracts.py — 追加(沿用本文件既有 client/seed helper)
def test_download_contract_scope_returns_subset(client, seeded_contract):
    cid = seeded_contract  # 已入档、3 页、pages 标注 1=approval,2=contract,3=other
    full = client.get(f"/api/contracts/{cid}/file")
    sub = client.get(f"/api/contracts/{cid}/file?scope=contract")
    assert sub.status_code == 200
    import fitz
    assert fitz.open(stream=sub.content, filetype="pdf").page_count == 1
    assert len(full.content) != len(sub.content)


def test_download_contract_scope_falls_back_when_no_pages(client, seeded_contract_no_pages):
    cid = seeded_contract_no_pages
    sub = client.get(f"/api/contracts/{cid}/file?scope=contract")
    assert sub.status_code == 200  # 回退整份,不报错
```

（若无现成 seed fixture,在该测试文件内用 `db.upsert_contract` + `db.insert_pages` + 写 `sp.signed_pdf(sp.contract_dir(cid))` 构造。）

- [ ] **Step 2: 跑测试确认失败**

Run: `.venv/bin/pytest tests/api/test_contracts.py -k scope -v`
Expected: FAIL

- [ ] **Step 3: 路由加 scope**

```python
# contracts.py — 下载路由签名加 scope: str = "full",并在返回前:
from fastapi import Response
from contract_rag.api.pdf_subset import subset_pdf_bytes

# ...定位到 signed = sp.signed_pdf(sp.contract_dir(contract_id)) 之后:
    if scope == "contract":
        pages = db.get_pages(contract_id)
        contract_pages = [p["page_no"] for p in pages if p["page_type"] == "contract"]
        if contract_pages:
            data = subset_pdf_bytes(signed, contract_pages)
            return Response(content=data, media_type="application/pdf",
                            headers={"Content-Disposition": f'attachment; filename="{contract_id}-contract.pdf"'})
    # 默认 / 回退:整份 FileResponse(保持现有逻辑)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `.venv/bin/pytest tests/api/test_contracts.py -v`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add contract_rag/api/routes/contracts.py tests/api/test_contracts.py
git commit -m "feat: GET /contracts/{id}/file?scope=contract (contract-only subset)"
```

### Task 3.3: 前端下载「整份 / 仅合同」

**Files:**
- Modify: `frontend/src/api/client.ts`、`frontend/src/features/ledger/LedgerPage.tsx`
- Test: `frontend/src/__tests__/app.test.tsx`

- [ ] **Step 1: 写失败测试**

```tsx
// app.test.tsx — 追加
it("offers whole vs contract-only download from the row menu", async () => {
  renderApp("/ledger");
  await openRowContextMenu("JSUS2026004");      // 既有 helper
  await userEvent.click(screen.getByRole("button", { name: "下载 PDF" }));
  expect(screen.getByRole("menuitem", { name: "整份" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "仅合同" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run -t "whole vs contract-only"`
Expected: FAIL

- [ ] **Step 3: client 增 scope**

```ts
// client.ts — downloadContractFile 增 scope 形参
export async function downloadContractFile(contractId: string, scope: "full" | "contract" = "full"): Promise<Blob> {
  // ... fetch 路径改为 `/contracts/${id}/file${scope === "contract" ? "?scope=contract" : ""}`
}
```

- [ ] **Step 4: LedgerPage 下载二级菜单**

`ContextMenu` 的「下载 PDF」改为展开「整份 / 仅合同」两个 menuitem;分别调用 `downloadPdf(id, "full")` / `downloadPdf(id, "contract")`,后者文件名 `${id}-contract.pdf`。`downloadPdf` 增 scope 形参透传。

- [ ] **Step 5: 跑测试 + tsc 确认通过**

Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add frontend/src/api/client.ts frontend/src/features/ledger/LedgerPage.tsx frontend/src/__tests__/app.test.tsx
git commit -m "feat: whole vs contract-only download in ledger"
```

### Task 3.4: 同步 INTERFACE.md

**Files:**
- Modify: `docs/INTERFACE.md`

- [ ] **Step 1: 更新契约**

记录:`POST /ingest/{task_id}/page-tags`(取代 `/approval-page`)、`/config` 新增 `contractVersions` + `PATCH /config/contract-versions`、`GET /contracts/{id}/file?scope=full|contract`。

- [ ] **Step 2: 提交**

```bash
git add docs/INTERFACE.md
git commit -m "docs: sync INTERFACE with page-tags + contract-versions + download scope"
```

---

# Phase 4 —(后置)两层第一层:其他文件直通归档

> 用户明确「后期再说」。此阶段补齐 UX 设计里的 `合同 / 其他文件` 段控与「其他文件」直通路径。**唯一待你拍板项见文末。**

### Task 4.1: 其他文件归档落库形态(待确认)

**前置决策(本阶段开工前必须定):** 「其他文件」无审批页、无 contract_id —— 落库形态二选一:
- (a) 独立归档:新建 `documents`/`archives` 表 + 存储目录 `{storage}/_archive/{doc_id}/`,不进 `contracts`;
- (b) 挂靠到某已有合同:上传时选关联 contract_id。

> 该决策决定本阶段全部 schema 与端点,**不在本计划内展开代码**;定了再追加 Task 4.x 的 TDD 细化。

### Task 4.2: 前端段控 + 分支(其他文件跳过 Step2)

**Files:** `frontend/src/features/upload/UploadPage.tsx`、`frontend/src/styles.css`、`app.test.tsx`

- [ ] 在 Step1 渲染 `合同 / 其他文件` 段控(默认合同),`docKind` state;选「其他文件」→ 隐藏合同版本下拉与 Step2,「下一步」直达入账分支(依赖 Task 4.1 的端点)。复用 Phase 1 已预留的 DOM 位置,确保不重排。

---

## 自检(Self-Review)

- **Spec 覆盖:** 决策 1(两层)→ Phase1 tier2 + Phase4 tier1;决策 2(其他文件直通)→ Phase4;决策 3(页角色/多审批/默认合同/必选审批+合同)→ Task2.2 校验 + Task2.4 UI;决策 4(合同版本可管理 + 上传选 + 落 contract_type)→ Phase1;决策 6(整份/仅合同)→ Phase3;决策 7(page_no 存 pages)→ Task2.1+2.3。✅ 均有对应任务。
- **类型一致性:** 后端页角色枚举统一 `"approval"|"contract"|"other"`(schemas `PageTagsRequest`、uploads、pages 写入、contracts 读取一致);前端 `PageRole` 同名;`submitPageTags` 取代 `submitApprovalPage` 后,UploadPage 与 client 同步改名。
- **契约同步:** Task3.4 显式更新 `docs/INTERFACE.md`(CLAUDE.md 强制项)。
- **破坏性变更:** `/approval-page` → `/page-tags` 为破坏性,但前后端同仓同发,且已列出需改的 4 个后端用例 + 前端用例;DB 走 additive 迁移,不破坏存量库。
- **存量数据:** 老合同 `pages` 为空 →「仅合同」回退整份(Task3.2 已覆盖测试)。

## 风险与回退

- **fitz 重组体积/字体:** `insert_pdf` 保留矢量与文本,体积测试已断言「不等于整份」;若个别 PDF 重组异常,scope=contract 端点应 try/except 回退整份(可在 Task3.2 Step3 加 try 包裹)。
- **多审批页抽取:** 现取第一个审批页喂 `extract_approval`(单页签名不变);若将来需要拼接多审批页,扩 `extract_approval` 另立任务。
