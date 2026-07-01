import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import App from "../App";
import { getContracts, getProcessingRows } from "../api/client";
import { configState, contracts, processingRows } from "../api/mockData";

afterEach(() => {
  cleanup();
  resetLedgerColumnsStorage();
  window.sessionStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const defaultLedgerColumns = [
  "contract_id",
  "counterparty",
  "project_name",
  "contract_type",
  "file_no",
  "file_name",
  "amount",
  "currency",
  "term_months",
  "yearly_amount",
  "petitioner",
  "petition_date",
  "effective_date",
  "expiration_date",
  "status"
];

function resetLedgerColumnsStorage() {
  if (typeof window.localStorage?.setItem === "function") {
    window.localStorage.setItem("contract-rag-ledger-columns", JSON.stringify(defaultLedgerColumns));
  }
}

function installLedgerColumnStorage(initialColumns = defaultLedgerColumns) {
  const values = new Map<string, string>([["contract-rag-ledger-columns", JSON.stringify(initialColumns)]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value))
    }
  });
}

function getLedgerHeaderText() {
  const headerRows = screen.getAllByRole("row").filter((row) => within(row).queryAllByRole("columnheader").length > 0);
  const headerRow = headerRows[headerRows.length - 1];
  return within(headerRow).getAllByRole("columnheader").map((header) => header.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

function getLedgerDataRows() {
  return Array.from(document.querySelectorAll<HTMLTableRowElement>('tr[data-contract-row="true"]'));
}

describe("Contract-RAG frontend", () => {
  it("renders the fixed navigation and processing status table", async () => {
    render(<App />);

    expect(screen.getByText("Contract Registry")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ledger" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Processing" })).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "Processing status table" });
    expect(within(table).getByRole("columnheader", { name: "Ingest status" })).toBeInTheDocument();
    expect(within(table).getByText("In progress · Embedding")).toBeInTheDocument();
    expect(within(table).getAllByText("Done").length).toBeGreaterThan(0);
  });

  it("keeps the sidebar runtime status aligned to the config API", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(processingRows), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    }));

    render(<App initialPath="/processing" />);

    expect(await screen.findByText("RAG on")).toBeInTheDocument();
  });

  it("filters processing rows from the overview metric cards", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/processing" />);

    await screen.findByRole("table", { name: "Processing status table" });
    expect(screen.getByText("Jushi Egypt For Fiberglass Industry S.A.E")).toBeInTheDocument();
    expect(screen.getByText("Water-treatment framework supplier")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Processing 1" }));

    expect(screen.getByText("Filter: Processing")).toBeInTheDocument();
    expect(screen.getByText("Stainless-steel pipe supplier")).toBeInTheDocument();
    expect(screen.queryByText("Water-treatment framework supplier")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear status filter" }));
    expect(screen.getByText("Water-treatment framework supplier")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Done 3" }));
    expect(screen.getByText("Water-treatment framework supplier")).toBeInTheDocument();
    expect(screen.queryByText("Stainless-steel pipe supplier")).not.toBeInTheDocument();
  });

  it("walks through the upload wizard from file selection to field confirmation", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "supply-contract.pdf", { type: "application/pdf" });

    expect(screen.getByText("Drag a PDF here, or click to choose")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);

    expect(await screen.findByText(/Uploading/)).toBeInTheDocument();
    expect((await screen.findAllByText("supply-contract.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Tag each page: Approval / Contract / Other")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect(screen.getByText("Confirm registration fields")).toBeInTheDocument();
    expect(screen.getByText("Registration fields")).toBeInTheDocument();
    expect(screen.getByText("Confirm registration")).toBeInTheDocument();
  });

  it("requires every page tagged plus an approval and contract page before extracting", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "approval-required.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("approval-required.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));

    const extractButton = screen.getByRole("button", { name: "Next: extract fields" });
    expect(extractButton).toBeDisabled();                                   // nothing tagged yet

    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));        // brush defaults to approval
    expect(extractButton).toBeDisabled();                                   // other pages still untagged

    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    expect(extractButton).toBeEnabled();                                    // all tagged + approval + contract
  });

  it("uploads the PDF and submits the selected approval page to the ingest API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "api-contract.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);

    const uploadCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ingest/upload");
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((uploadCall?.[1]?.body as FormData).get("file")).toBe(pdf);

    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ingest/task-42/page-tags", expect.objectContaining({ method: "POST" })));
    const pageTagsCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ingest/task-42/page-tags");
    const sentTags = JSON.parse((pageTagsCall?.[1]?.body as string)).tags as Record<string, string>;
    expect(sentTags["2"]).toBe("approval");
    expect(Object.values(sentTags)).toContain("contract");
    expect(Object.keys(sentTags)).toHaveLength(14);
  });

  it("loads extracted ingest fields and confirms the entry through the API", async () => {
    const extractedFields = {
      contract_id: "API2026001",
      amount: "25000",
      counterparty: "API Counterparty LLC",
      project_name: "API Supplied Project",
      department: "Legal",
      petitioner: "Zhang Wei"
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({
          status: "done",
          stage: "awaiting_user_confirmation",
          fields: extractedFields,
          _per_field_confidence: { project_name: 0.62 },
          _per_field_source_span: { project_name: "API Supplied Project" }
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/confirm" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ contract_id: "API2026001" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/contracts/API2026001") {
        return Promise.resolve(new Response(JSON.stringify({ ...contracts[0], contract_id: "API2026001", counterparty: "API Counterparty LLC" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "api-contract.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect(await screen.findByDisplayValue("API2026001")).toBeInTheDocument();
    expect(screen.getByDisplayValue("API Counterparty LLC")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Effective Date"), "2026-06-01");
    await user.type(screen.getByLabelText("Expiration Date"), "2027-06-01");
    await user.selectOptions(screen.getByLabelText("Archive category"), "china-buy");
    await user.click(screen.getByRole("button", { name: "Confirm registration" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ingest/task-42/confirm", expect.objectContaining({
      body: JSON.stringify({
        fields: { ...extractedFields, effective_date: "2026-06-01", expiration_date: "2027-06-01" },
        effective_date: "2026-06-01",
        expiration_date: "2027-06-01",
        category: "china-buy"
      }),
      method: "POST"
    })));
    expect(await screen.findByText("Registered API2026001")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "API2026001" })).toBeInTheDocument();
  });

  it("requires overwrite confirmation when an uploaded contract id already exists", async () => {
    const extractedFields = {
      contract_id: "API2026001",
      amount: "25000",
      counterparty: "API Counterparty LLC",
      project_name: "API Supplied Project",
      department: "Legal",
      petitioner: "Zhang Wei"
    };
    let confirmAttempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({ status: "done", stage: "awaiting_user_confirmation", fields: extractedFields }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/confirm" && init?.method === "POST") {
        confirmAttempts += 1;
        if (confirmAttempts === 1) {
          return Promise.resolve(new Response(JSON.stringify({ error: "duplicate_contract" }), { headers: { "Content-Type": "application/json" }, status: 409 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ contract_id: "API2026001" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/contracts/API2026001") {
        return Promise.resolve(new Response(JSON.stringify({ ...contracts[0], contract_id: "API2026001", counterparty: "API Counterparty LLC" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "api-contract.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));
    await user.type(await screen.findByLabelText("Effective Date"), "2026-06-01");
    await user.type(screen.getByLabelText("Expiration Date"), "2027-06-01");
    await user.click(screen.getByRole("button", { name: "Confirm registration" }));

    const dialog = await screen.findByRole("dialog", { name: "Overwrite existing contract?" });
    expect(within(dialog).getByText("Contract API2026001 already exists; registering will overwrite the existing data (including the vector store and archive). Continue?")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confirm registration fields" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Confirm overwrite" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ingest/task-42/confirm", expect.objectContaining({
      body: expect.stringContaining("\"overwrite\":true"),
      method: "POST"
    })));
    expect(await screen.findByRole("heading", { name: "API2026001" })).toBeInTheDocument();
  });

  it("shows the extraction stage skeleton while ingest fields are loading", async () => {
    let resolveStatus: (response: Response) => void = () => undefined;
    const statusResponse = new Promise<Response>((resolve) => {
      resolveStatus = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return statusResponse;
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "loading-fields.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("loading-fields.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect(await screen.findByRole("heading", { name: "Confirm registration fields" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Extracting fields" })).toBeInTheDocument();
    expect(screen.getAllByText("Structuring fields with a small model and generating the registration form…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Confirm registration" })).toBeDisabled();

    resolveStatus(new Response(JSON.stringify({ status: "done", stage: "awaiting_user_confirmation", fields: { contract_id: "API2026002" } }), { headers: { "Content-Type": "application/json" }, status: 200 }));

    expect(await screen.findByDisplayValue("API2026002")).toBeInTheDocument();
  });

  it("requires a manually entered contract id when extraction misses it", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({
          status: "done",
          stage: "awaiting_user_confirmation",
          fields: { contract_id: "", amount: "25000", counterparty: "API Counterparty LLC" }
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "missing-id.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("missing-id.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect(await screen.findByText("Contract number not detected; enter it manually")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm registration" })).toBeDisabled();
  });

  it("focuses the first invalid upload field when confirmation validation fails", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "invalid-dates.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("invalid-dates.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));
    await user.type(screen.getByLabelText("Effective Date"), "2027-04-15");
    await user.type(screen.getByLabelText("Expiration Date"), "2026-04-14");

    await user.click(screen.getByRole("button", { name: "Confirm registration" }));

    expect(screen.getByText("Expiration date cannot be earlier than the effective date")).toBeInTheDocument();
    expect(screen.getByLabelText("Expiration Date")).toHaveFocus();
  });

  it("keeps the approval page step retryable when extraction fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({ error: "extractor unavailable" }), { headers: { "Content-Type": "application/json" }, status: 500 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "extract-failure.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("extract-failure.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect((await screen.findAllByText("Extraction failed, please retry")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Next: extract fields" })).toBeEnabled();
    expect(screen.getByText("Tag each page: Approval / Contract / Other")).toBeInTheDocument();
    expect(screen.getAllByText("Extraction failed, please retry").some((node) => node.closest(".toast")?.classList.contains("toast-error"))).toBe(true);
  });

  it("returns to upload when OCR quality is too low", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ingest/upload" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ task_id: "task-42" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42/page-tags" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/ingest/task-42" && (!init || init.method === undefined)) {
        return Promise.resolve(new Response(JSON.stringify({ error: "low_quality" }), { headers: { "Content-Type": "application/json" }, status: 422 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "blurred-scan.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("blurred-scan.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect((await screen.findAllByText("Recognition quality too low; re-upload a clearer scan")).length).toBeGreaterThan(0);
    expect(screen.getByText("Drag a PDF here, or click to choose")).toBeInTheDocument();
    expect(screen.getAllByText("Recognition quality too low; re-upload a clearer scan").some((node) => node.closest(".toast")?.classList.contains("toast-error"))).toBe(true);
  });

  it("rejects non-PDF files in the upload wizard", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const image = new File(["not a contract"], "contract.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("Choose PDF file"), image);

    expect(screen.getByText("PDF only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("requires missing dates before confirming upload entry and then opens the contract detail", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "signed_2026005_OwensCorning.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("signed_2026005_OwensCorning.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: /Tag page 2/ }));
    await user.click(screen.getByRole("button", { name: "Set rest as Contract" }));
    await user.click(screen.getByRole("button", { name: "Next: extract fields" }));

    expect(screen.getByRole("button", { name: "Confirm registration" })).toBeDisabled();

    await user.type(screen.getByLabelText("Effective Date"), "2026-04-15");
    await user.type(screen.getByLabelText("Expiration Date"), "2027-04-14");
    await user.click(screen.getByRole("button", { name: "Confirm registration" }));

    expect(await screen.findByText("Registered JSUS2026005")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JSUS2026005" })).toBeInTheDocument();
    expect(screen.getAllByText("Owens Corning Composites").length).toBeGreaterThan(0);
  });

  it("rolls back a settings toggle when saving config fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "config locked" }), { status: 500 }));
      }
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.click(await screen.findByRole("button", { name: "RAG module" }));
    await user.click(screen.getByRole("button", { name: "Confirm disable" }));

    const failureToast = await screen.findByText(/Failed to save/);
    expect(failureToast).toBeInTheDocument();
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("heading", { name: "RAG module On" })).toBeInTheDocument();
  });

  it("edits and saves file number rule prefixes from settings", async () => {
    const updatedRules = configState.fileNoRules.map((rule) => rule.category === "china-buy" ? { ...rule, prefix: "CB", example: "CB2026001" } : rule);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config/file-no-rules") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(updatedRules), { status: 200 }));
      }
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    const prefixInput = await screen.findByLabelText("china-buy prefix");
    await user.clear(prefixInput);
    await user.type(prefixInput, "CB");
    await user.click(screen.getByRole("button", { name: "Save File-No. rules" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config/file-no-rules", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ordinary: { prefix: "" },
        "china-buy": { prefix: "CB" },
        production: { prefix: "PD" }
      })
    })));
    expect(await screen.findByText("File-No. rules saved")).toBeInTheDocument();
    expect(screen.getByLabelText("china-buy prefix")).toHaveValue("CB");
  });

  it("blocks duplicate file number rule prefixes in settings", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.type(await screen.findByLabelText("ordinary prefix"), "CN");
    await user.click(screen.getByRole("button", { name: "Save File-No. rules" }));

    expect(screen.getByText("Prefixes must be unique")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/config/file-no-rules", expect.anything());
  });

  it("shows a settings skeleton while configuration is loading", async () => {
    let resolveConfig: (response: Response) => void = () => undefined;
    const configResponse = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/config")) return configResponse;
      return Promise.reject(new Error("unexpected request"));
    }));

    render(<App initialPath="/settings" />);

    expect(screen.getByRole("status", { name: "Loading settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "RAG module" })).not.toBeInTheDocument();

    resolveConfig(new Response(JSON.stringify(configState), { headers: { "Content-Type": "application/json" }, status: 200 }));
    expect(await screen.findByRole("button", { name: "RAG module" })).toBeInTheDocument();
  });

  it("toggles ledger column visibility from the column configuration menu", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    expect(await screen.findByRole("columnheader", { name: "Petitioner" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByLabelText("Petitioner"));

    expect(screen.queryByRole("columnheader", { name: "Petitioner" })).not.toBeInTheDocument();
  });

  it("reorders ledger columns from the column configuration menu and persists the order", async () => {
    const user = userEvent.setup();
    installLedgerColumnStorage();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(getLedgerHeaderText().indexOf("File Name")).toBeLessThan(getLedgerHeaderText().indexOf("Contract Amount"));

    await user.click(screen.getByRole("button", { name: "Columns" }));
    await user.click(screen.getByRole("button", { name: "Move Contract Amount up" }));

    expect(getLedgerHeaderText().indexOf("Contract Amount")).toBeLessThan(getLedgerHeaderText().indexOf("File Name"));
    expect(JSON.parse(window.localStorage.getItem("contract-rag-ledger-columns") ?? "[]")).toEqual([
      "contract_id",
      "counterparty",
      "project_name",
      "contract_type",
      "file_no",
      "amount",
      "file_name",
      "currency",
      "term_months",
      "yearly_amount",
      "petitioner",
      "petition_date",
      "effective_date",
      "expiration_date",
      "status"
    ]);

    cleanup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(getLedgerHeaderText().indexOf("Amount")).toBeLessThan(getLedgerHeaderText().indexOf("File Name"));
  });

  it("renders the ledger as a grouped 17-column wide table using the interface fields", async () => {
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(screen.getByRole("scrollbar", { name: "Ledger horizontal scrollbar" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Key" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Basic info" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Amount" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Owner" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Date" })).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader", { name: "Status" }).length).toBeGreaterThan(0);

    const headerText = getLedgerHeaderText();
    expect(headerText).toEqual([
      "Select current page",
      "Contract No.",
      "Counterparty",
      "Project Name",
      "Contract Version",
      "File No.",
      "File Name",
      "Contract Amount",
      "Currency",
      "Term",
      "Annualized",
      "Petitioner",
      "Registered Date",
      "Effective Date",
      "Expiration Date",
      "Status",
      "Actions"
    ]);
    expect(headerText).toHaveLength(17);
    expect(screen.getByText("Supply Agreement")).toBeInTheDocument();
    expect(screen.getByText("2026004")).toBeInTheDocument();
    expect(screen.getByText("2026004-JSUS2026004-UD Glass-Fiber Reinforced Composite Procurement")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Payment method" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Archived" })).not.toBeInTheDocument();
  });

  it("filters ledger rows by search text and sorts amount descending", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "PPG");

    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search contract no. / counterparty / project"));
    await user.click(screen.getByRole("button", { name: "Sort by Amount" }));
    await user.click(screen.getByRole("button", { name: "Amount ascending" }));

    const rows = getLedgerDataRows();
    expect(within(rows[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();
  });

  it("filters ledger rows with multi-select chips", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    await user.click(screen.getByRole("button", { name: "Department filter" }));

    const departmentMenu = screen.getByRole("menu", { name: "Department filter options" });
    await user.click(within(departmentMenu).getByLabelText("FPW"));

    expect(await screen.findByText("Jushi Group Hong Kong")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("department")).toBe("FPW"));

    await user.click(within(departmentMenu).getByLabelText("PD"));

    expect(screen.getByRole("button", { name: "Department filter" })).toHaveTextContent("Department: 2 selected");
    expect(screen.getByText("Jushi Group Hong Kong")).toBeInTheDocument();
    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("department")).toBe("FPW,PD"));

    await user.click(within(departmentMenu).getByLabelText("All"));

    expect(await screen.findByText("Owens Corning Composites")).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("department="));
  });

  it("debounces ledger search requests while keeping immediate local feedback", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    expect(await screen.findByText("Owens Corning Composites")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "PPG");

    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("q=PPG"))).toHaveLength(0);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("q=PPG"))).toBe(true));
  });

  it("virtualizes the ledger body when more than 200 rows are rendered", async () => {
    const largeContracts = Array.from({ length: 260 }, (_, index) => ({
      ...contracts[index % contracts.length],
      contract_id: `BULK${String(index + 1).padStart(4, "0")}`,
      counterparty: `Batch supplier ${String(index + 1).padStart(4, "0")}`,
      file_no: `V${String(index + 1).padStart(4, "0")}`,
      file_name: `V${String(index + 1).padStart(4, "0")}-BULK${String(index + 1).padStart(4, "0")}`
    }));
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: largeContracts, total: largeContracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    }));

    render(<App initialPath="/ledger" />);

    expect(await screen.findByText("Batch supplier 0001")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Ledger table virtual scroll area" })).toBeInTheDocument();
    expect(getLedgerDataRows().length).toBeLessThan(260);
  });

  it("cycles the ledger amount sort through ascending descending and none", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    const amountSort = screen.getByRole("button", { name: "Sort by Amount" });

    await user.click(amountSort);
    expect(screen.getByRole("button", { name: "Amount ascending" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=amount_asc"));

    await user.click(screen.getByRole("button", { name: "Amount ascending" }));
    expect(screen.getByRole("button", { name: "Amount descending" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=amount_desc"));

    await user.click(screen.getByRole("button", { name: "Amount descending" }));
    expect(screen.getByRole("button", { name: "Sort by Amount" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("sort="));
  });

  it("sorts ledger by the documented contract id counterparty amount and date headers", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    expect(screen.getByRole("button", { name: "Sort by Contract No." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by Counterparty" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by Amount" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sort by Effective Date" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort by Project Name" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sort by Counterparty" }));
    expect(screen.getByRole("button", { name: "Counterparty ascending" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=counterparty_asc"));
    expect(within(getLedgerDataRows()[0]).getByText("Jushi Group Hong Kong")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Counterparty ascending" }));
    expect(screen.getByRole("button", { name: "Counterparty descending" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=counterparty_desc"));
    expect(within(getLedgerDataRows()[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sort by Effective Date" }));
    expect(screen.getByRole("button", { name: "Effective Date ascending" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=effective_date_asc"));
    expect(within(getLedgerDataRows()[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();
  });

  it("shows a filter empty state and can clear ledger filters", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "no such contract");

    expect(await screen.findByText("No matching contracts; try adjusting the filters")).toBeInTheDocument();
    expect(screen.queryByText("No contracts yet — click 'Upload contract' to start")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("Owens Corning Composites")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search contract no. / counterparty / project")).toHaveValue("");
  });

  it("preserves ledger search filters when returning from contract detail", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    const search = screen.getByPlaceholderText("Search contract no. / counterparty / project");
    await user.type(search, "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });
    await user.click(await screen.findByRole("link", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Contract ledger" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search contract no. / counterparty / project")).toHaveValue("PPG");
    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
  });

  it("restores the ledger scroll position when returning from contract detail", async () => {
    const user = userEvent.setup();
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 480 });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    render(<App initialPath="/ledger" />);

    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });
    await user.click(await screen.findByRole("link", { name: "Back" }));

    expect(await screen.findByRole("heading", { name: "Contract ledger" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search contract no. / counterparty / project")).toHaveValue("PPG");
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 480, behavior: "auto" }));
  });

  it("returns from contract detail with Escape while preserving ledger filters", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "JSUS2026002" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByRole("heading", { name: "Contract ledger" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search contract no. / counterparty / project")).toHaveValue("PPG");
    // The {q:"PPG"} query is genuinely uncached on return (the Enter navigation happened within
    // the 300ms search debounce, before it was ever fetched), so the ledger briefly shows a
    // loading skeleton — await the filtered rows instead of asserting synchronously.
    expect(await screen.findByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
  });

  it("disables ledger export when the current result set is empty", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(screen.getByRole("button", { name: "Export Excel" })).toBeEnabled();

    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "no such contract");

    expect(await screen.findByRole("button", { name: "Export Excel" })).toBeDisabled();
  });

  it("exports the current ledger filters as an xlsx download", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/contracts/export")) {
        return Promise.resolve(new Response(new Blob(["xlsx"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), { status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: [contracts[0]], total: 1 }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:ledger-export");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.type(screen.getByPlaceholderText("Search contract no. / counterparty / project"), "Owens");
    const exportButton = screen.getByRole("button", { name: "Export Excel" });
    await user.click(exportButton);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/contracts\/export\?.*q=Owens/), expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Exported the current filter results")).toBeInTheDocument();
  });

  it("opens the ledger context menu at the right-click cursor position", async () => {
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row!, { clientX: 160, clientY: 220 });

    const menu = screen.getByRole("menu", { name: "Row actions JSUS2026004" });
    expect(menu).toHaveStyle({ left: "160px", top: "220px" });
    expect(within(menu).getByText("JSUS2026004")).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "View detail" })).toHaveAttribute("href", "/contracts/JSUS2026004");
  });

  it("opens the same ledger row menu from the fallback more button without opening the drawer", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.click(screen.getByRole("button", { name: "More actions JSUS2026004" }));

    const menu = screen.getByRole("menu", { name: "Row actions JSUS2026004" });
    expect(within(menu).getByRole("link", { name: "View detail" })).toHaveAttribute("href", "/contracts/JSUS2026004");
    expect(within(menu).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "JSUS2026004" })).not.toBeInTheDocument();
  });

  it("opens the contract detail when pressing Enter on a ledger row", async () => {
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
    expect(await screen.findByTitle("signed.pdf")).toBeInTheDocument();
  });

  it("copies the ledger contract id from the row context menu", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 160, clientY: 220 });

    await user.click(screen.getByRole("button", { name: "Copy number" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(await screen.findByText("Copied JSUS2026004")).toBeInTheDocument();
  });

  it("downloads the ledger row PDF from the context menu", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004/file") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:contract-pdf");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 160, clientY: 220 });

    await user.click(screen.getByRole("button", { name: "Full" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004/file", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Downloaded 2026004-JSUS2026004-UD Glass-Fiber Reinforced Composite Procurement")).toBeInTheDocument();
  });

  it("downloads the contract detail PDF from the header action", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004/file") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:detail-pdf");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "Download PDF" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004/file", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Downloaded JSUS2026004 signed.pdf")).toBeInTheDocument();
  });

  it("renders the contract detail PDF through the file endpoint", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004/file") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:inline-detail-pdf");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    render(<App initialPath="/contracts/JSUS2026004" />);

    const pdf = await screen.findByTitle("signed.pdf");

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004/file", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(pdf).toHaveAttribute("src", "blob:inline-detail-pdf");
    expect(pdf).toHaveAttribute("type", "application/pdf");
  });

  it("shows a fallback download action when the detail PDF preview fails", async () => {
    const user = userEvent.setup();
    let fileRequests = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004/file") {
        fileRequests += 1;
        if (fileRequests === 1) {
          return Promise.resolve(new Response(JSON.stringify({ error: "preview unavailable" }), { headers: { "Content-Type": "application/json" }, status: 500 }));
        }
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:fallback-download-pdf");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    render(<App initialPath="/contracts/JSUS2026004" />);

    const previewError = await screen.findByRole("alert");
    expect(previewError).toHaveTextContent(/Could not load PDF/);
    await user.click(within(previewError).getByRole("button", { name: "Download file" }));

    expect(fileRequests).toBe(2);
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Downloaded JSUS2026004 signed.pdf")).toBeInTheDocument();
  });

  it("opens the contract detail action menu without a view-details item and copies the id", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "More actions" }));

    const menu = screen.getByRole("menu", { name: "Detail actions JSUS2026004" });
    expect(within(menu).queryByRole("link", { name: "View detail" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("button", { name: "Copy number" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(await screen.findByText("Copied JSUS2026004")).toBeInTheDocument();
  });

  it("uses the irreversible archive warning for detail delete confirmation", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Delete contract?" });
    expect(within(dialog).getByText("This will delete contract JSUS2026004 and its archived PDF. This cannot be undone.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("falls back to legacy copy from the detail menu when clipboard write fails", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard not focused"));
    let copyBuffer: HTMLTextAreaElement | null = null;
    const execCommand = vi.fn(() => {
      copyBuffer = document.querySelector("textarea[name='clipboard-copy-buffer']");
      return true;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText }
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand
    });
    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Copy number" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copyBuffer).toHaveAttribute("id", "clipboard-copy-buffer");
    expect(copyBuffer).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("menu", { name: "Detail actions JSUS2026004" })).not.toBeInTheDocument();
    expect(await screen.findByText("Copied JSUS2026004")).toBeInTheDocument();
  });

  it("opens the contract detail edit drawer and saves changes", async () => {
    const user = userEvent.setup();
    const updatedContract = { ...contracts[0], project_name: "UD detail-page edit save" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(updatedContract), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "UD detail-page edit save");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({
      body: JSON.stringify({ project_name: "UD detail-page edit save" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "PATCH"
    }));
    expect(await screen.findByText("Saved JSUS2026004")).toBeInTheDocument();
  });

  it("keeps the contract detail drawer open when saving fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "version conflict" }), { headers: { "Content-Type": "application/json" }, status: 409 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "kept after detail-page failure");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const failureToast = await screen.findByText("Failed to save: This contract was modified elsewhere; refresh and retry");
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("complementary", { name: "Edit contract JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project Name")).toHaveValue("kept after detail-page failure");
  });

  it("falls back to mock contracts when the REST endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("backend offline")));

    const result = await getContracts();

    expect(result.data.some((contract) => contract.contract_id === "JSUS2026004")).toBe(true);
    expect(result.total).toBeGreaterThan(0);
  });

  it("shows a retryable ledger error state when the backend returns an error", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "database locked" }), { headers: { "Content-Type": "application/json" }, status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [contracts[0]], total: 1 }), { headers: { "Content-Type": "application/json" }, status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/ledger" />);

    expect(await screen.findByText(/Failed to load: GET \/contracts.*failed: 500/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Owens Corning Composites")).toBeInTheDocument();
  });

  it("shows a retryable contract detail error state when the backend returns an error", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && fetchMock.mock.calls.filter(([callInput]) => String(callInput) === "/api/contracts/JSUS2026004").length === 1) {
        return Promise.resolve(new Response(JSON.stringify({ error: "database locked" }), { headers: { "Content-Type": "application/json" }, status: 500 }));
      }
      if (url === "/api/contracts/JSUS2026004") {
        return Promise.resolve(new Response(JSON.stringify(contracts[0]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { headers: { "Content-Type": "application/pdf" }, status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/contracts/JSUS2026004" />);

    expect(await screen.findByText("Failed to load: GET /contracts/JSUS2026004 failed: 500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByText("Owens Corning Composites · UD Glass-Fiber Reinforced Composite Procurement")).toBeInTheDocument();
  });

  it("falls back to mock processing rows when the REST endpoint is missing locally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Not Found", { status: 404 }))
    );

    const result = await getProcessingRows();

    expect(result.some((row) => row.contract_id === "JSEGRCXS20260003")).toBe(true);
  });

  it("falls back to mock processing rows when the local Vite proxy has no backend", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { headers: { "Content-Type": "text/plain" }, status: 500 }))
    );

    const result = await getProcessingRows();

    expect(result.some((row) => row.contract_id === "JSEGRCXS20260003")).toBe(true);
  });

  it("shows toast feedback after saving a ledger drawer", async () => {
    const user = userEvent.setup();
    const updatedContract = { ...contracts[0], project_name: "UD Glass-Fiber Reinforced Composite Procurement - revised" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(updatedContract), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "UD Glass-Fiber Reinforced Composite Procurement - revised");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({
      body: JSON.stringify({ project_name: "UD Glass-Fiber Reinforced Composite Procurement - revised" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "PATCH"
    }));
    expect(screen.getByText("Saved JSUS2026004")).toBeInTheDocument();
  });

  it("keeps the ledger drawer open and shows an error toast when saving fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "version conflict" }), { headers: { "Content-Type": "application/json" }, status: 409 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "project name kept after a failed save");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const failureToast = await screen.findByText(/Failed to save/);
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("complementary", { name: "Edit contract JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByLabelText("Project Name")).toHaveValue("project name kept after a failed save");
  });

  it("shows the business status tag in the ledger drawer header", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));

    const drawer = screen.getByRole("complementary", { name: "Edit contract JSUS2026004" });
    const header = drawer.querySelector("header") as HTMLElement;
    expect(within(drawer).getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
    expect(within(header).getByText("Active")).toBeInTheDocument();
  });

  it("keeps business status options aligned to the interface enum", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    expect(screen.queryByRole("option", { name: "Status: Conflict" })).not.toBeInTheDocument();

    await user.click(await screen.findByText("Owens Corning Composites"));
    const statusSelect = screen.getByLabelText("Business status") as HTMLSelectElement;

    expect(Array.from(statusSelect.options).map((option) => option.value)).toEqual(["active", "expired"]);
  });

  it("edits ledger drawer select fields and petition date from the spec", async () => {
    const user = userEvent.setup();
    const updatedContract = {
      ...contracts[0],
      department: "FPW",
      contract_type: "Framework",
      currency: "CNY",
      petition_date: "2026-05-02",
      status: "expired" as const
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify(updatedContract), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.selectOptions(screen.getByLabelText("Department"), "FPW");
    await user.selectOptions(screen.getByLabelText("Contract Version"), "Framework");
    await user.selectOptions(screen.getByLabelText("Currency"), "CNY");
    await user.clear(screen.getByLabelText("Registered Date"));
    await user.type(screen.getByLabelText("Registered Date"), "2026-05-02");
    await user.selectOptions(screen.getByLabelText("Business status"), "expired");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    const patchCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/contracts/JSUS2026004" && init?.method === "PATCH");
    expect(patchCall).toBeDefined();
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({
      department: "FPW",
      petition_date: "2026-05-02",
      contract_type: "Framework",
      currency: "CNY",
      status: "expired"
    });
  });

  it("blocks invalid ledger drawer values before saving", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.clear(screen.getByLabelText("Amount"));
    await user.type(screen.getByLabelText("Amount"), "abc");
    await user.clear(screen.getByLabelText("Effective Date"));
    await user.type(screen.getByLabelText("Effective Date"), "2026-05-01");
    await user.clear(screen.getByLabelText("Expiration Date"));
    await user.type(screen.getByLabelText("Expiration Date"), "2026-04-01");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByText("Enter a valid amount")).toBeInTheDocument();
    expect(screen.getByText("Expiration date cannot be earlier than the effective date")).toBeInTheDocument();
    expect(screen.getByLabelText("Amount")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({ method: "PATCH" }));
  });

  it("guards dirty ledger drawer changes before closing", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "UD Glass-Fiber Reinforced Composite Procurement - revised");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const dialog = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("The current changes are unsaved; closing will lose them.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("heading", { name: "JSUS2026004" })).not.toBeInTheDocument();
  });

  it("guards dirty ledger drawer changes before closing with Escape", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.clear(screen.getByLabelText("Project Name"));
    await user.type(screen.getByLabelText("Project Name"), "UD Glass-Fiber Reinforced Composite Procurement - revised");

    fireEvent.keyDown(window, { key: "Escape" });

    const dialog = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
  });

  it("cancels the ledger delete confirmation with Escape without closing the drawer", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog", { name: "Delete contract?" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Delete contract?" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
  });

  it("requires confirmation before deleting a ledger contract and removes it after success", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004" && init?.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const dialog = screen.getByRole("dialog", { name: "Delete contract?" });
    expect(within(dialog).getByText("This will delete contract JSUS2026004 and its archived PDF. This cannot be undone.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByText("Deleted JSUS2026004")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
  });

  it("shows the ledger bulk action bar for selected rows and can cancel selection", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/batch" && init?.method === "POST") {
        return Promise.resolve(new Response(new Blob(["xlsx"], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), { status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:bulk-export");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByLabelText("Select JSUS2026004"));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Export selected" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/batch", expect.objectContaining({
      body: JSON.stringify({ ids: ["JSUS2026004"], action: "export" }),
      headers: expect.objectContaining({ Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      method: "POST"
    }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Exported 1 items")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear selection" }));

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select JSUS2026004")).not.toBeChecked();
  });

  it("clears ledger bulk selection with Escape", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByLabelText("Select JSUS2026004"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Select JSUS2026004")).not.toBeChecked();
  });

  it("requires confirmation before bulk deleting selected ledger rows", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/contracts/batch" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ deleted: 3 }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        const filteredContracts = contracts.filter((contract) => contract.status === "active" && contract.petition_date.startsWith("2026"));
        return Promise.resolve(new Response(JSON.stringify({ data: filteredContracts, total: filteredContracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByLabelText("Select current page"));
    expect(screen.getByRole("region", { name: "Bulk actions" })).toHaveTextContent("3 selected");

    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = screen.getByRole("dialog", { name: "Delete selected contracts?" });
    expect(within(dialog).getByText("This will delete the 3 selected contracts and their archived PDFs. This cannot be undone.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete selected" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/batch", expect.objectContaining({
      body: JSON.stringify({ ids: ["JSUS2026004", "JSUS2026003", "JSUS2026002"], action: "delete" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "POST"
    }));
    expect(screen.getByText("Deleted 3 contracts")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    expect(screen.queryByText("Jushi Group Hong Kong")).not.toBeInTheDocument();
    expect(screen.queryByText("PPG Industries Inc.")).not.toBeInTheDocument();
  });

  it("shows failed ingest rows with the backend error message", async () => {
    const failedRows = [
      {
        contract_id: "FAIL2026001",
        counterparty: "Scan-quality test supplier",
        ingest: {
          stage: "ocr_processing" as const,
          status: "failed" as const,
          last_error: "Recognition quality too low; re-upload a clearer scan"
        },
        updated_at: "just now"
      }
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) {
          return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
        }
        if (url.endsWith("/processing")) {
          return Promise.resolve(new Response(JSON.stringify(failedRows), { status: 200 }));
        }
        return Promise.reject(new Error("unexpected request"));
      })
    );

    render(<App initialPath="/processing" />);

    expect((await screen.findAllByText("Failed")).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Failed: Recognition quality too low; re-upload a clearer scan")).toHaveAttribute(
      "title",
      "Recognition quality too low; re-upload a clearer scan"
    );
  });

  it("shows the no processing records empty state when there are no rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) {
          return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
        }
        if (url.endsWith("/processing")) {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        return Promise.reject(new Error("unexpected request"));
      })
    );

    render(<App initialPath="/processing" />);

    expect(await screen.findByText("No processing records yet")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Processing status table" })).not.toBeInTheDocument();
  });

  it("shows processing overview skeletons while rows are loading", async () => {
    let resolveProcessing: (response: Response) => void = () => undefined;
    const processingResponse = new Promise<Response>((resolve) => {
      resolveProcessing = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/config")) {
          return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
        }
        if (url.endsWith("/processing")) {
          return processingResponse;
        }
        return Promise.reject(new Error("unexpected request"));
      })
    );

    render(<App initialPath="/processing" />);

    expect(screen.getByRole("status", { name: "Loading processing overview" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Processing" })).not.toBeInTheDocument();

    await act(async () => {
      resolveProcessing(new Response(JSON.stringify(processingRows), { status: 200 }));
      await processingResponse;
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: /Processing/ })).toBeInTheDocument();
  });

  it("shows a retryable processing error state when the backend returns an error", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      if (url.endsWith("/processing")) {
        const response = fetchMock.mock.calls.filter(([request]) => String(request).endsWith("/processing")).length === 1
          ? new Response(JSON.stringify({ detail: "database unavailable" }), { status: 500 })
          : new Response(JSON.stringify(processingRows), { status: 200 });
        return Promise.resolve(response);
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/processing" />);

    expect(await screen.findByText("Failed to load: GET /processing failed: 500")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Processing status table" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("table", { name: "Processing status table" })).toBeInTheDocument();
  });

  it("polls unfinished processing rows every five seconds", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(processingRows), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    render(<App initialPath="/processing" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Water-treatment framework supplier")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing")).length).toBeGreaterThan(1);
  });

  it("stops polling processing rows when all rows are done", async () => {
    const settledRows = processingRows.map((row) => ({
      ...row,
      ingest: { ...row.ingest, stage: "done" as const, status: "done" as const }
    }));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(settledRows), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    render(<App initialPath="/processing" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Water-treatment framework supplier")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);
  });

  it("manages the contract version list from settings", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);
    await screen.findByText("File-No. rules");
    const input = await screen.findByLabelText("Add contract version");
    await user.type(input, "Purchase Contract");
    await user.click(screen.getByRole("button", { name: "Add version" }));
    expect(await screen.findByText("Purchase Contract")).toBeInTheDocument();
  });

  it("lets the user pick a contract version before tagging pages", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "version-select.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("Choose PDF file"), pdf);
    expect((await screen.findAllByText("version-select.pdf · 14 pages · 0.0 MB")).length).toBeGreaterThan(0);

    const select = await screen.findByLabelText("Contract Version");
    await userEvent.selectOptions(select, "Service Agreement");
    expect((select as HTMLSelectElement).value).toBe("Service Agreement");
  });

  it("offers whole and contract-only download from the ledger row menu", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/contracts/JSUS2026004/file") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url === "/api/contracts/JSUS2026004/file?scope=contract") {
        return Promise.resolve(new Response(new Blob(["%PDF-1.7"], { type: "application/pdf" }), { status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    const createObjectURL = vi.fn(() => "blob:contract-pdf-scoped");
    const revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 160, clientY: 220 });

    expect(screen.getByRole("button", { name: "Full" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contract only" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Contract only" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contracts/JSUS2026004/file?scope=contract",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) })
    );
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("Downloaded JSUS2026004-contract.pdf")).toBeInTheDocument();
  });

  it("renders mixed Q&A evidence and opens the source verification page", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/query") {
        return Promise.resolve(new Response(JSON.stringify({
          question: "For contracts with payment terms over 60 days, how is liability for late payment specified?",
          answer: "1 contract matches payment terms over 60 days; late payment accrues a daily penalty of 0.05%.",
          evidence: [
            {
              kind: "record",
              contract_id: "JSUS2026004",
              title: "Owens Corning Composites",
              fields: { "Payment terms": "90 days", "Amount": "USD 147,664.05" }
            },
            {
              kind: "clause",
              contract_id: "JSUS2026004",
              page: 8,
              section: "Payment",
              snippet: "late payment shall bear liquidated damages at 0.05% per day",
              bbox: [0.12, 0.34, 0.42, 0.08]
            }
          ]
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    expect(await screen.findByRole("link", { name: "Q&A" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Contract Q&A" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Enter a contract question"), "For contracts with payment terms over 60 days, how is liability for late payment specified?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "For contracts with payment terms over 60 days, how is liability for late payment specified?",
          contract_id: null,
          conversation_id: null,
          scope_type: "all",
          scope_value: null
        })
      })
    ));
    expect(await screen.findByText("1 contract matches payment terms over 60 days; late payment accrues a daily penalty of 0.05%.")).toBeInTheDocument();

    const recordTable = screen.getByRole("table", { name: "Matched contract evidence" });
    expect(within(recordTable).getByRole("columnheader", { name: "Payment terms" })).toBeInTheDocument();
    expect(within(recordTable).getByRole("cell", { name: "90 days" })).toBeInTheDocument();
    expect(screen.getByText("JSUS2026004 · p. 8 · Payment")).toBeInTheDocument();
    expect(screen.getByText("late payment shall bear liquidated damages at 0.05% per day")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verify source" }));

    const dialog = await screen.findByRole("dialog", { name: "Source verification" });
    expect(document.body).toHaveClass("modal-open");
    expect(within(dialog).queryByRole("button", { name: "Previous page" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("qa-verify-stage")).toHaveClass("qa-verify-stage-single-page");
    expect(within(dialog).getByRole("button", { name: "Rotate left 90°" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Rotate right 90°" })).toBeInTheDocument();
    expect(within(dialog).getByAltText("JSUS2026004 page 8 source")).toHaveAttribute("src", "/api/contracts/JSUS2026004/pages/8");
    expect(within(dialog).getByTestId("source-highlight")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open in new window" })).toHaveAttribute("href", "/api/contracts/JSUS2026004/pages/8");

    const page = within(dialog).getByTestId("qa-page-image-wrap");
    expect(page).toHaveStyle({ transform: "rotate(0deg)" });
    await user.click(within(dialog).getByRole("button", { name: "Rotate right 90°" }));
    expect(page).toHaveStyle({ transform: "rotate(90deg)" });
    await user.click(within(dialog).getByRole("button", { name: "Rotate left 90°" }));
    expect(page).toHaveStyle({ transform: "rotate(0deg)" });

    await user.click(within(dialog).getByRole("button", { name: "Close source verification" }));
    await waitFor(() => expect(document.body).not.toHaveClass("modal-open"));
  });

  it("submits Q&A with an explicit supplier scope", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/query") {
        return Promise.resolve(new Response(JSON.stringify({
          question: "What are the payment terms?",
          answer: "Owens-related contracts have payment terms of 90 days.",
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    await user.selectOptions(await screen.findByLabelText("Scope type"), "supplier");
    await user.type(screen.getByLabelText("Scope value"), "Owens Corning");
    await user.type(screen.getByLabelText("Enter a contract question"), "What are the payment terms?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "What are the payment terms?",
          contract_id: null,
          conversation_id: null,
          scope_type: "supplier",
          scope_value: "Owens Corning"
        })
      })
    ));
    expect(await screen.findByText("Owens-related contracts have payment terms of 90 days.")).toBeInTheDocument();
  });

  it("warns and locks the composer when the conversation hits its message cap", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/query") {
        return Promise.resolve(new Response(JSON.stringify({
          question: "when does it expire",
          answer: "The expiration date is December 31, 2026.",
          conversation_id: null,
          conversation_full: true,
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    await user.type(await screen.findByLabelText("Enter a contract question"), "when does it expire");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("The expiration date is December 31, 2026.")).toBeInTheDocument();
    expect(await screen.findByText(/This conversation has reached its length limit/)).toBeInTheDocument();
    expect(screen.getByLabelText("Enter a contract question")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start new conversation" })).toBeInTheDocument();
  });

  it("moves a submitted Q&A question into the thread while the answer is loading", async () => {
    const user = userEvent.setup();
    let resolveQuery: (response: Response) => void = () => undefined;
    const pendingQuery = new Promise<Response>((resolve) => {
      resolveQuery = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/query") {
        return pendingQuery;
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    const input = await screen.findByLabelText("Enter a contract question");
    await user.type(input, "what are all the currently active contracts");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("what are all the currently active contracts")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByText("Searching the contract corpus")).toBeInTheDocument();
    expect(screen.getByText("Analyzing ledger records and source text to produce a verifiable answer…")).toBeInTheDocument();

    resolveQuery(new Response(JSON.stringify({
      question: "what are all the currently active contracts",
      answer: "There are 3 active contracts.",
      evidence: []
    }), { headers: { "Content-Type": "application/json" }, status: 200 }));

    expect(await screen.findByText("There are 3 active contracts.")).toBeInTheDocument();
  });

  it("submits Q&A with Enter and keeps Shift Enter as a newline", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/query") {
        return Promise.resolve(new Response(JSON.stringify({
          question: "Line 1\nLine 2",
          answer: "Searched by the multi-line question.",
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    const input = await screen.findByLabelText("Enter a contract question");
    await user.type(input, "Line 1");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "Line 2");

    expect(input).toHaveValue("Line 1\nLine 2");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/query", expect.anything());

    await user.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "Line 1\nLine 2",
          contract_id: null,
          conversation_id: null,
          scope_type: "all",
          scope_value: null
        })
      })
    ));
    expect(await screen.findByText("Searched by the multi-line question.")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("keeps the Q&A shell fixed while only history and chat content scroll", async () => {
    render(<App initialPath="/qa" />);

    expect(await screen.findByText("Chat history")).toBeInTheDocument();
    const qaPage = document.querySelector(".qa-page");
    const history = document.querySelector(".qa-history");
    const historyList = screen.getByLabelText("Chat history list");
    const workspace = document.querySelector(".qa-workspace");
    const thread = document.querySelector(".qa-thread");

    expect(qaPage).not.toBeNull();
    expect(history).not.toBeNull();
    expect(workspace).not.toBeNull();
    expect(thread).not.toBeNull();

    expect(qaPage).toHaveClass("qa-page");
    expect(history).toHaveClass("qa-history");
    expect(historyList).toHaveClass("qa-history-list");
    expect(workspace).toHaveClass("qa-workspace");
    expect(thread).toHaveClass("qa-thread");
  });

  it("loads Q&A conversation history, starts a new conversation, and confirms deletion", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations" && !init?.method) {
        const items = deleted ? [] : [{ conversation_id: "c1", title: "Active contract", created_at: "2026-06-18T00:00:00Z", updated_at: "2026-06-18T00:01:00Z", message_count: 2 }];
        return Promise.resolve(new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ conversation_id: "c2", title: "New conversation", created_at: "2026-06-18T00:02:00Z", updated_at: "2026-06-18T00:02:00Z", message_count: 0 }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c1" && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/qa/conversations/c1") {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: "c1",
          title: "Active contract",
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:01:00Z",
          message_count: 2,
          messages: [
            { message_id: "m1", conversation_id: "c1", role: "user", content: "what are all the currently active contracts", evidence: [], created_at: "2026-06-18T00:00:00Z" },
            { message_id: "m2", conversation_id: "c1", role: "assistant", content: "There are 3 active contracts.", evidence: [], created_at: "2026-06-18T00:01:00Z" }
          ]
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c2") {
        return Promise.resolve(new Response(JSON.stringify({ conversation_id: "c2", title: "New conversation", created_at: "2026-06-18T00:02:00Z", updated_at: "2026-06-18T00:02:00Z", message_count: 0, messages: [] }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    expect(await screen.findByText("Chat history")).toBeInTheDocument();
    expect(await screen.findByText("Active contract")).toBeInTheDocument();

    await user.click(screen.getByText("Active contract"));
    expect(await screen.findByText("what are all the currently active contracts")).toBeInTheDocument();
    expect(await screen.findByText("There are 3 active contracts.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByText("Ask the contract corpus")).toBeInTheDocument();

    await user.click(screen.getByText("Active contract"));
    await user.hover(screen.getByText("Active contract"));
    await user.click(screen.getByRole("button", { name: "Delete Active contract" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete conversation?" });
    expect(within(dialog).getByText('This will delete "Active contract" and all of its Q&A records. This cannot be undone.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/qa/conversations/c1", expect.objectContaining({ method: "DELETE" })));
  });

  it("restores the active Q&A conversation after navigating away and back in the same tab", async () => {
    const user = userEvent.setup();
    window.sessionStorage.clear();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/config") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations" && !init?.method) {
        return Promise.resolve(new Response(JSON.stringify([
          { conversation_id: "c1", title: "Active contract", created_at: "2026-06-18T00:00:00Z", updated_at: "2026-06-18T00:01:00Z", message_count: 2 }
        ]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c1") {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: "c1",
          title: "Active contract",
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:01:00Z",
          message_count: 2,
          messages: [
            { message_id: "m1", conversation_id: "c1", role: "user", content: "what are all the currently active contracts", evidence: [], created_at: "2026-06-18T00:00:00Z" },
            { message_id: "m2", conversation_id: "c1", role: "assistant", content: "There are 3 active contracts.", evidence: [], created_at: "2026-06-18T00:01:00Z" }
          ]
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.startsWith("/api/contracts")) {
        return Promise.resolve(new Response(JSON.stringify({ data: contracts, total: contracts.length }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    await user.click(await screen.findByText("Active contract"));
    expect(await screen.findByText("There are 3 active contracts.")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Ledger" }));
    expect(await screen.findByRole("heading", { name: "Contract ledger" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Q&A" }));

    expect(await screen.findByText("what are all the currently active contracts")).toBeInTheDocument();
    expect(screen.getByText("There are 3 active contracts.")).toBeInTheDocument();
  });
});
