import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useReactTable,
  getCoreRowModel,
  type ColumnDef,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Plus,
  X,
  Maximize2,
  KeyRound,
} from "lucide-react";
import {
  activeProfile,
  useStore,
  EMPTY_TABLE_VIEW,
  type TableSubView,
  type GuiFilter,
} from "@/store";
import { matchesEvent } from "@/lib/shortcuts";
import { ViewTabs } from "@/components/workspace/ViewTabs";
import { AgentActivity } from "@/components/layout/AgentActivity";
import {
  allTables,
  fetchTableData,
  fetchTableDataForExport,
  isRealProfile,
  qualifiedTable,
  quoteIdent,
  sqlLiteral,
  type ExportProgressControls,
} from "@/lib/backend";
import type {
  CellValue,
  ColumnDef as SchemaCol,
  QueryResult,
  RowDiff,
  SqlType,
} from "@/lib/types";
import { CellContent, isLargeValue } from "./cells";
import { typeColor } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExportMenu } from "./ExportMenu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const OPS = ["=", "!=", "contains", "starts", ">", "<", "is null", "is not null"];

const VALUELESS_OPS = new Set(["is null", "is not null"]);

function isFilterComplete(f: GuiFilter): boolean {
  return !!f.column && (VALUELESS_OPS.has(f.op) || f.value !== "");
}

// Default column width by SQL type so wide values (timestamps) aren't cropped.
const TYPE_WIDTH: Partial<Record<SqlType, number>> = {
  timestamp: 190,
  date: 130,
  boolean: 90,
  integer: 96,
  bigint: 120,
  numeric: 116,
  uuid: 290,
  json: 240,
  text: 240,
  varchar: 200,
};

function defaultColWidth(type: SqlType, isPk: boolean): number {
  if (isPk) return 76;
  return TYPE_WIDTH[type] ?? 150;
}

const GUTTER = 44;

interface StagedCell {
  rowKey: string;
  pkValue: CellValue;
  rowIndex: number;
  column: string;
  oldValue: CellValue;
  newValue: CellValue;
}

const EMPTY_RESULT: QueryResult = {
  columns: [],
  rows: [],
  rowCount: 0,
  truncated: false,
  limit: 500,
  durationMs: 0,
};

interface EditSnapshot {
  staged: StagedCell[];
  inserts: Record<string, CellValue>[];
  deletes: Set<number>;
}

const UNDO_DEPTH = 50;
const COPY_FLASH_MS = 1000;

function clipboardText(v: CellValue): string {
  return v === null ? "NULL" : String(v);
}

function isEditableTarget(el: Element | null): boolean {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && el.isContentEditable)
  );
}

export function DataGrid({
  tableName,
  subView,
  onSub,
}: {
  tableName: string;
  subView?: TableSubView;
  onSub?: (v: TableSubView) => void;
}) {
  const { t } = useTranslation();
  const profile = useStore(activeProfile);
  const enqueue = useStore((s) => s.enqueue);
  const openTable = useStore((s) => s.openTable);
  const rowLimit = useStore((s) => s.settings.rowLimit);
  const statementTimeout = useStore((s) => s.settings.statementTimeout);
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  const view = useStore((s) => s.tableViews[tableName]) ?? EMPTY_TABLE_VIEW;
  const setTableFilters = useStore((s) => s.setTableFilters);
  const setTableSort = useStore((s) => s.setTableSort);

  const schema = useStore((s) => s.schema);
  const activeDatabase = useStore((s) => s.activeDatabase);
  const dataVersion = useStore((s) => s.dataVersion);
  const schemaTable = allTables(schema).find((x) => x.name === tableName);
  const cols: SchemaCol[] = schemaTable?.columns ?? [];
  const pkCols = cols.filter((c) => c.primaryKey);
  const pkCol = pkCols[0]?.name ?? cols[0]?.name;
  const exportPkCol = pkCols.length === 1 ? pkCols[0].name : undefined;
  const readOnly = profile?.readOnly ?? false;

  const sortColumn = view.sortColumn;
  const sortDir = view.sortDir;
  const filters = view.filters;
  const setFilters = (next: GuiFilter[]) => setTableFilters(tableName, next);
  const [showFilters, setShowFilters] = useState(false);
  const [staged, setStaged] = useState<StagedCell[]>([]);
  const [inserts, setInserts] = useState<Record<string, CellValue>[]>([]);
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<EditSnapshot[]>([]);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [selectedCell, setSelectedCell] = useState<
    { row: number; col: string } | null
  >(null);
  const [copiedCell, setCopiedCell] = useState<
    { row: number; col: string } | null
  >(null);
  const [copiedRow, setCopiedRow] = useState<number | null>(null);
  const copyFlashTimer = useRef<number | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(
    null
  );
  const [editValue, setEditValue] = useState("");
  const [bigValue, setBigValue] = useState<{ col: string; value: string } | null>(
    null
  );

  const [result, setResult] = useState<QueryResult>(EMPTY_RESULT);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // NOTE: async data source (IPC in the desktop build) — effect is the
  // fetch-on-param-change boundary.
  useEffect(() => {
    let alive = true;
    fetchTableData(
      profile,
      tableName,
      {
        sortColumn,
        sortDir,
        filters: filters.filter(isFilterComplete),
        limit: rowLimit,
        timeoutMs: statementTimeout * 1000,
      },
      schemaTable?.schema,
      activeDatabase || undefined
    )
      .then((r) => {
        if (alive) {
          setResult(r);
          setFetchError(null);
          setSelectedRow(null);
          setSelectedCell(null);
        }
      })
      .catch((e) => {
        console.error("table fetch failed", e);
        if (alive) {
          setResult(EMPTY_RESULT);
          setFetchError(String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [profile, tableName, sortColumn, sortDir, filters, rowLimit, statementTimeout, dataVersion, schemaTable?.schema, activeDatabase]);

  // Apply staged updates to displayed rows.
  const displayRows = useMemo(() => {
    if (staged.length === 0) return result.rows;
    const rows = result.rows.map((r) => r.slice());
    const colIndex = new Map(result.columns.map((c, i) => [c.name, i]));
    for (const s of staged) {
      const ci = colIndex.get(s.column);
      if (ci != null && rows[s.rowIndex]) rows[s.rowIndex][ci] = s.newValue;
    }
    return rows;
  }, [result, staged]);

  const columns = useMemo<ColumnDef<CellValue[]>[]>(
    () =>
      result.columns.map((c, i) => ({
        id: c.name,
        accessorFn: (row) => row[i],
        size: defaultColWidth(c.type, c.name === pkCol),
        header: () => c.name,
      })),
    [result.columns, pkCol]
  );

  const table = useReactTable({
    data: displayRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 56, maxSize: 640 },
  });

  const parentRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  function fetchFullTable(
    controls: ExportProgressControls
  ): Promise<QueryResult> {
    return fetchTableDataForExport(
      profile,
      tableName,
      {
        sortColumn,
        sortDir,
        filters: filters.filter(isFilterComplete),
        timeoutMs: statementTimeout * 1000,
      },
      schemaTable?.schema,
      activeDatabase || undefined,
      { ...controls, pkCol: exportPkCol }
    );
  }

  function toggleSort(col: string) {
    if (sortColumn !== col) {
      setTableSort(tableName, col, "asc");
    } else if (sortDir === "asc") {
      setTableSort(tableName, col, "desc");
    } else {
      setTableSort(tableName, undefined, "asc");
    }
  }

  function pushUndo() {
    setUndoStack((prev) => [...prev.slice(-(UNDO_DEPTH - 1)), { staged, inserts, deletes }]);
    setRedoStack([]);
  }

  function restoreSnapshot(s: EditSnapshot) {
    setStaged(s.staged);
    setInserts(s.inserts);
    setDeletes(s.deletes);
  }

  function undo() {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setRedoStack((prev) => [...prev, { staged, inserts, deletes }]);
    setUndoStack(undoStack.slice(0, -1));
    restoreSnapshot(last);
  }

  function redo() {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    setUndoStack((prev) => [...prev, { staged, inserts, deletes }]);
    setRedoStack(redoStack.slice(0, -1));
    restoreSnapshot(next);
  }

  // ⌘S = same action as the "Review" button, including the cell edit still
  // in progress: commit it, then send everything to the validation queue.
  function reviewNow() {
    const extra = stagedFromEditing();
    commitEdit();
    const cells = extra
      ? [
          ...staged.filter(
            (s) => !(s.rowIndex === extra.rowIndex && s.column === extra.column)
          ),
          extra,
        ]
      : staged;
    void reviewChanges(cells).catch((e) => console.error("staging failed", e));
  }

  // NOTE: ⌘Z/⇧⌘Z/⌘C arrive as keydown in the browser, but as
  // "gatehouse:undo/redo/copy" window events in the desktop build (the native
  // menu owns the accelerators).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) {
        if (editing || isEditableTarget(document.activeElement)) return;
        if (
          (e.key === "Delete" || e.key === "Backspace") &&
          !readOnly &&
          selectedRow !== null &&
          selectedRow < result.rows.length
        ) {
          e.preventDefault();
          toggleDelete(selectedRow);
        } else if (e.key === "Escape" && (selectedRow !== null || selectedCell)) {
          setSelectedRow(null);
          setSelectedCell(null);
        }
        return;
      }
      if (
        e.key.toLowerCase() === "c" &&
        !e.shiftKey &&
        !e.altKey &&
        (selectedCell || selectedRow !== null) &&
        !editing &&
        !isEditableTarget(document.activeElement) &&
        !window.getSelection()?.toString()
      ) {
        e.preventDefault();
        copySelection();
        return;
      }
      if (matchesEvent(useStore.getState().settings.shortcuts["review-staged"], e)) {
        e.preventDefault();
        reviewNow();
        return;
      }
      if (e.key.toLowerCase() !== "z") return;
      if (isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    const onUndo = () => undo();
    const onRedo = () => redo();
    const onCopy = () => copySelection();
    window.addEventListener("keydown", onKey);
    window.addEventListener("gatehouse:undo", onUndo);
    window.addEventListener("gatehouse:redo", onRedo);
    window.addEventListener("gatehouse:copy", onCopy);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("gatehouse:undo", onUndo);
      window.removeEventListener("gatehouse:redo", onRedo);
      window.removeEventListener("gatehouse:copy", onCopy);
    };
  });

  function flashCopied(
    cell: { row: number; col: string } | null,
    rowIndex: number | null
  ) {
    if (copyFlashTimer.current !== null) {
      window.clearTimeout(copyFlashTimer.current);
    }
    setCopiedCell(cell);
    setCopiedRow(rowIndex);
    copyFlashTimer.current = window.setTimeout(() => {
      setCopiedCell(null);
      setCopiedRow(null);
    }, COPY_FLASH_MS);
  }

  function copySelectedCell() {
    if (!selectedCell) return;
    const ci = result.columns.findIndex((c) => c.name === selectedCell.col);
    const row = displayRows[selectedCell.row];
    if (ci < 0 || !row) return;
    void navigator.clipboard
      .writeText(clipboardText(row[ci]))
      .then(() => flashCopied(selectedCell, null))
      .catch((err) => console.error("cell copy failed", err));
  }

  function copyRow(rowIndex: number) {
    const row = displayRows[rowIndex];
    if (!row) return;
    void navigator.clipboard
      .writeText(row.map(clipboardText).join("\t"))
      .then(() => flashCopied(null, rowIndex))
      .catch((err) => console.error("row copy failed", err));
  }

  function copySelection() {
    if (selectedCell) copySelectedCell();
    else if (selectedRow !== null) copyRow(selectedRow);
  }

  function selectRowOnly(rowIndex: number) {
    setSelectedRow(rowIndex);
    setSelectedCell(null);
  }

  function stagedFromEditing(): StagedCell | null {
    if (!editing) return null;
    const ci = result.columns.findIndex((c) => c.name === editing.col);
    const oldValue = result.rows[editing.row]?.[ci] ?? null;
    let newValue: CellValue = editValue;
    const colType = result.columns[ci]?.type;
    if (colType === "integer" || colType === "bigint" || colType === "numeric") {
      newValue = editValue === "" ? null : Number(editValue);
    } else if (colType === "boolean") {
      newValue = editValue === "true";
    }
    if (String(oldValue) === String(newValue)) return null;
    const pkValue =
      result.rows[editing.row]?.[
        result.columns.findIndex((c) => c.name === pkCol)
      ] ?? null;
    return {
      rowKey: String(pkValue),
      pkValue,
      rowIndex: editing.row,
      column: editing.col,
      oldValue,
      newValue,
    };
  }

  function commitEdit() {
    if (!editing) return;
    const cell = stagedFromEditing();
    if (cell) {
      pushUndo();
      setStaged((prev) => [
        ...prev.filter((s) => !(s.rowIndex === cell.rowIndex && s.column === cell.column)),
        cell,
      ]);
    }
    setEditing(null);
  }

  function setNull() {
    if (!editing) return;
    const ci = result.columns.findIndex((c) => c.name === editing.col);
    const oldValue = result.rows[editing.row]?.[ci] ?? null;
    const pkValue =
      result.rows[editing.row]?.[
        result.columns.findIndex((c) => c.name === pkCol)
      ] ?? null;
    pushUndo();
    setStaged((prev) => [
      ...prev.filter((s) => !(s.rowIndex === editing.row && s.column === editing.col)),
      {
        rowKey: String(pkValue),
        pkValue,
        rowIndex: editing.row,
        column: editing.col,
        oldValue,
        newValue: null,
      },
    ]);
    setEditing(null);
  }

  // NOTE: `stagedCells` lets ⌘S include the cell still being edited — its
  // commit is a setState that has not landed in `staged` yet.
  async function reviewChanges(stagedCells: StagedCell[] = staged) {
    if (!profile) return;
    if (stagedCells.length + inserts.length + deletes.size === 0) return;
    const real = isRealProfile(profile);
    const q = (n: string) => (real ? quoteIdent(n) : n);
    const target = real
      ? qualifiedTable(schemaTable?.schema, tableName)
      : tableName;
    for (const ins of inserts) {
      const colNames = cols.filter((c) => !c.primaryKey).map((c) => c.name);
      const vals = colNames.map((n) => sqlLiteral(ins[n] ?? null));
      const sql = `INSERT INTO ${target} (${colNames.map(q).join(", ")})\nVALUES (${vals.join(", ")});`;
      await enqueue({
        origin: "human-ui",
        originLabel: t("grid.originInsert"),
        profileId: profile.id,
        profileName: profile.name,
        database: profile.database,
        environment: profile.environment,
        sql,
        statementKind: "insert",
        affectedRows: 1,
        affectedLabel: `1 ${t("common.row")}`,
        risk: profile.environment === "production" ? "high" : "low",
        targetObjects: [`public.${tableName}`],
      });
    }
    for (const rowIndex of deletes) {
      const pk = result.rows[rowIndex]?.[
        result.columns.findIndex((c) => c.name === pkCol)
      ];
      const sql = `DELETE FROM ${target} WHERE ${q(pkCol)} = ${sqlLiteral(pk ?? null)};`;
      await enqueue({
        origin: "human-ui",
        originLabel: t("grid.originDelete"),
        profileId: profile.id,
        profileName: profile.name,
        database: profile.database,
        environment: profile.environment,
        sql,
        statementKind: "delete",
        affectedRows: 1,
        affectedLabel: `1 ${t("common.row")}`,
        risk: profile.environment === "production" ? "high" : "medium",
        targetObjects: [`public.${tableName}`],
      });
    }
    const byRow = new Map<string, StagedCell[]>();
    for (const s of stagedCells) {
      const arr = byRow.get(s.rowKey) ?? [];
      arr.push(s);
      byRow.set(s.rowKey, arr);
    }
    for (const [, cells] of byRow) {
      const setClause = cells
        .map((c) => `${q(c.column)} = ${sqlLiteral(c.newValue)}`)
        .join(", ");
      const nullSafeEq =
        real && profile.engine === "sqlite" ? "IS" : "IS NOT DISTINCT FROM";
      const whereConds = cells
        .map((c) => `${q(c.column)} ${nullSafeEq} ${sqlLiteral(c.oldValue)}`)
        .join("\n  AND ");
      const sql = `UPDATE ${target} SET ${setClause}\nWHERE ${q(pkCol)} = ${sqlLiteral(cells[0].pkValue)}\n  AND ${whereConds};`;
      const diffs: RowDiff[] = cells.map((c) => ({
        column: c.column,
        oldValue: c.oldValue,
        newValue: c.newValue,
      }));
      await enqueue({
        origin: "human-ui",
        originLabel: t("grid.originEdit"),
        profileId: profile.id,
        profileName: profile.name,
        database: profile.database,
        environment: profile.environment,
        sql,
        statementKind: "update",
        affectedRows: 1,
        affectedLabel: `1 ${t("common.row")}`,
        risk: profile.environment === "production" ? "high" : "low",
        targetObjects: [`public.${tableName}`],
        diffs,
      });
    }
    resetStaged();
    setUndoStack([]);
    setRedoStack([]);
  }

  function addRow() {
    const blank: Record<string, CellValue> = {};
    for (const c of cols) {
      blank[c.name] = c.primaryKey
        ? "auto"
        : c.defaultValue
          ? c.defaultValue.replace(/'/g, "")
          : null;
    }
    pushUndo();
    setInserts((prev) => [blank, ...prev]);
    if (parentRef.current) parentRef.current.scrollTop = 0;
  }

  function toggleDelete(rowIndex: number) {
    pushUndo();
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }

  function resetStaged() {
    setStaged([]);
    setInserts([]);
    setDeletes(new Set());
  }

  function discardAll() {
    pushUndo();
    resetStaged();
  }

  const stagedTotal = staged.length + inserts.length + deletes.size;

  const colType = (name: string) =>
    result.columns.find((c) => c.name === name)?.type ?? "text";
  const fkFor = (name: string) => cols.find((c) => c.name === name)?.references;
  const stagedKey = (row: number, col: string) =>
    staged.some((s) => s.rowIndex === row && s.column === col);

  const activeFilters = filters.filter(isFilterComplete);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        {subView && onSub && <ViewTabs value={subView} onChange={onSub} />}

        <div className="mx-1 flex flex-wrap items-center gap-1.5">
          {activeFilters.map((f, i) => (
            <span
              key={i}
              className="flex items-center gap-1.5 rounded-md border border-brand/30 bg-brand-muted px-2 py-1 font-mono text-[12px] text-brand"
            >
              {f.column} {f.op}{" "}
              {f.op !== "is null" && f.op !== "is not null" ? `'${f.value}'` : ""}
              <button
                onClick={() =>
                  setFilters(filters.filter((x) => x !== f))
                }
                className="text-brand/70 hover:text-brand"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setShowFilters(true);
              setFilters([
                ...filters,
                { column: result.columns[0]?.name ?? "", op: "=", value: "" },
              ]);
            }}
          >
            <Plus className="h-3.5 w-3.5" /> {t("grid.filter")}
          </Button>
        </div>

        <div className="flex-1" />

        <ExportMenu
          tableName={tableName}
          result={{ columns: result.columns, rows: displayRows }}
          totalRows={result.totalRows ?? result.rowCount}
          fetchFullTable={fetchFullTable}
        />
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-3.5 w-3.5" /> {t("grid.addRow")}
          </Button>
        )}
      </div>

      {/* Filter editor */}
      {showFilters && (
        <FilterBar
          columns={result.columns.map((c) => c.name)}
          filters={filters}
          setFilters={setFilters}
          onClose={() => setShowFilters(false)}
        />
      )}

      {/* Grid */}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        <div style={{ width: table.getTotalSize() + GUTTER, minWidth: "100%" }}>
          {/* Header */}
          <div className="sticky top-0 z-10 flex border-b border-border bg-panel-2">
            <div
              className="shrink-0 border-r border-border"
              style={{ width: GUTTER }}
            />
            {table.getFlatHeaders().map((header) => {
              const name = header.column.id;
              const sorted = sortColumn === name;
              const isPk = name === pkCol;
              return (
                <div
                  key={header.id}
                  className="group relative flex select-none flex-col justify-center border-r border-border px-2 py-1"
                  style={{ width: header.getSize() }}
                >
                  <button
                    onClick={() => toggleSort(name)}
                    className="flex items-center gap-1 text-left"
                  >
                    {isPk && <KeyRound className="h-3 w-3 text-warning" />}
                    <span className="truncate text-[12px] font-semibold text-foreground">
                      {name}
                    </span>
                    {sorted ? (
                      sortDir === "asc" ? (
                        <ArrowUp className="h-3 w-3 text-brand" />
                      ) : (
                        <ArrowDown className="h-3 w-3 text-brand" />
                      )
                    ) : (
                      <ChevronsUpDown className="h-3 w-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100" />
                    )}
                  </button>
                  <span
                    className="truncate text-[10px] lowercase"
                    style={{ color: typeColor(colType(name)) }}
                  >
                    {colType(name)}
                    {fkFor(name) ? ` → ${fkFor(name)!.table}` : ""}
                  </span>
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={cn(
                      "absolute right-0 top-0 h-full w-1 cursor-col-resize bg-transparent hover:bg-brand/60",
                      header.column.getIsResizing() && "bg-brand"
                    )}
                  />
                </div>
              );
            })}
          </div>

          {/* Staged insert rows — rendered at the top so they are visible. */}
          {inserts.map((ins, i) => (
            <div
              key={`ins_${i}`}
              className="flex border-b border-border/60 bg-success/10"
              style={{ width: table.getTotalSize() + GUTTER, height: 30 }}
            >
              <div
                className="flex shrink-0 items-center justify-center border-r border-border/40 text-[13px] font-bold text-success"
                style={{ width: GUTTER }}
              >
                +
              </div>
              {result.columns.map((c) => {
                const v = ins[c.name];
                return (
                  <div
                    key={c.name}
                    className="flex items-center overflow-hidden border-r border-border/40 px-2 text-[12.5px] italic text-foreground/70 whitespace-nowrap"
                    style={{ width: table.getColumn(c.name)?.getSize() ?? 150 }}
                  >
                    {v === null ? "NULL" : String(v)}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Body */}
          <div
            style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}
          >
            {rowVirtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              const isDeleted = deletes.has(vItem.index);
              const isSelected = selectedRow === vItem.index;
              return (
                <div
                  key={row.id}
                  onClick={() => setSelectedRow(vItem.index)}
                  className={cn(
                    "group absolute left-0 flex border-b border-border/60 hover:bg-panel-2/40",
                    vItem.index % 2 === 1 && "bg-foreground/[0.035]",
                    isSelected && "bg-brand/10 ring-1 ring-inset ring-brand/40",
                    isDeleted && "bg-destructive/10",
                    copiedRow === vItem.index && "animate-cell-copied"
                  )}
                  style={{
                    top: vItem.start,
                    height: vItem.size,
                    width: table.getTotalSize() + GUTTER,
                  }}
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div
                        className="relative flex shrink-0 items-center justify-center border-r border-border/40 text-[11px] tabular-nums text-muted-foreground/70"
                        style={{ width: GUTTER }}
                        onContextMenu={() => selectRowOnly(vItem.index)}
                      >
                        <button
                          onClick={() => selectRowOnly(vItem.index)}
                          className="tabular-nums hover:text-foreground"
                        >
                          {vItem.index + 1}
                        </button>
                        {!readOnly && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleDelete(vItem.index);
                            }}
                            className={cn(
                              "absolute right-1 hidden group-hover:block",
                              isDeleted
                                ? "text-destructive"
                                : "text-muted-foreground hover:text-destructive"
                            )}
                            title={t("grid.deleteRow")}
                          >
                            {isDeleted ? "↩" : "−"}
                          </button>
                        )}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => copyRow(vItem.index)}>
                        {t("grid.copyRow")}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  {row.getVisibleCells().map((cell) => {
                    const name = cell.column.id;
                    const value = cell.getValue() as CellValue;
                    const isEditing =
                      editing?.row === vItem.index && editing?.col === name;
                    const isStaged = stagedKey(vItem.index, name);
                    const isCellSelected =
                      selectedCell?.row === vItem.index &&
                      selectedCell?.col === name;
                    const isCopied =
                      copiedCell?.row === vItem.index &&
                      copiedCell?.col === name;
                    const fk = fkFor(name);
                    const large = isLargeValue(value);
                    return (
                      <div
                        key={cell.id}
                        onClick={() =>
                          setSelectedCell({ row: vItem.index, col: name })
                        }
                        onDoubleClick={() => {
                          if (readOnly || name === pkCol) return;
                          setEditing({ row: vItem.index, col: name });
                          setEditValue(value === null ? "" : String(value));
                        }}
                        className={cn(
                          "relative flex items-center gap-1 overflow-hidden border-r border-border/40 px-2 text-[12.5px] whitespace-nowrap",
                          !readOnly && name !== pkCol && !isEditing && "cursor-cell",
                          isStaged && "bg-warning/15 ring-1 ring-inset ring-warning/40",
                          isCellSelected &&
                            "ring-1 ring-inset ring-brand bg-brand/15",
                          isCopied && "animate-cell-copied",
                          isDeleted && "text-muted-foreground/60 line-through"
                        )}
                        style={{ width: cell.column.getSize() }}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            autoCorrect="off"
                            spellCheck={false}
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={commitEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitEdit();
                              if (e.key === "Escape") setEditing(null);
                              if (e.key === "n" && e.metaKey) {
                                e.preventDefault();
                                setNull();
                              }
                            }}
                            className="h-6 w-full rounded border border-brand bg-input-bg px-1 font-mono text-[12px] outline-none"
                          />
                        ) : (
                          <>
                            {fk && value !== null ? (
                              <button
                                onClick={() => {
                                  setTableFilters(fk.table, [
                                    { column: fk.column, op: "=", value: String(value) },
                                  ]);
                                  openTable(fk.table);
                                }}
                                className="truncate"
                                title={`Open ${fk.table} (${fk.column} = ${value})`}
                              >
                                <CellContent value={value} type={colType(name)} isFk />
                              </button>
                            ) : (
                              <span className="truncate">
                                <CellContent value={value} type={colType(name)} />
                              </span>
                            )}
                            {large && (
                              <button
                                onClick={() =>
                                  setBigValue({ col: name, value: String(value) })
                                }
                                className="ml-auto shrink-0 opacity-0 hover:text-brand group-hover:opacity-100"
                                title={t("grid.viewFullValue")}
                              >
                                <Maximize2 className="h-3 w-3" />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

        </div>
      </div>

      {/* Status bar */}
      <div className="flex h-9 shrink-0 items-center gap-3 border-t border-border bg-sidebar px-3 text-[11.5px] text-muted-foreground">
        {stagedTotal > 0 ? (
          <>
            <button
              onClick={() => {
                void reviewChanges().catch((e) =>
                  console.error("staging failed", e)
                );
              }}
              className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/15 px-2.5 py-1 font-medium text-warning transition-colors hover:bg-warning/25"
            >
              {stagedTotal} {t("grid.stagedModifs")} → {t("grid.review")}
            </button>
            <button onClick={discardAll} className="hover:text-foreground">
              {t("common.discard")}
            </button>
          </>
        ) : (
          <span className="tabular-nums">
            {result.truncated && result.totalRows !== undefined
              ? t("grid.rowsOfTotal", {
                  shown: result.rows.length.toLocaleString(),
                  total: result.totalRows.toLocaleString(),
                })
              : `${result.rowCount.toLocaleString()} ${t("common.rows")}`}
          </span>
        )}
        {fetchError && (
          <span className="truncate text-destructive" title={fetchError}>
            {t("grid.fetchFailed")} {fetchError}
          </span>
        )}
        {result.truncated && (
          <span>
            {t("grid.limitAppliedDisplay", { n: result.limit })}{" "}
            <button
              onClick={() => setSettingsSection("general")}
              className="text-brand hover:underline"
            >
              {t("grid.edit")}
            </button>
          </span>
        )}
        <div className="flex-1" />
        <AgentActivity />
      </div>

      {editing && !readOnly && (
        <div className="pointer-events-none fixed bottom-12 left-1/2 -translate-x-1/2 rounded-md border border-border bg-elevated px-3 py-1.5 text-[11px] text-muted-foreground shadow-xl">
          Enter to stage · Esc to cancel · ⌘N to Set NULL
        </div>
      )}

      <Dialog open={!!bigValue} onOpenChange={(o) => !o && setBigValue(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-[13px]">
              {bigValue?.col}
            </DialogTitle>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-border bg-input-bg p-3 font-mono text-[12px] text-foreground/90 whitespace-pre-wrap">
            {bigValue?.value}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FilterBar({
  columns,
  filters,
  setFilters,
  onClose,
}: {
  columns: string[];
  filters: GuiFilter[];
  setFilters: (f: GuiFilter[]) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-sidebar px-3 py-2">
      {filters.map((f, i) => (
        <div
          key={i}
          className="flex items-center gap-1 rounded-md border border-border bg-panel-2 p-1"
        >
          <Select
            value={f.column}
            onValueChange={(v) =>
              setFilters(filters.map((x, j) => (j === i ? { ...x, column: v } : x)))
            }
          >
            <SelectTrigger className="h-7 w-32 text-[12px]">
              <SelectValue placeholder="column" />
            </SelectTrigger>
            <SelectContent>
              {columns.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={f.op}
            onValueChange={(v) =>
              setFilters(filters.map((x, j) => (j === i ? { ...x, op: v } : x)))
            }
          >
            <SelectTrigger className="h-7 w-24 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OPS.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {f.op !== "is null" && f.op !== "is not null" && (
            <Input
              value={f.value}
              onChange={(e) =>
                setFilters(
                  filters.map((x, j) =>
                    j === i ? { ...x, value: e.target.value } : x
                  )
                )
              }
              placeholder="value"
              className="h-7 w-28 text-[12px]"
            />
          )}
          <button
            onClick={() => setFilters(filters.filter((_, j) => j !== i))}
            className="rounded p-1 text-muted-foreground hover:bg-panel hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
      <Button
        variant="outline"
        size="xs"
        onClick={() =>
          setFilters([...filters, { column: columns[0], op: "=", value: "" }])
        }
      >
        <Plus className="h-3.5 w-3.5" /> {t("grid.addFilter")}
      </Button>
      <div className="flex-1" />
      <Button variant="ghost" size="xs" onClick={onClose}>
        {t("common.close")}
      </Button>
    </div>
  );
}
