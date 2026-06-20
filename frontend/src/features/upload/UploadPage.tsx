import { type ChangeEvent, type DragEvent, Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AlertCircle, CheckCircle2, ChevronLeft, ChevronRight, FileText, UploadCloud, X, ZoomIn } from "lucide-react";
import { ApiError, confirmIngest, getIngestStatus, submitPageTags, uploadIngestFile, uploadPageUrl } from "../../api/client";
import type { PageRole } from "../../api/types";
import { useConfig } from "../../api/hooks";
import { Button } from "../../components/ui/Button";
import { DateField } from "../../components/ui/DateField";
import { Card, PageHeader } from "../../components/ui/Panel";
import { useToast } from "../../components/ui/Toast";

const maxUploadSizeMb = 50;

export function UploadPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [uploadedFile, setUploadedFile] = useState<UploadedFile | null>(null);
  const [uploadError, setUploadError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [pageRoles, setPageRoles] = useState<Record<number, PageRole>>({});
  const [brush, setBrush] = useState<PageRole>("approval");
  const [taskId, setTaskId] = useState("");
  const [category, setCategory] = useState("ordinary");
  const [contractVersion, setContractVersion] = useState("");
  const [fieldConfidence, setFieldConfidence] = useState<Record<string, number>>({});
  const [sourceSpans, setSourceSpans] = useState<Record<string, string>>({});
  const [confirmFields, setConfirmFields] = useState<ConfirmFields>(defaultConfirmFields);
  const [pendingOverwrite, setPendingOverwrite] = useState(false);
  const [validationField, setValidationField] = useState<keyof ConfirmFields | null>(null);
  const [extractStage, setExtractStage] = useState("OCR 识别审批页，抽取合同字段中…");
  const fieldInputs = useRef<Partial<Record<keyof ConfirmFields, HTMLInputElement | null>>>({});
  const navigate = useNavigate();
  const toast = useToast();
  const { data: config } = useConfig();
  const hasUploadedFile = Boolean(uploadedFile) && !isUploading;
  const canConfirmEntry = Boolean(confirmFields.contract_id && confirmFields.amount && confirmFields.effective_date && confirmFields.expiration_date) && !isExtracting;
  const pageCount = uploadedFile?.pages ?? 0;
  const taggedCount = Object.keys(pageRoles).length;
  const allTagged = pageCount > 0 && taggedCount === pageCount;
  const hasApproval = Object.values(pageRoles).includes("approval");
  const hasContract = Object.values(pageRoles).includes("contract");
  const canExtract = allTagged && hasApproval && hasContract;
  const approvalPage = Number(Object.entries(pageRoles).find(([, role]) => role === "approval")?.[0]) || 1;

  function updateConfirmField(field: keyof ConfirmFields, value: string) {
    if (validationField === field) setValidationField(null);
    setConfirmFields((current) => ({ ...current, [field]: value }));
  }

  async function confirmEntry() {
    const invalidField = getFirstInvalidConfirmField(confirmFields);
    if (invalidField) {
      setValidationField(invalidField);
      fieldInputs.current[invalidField]?.focus();
      return;
    }
    await submitConfirmEntry(false);
  }

  async function submitConfirmEntry(overwrite: boolean) {
    if (!canConfirmEntry || getFirstInvalidConfirmField(confirmFields)) return;
    setIsConfirming(true);
    try {
      // Omit term_months when unspecified ("") so it stays NULL; only send a
      // chosen pricing term ("0" one-time, or a month count).
      const { term_months, ...baseFields } = confirmFields;
      const result = taskId
        ? await confirmIngest(taskId, {
          fields: {
            ...baseFields,
            ...(term_months ? { term_months } : {}),
            ...(contractVersion ? { contract_type: contractVersion } : {})
          },
          effective_date: confirmFields.effective_date,
          expiration_date: confirmFields.expiration_date,
          category,
          ...(overwrite ? { overwrite: true } : {})
        })
        : { contract_id: confirmFields.contract_id };
      setPendingOverwrite(false);
      toast.success(`已入账 ${result.contract_id}`);
      navigate(`/contracts/${result.contract_id}`);
    } catch (error) {
      if (!overwrite && isDuplicateContractError(error)) {
        setPendingOverwrite(true);
        return;
      }
      setUploadError("入账失败，请重试");
      toast.error("入账失败，请重试");
    } finally {
      setIsConfirming(false);
    }
  }

  async function selectUploadFile(file?: File) {
    if (!file) return;
    setUploadError("");
    setUploadedFile(null);
    setTaskId("");
    setPendingOverwrite(false);
    setPageRoles({});
    setBrush("approval");
    setUploadProgress(0);
    setValidationField(null);

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setUploadError("仅支持 PDF");
      return;
    }
    if (file.size > maxUploadSizeMb * 1024 * 1024) {
      setUploadError(`文件过大（上限 ${maxUploadSizeMb}MB）`);
      return;
    }

    setIsUploading(true);
    setUploadProgress(42);
    try {
      const [uploadResult] = await Promise.all([uploadIngestFile(file), delay(350)]);
      setTaskId(uploadResult.task_id);
      setUploadedFile({ name: file.name, size: file.size, pages: uploadResult.page_count });
      setUploadProgress(100);
    } catch {
      setUploadError("上传失败，请重试");
      setUploadProgress(0);
    } finally {
      setIsUploading(false);
    }
  }

  function setPageRole(page: number, role: PageRole) {
    setPageRoles((current) => ({ ...current, [page]: role }));
  }

  function paintPage(page: number) {
    setPageRole(page, brush);
  }

  function fillRestAsContract() {
    setPageRoles((current) => {
      const next = { ...current };
      for (let page = 1; page <= pageCount; page += 1) {
        if (!next[page]) next[page] = "contract";
      }
      return next;
    });
  }

  async function continueToConfirmStep() {
    if (!canExtract) return;
    setStep(3);
    setIsExtracting(true);
    setUploadError("");
    setValidationField(null);
    setExtractStage("OCR 识别审批页，抽取合同字段中…");
    try {
      if (taskId) {
        await submitPageTags(taskId, pageRoles);
        setExtractStage("小模型结构化字段，生成登记表单中…");
        const ingestStatus = await getIngestStatus(taskId);
        setConfirmFields((current) => ({ ...current, ...normalizeConfirmFields(ingestStatus.fields) }));
        setFieldConfidence(ingestStatus._per_field_confidence ?? {});
        setSourceSpans(ingestStatus._per_field_source_span ?? {});
      }
    } catch (error) {
      const message = isLowQualityOcrError(error) ? "识别质量过低，请重传更清晰的扫描件" : "抽取失败，请重试";
      setUploadError(message);
      toast.error(message);
      setStep(isLowQualityOcrError(error) ? 1 : 2);
    } finally {
      setIsExtracting(false);
    }
  }

  const uploadSummary = uploadedFile ? formatUploadSummary(uploadedFile) : "";

  return (
    <>
      <PageHeader title={step === 3 ? "确认登记字段" : "上传合同登记"} subtitle={uploadSummary || "上传 PDF → 指认审批页 → 确认字段 → 入账"} />
      <div className="content-pad wizard-page">
        <StepBar current={step} />
        {step === 1 ? <UploadStep uploadedFile={uploadedFile} error={uploadError} progress={uploadProgress} isUploading={isUploading} onSelect={selectUploadFile} contractVersion={contractVersion} contractVersions={config?.contractVersions ?? []} onContractVersionChange={setContractVersion} /> : null}
        {step === 2 ? <ApprovalStep taskId={taskId} pageCount={pageCount} pageRoles={pageRoles} brush={brush} onBrush={setBrush} onPaint={paintPage} onSetRole={setPageRole} onFillRest={fillRestAsContract} /> : null}
        {step === 3 ? (
          <ConfirmStep
            taskId={taskId}
            approvalPage={approvalPage}
            values={confirmFields}
            category={category}
            fieldConfidence={fieldConfidence}
            sourceSpans={sourceSpans}
            isExtracting={isExtracting}
            extractStage={extractStage}
            validationField={validationField}
            onCategoryChange={setCategory}
            onChange={updateConfirmField}
            onRegisterField={(field, node) => {
              fieldInputs.current[field] = node;
            }}
          />
        ) : null}
        <footer className="wizard-footer">
          <span>{step === 1 ? (uploadError || (uploadSummary ? `已选择：${uploadSummary}` : "仅支持 PDF")) : step === 2 ? (uploadError || getTaggingHint({ taggedCount, pageCount, hasApproval, hasContract, canExtract })) : isExtracting ? extractStage : "8 个字段已抽取 · 1 个低置信待核对"}</span>
          <div>
            {step === 1 ? <Link to="/ledger" className="button button-secondary">取消</Link> : <Button onClick={() => setStep((current) => (current === 3 ? 2 : 1))}>上一步</Button>}
            {step === 1 ? <Button variant="primary" disabled={!hasUploadedFile} onClick={() => setStep(2)}>下一步</Button> : null}
            {step === 2 ? <Button variant="primary" loading={isExtracting} disabled={!canExtract} onClick={continueToConfirmStep}>下一步：抽取字段</Button> : null}
            {step === 3 ? <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={isConfirming} disabled={!canConfirmEntry} onClick={confirmEntry}>确认入账</Button> : null}
          </div>
        </footer>
      </div>
      {pendingOverwrite ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setPendingOverwrite(false)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="upload-overwrite-title">
            <h2 id="upload-overwrite-title">覆盖已有合同？</h2>
            <p>合同 {confirmFields.contract_id} 已存在，入账将覆盖原数据（含向量库与存档），是否继续？</p>
            <footer>
              <Button onClick={() => setPendingOverwrite(false)}>取消</Button>
              <Button variant="danger" loading={isConfirming} onClick={() => void submitConfirmEntry(true)}>确认覆盖</Button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeConfirmFields(fields: Record<string, string | number | null | undefined>): Partial<ConfirmFields> {
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key, value]) => key in defaultConfirmFields && value !== null && value !== undefined)
      .map(([key, value]) => [key, String(value)])
  ) as Partial<ConfirmFields>;
}

function isDuplicateContractError(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function isLowQualityOcrError(error: unknown) {
  return error instanceof ApiError && (error.status === 422 || error.bodyText.includes("low_quality"));
}

interface UploadedFile {
  name: string;
  size: number;
  pages: number;
}

function UploadStep({
  uploadedFile,
  error,
  progress,
  isUploading,
  onSelect,
  contractVersion,
  contractVersions,
  onContractVersionChange
}: {
  uploadedFile: UploadedFile | null;
  error: string;
  progress: number;
  isUploading: boolean;
  onSelect: (file?: File) => void;
  contractVersion: string;
  contractVersions: string[];
  onContractVersionChange: (value: string) => void;
}) {
  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    onSelect(event.target.files?.[0]);
    event.target.value = "";
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    onSelect(event.dataTransfer.files?.[0]);
  }

  const hasUploadedFile = Boolean(uploadedFile) && !isUploading;

  return (
    <Card
      className={`upload-drop ${error ? "upload-drop-error" : ""}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={handleDrop}
    >
      <UploadCloud size={42} />
      <h2>拖拽 PDF 到此处，或点击选择</h2>
      <p>{uploadedFile ? formatUploadSummary(uploadedFile) : "上传后系统会生成页面缩略图，下一步由你指认审批页。"}</p>
      {isUploading ? (
        <div className="upload-progress" role="status" aria-live="polite">
          <span>上传中 {progress}%</span>
          <progress value={progress} max={100} aria-label="上传进度" />
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <label className="button button-primary">
        <UploadCloud size={16} />
        <span>{uploadedFile ? "重新上传" : "选择 PDF"}</span>
        <input className="sr-only" type="file" accept="application/pdf,.pdf" aria-label="选择 PDF 文件" onChange={handleInputChange} />
      </label>
      {hasUploadedFile ? (
        <label className="field-block">
          <span>合同版本</span>
          <select aria-label="合同版本" value={contractVersion} onChange={(e) => onContractVersionChange(e.target.value)}>
            <option value="">请选择合同版本</option>
            {contractVersions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      ) : null}
    </Card>
  );
}

function formatUploadSummary(file: UploadedFile) {
  return `${file.name} · ${file.pages} 页 · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
}

const PAGE_ROLE_LABELS: Record<PageRole, string> = {
  approval: "审批",
  contract: "合同",
  other: "其他"
};

const PAGE_ROLE_ORDER: PageRole[] = ["approval", "contract", "other"];

function getTaggingHint({
  taggedCount,
  pageCount,
  hasApproval,
  hasContract,
  canExtract
}: {
  taggedCount: number;
  pageCount: number;
  hasApproval: boolean;
  hasContract: boolean;
  canExtract: boolean;
}) {
  if (canExtract) return `已标注 ${taggedCount}/${pageCount} 页`;
  if (taggedCount < pageCount) return `还有 ${pageCount - taggedCount} 页未标注（每页都需标注）`;
  if (!hasApproval) return "请至少标注一页审批页";
  if (!hasContract) return "请至少标注一页合同页";
  return `已标注 ${taggedCount}/${pageCount} 页`;
}

function ApprovalStep({
  taskId,
  pageCount,
  pageRoles,
  brush,
  onBrush,
  onPaint,
  onSetRole,
  onFillRest
}: {
  taskId: string;
  pageCount: number;
  pageRoles: Record<number, PageRole>;
  brush: PageRole;
  onBrush: (role: PageRole) => void;
  onPaint: (page: number) => void;
  onSetRole: (page: number, role: PageRole) => void;
  onFillRest: () => void;
}) {
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1);
  const [zoomPage, setZoomPage] = useState<number | null>(null);

  return (
    <Card className="upload-panel">
      <div className="upload-copy">
        <UploadCloud size={24} />
        <div>
          <h2>逐页标注：审批 / 合同 / 其他</h2>
          <p>先选类型，再点缩略图标注。看不清时点右上角放大镜放大查看。每一页都需标注，且至少各有一页审批与合同。系统只从审批页抽取字段，合同页用于「仅合同」下载，其余原样存档。</p>
        </div>
      </div>
      <div className="role-brushes">
        {PAGE_ROLE_ORDER.map((role) => (
          <button
            key={role}
            type="button"
            aria-label={PAGE_ROLE_LABELS[role]}
            aria-pressed={brush === role}
            className={`role-brush ${brush === role ? "active" : ""}`}
            onClick={() => onBrush(role)}
          >
            {PAGE_ROLE_LABELS[role]}
          </button>
        ))}
        <button type="button" className="role-brush" onClick={onFillRest}>其余设为合同</button>
      </div>
      <div className="thumbnail-grid">
        {pages.map((page) => {
          const role = pageRoles[page];
          return (
            <div key={page} className="thumbnail-item">
              <button aria-label={`标注第 ${page} 页`} className={`thumbnail ${role ? "selected" : ""}`} onClick={() => onPaint(page)}>
                {role ? <span className={`page-role-badge role-${role}`}>{PAGE_ROLE_LABELS[role]}</span> : null}
                <PageThumbnail taskId={taskId} page={page} />
                <strong>第 {page} 页</strong>
              </button>
              <button
                type="button"
                className="thumbnail-zoom"
                aria-label={`放大查看第 ${page} 页`}
                onClick={() => setZoomPage(page)}
              >
                <ZoomIn size={15} />
              </button>
            </div>
          );
        })}
      </div>
      {zoomPage !== null ? (
        <PageLightbox
          taskId={taskId}
          page={zoomPage}
          pageCount={pageCount}
          role={pageRoles[zoomPage]}
          onNavigate={setZoomPage}
          onSetRole={onSetRole}
          onClose={() => setZoomPage(null)}
        />
      ) : null}
    </Card>
  );
}

function PageLightbox({
  taskId,
  page,
  pageCount,
  role,
  onNavigate,
  onSetRole,
  onClose
}: {
  taskId: string;
  page: number;
  pageCount: number;
  role: PageRole | undefined;
  onNavigate: (page: number) => void;
  onSetRole: (page: number, role: PageRole) => void;
  onClose: () => void;
}) {
  const hasPrev = page > 1;
  const hasNext = page < pageCount;

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      else if (event.key === "ArrowLeft" && page > 1) onNavigate(page - 1);
      else if (event.key === "ArrowRight" && page < pageCount) onNavigate(page + 1);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [page, pageCount, onNavigate, onClose]);

  return (
    <div className="modal-layer">
      <div className="modal-scrim" onClick={onClose} />
      <section className="lightbox" role="dialog" aria-modal="true" aria-label={`第 ${page} 页预览`}>
        <header className="lightbox-bar">
          <strong>第 {page} / {pageCount} 页{role ? ` · ${PAGE_ROLE_LABELS[role]}` : ""}</strong>
          <button type="button" className="lightbox-close" aria-label="关闭预览" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="lightbox-stage">
          <button type="button" className="lightbox-nav" aria-label="上一页" disabled={!hasPrev} onClick={() => onNavigate(page - 1)}>
            <ChevronLeft size={22} />
          </button>
          <img className="lightbox-image" src={uploadPageUrl(taskId, page)} alt={`第 ${page} 页`} />
          <button type="button" className="lightbox-nav" aria-label="下一页" disabled={!hasNext} onClick={() => onNavigate(page + 1)}>
            <ChevronRight size={22} />
          </button>
        </div>
        <footer className="lightbox-roles">
          {PAGE_ROLE_ORDER.map((roleOption) => (
            <button
              key={roleOption}
              type="button"
              aria-pressed={role === roleOption}
              className={`role-brush ${role === roleOption ? "active" : ""}`}
              onClick={() => onSetRole(page, roleOption)}
            >
              {PAGE_ROLE_LABELS[roleOption]}
            </button>
          ))}
        </footer>
      </section>
    </div>
  );
}

const MAX_THUMBNAIL_RETRIES = 6;
const THUMBNAIL_RETRY_MS = 600;

function PageThumbnail({ taskId, page }: { taskId: string; page: number }) {
  const [attempt, setAttempt] = useState(0);
  const [errored, setErrored] = useState(false);
  const failed = errored && attempt >= MAX_THUMBNAIL_RETRIES;

  // Thumbnails render in a backend background task, so an early request can 404.
  // Retry a few times with a short delay before falling back to the icon.
  useEffect(() => {
    if (!errored || attempt >= MAX_THUMBNAIL_RETRIES) return undefined;
    const timer = window.setTimeout(() => {
      setErrored(false);
      setAttempt((current) => current + 1);
    }, THUMBNAIL_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [errored, attempt]);

  if (!taskId || failed) {
    return <FileText size={26} aria-hidden="true" />;
  }

  const baseUrl = uploadPageUrl(taskId, page);
  const src = attempt === 0 ? baseUrl : `${baseUrl}?retry=${attempt}`;

  return (
    <img
      className="thumbnail-image"
      src={src}
      alt={`第 ${page} 页预览`}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

interface ConfirmFields {
  contract_id: string;
  amount: string;
  // 计价期: "" 未指定 / "0" 一次性 / "<n>" N 个月（用于年均价折算）
  term_months: string;
  counterparty: string;
  project_name: string;
  department: string;
  petitioner: string;
  effective_date: string;
  expiration_date: string;
}

const defaultConfirmFields: ConfirmFields = {
  contract_id: "JSUS2026005",
  amount: "$147,664.05",
  term_months: "",
  counterparty: "Owens Corning Composites",
  project_name: "UD Glass Fiber Reinforced Composite Procurement",
  department: "UD",
  petitioner: "王立 Wang Li",
  effective_date: "",
  expiration_date: ""
};

const confirmFieldMeta: Array<{ key: keyof ConfirmFields; label: string; state: "高置信" | "低置信" | "需手填"; required?: boolean }> = [
  { key: "contract_id", label: "合同编号", state: "高置信", required: true },
  { key: "amount", label: "合同金额", state: "高置信", required: true },
  { key: "counterparty", label: "对方公司", state: "高置信" },
  { key: "project_name", label: "项目名称", state: "低置信" },
  { key: "department", label: "申请部门", state: "高置信" },
  { key: "petitioner", label: "申请人", state: "高置信" },
  { key: "effective_date", label: "生效日", state: "需手填", required: true },
  { key: "expiration_date", label: "到期日", state: "需手填", required: true }
];

function ApprovalPreview({ taskId, approvalPage, isExtracting }: { taskId: string; approvalPage: number; isExtracting: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const showImage = Boolean(taskId);

  if (isExtracting) {
    return <PaperSkeleton label="正在加载审批页预览" />;
  }

  if (!showImage) {
    return (
      <div className="paper paper-empty">
        <FileText size={40} aria-hidden="true" />
        <p>暂无审批页预览</p>
      </div>
    );
  }

  return (
    <div className="paper paper-image">
      {!loaded ? <PaperSkeleton label="正在加载审批页预览" inline /> : null}
      <img
        className={loaded ? "" : "paper-image-hidden"}
        src={uploadPageUrl(taskId, approvalPage)}
        alt={`审批页 第 ${approvalPage} 页`}
        onLoad={() => setLoaded(true)}
        onError={() => setLoaded(true)}
      />
    </div>
  );
}

function PaperSkeleton({ label, inline }: { label: string; inline?: boolean }) {
  return (
    <div className={`paper paper-skeleton ${inline ? "paper-skeleton-inline" : ""}`} role="status" aria-label={label}>
      <span className="skeleton-line paper-skeleton-title" />
      <span className="skeleton-line paper-skeleton-subtitle" />
      <div className="paper-skeleton-rows">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="paper-skeleton-row" key={index}>
            <span className="skeleton-line paper-skeleton-key" />
            <span className="skeleton-line paper-skeleton-value" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmStep({
  taskId,
  approvalPage,
  values,
  category,
  fieldConfidence,
  sourceSpans,
  isExtracting,
  extractStage,
  validationField,
  onCategoryChange,
  onChange,
  onRegisterField
}: {
  taskId: string;
  approvalPage: number;
  values: ConfirmFields;
  category: string;
  fieldConfidence: Record<string, number>;
  sourceSpans: Record<string, string>;
  isExtracting: boolean;
  extractStage: string;
  validationField: keyof ConfirmFields | null;
  onCategoryChange: (value: string) => void;
  onChange: (field: keyof ConfirmFields, value: string) => void;
  onRegisterField: (field: keyof ConfirmFields, node: HTMLInputElement | null) => void;
}) {
  const hasDateError = Boolean(values.effective_date && values.expiration_date && values.expiration_date < values.effective_date);

  return (
    <div className="split-workspace">
      <Card className="pdf-preview">
        <div className="pdf-toolbar">审批页预览 · 第 {approvalPage} 页</div>
        <ApprovalPreview taskId={taskId} approvalPage={approvalPage} isExtracting={isExtracting} />
      </Card>
      <Card className="field-panel">
        <div className="section-title">登记字段 <span>8 个字段已抽取 · 1 个低置信待核对</span></div>
        {isExtracting ? (
          <div className="field-extracting" role="status" aria-label="正在抽取字段">
            <div className="skeleton-fields" aria-hidden="true">
              {confirmFieldMeta.map(({ key }) => (
                <div className="skeleton-field" key={key}>
                  <span className="skeleton-line skeleton-label" />
                  <span className="skeleton-line skeleton-input" />
                </div>
              ))}
            </div>
            <p><span className="extract-spinner" aria-hidden="true" />{extractStage}</p>
          </div>
        ) : null}
        {!isExtracting ? (
          <>
        {confirmFieldMeta.map(({ key, label, state: defaultState, required }) => {
          const confidence = fieldConfidence[key];
          const isMissingContractId = key === "contract_id" && !values.contract_id.trim();
          const isInvalidDateOrder = key === "expiration_date" && hasDateError;
          const state = isMissingContractId
            ? "需手填"
            : confidence !== undefined
              ? (confidence < 0.75 ? "低置信" : "高置信")
              : defaultState;
          const sourceSpan = sourceSpans[key];
          const fieldNode = (
          <label className={`confirm-field ${state === "低置信" ? "low-confidence" : state === "需手填" ? "need-fill" : ""}`} key={label}>
            <span>{label}{required ? <b>*</b> : null}<em>{state === "低置信" && confidence !== undefined ? `置信度 ${Math.round(confidence * 100)}%` : state}</em></span>
            {isConfirmDateField(key) ? (
              <DateField
                label={label}
                name={key}
                value={values[key]}
                ariaInvalid={isInvalidDateOrder || validationField === key ? "true" : "false"}
                placeholder={state === "需手填" ? "请选择日期" : undefined}
                ref={(node) => onRegisterField(key, node)}
                onChange={(value) => onChange(key, value)}
              />
            ) : (
              <input
                aria-label={label}
                aria-invalid={isMissingContractId || validationField === key ? "true" : "false"}
                name={key}
                value={values[key]}
                placeholder={state === "需手填" ? "请手填" : undefined}
                ref={(node) => onRegisterField(key, node)}
                onChange={(event) => onChange(key, event.target.value)}
              />
            )}
            {isMissingContractId ? <small><AlertCircle size={13} />未识别到合同编号，请手填</small> : null}
            {state === "低置信" ? <small><AlertCircle size={13} />原文识别为「{sourceSpan ?? values[key]}」，请核对</small> : null}
            {isInvalidDateOrder ? <small><AlertCircle size={13} />到期日不能早于生效日</small> : null}
          </label>
          );
          if (key === "amount") {
            return (
              <Fragment key={label}>
                {fieldNode}
                <TermField value={values.term_months} amount={values.amount} onChange={(next) => onChange("term_months", next)} />
              </Fragment>
            );
          }
          return fieldNode;
        })}
        <label className="confirm-field">
          <span>存档分类<b>*</b><em>自动编号</em></span>
          <select aria-label="存档分类" name="category" value={category} onChange={(event) => onCategoryChange(event.target.value)}>
            <option value="ordinary">普通合同 · 2026001</option>
            <option value="china-buy">中国采购 · CN2026001</option>
            <option value="production">生产合同 · PD2026001</option>
          </select>
        </label>
          </>
        ) : null}
      </Card>
    </div>
  );
}

function TermField({ value, amount, onChange }: { value: string; amount: string; onChange: (next: string) => void }) {
  const isOneTime = value === "0";
  const months = isOneTime ? "" : value;
  const yearly = formatYearlyAmount(amount, months);

  return (
    <div className="confirm-field term-field">
      <span>计价方式<em>用于年均价折算</em></span>
      <div className="term-controls">
        <div className="term-toggle" role="group" aria-label="计价方式">
          <button type="button" aria-pressed={!isOneTime} className={!isOneTime ? "active" : ""} onClick={() => onChange(months)}>按合同期</button>
          <button type="button" aria-pressed={isOneTime} className={isOneTime ? "active" : ""} onClick={() => onChange("0")}>一次性</button>
        </div>
        {!isOneTime ? (
          <div className="term-months">
            <input
              aria-label="合同期月数"
              inputMode="numeric"
              placeholder="月数"
              value={months}
              onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
            />
            <span>个月</span>
          </div>
        ) : null}
      </div>
      {isOneTime ? (
        <small className="term-hint">一次性采购，与时间无关，不折算年均价</small>
      ) : yearly ? (
        <small className="term-hint">年均价 ≈ {yearly}</small>
      ) : (
        <small className="term-hint">填写月数后自动折算年均价</small>
      )}
    </div>
  );
}

function formatYearlyAmount(amount: string, monthsStr: string): string | null {
  const months = Number(monthsStr);
  const value = Number(String(amount).replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(months) || months <= 0) return null;
  const yearly = value / (months / 12);
  const prefix = String(amount).trim().startsWith("$") ? "$" : "";
  return `${prefix}${yearly.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function getFirstInvalidConfirmField(values: ConfirmFields): keyof ConfirmFields | null {
  if (!values.contract_id.trim()) return "contract_id";
  if (!values.amount.trim()) return "amount";
  if (!values.effective_date.trim()) return "effective_date";
  if (!values.expiration_date.trim()) return "expiration_date";
  if (values.expiration_date < values.effective_date) return "expiration_date";
  return null;
}

function isConfirmDateField(field: keyof ConfirmFields) {
  return field === "effective_date" || field === "expiration_date";
}

export function StepBar({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["上传", "指认审批页", "确认字段"];
  return (
    <div className="stepbar">
      {steps.map((label, index) => {
        const step = index + 1;
        return (
          <div className={`step ${step < current ? "done" : step === current ? "current" : ""}`} key={label}>
            <span>{step}</span>
            {label}
          </div>
        );
      })}
    </div>
  );
}
