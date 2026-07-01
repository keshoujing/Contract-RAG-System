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
  updated_at: string;
}

export interface FileNoRule {
  category: string;
  prefix: string;
  example: string;
}

export interface ConfigState {
  ragEnabled: boolean;
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

export type FeedbackScore = "up" | "down";

export interface FeedbackPayload {
  messageId: string;
  score: FeedbackScore;
  comment?: string;
}

export interface QueryResponse {
  question: string;
  answer: string;
  conversation_id?: string | null;
  // Assistant message id of this answer — the target for 👍/👎 feedback.
  message_id?: string;
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
  feedback?: FeedbackScore | null;
  created_at: string;
}

export interface QaConversationDetail extends QaConversationSummary {
  messages: QaMessage[];
  full?: boolean;
}
