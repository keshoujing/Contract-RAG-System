import type { ConfigState, ConflictField, ContractRow, FileNoRule, PageRole, ProcessingRow, QaConversationDetail, QaConversationSummary, QueryResponse, ResolveConflictPayload } from "./types";
import { configState, conflicts, contracts, processingRows } from "./mockData";

export interface ContractListResult {
  data: ContractRow[];
  total: number;
}

interface ContractQuery {
  q?: string;
  department?: string;
  status?: string;
  year?: string;
  sort?: string;
}

const API_BASE = import.meta.env.VITE_API_BASE?.replace(/\/$/, "") || "/api";
const EXCEL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME = "application/pdf";

async function getJson<T>(path: string): Promise<T> {
  if (!API_BASE) throw new Error("REST API disabled");
  const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new ApiError(`GET ${path} failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
  }
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const bodyText = await response.text();
    throw new ApiError(`POST ${path} failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
  }
  return response.json() as Promise<T>;
}

async function deleteJson(path: string): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { method: "DELETE", headers: { Accept: "application/json" } });
  if (!response.ok) throw new ApiError(`DELETE ${path} failed: ${response.status}`, response.status, await response.text(), response.headers.get("content-type") ?? "");
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new ApiError(`PATCH ${path} failed: ${response.status}`, response.status, await response.text(), response.headers.get("content-type") ?? "");
  return response.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly bodyText = "", readonly contentType = "") {
    super(message);
  }
}

function queryString(query: ContractQuery = {}) {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const value = params.toString();
  return value ? `?${value}` : "";
}

function applyContractQuery(rows: ContractRow[], query: ContractQuery = {}) {
  const term = query.q?.trim().toLowerCase();
  let result = [...rows];

  if (term) {
    const searchTerm = term;
    result = result.filter((contract) =>
      [contract.contract_id, contract.counterparty, contract.project_name].some((value) => value.toLowerCase().includes(searchTerm))
    );
  }
  const departments = parseMultiFilter(query.department);
  if (departments.length > 0) {
    result = result.filter((contract) => departments.includes(contract.department));
  }
  const statuses = parseMultiFilter(query.status);
  if (statuses.length > 0) {
    result = result.filter((contract) => statuses.includes(contract.status));
  }
  const years = parseMultiFilter(query.year);
  if (years.length > 0) {
    result = result.filter((contract) => years.some((year) => contract.petition_date.startsWith(year)));
  }
  applyLocalSort(result, query.sort);
  if (query.sort === "date_desc") {
    result.sort((left, right) => right.petition_date.localeCompare(left.petition_date));
  }

  return result;
}

function parseMultiFilter(value?: string) {
  if (!value || value === "all") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function applyLocalSort(rows: ContractRow[], sort: string | undefined) {
  const direction = sort?.endsWith("_asc") ? 1 : sort?.endsWith("_desc") ? -1 : 0;
  if (!direction || !sort) return;
  const column = sort.replace(/_(asc|desc)$/, "");
  const comparators: Record<string, (left: ContractRow, right: ContractRow) => number> = {
    amount: (left, right) => left.amount - right.amount,
    contract_id: (left, right) => left.contract_id.localeCompare(right.contract_id, undefined, { numeric: true }),
    counterparty: (left, right) => left.counterparty.localeCompare(right.counterparty),
    effective_date: (left, right) => compareOptionalDate(left.effective_date, right.effective_date)
  };
  const compare = comparators[column];
  if (!compare) return;
  rows.sort((left, right) => compare(left, right) * direction);
}

function compareOptionalDate(left: string | null, right: string | null) {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

export async function getContracts(query: ContractQuery = {}): Promise<ContractListResult> {
  try {
    return await getJson<ContractListResult>(`/contracts${queryString(query)}`);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    const data = applyContractQuery(contracts, query);
    return { data, total: data.length };
  }
}

export async function exportContracts(query: ContractQuery = {}, rows: ContractRow[] = contracts): Promise<Blob> {
  try {
    if (!API_BASE) throw new Error("REST API disabled");
    const response = await fetch(`${API_BASE}/contracts/export${queryString(query)}`, { headers: { Accept: EXCEL_MIME } });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(`GET /contracts/export failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
    }
    return response.blob();
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return buildLocalLedgerExport(rows);
  }
}

export async function exportContractBatch(ids: string[], rows: ContractRow[] = contracts): Promise<Blob> {
  try {
    if (!API_BASE) throw new Error("REST API disabled");
    const response = await fetch(`${API_BASE}/contracts/batch`, {
      method: "POST",
      headers: { Accept: EXCEL_MIME, "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action: "export" })
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(`POST /contracts/batch failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
    }
    return response.blob();
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    const selectedRows = rows.filter((contract) => ids.includes(contract.contract_id));
    return buildLocalLedgerExport(selectedRows);
  }
}

export async function deleteContractBatch(ids: string[]): Promise<void> {
  try {
    if (!API_BASE) throw new Error("REST API disabled");
    const response = await fetch(`${API_BASE}/contracts/batch`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ids, action: "delete" })
    });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(`POST /contracts/batch failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
    }
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
  }
}

export interface UploadIngestResult {
  task_id: string;
  page_count: number;
}

const MOCK_PAGE_COUNT = 14;

export async function uploadIngestFile(file: File): Promise<UploadIngestResult> {
  try {
    if (!API_BASE) throw new Error("REST API disabled");
    const body = new FormData();
    body.append("file", file);
    const response = await fetch(`${API_BASE}/ingest/upload`, { method: "POST", body });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(`POST /ingest/upload failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
    }
    const result = await response.json() as { task_id: string; page_count?: number };
    return { task_id: result.task_id, page_count: result.page_count || MOCK_PAGE_COUNT };
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return { task_id: `local-${Date.now()}`, page_count: MOCK_PAGE_COUNT };
  }
}

export function uploadPageUrl(taskId: string, pageNo: number): string {
  return `${API_BASE}/ingest/${encodeURIComponent(taskId)}/pages/${pageNo}`;
}

export async function submitPageTags(taskId: string, tags: Record<number, PageRole>): Promise<void> {
  try {
    const payload = Object.fromEntries(Object.entries(tags).map(([k, v]) => [String(k), v]));
    await postJson<unknown>(`/ingest/${encodeURIComponent(taskId)}/page-tags`, { tags: payload });
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
  }
}

export interface IngestStatusResult {
  status: string;
  stage: string;
  fields: Record<string, string | number | null | undefined>;
  _per_field_confidence?: Record<string, number>;
  _per_field_source_span?: Record<string, string>;
}

export async function getIngestStatus(taskId: string): Promise<IngestStatusResult> {
  try {
    return await getJson<IngestStatusResult>(`/ingest/${encodeURIComponent(taskId)}`);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return {
      status: "done",
      stage: "awaiting_user_confirmation",
      fields: {
        contract_id: "JSUS2026005",
        amount: "$147,664.05",
        counterparty: "Owens Corning Composites",
        project_name: "UD Glass Fiber Reinforced Composite Procurement",
        department: "UD",
        petitioner: "王立 Wang Li"
      },
      _per_field_confidence: { project_name: 0.62 },
      _per_field_source_span: { project_name: "UD Glass Fiber..." }
    };
  }
}

export interface ConfirmIngestPayload {
  fields: Record<string, string>;
  effective_date: string;
  expiration_date: string;
  category: string;
  overwrite?: boolean;
}

export async function confirmIngest(taskId: string, payload: ConfirmIngestPayload): Promise<{ contract_id: string }> {
  try {
    return await postJson<{ contract_id: string }>(`/ingest/${encodeURIComponent(taskId)}/confirm`, payload);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return { contract_id: payload.fields.contract_id };
  }
}

export async function downloadContractFile(contractId: string, scope: "full" | "contract" = "full"): Promise<Blob> {
  try {
    if (!API_BASE) throw new Error("REST API disabled");
    const path = `/contracts/${encodeURIComponent(contractId)}/file${scope === "contract" ? "?scope=contract" : ""}`;
    const response = await fetch(`${API_BASE}${path}`, { headers: { Accept: PDF_MIME } });
    if (!response.ok) {
      const bodyText = await response.text();
      throw new ApiError(`GET ${path} failed: ${response.status}`, response.status, bodyText, response.headers.get("content-type") ?? "");
    }
    return response.blob();
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return buildLocalPdf(contractId);
  }
}

export function contractPageUrl(contractId: string, pageNo: number): string {
  return `${API_BASE}/contracts/${encodeURIComponent(contractId)}/pages/${pageNo}`;
}

export async function askQuestion(payload: {
  question: string;
  contract_id?: string | null;
  conversation_id?: string | null;
  scope_type?: "all" | "contract" | "supplier";
  scope_value?: string | null;
}): Promise<QueryResponse> {
  const body = {
    question: payload.question,
    contract_id: payload.contract_id ?? null,
    conversation_id: payload.conversation_id ?? null,
    scope_type: payload.scope_type ?? "all",
    scope_value: payload.scope_value ?? null
  };
  try {
    return await postJson<QueryResponse>("/query", body);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return {
      question: body.question,
      answer: "本地预览模式下无法连接 RAG 服务。接入后这里会显示基于合同证据的回答。",
      evidence: []
    };
  }
}

export async function getQaConversations(): Promise<QaConversationSummary[]> {
  try {
    return await getJson<QaConversationSummary[]>("/qa/conversations");
  } catch {
    return [];
  }
}

export async function createQaConversation(): Promise<QaConversationSummary> {
  try {
    return await postJson<QaConversationSummary>("/qa/conversations");
  } catch {
    const now = new Date().toISOString();
    return { conversation_id: `local-${Date.now()}`, title: "新会话", created_at: now, updated_at: now, message_count: 0 };
  }
}

export async function getQaConversation(conversationId: string): Promise<QaConversationDetail> {
  return await getJson<QaConversationDetail>(`/qa/conversations/${encodeURIComponent(conversationId)}`);
}

export async function deleteQaConversation(conversationId: string): Promise<void> {
  await deleteJson(`/qa/conversations/${encodeURIComponent(conversationId)}`);
}

export async function deleteContract(contractId: string): Promise<void> {
  try {
    await deleteJson(`/contracts/${encodeURIComponent(contractId)}`);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
  }
}

export async function patchContract(contractId: string, changes: Partial<ContractRow>, fallback: ContractRow): Promise<ContractRow> {
  try {
    return await patchJson<ContractRow>(`/contracts/${encodeURIComponent(contractId)}`, changes);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return fallback;
  }
}

export async function getContract(contractId: string): Promise<ContractRow> {
  try {
    return await getJson<ContractRow>(`/contracts/${encodeURIComponent(contractId)}`);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return contracts.find((contract) => contract.contract_id === contractId) ?? createFallbackContract(contractId);
  }
}

function createFallbackContract(contractId: string): ContractRow {
  return {
    contract_id: contractId,
    counterparty: "Owens Corning Composites",
    amount: 147664.05,
    currency: "USD",
    term_months: null,
    yearly_amount: null,
    project_name: "UD Glass Fiber Reinforced Composite Procurement",
    contract_type: "Supply Agreement",
    petitioner: "王立",
    petition_date: "2026-04-12",
    file_no: contractId.replace(/\D/g, "").slice(-7) || "2026005",
    file_name: `${contractId}-signed.pdf`,
    effective_date: "2026-04-15",
    expiration_date: "2027-04-14",
    department: "UD",
    brief_description: "由上传向导登记的合同审批页。",
    status: "active",
    pages: 14,
    size: "8.2 MB",
    archived_at: "2026-04-12 09:22"
  };
}

export async function getProcessingRows(): Promise<ProcessingRow[]> {
  try {
    return await getJson<ProcessingRow[]>("/processing");
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return processingRows;
  }
}

function isMissingLocalApi(error: ApiError) {
  return error.status === 404 || (error.status === 500 && error.bodyText.trim() === "" && error.contentType.includes("text/plain"));
}

function buildLocalLedgerExport(rows: ContractRow[]) {
  const headers = ["合同编号", "对方公司", "项目名称", "合同版本", "存档编号", "文件名", "金额", "币种", "申请人", "登记日期", "生效日", "到期日", "状态"];
  const values = rows.map((contract) => [
    contract.contract_id,
    contract.counterparty,
    contract.project_name,
    contract.contract_type,
    contract.file_no,
    contract.file_name,
    contract.amount,
    contract.currency,
    contract.petitioner,
    contract.petition_date,
    contract.effective_date ?? "",
    contract.expiration_date ?? "",
    contract.status
  ]);
  const body = [headers, ...values].map((row) => row.map(escapeSpreadsheetCell).join("\t")).join("\n");
  return new Blob([body], { type: EXCEL_MIME });
}

function escapeSpreadsheetCell(value: string | number) {
  return String(value).replace(/\r?\n/g, " ").replace(/\t/g, " ");
}

function buildLocalPdf(contractId: string) {
  const pdf = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 62 >>
stream
BT /F1 12 Tf 24 90 Td (Contract ${contractId} signed.pdf) Tj ET
endstream
endobj
trailer
<< /Root 1 0 R >>
%%EOF`;
  return new Blob([pdf], { type: PDF_MIME });
}

export async function retryContractSync(contractId: string): Promise<void> {
  try {
    await postJson<unknown>(`/contracts/${encodeURIComponent(contractId)}/sync/retry`);
  } catch {
    await Promise.resolve();
  }
}

export async function resolveConflict({ contractId, resolutions }: ResolveConflictPayload): Promise<void> {
  await postJson<unknown>(`/contracts/${encodeURIComponent(contractId)}/resolve`, { resolutions });
}

export async function getConflicts(contractId: string): Promise<ConflictField[]> {
  try {
    return await getJson<ConflictField[]>(`/contracts/${encodeURIComponent(contractId)}/conflict`);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return conflicts;
  }
}

export async function getConfig(): Promise<ConfigState> {
  try {
    return await getJson<ConfigState>("/config");
  } catch {
    return configState;
  }
}

export async function patchConfig(changes: Partial<ConfigState>, fallback: ConfigState): Promise<ConfigState> {
  try {
    const response = await patchJson<Partial<ConfigState>>("/config", changes);
    return { ...fallback, ...response };
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return { ...fallback, ...changes };
  }
}

export async function updateContractVersions(versions: string[]): Promise<string[]> {
  try {
    const response = await patchJson<unknown>("/config/contract-versions", { versions });
    return Array.isArray(response) ? response as string[] : versions;
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return versions;
  }
}

export async function updateFileNoRules(rules: FileNoRule[]): Promise<FileNoRule[]> {
  const normalizedRules = rules.map((rule) => normalizeFileNoRule(rule));
  try {
    const response = await patchJson<unknown>("/config/file-no-rules", toFileNoRulePayload(normalizedRules));
    return normalizeFileNoRuleResponse(response, normalizedRules);
  } catch (error) {
    if (error instanceof ApiError && !isMissingLocalApi(error)) throw error;
    return normalizedRules;
  }
}

function toFileNoRulePayload(rules: FileNoRule[]) {
  return Object.fromEntries(rules.map((rule) => [rule.category, { prefix: rule.prefix.trim() }]));
}

function normalizeFileNoRule(rule: FileNoRule): FileNoRule {
  const prefix = rule.prefix.trim();
  return { ...rule, prefix, example: composeFileNoExample(prefix) };
}

function normalizeFileNoRuleResponse(response: unknown, fallback: FileNoRule[]): FileNoRule[] {
  if (Array.isArray(response)) return response.map((rule) => normalizeFileNoRule(rule as FileNoRule));
  if (response && typeof response === "object") {
    const payload = response as Record<string, { prefix?: string }>;
    return fallback.map((rule) => normalizeFileNoRule({ ...rule, prefix: payload[rule.category]?.prefix ?? rule.prefix }));
  }
  return fallback;
}

function composeFileNoExample(prefix: string) {
  return `${prefix}2026001`;
}
