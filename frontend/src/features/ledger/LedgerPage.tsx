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
      toast.success(`Saved ${savedContract.contract_id}`);
      setSelected(null);
    } catch (saveError) {
      toast.error(`Failed to save: ${getSaveErrorMessage(saveError)}`);
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
      toast.success(`Deleted ${contractId}`);
      setPendingDeleteId(null);
    } catch (deleteError) {
      toast.error(`Delete failed: ${getErrorMessage(deleteError)}`);
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
      toast.success(`Deleted ${ids.length} contracts`);
      setPendingBulkDeleteIds(null);
    } catch (deleteError) {
      toast.error(`Delete failed: ${getErrorMessage(deleteError)}`);
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
    toast.success(`Copied ${contractId}`);
  }

  async function downloadPdf(contractId: string, scope: "full" | "contract" = "full") {
    const contract = data.find((item) => item.contract_id === contractId);
    if (!contract?.file_name) {
      toast.error("No archived file; cannot download PDF");
      return;
    }
    const filename = scope === "contract" ? `${contractId}-contract.pdf` : (contract.file_name || "signed.pdf");
    try {
      const blob = await downloadContractFile(contractId, scope);
      downloadBlob(blob, filename);
      setMenuFor(null);
      toast.success(`Downloaded ${filename}`);
    } catch (downloadError) {
      toast.error(`Download failed: ${getErrorMessage(downloadError)}`);
    }
  }

  async function exportCurrentFilters() {
    setIsExporting(true);
    try {
      const blob = await exportContracts(filters, data);
      downloadBlob(blob, "contract-ledger.xlsx");
      toast.success("Exported the current filter results");
    } catch (exportError) {
      toast.error(`Export failed: ${getErrorMessage(exportError)}`);
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
      toast.success(`Exported ${selectedVisibleIds.length} items`);
    } catch (exportError) {
      toast.error(`Export failed: ${getErrorMessage(exportError)}`);
    } finally {
      setIsBatchExporting(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Contract ledger"
        subtitle="1,284 contracts · last updated 2026-05-31 09:22"
        actions={<><Button icon={<Download size={16} />} disabled={data.length === 0} loading={isExporting} onClick={() => void exportCurrentFilters()}>Export Excel</Button><Link to="/upload" className="button button-primary"><FilePlus2 size={16} />Upload contract</Link></>}
      />
      <div className="content-pad">
        <div className="toolbar">
          <div className="search-box"><Search size={16} /><input name="ledger-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search contract no. / counterparty / project" /></div>
          <FilterChip
            label="Department"
            allLabel="Department: All"
            options={departmentFilterOptions}
            selected={departments}
            onChange={setDepartments}
          />
          <FilterChip
            label="Status"
            allLabel="Status: All"
            options={statusFilterOptions}
            selected={statuses}
            onChange={setStatuses}
          />
          <FilterChip
            label="Year"
            allLabel="Year: All"
            options={yearFilterOptions}
            selected={years}
            onChange={setYears}
          />
          <span className="toolbar-count">Showing {data.length === 0 ? 0 : 1}–{data.length} / {contractResult.total}</span>
          <div className="column-config-wrap">
            <Button icon={<Columns3 size={16} />} onClick={() => setColumnMenuOpen((open) => !open)}>Columns</Button>
            {columnMenuOpen ? (
              <div className="column-config-menu" role="menu" aria-label="Columns">
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
                        <button type="button" aria-label={`Move ${column.label} up`} disabled={!isVisible || isFixedFirstColumn || columnIndex <= 1} onClick={() => moveColumn(column.key, -1)}>
                          <ChevronUp size={14} aria-hidden="true" />
                        </button>
                        <button type="button" aria-label={`Move ${column.label} down`} disabled={!isVisible || isFixedFirstColumn || columnIndex === visibleColumns.length - 1} onClick={() => moveColumn(column.key, 1)}>
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
          <div className="bulk-bar" role="region" aria-label="Bulk actions">
            <strong>{selectedVisibleIds.length} selected</strong>
            <div>
              <Button icon={<Download size={15} />} loading={isBatchExporting} onClick={() => void exportSelected()}>Export selected</Button>
              <Button variant="danger" icon={<Trash2 size={15} />} onClick={() => setPendingBulkDeleteIds([...selectedVisibleIds])}>Delete selected</Button>
              <Button onClick={() => setSelectedIds([])}>Clear selection</Button>
            </div>
          </div>
        ) : null}
        <div
          className="ledger-top-scrollbar"
          role="scrollbar"
          aria-label="Ledger horizontal scrollbar"
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
          aria-label={useVirtualRows ? "Ledger table virtual scroll area" : undefined}
          onScroll={syncTopScrollFromTable}
        >
          {isLoading ? <div className="skeleton-list" /> : isError ? (
            <ErrorState text={`Failed to load: ${getErrorMessage(error)}`} onRetry={() => void refetch()} retrying={isFetching} />
          ) : data.length === 0 ? (
            <EmptyState
              text={hasActiveFilters ? "No matching contracts; try adjusting the filters" : "No contracts yet — click 'Upload contract' to start"}
              action={hasActiveFilters ? <Button onClick={clearFilters}>Clear filters</Button> : <Link to="/upload" className="button button-primary"><FilePlus2 size={16} />Upload contract</Link>}
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
                    <span className="sr-only">Select current page</span>
                    <input type="checkbox" aria-label="Select current page" checked={allVisibleSelected} onChange={toggleCurrentPageSelection} />
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
                  <th className="operation-header" aria-label="Actions"><span className="sr-only">Actions</span></th>
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
          title="Delete contract?"
          body={`This will delete contract ${pendingDeleteId} and its archived PDF. This cannot be undone.`}
          cancelLabel="Cancel"
          actionLabel="Delete"
          actionVariant="danger"
          loading={isDeleting}
          onCancel={() => setPendingDeleteId(null)}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
      {pendingBulkDeleteIds ? (
        <ConfirmModal
          title="Delete selected contracts?"
          body={`This will delete the ${pendingBulkDeleteIds.length} selected contracts and their archived PDFs. This cannot be undone.`}
          cancelLabel="Cancel"
          actionLabel="Delete selected"
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
  return error instanceof Error ? error.message : "Unknown error";
}

function getSaveErrorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409) {
    return "This contract was modified elsewhere; refresh and retry";
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
  { value: "active", label: "Active" },
  { value: "expired", label: "Expired" }
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
        aria-label={`${label} filter`}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{buttonLabel}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div className="filter-chip-menu" role="menu" aria-label={`${label} filter options`}>
          <label className="filter-chip-option">
            <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
            <span>All</span>
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
    return `${label}: ${options.find((option) => option.value === selected[0])?.label ?? selected[0]}`;
  }
  return `${label}: ${selected.length} selected`;
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
      aria-label={`Contract ${contract.contract_id} ${contract.counterparty}`}
      onClick={onOpen}
      onKeyDown={(event) => onKeyDown(event, contract.contract_id)}
      onContextMenu={onContextMenu}
    >
      <td className="select-cell" onClick={(event) => event.stopPropagation()}>
        <input type="checkbox" aria-label={`Select ${contract.contract_id}`} checked={isSelected} onChange={onToggleSelection} />
      </td>
      {activeColumns.map((column) => <td key={column.key} className={column.className}>{column.render(contract)}</td>)}
      <td className="row-more">
        <button
          aria-label={`More actions ${contract.contract_id}`}
          title="More actions"
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
  if (getSortColumn(currentSort) !== columnKey) return `Sort by ${label}`;
  return getSortDirection(currentSort) === "asc" ? `${label} ascending` : `${label} descending`;
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
  key: "Key",
  basic: "Basic info",
  amount: "Amount",
  owner: "Owner",
  date: "Date",
  status: "Status"
};

const ledgerColumns: LedgerColumn[] = [
  { key: "contract_id", label: "Contract No.", group: "key", className: "mono sticky-cell", sortable: true, render: (contract) => contract.contract_id },
  { key: "counterparty", label: "Counterparty", group: "basic", sortable: true, render: (contract) => contract.counterparty },
  { key: "project_name", label: "Project Name", group: "basic", render: (contract) => <span title={contract.project_name}>{contract.project_name}</span> },
  { key: "contract_type", label: "Contract Version", group: "basic", render: (contract) => contract.contract_type },
  { key: "file_no", label: "File No.", group: "basic", className: "mono", render: (contract) => contract.file_no },
  { key: "file_name", label: "File Name", group: "basic", render: (contract) => <span title={contract.file_name}>{contract.file_name}</span> },
  { key: "amount", label: "Contract Amount", group: "amount", className: "mono number", sortable: true, sortLabel: "Amount", render: (contract) => money(contract.amount, contract.currency) },
  { key: "currency", label: "Currency", group: "amount", className: "mono", render: (contract) => contract.currency },
  { key: "term_months", label: "Term", group: "amount", className: "mono", render: (contract) => formatTerm(contract.term_months) },
  { key: "yearly_amount", label: "Annualized", group: "amount", className: "mono number", render: (contract) => (contract.yearly_amount != null ? money(contract.yearly_amount, contract.currency) : "—") },
  { key: "petitioner", label: "Petitioner", group: "owner", render: (contract) => contract.petitioner },
  { key: "petition_date", label: "Registered Date", group: "date", className: "mono", render: (contract) => dash(contract.petition_date) },
  { key: "effective_date", label: "Effective Date", group: "date", className: "mono", sortable: true, render: (contract) => dash(contract.effective_date) },
  { key: "expiration_date", label: "Expiration Date", group: "date", className: "mono", render: (contract) => dash(contract.expiration_date) },
  { key: "status", label: "Status", group: "status", render: (contract) => <BusinessStatusTag status={contract.status} /> }
];

function formatTerm(termMonths: number | null): string {
  if (termMonths == null) return "—";
  if (termMonths === 0) return "One-time";
  return `${termMonths} months`;
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
    <div className="menu-popover" role="menu" aria-label={`Row actions ${contractId}`} style={{ left: position.x, top: position.y }}>
      <strong className="mono">{contractId}</strong>
      <Link to={`/contracts/${contractId}`} state={returnState}><Eye size={14} />View detail</Link>
      <button onClick={onEdit}><Pencil size={14} />Edit</button>
      <span className="menu-group-label"><Download size={14} />Download PDF</span>
      <button disabled={!hasArchive} title={hasArchive ? undefined : "No archived file"} onClick={onDownloadFull}>Full</button>
      <button disabled={!hasArchive} title={hasArchive ? undefined : "No archived file"} onClick={onDownloadContract}>Contract only</button>
      <button onClick={onCopy}><Copy size={14} />Copy number</button>
      <button className="danger-menu" onClick={onDelete}><Trash2 size={14} />Delete</button>
      <button className="close-menu" aria-label="Close menu" onClick={onClose}><X size={14} /></button>
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
      <button className="drawer-scrim" onClick={requestClose} aria-label="Close drawer" />
      <aside className="drawer" aria-label={`Edit contract ${contract.contract_id}`}>
        <header>
          <div>
            <div className="drawer-title-row">
              <h2 className="mono">{contract.contract_id}</h2>
              <BusinessStatusTag status={contract.status} />
            </div>
            <p>{contract.counterparty} · {contract.project_name}</p>
          </div>
          <Button variant="icon" onClick={requestClose} icon={<X size={18} />} aria-label="Close drawer" />
        </header>
        <div className="form-sections">
          <FormSection title="Basic info" rows={[
            ["Counterparty", "counterparty"],
            ["Project Name", "project_name"],
            ["Department", "department"],
            ["Petitioner", "petitioner"],
            ["Registered Date", "petition_date"],
            ["Contract Version", "contract_type"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="Amount" rows={[
            ["Amount", "amount"],
            ["Currency", "currency"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="Date" rows={[
            ["Effective Date", "effective_date"],
            ["Expiration Date", "expiration_date"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <FormSection title="Status & remarks" rows={[
            ["Business status", "status"]
          ]} values={form} errors={errors} disabled={isSaving} onChange={updateField} />
          <label className="field-block">
            <span>Remarks</span>
            <textarea name="brief_description" disabled={isSaving} value={form.brief_description} onChange={(event) => updateField("brief_description", event.target.value)} />
          </label>
        </div>
        <footer>
          <Button variant="danger" disabled={isSaving} onClick={onDelete}>Delete</Button>
          <div>
            <Button disabled={isSaving} onClick={requestClose}>Cancel</Button>
            <Button variant="primary" loading={isSaving} disabled={!isDirty} onClick={() => void save()}>Save changes</Button>
          </div>
        </footer>
      </aside>
      {confirmDiscard ? (
        <ConfirmModal
          title="Discard changes?"
          body="The current changes are unsaved; closing will lose them."
          cancelLabel="Keep editing"
          actionLabel="Discard changes"
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
    errors.counterparty = "This field is required";
  }
  if (!form.amount.trim() || Number.isNaN(amount) || amount < 0) {
    errors.amount = "Enter a valid amount";
  }
  if (form.effective_date && form.expiration_date && form.expiration_date < form.effective_date) {
    errors.expiration_date = "Expiration date cannot be earlier than the effective date";
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
        { value: "active", label: "Active" },
        { value: "expired", label: "Expired" }
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
      <button className="modal-scrim" onClick={onCancel} aria-label="Close confirmation" />
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
