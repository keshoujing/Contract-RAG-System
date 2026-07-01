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
  const [extractStage, setExtractStage] = useState("OCR-reading the approval page and extracting contract fields…");
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
      toast.success(`Registered ${result.contract_id}`);
      navigate(`/contracts/${result.contract_id}`);
    } catch (error) {
      if (!overwrite && isDuplicateContractError(error)) {
        setPendingOverwrite(true);
        return;
      }
      setUploadError("Registration failed, please retry");
      toast.error("Registration failed, please retry");
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
      setUploadError("PDF only");
      return;
    }
    if (file.size > maxUploadSizeMb * 1024 * 1024) {
      setUploadError(`File too large (${maxUploadSizeMb}MB max)`);
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
      setUploadError("Upload failed, please retry");
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
    setExtractStage("OCR-reading the approval page and extracting contract fields…");
    try {
      if (taskId) {
        await submitPageTags(taskId, pageRoles);
        setExtractStage("Structuring fields with a small model and generating the registration form…");
        const ingestStatus = await getIngestStatus(taskId);
        setConfirmFields((current) => ({ ...current, ...normalizeConfirmFields(ingestStatus.fields) }));
        setFieldConfidence(ingestStatus._per_field_confidence ?? {});
        setSourceSpans(ingestStatus._per_field_source_span ?? {});
      }
    } catch (error) {
      const message = isLowQualityOcrError(error) ? "Recognition quality too low; re-upload a clearer scan" : "Extraction failed, please retry";
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
      <PageHeader title={step === 3 ? "Confirm registration fields" : "Upload contract registration"} subtitle={uploadSummary || "Upload PDF → tag the approval page → confirm fields → register"} />
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
          <span>{step === 1 ? (uploadError || (uploadSummary ? `Selected: ${uploadSummary}` : "PDF only")) : step === 2 ? (uploadError || getTaggingHint({ taggedCount, pageCount, hasApproval, hasContract, canExtract })) : isExtracting ? extractStage : "8 fields extracted · 1 low-confidence to review"}</span>
          <div>
            {step === 1 ? <Link to="/ledger" className="button button-secondary">Cancel</Link> : <Button onClick={() => setStep((current) => (current === 3 ? 2 : 1))}>Back</Button>}
            {step === 1 ? <Button variant="primary" disabled={!hasUploadedFile} onClick={() => setStep(2)}>Next</Button> : null}
            {step === 2 ? <Button variant="primary" loading={isExtracting} disabled={!canExtract} onClick={continueToConfirmStep}>Next: extract fields</Button> : null}
            {step === 3 ? <Button variant="primary" icon={<CheckCircle2 size={16} />} loading={isConfirming} disabled={!canConfirmEntry} onClick={confirmEntry}>Confirm registration</Button> : null}
          </div>
        </footer>
      </div>
      {pendingOverwrite ? (
        <div className="modal-layer">
          <div className="modal-scrim" onClick={() => setPendingOverwrite(false)} />
          <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="upload-overwrite-title">
            <h2 id="upload-overwrite-title">Overwrite existing contract?</h2>
            <p>Contract {confirmFields.contract_id} already exists; registering will overwrite the existing data (including the vector store and archive). Continue?</p>
            <footer>
              <Button onClick={() => setPendingOverwrite(false)}>Cancel</Button>
              <Button variant="danger" loading={isConfirming} onClick={() => void submitConfirmEntry(true)}>Confirm overwrite</Button>
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
      <h2>Drag a PDF here, or click to choose</h2>
      <p>{uploadedFile ? formatUploadSummary(uploadedFile) : "After upload, the system generates page thumbnails; next you tag the approval page."}</p>
      {isUploading ? (
        <div className="upload-progress" role="status" aria-live="polite">
          <span>Uploading {progress}%</span>
          <progress value={progress} max={100} aria-label="Upload progress" />
        </div>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <label className="button button-primary">
        <UploadCloud size={16} />
        <span>{uploadedFile ? "Re-upload" : "Choose PDF"}</span>
        <input className="sr-only" type="file" accept="application/pdf,.pdf" aria-label="Choose PDF file" onChange={handleInputChange} />
      </label>
      {hasUploadedFile ? (
        <label className="field-block">
          <span>Contract Version</span>
          <select aria-label="Contract Version" value={contractVersion} onChange={(e) => onContractVersionChange(e.target.value)}>
            <option value="">Select a contract version</option>
            {contractVersions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      ) : null}
    </Card>
  );
}

function formatUploadSummary(file: UploadedFile) {
  return `${file.name} · ${file.pages} pages · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
}

const PAGE_ROLE_LABELS: Record<PageRole, string> = {
  approval: "Approval",
  contract: "Contract",
  other: "Other"
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
  if (canExtract) return `Tagged ${taggedCount}/${pageCount} pages`;
  if (taggedCount < pageCount) return `${pageCount - taggedCount} page(s) untagged (every page must be tagged)`;
  if (!hasApproval) return "Tag at least one approval page";
  if (!hasContract) return "Tag at least one contract page";
  return `Tagged ${taggedCount}/${pageCount} pages`;
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
          <h2>Tag each page: Approval / Contract / Other</h2>
          <p>Pick a type first, then click a thumbnail to tag it. If a page is hard to read, click the magnifier in the top-right to zoom in. Every page must be tagged, with at least one approval and one contract page. The system only extracts fields from the approval page; contract pages are used for the "contract-only" download, and the rest are archived as-is.</p>
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
        <button type="button" className="role-brush" onClick={onFillRest}>Set rest as Contract</button>
      </div>
      <div className="thumbnail-grid">
        {pages.map((page) => {
          const role = pageRoles[page];
          return (
            <div key={page} className="thumbnail-item">
              <button aria-label={`Tag page ${page}`} className={`thumbnail ${role ? "selected" : ""}`} onClick={() => onPaint(page)}>
                {role ? <span className={`page-role-badge role-${role}`}>{PAGE_ROLE_LABELS[role]}</span> : null}
                <PageThumbnail taskId={taskId} page={page} />
                <strong>Page {page}</strong>
              </button>
              <button
                type="button"
                className="thumbnail-zoom"
                aria-label={`Zoom in on page ${page}`}
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
      <section className="lightbox" role="dialog" aria-modal="true" aria-label={`Page ${page} preview`}>
        <header className="lightbox-bar">
          <strong>Page {page} / {pageCount}{role ? ` · ${PAGE_ROLE_LABELS[role]}` : ""}</strong>
          <button type="button" className="lightbox-close" aria-label="Close preview" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="lightbox-stage">
          <button type="button" className="lightbox-nav" aria-label="Previous page" disabled={!hasPrev} onClick={() => onNavigate(page - 1)}>
            <ChevronLeft size={22} />
          </button>
          <img className="lightbox-image" src={uploadPageUrl(taskId, page)} alt={`Page ${page}`} />
          <button type="button" className="lightbox-nav" aria-label="Next page" disabled={!hasNext} onClick={() => onNavigate(page + 1)}>
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
      alt={`Page ${page} preview`}
      loading="lazy"
      onError={() => setErrored(true)}
    />
  );
}

interface ConfirmFields {
  contract_id: string;
  amount: string;
  // pricing period: "" unspecified / "0" one-time / "<n>" N months (used for annualized-price conversion)
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
  petitioner: "Wang Li",
  effective_date: "",
  expiration_date: ""
};

type FieldState = "High confidence" | "Low confidence" | "Manual";

const confirmFieldMeta: Array<{ key: keyof ConfirmFields; label: string; state: FieldState; required?: boolean }> = [
  { key: "contract_id", label: "Contract No.", state: "High confidence", required: true },
  { key: "amount", label: "Amount", state: "High confidence", required: true },
  { key: "counterparty", label: "Counterparty", state: "High confidence" },
  { key: "project_name", label: "Project Name", state: "Low confidence" },
  { key: "department", label: "Requesting Dept.", state: "High confidence" },
  { key: "petitioner", label: "Petitioner", state: "High confidence" },
  { key: "effective_date", label: "Effective Date", state: "Manual", required: true },
  { key: "expiration_date", label: "Expiration Date", state: "Manual", required: true }
];

function ApprovalPreview({ taskId, approvalPage, isExtracting }: { taskId: string; approvalPage: number; isExtracting: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const showImage = Boolean(taskId);

  if (isExtracting) {
    return <PaperSkeleton label="Loading approval-page preview" />;
  }

  if (!showImage) {
    return (
      <div className="paper paper-empty">
        <FileText size={40} aria-hidden="true" />
        <p>No approval-page preview</p>
      </div>
    );
  }

  return (
    <div className="paper paper-image">
      {!loaded ? <PaperSkeleton label="Loading approval-page preview" inline /> : null}
      <img
        className={loaded ? "" : "paper-image-hidden"}
        src={uploadPageUrl(taskId, approvalPage)}
        alt={`Approval page ${approvalPage}`}
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
        <div className="pdf-toolbar">Approval-page preview · page {approvalPage}</div>
        <ApprovalPreview taskId={taskId} approvalPage={approvalPage} isExtracting={isExtracting} />
      </Card>
      <Card className="field-panel">
        <div className="section-title">Registration fields <span>8 fields extracted · 1 low-confidence to review</span></div>
        {isExtracting ? (
          <div className="field-extracting" role="status" aria-label="Extracting fields">
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
          const state: FieldState = isMissingContractId
            ? "Manual"
            : confidence !== undefined
              ? (confidence < 0.75 ? "Low confidence" : "High confidence")
              : defaultState;
          const sourceSpan = sourceSpans[key];
          const fieldNode = (
          <label className={`confirm-field ${state === "Low confidence" ? "low-confidence" : state === "Manual" ? "need-fill" : ""}`} key={label}>
            <span>{label}{required ? <b>*</b> : null}<em>{state === "Low confidence" && confidence !== undefined ? `confidence ${Math.round(confidence * 100)}%` : state}</em></span>
            {isConfirmDateField(key) ? (
              <DateField
                label={label}
                name={key}
                value={values[key]}
                ariaInvalid={isInvalidDateOrder || validationField === key ? "true" : "false"}
                placeholder={state === "Manual" ? "Select a date" : undefined}
                ref={(node) => onRegisterField(key, node)}
                onChange={(value) => onChange(key, value)}
              />
            ) : (
              <input
                aria-label={label}
                aria-invalid={isMissingContractId || validationField === key ? "true" : "false"}
                name={key}
                value={values[key]}
                placeholder={state === "Manual" ? "Enter manually" : undefined}
                ref={(node) => onRegisterField(key, node)}
                onChange={(event) => onChange(key, event.target.value)}
              />
            )}
            {isMissingContractId ? <small><AlertCircle size={13} />Contract number not detected; enter it manually</small> : null}
            {state === "Low confidence" ? <small><AlertCircle size={13} />Recognized as "{sourceSpan ?? values[key]}" in the source; please verify</small> : null}
            {isInvalidDateOrder ? <small><AlertCircle size={13} />Expiration date cannot be earlier than the effective date</small> : null}
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
          <span>Archive category<b>*</b><em>Auto-number</em></span>
          <select aria-label="Archive category" name="category" value={category} onChange={(event) => onCategoryChange(event.target.value)}>
            <option value="ordinary">Ordinary contract · 2026001</option>
            <option value="china-buy">China purchase · CN2026001</option>
            <option value="production">Production contract · PD2026001</option>
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
      <span>Pricing method<em>Used for annualized-price conversion</em></span>
      <div className="term-controls">
        <div className="term-toggle" role="group" aria-label="Pricing method">
          <button type="button" aria-pressed={!isOneTime} className={!isOneTime ? "active" : ""} onClick={() => onChange(months)}>By contract term</button>
          <button type="button" aria-pressed={isOneTime} className={isOneTime ? "active" : ""} onClick={() => onChange("0")}>One-time</button>
        </div>
        {!isOneTime ? (
          <div className="term-months">
            <input
              aria-label="Contract term in months"
              inputMode="numeric"
              placeholder="Months"
              value={months}
              onChange={(event) => onChange(event.target.value.replace(/[^0-9]/g, ""))}
            />
            <span>months</span>
          </div>
        ) : null}
      </div>
      {isOneTime ? (
        <small className="term-hint">One-time purchase, time-independent; no annualized price</small>
      ) : yearly ? (
        <small className="term-hint">Annualized ≈ {yearly}</small>
      ) : (
        <small className="term-hint">Enter months to auto-compute the annualized price</small>
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
  const steps = ["Upload", "Tag approval page", "Confirm fields"];
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
