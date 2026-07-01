import type { ConfigState, ContractRow, ProcessingRow } from "./types";

export const contracts: ContractRow[] = [
  {
    contract_id: "JSUS2026004",
    counterparty: "Owens Corning Composites",
    amount: 147664.05,
    currency: "USD",
    term_months: 12,
    yearly_amount: 147664.05,
    project_name: "UD Glass-Fiber Reinforced Composite Procurement",
    contract_type: "Supply Agreement",
    petitioner: "Wang Li",
    petition_date: "2026-04-12",
    file_no: "2026004",
    file_name: "2026004-JSUS2026004-UD Glass-Fiber Reinforced Composite Procurement",
    effective_date: "2026-04-15",
    expiration_date: "2027-04-14",
    department: "UD",
    brief_description: "Annual glass-fiber reinforced composite procurement approval.",
    status: "active",
    pages: 14,
    size: "8.2 MB",
    archived_at: "2026-04-12 09:22"
  },
  {
    contract_id: "JSUS2026003",
    counterparty: "Jushi Group Hong Kong",
    amount: 52300,
    currency: "USD",
    term_months: 12,
    yearly_amount: 52300,
    project_name: "FPW Equipment Maintenance Service Agreement",
    contract_type: "Service Agreement",
    petitioner: "Li Na",
    petition_date: "2026-03-28",
    file_no: "2026003",
    file_name: "2026003-JSUS2026003-FPW Equipment Maintenance Service Agreement",
    effective_date: "2026-04-01",
    expiration_date: "2027-03-31",
    department: "FPW",
    brief_description: "Maintenance service and spare-parts support.",
    status: "active",
    pages: 9,
    size: "4.4 MB",
    archived_at: "2026-03-28 16:10"
  },
  {
    contract_id: "JSUS2026002",
    counterparty: "PPG Industries Inc.",
    amount: 308900,
    currency: "USD",
    term_months: 0,
    yearly_amount: null,
    project_name: "Coating Material Framework Procurement",
    contract_type: "Framework",
    petitioner: "Chen Min",
    petition_date: "2026-03-20",
    file_no: "2026002",
    file_name: "2026002-JSUS2026002-Coating Material Framework Procurement",
    effective_date: "2026-03-20",
    expiration_date: "2026-12-31",
    department: "PD",
    brief_description: "Production coating material framework procurement.",
    status: "active",
    pages: 18,
    size: "10.6 MB",
    archived_at: "2026-03-20 11:43"
  },
  {
    contract_id: "JSUS2025118",
    counterparty: "Vetrotex America",
    amount: 0,
    currency: "USD",
    term_months: null,
    yearly_amount: null,
    project_name: "Price Supplement Agreement",
    contract_type: "Supplement",
    petitioner: "Zhao Yang",
    petition_date: "2025-12-08",
    file_no: "2025118",
    file_name: "2025118-JSUS2025118-Price Supplement Agreement",
    effective_date: null,
    expiration_date: null,
    department: "UD",
    brief_description: "Supplement agreement date pending confirmation.",
    status: "expired",
    pages: 5,
    size: "2.1 MB",
    archived_at: "2025-12-08 13:01"
  }
];

export const processingRows: ProcessingRow[] = [
  {
    contract_id: "JSEGRCXS20260003",
    counterparty: "Jushi Egypt For Fiberglass Industry S.A.E",
    ingest: { stage: "done", status: "done" },
    updated_at: "just now"
  },
  {
    contract_id: "JSUS2026006",
    counterparty: "Water-treatment framework supplier",
    ingest: { stage: "done", status: "done" },
    updated_at: "2 minutes ago"
  },
  {
    contract_id: "CN2026003",
    counterparty: "Stainless-steel pipe supplier",
    ingest: { stage: "embedding", status: "running" },
    updated_at: "5 minutes ago"
  },
  {
    contract_id: "JSUS2026004",
    counterparty: "Owens Corning Composites",
    ingest: { stage: "done", status: "done" },
    updated_at: "Today 09:22"
  }
];

export const configState: ConfigState = {
  ragEnabled: false,
  fileNoRules: [
    { category: "ordinary", prefix: "", example: "2026001" },
    { category: "china-buy", prefix: "CN", example: "CN2026001" },
    { category: "production", prefix: "PD", example: "PD2026001" }
  ],
  contractVersions: ["Supply Agreement", "Service Agreement", "Framework", "Supplement"]
};
