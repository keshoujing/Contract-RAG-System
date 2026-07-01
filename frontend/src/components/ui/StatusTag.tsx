import { CheckCircle2, CircleX, Loader2 } from "lucide-react";
import type { ContractStatus, IngestStage } from "../../api/types";
import { ingestStageText } from "../../lib/format";

export function IngestStatusTag({ stage, status, lastError }: { stage: IngestStage; status: "running" | "done" | "failed"; lastError?: string }) {
  const Icon = status === "done" ? CheckCircle2 : status === "failed" ? CircleX : Loader2;
  const text = status === "running" ? `In progress · ${ingestStageText[stage]}` : status === "failed" ? "Failed" : ingestStageText.done;
  const errorProps = status === "failed" && lastError ? { title: lastError, "aria-label": `Failed: ${lastError}` } : {};
  return (
    <span className={`tag tag-ingest-${status}`} {...errorProps}>
      <Icon className={status === "running" ? "spin" : undefined} size={14} />
      {text}
    </span>
  );
}

export function BusinessStatusTag({ status }: { status: ContractStatus }) {
  const text = status === "active" ? "Active" : "Expired";
  return <span className={`tag tag-business-${status}`}>{text}</span>;
}
