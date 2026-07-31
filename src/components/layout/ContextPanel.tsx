import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Search,
  Table2,
  Eye,
  Layers,
  Clock,
  Bookmark,
  Bot,
  User,
  Command,
  KeyRound,
  Link2,
} from "lucide-react";
import { activeProfile, useStore } from "@/store";
import { inTauri } from "@/lib/ipc";
import { allTables, pickSqliteFile } from "@/lib/backend";
import type { ConnectionProfile, ObjectKind, TableDef } from "@/lib/types";
import {
  ColorDot,
  EngineIcon,
  StateDot,
  engineLabel,
  typeColor,
} from "@/components/shared";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatRelativeTime } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function ContextPanel() {
  const section = useStore((s) => s.section);
  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-sidebar">
      {section === "connections" && <ConnectionsPanel />}
      {section === "history" && <HistoryPanel />}
      {section === "agents" && <AgentsPanel />}
      {section === "saved" && <SavedPanel />}
      {section === "queue" && <QueuePanelSummary />}
      {section === "settings" && <SettingsNavPanel />}
    </aside>
  );
}

const KIND_ICON: Record<ObjectKind, typeof Table2> = {
  table: Table2,
  view: Eye,
  materialized_view: Layers,
};

const SQLITE_FILE_RE = /\.(db|sqlite3?|db3)$/i;

const SCHEMA_SKELETON_ROWS = 8;
const SCHEMA_SKELETON_WIDTHS = ["w-32", "w-24", "w-20", "w-28"];

function SchemaTreeSkeleton() {
  return (
    <div className="flex-1 overflow-hidden px-1.5 pb-3 pt-1">
      <div className="mb-1 px-2 py-1">
        <div className="h-3 w-16 animate-pulse rounded bg-panel-2" />
      </div>
      {Array.from({ length: SCHEMA_SKELETON_ROWS }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1 pl-6">
          <div className="h-3.5 w-3.5 shrink-0 animate-pulse rounded bg-panel-2" />
          <div
            className={cn(
              "h-3 animate-pulse rounded bg-panel-2",
              SCHEMA_SKELETON_WIDTHS[i % SCHEMA_SKELETON_WIDTHS.length]
            )}
          />
        </div>
      ))}
    </div>
  );
}

const DB_NAME_PLACEHOLDER_WIDTH = "w-24";

function SchemaLoadingSpinner() {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      aria-label={t("conn.loadingSchema")}
      className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
    />
  );
}

function DatabaseNameBox({ name, loading }: { name: string; loading: boolean }) {
  const showPlaceholder = loading && name.length === 0;
  return (
    <div className="mt-2 flex h-8 items-center gap-2 rounded-md border border-border bg-muted/40 px-3 font-mono text-[12px] text-muted-foreground">
      {loading && <SchemaLoadingSpinner />}
      {showPlaceholder ? (
        <span
          className={cn(
            "h-3 animate-pulse rounded bg-panel-2",
            DB_NAME_PLACEHOLDER_WIDTH
          )}
        />
      ) : (
        <span className="truncate">{name}</span>
      )}
    </div>
  );
}

function ConnectionsPanel() {
  const { t } = useTranslation();
  const profile = useStore(activeProfile);
  const activeDatabase = useStore((s) => s.activeDatabase);
  const setActiveDatabase = useStore((s) => s.setActiveDatabase);
  const openTable = useStore((s) => s.openTable);
  const openConnectionsManager = useStore((s) => s.openConnectionsManager);
  const setCommandPalette = useStore((s) => s.setCommandPalette);
  const schema = useStore((s) => s.schema);
  const schemaError = useStore((s) => s.schemaError);
  const schemaLoading = useStore((s) => s.schemaLoading);
  const refreshSchema = useStore((s) => s.refreshSchema);
  const [retrying, setRetrying] = useState(false);

  async function retrySchema() {
    setRetrying(true);
    try {
      await refreshSchema();
    } finally {
      setRetrying(false);
    }
  }
  const profiles = useStore((s) => s.profiles);
  const saveProfile = useStore((s) => s.saveProfile);
  const setActiveProfile = useStore((s) => s.setActiveProfile);

  async function openSqliteFile() {
    const path = await pickSqliteFile();
    if (!path) return;
    const existing = profiles.find(
      (p) => p.engine === "sqlite" && p.database === path
    );
    if (existing) {
      setActiveProfile(existing.id);
      return;
    }
    const fileName = path.split("/").pop() ?? path;
    const created: ConnectionProfile = {
      id: `p_sqlite_${Date.now()}`,
      name: fileName.replace(SQLITE_FILE_RE, ""),
      engine: "sqlite",
      group: "Local files",
      color: "#f2c94c",
      host: "",
      port: 0,
      user: "",
      database: path,
      environment: "local",
      ssl: false,
      sshTunnel: false,
      sshHost: "",
      sshPort: 22,
      sshUser: "",
      sshKeyPath: "",
      readOnly: false,
      agentAccess: false,
      readOnlyBadge: "guaranteed",
      state: "connected",
      savePassword: false,
    };
    saveProfile(created);
  }

  const tables = allTables(schema);
  const grouped = {
    table: tables.filter((x) => x.kind === "table"),
    view: tables.filter((x) => x.kind === "view"),
    materialized_view: tables.filter((x) => x.kind === "materialized_view"),
  };

  if (!profile) return null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border p-2.5">
        <button
          onClick={() => openConnectionsManager()}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-panel-2"
        >
          <ColorDot color={profile.color} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold text-foreground">
                {profile.name}
              </span>
              <StateDot state={profile.state} />
            </div>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <EngineIcon engine={profile.engine} className="h-3 w-3" />
              {engineLabel(profile.engine)}
            </div>
          </div>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>

        {profile.engine !== "sqlite" &&
          (schema.databases.length > 1 ? (
            <div className="mt-2">
              <Select
                value={activeDatabase}
                onValueChange={setActiveDatabase}
                disabled={schemaLoading}
              >
                <SelectTrigger className="h-8 text-[12px]">
                  <span className="flex! min-w-0 items-center gap-2">
                    {schemaLoading && <SchemaLoadingSpinner />}
                    <SelectValue />
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {schema.databases.map((db) => (
                    <SelectItem key={db} value={db}>
                      {db}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <DatabaseNameBox name={schema.database} loading={schemaLoading} />
          ))}

        {schemaError && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t("conn.schemaLoadError")}</div>
              <div className="mt-0.5 break-words font-mono text-[10.5px] text-warning/80">
                {schemaError}
              </div>
              <button
                onClick={() => void retrySchema()}
                disabled={retrying}
                className="mt-1.5 rounded border border-warning/40 px-2 py-0.5 text-[11px] font-medium text-warning hover:bg-warning/15 disabled:opacity-50"
              >
                {retrying ? t("conn.retrying") : t("conn.retrySchema")}
              </button>
            </div>
          </div>
        )}

        {inTauri() && profile.engine === "sqlite" && (
          <button
            onClick={() => void openSqliteFile()}
            className="mt-2 flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("conn.openSqliteFile")}
          </button>
        )}
      </div>

      <div className="p-2.5">
        <button
          onClick={() => setCommandPalette(true)}
          className="flex w-full items-center gap-2 rounded-md border border-input bg-input-bg px-2.5 py-1.5 text-left text-[12px] text-muted-foreground transition-colors hover:border-border-strong"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1">{t("grid.searchTable")}</span>
          <kbd className="flex items-center gap-0.5 rounded bg-panel-2 px-1 py-0.5 text-[10px]">
            <Command className="h-2.5 w-2.5" />P
          </kbd>
        </button>
      </div>

      {schemaLoading ? (
        <SchemaTreeSkeleton />
      ) : (
        <div className="flex-1 overflow-y-auto px-1.5 pb-3 pt-1">
          <TreeGroup
            label={`Tables · ${grouped.table.length}`}
            kind="table"
            items={grouped.table}
            onOpen={openTable}
          />
          {grouped.view.length > 0 && (
            <TreeGroup
              label={`Views · ${grouped.view.length}`}
              kind="view"
              items={grouped.view}
              onOpen={openTable}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TreeGroup({
  label,
  kind,
  items,
  onOpen,
}: {
  label: string;
  kind: ObjectKind;
  items: TableDef[];
  onOpen: (name: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const Icon = KIND_ICON[kind];
  const activeTab = useStore((s) => s.tabs.find((tb) => tb.id === s.activeTabId));
  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {label}
      </button>
      {open &&
        items.map((tb) => {
          const active =
            activeTab?.kind === "table" && activeTab.tableName === tb.name;
          return (
            <HoverCard key={tb.name} openDelay={350} closeDelay={100}>
              <HoverCardTrigger asChild>
                <button
                  onClick={() => onOpen(tb.name)}
                  className={cn(
                    "group flex w-full items-center gap-2 rounded-md px-2 py-1 pl-6 text-left text-[12.5px] text-foreground/90 transition-colors hover:bg-panel-2 data-[state=open]:bg-panel-2",
                    active && "bg-brand/10 text-brand"
                  )}
                >
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-brand" : "text-muted-foreground"
                    )}
                  />
                  <span className="flex-1 truncate">{tb.name}</span>
                  <span className="text-[10px] tabular-nums text-muted-foreground opacity-0 group-hover:opacity-100">
                    {tb.rowCount || ""}
                  </span>
                </button>
              </HoverCardTrigger>
              <HoverCardContent side="right">
                <TablePreview table={tb} />
              </HoverCardContent>
            </HoverCard>
          );
        })}
    </div>
  );
}

function TablePreview({ table }: { table: TableDef }) {
  const shown = table.columns.slice(0, 9);
  const rest = table.columns.length - shown.length;
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-border bg-panel-2 px-3 py-2">
        {table.kind === "view" ? (
          <Eye className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <Table2 className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <span className="text-[13px] font-semibold text-foreground">
          {table.name}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {table.kind === "view"
            ? "view"
            : `${table.rowCount.toLocaleString()} rows`}
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {shown.map((c) => (
          <div
            key={c.name}
            className="flex items-center gap-2 px-3 py-0.5 text-[11.5px]"
          >
            {c.primaryKey ? (
              <KeyRound className="h-3 w-3 shrink-0 text-warning" />
            ) : c.references ? (
              <Link2 className="h-3 w-3 shrink-0 text-info" />
            ) : (
              <span className="w-3 shrink-0" />
            )}
            <span className="truncate text-foreground/90">{c.name}</span>
            <span
              className="ml-auto shrink-0 font-mono text-[10.5px]"
              style={{ color: typeColor(c.type) }}
            >
              {c.type}
              {c.nullable ? "" : " ·"}
            </span>
          </div>
        ))}
        {rest > 0 && (
          <div className="px-3 py-1 text-[10.5px] text-muted-foreground">
            +{rest} more columns
          </div>
        )}
      </div>
    </div>
  );
}

function PanelHeader({ title }: { title: string }) {
  return (
    <div className="border-b border-border px-3 py-3">
      <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
    </div>
  );
}

function HistoryPanel() {
  const { t } = useTranslation();
  const history = useStore((s) => s.history);
  const openQueryTab = useStore((s) => s.openQueryTab);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("nav.history")} />
      <div className="flex-1 overflow-y-auto p-2">
        {history.map((h) => (
          <button
            key={h.id}
            onClick={() => openQueryTab(h.sql, "History")}
            className="mb-1 flex w-full flex-col gap-1 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-panel-2"
          >
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              {h.source === "agent" ? (
                <Bot className="h-3 w-3 text-brand" />
              ) : (
                <User className="h-3 w-3" />
              )}
              <span>{h.source === "agent" ? h.agentClient : "you"}</span>
              <span>·</span>
              <Clock className="h-3 w-3" />
              {formatRelativeTime(h.ranAt)}
              <span className="ml-auto tabular-nums">
                {h.rowCount} {t("common.rows")}
              </span>
            </div>
            <code className="line-clamp-2 font-mono text-[11px] leading-snug text-foreground/85">
              {h.sql}
            </code>
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentsPanel() {
  const { t } = useTranslation();
  const clients = useStore((s) => s.mcpClients);
  const audit = useStore((s) => s.audit);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("nav.agents")} />
      <div className="flex-1 overflow-y-auto p-2">
        <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("agents.connectedClients")}
        </div>
        {clients.map((c) => {
          const callCount = audit.filter((a) => a.client === c.name).length;
          return (
            <div
              key={c.id}
              className={cn(
                "mb-1 flex flex-col gap-1 rounded-md p-2",
                c.revoked && "opacity-60"
              )}
            >
              <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
                <Bot className="h-3.5 w-3.5 text-brand" />
                <span className="truncate">{c.name}</span>
                {c.revoked && (
                  <span className="rounded border border-destructive/40 bg-destructive/10 px-1 py-px text-[10px] font-semibold text-destructive">
                    {t("agents.revoked")}
                  </span>
                )}
                <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">
                  {callCount} {t("agents.calls")}
                </span>
              </div>
              <div className="flex items-center gap-1 pl-5 text-[10.5px] text-muted-foreground">
                <Clock className="h-3 w-3" />
                {t("agents.lastCall")} :{" "}
                {c.lastActivity ? formatRelativeTime(c.lastActivity) : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SavedPanel() {
  const { t } = useTranslation();
  const saved = useStore((s) => s.saved);
  const openQueryTab = useStore((s) => s.openQueryTab);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("nav.saved")} />
      <div className="flex-1 overflow-y-auto p-2">
        {saved.map((s) => (
          <button
            key={s.id}
            onClick={() => openQueryTab(s.sql, s.name)}
            className="mb-1 flex w-full flex-col gap-1 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-panel-2"
          >
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
              <Bookmark className="h-3.5 w-3.5 text-brand" />
              {s.name}
            </div>
            <code className="line-clamp-2 font-mono text-[11px] leading-snug text-muted-foreground">
              {s.sql}
            </code>
          </button>
        ))}
      </div>
    </div>
  );
}

function QueuePanelSummary() {
  const { t } = useTranslation();
  const queue = useStore((s) => s.queue);
  const pending = queue.filter((q) => q.status === "pending");
  const byOrigin = {
    agent: pending.filter((q) => q.origin === "agent").length,
    "human-ui": pending.filter((q) => q.origin === "human-ui").length,
    "schema-editor": pending.filter((q) => q.origin === "schema-editor").length,
  };
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("nav.queue")} />
      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-border bg-panel-2 p-3">
          <div className="text-3xl font-bold tabular-nums text-brand">
            {pending.length}
          </div>
          <div className="text-[12px] text-muted-foreground">
            {t("queue.title").toLowerCase()}
          </div>
        </div>
        <div className="space-y-1.5 text-[12px]">
          <SummaryRow icon={<Bot className="h-3.5 w-3.5 text-brand" />} label={t("queue.originAgent")} value={byOrigin.agent} />
          <SummaryRow icon={<User className="h-3.5 w-3.5" />} label={t("queue.originHumanUi")} value={byOrigin["human-ui"]} />
          <SummaryRow icon={<Layers className="h-3.5 w-3.5" />} label={t("queue.originSchema")} value={byOrigin["schema-editor"]} />
        </div>
      </div>
    </div>
  );
}

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-panel-2">
      {icon}
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium text-foreground">{value}</span>
    </div>
  );
}

const SETTINGS_SECTIONS = [
  { id: "general", labelKey: "settings.general" },
  { id: "appearance", labelKey: "settings.appearance" },
  { id: "editor", labelKey: "settings.editor" },
  { id: "agents", labelKey: "settings.agents" },
  { id: "shortcuts", labelKey: "settings.shortcuts" },
];

function SettingsNavPanel() {
  const { t } = useTranslation();
  const active = useStore((s) => s.settingsSection ?? "general");
  const setSettingsSection = useStore((s) => s.setSettingsSection);
  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t("settings.title")} />
      <div className="p-2">
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSettingsSection(s.id)}
            className={cn(
              "flex w-full items-center rounded-md px-3 py-2 text-left text-[13px] transition-colors hover:bg-panel-2",
              active === s.id
                ? "bg-brand/10 font-medium text-brand"
                : "text-foreground/85"
            )}
          >
            {t(s.labelKey)}
          </button>
        ))}
      </div>
    </div>
  );
}
