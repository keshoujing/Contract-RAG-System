import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { ApiError } from "../../api/client";
import { useConflicts, useResolveConflict } from "../../api/hooks";
import type { ConflictField } from "../../api/types";
import { Button } from "../../components/ui/Button";
import { Card, EmptyState, ErrorState, PageHeader } from "../../components/ui/Panel";
import { OwnerBadge } from "../../components/ui/StatusTag";
import { useToast } from "../../components/ui/Toast";

type Resolution = "system" | "excel" | "manual";

export function ConflictPage() {
  const { id = "JSEGRCXS20260003" } = useParams();
  const navigate = useNavigate();
  const { data, error, isError, isFetching, isLoading, refetch } = useConflicts(id);
  const conflictFields = data ?? [];
  const resolveConflict = useResolveConflict();
  const toast = useToast();
  const [choices, setChoices] = useState<Record<string, Resolution>>(() => Object.fromEntries(conflictFields.map((field) => [field.field, field.suggested ?? "system"])));
  const [manual, setManual] = useState<Record<string, string>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pendingFocusField, setPendingFocusField] = useState<string | null>(null);
  const [showConsistentFields, setShowConsistentFields] = useState(false);
  const manualInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const resolved = useMemo(() => conflictFields.map((field) => ({ field, choice: choices[field.field] ?? field.suggested ?? "system" })), [choices, conflictFields]);

  useEffect(() => {
    if (!pendingFocusField) return;
    manualInputs.current[pendingFocusField]?.focus();
    setPendingFocusField(null);
  }, [pendingFocusField, choices]);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !resolveConflict.isPending) {
        navigate("/processing");
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [navigate, resolveConflict.isPending]);

  function choose(field: ConflictField, choice: Resolution) {
    setChoices((current) => ({ ...current, [field.field]: choice }));
    setValidationError(null);
    setSubmitError(null);
    if (choice === "manual") {
      setPendingFocusField(String(field.field));
      return;
    }
    setManual((current) => ({ ...current, [field.field]: "" }));
  }

  async function merge() {
    const invalidManualFields = resolved.filter(({ field, choice }) => choice === "manual" && !(manual[field.field] ?? "").trim());
    if (invalidManualFields.length > 0) {
      const message = `还有 ${invalidManualFields.length} 个字段未选择`;
      setValidationError(message);
      setPendingFocusField(String(invalidManualFields[0].field.field));
      return;
    }
    setValidationError(null);
    setSubmitError(null);
    try {
      await resolveConflict.mutateAsync({
        contractId: id,
        resolutions: Object.fromEntries(resolved.map(({ field, choice }) => [
          field.field,
          choice === "manual" ? (manual[field.field] ?? "").trim() : choice
        ]))
      });
      toast.success(`已合并 ${id}，生成新基线`);
      navigate("/processing");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setSubmitError("数据已更新，请重新核对");
        toast.error("数据已更新，请重新核对");
        await refetch();
        return;
      }
      setSubmitError("合并失败，请重试");
      toast.error("合并失败，请重试");
    }
  }

  return (
    <>
      <PageHeader
        title="解决冲突"
        subtitle={`${conflictFields.length} 个字段冲突 · ${id} · Jushi Egypt For Fiberglass Industry S.A.E`}
        actions={<Link className="button button-secondary" to="/processing"><ArrowLeft size={15} />返回</Link>}
      />
      <div className="content-pad conflict-layout">
        {isLoading ? (
          <Card><div className="skeleton-list" /></Card>
        ) : isError ? (
          <Card>
            <ErrorState text={`加载失败：${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          </Card>
        ) : conflictFields.length === 0 ? (
          <Card>
            <EmptyState
              text="该合同的冲突已被解决"
              action={<Link className="button button-primary" to="/processing">返回</Link>}
            />
          </Card>
        ) : (
          <>
        <div className="notice">以下字段在数据库和 Excel 台账中出现不一致。基线 = 上次同步时的值，帮助你判断改动来自哪一方。请逐字段选择要保留的版本。</div>
        <Card>
          <div className="section-title">
            冲突字段（{conflictFields.length}）
            <Button onClick={() => setShowConsistentFields((current) => !current)}>
              {showConsistentFields ? "收起" : "展开全部字段"}
            </Button>
          </div>
          <table className="data-table conflict-table">
            <thead>
              <tr>
                <th>字段</th>
                <th>基线<br /><small>上次导出</small></th>
                <th>系统<br /><small>数据库</small></th>
                <th>台账<br /><small>Excel</small></th>
                <th>选择保留版本</th>
              </tr>
            </thead>
            <tbody>
              {conflictFields.map((field) => {
                const choice = choices[field.field] ?? field.suggested ?? "system";
                return (
                  <tr key={field.field}>
                    <td><span className="field-name">{field.field}</span><OwnerBadge owner={field.owner} /></td>
                    <td className="muted-cell">{field.baseline}</td>
                    <td className={field.system !== field.baseline ? "diff-cell" : ""}>{field.system}</td>
                    <td className={field.excel !== field.baseline ? "diff-cell" : ""}>{field.excel}</td>
                    <td>
                      <div className="radio-stack">
                        <label><input type="radio" name={field.field} checked={choice === "system"} disabled={resolveConflict.isPending} onChange={() => choose(field, "system")} />用系统值</label>
                        <label><input type="radio" name={field.field} checked={choice === "excel"} disabled={resolveConflict.isPending} onChange={() => choose(field, "excel")} />用台账值</label>
                        <label><input type="radio" name={field.field} aria-label="手动输入" checked={choice === "manual"} disabled={resolveConflict.isPending} onChange={() => choose(field, "manual")} />手动输入</label>
                        {choice === "manual" ? (
                          <input
                            className="input"
                            placeholder="输入要保留的值"
                            aria-invalid={Boolean(validationError && !(manual[field.field] ?? "").trim())}
                            disabled={resolveConflict.isPending}
                            ref={(node) => { manualInputs.current[String(field.field)] = node; }}
                            value={manual[field.field] ?? ""}
                            onChange={(event) => {
                              setValidationError(null);
                              setManual((current) => ({ ...current, [field.field]: event.target.value }));
                            }}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
        {showConsistentFields ? (
          <Card>
            <div className="section-title">无冲突字段（{consistentFields.length}）</div>
            <table className="data-table conflict-table consistent-table" aria-label="无冲突字段">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>系统</th>
                  <th>台账</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {consistentFields.map((field) => (
                  <tr key={field.field}>
                    <td><span className="field-name">{field.field}</span><OwnerBadge owner={field.owner} /></td>
                    <td className="muted-cell">{field.value}</td>
                    <td className="muted-cell">{field.value}</td>
                    <td><span className="tag tag-consistent">一致</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ) : null}
        <footer className="sticky-summary">
          <div>
            <strong>本次将采用：</strong>
            {resolved.map(({ field, choice }) => <span className="summary-chip" key={field.field}>{field.field}={choice === "manual" ? "手动" : choice === "system" ? "用系统值" : "用台账值"}</span>)}
            {validationError ? <p className="merge-error" role="alert">{validationError}</p> : null}
            {submitError ? <p className="merge-error" role="alert">{submitError}</p> : null}
          </div>
          <div className="sticky-summary-actions">
            <Link className="button button-secondary" to="/processing">取消</Link>
            <Button variant="primary" loading={resolveConflict.isPending} onClick={() => void merge()}>确认合并</Button>
          </div>
        </footer>
          </>
        )}
      </div>
    </>
  );
}

const consistentFields: Array<{ field: string; owner: "system" | "human"; value: string }> = [
  { field: "project_name", owner: "system", value: "UD 玻纤增强复合材料采购" },
  { field: "contract_type", owner: "system", value: "Supply Agreement" },
  { field: "petitioner", owner: "human", value: "王立" }
];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}
