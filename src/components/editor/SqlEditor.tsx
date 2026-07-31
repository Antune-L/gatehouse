import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Play,
  ScanSearch,
  Square,
  Save,
  Bot,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  PanelRightOpen,
  PanelRightClose,
} from "lucide-react";
import { activeProfile, useStore, type WorkspaceTab } from "@/store";
import {
  allTables,
  cancelRunningQuery,
  classifyStatement,
  runEditorSql,
  runExplain,
} from "@/lib/backend";
import { classify } from "@/lib/sql";
import { formatBinding, matchesEvent } from "@/lib/shortcuts";
import type { QueryResult, SqlType } from "@/lib/types";
import { CellContent } from "@/components/data/cells";
import { ExportMenu } from "@/components/data/ExportMenu";
import { typeColor } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "LIMIT", "JOIN",
  "LEFT JOIN", "INNER JOIN", "ON", "AND", "OR", "INSERT INTO", "UPDATE",
  "DELETE FROM", "SET", "VALUES", "COUNT", "SUM", "AVG", "DISTINCT", "AS",
];

const HL_COLOR = {
  keyword: "#c586e0",
  fn: "#5a9bd8",
  string: "#7fca7f",
  number: "#d9a441",
  comment: "#6b6b72",
} as const;

const KEYWORD_SET = new Set([
  "SELECT", "FROM", "WHERE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT",
  "OFFSET", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "FULL", "CROSS", "ON",
  "USING", "AND", "OR", "NOT", "IN", "IS", "NULL", "LIKE", "ILIKE", "BETWEEN",
  "EXISTS", "AS", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "DISTINCT", "UNION",
  "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC", "WITH",
  "RETURNING", "DEFAULT", "PRIMARY", "KEY", "FOREIGN", "REFERENCES",
  "CONSTRAINT", "EXPLAIN", "ANALYZE", "TRUE", "FALSE",
]);

const FUNCTION_SET = new Set([
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NOW", "LOWER", "UPPER",
  "LENGTH", "CAST", "ROUND", "ABS", "DATE", "EXTRACT",
]);

// Comments, strings, numbers, words, then everything else (whitespace/operators).
const TOKEN_RE =
  /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'|"(?:[^"]|"")*")|(\b\d+(?:\.\d+)?\b)|([a-zA-Z_]\w*)|([\s\S])/g;

function highlightSql(sql: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let match: RegExpExecArray | null;
  let i = 0;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(sql)) !== null) {
    const [text, comment, str, num, word] = match;
    let color: string | undefined;
    if (comment) {
      nodes.push(
        <span key={i++} style={{ color: HL_COLOR.comment, fontStyle: "italic" }}>
          {text}
        </span>
      );
      continue;
    }
    if (str) color = HL_COLOR.string;
    else if (num) color = HL_COLOR.number;
    else if (word) {
      const upper = word.toUpperCase();
      if (KEYWORD_SET.has(upper)) color = HL_COLOR.keyword;
      else if (FUNCTION_SET.has(upper)) color = HL_COLOR.fn;
    }
    nodes.push(
      color ? (
        <span key={i++} style={{ color }}>
          {text}
        </span>
      ) : (
        <Fragment key={i++}>{text}</Fragment>
      )
    );
  }
  return nodes;
}

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "result"; result: QueryResult; explain?: boolean }
  | { kind: "error"; message: string }
  | { kind: "queued"; sql: string; reason: string };

interface Suggestion {
  label: string;
  kind: "col" | "tbl" | "kw";
  type?: SqlType;
  source?: string;
  insert?: string;
}

export function SqlEditor({ tab }: { tab: WorkspaceTab }) {
  const { t } = useTranslation();
  const profile = useStore(activeProfile);
  const updateTabSql = useStore((s) => s.updateTabSql);
  const enqueue = useStore((s) => s.enqueue);
  const addHistory = useStore((s) => s.addHistory);
  const schema = useStore((s) => s.schema);
  const activeDatabase = useStore((s) => s.activeDatabase);
  const rowLimit = useStore((s) => s.settings.rowLimit);
  const autocompleteOn = useStore((s) => s.settings.autocomplete);
  const keywordCase = useStore((s) => s.settings.keywordCase);
  const shortcuts = useStore((s) => s.settings.shortcuts);
  const fontSize = useStore((s) => s.settings.editorFontSize);
  const statementTimeout = useStore((s) => s.settings.statementTimeout);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const [runState, setRunState] = useState<RunState>({ kind: "idle" });
  const [saveName, setSaveName] = useState<string | null>(null);
  const activeQueryRef = useRef<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLPreElement>(null);
  const [suggest, setSuggest] = useState<{ items: Suggestion[]; word: string } | null>(
    null
  );
  const [selIdx, setSelIdx] = useState(0);
  const [resultHeight, setResultHeight] = useState(260);

  const sql = tab.sql ?? "";

  const suggestions = useMemo<Suggestion[]>(() => {
    const tables = allTables(schema);
    const out: Suggestion[] = [];
    tables.forEach((tb) => {
      out.push({ label: tb.name, kind: "tbl", source: tb.schema });
      tb.columns.forEach((c) =>
        out.push({ label: c.name, kind: "col", type: c.type, source: tb.name })
      );
    });
    SQL_KEYWORDS.forEach((k) => out.push({ label: k, kind: "kw" }));
    return out;
  }, [schema]);

  function onChange(value: string) {
    updateTabSql(tab.id, value);
    const ta = taRef.current;
    if (!ta || !autocompleteOn) return;
    const upto = value.slice(0, ta.selectionStart);
    // An opening double quote starts a quoted identifier: offer tables only
    // (the common case is a table name right after FROM/JOIN).
    const qm = upto.match(/"([a-zA-Z_]\w*)?$/);
    if (qm) {
      const partial = (qm[1] ?? "").toLowerCase();
      const seen = new Set<string>();
      const items = suggestions
        .filter((x) => {
          if (x.kind !== "tbl") return false;
          const lower = x.label.toLowerCase();
          if (partial && !lower.startsWith(partial)) return false;
          if (seen.has(x.label)) return false;
          seen.add(x.label);
          return true;
        })
        .slice(0, 8)
        .map((x) => ({ ...x, insert: `"${x.label}"` }));
      setSuggest(items.length ? { items, word: qm[0] } : null);
      setSelIdx(0);
      return;
    }
    const m = upto.match(/([a-zA-Z_][\w]*)$/);
    if (m && m[1].length >= 1) {
      const word = m[1].toLowerCase();
      const seen = new Set<string>();
      const items = suggestions
        .filter((x) => {
          const lower = x.label.toLowerCase();
          if (!lower.startsWith(word) || lower === word) return false;
          const key = `${x.kind}:${x.label}:${x.source ?? ""}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8);
      setSuggest(items.length ? { items, word: m[1] } : null);
      setSelIdx(0);
    } else {
      setSuggest(null);
    }
  }

  function accept(item: Suggestion) {
    const ta = taRef.current;
    if (!ta || !suggest) return;
    const raw = item.insert ?? item.label;
    let text = raw;
    if (item.kind === "kw") {
      text = keywordCase === "lower" ? raw.toLowerCase() : raw.toUpperCase();
    }
    const start = ta.selectionStart - suggest.word.length;
    const next = sql.slice(0, start) + text + sql.slice(ta.selectionStart);
    updateTabSql(tab.id, next);
    setSuggest(null);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + text.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  async function run(explain = false) {
    if (!sql.trim() || !profile) return;
    const c = await classifyStatement(sql, profile.engine);
    if (c.isWrite && !explain) {
      setRunState({ kind: "running" });
      try {
        await enqueue({
          origin: "human-ui",
          originLabel: t("nav.editor"),
          profileId: profile.id,
          profileName: profile.name,
          database: profile.database,
          environment: profile.environment,
          sql: sql.trim(),
          statementKind: c.kind,
          affectedRows: null,
          affectedLabel: t("queue.unknownRows"),
          risk: c.kind === "delete" || c.kind === "ddl" ? "high" : "medium",
          targetObjects: [],
        });
        setRunState({ kind: "queued", sql: sql.trim(), reason: c.reason });
      } catch (e) {
        setRunState({ kind: "error", message: String(e) });
      }
      return;
    }
    setRunState({ kind: "running" });
    if (explain) {
      const plan = await runExplain(profile, sql, activeDatabase || undefined);
      if (plan === null) {
        setRunState({ kind: "result", explain: true, result: explainPlan(sql) });
      } else if ("error" in plan) {
        setRunState({ kind: "error", message: plan.error });
      } else {
        setRunState({ kind: "result", explain: true, result: plan });
      }
      return;
    }
    const queryId = crypto.randomUUID();
    activeQueryRef.current = queryId;
    const res = await runEditorSql(profile, sql, rowLimit, {
      queryId,
      timeoutMs: statementTimeout * 1000,
      database: activeDatabase || undefined,
    });
    if (activeQueryRef.current !== queryId) return;
    activeQueryRef.current = null;
    if ("error" in res) {
      setRunState({ kind: "error", message: res.error });
    } else {
      setRunState({ kind: "result", result: res });
      addHistory(sql.trim(), res.rowCount, res.durationMs);
    }
  }

  function cancelRun() {
    const queryId = activeQueryRef.current;
    activeQueryRef.current = null;
    if (queryId) void cancelRunningQuery(queryId);
    setRunState({ kind: "idle" });
  }

  // ⌘. cancels the running query even when focus left the textarea.
  // NOTE: no dep array on purpose — re-registering each render keeps the
  // closures fresh (same pattern as the DataGrid keyboard handler).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!matchesEvent(shortcuts["cancel-query"], e)) return;
      if (runState.kind !== "running") return;
      e.preventDefault();
      cancelRun();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function confirmSave() {
    const fallback = sql.trim().split("\n")[0].slice(0, 40);
    addSavedQuery((saveName ?? "").trim() || fallback, sql.trim());
    setSaveName(null);
  }

  const classification = sql.trim() ? classify(sql) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          variant="brand"
          size="sm"
          onClick={() => void run(false)}
          disabled={runState.kind === "running"}
        >
          <Play className="h-3.5 w-3.5" /> {t("common.run")}
          <kbd className="ml-1 rounded bg-black/20 px-1 text-[10px]">
            {formatBinding(shortcuts["run-query"])}
          </kbd>
        </Button>
        <Button variant="outline" size="sm" onClick={() => void run(true)}>
          <ScanSearch className="h-3.5 w-3.5" /> {t("common.explain")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={runState.kind !== "running"}
          onClick={cancelRun}
          className="text-destructive"
        >
          <Square className="h-3.5 w-3.5" /> {t("common.cancelQuery")}
        </Button>
        {saveName === null ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!sql.trim()}
            onClick={() => setSaveName("")}
          >
            <Save className="h-3.5 w-3.5" /> {t("editor.saveQuery")}
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              autoCorrect="off"
              spellCheck={false}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmSave();
                if (e.key === "Escape") setSaveName(null);
              }}
              placeholder={t("editor.saveNamePlaceholder")}
              className="h-7 w-44 rounded-md border border-border bg-input-bg px-2 text-[12.5px] text-foreground outline-none focus:border-brand"
            />
            <Button variant="brand" size="sm" onClick={confirmSave}>
              {t("common.save")}
            </Button>
          </div>
        )}
        <div className="flex-1" />
        {classification && (
          <Badge variant={classification.isWrite ? "warning" : "success"}>
            {classification.isWrite ? (
              <ShieldAlert className="h-3 w-3" />
            ) : (
              <CheckCircle2 className="h-3 w-3" />
            )}
            {classification.kind}
          </Badge>
        )}
      </div>

      {/* Editor + side panel row */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-[120px] flex-1 bg-background">
            <pre
              ref={overlayRef}
              aria-hidden
              className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words px-4 py-3 font-mono leading-relaxed text-foreground"
              style={{ fontSize }}
            >
              {highlightSql(sql)}
              {"\n"}
            </pre>
            <textarea
              ref={taRef}
              value={sql}
              onScroll={(e) => {
                const el = overlayRef.current;
                if (!el) return;
                el.scrollTop = e.currentTarget.scrollTop;
                el.scrollLeft = e.currentTarget.scrollLeft;
              }}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (matchesEvent(shortcuts["run-query"], e)) {
                  e.preventDefault();
                  void run(false);
                } else if (suggest) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSelIdx((i) => (i + 1) % suggest.items.length);
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSelIdx((i) => (i - 1 + suggest.items.length) % suggest.items.length);
                  } else if (e.key === "Tab") {
                    e.preventDefault();
                    accept(suggest.items[selIdx]);
                  } else if (e.key === "Enter") {
                    // NOTE: Enter inserts a newline; only Tab accepts. Otherwise
                    // typing `user` then Enter silently rewrites it to `Users`.
                    setSuggest(null);
                  } else if (e.key === "Escape") {
                    setSuggest(null);
                  }
                }
              }}
              spellCheck={false}
              autoCorrect="off"
              placeholder="SELECT * FROM orders WHERE status = 'paid' LIMIT 100;"
              style={{ caretColor: "var(--foreground)", fontSize }}
              className="absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre-wrap break-words bg-transparent px-4 py-3 font-mono leading-relaxed text-transparent outline-none placeholder:text-muted-foreground/40"
            />
            {suggest && <AutocompleteMenu items={suggest.items} selIdx={selIdx} onAccept={accept} />}
          </div>

          {/* Resizable split between editor and results */}
          <Resizer
            onResize={(delta) =>
              setResultHeight((h) => Math.max(120, Math.min(680, h + delta)))
            }
          />

          {/* Results */}
          <div
            className="min-h-0 shrink-0 overflow-auto"
            style={{ height: resultHeight }}
          >
            <ResultPanel state={runState} />
          </div>
        </div>

        <EditorSidePanel />
      </div>
    </div>
  );
}

const KIND_META: Record<Suggestion["kind"], { label: string; className: string }> = {
  col: { label: "col", className: "text-info" },
  tbl: { label: "tbl", className: "text-brand" },
  kw: { label: "kw", className: "text-[#c586e0]" },
};

function AutocompleteMenu({
  items,
  selIdx,
  onAccept,
}: {
  items: Suggestion[];
  selIdx: number;
  onAccept: (s: Suggestion) => void;
}) {
  return (
    <div className="absolute left-4 top-16 z-20 w-72 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
      {items.map((item, i) => (
        <button
          key={`${item.kind}:${item.label}:${item.source ?? ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onAccept(item);
          }}
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
            i === selIdx ? "bg-brand-muted" : "hover:bg-panel-2"
          )}
        >
          <span className={cn("w-6 font-mono text-[10px] font-semibold", KIND_META[item.kind].className)}>
            {KIND_META[item.kind].label}
          </span>
          <span className="font-mono text-[12.5px] text-foreground">{item.label}</span>
          {(item.type || item.source) && (
            <span className="ml-auto font-mono text-[11px] text-muted-foreground">
              {item.type ? (
                <span style={{ color: typeColor(item.type) }}>{item.type}</span>
              ) : null}
              {item.type && item.source ? " · " : ""}
              {item.source}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function Resizer({ onResize }: { onResize: (delta: number) => void }) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    let last = e.clientY;
    function move(ev: MouseEvent) {
      onResize(last - ev.clientY);
      last = ev.clientY;
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  }
  return (
    <div
      onMouseDown={onMouseDown}
      className="h-1.5 shrink-0 cursor-row-resize border-y border-border bg-panel-2/50 transition-colors hover:bg-brand/40"
    />
  );
}

function EditorSidePanel() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"history" | "saved">("history");
  const [collapsed, setCollapsed] = useState(true);
  const history = useStore((s) => s.history);
  const saved = useStore((s) => s.saved);
  const profile = useStore(activeProfile);
  const openQueryTab = useStore((s) => s.openQueryTab);
  const updateTabSql = useStore((s) => s.updateTabSql);
  const activeTabId = useStore((s) => s.activeTabId);

  function load(sql: string) {
    if (activeTabId) updateTabSql(activeTabId, sql);
    else openQueryTab(sql);
  }

  if (collapsed) {
    return (
      <aside className="flex w-10 shrink-0 flex-col items-center gap-3 border-l border-border bg-sidebar py-2">
        <button
          onClick={() => setCollapsed(false)}
          title={`${t("editor.history")} · ${t("editor.saved")}`}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
          {t("editor.history")} · {t("editor.saved")}
        </span>
      </aside>
    );
  }

  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-l border-border bg-sidebar">
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-1.5">
        <SideTab active={tab === "history"} onClick={() => setTab("history")}>
          {t("editor.history")}
        </SideTab>
        <SideTab active={tab === "saved"} onClick={() => setTab("saved")}>
          {t("editor.saved")}
        </SideTab>
        <button
          onClick={() => setCollapsed(true)}
          title={t("common.close")}
          className="ml-auto rounded p-1.5 text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "history" ? (
          <>
            <div className="px-1 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("editor.today")} · {(profile?.group ?? "").replace(/^projet\s+/i, "").toUpperCase()} · {profile?.name?.toUpperCase()}
            </div>
            {history.map((h) => (
              <button
                key={h.id}
                onClick={() => load(h.sql)}
                className="mb-1.5 flex w-full flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-border-strong"
              >
                <code className="line-clamp-1 font-mono text-[12px] text-foreground/90">
                  {h.sql}
                </code>
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="tabular-nums">
                    {new Date(h.ranAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span>·</span>
                  <span className="tabular-nums">{h.durationMs} ms</span>
                  <span className="ml-auto">
                    {h.source === "agent" ? (
                      <span className="flex items-center gap-1 rounded bg-brand-muted px-1.5 py-0.5 font-mono text-[10px] text-brand">
                        <Bot className="h-3 w-3" />
                        {h.agentClient}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("editor.you")}</span>
                    )}
                  </span>
                </div>
              </button>
            ))}
          </>
        ) : (
          saved.map((s) => (
            <button
              key={s.id}
              onClick={() => load(s.sql)}
              className="mb-1.5 flex w-full flex-col gap-1 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:border-border-strong"
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                <Save className="h-3.5 w-3.5 text-brand" />
                {s.name}
              </div>
              <code className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
                {s.sql}
              </code>
            </button>
          ))
        )}
      </div>
    </aside>
  );
}

function SideTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        active
          ? "bg-brand-muted text-brand"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function ResultPanel({ state }: { state: RunState }) {
  const { t } = useTranslation();
  if (state.kind === "idle")
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground/60">
        {t("editor.idleHint")}
      </div>
    );
  if (state.kind === "running")
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
        <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        {t("editor.running")}
      </div>
    );
  if (state.kind === "error")
    return (
      <div className="flex items-start gap-2 p-4 text-[12.5px] text-destructive">
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <code className="font-mono">{state.message}</code>
      </div>
    );
  if (state.kind === "queued")
    return (
      <div className="m-4 rounded-lg border border-warning/40 bg-warning/10 p-4">
        <div className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-warning">
          <Bot className="h-4 w-4" /> {t("editor.queuedTitle")}
        </div>
        <p className="text-[12.5px] text-muted-foreground">{state.reason}</p>
        <pre className="mt-2 overflow-auto rounded border border-border bg-input-bg p-2 font-mono text-[12px]">
          {state.sql}
        </pre>
      </div>
    );

  const { result } = state;
  return (
    <div className="flex h-full flex-col">
      {state.explain && (
        <div className="border-b border-border bg-panel-2 px-3 py-1.5 text-[11px] text-muted-foreground">
          {t("editor.estimatedPlan")}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 bg-panel-2">
            <tr>
              {result.columns.map((c) => (
                <th key={c.name} className="border-b border-r border-border px-2 py-1 text-left">
                  <span className="font-semibold text-foreground">{c.name}</span>
                  <span className="ml-1 font-mono text-[10px]" style={{ color: typeColor(c.type) }}>
                    {c.type}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r, ri) => (
              <tr key={ri} className={ri % 2 ? "bg-foreground/[0.035]" : ""}>
                {r.map((v, ci) => (
                  <td key={ci} className="border-b border-r border-border/40 px-2 py-1">
                    <CellContent value={v} type={result.columns[ci]?.type ?? "text"} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-sidebar px-3 py-1.5 text-[11.5px] text-muted-foreground">
        <span className="font-mono">{state.explain ? "EXPLAIN" : "SELECT"}</span>
        <span>·</span>
        <span className="tabular-nums">{result.durationMs} ms</span>
        <span>·</span>
        <span className="tabular-nums">
          {result.rowCount} {t("editor.lines")}
        </span>
        {!state.explain && (
          <div className="ml-auto">
            <ExportMenu
              tableName="query_result"
              result={{ columns: result.columns, rows: result.rows }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function explainPlan(sql: string): QueryResult {
  const from = sql.match(/from\s+([a-zA-Z_]\w*)/i);
  const table = from ? from[1] : "table";
  const lines = [
    [`Seq Scan on ${table}  (cost=0.00..18.10 rows=810 width=64)`],
    [`  Filter: (status = 'paid'::text)`],
    [`Planning Time: 0.084 ms`],
  ];
  return {
    columns: [{ name: "QUERY PLAN", type: "text" }],
    rows: lines,
    rowCount: lines.length,
    truncated: false,
    limit: 500,
    durationMs: 0.4,
  };
}
