import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type UIEvent as ReactUIEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowDownUp, ChevronDown, ChevronUp, Columns3, Copy, Download, Eye, FilePlus2, MoreHorizontal, Pencil, Search, Trash2, X } from "lucide-react";
import type { ContractRow } from "../../api/types";
import { useContracts } from "../../api/hooks";
import { ApiError, deleteContract, deleteContractBatch, downloadContractFile, exportContractBatch, exportContracts, patchContract } from "../../api/client";
import { downloadBlob } from "../../lib/download";
import { money, dash } from "../../lib/format";
import { Button } from "../../components/ui/Button";
import { Card, EmptyState, ErrorState, PageHeader } from "../../components/ui/Panel";
import { BusinessStatusTag } from "../../components/ui/StatusTag";
import { useToast } from "../../components/ui/Toast";
import { DateField } from "../../components/ui/DateField";

export function LedgerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [departments, setDepartments] = useState(() => parseFilterValues(searchParams.get("department")));
  const [statuses, setStatuses] = useState(() => parseFilterValues(searchParams.get("status"), ["active"]));
  const [years, setYears] = useState(() => parseFilterValues(searchParams.get("year")));
  const [sort, setSort] = useState<string | undefined>(() => searchParams.get("sort") ?? undefined);
  const debouncedQuery = useDebouncedValue(query, 300);
  const filters = {
    q: query,
    department: serializeFilterValues(departments),
    status: serializeFilterValues(statuses),
    year: serializeFilterValues(years),
    sort
  };
  const requestFilters = {
    q: debouncedQuery,
    department: serializeFilterValues(departments),
    status: serializeFilterValues(statuses),
    year: serializeFilterValues(years),
    sort
  };
  const { data: contractResult = { data: [], total: 0 }, error, isError, isFetching, isLoading, refetch } = useContracts(requestFilters);
  const [selected, setSelected] = useState<ContractRow | null>(null);
  const [menuFor, setMenuFor] = useState<MenuState | null>(null);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [savedRows, setSavedRows] = useState<Record<string, ContractRow>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [pendingBulkDeleteIds, setPendingBulkDeleteIds] = useState<string[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [columnMenuOpen, setColumnMenuOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isBatchExporting, setIsBatchExporting] = useState(false);
  const tableScrollRef = useRef<HTMLElement | null>(null);
  const topTableScrollRef = useRef<HTMLDivElement | null>(null);
  const [visibleColumns, setVisibleColumns] = useState<string[]>(() => {
    const stored = readStoredColumns();
    return stored ? JSON.parse(stored) as string[] : ledgerColumns.map((column) => column.key);
  });
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const returnState = getLedgerReturnState(location);

  const data = contractResult.data
    .filter((contract) => !deletedIds.includes(contract.contract_id))
    .map((contract) => savedRows[contract.contract_id] ?? contract)
    .filter((contract) => matchesLocalLedgerQuery(contract, query));
  const hasActiveFilters = Boolean(query.trim()) || departments.length > 0 || !isSameFilter(statuses, ["active"]) || years.length > 0;

  function toggleColumn(key: string) {
    setVisibleColumns((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key];
      writeStoredColumns(next);
      return next;
    });
  }

  function moveColumn(key: string, direction: -1 | 1) {
    setVisibleColumns((current) => {
      const index = current.indexOf(key);
      const nextIndex = index + direction;
      if (index <= 0 || nextIndex < 1 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      writeStoredColumns(next);
      return next;
    });
  }

  const menuColumns = getOrderedColumns(visibleColumns);
  const activeColumns = menuColumns.filter((column) => visibleColumns.includes(column.key));
  const columnGroupSegments = getColumnGroupSegments(activeColumns);
  const selectedVisibleIds = selectedIds.filter((id) => data.some((contract) => contract.contract_id === id));
  const allVisibleSelected = data.length > 0 && data.every((contract) => selectedIds.includes(contract.contract_id));
  const useVirtualRows = data.length > 200;
  const rowVirtualizer = useVirtualizer({
    count: data.length,
    estimateSize: () => LEDGER_ROW_ESTIMATE,
    getScrollElement: () => tableScrollRef.current,
    initialRect: { width: 1200, height: 560 },
    overscan: 8
  });
  const virtualRows = useVirtualRows ? rowVirtualizer.getVirtualItems() : [];
  const fallbackVirtualRows = useVirtualRows && virtualRows.length === 0 ? data.slice(0, VIRTUAL_FALLBACK_ROW_COUNT) : [];
  const visibleRows = useVirtualRows ? (virtualRows.length > 0 ? virtualRows.map((virtualRow) => data[virtualRow.index]) : fallbackVirtualRows) : data;
  const topPadding = useVirtualRows ? virtualRows[0]?.start ?? 0 : 0;
  const bottomPadding = useVirtualRows && virtualRows.length > 0
    ? Math.max(0, rowVirtualizer.getTotalSize() - (virtualRows[virtualRows.length - 1].end ?? 0))
    : useVirtualRows
      ? Math.max(0, (data.length - fallbackVirtualRows.length) * LEDGER_ROW_ESTIMATE)
    : 0;

  useEffect(() => {
    if (selectedIds.length === 0) return undefined;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedIds([]);
      }
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [selectedIds.length]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (query.trim()) next.set("q", query);
    if (departments.length > 0) next.set("department", serializeFilterValues(departments));
    if (!isSameFilter(statuses, ["active"])) next.set("status", serializeFilterValues(statuses));
    if (years.length > 0) next.set("year", serializeFilterValues(years));
    if (sort) next.set("sort", sort);
    setSearchParams(next, { replace: true });
  }, [departments, query, setSearchParams, sort, statuses, years]);

  useEffect(() => {
    const restoreScrollY = getRestoreScrollY(location.state);
    if (restoreScrollY === undefined || restoreScrollY <= 0) return;
    window.scrollTo({ left: 0, top: restoreScrollY, behavior: "auto" });
  }, [location.state]);

  function toggleRowSelection(contractId: string) {
    setSelectedIds((current) => current.includes(contractId) ? current.filter((id) => id !== contractId) : [...current, contractId]);
  }

  function toggleCurrentPageSelection() {
    const visibleIds = data.map((contract) => contract.contract_id);
    setSelectedIds((current) => allVisibleSelected ? current.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...current, ...visibleIds])));
  }

  function handleRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>, contractId: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(`/contracts/${contractId}`, { state: getLedgerReturnState(location) });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLTableRowElement>("tr[data-contract-row]") ?? []);
    const currentIndex = rows.indexOf(event.currentTarget);
    const nextIndex = event.key === "ArrowDown" ? Math.min(rows.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
    rows[nextIndex]?.focus();
  }

  function syncTableScrollFromTop(event: ReactUIEvent<HTMLDivElement>) {
    if (tableScrollRef.current) {
      tableScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  function syncTopScrollFromTable(event: ReactUIEvent<HTMLElement>) {
    if (topTableScrollRef.current && topTableScrollRef.current.scrollLeft !== event.currentTarget.scrollLeft) {
      topTableScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }

  async function saveContract(contract: ContractRow, changes: Partial<ContractRow>) {
    try {
      const savedContract = await patchContract(contract.contract_id, changes, contract);
      setSavedRows((current) => ({ ...current, [savedContract.contract_id]: savedContract }));
      toast.success(`已保存 ${savedContract.contract_id}`);
      setSelected(null);
    } catch (saveError) {
      toast.error(`保存失败：${getSaveErrorMessage(saveError)}`);
    }
  }

  async function confirmDelete() {
    if (!pendingDeleteId) return;
    const contractId = pendingDeleteId;
    setIsDeleting(true);
    try {
      await deleteContract(contractId);
      setDeletedIds((current) => [...current, contractId]);
      setSelected((current) => current?.contract_id === contractId ? null : current);
      setSelectedIds((current) => current.filter((id) => id !== contractId));
      setMenuFor(null);
      toast.success(`已删除 ${contractId}`);
      setPendingDeleteId(null);
    } catch (deleteError) {
      toast.error(`删除失败：${getErrorMessage(deleteError)}`);
    } finally {
      setIsDeleting(false);
    }
  }

  async function confirmBulkDelete() {
    if (!pendingBulkDeleteIds) return;
    const ids = pendingBulkDeleteIds;
    setIsBulkDeleting(true);
    try {
      await deleteContractBatch(ids);
      setDeletedIds((current) => [...current, ...ids]);
      setSelectedIds((current) => current.filter((id) => !ids.includes(id)));
      setSelected((current) => current && ids.includes(current.contract_id) ? null : current);
      toast.success(`已删除 ${ids.length} 份合同`);
      setPendingBulkDeleteIds(null);
    } catch (deleteError) {
      toast.error(`删除失败：${getErrorMessage(deleteError)}`);
    } finally {
      setIsBulkDeleting(false);
    }
  }

  function clearFilters() {
    setQuery("");
    setDepartments([]);
    setStatuses(["active"]);
    setYears([]);
    setSort(undefined);
  }

  async function copyContractId(contractId: string) {
    await navigator.clipboard?.writeText(contractId);
    setMenuFor(null);
    toast.success(`已复制 ${contractId}`);
  }

  async function downloadPdf(contractId: string, scope: "full" | "contract" = "full") {
    const contract = data.find((item) => item.contract_id === contractId);
    if (!contract?.file_name) {
      toast.error("无存档文件，无法下载 PDF");
      return;
    }
    const filename = scope === "contract" ? `${contractId}-contract.pdf` : (contract.file_name || "signed.pdf");
    try {
      const blob = await downloadContractFile(contractId, scope);
      downloadBlob(blob, filename);
      setMenuFor(null);
      toast.success(`已下载 ${filename}`);
    } catch (downloadError) {
      toast.error(`下载失败：${getErrorMessage(downloadError)}`);
    }
  }

  async function exportCurrentFilters() {
    setIsExporting(true);
    try {
      const blob = await exportContracts(filters, data);
      downloadBlob(blob, "contract-ledger.xlsx");
      toast.success("已导出当前筛选结果");
    } catch (exportError) {
      toast.error(`导出失败：${getErrorMessage(exportError)}`);
    } finally {
      setIsExporting(false);
    }
  }

  async function exportSelected() {
    setIsBatchExporting(true);
    try {
      const selectedRows = data.filter((contract) => selectedVisibleIds.includes(contract.contract_id));
      const blob = await exportContractBatch(selectedVisibleIds, selectedRows);
      downloadBlob(blob, "selected-contracts.xlsx");
      toast.success(`已导出 ${selectedVisibleIds.length} 项`);
    } catch (exportError) {
      toast.error(`导出失败：${getErrorMessage(exportError)}`);
    } finally {
      setIsBatchExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="合同台账"
        subtitle="共 1,284 份合同 · 最近更新 2026-05-31 09:22"
        actions={<><Button icon={<Download size={16} />} disabled={data.length === 0} loading={isExporting} onClick={() => void exportCurrentFilters()}>导出 Excel</Button><Link to="/upload" className="button button-primary"><FilePlus2 size={16} />上传合同</Link></>}
      />
      <div className="content-pad">
        <div className="toolbar">
          <div className="search-box"><Search size={16} /><input name="ledger-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索合同编号 / 对方公司 / 项目名" /></div>
          <FilterChip
            label="部门"
            allLabel="部门：全部"
            options={departmentFilterOptions}
            selected={departments}
            onChange={setDepartments}
          />
          <FilterChip
            label="状态"
            allLabel="状态：全部"
            options={statusFilterOptions}
            selected={statuses}
            onChange={setStatuses}
          />
          <FilterChip
            label="年份"
            allLabel="年份：全部"
            options={yearFilterOptions}
            selected={years}
            onChange={setYears}
          />
          <span className="toolbar-count">显示 {data.length === 0 ? 0 : 1}–{data.length} / {contractResult.total}</span>
          <div className="column-config-wrap">
            <Button icon={<Columns3 size={16} />} onClick={() => setColumnMenuOpen((open) => !open)}>列配置</Button>
            {columnMenuOpen ? (
              <div className="column-config-menu" role="menu" aria-label="列配置">
                {menuColumns.map((column) => {
                  const columnIndex = visibleColumns.indexOf(column.key);
                  const isVisible = columnIndex >= 0;
                  const isFixedFirstColumn = column.key === "contract_id";
                  return (
                    <div className="column-config-item" key={column.key}>
                      <label>
                        <input type="checkbox" checked={isVisible} onChange={() => toggleColumn(column.key)} disabled={isFixedFirstColumn} />
                        <span>{column.label}</span>
                      </label>
                      <div className="column-order-controls">
                        <button type="button" aria-label={`上移 ${column.label}`} disabled={!isVisible || isFixedFirstColumn || columnIndex <= 1} onClick={() => moveColumn(column.key, -1)}>
                          <ChevronUp size={14} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`下移 ${column.label}`} disabled={!isVisible || isFixedFirstColumn || columnIndex === visibleColumns.length - 1} onClick={() => moveColumn(column.key, 1)}>
                          <ChevronDown size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
        {selectedVisibleIds.length > 0 ? (
          <div className="bulk-bar" role="region" aria-label="批量操作">
            <strong>已选 {selectedVisibleIds.length} 项</strong>
            <div>
              <Button icon={<Download size={15} />} loading={isBatchExporting} onClick={() => void exportSelected()}>导出所选</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setPendingBulkDeleteIds([...selectedVisibleIds])}>删除所选</Button>
              <Button onClick={() => setSelectedIds([])}>取消选择</Button>
            </div>
          </div>
        ) : null}
        <div
          className="ledger-top-scrollbar"
          role="scrollbar"
          aria-label="台账横向滚动条"
          aria-controls="ledger-table-scroll"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={0}
          ref={topTableScrollRef}
          onScroll={syncTableScrollFromTop}
        >
          <div style={{ width: LEDGER_TABLE_MIN_WIDTH }} />
        </div>
        <Card
          id="ledger-table-scroll"
          className={`table-card ${useVirtualRows ? "table-card-virtual" : ""}`}
          ref={tableScrollRef}
          role={useVirtualRows ? "region" : undefined}
          aria-label={useVirtualRows ? "台账表格虚拟滚动区域" : undefined}
          onScroll={syncTopScrollFromTable}
        >
          {isLoading ? <div className="skeleton-list" /> : isError ? (
            <ErrorState text={`加载失败：${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          ) : data.length === 0 ? (
            <EmptyState
              text={hasActiveFilters ? "没有匹配的合同，试试调整筛选" : "还没有合同，点「上传合同」开始登记"}
              action={hasActiveFilters ? <Button onClick={clearFilters}>清除筛选</Button> : <Link to="/upload" className="button button-primary"><FilePlus2 size={16} />上传合同</Link>}
            />
          ) : (
            <table className="data-table ledger-table">
              <thead>
                <tr className="group-header-row">
                  <th className="select-cell group-spacer" aria-hidden="true" />
                  {columnGroupSegments.map((segment) => (
                    <th
                      key={segment.segmentKey}
                      className={`column-group ${segment.columns.some((column) => column.key === "contract_id") ? "sticky-cell" : ""}`}
                      colSpan={segment.columns.length}
                      scope="colgroup"
                    >
                      {segment.label}
                    </th>
                  ))}
                  <th className="group-spacer" aria-hidden="true" />
                </tr>
                <tr>
                  <th className="select-cell">
                    <span className="sr-only">选择当前页</span>
                    <input type="checkbox" aria-label="选择当前页" checked={allVisibleSelected} onChange={toggleCurrentPageSelection} />
                  </th>
                  {activeColumns.map((column) => (
                    <th key={column.key} className={column.className}>
                      {column.sortable ? (
                        <button
                          className="sort-header"
                          aria-label={getSortLabel(column.sortLabel ?? column.label, sort, column.key)}
                          onClick={() => setSort((current) => getNextSort(current, column.key))}
                        >
                          {column.label}
                          <SortIndicator sort={sort} columnKey={column.key} />
                        </button>
                      ) : column.label}
                    </th>
                  ))}
                  <th className="operation-header" aria-label="操作"><span className="sr-only">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {topPadding > 0 ? <tr aria-hidden="true"><td className="virtual-padding-cell" colSpan={activeColumns.length + 2} style={{ height: topPadding }} /></tr> : null}
                {visibleRows.map((contract) => <LedgerRow
                  key={contract.contract_id}
                  activeColumns={activeColumns}
                  contract={contract}
                  isSelected={selectedIds.includes(contract.contract_id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenuFor({ contractId: contract.contract_id, ...getBoundedMenuPosition(event.clientX, event.clientY) });
                  }}
                  onKeyDown={handleRowKeyDown}
                  onOpen={() => setSelected(contract)}
                  onToggleSelection={() => toggleRowSelection(contract.contract_id)}
                  onOpenMenu={(event) => {
                    event.stopPropagation();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenuFor({ contractId: contract.contract_id, ...getBoundedMenuPosition(rect.right - MENU_WIDTH, rect.bottom + 6) });
                  }}
                />)}
                {bottomPadding > 0 ? <tr aria-hidden="true"><td className="virtual-padding-cell" colSpan={activeColumns.length + 2} style={{ height: bottomPadding }} /></tr> : null}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {menuFor ? (
        <ContextMenu
          contractId={menuFor.contractId}
          position={menuFor}
          onClose={() => setMenuFor(null)}
          onCopy={() => void copyContractId(menuFor.contractId)}
          onDownloadFull={() => void downloadPdf(menuFor.contractId, "full")}
          onDownloadContract={() => void downloadPdf(menuFor.contractId, "contract")}
          onDelete={() => setPendingDeleteId(menuFor.contractId)}
          onEdit={() => setSelected(data.find((contract) => contract.contract_id === menuFor.contractId) ?? null)}
          hasArchive={Boolean(data.find((contract) => contract.contract_id === menuFor.contractId)?.file_name)}
          returnState={returnState}
        />
      ) : null}
      {selected ? (
        <EditDrawer
          contract={selected}
          onClose={() => setSelected(null)}
          onDelete={() => setPendingDeleteId(selected.contract_id)}
          onSave={saveContract}
        />
      ) : null}
      {pendingDeleteId ? (
        <ConfirmModal
          title="删除合同？"
          body={`将删除合同 ${pendingDeleteId} 及其存档 PDF，不可恢复。`}
          cancelLabel="取消"
          actionLabel="删除"
          actionVariant="danger"
          loading={isDeleting}
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {pendingBulkDeleteIds ? (
        <ConfirmModal
          title="删除所选合同？"
          body={`将删除选中的 ${pendingBulkDeleteIds.length} 份合同及其存档 PDF，不可恢复。`}
          cancelLabel="取消"
          actionLabel="删除所选"
          actionVariant="danger"
          loading={isBulkDeleting}
          onCancel={() => setPendingBulkDeleteIds(null)}
          onConfirm={() => void confirmBulkDelete()}
        />
      ) : null}
    </>
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

function getLedgerReturnState(location: { pathname: string; search: string }): LedgerReturnState {
  return {
    returnTo: `${location.pathname}${location.search}`,
    restoreScrollY: typeof window === "undefined" ? 0 : window.scrollY
  };
}

function getRestoreScrollY(state: unknown) {
  if (!state || typeof state !== "object" || !("restoreScrollY" in state)) return undefined;
  const value = (state as { restoreScrollY?: unknown }).restoreScrollY;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const departmentFilterOptions = [
  { value: "UD", label: "UD" },
  { value: "FPW", label: "FPW" },
  { value: "PD", label: "PD" }
];

const statusFilterOptions = [
  { value: "active", label: "生效中" },
  { value: "expired", label: "已到期" }
];

const yearFilterOptions = [
  { value: "2026", label: "2026" },
  { value: "2025", label: "2025" }
];

interface FilterOption {
  value: string;
  label: string;
}

function FilterChip({
  label,
  allLabel,
  options,
  selected,
  onChange
}: {
  label: string;
  allLabel: string;
  options: FilterOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  const buttonLabel = getFilterChipLabel(label, allLabel, options, selected);

  function toggleValue(value: string) {
    onChange(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <div className="filter-chip-wrap" ref={rootRef}>
      <button
        type="button"
        className={`chip filter-chip ${selected.length > 0 ? "active" : ""}`}
        aria-label={`${label}筛选`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="filter-chip-menu" role="menu" aria-label={`${label}筛选选项`}>
          <label className="filter-chip-option">
            <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
            <span>全部</span>
          </label>
          {options.map((option) => (
            <label className="filter-chip-option" key={option.value}>
              <input type="checkbox" checked={selected.includes(option.value)} onChange={() => toggleValue(option.value)} />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function getFilterChipLabel(label: string, allLabel: string, options: FilterOption[], selected: string[]) {
  if (selected.length === 0) return allLabel;
  if (selected.length === 1) {
    return `${label}：${options.find((option) => option.value === selected[0])?.label ?? selected[0]}`;
  }
  return `${label}：${selected.length} 项`;
}

function parseFilterValues(value: string | null, fallback: string[] = []) {
  if (!value || value === "all") return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function serializeFilterValues(values: string[]) {
  return values.length > 0 ? values.join(",") : "all";
}

function isSameFilter(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

interface MenuState {
  contractId: string;
  x: number;
  y: number;
}

interface LedgerReturnState {
  returnTo: string;
  restoreScrollY: number;
}

function LedgerRow({
  activeColumns,
  contract,
  isSelected,
  onContextMenu,
  onKeyDown,
  onOpen,
  onOpenMenu,
  onToggleSelection
}: {
  activeColumns: LedgerColumn[];
  contract: ContractRow;
  isSelected: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLTableRowElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>, contractId: string) => void;
  onOpen: () => void;
  onOpenMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onToggleSelection: () => void;
}) {
  return (
    <tr
      className={isSelected ? "row-selected" : undefined}
      data-contract-row="true"
      tabIndex={0}
      aria-label={`合同 ${contract.contract_id} ${contract.counterparty}`}
      onClick={onOpen}
      onKeyDown={(event) => onKeyDown(event, contract.contract_id)}
      onContextMenu={onContextMenu}
    >
      <td className="select-cell" onClick={(event) => event.stopPropagation()}>
        <input type="checkbox" aria-label={`选择 ${contract.contract_id}`} checked={isSelected} onChange={onToggleSelection} />
      </td>
      {activeColumns.map((column) => <td key={column.key} className={column.className}>{column.render(contract)}</td>)}
      <td className="row-more">
        <button
          aria-label={`更多操作 ${contract.contract_id}`}
          title="更多操作"
          onClick={onOpenMenu}
        >
          <MoreHorizontal size={18} />
        </button>
      </td>
    </tr>
  );
}

function useDebouncedValue<T>(value: T, delayMs: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);

  return debouncedValue;
}

function matchesLocalLedgerQuery(contract: ContractRow, query: string) {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return [contract.contract_id, contract.counterparty, contract.project_name].some((value) => value.toLowerCase().includes(term));
}

const MENU_WIDTH = 190;
const MENU_HEIGHT = 238;
const MENU_MARGIN = 8;
const LEDGER_ROW_ESTIMATE = 48;
const LEDGER_TABLE_MIN_WIDTH = 1680;
const VIRTUAL_FALLBACK_ROW_COUNT = 24;

type SortDirection = "asc" | "desc" | undefined;

function getSortColumn(sort: string | undefined) {
  if (!sort?.endsWith("_asc") && !sort?.endsWith("_desc")) return undefined;
  return sort.replace(/_(asc|desc)$/, "");
}

function getSortDirection(sort: string | undefined): SortDirection {
  if (sort?.endsWith("_asc")) return "asc";
  if (sort?.endsWith("_desc")) return "desc";
  return undefined;
}

function getNextSort(currentSort: string | undefined, columnKey: string) {
  if (getSortColumn(currentSort) !== columnKey) return `${columnKey}_asc`;
  const currentDirection = getSortDirection(currentSort);
  if (currentDirection === "asc") return `${columnKey}_desc`;
  if (currentDirection === "desc") return undefined;
  return `${columnKey}_asc`;
}

function getSortLabel(label: string, currentSort: string | undefined, columnKey: string) {
  if (getSortColumn(currentSort) !== columnKey) return `${label} 排序`;
  return getSortDirection(currentSort) === "asc" ? `${label} 升序` : `${label} 降序`;
}

function SortIndicator({ sort, columnKey }: { sort: string | undefined; columnKey: string }) {
  if (getSortColumn(sort) !== columnKey) {
    return <ArrowDownUp size={13} aria-hidden="true" />;
  }
  return <span className="sort-indicator" aria-hidden="true">{getSortDirection(sort) === "asc" ? "↑" : "↓"}</span>;
}

function getBoundedMenuPosition(x: number, y: number) {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;
  const maxX = Math.max(MENU_MARGIN, viewportWidth - MENU_WIDTH - MENU_MARGIN);
  const maxY = Math.max(MENU_MARGIN, viewportHeight - MENU_HEIGHT - MENU_MARGIN);
  return {
    x: Math.min(Math.max(MENU_MARGIN, x), maxX),
    y: Math.min(Math.max(MENU_MARGIN, y), maxY)
  };
}

type LedgerColumnGroup = "key" | "basic" | "amount" | "owner" | "date" | "status";

interface LedgerColumn {
  key: string;
  label: string;
  group: LedgerColumnGroup;
  className?: string;
  sortable?: boolean;
  sortLabel?: string;
  render: (contract: ContractRow) => ReactNode;
}

const ledgerGroupLabels: Record<LedgerColumnGroup, string> = {
  key: "主键",
  basic: "基本信息",
  amount: "金额",
  owner: "归口",
  date: "日期",
  status: "状态"
};

const ledgerColumns: LedgerColumn[] = [
  { key: "contract_id", label: "合同编号", group: "key", className: "mono sticky-cell", sortable: true, render: (contract) => contract.contract_id },
  { key: "counterparty", label: "对方公司", group: "basic", sortable: true, render: (contract) => contract.counterparty },
  { key: "project_name", label: "项目名称", group: "basic", render: (contract) => <span title={contract.project_name}>{contract.project_name}</span> },
  { key: "contract_type", label: "合同版本", group: "basic", render: (contract) => contract.contract_type },
  { key: "file_no", label: "存档编号", group: "basic", className: "mono", render: (contract) => contract.file_no },
  { key: "file_name", label: "文件名", group: "basic", render: (contract) => <span title={contract.file_name}>{contract.file_name}</span> },
  { key: "amount", label: "合同金额", group: "amount", className: "mono number", sortable: true, sortLabel: "金额", render: (contract) => money(contract.amount, contract.currency) },
  { key: "currency", label: "币种", group: "amount", className: "mono", render: (contract) => contract.currency },
  { key: "term_months", label: "合同期", group: "amount", className: "mono", render: (contract) => formatTerm(contract.term_months) },
  { key: "yearly_amount", label: "年均价", group: "amount", className: "mono number", render: (contract) => (contract.yearly_amount != null ? money(contract.yearly_amount, contract.currency) : "—") },
  { key: "petitioner", label: "申请人", group: "owner", render: (contract) => contract.petitioner },
  { key: "petition_date", label: "登记日期", group: "date", className: "mono", render: (contract) => dash(contract.petition_date) },
  { key: "effective_date", label: "生效日", group: "date", className: "mono", sortable: true, render: (contract) => dash(contract.effective_date) },
  { key: "expiration_date", label: "到期日", group: "date", className: "mono", render: (contract) => dash(contract.expiration_date) },
  { key: "status", label: "状态", group: "status", render: (contract) => <BusinessStatusTag status={contract.status} /> }
];

function formatTerm(termMonths: number | null): string {
  if (termMonths == null) return "—";
  if (termMonths === 0) return "一次性";
  return `${termMonths} 个月`;
}

function getOrderedColumns(columnKeys: string[]) {
  const byKey = new Map(ledgerColumns.map((column) => [column.key, column]));
  const orderedVisibleColumns = columnKeys
    .map((key) => byKey.get(key))
    .filter((column): column is (typeof ledgerColumns)[number] => Boolean(column));
  const missingColumns = ledgerColumns.filter((column) => !columnKeys.includes(column.key));
  return [...orderedVisibleColumns, ...missingColumns];
}

function getColumnGroupSegments(columns: LedgerColumn[]) {
  return columns.reduce<Array<{ segmentKey: string; group: LedgerColumnGroup; label: string; columns: LedgerColumn[] }>>((segments, column) => {
    const previous = segments[segments.length - 1];
    if (previous?.group === column.group) {
      previous.columns.push(column);
      return segments;
    }
    return [
      ...segments,
      {
        segmentKey: `${column.group}-${segments.length}`,
        group: column.group,
        label: ledgerGroupLabels[column.group],
        columns: [column]
      }
    ];
  }, []);
}

function readStoredColumns() {
  try {
    const storage = window.localStorage as Storage | undefined;
    if (typeof storage?.getItem !== "function") return null;
    const stored = storage.getItem("contract-rag-ledger-columns");
    return stored ? JSON.stringify(normalizeColumnKeys(JSON.parse(stored))) : null;
  } catch {
    return null;
  }
}

function normalizeColumnKeys(value: unknown) {
  const defaultKeys = ledgerColumns.map((column) => column.key);
  if (!Array.isArray(value)) return defaultKeys;
  const validKeys = new Set(defaultKeys);
  const orderedStoredKeys = value.filter((key): key is string => typeof key === "string" && validKeys.has(key));
  const missingKeys = defaultKeys.filter((key) => !orderedStoredKeys.includes(key));
  return [...orderedStoredKeys, ...missingKeys];
}

function writeStoredColumns(columns: string[]) {
  try {
    const storage = window.localStorage as Storage | undefined;
    if (typeof storage?.setItem === "function") {
      storage.setItem("contract-rag-ledger-columns", JSON.stringify(columns));
    }
  } catch {
    // Column preferences are nice-to-have; rendering should never depend on storage.
  }
}

function ContextMenu({
  contractId,
  position,
  onClose,
  onCopy,
  onDownloadFull,
  onDownloadContract,
  onDelete,
  onEdit,
  hasArchive,
  returnState
}: {
  contractId: string;
  position: Pick<MenuState, "x" | "y">;
  onClose: () => void;
  onCopy: () => void;
  onDownloadFull: () => void;
  onDownloadContract: () => void;
  onDelete: () => void;
  onEdit: () => void;
  hasArchive: boolean;
  returnState: LedgerReturnState;
}) {
  return (
    <div className="menu-popover" role="menu" aria-label={`行操作 ${contractId}`} style={{ left: position.x, top: position.y }}>
      <strong className="mono">{contractId}</strong>
      <Link to={`/contracts/${contractId}`} state={returnState}><Eye size={14} />查看详情</Link>
      <button onClick={onEdit}><Pencil size={14} />编辑</button>
      <span className="menu-group-label"><Download size={14} />下载 PDF</span>
      <button disabled={!hasArchive} title={hasArchive ? undefined : "无存档文件"} onClick={onDownloadFull}>整份</button>
      <button disabled={!hasArchive} title={hasArchive ? undefined : "无存档文件"} onClick={onDownloadContract}>仅合同</button>
      <button onClick={onCopy}><Copy size={14} />复制编号</button>
      <button className="danger-menu" onClick={onDelete}><Trash2 size={14} />删除</button>
      <button className="close-menu" aria-label="关闭菜单" onClick={onClose}><X size={14} /></button>
    </div>
  );
}

interface EditDrawerProps {
  contract: ContractRow;
  onClose: () => void;
  onDelete: () => void;
  onSave: (contract: ContractRow, changes: Partial<ContractRow>) => Promise<void>;
}

interface ContractFormValues {
  counterparty: string;
  project_name: string;
  department: string;
  petitioner: string;
  petition_date: string;
  contract_type: string;
  amount: string;
  currency: string;
  effective_date: string;
  expiration_date: string;
  status: ContractRow["status"];
  brief_description: string;
}

type ContractFormErrors = Partial<Record<keyof ContractFormValues, string>>;

export function EditDrawer({ contract, onClose, onDelete, onSave }: EditDrawerProps) {
  const initialForm = contractToForm(contract);
  const [form, setForm] = useState<ContractFormValues>(initialForm);
  const [errors, setErrors] = useState<ContractFormErrors>({});
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm);

  function updateField(field: keyof ContractFormValues, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function requestClose() {
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || isSaving) return;
      if (confirmDiscard) {
        setConfirmDiscard(false);
        return;
      }
      requestClose();
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [confirmDiscard, isDirty, isSaving]);

  async function save() {
    const validation = validateContractForm(form);
    if (Object.keys(validation).length > 0) {
      setErrors(validation);
      focusFirstInvalidField(validation);
      return;
    }
    const nextContract = {
      ...contract,
      counterparty: form.counterparty.trim(),
      project_name: form.project_name,
      department: form.department,
      petitioner: form.petitioner,
      petition_date: form.petition_date,
      contract_type: form.contract_type,
      amount: Number(form.amount.trim()),
      currency: form.currency,
      effective_date: form.effective_date || null,
      expiration_date: form.expiration_date || null,
      status: form.status,
      brief_description: form.brief_description
    };
    const changes = getContractChanges(contract, nextContract);
    setIsSaving(true);
    try {
      await onSave(nextContract, changes);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="drawer-layer">
      <button className="drawer-scrim" onClick={requestClose} aria-label="关闭抽屉" />
      <aside className="drawer" aria-label={`编辑合同 ${contract.contract_id}`}>
        <header>
          <div>
            <div className="drawer-title-row">
              <h2 className="mono">{contract.contract_id}</h2>
              <BusinessStatusTag status={contract.status} />
            </div>
            <p>{contract.counterparty} · {contract.project_name}</p>
          </div>
          <Button variant="icon" onClick={requestClose} icon={<X size={18} />} aria-label="关闭抽屉" />
        </header>
        <div className="form-sections">
          <FormSection title="基本信息" rows={[
            ["对方公司", "counterparty"],
            ["项目名称", "project_name"],
            ["部门", "department"],
            ["申请人", "petitioner"],
            ["登记日期", "petition_date"],
            ["合同版本", "contract_type"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="金额" rows={[
            ["合同金额", "amount"],
            ["币种", "currency"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="日期" rows={[
            ["生效日", "effective_date"],
            ["到期日", "expiration_date"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="状态与备注" rows={[
            ["业务状态", "status"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <label className="field-block">
            <span>备注</span>
            <textarea name="brief_description" disabled={isSaving} value={form.brief_description} onChange={(event) => updateField("brief_description", event.target.value)} />
          </label>
        </div>
        <footer>
          <Button variant="danger" disabled={isSaving} onClick={onDelete}>删除</Button>
          <div>
            <Button disabled={isSaving} onClick={requestClose}>取消</Button>
            <Button variant="primary" loading={isSaving} disabled={!isDirty} onClick={() => void save()}>保存修改</Button>
          </div>
        </footer>
      </aside>
      {confirmDiscard ? (
        <ConfirmModal
          title="放弃修改？"
          body="当前修改尚未保存，关闭后将丢失这些改动。"
          cancelLabel="继续编辑"
          actionLabel="放弃修改"
          actionVariant="danger"
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={onClose}
        />
      ) : null}
    </div>
  );
}

function contractToForm(contract: ContractRow): ContractFormValues {
  return {
    counterparty: contract.counterparty,
    project_name: contract.project_name,
    department: contract.department,
    petitioner: contract.petitioner,
    petition_date: contract.petition_date,
    contract_type: contract.contract_type,
    amount: String(contract.amount),
    currency: contract.currency,
    effective_date: contract.effective_date ?? "",
    expiration_date: contract.expiration_date ?? "",
    status: contract.status,
    brief_description: contract.brief_description
  };
}

function validateContractForm(form: ContractFormValues): ContractFormErrors {
  const errors: ContractFormErrors = {};
  const amount = Number(form.amount.trim());

  if (!form.counterparty.trim()) {
    errors.counterparty = "此项必填";
  }
  if (!form.amount.trim() || Number.isNaN(amount) || amount < 0) {
    errors.amount = "请输入有效金额";
  }
  if (form.effective_date && form.expiration_date && form.expiration_date < form.effective_date) {
    errors.expiration_date = "到期日不能早于生效日";
  }

  return errors;
}

function focusFirstInvalidField(errors: ContractFormErrors) {
  const firstField = Object.keys(errors)[0];
  if (!firstField) return;
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${firstField}"]`);
  field?.focus();
}

function getContractChanges(original: ContractRow, next: ContractRow): Partial<ContractRow> {
  const editableFields: Array<keyof ContractRow> = [
    "counterparty",
    "project_name",
    "department",
    "petitioner",
    "petition_date",
    "contract_type",
    "amount",
    "currency",
    "effective_date",
    "expiration_date",
    "status",
    "brief_description"
  ];
  return editableFields.reduce<Partial<ContractRow>>((changes, field) => {
    if (original[field] !== next[field]) {
      return { ...changes, [field]: next[field] };
    }
    return changes;
  }, {});
}

function FormSection({
  title,
  rows,
  values,
  errors,
  disabled = false,
  onChange
}: {
  title: string;
  rows: Array<[string, keyof ContractFormValues]>;
  values: ContractFormValues;
  errors: ContractFormErrors;
  disabled?: boolean;
  onChange: (field: keyof ContractFormValues, value: string) => void;
}) {
  return (
    <section className="form-section">
      <h3>{title}</h3>
      {rows.map(([label, field]) => (
        <div className="field-block" key={field}>
          <label htmlFor={`edit-${field}`}><span>{label}</span></label>
          {isSelectField(field) ? (
            <select
              id={`edit-${field}`}
              name={field}
              disabled={disabled}
              aria-invalid={Boolean(errors[field])}
              value={values[field]}
              onChange={(event) => onChange(field, event.target.value)}
            >
              {getSelectOptions(field).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : isDateField(field) ? (
            <DateField
              id={`edit-${field}`}
              name={field}
              label={label}
              disabled={disabled}
              ariaInvalid={Boolean(errors[field])}
              value={values[field]}
              onChange={(value) => onChange(field, value)}
            />
          ) : (
            <input
              id={`edit-${field}`}
              name={field}
              disabled={disabled}
              aria-invalid={Boolean(errors[field])}
              type={field === "amount" ? "number" : "text"}
              value={values[field]}
              onChange={(event) => onChange(field, event.target.value)}
            />
          )}
          {errors[field] ? <small className="form-error" role="alert">{errors[field]}</small> : null}
        </div>
      ))}
    </section>
  );
}

function isDateField(field: keyof ContractFormValues) {
  return field === "petition_date" || field === "effective_date" || field === "expiration_date";
}

function isSelectField(field: keyof ContractFormValues) {
  return field === "department" || field === "contract_type" || field === "currency" || field === "status";
}

function getSelectOptions(field: keyof ContractFormValues) {
  switch (field) {
    case "department":
      return [
        { value: "UD", label: "UD" },
        { value: "FPW", label: "FPW" },
        { value: "PD", label: "PD" }
      ];
    case "contract_type":
      return [
        { value: "Supply Agreement", label: "Supply Agreement" },
        { value: "Service Agreement", label: "Service Agreement" },
        { value: "Framework", label: "Framework" },
        { value: "Supplement", label: "Supplement" }
      ];
    case "currency":
      return [
        { value: "USD", label: "USD" },
        { value: "CNY", label: "CNY" },
        { value: "EUR", label: "EUR" }
      ];
    case "status":
      return [
        { value: "active", label: "生效中" },
        { value: "expired", label: "已到期" }
      ];
    default:
      return [];
  }
}

export function ConfirmModal({
  title,
  body,
  cancelLabel,
  actionLabel,
  actionVariant,
  loading = false,
  onCancel,
  onConfirm
}: {
  title: string;
  body: string;
  cancelLabel: string;
  actionLabel: string;
  actionVariant: "primary" | "danger";
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    document.body.classList.add("modal-open");
    return () => document.body.classList.remove("modal-open");
  }, []);

  useEffect(() => {
    function handleEscape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || loading) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    }
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [loading, onCancel]);

  return (
    <div className="modal-layer">
      <button className="modal-scrim" onClick={onCancel} aria-label="关闭确认" />
      <section className="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="ledger-confirm-title">
        <h2 id="ledger-confirm-title">{title}</h2>
        <p>{body}</p>
        <footer>
          <Button disabled={loading} onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={actionVariant} loading={loading} onClick={onConfirm}>{actionLabel}</Button>
        </footer>
      </section>
    </div>
  );
}
