import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, vi } from "vitest";
import App from "../App";
import { getContracts, getProcessingRows } from "../api/client";
import { configState, conflicts, contracts, processingRows } from "../api/mockData";

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
  it("renders the fixed navigation and keeps ingest and Excel sync statuses separate", async () => {
    render(<App />);

    expect(screen.getByText("合同登记系统")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "台账" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "入库与同步" })).toBeInTheDocument();

    const table = await screen.findByRole("table", { name: "入库与同步状态表" });
    expect(within(table).getByRole("columnheader", { name: "入库状态" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Excel 同步状态" })).toBeInTheDocument();
    expect(within(table).getByText("进行中 · 嵌入中")).toBeInTheDocument();
    expect(within(table).getByText("待确认冲突")).toBeInTheDocument();
  });

  it("keeps the sidebar runtime status aligned to the config API", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, ragEnabled: true, excelEnabled: false }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(processingRows), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    }));

    render(<App initialPath="/processing" />);

    expect(await screen.findByText("RAG 开启 · 仅数据库")).toBeInTheDocument();
  });

  it("filters processing rows from the overview metric cards", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/processing" />);

    await screen.findByRole("table", { name: "入库与同步状态表" });
    expect(screen.getByText("Jushi Egypt For Fiberglass Industry S.A.E")).toBeInTheDocument();
    expect(screen.getByText("水处理框架供应商")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "待确认冲突 1" }));

    expect(screen.getByText("筛选：待确认冲突")).toBeInTheDocument();
    expect(screen.getByText("Jushi Egypt For Fiberglass Industry S.A.E")).toBeInTheDocument();
    expect(screen.queryByText("水处理框架供应商")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清除状态筛选" }));
    expect(screen.getByText("水处理框架供应商")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试中 1" }));
    expect(screen.getByText("水处理框架供应商")).toBeInTheDocument();
    expect(screen.queryByText("Jushi Egypt For Fiberglass Industry S.A.E")).not.toBeInTheDocument();
  });

  it("lets the conflict page choose a manual resolution value", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    const manualChoices = await screen.findAllByLabelText("手动输入");
    await user.click(manualChoices[0]);
    const manualInput = screen.getByPlaceholderText("输入要保留的值");
    expect(manualInput).toHaveFocus();
    await user.type(manualInput, "巨石埃及玻璃纤维工业");

    expect(screen.getByText("本次将采用：")).toBeInTheDocument();
    expect(screen.getByText(/counterparty=手动/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("巨石埃及玻璃纤维工业")).toBeInTheDocument();
  });

  it("blocks conflict merge when a manual resolution is empty", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    const manualChoices = await screen.findAllByLabelText("手动输入");
    await user.click(manualChoices[0]);
    await user.click(screen.getByRole("button", { name: "确认合并" }));

    expect(screen.getByText("还有 1 个字段未选择")).toBeInTheDocument();
    expect(screen.queryByText("已合并 JSEGRCXS20260003，生成新基线")).not.toBeInTheDocument();
  });

  it("returns to processing from the conflict footer cancel action", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    await user.click(await screen.findByRole("link", { name: "取消" }));

    expect(screen.getByRole("heading", { name: "入库与同步" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "入库与同步状态表" })).toBeInTheDocument();
  });

  it("returns to processing from the conflict page with Escape", async () => {
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    await screen.findByText("冲突字段（3）");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByRole("heading", { name: "入库与同步" })).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "入库与同步状态表" })).toBeInTheDocument();
  });

  it("expands and collapses readonly consistent fields on the conflict page", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    expect(await screen.findByText("冲突字段（3）")).toBeInTheDocument();
    expect(screen.queryByText("无冲突字段（3）")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "展开全部字段" }));

    expect(screen.getByText("无冲突字段（3）")).toBeInTheDocument();
    expect(screen.getByText("project_name")).toBeInTheDocument();
    expect(screen.getAllByText("一致")).toHaveLength(3);
    expect(screen.getAllByText("UD 玻纤增强复合材料采购")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText("无冲突字段（3）")).not.toBeInTheDocument();
  });

  it("shows a resolved empty state when a contract has no conflicts left", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith("/conflict")) {
          return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
        }
        return Promise.reject(new Error("unexpected request"));
      })
    );
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    expect(await screen.findByText("该合同的冲突已被解决")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "返回" }).some((link) => link.getAttribute("href") === "/processing")).toBe(true);
    expect(screen.queryByRole("button", { name: "确认合并" })).not.toBeInTheDocument();
  });

  it("shows a retryable conflict error state when the backend returns an error", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/conflict")) {
        attempts += 1;
        if (attempts === 1) {
          return Promise.resolve(new Response(JSON.stringify({ error: "conflict service unavailable" }), { headers: { "Content-Type": "application/json" }, status: 500 }));
        }
        return Promise.resolve(new Response(JSON.stringify(conflicts), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    expect(await screen.findByText(/加载失败/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByText("冲突字段（3）")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/conflict")).length).toBeGreaterThan(1);
  });

  it("walks through the upload wizard from file selection to field confirmation", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "supply-contract.pdf", { type: "application/pdf" });

    expect(screen.getByText("拖拽 PDF 到此处，或点击选择")).toBeInTheDocument();
    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);

    expect(await screen.findByText(/上传中/)).toBeInTheDocument();
    expect((await screen.findAllByText("supply-contract.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));

    expect(screen.getByText("逐页标注：审批 / 合同 / 其他")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect(screen.getByText("确认登记字段")).toBeInTheDocument();
    expect(screen.getByText("登记字段")).toBeInTheDocument();
    expect(screen.getByText("确认入账")).toBeInTheDocument();
  });

  it("requires every page tagged plus an approval and contract page before extracting", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "approval-required.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("approval-required.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));

    const extractButton = screen.getByRole("button", { name: "下一步：抽取字段" });
    expect(extractButton).toBeDisabled();                                   // nothing tagged yet

    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));        // brush defaults to 审批
    expect(extractButton).toBeDisabled();                                   // other pages still untagged

    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);

    const uploadCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/ingest/upload");
    expect(uploadCall?.[1]?.body).toBeInstanceOf(FormData);
    expect((uploadCall?.[1]?.body as FormData).get("file")).toBe(pdf);

    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect(await screen.findByDisplayValue("API2026001")).toBeInTheDocument();
    expect(screen.getByDisplayValue("API Counterparty LLC")).toBeInTheDocument();
    await user.type(screen.getByLabelText("生效日"), "2026-06-01");
    await user.type(screen.getByLabelText("到期日"), "2027-06-01");
    await user.selectOptions(screen.getByLabelText("存档分类"), "china-buy");
    await user.click(screen.getByRole("button", { name: "确认入账" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ingest/task-42/confirm", expect.objectContaining({
      body: JSON.stringify({
        fields: { ...extractedFields, effective_date: "2026-06-01", expiration_date: "2027-06-01" },
        effective_date: "2026-06-01",
        expiration_date: "2027-06-01",
        category: "china-buy"
      }),
      method: "POST"
    })));
    expect(await screen.findByText("已入账 API2026001")).toBeInTheDocument();
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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("api-contract.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));
    await user.type(await screen.findByLabelText("生效日"), "2026-06-01");
    await user.type(screen.getByLabelText("到期日"), "2027-06-01");
    await user.click(screen.getByRole("button", { name: "确认入账" }));

    const dialog = await screen.findByRole("dialog", { name: "覆盖已有合同？" });
    expect(within(dialog).getByText("合同 API2026001 已存在，入账将覆盖原数据（含向量库与存档），是否继续？")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "确认登记字段" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "确认覆盖" }));

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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("loading-fields.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect(await screen.findByRole("heading", { name: "确认登记字段" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在抽取字段" })).toBeInTheDocument();
    expect(screen.getAllByText("小模型结构化字段，生成登记表单中…").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "确认入账" })).toBeDisabled();

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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("missing-id.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect(await screen.findByText("未识别到合同编号，请手填")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认入账" })).toBeDisabled();
  });

  it("focuses the first invalid upload field when confirmation validation fails", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "invalid-dates.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("invalid-dates.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));
    await user.type(screen.getByLabelText("生效日"), "2027-04-15");
    await user.type(screen.getByLabelText("到期日"), "2026-04-14");

    await user.click(screen.getByRole("button", { name: "确认入账" }));

    expect(screen.getByText("到期日不能早于生效日")).toBeInTheDocument();
    expect(screen.getByLabelText("到期日")).toHaveFocus();
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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("extract-failure.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect((await screen.findAllByText("抽取失败，请重试")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "下一步：抽取字段" })).toBeEnabled();
    expect(screen.getByText("逐页标注：审批 / 合同 / 其他")).toBeInTheDocument();
    expect(screen.getAllByText("抽取失败，请重试").some((node) => node.closest(".toast")?.classList.contains("toast-error"))).toBe(true);
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

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("blurred-scan.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect((await screen.findAllByText("识别质量过低，请重传更清晰的扫描件")).length).toBeGreaterThan(0);
    expect(screen.getByText("拖拽 PDF 到此处，或点击选择")).toBeInTheDocument();
    expect(screen.getAllByText("识别质量过低，请重传更清晰的扫描件").some((node) => node.closest(".toast")?.classList.contains("toast-error"))).toBe(true);
  });

  it("rejects non-PDF files in the upload wizard", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const image = new File(["not a contract"], "contract.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("选择 PDF 文件"), image);

    expect(screen.getByText("仅支持 PDF")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  });

  it("requires missing dates before confirming upload entry and then opens the contract detail", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "signed_2026005_OwensCorning.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("signed_2026005_OwensCorning.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "下一步" }));
    await user.click(screen.getByRole("button", { name: /标注第 2 页/ }));
    await user.click(screen.getByRole("button", { name: "其余设为合同" }));
    await user.click(screen.getByRole("button", { name: "下一步：抽取字段" }));

    expect(screen.getByRole("button", { name: "确认入账" })).toBeDisabled();

    await user.type(screen.getByLabelText("生效日"), "2026-04-15");
    await user.type(screen.getByLabelText("到期日"), "2027-04-14");
    await user.click(screen.getByRole("button", { name: "确认入账" }));

    expect(await screen.findByText("已入账 JSUS2026005")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JSUS2026005" })).toBeInTheDocument();
    expect(screen.getAllByText("Owens Corning Composites").length).toBeGreaterThan(0);
  });

  it("requires confirmation before disabling Excel sync", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.click(await screen.findByRole("button", { name: "Excel 同步" }));

    const dialog = screen.getByRole("dialog", { name: "关闭 Excel 同步？" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText(/关闭后系统仅写入数据库/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认关闭" }));
    expect(screen.getByRole("heading", { name: "Excel 同步 已关闭" })).toBeInTheDocument();
  });

  it("greys out the processing sync column and disables sync actions when Excel sync is off", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.click(await screen.findByRole("button", { name: "Excel 同步" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));
    await user.click(screen.getByRole("link", { name: "入库与同步" }));

    const table = await screen.findByRole("table", { name: "入库与同步状态表" });
    expect(within(table).getAllByText("已禁用 ⊘")).toHaveLength(4);
    expect(within(table).queryByRole("button", { name: "立即重试" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "解决冲突" })).not.toBeInTheDocument();
    expect(within(table).getAllByText("完成").length).toBeGreaterThan(0);
  });

  it("honors an initially disabled Excel sync configuration from the API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, excelEnabled: false }), { status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(processingRows), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    expect(await screen.findByRole("heading", { name: "Excel 同步 已关闭" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "入库与同步" }));
    const table = await screen.findByRole("table", { name: "入库与同步状态表" });
    expect(within(table).getAllByText("已禁用 ⊘")).toHaveLength(4);
  });

  it("persists disabling Excel sync through the config API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ ...configState, excelEnabled: false }), { status: 200 }));
      }
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.click(await screen.findByRole("button", { name: "Excel 同步" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config", expect.objectContaining({
      body: JSON.stringify({ excelEnabled: false }),
      method: "PATCH"
    })));
    expect(screen.getByRole("heading", { name: "Excel 同步 已关闭" })).toBeInTheDocument();
  });

  it("rolls back a settings toggle when saving config fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config") && init?.method === "PATCH") {
        return Promise.resolve(new Response(JSON.stringify({ error: "config locked" }), { status: 500 }));
      }
      if (url.endsWith("/config")) {
        return Promise.resolve(new Response(JSON.stringify(configState), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);

    await user.click(await screen.findByRole("button", { name: "Excel 同步" }));
    await user.click(screen.getByRole("button", { name: "确认关闭" }));

    const failureToast = await screen.findByText(/保存失败/);
    expect(failureToast).toBeInTheDocument();
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("heading", { name: "Excel 同步 开启中" })).toBeInTheDocument();
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

    const prefixInput = await screen.findByLabelText("china-buy 前缀");
    await user.clear(prefixInput);
    await user.type(prefixInput, "CB");
    await user.click(screen.getByRole("button", { name: "保存编号规则" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/config/file-no-rules", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({
        ordinary: { prefix: "" },
        "china-buy": { prefix: "CB" },
        production: { prefix: "PD" }
      })
    })));
    expect(await screen.findByText("已保存存档编号规则")).toBeInTheDocument();
    expect(screen.getByLabelText("china-buy 前缀")).toHaveValue("CB");
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

    await user.type(await screen.findByLabelText("ordinary 前缀"), "CN");
    await user.click(screen.getByRole("button", { name: "保存编号规则" }));

    expect(screen.getByText("前缀不能重复")).toBeInTheDocument();
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

    expect(screen.getByRole("status", { name: "正在加载设置" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Excel 同步" })).not.toBeInTheDocument();

    resolveConfig(new Response(JSON.stringify(configState), { headers: { "Content-Type": "application/json" }, status: 200 }));
    expect(await screen.findByRole("button", { name: "Excel 同步" })).toBeInTheDocument();
  });

  it("toggles ledger column visibility from the column configuration menu", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    expect(await screen.findByRole("columnheader", { name: "申请人" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "列配置" }));
    await user.click(screen.getByLabelText("申请人"));

    expect(screen.queryByRole("columnheader", { name: "申请人" })).not.toBeInTheDocument();
  });

  it("reorders ledger columns from the column configuration menu and persists the order", async () => {
    const user = userEvent.setup();
    installLedgerColumnStorage();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(getLedgerHeaderText().indexOf("文件名")).toBeLessThan(getLedgerHeaderText().indexOf("合同金额"));

    await user.click(screen.getByRole("button", { name: "列配置" }));
    await user.click(screen.getByRole("button", { name: "上移 合同金额" }));

    expect(getLedgerHeaderText().indexOf("合同金额")).toBeLessThan(getLedgerHeaderText().indexOf("文件名"));
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
    expect(getLedgerHeaderText().indexOf("合同金额")).toBeLessThan(getLedgerHeaderText().indexOf("文件名"));
  });

  it("renders the ledger as a grouped 17-column wide table using the interface fields", async () => {
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    expect(screen.getByRole("scrollbar", { name: "台账横向滚动条" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "主键" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "基本信息" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "金额" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "归口" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "日期" })).toBeInTheDocument();
    expect(within(table).getAllByRole("columnheader", { name: "状态" }).length).toBeGreaterThan(0);

    const headerText = getLedgerHeaderText();
    expect(headerText).toEqual([
      "选择当前页",
      "合同编号",
      "对方公司",
      "项目名称",
      "合同版本",
      "存档编号",
      "文件名",
      "合同金额",
      "币种",
      "合同期",
      "年均价",
      "申请人",
      "登记日期",
      "生效日",
      "到期日",
      "状态",
      "操作"
    ]);
    expect(headerText).toHaveLength(17);
    expect(screen.getByText("Supply Agreement")).toBeInTheDocument();
    expect(screen.getByText("2026004")).toBeInTheDocument();
    expect(screen.getByText("2026004-JSUS2026004-UD 玻纤增强复合材料采购")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "付款方式" })).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "归档" })).not.toBeInTheDocument();
  });

  it("filters ledger rows by search text and sorts amount descending", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "PPG");

    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"));
    await user.click(screen.getByRole("button", { name: "金额 排序" }));
    await user.click(screen.getByRole("button", { name: "金额 升序" }));

    const rows = getLedgerDataRows();
    expect(within(rows[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();
  });

  it("filters ledger rows with multi-select chips", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    await user.click(screen.getByRole("button", { name: "部门筛选" }));

    const departmentMenu = screen.getByRole("menu", { name: "部门筛选选项" });
    await user.click(within(departmentMenu).getByLabelText("FPW"));

    expect(await screen.findByText("Jushi Group Hong Kong")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("department")).toBe("FPW"));

    await user.click(within(departmentMenu).getByLabelText("PD"));

    expect(screen.getByRole("button", { name: "部门筛选" })).toHaveTextContent("部门：2 项");
    expect(screen.getByText("Jushi Group Hong Kong")).toBeInTheDocument();
    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("department")).toBe("FPW,PD"));

    await user.click(within(departmentMenu).getByLabelText("全部"));

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
    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "PPG");

    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("q=PPG"))).toHaveLength(0);

    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes("q=PPG"))).toBe(true));
  });

  it("virtualizes the ledger body when more than 200 rows are rendered", async () => {
    const largeContracts = Array.from({ length: 260 }, (_, index) => ({
      ...contracts[index % contracts.length],
      contract_id: `BULK${String(index + 1).padStart(4, "0")}`,
      counterparty: `批量供应商 ${String(index + 1).padStart(4, "0")}`,
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

    expect(await screen.findByText("批量供应商 0001")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "台账表格虚拟滚动区域" })).toBeInTheDocument();
    expect(getLedgerDataRows().length).toBeLessThan(260);
  });

  it("cycles the ledger amount sort through ascending descending and none", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    const amountSort = screen.getByRole("button", { name: "金额 排序" });

    await user.click(amountSort);
    expect(screen.getByRole("button", { name: "金额 升序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=amount_asc"));

    await user.click(screen.getByRole("button", { name: "金额 升序" }));
    expect(screen.getByRole("button", { name: "金额 降序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=amount_desc"));

    await user.click(screen.getByRole("button", { name: "金额 降序" }));
    expect(screen.getByRole("button", { name: "金额 排序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).not.toContain("sort="));
  });

  it("sorts ledger by the documented contract id counterparty amount and date headers", async () => {
    const user = userEvent.setup();
    window.history.pushState({}, "", "/ledger");
    render(<App />);

    await screen.findByText("Owens Corning Composites");
    expect(screen.getByRole("button", { name: "合同编号 排序" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对方公司 排序" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "金额 排序" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生效日 排序" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目名称 排序" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "对方公司 排序" }));
    expect(screen.getByRole("button", { name: "对方公司 升序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=counterparty_asc"));
    expect(within(getLedgerDataRows()[0]).getByText("Jushi Group Hong Kong")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "对方公司 升序" }));
    expect(screen.getByRole("button", { name: "对方公司 降序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=counterparty_desc"));
    expect(within(getLedgerDataRows()[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "生效日 排序" }));
    expect(screen.getByRole("button", { name: "生效日 升序" })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toContain("sort=effective_date_asc"));
    expect(within(getLedgerDataRows()[0]).getByText("PPG Industries Inc.")).toBeInTheDocument();
  });

  it("shows a filter empty state and can clear ledger filters", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "no such contract");

    expect(await screen.findByText("没有匹配的合同，试试调整筛选")).toBeInTheDocument();
    expect(screen.queryByText("还没有合同，点「上传合同」开始登记")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "清除筛选" }));

    expect(await screen.findByText("Owens Corning Composites")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名")).toHaveValue("");
  });

  it("preserves ledger search filters when returning from contract detail", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    const search = screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名");
    await user.type(search, "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });
    await user.click(await screen.findByRole("link", { name: "返回" }));

    expect(await screen.findByRole("heading", { name: "合同台账" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名")).toHaveValue("PPG");
    expect(screen.getByText("PPG Industries Inc.")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
  });

  it("restores the ledger scroll position when returning from contract detail", async () => {
    const user = userEvent.setup();
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 480 });
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    render(<App initialPath="/ledger" />);

    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });
    await user.click(await screen.findByRole("link", { name: "返回" }));

    expect(await screen.findByRole("heading", { name: "合同台账" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名")).toHaveValue("PPG");
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 480, behavior: "auto" }));
  });

  it("returns from contract detail with Escape while preserving ledger filters", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "PPG");
    const row = (await screen.findByText("PPG Industries Inc.")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.keyDown(row!, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "JSUS2026002" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(await screen.findByRole("heading", { name: "合同台账" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名")).toHaveValue("PPG");
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
    expect(screen.getByRole("button", { name: "导出 Excel" })).toBeEnabled();

    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "no such contract");

    expect(await screen.findByRole("button", { name: "导出 Excel" })).toBeDisabled();
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
    await user.type(screen.getByPlaceholderText("搜索合同编号 / 对方公司 / 项目名"), "Owens");
    const exportButton = screen.getByRole("button", { name: "导出 Excel" });
    await user.click(exportButton);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/contracts\/export\?.*q=Owens/), expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已导出当前筛选结果")).toBeInTheDocument();
  });

  it("opens the ledger context menu at the right-click cursor position", async () => {
    render(<App initialPath="/ledger" />);

    const row = (await screen.findByText("Owens Corning Composites")).closest("tr");
    expect(row).not.toBeNull();

    fireEvent.contextMenu(row!, { clientX: 160, clientY: 220 });

    const menu = screen.getByRole("menu", { name: "行操作 JSUS2026004" });
    expect(menu).toHaveStyle({ left: "160px", top: "220px" });
    expect(within(menu).getByText("JSUS2026004")).toBeInTheDocument();
    expect(within(menu).getByRole("link", { name: "查看详情" })).toHaveAttribute("href", "/contracts/JSUS2026004");
  });

  it("opens the same ledger row menu from the fallback more button without opening the drawer", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await screen.findByText("Owens Corning Composites");
    await user.click(screen.getByRole("button", { name: "更多操作 JSUS2026004" }));

    const menu = screen.getByRole("menu", { name: "行操作 JSUS2026004" });
    expect(within(menu).getByRole("link", { name: "查看详情" })).toHaveAttribute("href", "/contracts/JSUS2026004");
    expect(within(menu).getByRole("button", { name: "编辑" })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "复制编号" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(await screen.findByText("已复制 JSUS2026004")).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: "整份" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004/file", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已下载 2026004-JSUS2026004-UD 玻纤增强复合材料采购")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "下载 PDF" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004/file", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已下载 JSUS2026004 signed.pdf")).toBeInTheDocument();
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
    expect(previewError).toHaveTextContent(/无法加载 PDF/);
    await user.click(within(previewError).getByRole("button", { name: "下载文件" }));

    expect(fileRequests).toBe(2);
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已下载 JSUS2026004 signed.pdf")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const menu = screen.getByRole("menu", { name: "详情操作 JSUS2026004" });
    expect(within(menu).queryByRole("link", { name: "查看详情" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "下载 PDF" })).toBeInTheDocument();
    await user.click(within(menu).getByRole("button", { name: "复制编号" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(await screen.findByText("已复制 JSUS2026004")).toBeInTheDocument();
  });

  it("uses the irreversible archive warning for detail delete confirmation", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/contracts/JSUS2026004" />);

    await screen.findByRole("heading", { name: "JSUS2026004" });
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("button", { name: "删除" }));

    const dialog = screen.getByRole("dialog", { name: "删除合同？" });
    expect(within(dialog).getByText("将删除合同 JSUS2026004 及其存档 PDF，不可恢复。")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "删除" })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "更多操作" }));
    await user.click(screen.getByRole("button", { name: "复制编号" }));

    expect(writeText).toHaveBeenCalledWith("JSUS2026004");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copyBuffer).toHaveAttribute("id", "clipboard-copy-buffer");
    expect(copyBuffer).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("menu", { name: "详情操作 JSUS2026004" })).not.toBeInTheDocument();
    expect(await screen.findByText("已复制 JSUS2026004")).toBeInTheDocument();
  });

  it("opens the contract detail edit drawer and saves changes", async () => {
    const user = userEvent.setup();
    const updatedContract = { ...contracts[0], project_name: "UD 详情页编辑保存" };
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
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "UD 详情页编辑保存");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({
      body: JSON.stringify({ project_name: "UD 详情页编辑保存" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "PATCH"
    }));
    expect(await screen.findByText("已保存 JSUS2026004")).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "详情页失败后保留");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    const failureToast = await screen.findByText("保存失败：该合同已被他处修改，请刷新后重试");
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("complementary", { name: "编辑合同 JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("详情页失败后保留");
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

    expect(await screen.findByText(/加载失败：GET \/contracts.*failed: 500/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

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

    expect(await screen.findByText("加载失败：GET /contracts/JSUS2026004 failed: 500")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByText("Owens Corning Composites · UD 玻纤增强复合材料采购")).toBeInTheDocument();
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
    const updatedContract = { ...contracts[0], project_name: "UD 玻纤增强复合材料采购 - 修订" };
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
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "UD 玻纤增强复合材料采购 - 修订");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({
      body: JSON.stringify({ project_name: "UD 玻纤增强复合材料采购 - 修订" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "PATCH"
    }));
    expect(screen.getByText("已保存 JSUS2026004")).toBeInTheDocument();
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
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "保存失败后保留的项目名");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    const failureToast = await screen.findByText(/保存失败/);
    expect(failureToast.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("complementary", { name: "编辑合同 JSUS2026004" })).toBeInTheDocument();
    expect(screen.getByLabelText("项目名称")).toHaveValue("保存失败后保留的项目名");
  });

  it("shows the business status tag in the ledger drawer header", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));

    const drawer = screen.getByRole("complementary", { name: "编辑合同 JSUS2026004" });
    const header = drawer.querySelector("header") as HTMLElement;
    expect(within(drawer).getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
    expect(within(header).getByText("生效中")).toBeInTheDocument();
  });

  it("keeps business status options aligned to the interface enum", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    expect(screen.queryByRole("option", { name: "状态：待确认" })).not.toBeInTheDocument();

    await user.click(await screen.findByText("Owens Corning Composites"));
    const statusSelect = screen.getByLabelText("业务状态") as HTMLSelectElement;

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
    await user.selectOptions(screen.getByLabelText("部门"), "FPW");
    await user.selectOptions(screen.getByLabelText("合同版本"), "Framework");
    await user.selectOptions(screen.getByLabelText("币种"), "CNY");
    await user.clear(screen.getByLabelText("登记日期"));
    await user.type(screen.getByLabelText("登记日期"), "2026-05-02");
    await user.selectOptions(screen.getByLabelText("业务状态"), "expired");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

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
    await user.clear(screen.getByLabelText("合同金额"));
    await user.type(screen.getByLabelText("合同金额"), "abc");
    await user.clear(screen.getByLabelText("生效日"));
    await user.type(screen.getByLabelText("生效日"), "2026-05-01");
    await user.clear(screen.getByLabelText("到期日"));
    await user.type(screen.getByLabelText("到期日"), "2026-04-01");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    expect(screen.getByText("请输入有效金额")).toBeInTheDocument();
    expect(screen.getByText("到期日不能早于生效日")).toBeInTheDocument();
    expect(screen.getByLabelText("合同金额")).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({ method: "PATCH" }));
  });

  it("guards dirty ledger drawer changes before closing", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));

    expect(screen.getByRole("button", { name: "保存修改" })).toBeDisabled();
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "UD 玻纤增强复合材料采购 - 修订");
    expect(screen.getByRole("button", { name: "保存修改" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "取消" }));

    const dialog = screen.getByRole("dialog", { name: "放弃修改？" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("当前修改尚未保存，关闭后将丢失这些改动。")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "继续编辑" }));
    expect(screen.getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(screen.queryByRole("heading", { name: "JSUS2026004" })).not.toBeInTheDocument();
  });

  it("guards dirty ledger drawer changes before closing with Escape", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.clear(screen.getByLabelText("项目名称"));
    await user.type(screen.getByLabelText("项目名称"), "UD 玻纤增强复合材料采购 - 修订");

    fireEvent.keyDown(window, { key: "Escape" });

    const dialog = screen.getByRole("dialog", { name: "放弃修改？" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "JSUS2026004" })).toBeInTheDocument();
  });

  it("cancels the ledger delete confirmation with Escape without closing the drawer", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByText("Owens Corning Composites"));
    await user.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除合同？" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "删除合同？" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "删除" }));

    const dialog = screen.getByRole("dialog", { name: "删除合同？" });
    expect(within(dialog).getByText("将删除合同 JSUS2026004 及其存档 PDF，不可恢复。")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "删除" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026004", expect.objectContaining({ method: "DELETE" }));
    expect(screen.getByText("已删除 JSUS2026004")).toBeInTheDocument();
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

    await user.click(await screen.findByLabelText("选择 JSUS2026004"));

    expect(screen.getByText("已选 1 项")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出所选" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/batch", expect.objectContaining({
      body: JSON.stringify({ ids: ["JSUS2026004"], action: "export" }),
      headers: expect.objectContaining({ Accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
      method: "POST"
    }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已导出 1 项")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "取消选择" }));

    expect(screen.queryByText("已选 1 项")).not.toBeInTheDocument();
    expect(screen.getByLabelText("选择 JSUS2026004")).not.toBeChecked();
  });

  it("clears ledger bulk selection with Escape", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/ledger" />);

    await user.click(await screen.findByLabelText("选择 JSUS2026004"));
    expect(screen.getByText("已选 1 项")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByText("已选 1 项")).not.toBeInTheDocument();
    expect(screen.getByLabelText("选择 JSUS2026004")).not.toBeChecked();
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

    await user.click(await screen.findByLabelText("选择当前页"));
    expect(screen.getByRole("region", { name: "批量操作" })).toHaveTextContent("已选 3 项");

    await user.click(screen.getByRole("button", { name: "删除所选" }));
    const dialog = screen.getByRole("dialog", { name: "删除所选合同？" });
    expect(within(dialog).getByText("将删除选中的 3 份合同及其存档 PDF，不可恢复。")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "删除所选" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/batch", expect.objectContaining({
      body: JSON.stringify({ ids: ["JSUS2026004", "JSUS2026003", "JSUS2026002"], action: "delete" }),
      headers: expect.objectContaining({ "Content-Type": "application/json" }),
      method: "POST"
    }));
    expect(screen.getByText("已删除 3 份合同")).toBeInTheDocument();
    expect(screen.queryByText("Owens Corning Composites")).not.toBeInTheDocument();
    expect(screen.queryByText("Jushi Group Hong Kong")).not.toBeInTheDocument();
    expect(screen.queryByText("PPG Industries Inc.")).not.toBeInTheDocument();
  });

  it("shows toast feedback after retrying sync", async () => {
    render(<App initialPath="/processing" />);

    const retryButtons = await screen.findAllByRole("button", { name: "立即重试" });
    fireEvent.click(retryButtons[0]);

    expect(retryButtons[0]).toBeDisabled();
    expect(await screen.findByText("已重新发起同步")).toBeInTheDocument();
  });

  it("shows failed ingest rows with the backend error message", async () => {
    const failedRows = [
      {
        contract_id: "FAIL2026001",
        counterparty: "扫描质量测试供应商",
        ingest: {
          stage: "ocr_processing" as const,
          status: "failed" as const,
          last_error: "识别质量过低，请重传更清晰的扫描件"
        },
        sync: {
          state: "pending" as const,
          attempts: 0,
          updated_at: "刚刚"
        },
        updated_at: "刚刚"
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

    expect(await screen.findByText("失败")).toBeInTheDocument();
    expect(screen.getByLabelText("失败：识别质量过低，请重传更清晰的扫描件")).toHaveAttribute(
      "title",
      "识别质量过低，请重传更清晰的扫描件"
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

    expect(await screen.findByText("还没有处理记录")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "入库与同步状态表" })).not.toBeInTheDocument();
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

    expect(screen.getByRole("status", { name: "正在加载入库与同步概览" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "处理中" })).not.toBeInTheDocument();

    await act(async () => {
      resolveProcessing(new Response(JSON.stringify(processingRows), { status: 200 }));
      await processingResponse;
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: /处理中/ })).toBeInTheDocument();
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

    expect(await screen.findByText("加载失败：GET /processing failed: 500")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "入库与同步状态表" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("table", { name: "入库与同步状态表" })).toBeInTheDocument();
  });

  it("counts down retrying sync rows every second", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).endsWith("/processing")) {
          return Promise.resolve(new Response(JSON.stringify(processingRows), { status: 200 }));
        }
        return Promise.reject(new Error("unexpected request"));
      })
    );
    vi.useFakeTimers();
    render(<App initialPath="/processing" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("第 3 次 · 下次 00:42 后")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText("第 3 次 · 下次 00:41 后")).toBeInTheDocument();
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

    expect(screen.getByText("水处理框架供应商")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing")).length).toBeGreaterThan(1);
  });

  it("stops polling processing rows when all rows are done and synced", async () => {
    const settledRows = processingRows.map((row) => ({
      ...row,
      ingest: { ...row.ingest, stage: "done" as const, status: "done" as const },
      sync: { ...row.sync, state: "synced" as const }
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

    expect(screen.getByText("水处理框架供应商")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing"))).toHaveLength(1);
  });

  it("automatically retries and refreshes retrying sync rows when the countdown reaches zero", async () => {
    const expiringRows = processingRows.map((row) =>
      row.contract_id === "JSUS2026006"
        ? { ...row, sync: { ...row.sync, next_retry_in_seconds: 1 } }
        : row
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(expiringRows), { status: 200 }));
      }
      if (url.endsWith("/sync/retry") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ state: "retrying" }), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    render(<App initialPath="/processing" />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("第 3 次 · 下次 00:01 后")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/contracts/JSUS2026006/sync/retry", expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/processing")).length).toBeGreaterThan(1);
  });

  it("submits conflict resolutions and locks the merge button while saving", async () => {
    const user = userEvent.setup();
    let resolvePost!: () => void;
    const postResponse = new Promise<Response>((resolve) => {
      resolvePost = () => resolve(new Response(JSON.stringify({ state: "synced" }), { status: 200 }));
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/conflict")) {
        return Promise.resolve(new Response(JSON.stringify(conflicts), { status: 200 }));
      }
      if (url.endsWith("/resolve") && init?.method === "POST") {
        return postResponse;
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    const mergeButton = await screen.findByRole("button", { name: "确认合并" });
    await user.click(mergeButton);

    expect(mergeButton).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contracts/JSEGRCXS20260003/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          resolutions: {
            counterparty: "system",
            amount: "system",
            effective_date: "excel"
          }
        })
      })
    );

    resolvePost();
    expect(await screen.findByText("已合并 JSEGRCXS20260003，生成新基线")).toBeInTheDocument();
  });

  it("returns to processing and shows the row as synced after resolving conflicts", async () => {
    const user = userEvent.setup();
    const syncedProcessingRows = processingRows.map((row) =>
      row.contract_id === "JSEGRCXS20260003"
        ? { ...row, sync: { ...row.sync, state: "synced" as const } }
        : row
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/conflict")) {
        return Promise.resolve(new Response(JSON.stringify(conflicts), { status: 200 }));
      }
      if (url.endsWith("/resolve") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ state: "synced" }), { status: 200 }));
      }
      if (url.endsWith("/processing")) {
        return Promise.resolve(new Response(JSON.stringify(syncedProcessingRows), { status: 200 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    await user.click(await screen.findByRole("button", { name: "确认合并" }));

    const table = await screen.findByRole("table", { name: "入库与同步状态表" });
    const row = within(table).getByText("JSEGRCXS20260003").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLTableRowElement).getByText("已同步")).toBeInTheDocument();
    expect(within(row as HTMLTableRowElement).queryByRole("link", { name: "解决冲突" })).not.toBeInTheDocument();
  });

  it("shows a concurrency warning when conflict resolution is stale", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/conflict")) {
        return Promise.resolve(new Response(JSON.stringify(conflicts), { status: 200 }));
      }
      if (url.endsWith("/resolve") && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ error: "stale baseline" }), { status: 409 }));
      }
      return Promise.reject(new Error("unexpected request"));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App initialPath="/conflicts/JSEGRCXS20260003" />);

    await user.click(await screen.findByRole("button", { name: "确认合并" }));

    const staleWarnings = await screen.findAllByText("数据已更新，请重新核对");
    expect(staleWarnings.length).toBeGreaterThanOrEqual(2);
    expect(staleWarnings.find((node) => node.closest(".toast"))?.closest(".toast")).toHaveClass("toast-error");
    expect(screen.getByRole("button", { name: "确认合并" })).toBeEnabled();
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/conflict")).length).toBeGreaterThan(1);
    });
  });

  it("manages the contract version list from settings", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/settings" />);
    await screen.findByText("存档编号规则");
    const input = await screen.findByLabelText("新增合同版本");
    await user.type(input, "采购合同");
    await user.click(screen.getByRole("button", { name: "添加版本" }));
    expect(await screen.findByText("采购合同")).toBeInTheDocument();
  });

  it("lets the user pick a contract version before tagging pages", async () => {
    const user = userEvent.setup();
    render(<App initialPath="/upload" />);
    const pdf = new File(["%PDF-1.7"], "version-select.pdf", { type: "application/pdf" });

    await user.upload(screen.getByLabelText("选择 PDF 文件"), pdf);
    expect((await screen.findAllByText("version-select.pdf · 14 页 · 0.0 MB")).length).toBeGreaterThan(0);

    const select = await screen.findByLabelText("合同版本");
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

    expect(screen.getByRole("button", { name: "整份" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅合同" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "仅合同" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/contracts/JSUS2026004/file?scope=contract",
      expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/pdf" }) })
    );
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(await screen.findByText("已下载 JSUS2026004-contract.pdf")).toBeInTheDocument();
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
          question: "付款期限超过 60 天的合同，逾期付款怎么约定违约责任？",
          answer: "共有 1 份合同匹配付款期限超过 60 天，逾期付款按每日万分之五计算违约金。",
          evidence: [
            {
              kind: "record",
              contract_id: "JSUS2026004",
              title: "Owens Corning Composites",
              fields: { "付款期限": "90 天", "金额": "USD 147,664.05" }
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

    expect(await screen.findByRole("link", { name: "问答" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "合同问答" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("输入合同问题"), "付款期限超过 60 天的合同，逾期付款怎么约定违约责任？");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "付款期限超过 60 天的合同，逾期付款怎么约定违约责任？",
          contract_id: null,
          conversation_id: null,
          scope_type: "all",
          scope_value: null
        })
      })
    ));
    expect(await screen.findByText("共有 1 份合同匹配付款期限超过 60 天，逾期付款按每日万分之五计算违约金。")).toBeInTheDocument();

    const recordTable = screen.getByRole("table", { name: "匹配合同证据" });
    expect(within(recordTable).getByRole("columnheader", { name: "付款期限" })).toBeInTheDocument();
    expect(within(recordTable).getByRole("cell", { name: "90 天" })).toBeInTheDocument();
    expect(screen.getByText("JSUS2026004 · 第 8 页 · Payment")).toBeInTheDocument();
    expect(screen.getByText("late payment shall bear liquidated damages at 0.05% per day")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "核实原文" }));

    const dialog = await screen.findByRole("dialog", { name: "原文核实" });
    expect(document.body).toHaveClass("modal-open");
    expect(within(dialog).queryByRole("button", { name: "上一页" })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "下一页" })).not.toBeInTheDocument();
    expect(within(dialog).getByTestId("qa-verify-stage")).toHaveClass("qa-verify-stage-single-page");
    expect(within(dialog).getByRole("button", { name: "左转 90 度" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "右转 90 度" })).toBeInTheDocument();
    expect(within(dialog).getByAltText("JSUS2026004 第 8 页原文")).toHaveAttribute("src", "/api/contracts/JSUS2026004/pages/8");
    expect(within(dialog).getByTestId("source-highlight")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "新窗口打开" })).toHaveAttribute("href", "/api/contracts/JSUS2026004/pages/8");

    const page = within(dialog).getByTestId("qa-page-image-wrap");
    expect(page).toHaveStyle({ transform: "rotate(0deg)" });
    await user.click(within(dialog).getByRole("button", { name: "右转 90 度" }));
    expect(page).toHaveStyle({ transform: "rotate(90deg)" });
    await user.click(within(dialog).getByRole("button", { name: "左转 90 度" }));
    expect(page).toHaveStyle({ transform: "rotate(0deg)" });

    await user.click(within(dialog).getByRole("button", { name: "关闭原文核实" }));
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
          question: "付款期限是什么？",
          answer: "Owens 相关合同付款期限为 90 天。",
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    await user.selectOptions(await screen.findByLabelText("范围类型"), "supplier");
    await user.type(screen.getByLabelText("范围值"), "Owens Corning");
    await user.type(screen.getByLabelText("输入合同问题"), "付款期限是什么？");
    await user.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "付款期限是什么？",
          contract_id: null,
          conversation_id: null,
          scope_type: "supplier",
          scope_value: "Owens Corning"
        })
      })
    ));
    expect(await screen.findByText("Owens 相关合同付款期限为 90 天。")).toBeInTheDocument();
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
          question: "它什么时候到期呢",
          answer: "到期日为 2026 年 12 月 31 日。",
          conversation_id: null,
          conversation_full: true,
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    await user.type(await screen.findByLabelText("输入合同问题"), "它什么时候到期呢");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("到期日为 2026 年 12 月 31 日。")).toBeInTheDocument();
    expect(await screen.findByText(/本次对话已达长度上限/)).toBeInTheDocument();
    expect(screen.getByLabelText("输入合同问题")).toBeDisabled();
    expect(screen.getByRole("button", { name: "开启新对话" })).toBeInTheDocument();
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

    const input = await screen.findByLabelText("输入合同问题");
    await user.type(input, "当前所有还在生效的合同是什么");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(screen.getByText("当前所有还在生效的合同是什么")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByText("正在检索合同库")).toBeInTheDocument();
    expect(screen.getByText("分析台账记录和原文片段，生成可核实回答…")).toBeInTheDocument();

    resolveQuery(new Response(JSON.stringify({
      question: "当前所有还在生效的合同是什么",
      answer: "当前共有 3 份生效合同。",
      evidence: []
    }), { headers: { "Content-Type": "application/json" }, status: 200 }));

    expect(await screen.findByText("当前共有 3 份生效合同。")).toBeInTheDocument();
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
          question: "第一行\n第二行",
          answer: "已按多行问题检索。",
          evidence: []
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    const input = await screen.findByLabelText("输入合同问题");
    await user.type(input, "第一行");
    await user.keyboard("{Shift>}{Enter}{/Shift}");
    await user.type(input, "第二行");

    expect(input).toHaveValue("第一行\n第二行");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/query", expect.anything());

    await user.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/query",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          question: "第一行\n第二行",
          contract_id: null,
          conversation_id: null,
          scope_type: "all",
          scope_value: null
        })
      })
    ));
    expect(await screen.findByText("已按多行问题检索。")).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("keeps the Q&A shell fixed while only history and chat content scroll", async () => {
    render(<App initialPath="/qa" />);

    expect(await screen.findByText("历史聊天")).toBeInTheDocument();
    const qaPage = document.querySelector(".qa-page");
    const history = document.querySelector(".qa-history");
    const historyList = screen.getByLabelText("历史聊天列表");
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
        const items = deleted ? [] : [{ conversation_id: "c1", title: "生效合同", created_at: "2026-06-18T00:00:00Z", updated_at: "2026-06-18T00:01:00Z", message_count: 2 }];
        return Promise.resolve(new Response(JSON.stringify(items), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations" && init?.method === "POST") {
        return Promise.resolve(new Response(JSON.stringify({ conversation_id: "c2", title: "新会话", created_at: "2026-06-18T00:02:00Z", updated_at: "2026-06-18T00:02:00Z", message_count: 0 }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c1" && init?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === "/api/qa/conversations/c1") {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: "c1",
          title: "生效合同",
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:01:00Z",
          message_count: 2,
          messages: [
            { message_id: "m1", conversation_id: "c1", role: "user", content: "当前所有还在生效的合同是什么", evidence: [], created_at: "2026-06-18T00:00:00Z" },
            { message_id: "m2", conversation_id: "c1", role: "assistant", content: "当前共有 3 份生效合同。", evidence: [], created_at: "2026-06-18T00:01:00Z" }
          ]
        }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c2") {
        return Promise.resolve(new Response(JSON.stringify({ conversation_id: "c2", title: "新会话", created_at: "2026-06-18T00:02:00Z", updated_at: "2026-06-18T00:02:00Z", message_count: 0, messages: [] }), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App initialPath="/qa" />);

    expect(await screen.findByText("历史聊天")).toBeInTheDocument();
    expect(await screen.findByText("生效合同")).toBeInTheDocument();

    await user.click(screen.getByText("生效合同"));
    expect(await screen.findByText("当前所有还在生效的合同是什么")).toBeInTheDocument();
    expect(await screen.findByText("当前共有 3 份生效合同。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByText("向合同库提问")).toBeInTheDocument();

    await user.click(screen.getByText("生效合同"));
    await user.hover(screen.getByText("生效合同"));
    await user.click(screen.getByRole("button", { name: "删除 生效合同" }));
    const dialog = await screen.findByRole("dialog", { name: "删除对话？" });
    expect(within(dialog).getByText("将删除「生效合同」及其中所有问答记录，不可恢复。")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除" }));

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
          { conversation_id: "c1", title: "生效合同", created_at: "2026-06-18T00:00:00Z", updated_at: "2026-06-18T00:01:00Z", message_count: 2 }
        ]), { headers: { "Content-Type": "application/json" }, status: 200 }));
      }
      if (url === "/api/qa/conversations/c1") {
        return Promise.resolve(new Response(JSON.stringify({
          conversation_id: "c1",
          title: "生效合同",
          created_at: "2026-06-18T00:00:00Z",
          updated_at: "2026-06-18T00:01:00Z",
          message_count: 2,
          messages: [
            { message_id: "m1", conversation_id: "c1", role: "user", content: "当前所有还在生效的合同是什么", evidence: [], created_at: "2026-06-18T00:00:00Z" },
            { message_id: "m2", conversation_id: "c1", role: "assistant", content: "当前共有 3 份生效合同。", evidence: [], created_at: "2026-06-18T00:01:00Z" }
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

    await user.click(await screen.findByText("生效合同"));
    expect(await screen.findByText("当前共有 3 份生效合同。")).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "台账" }));
    expect(await screen.findByRole("heading", { name: "合同台账" })).toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "问答" }));

    expect(await screen.findByText("当前所有还在生效的合同是什么")).toBeInTheDocument();
    expect(screen.getByText("当前共有 3 份生效合同。")).toBeInTheDocument();
  });
});
