import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { useConfig, useProcessingRows, useRetryContractSync } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { Card, EmptyState, ErrorState, PageHeader } from "../../components/ui/Panel";
import { IngestStatusTag, SyncStatusTag } from "../../components/ui/StatusTag";
import { useToast } from "../../components/ui/Toast";
import type { ProcessingRow, SyncState } from "../../api/types";

type ProcessingFilter = "running" | "conflict" | "done" | "retrying";
const emptyProcessingRows: ProcessingRow[] = [];
const loadingMetricKeys = ["running", "conflict", "done", "retrying"];

export function ProcessingPage() {
  const { data = emptyProcessingRows, error, isError, isFetching, isLoading, refetch } = useProcessingRows();
  const { data: config } = useConfig();
  const excelSyncEnabled = config?.excelEnabled ?? true;
  const retryMutation = useRetryContractSync();
  const [filter, setFilter] = useState<ProcessingFilter | null>(null);
  const [retryingContractId, setRetryingContractId] = useState<string | null>(null);
  const [retryCountdowns, setRetryCountdowns] = useState<Record<string, number>>({});
  const autoRetriedContracts = useRef<Set<string>>(new Set());
  const toast = useToast();
  useEffect(() => {
    setRetryCountdowns((current) => {
      const next: Record<string, number> = {};
      data.forEach((row) => {
        if (row.sync.state === "retrying") {
          next[row.contract_id] = current[row.contract_id] ?? getInitialRetrySeconds(row);
        }
      });
      return next;
    });
  }, [data]);

  useEffect(() => {
    if (!data.some((row) => row.sync.state === "retrying")) return undefined;
    const timer = window.setInterval(() => {
      setRetryCountdowns((current) => Object.fromEntries(
        Object.entries(current).map(([contractId, seconds]) => [contractId, Math.max(0, seconds - 1)])
      ));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [data]);

  useEffect(() => {
    if (!excelSyncEnabled) return;
    data.forEach((row) => {
      if (row.sync.state !== "retrying") {
        autoRetriedContracts.current.delete(row.contract_id);
        return;
      }
      const seconds = retryCountdowns[row.contract_id] ?? getInitialRetrySeconds(row);
      if (seconds > 0 || autoRetriedContracts.current.has(row.contract_id)) return;
      autoRetriedContracts.current.add(row.contract_id);
      void retryMutation.mutateAsync(row.contract_id);
    });
  }, [data, excelSyncEnabled, retryCountdowns, retryMutation]);

  async function handleRetry(contractId: string) {
    setRetryingContractId(contractId);
    try {
      await retryMutation.mutateAsync(contractId);
      toast.success("已重新发起同步");
    } finally {
      setRetryingContractId(null);
    }
  }

  const counts = {
    running: data.filter((row) => row.ingest.status === "running").length,
    conflict: excelSyncEnabled ? data.filter((row) => row.sync.state === "conflict").length : 0,
    done: data.filter((row) => row.ingest.status === "done").length,
    retrying: excelSyncEnabled ? data.filter((row) => row.sync.state === "retrying").length : 0
  };
  const metrics: Array<{ key: ProcessingFilter; label: string; count: number; tone?: "warning" | "amber" }> = [
    { key: "running", label: "处理中", count: counts.running },
    { key: "conflict", label: "待确认冲突", count: counts.conflict, tone: "warning" },
    { key: "done", label: "已完成", count: counts.done },
    { key: "retrying", label: "重试中", count: counts.retrying, tone: "amber" }
  ];
  const activeMetric = metrics.find((metric) => metric.key === filter);
  const filteredData = filter ? data.filter((row) => matchesProcessingFilter(row, filter, excelSyncEnabled)) : data;

  return (
    <>
      <PageHeader title="入库与同步" subtitle="入库完成即可检索；Excel 同步是独立下游，未同步不影响合同可用" />
      <div className="content-pad">
        <div className="metric-grid" role={isLoading ? "status" : undefined} aria-label={isLoading ? "正在加载入库与同步概览" : undefined}>
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
            <span>筛选：{activeMetric.label}</span>
            <Button onClick={() => setFilter(null)}>清除状态筛选</Button>
          </div>
        ) : null}
        <Card>
          {isLoading ? <div className="skeleton-list" /> : isError ? (
            <ErrorState text={`加载失败：${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          ) : filteredData.length === 0 ? <EmptyState text={data.length === 0 ? "还没有处理记录" : "当前筛选没有状态记录"} /> : (
            <table className="data-table processing-table" aria-label="入库与同步状态表">
              <thead>
                <tr>
                  <th>合同编号</th>
                  <th>对方</th>
                  <th>入库状态</th>
                  <th>Excel 同步状态</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((row) => {
                  const syncState: SyncState = excelSyncEnabled ? row.sync.state : "disabled";
                  return (
                    <tr key={row.contract_id} className={syncState === "conflict" ? "row-conflict" : syncState === "retrying" ? "row-retrying" : ""}>
                      <td className="mono">{row.contract_id}</td>
                      <td>{row.counterparty}</td>
                      <td><IngestStatusTag stage={row.ingest.stage} status={row.ingest.status} lastError={row.ingest.last_error} /></td>
                      <td>
                        <div className="status-cell">
                          <SyncStatusTag state={syncState} />
                          {syncState === "retrying" ? <small>第 {row.sync.attempts} 次 · 下次 {formatRetryCountdown(retryCountdowns[row.contract_id] ?? getInitialRetrySeconds(row))} 后</small> : null}
                        </div>
                      </td>
                      <td>{row.updated_at}</td>
                      <td className="action-cell">
                        <Link className="button button-ghost" to={`/contracts/${row.contract_id}`}>详情</Link>
                        {excelSyncEnabled && row.sync.state === "conflict" ? <Link className="button button-primary" to={`/conflicts/${row.contract_id}`}>解决冲突</Link> : null}
                        {excelSyncEnabled && (row.sync.state === "pending" || row.sync.state === "retrying") ? (
                          <Button
                            icon={<RefreshCw size={15} />}
                            loading={retryingContractId === row.contract_id}
                            onClick={() => void handleRetry(row.contract_id)}
                          >
                            立即重试
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

function matchesProcessingFilter(row: ProcessingRow, filter: ProcessingFilter, excelSyncEnabled: boolean) {
  if (filter === "running") return row.ingest.status === "running";
  if (filter === "conflict") return excelSyncEnabled && row.sync.state === "conflict";
  if (filter === "done") return row.ingest.status === "done";
  return excelSyncEnabled && row.sync.state === "retrying";
}

function getInitialRetrySeconds(row: ProcessingRow) {
  if (row.sync.next_retry_in_seconds !== undefined) return Math.max(0, row.sync.next_retry_in_seconds);
  if (!row.sync.last_attempt_at) return 0;
  const attemptedAt = new Date(row.sync.last_attempt_at).getTime();
  if (Number.isNaN(attemptedAt)) return 0;
  const retryAt = attemptedAt + 60_000;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function formatRetryCountdown(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(safeSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainingSeconds}`;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
