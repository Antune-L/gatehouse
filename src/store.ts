import { create } from "zustand";
import type {
  AuditEntry,
  CellValue,
  ConnectionProfile,
  HistoryEntry,
  McpClient,
  QueueEntry,
  RowDiff,
  SavedQuery,
  SchemaTree,
} from "@/lib/types";
import {
  seedAudit,
  seedHistory,
  seedMcpClients,
  seedProfiles,
  seedQueue,
  seedSaved,
  seedSchema,
} from "@/lib/seed";
import {
  approveAndExecute,
  fetchAudit,
  fetchBackendQueue,
  isBackendRequestId,
  isRealProfile,
  listMcpClients,
  listPersistedProfiles,
  loadSchemaTree,
  loadUiState,
  pairMcpClient,
  persistProfile,
  rejectWrite,
  removeProfile,
  revokeMcpClient,
  saveUiState,
  stageWrite,
} from "@/lib/backend";
import { inTauri, type BackendWriteRequest } from "@/lib/ipc";
import { classify } from "@/lib/sql";
import {
  DEFAULT_SHORTCUTS,
  sanitizeShortcuts,
  type ShortcutMap,
} from "@/lib/shortcuts";
import { applyTheme, storedTheme, type ThemeName } from "@/lib/theme";
import i18n from "@/lib/i18n";

export type RailSection =
  | "connections"
  | "history"
  | "agents"
  | "saved"
  | "queue"
  | "settings";

export type WorkspaceTabKind = "table" | "query";
export type TableSubView = "data" | "structure" | "relations";

export interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  title: string;
  tableName?: string;
  subView?: TableSubView;
  sql?: string;
  dirty?: boolean;
}

export interface StagedEdit {
  id: string;
  tableName: string;
  rowPk: CellValue;
  kind: "update" | "insert" | "delete";
  diffs: RowDiff[];
}

export type ExportFormat = "csv" | "json" | "markdown" | "insert";
export type KeywordCase = "upper" | "lower";

export interface GuiFilter {
  column: string;
  op: string;
  value: string;
}

export interface TableView {
  filters: GuiFilter[];
  sortColumn?: string;
  sortDir: "asc" | "desc";
}

export const EMPTY_TABLE_VIEW: TableView = { filters: [], sortDir: "asc" };

/// Per-profile workspace snapshot: everything the main area shows for one
/// open profile, saved on switch and restored when the profile is reopened.
export interface ProfileWorkspace {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  activeDatabase: string;
  tableViews: Record<string, TableView>;
  staged: StagedEdit[];
}

export interface AppSettings {
  language: "en" | "fr";
  theme: ThemeName;
  rowLimit: number;
  statementTimeout: number;
  restoreTabs: boolean;
  exportFormat: ExportFormat;
  autocomplete: boolean;
  keywordCase: KeywordCase;
  editorFontSize: number;
  historyRetentionDays: number;
  confirmQuit: boolean;
  shortcuts: ShortcutMap;
}

let idCounter = 1;
const nextId = (p: string) => `${p}_${idCounter++}`;

/// Session persistence (desktop only): the slice of UI state stored in the
/// backend's settings table and restored at launch.
interface PersistedUiState {
  tabs?: WorkspaceTab[];
  activeTabId?: string | null;
  history?: HistoryEntry[];
  saved?: SavedQuery[];
  settings?: Partial<AppSettings>;
  groupOrder?: string[];
  activeProfileId?: string | null;
  openProfileIds?: string[];
  profileWorkspaces?: Record<string, ProfileWorkspace>;
}

const PERSISTED_UI_KEYS = [
  "tabs",
  "activeTabId",
  "history",
  "saved",
  "settings",
  "groupOrder",
  "activeProfileId",
  "openProfileIds",
  "profileWorkspaces",
] as const satisfies readonly (keyof PersistedUiState)[];

function isPersistedUiState(v: unknown): v is PersistedUiState {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/// Restored entries carry ids minted by a previous session's counter — move
/// the counter past them so new ids never collide.
function bumpIdCounterPast(ids: string[]) {
  for (const id of ids) {
    const m = id.match(/_(\d+)$/);
    if (m) idCounter = Math.max(idCounter, Number(m[1]) + 1);
  }
}

let uiHydrated = false;
const PERSIST_DEBOUNCE_MS = 500;

interface AppState {
  profiles: ConnectionProfile[];
  groupOrder: string[];
  activeProfileId: string | null;
  openProfileIds: string[];
  profileWorkspaces: Record<string, ProfileWorkspace>;
  activeDatabase: string;
  section: RailSection;
  settingsSection: string;
  connectionDialogOpen: boolean;
  editingProfileId: string | null;
  commandPaletteOpen: boolean;
  connectionsManagerOpen: boolean;
  keychainError: string | null;
  managerProfileId: string | null;

  tabs: WorkspaceTab[];
  activeTabId: string | null;

  queue: QueueEntry[];
  history: HistoryEntry[];
  saved: SavedQuery[];
  mcpClients: McpClient[];
  audit: AuditEntry[];
  auditChainValid: boolean;
  agentActivity: AgentActivityInfo | null;
  staged: StagedEdit[];
  tableViews: Record<string, TableView>;

  schema: SchemaTree;
  schemaError: string | null;
  schemaLoading: boolean;
  dataVersion: number;

  settings: AppSettings;

  initBackend: () => Promise<void>;
  refreshSchema: () => Promise<void>;
  refreshAudit: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  refreshQueue: () => Promise<void>;
  pairClient: (name: string) => Promise<string | null>;
  noteAgentActivity: (info: AgentActivityInfo) => void;
  bumpDataVersion: () => void;
  setSection: (s: RailSection) => void;
  setSettingsSection: (s: string) => void;
  setActiveProfile: (id: string) => void;
  closeProfile: (id: string) => void;
  setActiveDatabase: (db: string) => void;
  openConnectionDialog: (profileId?: string) => void;
  closeConnectionDialog: () => void;
  setCommandPalette: (open: boolean) => void;
  setKeychainError: (message: string | null) => void;
  openConnectionsManager: (profileId?: string) => void;
  closeConnectionsManager: () => void;
  setManagerProfile: (id: string) => void;
  saveProfile: (p: ConnectionProfile, password?: string, sshSecret?: string) => void;
  toggleAgentAccess: (id: string) => void;
  deleteProfile: (id: string) => void;
  addGroup: () => void;
  deleteGroup: (group: string) => void;
  moveProfile: (id: string, toGroup: string, toIndex: number) => void;
  moveGroup: (group: string, toIndex: number) => void;

  openTable: (tableName: string, sub?: TableSubView) => void;
  openQueryTab: (sql?: string, title?: string) => void;
  setActiveTab: (id: string) => void;
  closeTab: (id: string) => void;
  setTableSubView: (id: string, sub: TableSubView) => void;
  updateTabSql: (id: string, sql: string) => void;
  setTableFilters: (tableName: string, filters: GuiFilter[]) => void;
  setTableSort: (tableName: string, sortColumn: string | undefined, sortDir: "asc" | "desc") => void;

  approve: (id: string) => Promise<void>;
  reject: (id: string) => Promise<void>;
  enqueue: (entry: Omit<QueueEntry, "id" | "createdAt" | "expiresAt" | "status">) => Promise<void>;
  addHistory: (sql: string, rowCount: number, durationMs: number) => void;
  addSavedQuery: (name: string, sql: string) => void;
  stageEdits: (edits: StagedEdit[]) => void;
  clearStaged: () => void;

  revokeClient: (id: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
}

export interface AgentActivityInfo {
  client: string;
  tool: string;
  durationMs: number;
  rows: number | null;
  at: string;
}

const initialGroupOrder = Array.from(new Set(seedProfiles.map((p) => p.group)));

// NOTE: table tabs are bound to the active database schema; keeping them across a
// database switch would show empty grids for tables that do not exist there.
function closeTableTabs(st: AppState): Pick<AppState, "tabs" | "activeTabId"> {
  const tabs = st.tabs.filter((t) => t.kind !== "table");
  const activeTabId = tabs.some((t) => t.id === st.activeTabId)
    ? st.activeTabId
    : (tabs[tabs.length - 1]?.id ?? null);
  return { tabs, activeTabId };
}

function snapshotWorkspace(st: AppState): ProfileWorkspace {
  return {
    tabs: st.tabs,
    activeTabId: st.activeTabId,
    activeDatabase: st.activeDatabase,
    tableViews: st.tableViews,
    staged: st.staged,
  };
}

type WorkspaceMap = Record<string, ProfileWorkspace>;

function keepWorkspaces(
  workspaces: WorkspaceMap,
  keep: (profileId: string) => boolean
): WorkspaceMap {
  return Object.fromEntries(
    Object.entries(workspaces).filter(([profileId]) => keep(profileId))
  );
}

function withOpenProfile(openProfileIds: string[], id: string | null): string[] {
  if (!id || openProfileIds.includes(id)) return openProfileIds;
  return [...openProfileIds, id];
}

/// Activating a profile restores the main-area state saved for it, falling back
/// to an empty workspace on its default database the first time it is opened.
function activateProfile(
  profiles: ConnectionProfile[],
  workspaces: WorkspaceMap,
  id: string | null
): Partial<AppState> {
  const ws = id ? workspaces[id] : undefined;
  const fallbackDb = profiles.find((p) => p.id === id)?.database ?? "";
  return {
    activeProfileId: id,
    tabs: ws?.tabs ?? [],
    activeTabId: ws?.activeTabId ?? null,
    activeDatabase: ws?.activeDatabase ?? fallbackDb,
    tableViews: ws?.tableViews ?? {},
    staged: ws?.staged ?? [],
  };
}

/// Switching profiles saves the current main-area state under the outgoing
/// profile and restores the incoming one's, so open tabs survive the round trip.
function switchProfile(st: AppState, id: string): Partial<AppState> {
  const openProfileIds = withOpenProfile(st.openProfileIds, id);
  if (st.activeProfileId === id) return { openProfileIds };
  const profileWorkspaces = st.activeProfileId
    ? { ...st.profileWorkspaces, [st.activeProfileId]: snapshotWorkspace(st) }
    : st.profileWorkspaces;
  return {
    openProfileIds,
    profileWorkspaces,
    ...activateProfile(st.profiles, profileWorkspaces, id),
  };
}

function removeProfilesState(
  st: AppState,
  removedIds: string[],
  profiles: ConnectionProfile[]
): Partial<AppState> {
  const isRemoved = (id: string) => removedIds.includes(id);
  const openProfileIds = st.openProfileIds.filter((id) => !isRemoved(id));
  const profileWorkspaces = keepWorkspaces(
    st.profileWorkspaces,
    (id) => !isRemoved(id)
  );
  const managerProfileId = profiles.some((p) => p.id === st.managerProfileId)
    ? st.managerProfileId
    : (profiles[0]?.id ?? null);
  if (st.activeProfileId && !isRemoved(st.activeProfileId)) {
    return { profiles, openProfileIds, profileWorkspaces, managerProfileId };
  }
  const activeProfileId = openProfileIds[0] ?? profiles[0]?.id ?? null;
  return {
    profiles,
    openProfileIds: withOpenProfile(openProfileIds, activeProfileId),
    profileWorkspaces,
    managerProfileId,
    ...activateProfile(profiles, profileWorkspaces, activeProfileId),
  };
}

export const useStore = create<AppState>((set, get) => ({
  profiles: seedProfiles,
  groupOrder: initialGroupOrder,
  activeProfileId: "p_acme_prod",
  openProfileIds: ["p_acme_prod"],
  profileWorkspaces: {},
  activeDatabase: "acme_prod",
  section: "connections",
  settingsSection: "general",
  connectionDialogOpen: false,
  editingProfileId: null,
  commandPaletteOpen: false,
  keychainError: null,
  connectionsManagerOpen: false,
  managerProfileId: null,

  tabs: [
    {
      id: "t_default",
      kind: "table",
      title: "orders",
      tableName: "orders",
      subView: "data",
    },
  ],
  activeTabId: "t_default",

  queue: seedQueue,
  history: seedHistory,
  saved: seedSaved,
  mcpClients: seedMcpClients,
  audit: seedAudit,
  auditChainValid: true,
  agentActivity: null,
  staged: [],
  tableViews: {},

  schema: seedSchema,
  schemaError: null,
  schemaLoading: false,
  dataVersion: 0,

  settings: {
    language: "fr",
    theme: storedTheme(),
    rowLimit: 500,
    statementTimeout: 30,
    restoreTabs: true,
    exportFormat: "csv",
    autocomplete: true,
    keywordCase: "upper",
    editorFontSize: 13,
    historyRetentionDays: 90,
    confirmQuit: true,
    shortcuts: { ...DEFAULT_SHORTCUTS },
  },

  // NOTE: in the desktop build the demo profiles/tabs are replaced entirely by
  // the persisted backend profiles — everything visible is real. The browser
  // build keeps the seeded demo dataset.
  initBackend: async () => {
    if (!inTauri()) {
      await get().refreshSchema();
      return;
    }
    try {
      const persisted = await listPersistedProfiles();
      const uiRaw = await loadUiState("workspace");
      const ui = isPersistedUiState(uiRaw) ? uiRaw : {};
      const settings = {
        ...get().settings,
        ...ui.settings,
        shortcuts: sanitizeShortcuts(ui.settings?.shortcuts),
      };

      const activeProfileId =
        ui.activeProfileId && persisted.some((p) => p.id === ui.activeProfileId)
          ? ui.activeProfileId
          : (persisted[0]?.id ?? null);
      const active = persisted.find((p) => p.id === activeProfileId) ?? null;

      const knownGroups = Array.from(new Set(persisted.map((p) => p.group)));
      const orderedGroups = (ui.groupOrder ?? []).filter((g) =>
        knownGroups.includes(g)
      );
      const groupOrder = [
        ...orderedGroups,
        ...knownGroups.filter((g) => !orderedGroups.includes(g)),
      ];

      const restoredTabs =
        settings.restoreTabs && ui.tabs && ui.tabs.length > 0 ? ui.tabs : null;
      const defaultTab: WorkspaceTab = {
        id: "t_default",
        kind: "query",
        title: i18n.t("editor.queryTab", { n: 1 }),
        sql: "",
        dirty: false,
      };
      const tabs = restoredTabs ?? [defaultTab];
      const activeTabId =
        restoredTabs && ui.activeTabId && restoredTabs.some((t) => t.id === ui.activeTabId)
          ? ui.activeTabId
          : tabs[0].id;

      const retentionCutoff =
        Date.now() - settings.historyRetentionDays * 24 * 60 * 60 * 1000;
      const history = (ui.history ?? []).filter(
        (h) => new Date(h.ranAt).getTime() >= retentionCutoff
      );
      const saved = ui.saved ?? [];

      const isPersisted = (id: string) => persisted.some((p) => p.id === id);
      // NOTE: the active profile's workspace is `tabs`/`activeTabId` above, not a
      // stored snapshot — keeping a stale copy would resurrect it on the next switch.
      const profileWorkspaces = settings.restoreTabs
        ? keepWorkspaces(
            ui.profileWorkspaces ?? {},
            (id) => id !== activeProfileId && isPersisted(id)
          )
        : {};
      const openProfileIds = withOpenProfile(
        (ui.openProfileIds ?? []).filter(isPersisted),
        activeProfileId
      );

      bumpIdCounterPast([
        ...tabs.map((t) => t.id),
        ...Object.values(profileWorkspaces).flatMap((w) =>
          w.tabs.map((t) => t.id)
        ),
        ...history.map((h) => h.id),
        ...saved.map((s) => s.id),
      ]);

      if (settings.language !== i18n.language) {
        void i18n.changeLanguage(settings.language);
      }
      applyTheme(settings.theme);
      set({
        profiles: persisted,
        groupOrder,
        activeProfileId,
        openProfileIds,
        profileWorkspaces,
        activeDatabase: active?.database ?? "",
        tabs,
        activeTabId,
        queue: [],
        history,
        saved,
        audit: [],
        mcpClients: [],
        settings,
      });
      uiHydrated = true;
    } catch (e) {
      console.error("backend profile load failed", e);
    }
    await get().refreshSchema();
  },

  refreshSchema: async () => {
    const p = activeProfile(get());
    const database = get().activeDatabase;
    set({ schemaLoading: true });
    try {
      const schema = await loadSchemaTree(p, database || undefined);
      set((st) => ({
        schema,
        schemaError: null,
        schemaLoading: false,
        profiles: st.profiles.map((x) =>
          x.id === p?.id ? { ...x, state: "connected" } : x
        ),
      }));
    } catch (e) {
      const current = database || p?.database || "";
      set((st) => ({
        schema: {
          database: current,
          databases: st.schema.databases.includes(current)
            ? st.schema.databases
            : [current],
          schemas: [{ name: "main", tables: [] }],
        },
        schemaError: String(e),
        schemaLoading: false,
        profiles: st.profiles.map((x) =>
          x.id === p?.id ? { ...x, state: "disconnected" } : x
        ),
      }));
    }
  },

  // Fetched on demand (Settings → Agents): opening the audit trail touches
  // the Keychain backend-side, so it is not part of the startup path.
  refreshAudit: async () => {
    try {
      const out = await fetchAudit();
      if (out) set({ audit: out.entries, auditChainValid: out.chainValid });
    } catch (e) {
      console.error("audit fetch failed", e);
    }
  },

  refreshAgents: async () => {
    try {
      const clients = await listMcpClients();
      if (clients) set({ mcpClients: clients });
    } catch (e) {
      console.error("mcp clients fetch failed", e);
    }
  },

  // Pulls the backend queue (the only channel through which MCP-originated
  // requests reach the UI) and merges it with locally staged entries.
  refreshQueue: async () => {
    try {
      const rows = await fetchBackendQueue();
      if (rows.length === 0) return;
      set((st) => {
        const existing = new Map(st.queue.map((q) => [q.id, q]));
        const backendEntries = rows.map((r) => {
          const mapped = backendQueueEntry(r, st.profiles);
          const prev = existing.get(r.id);
          if (!prev) return mapped;
          return {
            ...mapped,
            affectedRows: prev.affectedRows,
            affectedLabel: prev.affectedLabel,
            diffs: prev.diffs,
            error: prev.error,
          };
        });
        const locals = st.queue.filter((q) => !isBackendRequestId(q.id));
        const queue = [...backendEntries, ...locals].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        );
        return { queue };
      });
    } catch (e) {
      console.error("queue fetch failed", e);
    }
  },

  pairClient: async (name) => {
    const out = await pairMcpClient(name);
    await get().refreshAgents();
    return out?.token ?? null;
  },

  noteAgentActivity: (info) =>
    set((st) => ({
      agentActivity: info,
      mcpClients: st.mcpClients.map((c) =>
        c.name === info.client ? { ...c, lastActivity: info.at } : c
      ),
    })),

  bumpDataVersion: () => set((st) => ({ dataVersion: st.dataVersion + 1 })),

  setSection: (s) => {
    set({ section: s, connectionsManagerOpen: false });
    if (s === "agents") {
      void get().refreshAudit();
      void get().refreshAgents();
    }
  },
  setSettingsSection: (s) => {
    set({ settingsSection: s, section: "settings", connectionsManagerOpen: false });
    if (s === "agents") {
      void get().refreshAudit();
      void get().refreshAgents();
    }
  },
  setActiveProfile: (id) => {
    set((st) => ({ ...switchProfile(st, id), section: "connections" }));
    void get().refreshSchema();
  },
  // NOTE: the last open profile cannot be closed — the main area always shows one.
  closeProfile: (id) => {
    const st = get();
    const index = st.openProfileIds.indexOf(id);
    const openProfileIds = st.openProfileIds.filter((x) => x !== id);
    if (index === -1 || openProfileIds.length === 0) return;
    const profileWorkspaces = keepWorkspaces(
      st.profileWorkspaces,
      (key) => key !== id
    );
    if (st.activeProfileId !== id) {
      set({ openProfileIds, profileWorkspaces });
      return;
    }
    const nextId = openProfileIds[Math.min(index, openProfileIds.length - 1)];
    set({
      openProfileIds,
      profileWorkspaces,
      ...activateProfile(st.profiles, profileWorkspaces, nextId),
    });
    void get().refreshSchema();
  },
  setActiveDatabase: (db) => {
    const changed = get().activeDatabase !== db;
    set((st) =>
      changed ? { activeDatabase: db, ...closeTableTabs(st) } : { activeDatabase: db }
    );
    if (changed) void get().refreshSchema();
  },
  openConnectionDialog: (profileId) =>
    set({ connectionDialogOpen: true, editingProfileId: profileId ?? null }),
  closeConnectionDialog: () =>
    set({ connectionDialogOpen: false, editingProfileId: null }),
  setCommandPalette: (open) => set({ commandPaletteOpen: open }),
  setKeychainError: (message) => set({ keychainError: message }),
  openConnectionsManager: (profileId) =>
    set((st) => ({
      connectionsManagerOpen: true,
      section: "connections",
      managerProfileId: profileId ?? st.activeProfileId,
    })),
  closeConnectionsManager: () => set({ connectionsManagerOpen: false }),
  setManagerProfile: (id) => set({ managerProfileId: id }),

  saveProfile: (p, password, sshSecret) => {
    set((st) => {
      const exists = st.profiles.some((x) => x.id === p.id);
      const groupOrder = st.groupOrder.includes(p.group)
        ? st.groupOrder
        : [...st.groupOrder, p.group];
      const profiles = exists
        ? st.profiles.map((x) => (x.id === p.id ? p : x))
        : [...st.profiles, p];
      const base = { ...st, profiles };
      return {
        profiles,
        groupOrder,
        connectionDialogOpen: false,
        editingProfileId: null,
        ...switchProfile(base, p.id),
        ...(st.activeProfileId === p.id ? { activeDatabase: p.database } : {}),
      };
    });
    void persistProfile(p, password, sshSecret)
      .catch((e) => console.error("profile persist failed", e))
      .then(() => get().refreshSchema());
  },

  deleteProfile: (id) => {
    const removed = get().profiles.find((p) => p.id === id);
    const wasActive = get().activeProfileId === id;
    set((st) =>
      removeProfilesState(st, [id], st.profiles.filter((p) => p.id !== id))
    );
    if (wasActive) void get().refreshSchema();
    if (removed) {
      void removeProfile(removed).catch((e) =>
        console.error("profile delete failed", e)
      );
    }
  },

  addGroup: () =>
    set((st) => {
      let n = st.groupOrder.length + 1;
      let name = i18n.t("connScreen.newGroupName", { n });
      while (st.groupOrder.includes(name)) {
        n += 1;
        name = i18n.t("connScreen.newGroupName", { n });
      }
      return { groupOrder: [...st.groupOrder, name] };
    }),

  deleteGroup: (group) => {
    const activeRemoved =
      get().profiles.find((p) => p.id === get().activeProfileId)?.group === group;
    set((st) => {
      const removedIds = st.profiles
        .filter((p) => p.group === group)
        .map((p) => p.id);
      const profiles = st.profiles.filter((p) => p.group !== group);
      return {
        groupOrder: st.groupOrder.filter((g) => g !== group),
        ...removeProfilesState(st, removedIds, profiles),
      };
    });
    if (activeRemoved) void get().refreshSchema();
  },

  moveProfile: (id, toGroup, toIndex) =>
    set((st) => {
      const moving = st.profiles.find((p) => p.id === id);
      if (!moving) return {};
      const without = st.profiles.filter((p) => p.id !== id);
      const updated: ConnectionProfile = { ...moving, group: toGroup };
      const result: ConnectionProfile[] = [];
      let placed = false;
      let seenInGroup = 0;
      for (const p of without) {
        if (p.group === toGroup) {
          if (seenInGroup === toIndex && !placed) {
            result.push(updated);
            placed = true;
          }
          seenInGroup += 1;
        }
        result.push(p);
      }
      if (!placed) result.push(updated);
      return { profiles: result };
    }),

  moveGroup: (group, toIndex) =>
    set((st) => {
      const order = st.groupOrder.filter((g) => g !== group);
      order.splice(toIndex, 0, group);
      return { groupOrder: order };
    }),

  toggleAgentAccess: (id) => {
    const current = get().profiles.find((p) => p.id === id);
    if (!current) return;
    const updated: ConnectionProfile = {
      ...current,
      agentAccess:
        current.environment === "production" ? false : !current.agentAccess,
    };
    set((st) => ({
      profiles: st.profiles.map((p) => (p.id === id ? updated : p)),
    }));
    void persistProfile(updated).catch((e) =>
      console.error("profile persist failed", e)
    );
  },

  openTable: (tableName, sub = "data") =>
    set((st) => {
      const existing = st.tabs.find(
        (t) => t.kind === "table" && t.tableName === tableName
      );
      if (existing) {
        return {
          activeTabId: existing.id,
          section: "connections",
          tabs: st.tabs.map((t) =>
            t.id === existing.id ? { ...t, subView: sub } : t
          ),
        };
      }
      const id = nextId("tab");
      return {
        tabs: [
          ...st.tabs,
          { id, kind: "table", title: tableName, tableName, subView: sub },
        ],
        activeTabId: id,
        section: "connections",
      };
    }),

  openQueryTab: (sql = "", title) =>
    set((st) => {
      const id = nextId("tab");
      const n = st.tabs.filter((t) => t.kind === "query").length + 1;
      const resolved = title ?? i18n.t("editor.queryTab", { n });
      return {
        tabs: [
          ...st.tabs,
          { id, kind: "query", title: resolved, sql, dirty: false },
        ],
        activeTabId: id,
        section: "connections",
      };
    }),

  setActiveTab: (id) => set({ activeTabId: id, section: "connections" }),
  closeTab: (id) =>
    set((st) => {
      const tabs = st.tabs.filter((t) => t.id !== id);
      const activeTabId =
        st.activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : st.activeTabId;
      return { tabs, activeTabId };
    }),
  setTableSubView: (id, sub) =>
    set((st) => ({
      tabs: st.tabs.map((t) => (t.id === id ? { ...t, subView: sub } : t)),
    })),
  updateTabSql: (id, sql) =>
    set((st) => ({
      tabs: st.tabs.map((t) =>
        t.id === id ? { ...t, sql, dirty: true } : t
      ),
    })),
  setTableFilters: (tableName, filters) =>
    set((st) => ({
      tableViews: {
        ...st.tableViews,
        [tableName]: {
          ...(st.tableViews[tableName] ?? EMPTY_TABLE_VIEW),
          filters,
        },
      },
    })),
  setTableSort: (tableName, sortColumn, sortDir) =>
    set((st) => ({
      tableViews: {
        ...st.tableViews,
        [tableName]: {
          ...(st.tableViews[tableName] ?? EMPTY_TABLE_VIEW),
          sortColumn,
          sortDir,
        },
      },
    })),

  approve: async (id) => {
    const entry = get().queue.find((q) => q.id === id);
    if (!entry) return;
    if (isBackendRequestId(id)) {
      try {
        const affected = await approveAndExecute(id);
        set((st) => ({
          queue: st.queue.map((q) =>
            q.id === id
              ? {
                  ...q,
                  status: "used",
                  affectedRows: affected,
                  affectedLabel: i18n.t("queue.affectedRows", { n: affected }),
                }
              : q
          ),
        }));
        get().bumpDataVersion();
        void get().refreshSchema();
      } catch (e) {
        set((st) => ({
          queue: st.queue.map((q) =>
            q.id === id ? { ...q, status: "failed", error: String(e) } : q
          ),
        }));
      }
      return;
    }
    set((st) => ({
      queue: st.queue.map((q) =>
        q.id === id ? { ...q, status: "approved" } : q
      ),
    }));
  },
  reject: async (id) => {
    if (isBackendRequestId(id)) {
      await rejectWrite(id).catch((e) => console.error("reject failed", e));
    }
    set((st) => ({
      queue: st.queue.map((q) =>
        q.id === id ? { ...q, status: "rejected" } : q
      ),
    }));
  },
  enqueue: async (entry) => {
    const { profiles, activeProfileId, activeDatabase } = get();
    const profile = profiles.find((p) => p.id === entry.profileId) ?? null;
    const database =
      activeProfileId === entry.profileId ? activeDatabase : entry.database;
    let id = nextId("q");
    let createdAt = new Date().toISOString();
    let expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    if (profile && isRealProfile(profile)) {
      const ref = await stageWrite(profile, entry.sql, database);
      if (ref) {
        id = ref.id;
        createdAt = ref.createdAt;
        expiresAt = ref.expiresAt;
      }
    }
    set((st) => ({
      queue: [
        { ...entry, id, createdAt, expiresAt, status: "pending" },
        ...st.queue,
      ],
      section: "queue",
    }));
  },
  addHistory: (sql, rowCount, durationMs) =>
    set((st) => ({
      history: [
        {
          id: nextId("h"),
          profileId: st.activeProfileId ?? "",
          sql,
          source: "human",
          durationMs,
          rowCount,
          ranAt: new Date().toISOString(),
          ok: true,
        },
        ...st.history,
      ],
    })),
  addSavedQuery: (name, sql) =>
    set((st) => ({
      saved: [
        {
          id: nextId("sq"),
          name,
          profileId: st.activeProfileId ?? "",
          sql,
          updatedAt: new Date().toISOString(),
        },
        ...st.saved,
      ],
    })),
  stageEdits: (edits) => set((st) => ({ staged: [...st.staged, ...edits] })),
  clearStaged: () => set({ staged: [] }),

  revokeClient: (id) => {
    if (inTauri()) {
      void revokeMcpClient(id)
        .then(() => get().refreshAgents())
        .catch((e) => console.error("revoke failed", e));
      return;
    }
    set((st) => ({ mcpClients: st.mcpClients.filter((c) => c.id !== id) }));
  },
  updateSettings: (patch) => {
    if (patch.theme) applyTheme(patch.theme);
    set((st) => ({ settings: { ...st.settings, ...patch } }));
  },
}));

applyTheme(storedTheme());

// Persist the session slice (tabs, history, saved queries, settings) to the
// backend settings table, debounced; only after hydration so a failed boot
// never overwrites the stored state with defaults.
if (inTauri()) {
  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  useStore.subscribe((st, prev) => {
    if (!uiHydrated) return;
    if (PERSISTED_UI_KEYS.every((k) => st[k] === prev[k])) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const s = useStore.getState();
      void saveUiState("workspace", {
        tabs: s.tabs,
        activeTabId: s.activeTabId,
        history: s.history,
        saved: s.saved,
        settings: s.settings,
        groupOrder: s.groupOrder,
        activeProfileId: s.activeProfileId,
        openProfileIds: s.openProfileIds,
        profileWorkspaces: s.profileWorkspaces,
      });
    }, PERSIST_DEBOUNCE_MS);
  });
}

export const activeProfile = (st: AppState) =>
  st.profiles.find((p) => p.id === st.activeProfileId) ?? null;

export const pendingCount = (st: AppState) =>
  st.queue.filter((q) => q.status === "pending").length;

const QUEUE_STATUSES: QueueEntry["status"][] = [
  "pending",
  "approved",
  "used",
  "rejected",
  "failed",
];

// Backend "expired" stays "pending": the UI derives expiry from expiresAt.
function toQueueStatus(s: string): QueueEntry["status"] {
  return QUEUE_STATUSES.find((x) => x === s) ?? "pending";
}

function backendQueueEntry(
  r: BackendWriteRequest,
  profiles: ConnectionProfile[]
): QueueEntry {
  const profile = profiles.find((p) => p.id === r.profile_id) ?? null;
  const c = classify(r.sql);
  return {
    id: r.id,
    origin: r.origin === "human-ui" ? "human-ui" : "agent",
    originLabel: r.origin === "human-ui" ? "SQL editor" : r.origin,
    profileId: r.profile_id,
    profileName: profile?.name ?? r.profile_id,
    database: r.database,
    environment: profile?.environment ?? "local",
    sql: r.sql,
    statementKind: c.kind,
    affectedRows: null,
    affectedLabel: i18n.t("queue.unknownRows"),
    risk: c.kind === "delete" || c.kind === "ddl" ? "high" : "medium",
    targetObjects: [],
    createdAt: new Date(r.created_at * 1000).toISOString(),
    expiresAt: new Date(r.expires_at * 1000).toISOString(),
    status: toQueueStatus(r.status),
  };
}

export function classifyIntoQueue(
  sql: string,
  profile: ConnectionProfile,
  database: string
): Omit<QueueEntry, "id" | "createdAt" | "expiresAt" | "status"> | null {
  const c = classify(sql);
  if (!c.isWrite) return null;
  return {
    origin: "human-ui",
    originLabel: "SQL editor",
    profileId: profile.id,
    profileName: profile.name,
    database,
    environment: profile.environment,
    sql,
    statementKind: c.kind,
    affectedRows: null,
    affectedLabel: i18n.t("queue.unknownRows"),
    risk: c.kind === "delete" || c.kind === "ddl" ? "high" : "medium",
    targetObjects: [],
  };
}

export { seedSchema };
