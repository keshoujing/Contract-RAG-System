export type SyncState = "synced" | "pending" | "retrying" | "conflict" | "disabled";
export type IngestStage =
  | "uploaded"
  | "tagging"
  | "ocr_processing"
  | "alignment"
  | "llm_extraction"
  | "awaiting_user_confirmation"
  | "chunking"
  | "embedding"
  | "done"
  | "failed";

export type ContractStatus = "active" | "expired";
export type FieldOwner = "system" | "human";
export type PageRole = "approval" | "contract" | "other";

export interface ContractRow {
  contract_id: string;
  counterparty: string;
  amount: number;
  currency: string;
  term_months: number | null;
  yearly_amount: number | null;
  project_name: string;
  contract_type: string;
  petitioner: string;
  petition_date: string;
  file_no: string;
  file_name: string;
  effective_date: string | null;
  expiration_date: string | null;
  department: string;
  brief_description: string;
  status: ContractStatus;
  pages: number;
  size: string;
  archived_at: string;
}

export interface ProcessingRow {
  contract_id: string;
  counterparty: string;
  ingest: {
    stage: IngestStage;
    status: "running" | "done" | "failed";
    last_error?: string;
  };
  sync: {
    state: SyncState;
    attempts: number;
    last_error?: string;
    last_attempt_at?: string;
    next_retry_in_seconds?: number;
    updated_at: string;
  };
  updated_at: string;
}

export interface ConflictField {
  field: keyof ContractRow | "amount";
  owner: FieldOwner;
  baseline: string;
  system: string;
  excel: string;
  suggested?: "system" | "excel";
}

export interface ResolveConflictPayload {
  contractId: string;
  resolutions: Record<string, "system" | "excel" | string>;
}

export interface FileNoRule {
  category: string;
  prefix: string;
  example: string;
}

export interface ConfigState {
  ragEnabled: boolean;
  excelEnabled: boolean;
  backupEnabled: boolean;
  lockCheckEnabled: boolean;
  fileNoRules: FileNoRule[];
  contractVersions: string[];
}

export interface QueryRecordEvidence {
  kind: "record";
  contract_id: string;
  title?: string;
  fields: Record<string, string | number | null | undefined>;
}

export interface QueryClauseEvidence {
  kind: "clause";
  contract_id: string;
  page?: number;
  section?: string;
  snippet: string;
  bbox?: number[];
}

export type QueryEvidence = QueryRecordEvidence | QueryClauseEvidence;

export interface QueryResponse {
  question: string;
  answer: string;
  conversation_id?: string | null;
  conversation_full?: boolean;
  evidence: QueryEvidence[];
}

export interface QaConversationSummary {
  conversation_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface QaMessage {
  message_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  evidence: QueryEvidence[];
  created_at: string;
}

export interface QaConversationDetail extends QaConversationSummary {
  messages: QaMessage[];
  full?: boolean;
}
