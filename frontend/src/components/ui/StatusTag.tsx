import { Ban, CheckCircle2, CircleX, Hourglass, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import type { ContractStatus, IngestStage, SyncState } from "../../api/types";
import { ingestStageText, syncStateText } from "../../lib/format";

export function SyncStatusTag({ state }: { state: SyncState }) {
  const Icon = state === "synced" ? CheckCircle2 : state === "pending" ? Hourglass : state === "retrying" ? RefreshCw : state === "conflict" ? TriangleAlert : Ban;
  return (
    <span className={`tag tag-sync-${state}`}>
      <Icon size={14} />
      {syncStateText[state]}
    </span>
  );
}

export function IngestStatusTag({ stage, status, lastError }: { stage: IngestStage; status: "running" | "done" | "failed"; lastError?: string }) {
  const Icon = status === "done" ? CheckCircle2 : status === "failed" ? CircleX : Loader2;
  const text = status === "running" ? `进行中 · ${ingestStageText[stage]}` : status === "failed" ? "失败" : ingestStageText.done;
  const errorProps = status === "failed" && lastError ? { title: lastError, "aria-label": `失败：${lastError}` } : {};
  return (
    <span className={`tag tag-ingest-${status}`} {...errorProps}>
      <Icon className={status === "running" ? "spin" : undefined} size={14} />
      {text}
    </span>
  );
}

export function BusinessStatusTag({ status }: { status: ContractStatus }) {
  const text = status === "active" ? "生效中" : "已到期";
  return <span className={`tag tag-business-${status}`}>{text}</span>;
}

export function OwnerBadge({ owner }: { owner: "system" | "human" }) {
  return <span className={`badge badge-${owner}`}>{owner === "system" ? "系统列" : "人工列"}</span>;
}
