# Contract-RAG UI Spec

> Data contracts are defined in `docs/INTERFACE.md`. This document describes the
> current product surface only.

## Navigation

- Ledger: searchable contract registry with column controls, row actions,
  contract details, editing, delete confirmation, PDF download, and on-demand
  spreadsheet export.
- Q&A: scoped contract questions with structured record evidence, clause
  evidence, source verification, conversations, and feedback.
- Processing: per-contract ingest status from upload through searchable ledger
  entry.
- Settings: runtime RAG toggle, registry storage information, File-No. rules,
  Contract Version options, and read-only model configuration.
- Upload contract: PDF upload, page tagging, approval extraction, field
  confirmation, duplicate overwrite confirmation, and detail-page handoff.

## Processing

The processing page tracks ingest only. It does not display downstream
spreadsheet synchronization, conflict resolution, retry state, or file-lock
handling.

| Column | Source |
|---|---|
| Contract No. | `contracts.contract_id` |
| Counterparty | `contracts.counterparty` |
| Ingest status | latest `tasks` row for the contract |
| Updated | latest task update, falling back to contract update |
| Actions | detail link |

Overview filters: Processing, Done, Failed.

## Settings

Runtime mode has one user-facing toggle:

| Toggle | Behavior |
|---|---|
| RAG module | Confirm before disabling. When off, the app stays in entry-only mode: approval extraction, PDF archival, and ledger writes remain available; body parsing, chunking, vectorization, and RAG are skipped. |

Registry storage is SQLite source-of-truth. Spreadsheet files are produced only
when the user exports from the ledger.

## Ledger

The ledger table is the primary operational surface for contract metadata. It
supports search, multi-filter chips, sortable columns, local column visibility
and ordering preferences, row context menus, batch delete, detail navigation,
inline editing through a drawer, and spreadsheet export.

## Upload

Upload flow:

1. Choose a PDF.
2. Tag every page as Approval, Contract, or Other.
3. Extract from the first approval page.
4. Confirm registry fields, effective date, expiration date, pricing term, File
   No. category, and Contract Version.
5. Persist to SQLite, archive the full PDF, store page roles, and navigate to
   the contract detail page.

## Q&A

Answers are evidence-first. Record evidence links to the ledger contract. Clause
evidence opens the PDF verification view with page and bounding-box highlight
when available.
