import type { ContractStatus, IngestStage, SyncState } from "../api/types";

export function money(amount: number, currency = "USD") {
  if (amount === 0) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function dash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export const ingestStageText: Record<IngestStage, string> = {
  uploaded: "已上传",
  tagging: "标注中",
  ocr_processing: "OCR 中",
  alignment: "对齐中",
  llm_extraction: "抽取中",
  awaiting_user_confirmation: "待确认",
  chunking: "分块中",
  embedding: "嵌入中",
  done: "完成",
  failed: "失败"
};

export const syncStateText: Record<SyncState, string> = {
  synced: "已同步",
  pending: "待同步",
  retrying: "重试中",
  conflict: "待确认冲突",
  disabled: "已禁用 ⊘"
};

export function statusText(status: ContractStatus) {
  if (status === "active") return "生效中";
  return "已到期";
}
