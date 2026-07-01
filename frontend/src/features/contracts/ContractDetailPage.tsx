import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Download, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { useContract } from "../../api/hooks";
import { ApiError, deleteContract, downloadContractFile, patchContract } from "../../api/client";
import type { ContractRow } from "../../api/types";
import { downloadBlob } from "../../lib/download";
import { dash, money } from "../../lib/format";
import { Button } from "../../components/ui/Button";
import { Card, ErrorState, PageHeader } from "../../components/ui/Panel";
import { BusinessStatusTag } from "../../components/ui/StatusTag";
import { useToast } from "../../components/ui/Toast";
import { ConfirmModal, EditDrawer } from "../ledger/LedgerPage";

export function ContractDetailPage() {
  const { id = "JSUS2026004" } = useParams();
  const { data: contract, error, isError, isFetching, isLoading, refetch } = useContract(id);
  const [editing, setEditing] = useState(false);
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [savedContract, setSavedContract] = useState<ContractRow | null>(null);
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState>({ status: "idle", url: "" });
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const currentContract = savedContract ?? contract;
  const returnTo = getDetailReturnTo(location.state);
  const returnState = getDetailReturnState(location.state);

  useEffect(() => {
    if (editing || detailMenuOpen || deletePending) return undefined;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      navigate(returnTo, { state: returnState });
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [deletePending, detailMenuOpen, editing, navigate, returnState, returnTo]);

  useEffect(() => {
    if (!detailMenuOpen) return undefined;
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setDetailMenuOpen(false);
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [detailMenuOpen]);

  useEffect(() => {
    if (!currentContract?.file_name) {
      setPdfPreview({ status: "missing", url: "" });
      return undefined;
    }

    const previewContract = currentContract;
    let cancelled = false;
    let objectUrl = "";
    setPdfPreview({ status: "loading", url: "" });

    async function loadPdfPreview() {
      try {
        const blob = await downloadContractFile(previewContract.contract_id);
        if (cancelled) return;
        if (typeof URL.createObjectURL !== "function") {
          throw new Error("Online preview is not supported in this environment");
        }
        objectUrl = URL.createObjectURL(blob);
        setPdfPreview({ status: "ready", url: objectUrl });
      } catch (error) {
        if (!cancelled) {
          setPdfPreview({ status: "error", url: "", error: getErrorMessage(error) });
        }
      }
    }

    void loadPdfPreview();

    return () => {
      cancelled = true;
      if (objectUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [currentContract?.contract_id, currentContract?.file_name]);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Contract detail" subtitle={`Loading ${id}`} actions={<Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />Back</Link>} />
        <div className="content-pad detail-layout">
          <Card className="pdf-viewer"><div className="skeleton-list" role="status" aria-label="Loading contract detail" /></Card>
          <Card className="detail-fields"><div className="skeleton-list" /></Card>
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <PageHeader title="Contract detail" subtitle={`${id} failed to load`} actions={<Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />Back</Link>} />
        <div className="content-pad">
          <Card>
            <ErrorState text={`Failed to load: ${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          </Card>
        </div>
      </>
    );
  }

  if (!currentContract) return null;
  const detailContract: ContractRow = currentContract;

  async function downloadPdf() {
    if (!detailContract.file_name) {
      toast.error("No archived file; cannot download PDF");
      return;
    }
    try {
      const blob = await downloadContractFile(detailContract.contract_id);
      downloadBlob(blob, detailContract.file_name || "signed.pdf");
      toast.success(`Downloaded ${detailContract.contract_id} signed.pdf`);
    } catch (downloadError) {
      toast.error(`Download failed: ${getErrorMessage(downloadError)}`);
    }
  }

  async function copyContractId() {
    try {
      await copyTextToClipboard(detailContract.contract_id);
      toast.success(`Copied ${detailContract.contract_id}`);
    } catch {
      toast.error("Copy failed; please copy the number manually");
    } finally {
      setDetailMenuOpen(false);
    }
  }

  async function saveContract(nextContract: ContractRow, changes: Partial<ContractRow>) {
    try {
      const updatedContract = await patchContract(nextContract.contract_id, changes, nextContract);
      setSavedContract(updatedContract);
      setEditing(false);
      toast.success(`Saved ${updatedContract.contract_id}`);
    } catch (saveError) {
      toast.error(`Failed to save: ${getSaveErrorMessage(saveError)}`);
    }
  }

  async function removeContract() {
    await deleteContract(detailContract.contract_id);
    toast.success(`Deleted ${detailContract.contract_id}`);
    navigate("/ledger");
  }

  async function confirmRemoveContract() {
    setIsDeleting(true);
    try {
      await removeContract();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <>
      <PageHeader
        title={detailContract.contract_id}
        subtitle={`${detailContract.counterparty} · ${detailContract.project_name}`}
        actions={(
          <>
            <Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />Back</Link>
            <Button icon={<Download size={15} />} disabled={!detailContract.file_name} onClick={() => void downloadPdf()}>Download PDF</Button>
            <Button variant="primary" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>Edit</Button>
            <div className="detail-menu-wrap">
              <Button
                variant="icon"
                aria-label="More actions"
                aria-expanded={detailMenuOpen}
                aria-haspopup="menu"
                icon={<MoreHorizontal size={17} />}
                onClick={() => setDetailMenuOpen((open) => !open)}
              />
              {detailMenuOpen ? (
                <DetailActionMenu
                  contract={detailContract}
                  onClose={() => setDetailMenuOpen(false)}
                  onCopy={() => void copyContractId()}
                  onDelete={() => {
                    setDetailMenuOpen(false);
                    setDeletePending(true);
                  }}
                  onDownload={() => {
                    setDetailMenuOpen(false);
                    void downloadPdf();
                  }}
                  onEdit={() => {
                    setDetailMenuOpen(false);
                    setEditing(true);
                  }}
                />
              ) : null}
            </div>
          </>
        )}
      />
      <div className="content-pad detail-layout">
        <Card className="pdf-viewer">
          <div className="pdf-toolbar">signed.pdf <span>{detailContract.pages} pages</span></div>
          {pdfPreview.status === "ready" ? (
            <embed className="pdf-embed" title="signed.pdf" src={pdfPreview.url} type="application/pdf" />
          ) : pdfPreview.status === "loading" ? (
            <div className="pdf-loading" role="status">Loading PDF…</div>
          ) : pdfPreview.status === "error" ? (
            <div className="pdf-error" role="alert">
              <span>Could not load PDF: {pdfPreview.error}</span>
              <Button onClick={() => void downloadPdf()}>Download file</Button>
            </div>
          ) : (
            <StaticPaperPreview contract={detailContract} />
          )}
        </Card>
        <Card className="detail-fields">
          <div className="section-title">Basic info <BusinessStatusTag status={detailContract.status} /></div>
          <Info label="Counterparty" value={detailContract.counterparty} />
          <Info label="Project Name" value={detailContract.project_name} />
          <Info label="Department" value={detailContract.department} />
          <Info label="Amount" value={money(detailContract.amount, detailContract.currency)} mono />
          <Info label="Petition Date" value={detailContract.petition_date} mono />
          <Info label="Effective Date" value={dash(detailContract.effective_date)} mono />
          <Info label="Expiration Date" value={dash(detailContract.expiration_date)} mono />
          <div className="section-title">Archive info</div>
          <Info label="File Name" value={detailContract.file_name} />
          <Info label="File No." value={detailContract.file_no} mono />
          <Info label="Pages / Size" value={`${detailContract.pages} pages / ${detailContract.size}`} />
          <Info label="Archived at" value={detailContract.archived_at} />
        </Card>
      </div>
      {editing ? (
        <EditDrawer
          contract={detailContract}
          onClose={() => setEditing(false)}
          onDelete={() => void removeContract()}
          onSave={saveContract}
        />
      ) : null}
      {deletePending ? (
        <ConfirmModal
          title="Delete contract?"
          body={`This will delete contract ${detailContract.contract_id} and its archived PDF. This cannot be undone.`}
          cancelLabel="Cancel"
          actionLabel="Delete"
          actionVariant="danger"
          loading={isDeleting}
          onCancel={() => setDeletePending(false)}
          onConfirm={() => void confirmRemoveContract()}
        />
      ) : null}
    </>
  );
}

type PdfPreviewState =
  | { status: "idle" | "loading" | "missing"; url: "" }
  | { status: "ready"; url: string }
  | { status: "error"; url: ""; error: string };

function StaticPaperPreview({ contract }: { contract: ContractRow }) {
  return (
    <div className="paper detail-paper">
      <h2>China Jushi USA</h2>
      <h3>Contract Approval Form</h3>
      <dl>
        <dt>Contract Number</dt><dd>{contract.contract_id}</dd>
        <dt>Seller's Party</dt><dd>{contract.counterparty}</dd>
        <dt>Contract Amount</dt><dd>{money(contract.amount, contract.currency)}</dd>
        <dt>Project Name</dt><dd>{contract.project_name}</dd>
      </dl>
    </div>
  );
}

function Info({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="info-row"><span>{label}</span><strong className={mono ? "mono" : undefined}>{value}</strong></div>;
}

function DetailActionMenu({
  contract,
  onClose,
  onCopy,
  onDelete,
  onDownload,
  onEdit
}: {
  contract: ContractRow;
  onClose: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="menu-popover detail-menu-popover" role="menu" aria-label={`Detail actions ${contract.contract_id}`}>
      <strong className="mono">{contract.contract_id}</strong>
      <button onClick={onEdit}><Pencil size={14} />Edit</button>
      <button disabled={!contract.file_name} title={contract.file_name ? undefined : "No archived file"} onClick={onDownload}><Download size={14} />Download PDF</button>
      <button onClick={onCopy}><Copy size={14} />Copy number</button>
      <button className="danger-menu" onClick={onDelete}><Trash2 size={14} />Delete</button>
      <button className="close-menu" aria-label="Close menu" onClick={onClose}><X size={14} /></button>
    </div>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

function getSaveErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return "This contract was modified elsewhere; refresh and retry";
  }
  return getErrorMessage(error);
}

async function copyTextToClipboard(value: string) {
  const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return;
    } catch {
      legacyCopyText(value);
      return;
    }
  }
  legacyCopyText(value);
}

function legacyCopyText(value: string) {
  if (typeof document === "undefined" || !document.body || typeof document.execCommand !== "function") {
    throw new Error("Copy is not supported");
  }

  const textArea = document.createElement("textarea");
  textArea.id = "clipboard-copy-buffer";
  textArea.name = "clipboard-copy-buffer";
  textArea.value = value;
  textArea.readOnly = true;
  textArea.setAttribute("aria-hidden", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  textArea.style.top = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  textArea.setSelectionRange(0, value.length);
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) throw new Error("Copy command failed");
}

function getDetailReturnTo(state: unknown) {
  if (state && typeof state === "object" && "returnTo" in state) {
    const value = (state as { returnTo?: unknown }).returnTo;
    if (typeof value === "string" && value.startsWith("/ledger")) return value;
  }
  return "/ledger";
}

function getDetailReturnState(state: unknown) {
  if (!state || typeof state !== "object" || !("restoreScrollY" in state)) return undefined;
  const value = (state as { restoreScrollY?: unknown }).restoreScrollY;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return { restoreScrollY: value };
}
