import type { ConfigState, ConflictField, ContractRow, ProcessingRow } from "./types";

export const contracts: ContractRow[] = [
  {
    contract_id: "JSUS2026004",
    counterparty: "Owens Corning Composites",
    amount: 147664.05,
    currency: "USD",
    term_months: 12,
    yearly_amount: 147664.05,
    project_name: "UD 玻纤增强复合材料采购",
    contract_type: "Supply Agreement",
    petitioner: "王立",
    petition_date: "2026-04-12",
    file_no: "2026004",
    file_name: "2026004-JSUS2026004-UD 玻纤增强复合材料采购",
    effective_date: "2026-04-15",
    expiration_date: "2027-04-14",
    department: "UD",
    brief_description: "年度玻纤增强复合材料采购审批。",
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
    project_name: "FPW 设备维护服务协议",
    contract_type: "Service Agreement",
    petitioner: "李娜",
    petition_date: "2026-03-28",
    file_no: "2026003",
    file_name: "2026003-JSUS2026003-FPW 设备维护服务协议",
    effective_date: "2026-04-01",
    expiration_date: "2027-03-31",
    department: "FPW",
    brief_description: "维护服务与备件支持。",
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
    project_name: "涂层材料框架采购",
    contract_type: "Framework",
    petitioner: "陈敏",
    petition_date: "2026-03-20",
    file_no: "2026002",
    file_name: "2026002-JSUS2026002-涂层材料框架采购",
    effective_date: "2026-03-20",
    expiration_date: "2026-12-31",
    department: "PD",
    brief_description: "生产涂层材料框架采购。",
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
    project_name: "价格补充协议",
    contract_type: "Supplement",
    petitioner: "赵阳",
    petition_date: "2025-12-08",
    file_no: "2025118",
    file_name: "2025118-JSUS2025118-价格补充协议",
    effective_date: null,
    expiration_date: null,
    department: "UD",
    brief_description: "待确认补充协议日期。",
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
    sync: { state: "conflict", attempts: 0, updated_at: "刚刚" },
    updated_at: "刚刚"
  },
  {
    contract_id: "JSUS2026006",
    counterparty: "水处理框架供应商",
    ingest: { stage: "done", status: "done" },
    sync: {
      state: "retrying",
      attempts: 3,
      last_error: "Excel 文件被占用，请关闭后重试",
      last_attempt_at: "2026-06-02T22:12:00",
      next_retry_in_seconds: 42,
      updated_at: "2 分钟前"
    },
    updated_at: "2 分钟前"
  },
  {
    contract_id: "CN2026003",
    counterparty: "不锈钢管供应商",
    ingest: { stage: "embedding", status: "running" },
    sync: { state: "pending", attempts: 0, updated_at: "5 分钟前" },
    updated_at: "5 分钟前"
  },
  {
    contract_id: "JSUS2026004",
    counterparty: "Owens Corning Composites",
    ingest: { stage: "done", status: "done" },
    sync: { state: "synced", attempts: 0, updated_at: "今天 09:22" },
    updated_at: "今天 09:22"
  }
];

export const conflicts: ConflictField[] = [
  {
    field: "counterparty",
    owner: "system",
    baseline: "Jushi Egypt For Fiberglass Industry S.A.E",
    system: "Jushi Egypt For Fiberglass Industry S.A.E",
    excel: "巨石埃及玻璃纤维",
    suggested: "system"
  },
  {
    field: "amount",
    owner: "system",
    baseline: "39041.60",
    system: "39041.60",
    excel: "39041.6",
    suggested: "system"
  },
  {
    field: "effective_date",
    owner: "human",
    baseline: "（空）",
    system: "（空）",
    excel: "2026-03-15",
    suggested: "excel"
  }
];

export const configState: ConfigState = {
  ragEnabled: false,
  excelEnabled: true,
  backupEnabled: true,
  lockCheckEnabled: true,
  fileNoRules: [
    { category: "ordinary", prefix: "", example: "2026001" },
    { category: "china-buy", prefix: "CN", example: "CN2026001" },
    { category: "production", prefix: "PD", example: "PD2026001" }
  ],
  contractVersions: ["Supply Agreement", "Service Agreement", "Framework", "Supplement"]
};
