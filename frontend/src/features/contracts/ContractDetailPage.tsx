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
          throw new Error("当前环境不支持在线预览");
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
        <PageHeader title="合同详情" subtitle={`正在加载 ${id}`} actions={<Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />返回</Link>} />
        <div className="content-pad detail-layout">
          <Card className="pdf-viewer"><div className="skeleton-list" role="status" aria-label="正在加载合同详情" /></Card>
          <Card className="detail-fields"><div className="skeleton-list" /></Card>
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <PageHeader title="合同详情" subtitle={`${id} 加载失败`} actions={<Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />返回</Link>} />
        <div className="content-pad">
          <Card>
            <ErrorState text={`加载失败：${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          </Card>
        </div>
      </>
    );
  }

  if (!currentContract) return null;
  const detailContract: ContractRow = currentContract;

  async function downloadPdf() {
    if (!detailContract.file_name) {
      toast.error("无存档文件，无法下载 PDF");
      return;
    }
    try {
      const blob = await downloadContractFile(detailContract.contract_id);
      downloadBlob(blob, detailContract.file_name || "signed.pdf");
      toast.success(`已下载 ${detailContract.contract_id} signed.pdf`);
    } catch (downloadError) {
      toast.error(`下载失败：${getErrorMessage(downloadError)}`);
    }
  }

  async function copyContractId() {
    try {
      await copyTextToClipboard(detailContract.contract_id);
      toast.success(`已复制 ${detailContract.contract_id}`);
    } catch {
      toast.error("复制失败，请手动复制编号");
    } finally {
      setDetailMenuOpen(false);
    }
  }

  async function saveContract(nextContract: ContractRow, changes: Partial<ContractRow>) {
    try {
      const updatedContract = await patchContract(nextContract.contract_id, changes, nextContract);
      setSavedContract(updatedContract);
      setEditing(false);
      toast.success(`已保存 ${updatedContract.contract_id}`);
    } catch (saveError) {
      toast.error(`保存失败：${getSaveErrorMessage(saveError)}`);
    }
  }

  async function removeContract() {
    await deleteContract(detailContract.contract_id);
    toast.success(`已删除 ${detailContract.contract_id}`);
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
            <Link className="button button-secondary" to={returnTo} state={returnState}><ArrowLeft size={15} />返回</Link>
            <Button icon={<Download size={15} />} disabled={!detailContract.file_name} onClick={() => void downloadPdf()}>下载 PDF</Button>
            <Button variant="primary" icon={<Pencil size={15} />} onClick={() => setEditing(true)}>编辑</Button>
            <div className="detail-menu-wrap">
              <Button
                variant="icon"
                aria-label="更多操作"
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
          <div className="pdf-toolbar">signed.pdf <span>{detailContract.pages} 页</span></div>
          {pdfPreview.status === "ready" ? (
            <embed className="pdf-embed" title="signed.pdf" src={pdfPreview.url} type="application/pdf" />
          ) : pdfPreview.status === "loading" ? (
            <div className="pdf-loading" role="status">正在加载 PDF…</div>
          ) : pdfPreview.status === "error" ? (
            <div className="pdf-error" role="alert">
              <span>无法加载 PDF：{pdfPreview.error}</span>
              <Button onClick={() => void downloadPdf()}>下载文件</Button>
            </div>
          ) : (
            <StaticPaperPreview contract={detailContract} />
          )}
        </Card>
        <Card className="detail-fields">
          <div className="section-title">基本信息 <BusinessStatusTag status={detailContract.status} /></div>
          <Info label="对方公司" value={detailContract.counterparty} />
          <Info label="项目名称" value={detailContract.project_name} />
          <Info label="部门" value={detailContract.department} />
          <Info label="合同金额" value={money(detailContract.amount, detailContract.currency)} mono />
          <Info label="申请日期" value={detailContract.petition_date} mono />
          <Info label="生效日" value={dash(detailContract.effective_date)} mono />
          <Info label="到期日" value={dash(detailContract.expiration_date)} mono />
          <div className="section-title">存档信息</div>
          <Info label="文件名" value={detailContract.file_name} />
          <Info label="存档编号" value={detailContract.file_no} mono />
          <Info label="页数 / 大小" value={`${detailContract.pages} 页 / ${detailContract.size}`} />
          <Info label="存档时间" value={detailContract.archived_at} />
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
          title="删除合同？"
          body={`将删除合同 ${detailContract.contract_id} 及其存档 PDF，不可恢复。`}
          cancelLabel="取消"
          actionLabel="删除"
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
    <div className="menu-popover detail-menu-popover" role="menu" aria-label={`详情操作 ${contract.contract_id}`}>
      <strong className="mono">{contract.contract_id}</strong>
      <button onClick={onEdit}><Pencil size={14} />编辑</button>
      <button disabled={!contract.file_name} title={contract.file_name ? undefined : "无存档文件"} onClick={onDownload}><Download size={14} />下载 PDF</button>
      <button onClick={onCopy}><Copy size={14} />复制编号</button>
      <button className="danger-menu" onClick={onDelete}><Trash2 size={14} />删除</button>
      <button className="close-menu" aria-label="关闭菜单" onClick={onClose}><X size={14} /></button>
    </div>
  );
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "未知错误";
}

function getSaveErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return "该合同已被他处修改，请刷新后重试";
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
