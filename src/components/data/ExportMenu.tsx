import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Copy, Loader2 } from "lucide-react";
import { useStore, type ExportFormat } from "@/store";
import { EXPORT_MAX_ROWS, type ExportProgressControls } from "@/lib/backend";
import type { CellValue, QueryResult } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface FormatSpec {
  fmt: ExportFormat;
  label: string;
  ext: string;
}

const FORMATS: FormatSpec[] = [
  { fmt: "csv", label: "CSV", ext: "csv" },
  { fmt: "json", label: "JSON", ext: "json" },
  { fmt: "markdown", label: "Markdown", ext: "md" },
  { fmt: "insert", label: "INSERT", ext: "sql" },
];

const EXPORT_CONFIRM_THRESHOLD = 50_000;
const COPY_FEEDBACK_MS = 1500;
const EXPORT_FEEDBACK_MS = 4000;

interface ExportData {
  columns: { name: string }[];
  rows: CellValue[][];
}

type ExportStatus = { kind: "error" } | { kind: "truncated"; rows: number };

// NOTE: cells starting with = + - @ (or tab/CR) can execute as formulas when
// the CSV is opened in Excel/Sheets — neutralise them with a leading quote.
function neutralizeCsvText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function csvCell(v: CellValue): string {
  if (v === null) return "";
  const text = typeof v === "string" ? neutralizeCsvText(v) : String(v);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(data: ExportData): string {
  const head = data.columns.map((c) => csvCell(c.name)).join(",");
  const body = data.rows.map((r) => r.map(csvCell).join(",")).join("\n");
  return `${head}\n${body}`;
}

function toJson(data: ExportData): string {
  return JSON.stringify(
    data.rows.map((r) =>
      Object.fromEntries(data.columns.map((c, i) => [c.name, r[i]]))
    ),
    null,
    2
  );
}

function toMarkdown(data: ExportData): string {
  const head = `| ${data.columns.map((c) => c.name).join(" | ")} |`;
  const sep = `| ${data.columns.map(() => "---").join(" | ")} |`;
  const body = data.rows
    .map(
      (r) => `| ${r.map((v) => (v === null ? "NULL" : String(v))).join(" | ")} |`
    )
    .join("\n");
  return `${head}\n${sep}\n${body}`;
}

function insertValue(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function toInsert(data: ExportData, tableName: string): string {
  const cols = data.columns.map((c) => c.name).join(", ");
  return data.rows
    .map(
      (r) =>
        `INSERT INTO ${tableName} (${cols}) VALUES (${r
          .map(insertValue)
          .join(", ")});`
    )
    .join("\n");
}

function serialize(
  fmt: ExportFormat,
  data: ExportData,
  tableName: string
): string {
  switch (fmt) {
    case "csv":
      return toCsv(data);
    case "json":
      return toJson(data);
    case "markdown":
      return toMarkdown(data);
    case "insert":
      return toInsert(data, tableName);
  }
}

function downloadFile(name: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function ExportMenu({
  tableName,
  result,
  totalRows,
  fetchFullTable,
}: {
  tableName: string;
  result: ExportData;
  totalRows?: number;
  fetchFullTable?: (controls: ExportProgressControls) => Promise<QueryResult>;
}) {
  const { t } = useTranslation();
  const defaultFormat = useStore((s) => s.settings.exportFormat);
  const [copyResult, setCopyResult] = useState<{
    label: string;
    ok: boolean;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportedRows, setExportedRows] = useState(0);
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null);
  const [pending, setPending] = useState<FormatSpec | null>(null);
  const cancelledRef = useRef(false);

  const formats = [
    ...FORMATS.filter((f) => f.fmt === defaultFormat),
    ...FORMATS.filter((f) => f.fmt !== defaultFormat),
  ];
  const canExportFullTable = fetchFullTable !== undefined;
  const total = totalRows ?? 0;

  async function copy(fmt: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyResult({ label: fmt, ok: true });
    } catch {
      setCopyResult({ label: fmt, ok: false });
    }
    setTimeout(() => setCopyResult(null), COPY_FEEDBACK_MS);
  }

  function flashStatus(status: ExportStatus) {
    setExportStatus(status);
    setTimeout(() => setExportStatus(null), EXPORT_FEEDBACK_MS);
  }

  async function runDownload(f: FormatSpec) {
    const fileName = `${tableName}.${f.ext}`;
    if (!fetchFullTable) {
      downloadFile(fileName, serialize(f.fmt, result, tableName));
      return;
    }
    setExporting(true);
    setExportedRows(0);
    setExportStatus(null);
    cancelledRef.current = false;
    try {
      const full = await fetchFullTable({
        onProgress: setExportedRows,
        isCancelled: () => cancelledRef.current,
      });
      if (cancelledRef.current) return;
      downloadFile(fileName, serialize(f.fmt, full, tableName));
      if (full.truncated) {
        flashStatus({ kind: "truncated", rows: full.rows.length });
      }
    } catch (e) {
      console.error("full table export failed", e);
      flashStatus({ kind: "error" });
    } finally {
      setExporting(false);
    }
  }

  function onDownload(f: FormatSpec) {
    if (total > EXPORT_CONFIRM_THRESHOLD) {
      setPending(f);
      return;
    }
    void runDownload(f);
  }

  function confirmPending() {
    const f = pending;
    setPending(null);
    if (f) void runDownload(f);
  }

  return (
    <div className="flex items-center gap-2">
      {exportStatus?.kind === "error" && (
        <span className="text-[11.5px] text-destructive">
          {t("grid.exportFailed")}
        </span>
      )}
      {exportStatus?.kind === "truncated" && (
        <span className="text-[11.5px] text-warning">
          {t("grid.exportTruncated", {
            n: exportStatus.rows.toLocaleString(),
          })}
        </span>
      )}
      {exporting && (
        <Button
          variant="ghost"
          size="xs"
          title={t("grid.exportCancel")}
          onClick={() => {
            cancelledRef.current = true;
          }}
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />{" "}
          {t("grid.exportProgress", { n: exportedRows.toLocaleString() })}
        </Button>
      )}
      <DropdownMenu>
        {!exporting && (
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="xs">
              <Download className="h-3.5 w-3.5" /> {t("grid.export")}
            </Button>
          </DropdownMenuTrigger>
        )}
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>
            {t("grid.copySection", { n: result.rows.length.toLocaleString() })}
          </DropdownMenuLabel>
          {formats.map((f) => (
            <DropdownMenuItem
              key={`copy-${f.fmt}`}
              onClick={() =>
                void copy(f.label, serialize(f.fmt, result, tableName))
              }
            >
              <Copy className="h-4 w-4" /> {f.label}{" "}
              {copyResult?.label === f.label && (copyResult.ok ? "✓" : "✗")}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            {canExportFullTable
              ? t("grid.downloadSection")
              : t("grid.downloadSectionLoaded")}
          </DropdownMenuLabel>
          {formats.map((f) => (
            <DropdownMenuItem
              key={`dl-${f.fmt}`}
              disabled={exporting}
              onClick={() => onDownload(f)}
            >
              <Download className="h-4 w-4" />{" "}
              {canExportFullTable
                ? t("grid.downloadAs", { fmt: f.label })
                : t("grid.downloadLoadedAs", { fmt: f.label })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("grid.exportConfirmTitle")}</DialogTitle>
          </DialogHeader>
          <p className="text-[13.5px] leading-relaxed text-muted-foreground">
            {t("grid.exportConfirmBody", {
              total: total.toLocaleString(),
              max: EXPORT_MAX_ROWS.toLocaleString(),
            })}
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmPending}>
              {t("grid.exportConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
