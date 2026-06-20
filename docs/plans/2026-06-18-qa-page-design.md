# Contract Q&A Page Design

**Goal:** Implement the Pencil `Page / 合同问答 (RAG)` and `State / 问答 · 原文核实弹窗` as a production React page backed by the existing agentic `/api/query` contract.

## Product Decision

Use one Q&A surface and one response shape. The backend agent decides whether to call SQL, Weaviate, or both. The frontend never classifies questions. It renders whatever evidence the response contains:

- `record` evidence becomes one ledger-style table.
- `clause` evidence becomes source cards with contract, page, section, verbatim snippet, and a verify action.
- Mixed evidence is the primary path: table first, clause cards second.

This keeps entity, comparison, clause, and mixed answers on the same page without branching the UI into separate modes.

## API Contract

`POST /api/query`

Request:

```json
{ "question": "付款期限超过 60 天的合同，逾期付款怎么约定违约责任？", "contract_id": null }
```

Response:

```json
{
  "question": "付款期限超过 60 天的合同，逾期付款怎么约定违约责任？",
  "answer": "自然语言回答。",
  "evidence": [
    {
      "kind": "record",
      "contract_id": "JSUS2026004",
      "title": "Owens Corning Composites",
      "fields": { "付款期限": "90 天", "金额": "USD 147,664.05" }
    },
    {
      "kind": "clause",
      "contract_id": "JSUS2026004",
      "page": 8,
      "section": "Payment",
      "snippet": "verbatim source text",
      "bbox": [0.12, 0.34, 0.76, 0.08]
    }
  ]
}
```

Add `GET /api/contracts/{contract_id}/pages/{page_no}` for the verify popup. It returns the already-rendered page PNG from `storage/{contract_id}/pages/{page_no}.png`. If the PNG is missing but `signed.pdf` exists, the endpoint may render thumbnails on demand and then serve the requested page. Invalid page numbers return `400`; missing files return `404`.

## Frontend Design

Navigation adds a `问答` item after `台账`.

`/qa` has:

- Sticky header: title `合同问答`, subtitle `基于全部合同的检索增强问答 · 回答附可追溯来源`.
- Scope control for all contracts vs a specific contract id. The first implementation can use a plain input; it should not block global Q&A.
- Conversation panel with an initial empty state, user question bubble, answer card, and source sections.
- Composer pinned at the bottom of the content area with textarea and send button.

Answer card rendering:

- Show answer prose first.
- Group `record` evidence into a table. Columns are `合同编号`, `名称`, then the union of all `fields` keys. Each row links to `/contracts/{id}`.
- Group `clause` evidence into source cards. Each card shows `contract_id · 第{page}页 · {section}`, the snippet, and `核实原文`.
- If no evidence exists, show a subdued `暂无可追溯来源` line, not an empty block.

Verify popup:

- Opens from a clause source card.
- Shows contract id, page number, section, snippet, page navigation, `新窗口打开`, and close.
- Displays `/api/contracts/{id}/pages/{page}` in an image stage.
- If `bbox` is present, draw an absolute highlight rectangle over the image using normalized `[x, y, w, h]`.
- If image loading fails, show a retry/open-file fallback.

## Prompt and Backend Expectations

The agent prompt should continue to require:

- Only answer from tool results.
- SQL-derived facts produce `record` evidence.
- Weaviate-derived source text produces `clause` evidence.
- Clause snippets must be verbatim.
- Every clause evidence item must include `contract_id` and `page` when available.
- The final response must be JSON with `answer` and `evidence`.

The existing backend already implements the agentic response shape. This feature mainly exposes it in the UI and adds the page image endpoint for verification.

## Testing

Backend:

- `GET /api/contracts/{id}/pages/{n}` returns `image/png` for an archived page.
- Bad page numbers return `400`.
- Missing page/PDF returns `404`.

Frontend:

- Sidebar includes `问答`; `/qa` renders the page.
- Submitting a question posts to `/api/query`.
- Mixed evidence renders both the record table and clause cards.
- `核实原文` opens the page modal at the correct contract/page and draws bbox highlight.
- Query failure shows a recoverable error.

