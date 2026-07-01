import { useState } from "react";
import { Link } from "react-router-dom";
import { useProcessingRows } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { Card, EmptyState, ErrorState, PageHeader } from "../../components/ui/Panel";
import { IngestStatusTag } from "../../components/ui/StatusTag";
import type { ProcessingRow } from "../../api/types";

type ProcessingFilter = "running" | "done" | "failed";
const emptyProcessingRows: ProcessingRow[] = [];
const loadingMetricKeys = ["running", "done", "failed"];

export function ProcessingPage() {
  const { data = emptyProcessingRows, error, isError, isFetching, isLoading, refetch } = useProcessingRows();
  const [filter, setFilter] = useState<ProcessingFilter | null>(null);

  const counts = {
    running: data.filter((row) => row.ingest.status === "running").length,
    done: data.filter((row) => row.ingest.status === "done").length,
    failed: data.filter((row) => row.ingest.status === "failed").length
  };
  const metrics: Array<{ key: ProcessingFilter; label: string; count: number; tone?: "warning" | "amber" }> = [
    { key: "running", label: "Processing", count: counts.running },
    { key: "done", label: "Done", count: counts.done },
    { key: "failed", label: "Failed", count: counts.failed, tone: "warning" }
  ];
  const activeMetric = metrics.find((metric) => metric.key === filter);
  const filteredData = filter ? data.filter((row) => matchesProcessingFilter(row, filter)) : data;

  return (
    <>
      <PageHeader title="Processing" subtitle="Track contract registration from upload through searchable ledger entry" />
      <div className="content-pad">
        <div className="metric-grid" role={isLoading ? "status" : undefined} aria-label={isLoading ? "Loading processing overview" : undefined}>
          {isLoading ? loadingMetricKeys.map((key) => (
            <div className="card metric-card metric-skeleton" key={key}>
              <span />
              <strong />
            </div>
          )) : metrics.map((metric) => (
            <button
              type="button"
              key={metric.key}
              className={`card metric-card metric-button ${metric.tone ?? ""} ${filter === metric.key ? "active" : ""}`}
              disabled={metric.count === 0}
              aria-pressed={filter === metric.key}
              onClick={() => setFilter((current) => current === metric.key ? null : metric.key)}
            >
              <span>{metric.label}</span>
              <strong>{metric.count.toLocaleString()}</strong>
            </button>
          ))}
        </div>
        {activeMetric ? (
          <div className="filter-strip">
            <span>Filter: {activeMetric.label}</span>
            <Button onClick={() => setFilter(null)}>Clear status filter</Button>
          </div>
        ) : null}
        <Card>
          {isLoading ? <div className="skeleton-list" /> : isError ? (
            <ErrorState text={`Failed to load: ${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          ) : filteredData.length === 0 ? <EmptyState text={data.length === 0 ? "No processing records yet" : "No records for the current filter"} /> : (
            <table className="data-table processing-table" aria-label="Processing status table">
              <thead>
                <tr>
                  <th>Contract No.</th>
                  <th>Counterparty</th>
                  <th>Ingest status</th>
                  <th>Updated</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((row) => (
                  <tr key={row.contract_id} className={row.ingest.status === "failed" ? "row-failed" : ""}>
                    <td className="mono">{row.contract_id}</td>
                    <td>{row.counterparty}</td>
                    <td><IngestStatusTag stage={row.ingest.stage} status={row.ingest.status} lastError={row.ingest.last_error} /></td>
                    <td>{row.updated_at}</td>
                    <td className="action-cell">
                      <Link className="button button-ghost" to={`/contracts/${row.contract_id}`}>Details</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function matchesProcessingFilter(row: ProcessingRow, filter: ProcessingFilter) {
  if (filter === "running") return row.ingest.status === "running";
  if (filter === "done") return row.ingest.status === "done";
  return row.ingest.status === "failed";
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
