# V1 Upload Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V1 FastAPI layer for a pure-archive contract upload pipeline (no RAG) and rewire the frontend upload wizard from mock to real API calls.

**Architecture:** FastAPI + uvicorn over the existing SQLite source of truth. The upload wizard is an async task+poll state machine driving the already-built `ingest`/`sync` functions. Slow steps (thumbnail render, approval LLM extraction) run in `BackgroundTasks`. New backend code is thin: HTTP routes + PDF thumbnail rendering + pure projection of existing data into the frontend's `types.ts` shapes.

**Tech Stack:** FastAPI, uvicorn, python-multipart, PyMuPDF (fitz), openpyxl (all but the first three already deps); frontend React 18 + TanStack Query + Vitest.

**Design spec:** `docs/plans/2026-06-03-v1-upload-backend-design.md` (read it first).

---

## File Structure

**Backend (new package `contract_rag/api/`):**
- `contract_rag/api/__init__.py` — package marker + `create_app` re-export
- `contract_rag/api/app.py` — FastAPI factory: CORS, router mounting
- `contract_rag/api/rendering.py` — fitz PDF → page-count + PNG thumbnails (pure I/O)
- `contract_rag/api/storage_paths.py` — `_uploads/{task_id}` ↔ `{contract_id}` paths, promote/move, traversal guard
- `contract_rag/api/projections.py` — pure: DB rows → `ContractRow`/`ProcessingRow`/`ConflictField`/`ConfigState`; query filter/sort; status/size/time derivation
- `contract_rag/api/schemas.py` — Pydantic request models
- `contract_rag/api/routes/uploads.py` — upload flow + file serving
- `contract_rag/api/routes/contracts.py` — ledger read + export + download
- `contract_rag/api/routes/processing.py` — processing list + sync retry
- `contract_rag/api/routes/conflicts.py` — conflict read + resolve
- `contract_rag/api/routes/config.py` — config read

**Backend modified:**
- `contract_rag/storage/db.py` — additive migration: `tasks +approval_page,+extraction`; `contracts +page_count`; helpers `set_task_extraction`, `delete_contract`
- `pyproject.toml` — add `fastapi`, `uvicorn[standard]`, `python-multipart`

**Backend tests (new):**
- `tests/api/test_rendering.py`, `tests/api/test_storage_paths.py`, `tests/api/test_projections.py`
- `tests/api/test_uploads.py`, `tests/api/test_contracts.py`, `tests/api/test_processing_conflicts.py`, `tests/api/test_config.py`

**Frontend modified:**
- `frontend/src/api/types.ts` — upload/extract/confirm/task types
- `frontend/src/api/client.ts` — upload flow client functions
- `frontend/src/api/hooks.ts` — upload flow hooks
- `frontend/src/features/upload/UploadPage.tsx` — rewire to real API
- `frontend/src/features/upload/FieldConfirmPage.tsx` — delete (dead duplicate)
- `frontend/src/App.tsx` — drop the `/confirm` route if present
- `frontend/src/__tests__/upload.test.tsx` — new

---

## Phase A — Backend foundation

### Task 1: Dependencies and DB migrations

**Files:**
- Modify: `pyproject.toml:7-32`
- Modify: `contract_rag/storage/db.py`
- Test: `tests/api/test_db_migrations.py`

- [ ] **Step 1: Add backend deps**

In `pyproject.toml`, add to the `dependencies` array (keep alphabetical-ish, after `cryptography`):

```toml
    "fastapi>=0.115.0",
    "python-multipart>=0.0.9",
    "uvicorn[standard]>=0.30.0",
```

Then run: `uv sync`
Expected: resolves and installs fastapi/uvicorn/python-multipart.

- [ ] **Step 2: Write failing test for new columns + helpers**

Create `tests/api/__init__.py` (empty) and `tests/api/test_db_migrations.py`:

```python
import json
from contract_rag.storage import db


def test_tasks_and_contracts_have_new_columns(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    with db.connect(p) as conn:
        task_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
        contract_cols = {r["name"] for r in conn.execute("PRAGMA table_info(contracts)")}
    assert {"approval_page", "extraction"} <= task_cols
    assert "page_count" in contract_cols


def test_set_task_extraction_roundtrip(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    task_id = db.create_task(db_path=p)
    db.set_task_extraction(task_id, approval_page=2, extraction={"contract_number": "X1"}, db_path=p)
    row = db.get_task(task_id, db_path=p)
    assert row["approval_page"] == 2
    assert json.loads(row["extraction"])["contract_number"] == "X1"


def test_delete_contract_removes_row(tmp_path):
    p = tmp_path / "t.db"
    db.init_db(p)
    db.upsert_contract("C1", db_path=p, status="active")
    db.delete_contract("C1", db_path=p)
    assert db.get_contract("C1", db_path=p) is None
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/api/test_db_migrations.py -v`
Expected: FAIL (columns missing / `set_task_extraction` undefined).

- [ ] **Step 4: Add columns to schema + migration**

In `contract_rag/storage/db.py`, update the `tasks` table in `_SCHEMA` to include the two columns (add after `error_message TEXT,`):

```python
    approval_page INTEGER,
    extraction    TEXT,
```

Update the `contracts` table in `_SCHEMA` to include (add after `status ... ,` line, before `created_at`):

```python
    page_count        INTEGER,
```

Add `page_count` to the `_CONTRACT_COLS` whitelist tuple:

```python
_CONTRACT_COLS = (
    "counterparty", "amount", "currency", "project_name", "department",
    "petitioner", "petition_date", "brief_description", "contract_type",
    "effective_date", "expiration_date", "file_no", "status", "raw_extraction",
    "page_count",
)
```

Add a `tasks` migration mirroring `_migrate_contracts`. Add this function and call it from `init_db`:

```python
def _migrate_tasks(conn: sqlite3.Connection) -> None:
    """Add task columns missing from a pre-existing DB (additive)."""
    existing = {r["name"] for r in conn.execute("PRAGMA table_info(tasks)")}
    for col, decl in (("approval_page", "INTEGER"), ("extraction", "TEXT")):
        if col not in existing:
            conn.execute(f"ALTER TABLE tasks ADD COLUMN {col} {decl}")
```

In `init_db`, after `_migrate_contracts(conn)` add: `_migrate_tasks(conn)`.

The `page_count` column is in `_CONTRACT_COLS`, so `_migrate_contracts` adds it to old DBs automatically (it defaults type TEXT — override by adding `"page_count": "INTEGER"` to the `types` dict in `_migrate_contracts`).

- [ ] **Step 5: Add `set_task_extraction` and `delete_contract` helpers**

In `contract_rag/storage/db.py`, after `get_task`:

```python
def set_task_extraction(task_id, *, approval_page=None, extraction=None, db_path=None) -> None:
    """Stash the chosen approval page + raw extraction JSON on the task row."""
    payload = json.dumps(extraction, ensure_ascii=False) if isinstance(extraction, (dict, list)) else extraction
    with connect(db_path) as conn:
        conn.execute(
            "UPDATE tasks SET approval_page = ?, extraction = ?, updated_at = ? WHERE task_id = ?",
            (approval_page, payload, _now(), task_id),
        )
```

After `get_contract`:

```python
def delete_contract(contract_id, db_path=None) -> None:
    """Remove a contract row and its page rows (used by overwrite re-ingest)."""
    with connect(db_path) as conn:
        conn.execute("DELETE FROM pages WHERE contract_id = ?", (contract_id,))
        conn.execute("DELETE FROM contracts WHERE contract_id = ?", (contract_id,))
```

- [ ] **Step 6: Run test to verify it passes**

Run: `uv run pytest tests/api/test_db_migrations.py -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml uv.lock contract_rag/storage/db.py tests/api/
git commit -m "feat: add api deps + tasks/contracts migrations for upload flow"
```

---

### Task 2: PDF thumbnail rendering

**Files:**
- Create: `contract_rag/api/__init__.py`, `contract_rag/api/rendering.py`
- Test: `tests/api/test_rendering.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_rendering.py`:

```python
import fitz
from contract_rag.api import rendering


def _make_pdf(path, n_pages):
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page(width=300, height=400)
    doc.save(str(path))
    doc.close()


def test_page_count(tmp_path):
    pdf = tmp_path / "a.pdf"
    _make_pdf(pdf, 3)
    assert rendering.page_count(pdf) == 3


def test_render_thumbnails_writes_one_png_per_page(tmp_path):
    pdf = tmp_path / "a.pdf"
    _make_pdf(pdf, 2)
    out = tmp_path / "pages"
    count = rendering.render_thumbnails(pdf, out)
    assert count == 2
    assert (out / "1.png").exists()
    assert (out / "2.png").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_rendering.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement rendering**

Create `contract_rag/api/__init__.py`:

```python
"""HTTP API layer for the V1 upload pipeline (FastAPI over the SQLite source of truth)."""
```

Create `contract_rag/api/rendering.py`:

```python
"""PDF page-count + thumbnail rendering (fitz). Pages are 1-indexed PNGs."""
from __future__ import annotations

import pathlib

import fitz

THUMBNAIL_DPI = 110


def page_count(pdf_path: str | pathlib.Path) -> int:
    with fitz.open(str(pdf_path)) as doc:
        return doc.page_count


def render_thumbnails(
    pdf_path: str | pathlib.Path,
    out_dir: str | pathlib.Path,
    *,
    dpi: int = THUMBNAIL_DPI,
) -> int:
    """Render every page to ``{out_dir}/{n}.png`` (n starts at 1). Returns page count."""
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    with fitz.open(str(pdf_path)) as doc:
        for i, page in enumerate(doc, start=1):
            pix = page.get_pixmap(matrix=matrix)
            pix.save(str(out / f"{i}.png"))
        return doc.page_count
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_rendering.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/__init__.py contract_rag/api/rendering.py tests/api/test_rendering.py
git commit -m "feat: PDF thumbnail rendering helper"
```

---

### Task 3: Storage paths

**Files:**
- Create: `contract_rag/api/storage_paths.py`
- Test: `tests/api/test_storage_paths.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_storage_paths.py`:

```python
import pytest
from contract_rag.api import storage_paths as sp


def test_upload_and_contract_dirs(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    assert sp.upload_dir("T1") == tmp_path / "_uploads" / "T1"
    assert sp.contract_dir("C1") == tmp_path / "C1"
    assert sp.signed_pdf(sp.upload_dir("T1")).name == "signed.pdf"


def test_promote_upload_moves_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    up = sp.upload_dir("T1")
    (up / "pages").mkdir(parents=True)
    sp.signed_pdf(up).write_bytes(b"%PDF-1.4")
    sp.promote_upload("T1", "C1")
    assert not up.exists()
    assert sp.signed_pdf(sp.contract_dir("C1")).read_bytes() == b"%PDF-1.4"


def test_promote_upload_overwrites_existing_contract_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    cdir = sp.contract_dir("C1")
    cdir.mkdir(parents=True)
    (cdir / "old.txt").write_text("stale")
    up = sp.upload_dir("T1")
    up.mkdir(parents=True)
    sp.signed_pdf(up).write_bytes(b"new")
    sp.promote_upload("T1", "C1")
    assert not (sp.contract_dir("C1") / "old.txt").exists()
    assert sp.signed_pdf(sp.contract_dir("C1")).read_bytes() == b"new"


def test_page_png_rejects_bad_index(tmp_path, monkeypatch):
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path)
    with pytest.raises(ValueError):
        sp.page_png(sp.upload_dir("T1"), 0)
    assert sp.page_png(sp.upload_dir("T1"), 3).name == "3.png"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_storage_paths.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement storage_paths**

Create `contract_rag/api/storage_paths.py`:

```python
"""Filesystem layout for archived contracts.

Uploads land under ``{storage}/_uploads/{task_id}/`` before the contract_id is
known (it comes from approval extraction). On confirm, the directory is promoted
to ``{storage}/{contract_id}/``. See design spec.
"""
from __future__ import annotations

import pathlib
import shutil

from contract_rag.config import load_config

_UPLOADS = "_uploads"


def _storage_root() -> pathlib.Path:
    return load_config().paths.storage_dir


def upload_dir(task_id: str) -> pathlib.Path:
    return _storage_root() / _UPLOADS / task_id


def contract_dir(contract_id: str) -> pathlib.Path:
    return _storage_root() / contract_id


def signed_pdf(base: pathlib.Path) -> pathlib.Path:
    return base / "signed.pdf"


def pages_dir(base: pathlib.Path) -> pathlib.Path:
    return base / "pages"


def page_png(base: pathlib.Path, page_no: int) -> pathlib.Path:
    """Path to a 1-indexed page PNG. Rejects non-positive indices (traversal guard)."""
    if not isinstance(page_no, int) or page_no < 1:
        raise ValueError(f"invalid page_no: {page_no!r}")
    return pages_dir(base) / f"{page_no}.png"


def promote_upload(task_id: str, contract_id: str) -> pathlib.Path:
    """Move the upload dir to the contract dir, replacing any existing one."""
    src = upload_dir(task_id)
    dst = contract_dir(contract_id)
    if dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return dst


def remove_contract_dir(contract_id: str) -> None:
    d = contract_dir(contract_id)
    if d.exists():
        shutil.rmtree(d)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_storage_paths.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/storage_paths.py tests/api/test_storage_paths.py
git commit -m "feat: upload/contract storage paths + promote"
```

---

### Task 4: Pure projections

**Files:**
- Create: `contract_rag/api/projections.py`
- Test: `tests/api/test_projections.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_projections.py`:

```python
from datetime import date
from contract_rag.api import projections as pj


def test_derive_status():
    today = date(2026, 6, 3)
    assert pj.derive_status(None, None, today) == "pending"
    assert pj.derive_status("2026-01-01", None, today) == "pending"
    assert pj.derive_status("2026-01-01", "2026-05-01", today) == "expired"
    assert pj.derive_status("2026-01-01", "2027-01-01", today) == "active"


def test_format_size():
    assert pj.format_size(8_598_323) == "8.2 MB"
    assert pj.format_size(None) == "—"


def test_format_ts():
    assert pj.format_ts("2026-04-12T09:22:05+00:00") == "2026-04-12 09:22"
    assert pj.format_ts(None) == ""


def test_to_contract_row_derives_fields():
    today = date(2026, 6, 3)
    contract = {
        "contract_id": "JSUS2026004", "counterparty": "OC", "amount": 147664.05,
        "currency": "USD", "project_name": "UD", "contract_type": "Supply",
        "petitioner": "王立", "petition_date": "2026-04-12", "file_no": "2026004",
        "effective_date": "2026-04-15", "expiration_date": "2027-04-14",
        "department": "UD", "brief_description": "x", "status": "active",
        "page_count": 14, "created_at": "2026-04-12T09:22:00+00:00",
    }
    row = pj.to_contract_row(contract, signed_pdf_size=8_598_323, today=today)
    assert row["file_name"] == "2026004-JSUS2026004-UD"
    assert row["pages"] == 14
    assert row["size"] == "8.2 MB"
    assert row["archived_at"] == "2026-04-12 09:22"
    assert row["status"] == "active"


def test_to_conflict_fields_adds_owner_and_suggested():
    conflicts = [
        {"field": "counterparty", "baseline": "A", "system": "A", "excel": "B"},
        {"field": "effective_date", "baseline": "（空）", "system": "（空）", "excel": "2026-03-15"},
    ]
    out = pj.to_conflict_fields(conflicts)
    by = {c["field"]: c for c in out}
    assert by["counterparty"]["owner"] == "system"
    assert by["counterparty"]["suggested"] == "system"
    assert by["effective_date"]["owner"] == "human"
    assert by["effective_date"]["suggested"] == "excel"


def test_to_config_state():
    rules = {"default": {"prefix": ""}, "chinabuy": {"prefix": "CN"}}
    cfg = pj.to_config_state(excel_enabled=False, file_no_rules=rules, year=2026)
    assert cfg["excelEnabled"] is False
    assert cfg["ragEnabled"] is False
    examples = {r["category"]: r["example"] for r in cfg["fileNoRules"]}
    assert examples["default"] == "2026001"
    assert examples["chinabuy"] == "CN2026001"


def test_apply_contract_query_filters_and_sorts():
    today = date(2026, 6, 3)
    rows = [
        {"contract_id": "A", "counterparty": "Foo", "project_name": "p", "amount": 10,
         "department": "UD", "petition_date": "2026-01-01", "effective_date": "2026-01-01",
         "expiration_date": "2027-01-01", "status": "active"},
        {"contract_id": "B", "counterparty": "Bar", "project_name": "p", "amount": 50,
         "department": "PD", "petition_date": "2025-01-01", "effective_date": "2025-01-01",
         "expiration_date": "2027-01-01", "status": "active"},
    ]
    out = pj.apply_contract_query(rows, q="foo", department="all", status="all", year="all", sort=None, today=today)
    assert [r["contract_id"] for r in out] == ["A"]
    out2 = pj.apply_contract_query(rows, q=None, department="all", status="all", year="2025", sort="amount_desc", today=today)
    assert [r["contract_id"] for r in out2] == ["B"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_projections.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement projections**

Create `contract_rag/api/projections.py`:

```python
"""Pure mappers from SQLite rows to the frontend's types.ts shapes.

No I/O. Every function takes plain dicts and returns plain dicts/lists so it is
trivially unit-tested. See frontend/src/api/types.ts for the target shapes.
"""
from __future__ import annotations

from datetime import date, datetime

from contract_rag.sync import compose_file_name
from contract_rag.sync.file_no import format_file_no
from contract_rag.sync.models import HUMAN_FIELDS, SYSTEM_FIELDS

# Fields copied straight from the contracts row onto ContractRow.
_DIRECT = (
    "contract_id", "counterparty", "amount", "currency", "project_name",
    "contract_type", "petitioner", "petition_date", "file_no",
    "effective_date", "expiration_date", "department", "brief_description",
)


def derive_status(effective_date, expiration_date, today: date) -> str:
    """active / expired / pending (see design spec status rule)."""
    if not effective_date or not expiration_date:
        return "pending"
    try:
        exp = date.fromisoformat(str(expiration_date)[:10])
    except ValueError:
        return "active"
    return "expired" if exp < today else "active"


def format_size(num_bytes) -> str:
    if not num_bytes:
        return "—"
    return f"{num_bytes / 1024 / 1024:.1f} MB"


def format_ts(iso) -> str:
    if not iso:
        return ""
    try:
        return datetime.fromisoformat(str(iso)).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(iso)


def to_contract_row(contract: dict, *, signed_pdf_size, today: date) -> dict:
    row = {k: contract.get(k) for k in _DIRECT}
    row["amount"] = contract.get("amount") or 0
    row["currency"] = contract.get("currency") or ""
    row["file_name"] = compose_file_name(
        contract.get("file_no"), contract.get("contract_id"), contract.get("project_name")
    ) or ""
    row["pages"] = contract.get("page_count") or 0
    row["size"] = format_size(signed_pdf_size)
    row["archived_at"] = format_ts(contract.get("created_at"))
    row["status"] = derive_status(
        contract.get("effective_date"), contract.get("expiration_date"), today
    )
    # Frontend expects strings for these; coalesce null-ish to "".
    for k in ("counterparty", "project_name", "contract_type", "petitioner",
              "petition_date", "file_no", "department", "brief_description"):
        row[k] = row.get(k) or ""
    return row


def to_conflict_fields(conflicts: list[dict]) -> list[dict]:
    out = []
    for c in conflicts:
        owner = "human" if c["field"] in HUMAN_FIELDS else "system"
        # suggest the side that diverged from baseline; default to system.
        suggested = "system"
        if owner == "human" and c.get("excel") != c.get("baseline"):
            suggested = "excel"
        out.append({**c, "owner": owner, "suggested": suggested})
    return out


def to_config_state(*, excel_enabled: bool, file_no_rules: dict, year: int) -> dict:
    rules = [
        {
            "category": category,
            "prefix": (rule or {}).get("prefix", ""),
            "example": format_file_no(year, 1, category, file_no_rules),
        }
        for category, rule in file_no_rules.items()
    ]
    return {
        "ragEnabled": False,
        "excelEnabled": bool(excel_enabled),
        "backupEnabled": True,
        "lockCheckEnabled": True,
        "fileNoRules": rules,
    }


def to_processing_row(*, contract: dict, task: dict | None, sync_status: dict | None) -> dict:
    ingest = {
        "stage": (task or {}).get("stage", "done"),
        "status": (task or {}).get("status", "done"),
    }
    if (task or {}).get("error_message"):
        ingest["last_error"] = task["error_message"]
    sync = {
        "state": (sync_status or {}).get("state", "disabled"),
        "attempts": (sync_status or {}).get("attempts", 0),
        "updated_at": format_ts((sync_status or {}).get("updated_at")),
    }
    for k in ("last_error", "last_attempt_at"):
        if (sync_status or {}).get(k):
            sync[k] = sync_status[k]
    return {
        "contract_id": contract["contract_id"],
        "counterparty": contract.get("counterparty") or "",
        "ingest": ingest,
        "sync": sync,
        "updated_at": format_ts((sync_status or {}).get("updated_at") or contract.get("updated_at")),
    }


def apply_contract_query(rows, *, q, department, status, year, sort, today: date) -> list:
    """Mirror frontend applyContractQuery (filter by q/dept/status/year, sort)."""
    result = list(rows)
    if q:
        term = q.strip().lower()
        result = [
            r for r in result
            if any(term in str(r.get(k, "")).lower()
                   for k in ("contract_id", "counterparty", "project_name"))
        ]
    if department and department != "all":
        result = [r for r in result if r.get("department") == department]
    if status and status != "all":
        result = [
            r for r in result
            if derive_status(r.get("effective_date"), r.get("expiration_date"), today) == status
        ]
    if year and year != "all":
        result = [r for r in result if str(r.get("petition_date", "")).startswith(year)]
    if sort == "amount_desc":
        result.sort(key=lambda r: r.get("amount") or 0, reverse=True)
    elif sort == "amount_asc":
        result.sort(key=lambda r: r.get("amount") or 0)
    elif sort == "date_desc":
        result.sort(key=lambda r: str(r.get("petition_date", "")), reverse=True)
    return result
```

Note: `apply_contract_query` takes keyword args; the test calls them positionally for `rows` only and the rest by keyword — update the test calls to keyword (already keyword in Step 1).

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_projections.py -v`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/projections.py tests/api/test_projections.py
git commit -m "feat: pure projections DB rows -> frontend shapes"
```

---

## Phase B — Backend endpoints

### Task 5: Schemas + app factory

**Files:**
- Create: `contract_rag/api/schemas.py`, `contract_rag/api/app.py`
- Test: `tests/api/test_app.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_app.py`:

```python
from fastapi.testclient import TestClient
from contract_rag.api.app import create_app


def test_health_ok():
    client = TestClient(create_app())
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_app.py -v`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement schemas + app**

Create `contract_rag/api/schemas.py`:

```python
"""Pydantic request models (input validation at the HTTP boundary)."""
from __future__ import annotations

from pydantic import BaseModel


class ExtractRequest(BaseModel):
    approval_page: int


class ConfirmRequest(BaseModel):
    values: dict[str, object]
    effective_date: str | None = None
    expiration_date: str | None = None
    category: str = "default"
    overwrite: bool = False


class ResolveRequest(BaseModel):
    resolutions: dict[str, object]
```

Create `contract_rag/api/app.py`:

```python
"""FastAPI application factory for the V1 upload backend."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from contract_rag.api.routes import conflicts, config, contracts, processing, uploads
from contract_rag.storage import db


def create_app() -> FastAPI:
    app = FastAPI(title="Contract-RAG V1 API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.on_event("startup")
    def _init() -> None:
        db.init_db()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    for module in (uploads, contracts, processing, conflicts, config):
        app.include_router(module.router, prefix="/api")
    return app


app = create_app()
```

Note: routes modules don't exist yet — this step's test will still fail to import until Tasks 6–9 add them. To keep Task 5 self-contained, temporarily comment the `for module ...` loop and the import line, run the health test green, then re-enable in Task 10. (Simpler: create empty router stubs now — see Step 4.)

- [ ] **Step 4: Create empty router stubs so the app imports**

Create each of these with just a router (filled in later tasks):

`contract_rag/api/routes/__init__.py` (empty).

`contract_rag/api/routes/uploads.py`, `contracts.py`, `processing.py`, `conflicts.py`, `config.py`, each starting with:

```python
from fastapi import APIRouter

router = APIRouter()
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv run pytest tests/api/test_app.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add contract_rag/api/schemas.py contract_rag/api/app.py contract_rag/api/routes/ tests/api/test_app.py
git commit -m "feat: FastAPI app factory + schemas + router stubs"
```

---

### Task 6: Upload flow routes

**Files:**
- Modify: `contract_rag/api/routes/uploads.py`
- Test: `tests/api/test_uploads.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_uploads.py`:

```python
import fitz
import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.api.routes import uploads
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    return TestClient(create_app())


def _pdf_bytes(n_pages=3):
    doc = fitz.open()
    for _ in range(n_pages):
        doc.new_page(width=300, height=400)
    data = doc.tobytes()
    doc.close()
    return data


def test_upload_extract_confirm_flow(client, monkeypatch):
    # stub the LLM extraction (external I/O boundary)
    monkeypatch.setattr(
        uploads, "extract_approval",
        lambda pdf, page_no, **kw: {
            "contract_number": "JSUS2026099", "counterparty": "OC", "amount": 100.0,
            "currency": "USD", "project_name": "P", "department": "UD",
            "petitioner": "王立", "petition_date": "2026-04-12", "contract_type": "Supply",
            "_per_field_confidence": {"project_name": 0.6},
        },
    )

    # 1. upload (BackgroundTasks run synchronously under TestClient)
    resp = client.post("/api/uploads", files={"file": ("c.pdf", _pdf_bytes(3), "application/pdf")})
    assert resp.status_code == 200
    task_id = resp.json()["task_id"]
    assert resp.json()["page_count"] == 3

    # poll -> tagging (thumbnails rendered)
    status = client.get(f"/api/uploads/{task_id}").json()
    assert status["stage"] == "tagging"

    # thumbnail served
    assert client.get(f"/api/uploads/{task_id}/pages/1").status_code == 200

    # 2. extract
    client.post(f"/api/uploads/{task_id}/extract", json={"approval_page": 1})
    status = client.get(f"/api/uploads/{task_id}").json()
    assert status["stage"] == "awaiting_user_confirmation"
    assert status["fields"]["contract_id_guess"] == "JSUS2026099"
    assert status["fields"]["per_field_confidence"]["project_name"] == 0.6

    # 3. confirm
    resp = client.post(f"/api/uploads/{task_id}/confirm", json={
        "values": {"contract_id": "JSUS2026099", "counterparty": "OC", "amount": 100.0,
                   "currency": "USD", "project_name": "P", "department": "UD",
                   "petitioner": "王立", "petition_date": "2026-04-12", "contract_type": "Supply"},
        "effective_date": "2026-04-15", "expiration_date": "2027-04-14",
        "category": "default",
    })
    assert resp.status_code == 200
    assert resp.json()["contract_id"] == "JSUS2026099"
    assert resp.json()["file_no"] == "2026001"
    assert db.get_contract("JSUS2026099", db_path=client_dbpath(client)).get("page_count") == 3


def test_confirm_duplicate_returns_409_then_overwrite(client, monkeypatch):
    db.upsert_contract("JSUS2026099", status="active")
    monkeypatch.setattr(uploads, "extract_approval",
                        lambda pdf, page_no, **kw: {"contract_number": "JSUS2026099"})
    task_id = client.post("/api/uploads", files={"file": ("c.pdf", _pdf_bytes(1), "application/pdf")}).json()["task_id"]
    client.post(f"/api/uploads/{task_id}/extract", json={"approval_page": 1})
    body = {"values": {"contract_id": "JSUS2026099"}, "effective_date": "2026-04-15",
            "expiration_date": "2027-04-14", "category": "default"}
    assert client.post(f"/api/uploads/{task_id}/confirm", json=body).status_code == 409
    body["overwrite"] = True
    assert client.post(f"/api/uploads/{task_id}/confirm", json=body).status_code == 200


def client_dbpath(client):
    from contract_rag.storage import db as _db
    return _db._db_path()


def test_upload_rejects_non_pdf(client):
    resp = client.post("/api/uploads", files={"file": ("c.txt", b"hello", "text/plain")})
    assert resp.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_uploads.py -v`
Expected: FAIL (routes empty).

- [ ] **Step 3: Implement uploads routes**

Replace `contract_rag/api/routes/uploads.py`:

```python
"""Upload-wizard flow: upload -> render -> tag approval page -> extract -> confirm.

Async task + poll (decision 7); slow steps run in BackgroundTasks. Pure-archive
V1: no body parsing. See design spec.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile
from fastapi.responses import FileResponse

from contract_rag.api import projections, rendering
from contract_rag.api import storage_paths as sp
from contract_rag.api.schemas import ConfirmRequest, ExtractRequest
from contract_rag.ingest.approval import extract_approval
from contract_rag.ingest.approval_store import persist_approval, resolve_contract_id
from contract_rag.storage import db
from contract_rag import sync

router = APIRouter()

MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _render_task(task_id: str, pdf_path) -> None:
    try:
        rendering.render_thumbnails(pdf_path, sp.pages_dir(sp.upload_dir(task_id)))
        db.update_task_stage(task_id, "tagging")
    except Exception as e:  # noqa: BLE001
        db.update_task_stage(task_id, "failed", status="failed", error_message=str(e))


def _extract_task(task_id: str, pdf_path, page_no: int) -> None:
    try:
        fields = extract_approval(pdf_path, page_no)
        db.set_task_extraction(task_id, approval_page=page_no, extraction=fields)
        db.update_task_stage(task_id, "awaiting_user_confirmation")
    except Exception as e:  # noqa: BLE001
        db.update_task_stage(task_id, "failed", status="failed", error_message=str(e))


@router.post("/uploads")
async def create_upload(file: UploadFile, background: BackgroundTasks) -> dict:
    name = (file.filename or "").lower()
    if not name.endswith(".pdf") and file.content_type != "application/pdf":
        raise HTTPException(status_code=400, detail="仅支持 PDF")
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="文件过大（上限 50MB）")

    task_id = db.create_task()
    udir = sp.upload_dir(task_id)
    udir.mkdir(parents=True, exist_ok=True)
    pdf_path = sp.signed_pdf(udir)
    pdf_path.write_bytes(data)
    try:
        n = rendering.page_count(pdf_path)
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="无法读取 PDF")

    background.add_task(_render_task, task_id, pdf_path)
    return {"task_id": task_id, "page_count": n, "filename": file.filename}


@router.get("/uploads/{task_id}")
def get_upload(task_id: str) -> dict:
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    out = {
        "task_id": task_id,
        "stage": task["stage"],
        "status": task["status"],
        "error": task.get("error_message"),
    }
    udir = sp.upload_dir(task_id)
    pdf = sp.signed_pdf(udir)
    out["page_count"] = rendering.page_count(pdf) if pdf.exists() else None
    if task["stage"] == "awaiting_user_confirmation" and task.get("extraction"):
        import json
        fields = json.loads(task["extraction"])
        out["fields"] = {
            "contract_id_guess": resolve_contract_id(fields),
            "values": fields,
            "per_field_confidence": fields.get("_per_field_confidence", {}),
            "per_field_source_span": fields.get("_per_field_source_span", {}),
        }
    return out


@router.get("/uploads/{task_id}/pages/{page_no}")
def get_upload_page(task_id: str, page_no: int) -> FileResponse:
    try:
        path = sp.page_png(sp.upload_dir(task_id), page_no)
    except ValueError:
        raise HTTPException(status_code=400, detail="bad page")
    if not path.exists():
        raise HTTPException(status_code=404, detail="page not found")
    return FileResponse(str(path), media_type="image/png")


@router.post("/uploads/{task_id}/extract")
def start_extract(task_id: str, body: ExtractRequest, background: BackgroundTasks) -> dict:
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")
    pdf = sp.signed_pdf(sp.upload_dir(task_id))
    db.update_task_stage(task_id, "llm_extraction", status="running")
    background.add_task(_extract_task, task_id, pdf, body.approval_page)
    return {"task_id": task_id, "stage": "llm_extraction"}


@router.post("/uploads/{task_id}/confirm")
def confirm_upload(task_id: str, body: ConfirmRequest) -> dict:
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="task not found")

    values = dict(body.values)
    contract_id = resolve_contract_id(values)
    if not contract_id:
        raise HTTPException(status_code=400, detail="缺少合同编号")

    if db.contract_exists(contract_id) and not body.overwrite:
        raise HTTPException(status_code=409, detail={"conflict": "duplicate", "contract_id": contract_id})

    if db.contract_exists(contract_id) and body.overwrite:
        db.delete_contract(contract_id)
        sp.remove_contract_dir(contract_id)

    pdf = sp.signed_pdf(sp.upload_dir(task_id))
    page_count = rendering.page_count(pdf) if pdf.exists() else None

    persist_approval(values, fallback_id=contract_id)
    db.upsert_contract(
        contract_id,
        status="active",
        effective_date=body.effective_date,
        expiration_date=body.expiration_date,
        page_count=page_count,
    )
    file_no = sync.assign_file_no(contract_id, category=body.category)

    sp.promote_upload(task_id, contract_id)
    db.update_task_stage(task_id, "done", status="done", contract_id=contract_id)
    sync.sync_contract(contract_id)

    contract = db.get_contract(contract_id)
    size = pdf.stat().st_size if (pdf := sp.signed_pdf(sp.contract_dir(contract_id))).exists() else None
    return projections.to_contract_row(contract, signed_pdf_size=size, today=date.today())
```

Note: `persist_approval` writes the system-extracted fields; the subsequent `upsert_contract` overrides the user-confirmed `effective/expiration/page_count`. If the user edited a system field in `values`, `persist_approval` already used the edited value (it reads from `values`). `assign_file_no` persists `file_no` onto the row before projection reads it.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_uploads.py -v`
Expected: PASS (3 tests). If `extract_approval` import binding can't be monkeypatched, patch `contract_rag.api.routes.uploads.extract_approval` (the test already targets the `uploads` module attribute).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/routes/uploads.py tests/api/test_uploads.py
git commit -m "feat: upload flow routes (upload/poll/thumb/extract/confirm)"
```

---

### Task 7: Contracts routes (list / detail / export / download)

**Files:**
- Modify: `contract_rag/api/routes/contracts.py`
- Test: `tests/api/test_contracts.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_contracts.py`:

```python
import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    db.upsert_contract("JSUS2026004", status="active", counterparty="OC", amount=100.0,
                       currency="USD", project_name="UD", department="UD",
                       petition_date="2026-04-12", effective_date="2026-04-15",
                       expiration_date="2027-04-14", file_no="2026004", page_count=14)
    return TestClient(create_app())


def test_list_contracts(client):
    resp = client.get("/api/contracts")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["data"][0]["file_name"] == "2026004-JSUS2026004-UD"


def test_list_contracts_search(client):
    assert client.get("/api/contracts?q=oc").json()["total"] == 1
    assert client.get("/api/contracts?q=zzz").json()["total"] == 0


def test_get_contract(client):
    resp = client.get("/api/contracts/JSUS2026004")
    assert resp.status_code == 200
    assert resp.json()["pages"] == 14


def test_get_contract_404(client):
    assert client.get("/api/contracts/NOPE").status_code == 404


def test_export_returns_xlsx(client):
    resp = client.get("/api/contracts/export")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_contracts.py -v`
Expected: FAIL (routes empty).

- [ ] **Step 3: Implement contracts routes**

Replace `contract_rag/api/routes/contracts.py`:

```python
"""Ledger read endpoints + Excel export + signed.pdf download."""
from __future__ import annotations

import io
from datetime import date

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response

from contract_rag.api import projections
from contract_rag.api import storage_paths as sp
from contract_rag.storage import db

router = APIRouter()

_EXPORT_HEADERS = [
    "合同编号", "对方公司", "项目名称", "金额", "币种", "部门", "申请人",
    "登记日期", "生效日", "到期日", "存档编号", "文件名", "状态",
]


def _signed_size(contract_id: str):
    pdf = sp.signed_pdf(sp.contract_dir(contract_id))
    return pdf.stat().st_size if pdf.exists() else None


def _row(contract: dict) -> dict:
    return projections.to_contract_row(
        contract, signed_pdf_size=_signed_size(contract["contract_id"]), today=date.today()
    )


@router.get("/contracts")
def list_contracts(q: str | None = None, department: str | None = None,
                   status: str | None = None, year: str | None = None,
                   sort: str | None = None) -> dict:
    rows = db.list_contracts()
    filtered = projections.apply_contract_query(
        rows, q=q, department=department, status=status, year=year, sort=sort, today=date.today()
    )
    data = [_row(c) for c in filtered]
    return {"data": data, "total": len(data)}


@router.get("/contracts/export")
def export_contracts(q: str | None = None, department: str | None = None,
                     status: str | None = None, year: str | None = None,
                     sort: str | None = None) -> Response:
    from openpyxl import Workbook

    rows = db.list_contracts()
    filtered = projections.apply_contract_query(
        rows, q=q, department=department, status=status, year=year, sort=sort, today=date.today()
    )
    wb = Workbook()
    ws = wb.active
    ws.append(_EXPORT_HEADERS)
    for c in filtered:
        r = _row(c)
        ws.append([
            r["contract_id"], r["counterparty"], r["project_name"], r["amount"], r["currency"],
            r["department"], r["petitioner"], r["petition_date"], r["effective_date"] or "",
            r["expiration_date"] or "", r["file_no"], r["file_name"], r["status"],
        ])
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="contract-ledger.xlsx"'},
    )


@router.get("/contracts/{contract_id}")
def get_contract(contract_id: str) -> dict:
    contract = db.get_contract(contract_id)
    if contract is None:
        raise HTTPException(status_code=404, detail="contract not found")
    return _row(contract)


@router.get("/contracts/{contract_id}/file")
def download_contract(contract_id: str) -> FileResponse:
    pdf = sp.signed_pdf(sp.contract_dir(contract_id))
    if not pdf.exists():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(pdf), media_type="application/pdf", filename=f"{contract_id}.pdf")
```

Note: `/contracts/export` is declared **before** `/contracts/{contract_id}` so "export" is not captured as a contract_id.

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_contracts.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/routes/contracts.py tests/api/test_contracts.py
git commit -m "feat: contracts read/export/download routes"
```

---

### Task 8: Processing + conflicts routes

**Files:**
- Modify: `contract_rag/api/routes/processing.py`, `contract_rag/api/routes/conflicts.py`
- Test: `tests/api/test_processing_conflicts.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_processing_conflicts.py`:

```python
import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.storage import db
from contract_rag.sync import state


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    db.upsert_contract("C1", status="active", counterparty="OC")
    tid = db.create_task(contract_id="C1")
    db.update_task_stage(tid, "done", status="done")
    state.upsert("C1", state="conflict", conflicts=[
        {"field": "counterparty", "baseline": "A", "system": "A", "excel": "B"},
    ], db_path=dbp)
    return TestClient(create_app())


def test_processing_lists_rows(client):
    rows = client.get("/api/processing").json()
    assert rows[0]["contract_id"] == "C1"
    assert rows[0]["ingest"]["status"] == "done"
    assert rows[0]["sync"]["state"] == "conflict"


def test_conflict_has_owner_and_suggested(client):
    fields = client.get("/api/contracts/C1/conflict").json()
    assert fields[0]["owner"] == "system"
    assert fields[0]["suggested"] == "system"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_processing_conflicts.py -v`
Expected: FAIL (routes empty).

- [ ] **Step 3: Implement processing + conflicts routes**

Replace `contract_rag/api/routes/processing.py`:

```python
"""Processing page: per-contract ingest (tasks) + Excel sync state."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from contract_rag.api import projections
from contract_rag.storage import db
from contract_rag import sync

router = APIRouter()


def _latest_task_for(contract_id: str) -> dict | None:
    with db.connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE contract_id = ? ORDER BY updated_at DESC LIMIT 1",
            (contract_id,),
        ).fetchone()
    return dict(row) if row else None


@router.get("/processing")
def list_processing() -> list[dict]:
    out = []
    for status in sync.list_statuses():  # newest first
        cid = status["contract_id"]
        contract = db.get_contract(cid)
        if contract is None:
            continue
        out.append(projections.to_processing_row(
            contract=contract, task=_latest_task_for(cid), sync_status=status
        ))
    return out


@router.post("/contracts/{contract_id}/sync/retry")
def retry_sync(contract_id: str) -> dict:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    result = sync.sync_contract(contract_id)
    return {"contract_id": contract_id, "state": result.state}
```

Replace `contract_rag/api/routes/conflicts.py`:

```python
"""Conflict merge page: three-way view + resolution."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from contract_rag.api import projections
from contract_rag.api.schemas import ResolveRequest
from contract_rag.storage import db
from contract_rag import sync

router = APIRouter()


@router.get("/contracts/{contract_id}/conflict")
def get_conflict(contract_id: str) -> list[dict]:
    return projections.to_conflict_fields(sync.get_conflict(contract_id))


@router.post("/contracts/{contract_id}/resolve")
def resolve(contract_id: str, body: ResolveRequest) -> dict:
    if db.get_contract(contract_id) is None:
        raise HTTPException(status_code=404, detail="contract not found")
    result = sync.resolve_conflict(contract_id, body.resolutions)
    return {"contract_id": contract_id, "state": result.state}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_processing_conflicts.py -v`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add contract_rag/api/routes/processing.py contract_rag/api/routes/conflicts.py tests/api/test_processing_conflicts.py
git commit -m "feat: processing + conflict routes"
```

---

### Task 9: Config route

**Files:**
- Modify: `contract_rag/api/routes/config.py`
- Test: `tests/api/test_config.py`

- [ ] **Step 1: Write the failing test**

Create `tests/api/test_config.py`:

```python
import pytest
from fastapi.testclient import TestClient

from contract_rag.api import storage_paths as sp
from contract_rag.api.app import create_app
from contract_rag.storage import db


@pytest.fixture
def client(tmp_path, monkeypatch):
    dbp = tmp_path / "t.db"
    monkeypatch.setattr(db, "_db_path", lambda: dbp)
    monkeypatch.setattr(sp, "_storage_root", lambda: tmp_path / "storage")
    db.init_db(dbp)
    return TestClient(create_app())


def test_config_shape(client):
    cfg = client.get("/api/config").json()
    assert cfg["ragEnabled"] is False
    assert "excelEnabled" in cfg
    assert isinstance(cfg["fileNoRules"], list)
    assert {"category", "prefix", "example"} <= set(cfg["fileNoRules"][0].keys())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/api/test_config.py -v`
Expected: FAIL (route empty).

- [ ] **Step 3: Implement config route**

Replace `contract_rag/api/routes/config.py`:

```python
"""Runtime config read for the settings page (read-only in V1)."""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter

from contract_rag.api import projections
from contract_rag.config import load_config
from contract_rag.sync import get_file_no_rules

router = APIRouter()


@router.get("/config")
def get_config() -> dict:
    cfg = load_config()
    return projections.to_config_state(
        excel_enabled=cfg.excel.enabled,
        file_no_rules=get_file_no_rules(),
        year=date.today().year,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/api/test_config.py -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite + commit**

Run: `uv run pytest tests/api/ -v`
Expected: all PASS.

```bash
git add contract_rag/api/routes/config.py tests/api/test_config.py
git commit -m "feat: config read route"
```

---

## Phase C — Frontend rewire

### Task 10: Upload API types + client + hooks

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/api/client.ts`
- Modify: `frontend/src/api/hooks.ts`

- [ ] **Step 1: Add upload types**

Append to `frontend/src/api/types.ts`:

```typescript
export interface UploadResponse {
  task_id: string;
  page_count: number;
  filename: string;
}

export interface ExtractedFields {
  contract_id_guess: string | null;
  values: Record<string, unknown>;
  per_field_confidence: Record<string, number>;
  per_field_source_span: Record<string, string>;
}

export interface TaskStatus {
  task_id: string;
  stage: IngestStage;
  status: "running" | "done" | "failed";
  page_count: number | null;
  error?: string | null;
  fields?: ExtractedFields;
}

export interface ConfirmUploadPayload {
  taskId: string;
  values: Record<string, unknown>;
  effective_date: string;
  expiration_date: string;
  category: string;
  overwrite?: boolean;
}
```

- [ ] **Step 2: Add client functions**

Append to `frontend/src/api/client.ts` (after `getConfig`):

```typescript
import type { ConfirmUploadPayload, TaskStatus, UploadResponse } from "./types";

export async function uploadPdf(file: File): Promise<UploadResponse> {
  const form = new FormData();
  form.append("file", file);
  const response = await fetch(`${API_BASE}/uploads`, { method: "POST", body: form });
  if (!response.ok) throw new ApiError(`POST /uploads failed: ${response.status}`, response.status, await response.text());
  return response.json() as Promise<UploadResponse>;
}

export async function getUploadStatus(taskId: string): Promise<TaskStatus> {
  return getJson<TaskStatus>(`/uploads/${encodeURIComponent(taskId)}`);
}

export function uploadPageUrl(taskId: string, pageNo: number): string {
  return `${API_BASE}/uploads/${encodeURIComponent(taskId)}/pages/${pageNo}`;
}

export async function startExtract(taskId: string, approvalPage: number): Promise<void> {
  await postJson(`/uploads/${encodeURIComponent(taskId)}/extract`, { approval_page: approvalPage });
}

export async function confirmUpload(payload: ConfirmUploadPayload): Promise<ContractRow> {
  const { taskId, ...body } = payload;
  const response = await fetch(`${API_BASE}/uploads/${encodeURIComponent(taskId)}/confirm`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status === 409) throw new ApiError("duplicate", 409, await response.text());
  if (!response.ok) throw new ApiError(`confirm failed: ${response.status}`, response.status, await response.text());
  return response.json() as Promise<ContractRow>;
}
```

(Add `ContractRow` to the existing top-of-file type import if not already present.)

- [ ] **Step 3: Add hooks**

Append to `frontend/src/api/hooks.ts`:

```typescript
import { confirmUpload, getUploadStatus, startExtract, uploadPdf } from "./client";
import type { ConfirmUploadPayload } from "./types";

export function useUploadPdf() {
  return useMutation({ mutationFn: uploadPdf });
}

export function useUploadStatus(taskId: string | undefined, active: boolean) {
  return useQuery({
    queryKey: ["upload", taskId],
    queryFn: () => getUploadStatus(taskId ?? ""),
    enabled: Boolean(taskId) && active,
    refetchInterval: (query) => {
      const stage = (query.state.data as { stage?: string } | undefined)?.stage;
      return stage === "tagging" || stage === "awaiting_user_confirmation" || stage === "failed" ? false : 1000;
    }
  });
}

export function useStartExtract() {
  return useMutation({ mutationFn: ({ taskId, page }: { taskId: string; page: number }) => startExtract(taskId, page) });
}

export function useConfirmUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: ConfirmUploadPayload) => confirmUpload(payload),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contracts"] })
  });
}
```

- [ ] **Step 4: Verify it typechecks**

Run: `cd frontend && npm run build`
Expected: build succeeds (or fails only in UploadPage until Task 11). If only UploadPage errors, proceed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts frontend/src/api/hooks.ts
git commit -m "feat(fe): upload flow api client + hooks + types"
```

---

### Task 11: Rewire UploadPage to real API

**Files:**
- Modify: `frontend/src/features/upload/UploadPage.tsx`
- Delete: `frontend/src/features/upload/FieldConfirmPage.tsx`
- Modify: `frontend/src/App.tsx` (remove the standalone `/confirm` route + its import, if present)
- Test: `frontend/src/__tests__/upload.test.tsx`

- [ ] **Step 1: Write a failing smoke test**

Create `frontend/src/__tests__/upload.test.tsx`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { UploadPage } from "../features/upload/UploadPage";
import * as client from "../api/client";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><UploadPage /></MemoryRouter>
    </QueryClientProvider>
  );
}

describe("UploadPage", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("uploads a PDF and advances to approval-page tagging", async () => {
    vi.spyOn(client, "uploadPdf").mockResolvedValue({ task_id: "T1", page_count: 3, filename: "c.pdf" });
    vi.spyOn(client, "getUploadStatus").mockResolvedValue({
      task_id: "T1", stage: "tagging", status: "running", page_count: 3
    });
    vi.spyOn(client, "uploadPageUrl").mockReturnValue("/api/uploads/T1/pages/1");

    renderPage();
    const file = new File([new Uint8Array([1, 2, 3])], "c.pdf", { type: "application/pdf" });
    const input = screen.getByLabelText("选择 PDF 文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(client.uploadPdf).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npm test -- --run upload.test.tsx`
Expected: FAIL (UploadPage still mock; `uploadPdf` not called).

- [ ] **Step 3: Rewire UploadPage**

Rewrite `frontend/src/features/upload/UploadPage.tsx` so that:

1. **Step 1 (upload):** on file select, call `useUploadPdf().mutateAsync(file)`; store `task_id` + `page_count`; then enable polling via `useUploadStatus(taskId, active)`. Keep the existing PDF/size validation (≤50MB, `.pdf`). Show progress while the mutation is pending. Advance to step 2 when status `stage === "tagging"`.
2. **Step 2 (tag approval page):** render the thumbnail grid using real images — `pages` count from `page_count`, each thumbnail `<img src={uploadPageUrl(taskId, page)} />`. On "下一步：抽取字段", call `useStartExtract().mutateAsync({ taskId, page: approvalPage })`, then poll until `stage === "awaiting_user_confirmation"`, then go to step 3.
3. **Step 3 (confirm):** populate `confirmFields` from `status.fields.values`; for each field with `status.fields.per_field_confidence[key] < 0.85`, add the `low-confidence` class. Category `<select>` options come from `useConfig().data.fileNoRules` (map `category`→label; send `category` value). On "确认入账", call `useConfirmUpload().mutateAsync({ taskId, values, effective_date, expiration_date, category, overwrite })`. On `ApiError` status 409, show an overwrite `ConfirmModal`; on confirm, retry with `overwrite: true`. On success, `toast.success` + `navigate(/contracts/${contract_id})`.

Concrete implementation (replace the file body; preserves the existing `StepBar`, `UploadStep`, and CSS class names):

```tsx
import { type ChangeEvent, type DragEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, FileText, UploadCloud } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Panel";
import { useToast } from "../../components/ui/Toast";
import { ApiError, uploadPageUrl } from "../../api/client";
import { useConfig, useConfirmUpload, useStartExtract, useUploadPdf, useUploadStatus } from "../../api/hooks";

const maxUploadSizeMb = 50;
const LOW_CONFIDENCE = 0.85;

const confirmFieldMeta: Array<{ key: string; label: string; required?: boolean }> = [
  { key: "contract_id", label: "合同编号", required: true },
  { key: "amount", label: "合同金额", required: true },
  { key: "counterparty", label: "对方公司" },
  { key: "project_name", label: "项目名称" },
  { key: "department", label: "申请部门" },
  { key: "petitioner", label: "申请人" }
];

export function UploadPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [taskId, setTaskId] = useState<string>();
  const [pageCount, setPageCount] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const [approvalPage, setApprovalPage] = useState(1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confidence, setConfidence] = useState<Record<string, number>>({});
  const [dates, setDates] = useState({ effective_date: "", expiration_date: "" });
  const [category, setCategory] = useState("default");
  const [showOverwrite, setShowOverwrite] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();

  const uploadMutation = useUploadPdf();
  const extractMutation = useStartExtract();
  const confirmMutation = useConfirmUpload();
  const { data: config } = useConfig();
  const polling = Boolean(taskId) && (step === 1 || step === 2);
  const { data: status } = useUploadStatus(taskId, polling);

  // step 1 -> 2 when thumbnails ready
  useEffect(() => {
    if (step === 1 && status?.stage === "tagging") setStep(2);
  }, [status?.stage, step]);

  // step 2 -> 3 when extraction done; hydrate confirm form
  useEffect(() => {
    if (step === 2 && status?.stage === "awaiting_user_confirmation" && status.fields) {
      const v = status.fields.values as Record<string, unknown>;
      const next: Record<string, string> = {};
      confirmFieldMeta.forEach(({ key }) => { next[key] = v[key] != null ? String(v[key]) : ""; });
      if (status.fields.contract_id_guess) next.contract_id = status.fields.contract_id_guess;
      setValues(next);
      setConfidence(status.fields.per_field_confidence ?? {});
      setStep(3);
    }
  }, [status, step]);

  function selectUploadFile(file?: File) {
    if (!file) return;
    setUploadError("");
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("仅支持 PDF"); return;
    }
    if (file.size > maxUploadSizeMb * 1024 * 1024) {
      setUploadError(`文件过大（上限 ${maxUploadSizeMb}MB）`); return;
    }
    uploadMutation.mutate(file, {
      onSuccess: (res) => { setTaskId(res.task_id); setPageCount(res.page_count); },
      onError: () => setUploadError("上传失败，请重试")
    });
  }

  function goExtract() {
    if (!taskId) return;
    extractMutation.mutate({ taskId, page: approvalPage });
  }

  const canConfirm = Boolean(values.contract_id && values.amount && dates.effective_date && dates.expiration_date)
    && dates.expiration_date >= dates.effective_date;

  function doConfirm(overwrite = false) {
    if (!taskId || !canConfirm) return;
    confirmMutation.mutate(
      { taskId, values, ...dates, category, overwrite },
      {
        onSuccess: (row) => { toast.success(`已入账 ${row.contract_id}`); navigate(`/contracts/${row.contract_id}`); },
        onError: (err) => {
          if (err instanceof ApiError && err.status === 409) { setShowOverwrite(true); return; }
          toast.success("入账失败，请重试");
        }
      }
    );
  }

  return (
    <>
      <PageHeader title={step === 3 ? "确认登记字段" : "上传合同登记"} subtitle="上传 PDF → 指认审批页 → 确认字段 → 入账" />
      <div className="content-pad wizard-page">
        <StepBar current={step} />
        {step === 1 ? <UploadStep error={uploadError} isUploading={uploadMutation.isPending} onSelect={selectUploadFile} /> : null}
        {step === 2 ? (
          <Card className="upload-panel">
            <div className="upload-copy">
              <UploadCloud size={24} />
              <div><h2>点击标出审批页</h2><p>系统只从审批页抽取字段。其余页整份原样存档，纯录入模式下不解析正文。</p></div>
            </div>
            <div className="thumbnail-grid">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
                <button key={page} className={`thumbnail ${page === approvalPage ? "selected" : ""}`} onClick={() => setApprovalPage(page)}>
                  {page === approvalPage ? <span>审批页</span> : null}
                  {taskId ? <img src={uploadPageUrl(taskId, page)} alt={`第 ${page} 页`} /> : <FileText size={26} />}
                  <strong>第 {page} 页</strong>
                </button>
              ))}
            </div>
          </Card>
        ) : null}
        {step === 3 ? (
          <div className="split-workspace">
            <Card className="pdf-preview">
              <div className="pdf-toolbar">审批页预览 · 第 {approvalPage} 页</div>
              {taskId ? <img className="paper" src={uploadPageUrl(taskId, approvalPage)} alt="审批页" /> : null}
            </Card>
            <Card className="field-panel">
              <div className="section-title">登记字段</div>
              {confirmFieldMeta.map(({ key, label, required }) => {
                const low = confidence[key] !== undefined && confidence[key] < LOW_CONFIDENCE;
                return (
                  <label className={`confirm-field ${low ? "low-confidence" : ""}`} key={key}>
                    <span>{label}{required ? <b>*</b> : null}{low ? <em>低置信</em> : null}</span>
                    <input aria-label={label} value={values[key] ?? ""} onChange={(e) => setValues((c) => ({ ...c, [key]: e.target.value }))} />
                    {low ? <small><AlertCircle size={13} />置信度偏低，请核对</small> : null}
                  </label>
                );
              })}
              <label className="confirm-field need-fill"><span>生效日<b>*</b></span><input type="date" aria-label="生效日" value={dates.effective_date} onChange={(e) => setDates((d) => ({ ...d, effective_date: e.target.value }))} /></label>
              <label className="confirm-field need-fill"><span>到期日<b>*</b></span><input type="date" aria-label="到期日" value={dates.expiration_date} onChange={(e) => setDates((d) => ({ ...d, expiration_date: e.target.value }))} /></label>
              <label className="confirm-field"><span>存档分类<b>*</b></span>
                <select aria-label="存档分类" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {(config?.fileNoRules ?? []).map((r) => <option key={r.category} value={r.category}>{r.category} · {r.example}</option>)}
                </select>
              </label>
            </Card>
          </div>
        ) : null}
        <footer className="wizard-footer">
          <span>{step === 1 ? (uploadError || "仅支持 PDF") : step === 2 ? `已选：第 ${approvalPage} 页为审批页` : ""}</span>
          <div>
            {step === 1 ? <Link to="/ledger" className="button button-secondary">取消</Link> : <Button onClick={() => setStep((s) => (s === 3 ? 2 : 1))}>上一步</Button>}
            {step === 2 ? <Button variant="primary" loading={extractMutation.isPending} onClick={goExtract}>下一步：抽取字段</Button> : null}
            {step === 3 ? <Button variant="primary" icon={<CheckCircle2 size={16} />} disabled={!canConfirm} loading={confirmMutation.isPending} onClick={() => doConfirm(false)}>确认入账</Button> : null}
          </div>
        </footer>
      </div>
      {showOverwrite ? (
        <div className="modal-layer">
          <button className="modal-scrim" aria-label="关闭" onClick={() => setShowOverwrite(false)} />
          <section className="confirm-modal" role="dialog" aria-modal="true">
            <h2>合同已存在</h2>
            <p>该合同编号已登记，确认入账将覆盖原数据及其存档 PDF，不可恢复。是否继续？</p>
            <footer>
              <Button onClick={() => setShowOverwrite(false)}>取消</Button>
              <Button variant="danger" onClick={() => { setShowOverwrite(false); doConfirm(true); }}>覆盖并入账</Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function UploadStep({ error, isUploading, onSelect }: { error: string; isUploading: boolean; onSelect: (file?: File) => void }) {
  function handleInputChange(event: ChangeEvent<HTMLInputElement>) { onSelect(event.target.files?.[0]); event.target.value = ""; }
  function handleDrop(event: DragEvent<HTMLElement>) { event.preventDefault(); onSelect(event.dataTransfer.files?.[0]); }
  return (
    <Card className={`upload-drop ${error ? "upload-drop-error" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={handleDrop}>
      <UploadCloud size={42} />
      <h2>拖拽 PDF 到此处，或点击选择</h2>
      <p>上传后系统会生成页面缩略图，下一步由你指认审批页。</p>
      {isUploading ? <div className="upload-progress" role="status" aria-live="polite"><span>上传中…</span></div> : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <label className="button button-primary">
        <UploadCloud size={16} /><span>选择 PDF</span>
        <input className="sr-only" type="file" accept="application/pdf,.pdf" aria-label="选择 PDF 文件" onChange={handleInputChange} />
      </label>
    </Card>
  );
}

export function StepBar({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["上传", "指认审批页", "确认字段"];
  return (
    <div className="stepbar">
      {steps.map((label, index) => {
        const stepNo = index + 1;
        return <div className={`step ${stepNo < current ? "done" : stepNo === current ? "current" : ""}`} key={label}><span>{stepNo}</span>{label}</div>;
      })}
    </div>
  );
}
```

- [ ] **Step 4: Delete the dead duplicate confirm page + its route**

```bash
git rm frontend/src/features/upload/FieldConfirmPage.tsx
```

In `frontend/src/App.tsx`, remove the `FieldConfirmPage` import and any `<Route path="/confirm" ...>` referencing it. (Grep first: `grep -rn FieldConfirmPage frontend/src`.)

- [ ] **Step 5: Run the test + build**

Run: `cd frontend && npm test -- --run upload.test.tsx`
Expected: PASS.
Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/upload/UploadPage.tsx frontend/src/App.tsx frontend/src/__tests__/upload.test.tsx
git commit -m "feat(fe): rewire upload wizard to real API + overwrite modal"
```

---

### Task 12: End-to-end manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run all backend tests**

Run: `uv run pytest tests/ -v`
Expected: all PASS (existing 38 + new api tests).

- [ ] **Step 2: Start the API**

Run: `uv run uvicorn contract_rag.api.app:app --reload --port 8000`
Expected: server starts; `GET http://localhost:8000/api/health` → `{"status":"ok"}`.

- [ ] **Step 3: Start the frontend against the API**

In `frontend/`, create `.env.local` with `VITE_API_BASE=http://localhost:8000/api`, then:
Run: `cd frontend && npm run dev`
Expected: Vite on :5173. CORS allows it (app.py whitelist).

- [ ] **Step 4: Walk the upload flow in the browser**

Upload a real multi-page PDF → confirm thumbnails render → mark approval page → extract → confirm fields (low-confidence highlighted) → set dates + category → 确认入账 → lands on the contract detail page → appears in the ledger.

- [ ] **Step 5: Verify overwrite + ledger + processing**

Re-upload the same contract number → overwrite modal appears → confirm → succeeds. Check the ledger filters/search/export and (with `excel.enabled: true` + a real ledger path) the processing page sync state.

- [ ] **Step 6: Final commit (docs)**

Update `docs/INTERFACE.md` to add the new HTTP surface (upload flow + REST endpoints) and update `memory/ingestion_pipeline.md` decision 7/15 "现已落地" notes to mark the API layer done.

```bash
git add docs/INTERFACE.md memory/ingestion_pipeline.md
git commit -m "docs: record V1 upload API surface"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** upload state machine (T6), read/sync/config endpoints (T7–T9), ContractRow/ProcessingRow/ConflictField/ConfigState projections incl. owner/suggested + status/size/time derivation (T4), page_count + task extraction columns (T1), overwrite-on-duplicate 409 flow (T6 + T11), category vocab unified via `/config`-driven dropdown (T11 step 3), frontend rewire + dead-page deletion (T11). All present.
- **Excel-off behavior:** sync endpoints return `disabled` because `sync_contract`/`get_status` already short-circuit on `excel.enabled: false`; processing rows still render (T8).
- **Out of scope (per spec):** body OCR/parse/embed; auto-retry loop; config write; auth. Not in any task.
