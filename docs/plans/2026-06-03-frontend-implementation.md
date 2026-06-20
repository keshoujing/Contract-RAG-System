# Contract-RAG Frontend Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the React frontend described by `docs/UI_SPEC.md` and `docs/pencil-new.pen`, keeping the visual system and interactions aligned with the design.

**Architecture:** Create an independent `frontend/` Vite SPA beside the Python backend. Use mock-backed typed API hooks for now so screens can be built and verified before FastAPI REST wrappers exist; keep API boundaries shaped like Appendix A so real endpoints can replace mocks later.

**Tech Stack:** React 18, TypeScript strict, Vite, React Router v6, TanStack Query, Zustand, Tailwind CSS, lucide-react, Vitest, React Testing Library, Playwright.

---

### Task 1: Frontend Scaffold And Smoke Tests

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/src/__tests__/app.test.tsx`

**Steps:**
1. Add Vite/React/TypeScript tooling and test configuration.
2. Write a failing smoke test asserting the app renders the sidebar navigation and two independent status columns.
3. Run `npm test -- --run` from `frontend/` and confirm the test fails because the app implementation is missing.

### Task 2: Design Tokens And Shell

**Files:**
- Create: `frontend/src/styles.css`
- Create: `frontend/src/main.tsx`
- Create: `frontend/src/App.tsx`
- Create: `frontend/src/components/AppShell.tsx`

**Steps:**
1. Map `UI_SPEC.md` tokens into CSS variables.
2. Build the fixed dark sidebar and page shell.
3. Implement route structure for ledger, upload, confirm, settings, processing, conflict, and detail pages.
4. Run the smoke test and keep it failing only for not-yet-built page content.

### Task 3: Mock API And Domain Types

**Files:**
- Create: `frontend/src/api/types.ts`
- Create: `frontend/src/api/mockData.ts`
- Create: `frontend/src/api/hooks.ts`
- Create: `frontend/src/lib/format.ts`

**Steps:**
1. Encode `INTERFACE.md` field/state enums in TypeScript.
2. Add sample contracts, ingest statuses, sync statuses, and conflicts from the Pencil screens.
3. Add Query hooks shaped like the future REST endpoints.

### Task 4: Shared UI Components

**Files:**
- Create: `frontend/src/components/ui/Button.tsx`
- Create: `frontend/src/components/ui/StatusTag.tsx`
- Create: `frontend/src/components/ui/DataTable.tsx`
- Create: `frontend/src/components/ui/Modal.tsx`
- Create: `frontend/src/components/ui/Toast.tsx`

**Steps:**
1. Implement button variants, state tags, table primitives, modal confirmation, and toast styling using tokens.
2. Ensure states use the exact text and color semantics in `UI_SPEC.md`.

### Task 5: Main Screens

**Files:**
- Create: `frontend/src/features/ledger/LedgerPage.tsx`
- Create: `frontend/src/features/upload/UploadPage.tsx`
- Create: `frontend/src/features/upload/FieldConfirmPage.tsx`
- Create: `frontend/src/features/settings/SettingsPage.tsx`
- Create: `frontend/src/features/processing/ProcessingPage.tsx`
- Create: `frontend/src/features/conflicts/ConflictPage.tsx`
- Create: `frontend/src/features/contracts/ContractDetailPage.tsx`

**Steps:**
1. Build each screen to match the Pencil layout, preserving core interactions.
2. Implement row click drawer, context menu fallback, conflict choice radios, settings toggles, and upload wizard visuals.
3. Keep uncovered designs visually consistent with the token system.

### Task 6: Verification

**Files:**
- Modify: `frontend/src/__tests__/app.test.tsx`

**Steps:**
1. Add focused tests for sidebar navigation, processing dual-status display, and conflict resolution choices.
2. Run `npm test -- --run`.
3. Run `npm run build`.
4. Start the dev server and inspect the app in browser at desktop and mobile sizes.
