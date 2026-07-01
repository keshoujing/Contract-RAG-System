import type { ContractStatus, IngestStage } from "../api/types";

export function money(amount: number, currency = "USD") {
  if (amount === 0) return "$0.00";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function dash(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

export const ingestStageText: Record<IngestStage, string> = {
  uploaded: "Uploaded",
  tagging: "Tagging",
  ocr_processing: "OCR",
  alignment: "Aligning",
  llm_extraction: "Extracting",
  awaiting_user_confirmation: "Awaiting confirmation",
  chunking: "Chunking",
  embedding: "Embedding",
  done: "Done",
  failed: "Failed"
};

export function statusText(status: ContractStatus) {
  if (status === "active") return "Active";
  return "Expired";
}
