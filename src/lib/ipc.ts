import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  ConnectionProfile,
  Engine,
  Environment,
  QueryResult,
  SqlType,
} from "./types";

export interface BackendProfile {
  id: string;
  name: string;
  engine: string;
  group: string;
  color: string;
  host: string;
  port: number;
  user: string;
  database: string;
  environment: string;
  ssl: boolean;
  ssh_tunnel: boolean;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path: string;
  read_only: boolean;
  agent_access: boolean;
  save_password: boolean;
  has_password: boolean;
  has_ssh_secret: boolean;
}

export interface BackendColumnMeta {
  name: string;
  type: string;
}

export interface BackendQueryResult {
  columns: BackendColumnMeta[];
  rows: (string | number | boolean | null)[][];
  rowCount: number;
  truncated: boolean;
  limit: number;
  durationMs: number;
}

export interface BackendColumn {
  name: string;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
  references: { table: string; column: string } | null;
}

export interface BackendIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface BackendTable {
  schema: string;
  name: string;
  kind: string;
  rowCount: number;
  columns: BackendColumn[];
  indexes: BackendIndex[];
}

export interface BackendSchema {
  database: string;
  databases: string[];
  tables: BackendTable[];
}

export interface BackendWriteRequest {
  id: string;
  origin: string;
  profile_id: string;
  database: string;
  sql: string;
  statement_kind: string;
  created_at: number;
  expires_at: number;
  status: string;
}

export interface ApproveOutcome {
  request: BackendWriteRequest;
  result: { affectedRows: number };
}

export interface BackendClassification {
  kind: string;
  is_write: boolean;
  reason: string;
}

export interface BackendMcpClient {
  id: string;
  name: string;
  createdAt: number;
  lastActivity: number | null;
  revoked: boolean;
}

export interface BackendMcpServerInfo {
  socketPath: string | null;
  proxyPath: string | null;
}

export interface BackendAuditEntry {
  seq: number;
  at: number;
  origin: string;
  profileId: string;
  profileName: string;
  action: string;
  detail: string;
  outcome: string;
}

export interface BackendAuditList {
  chainValid: boolean;
  entries: BackendAuditEntry[];
}

export const inTauri = (): boolean => isTauri();

const ENGINES: Engine[] = ["postgres", "mysql", "sqlite", "mssql"];
const ENVIRONMENTS: Environment[] = ["local", "staging", "production"];
const SQL_TYPES: SqlType[] = [
  "integer",
  "bigint",
  "text",
  "varchar",
  "boolean",
  "timestamp",
  "date",
  "numeric",
  "json",
  "uuid",
];

export function toEngine(v: string): Engine {
  return ENGINES.find((e) => e === v) ?? "sqlite";
}

export function toEnvironment(v: string): Environment {
  return ENVIRONMENTS.find((e) => e === v) ?? "local";
}

export function toSqlType(v: string): SqlType {
  return SQL_TYPES.find((t) => t === v) ?? "text";
}

// SQLite: read-only open flag + authorizer. Postgres/MySQL: read-only session
// (best-effort). MS SQL has no session read-only mode — "unknown" until the
// SEC-03 attack matrix validates an EXECUTE AS mode (Decisions §5).
const READ_ONLY_BADGES: Record<Engine, ConnectionProfile["readOnlyBadge"]> = {
  sqlite: "guaranteed",
  postgres: "best-effort",
  mysql: "best-effort",
  mssql: "unknown",
};

export function toConnectionProfile(p: BackendProfile): ConnectionProfile {
  const engine = toEngine(p.engine);
  return {
    id: p.id,
    name: p.name,
    engine,
    group: p.group,
    color: p.color,
    host: p.host,
    port: p.port,
    user: p.user,
    database: p.database,
    environment: toEnvironment(p.environment),
    ssl: p.ssl,
    sshTunnel: p.ssh_tunnel,
    sshHost: p.ssh_host,
    sshPort: p.ssh_port,
    sshUser: p.ssh_user,
    sshKeyPath: p.ssh_key_path,
    readOnly: p.read_only,
    agentAccess: p.agent_access,
    readOnlyBadge: READ_ONLY_BADGES[engine],
    state: "connected",
    savePassword: p.save_password,
    hasPassword: p.has_password,
    hasSshSecret: p.has_ssh_secret,
  };
}

export function toBackendProfile(p: ConnectionProfile): BackendProfile {
  return {
    id: p.id,
    name: p.name,
    engine: p.engine,
    group: p.group,
    color: p.color,
    host: p.host,
    port: p.port,
    user: p.user,
    database: p.database,
    environment: p.environment,
    ssl: p.ssl,
    ssh_tunnel: p.sshTunnel,
    ssh_host: p.sshHost,
    ssh_port: p.sshPort,
    ssh_user: p.sshUser,
    ssh_key_path: p.sshKeyPath,
    read_only: p.readOnly,
    agent_access: p.agentAccess,
    save_password: p.savePassword,
    has_password: p.hasPassword ?? false,
    has_ssh_secret: p.hasSshSecret ?? false,
  };
}

const BOOLEAN_TEXT: Record<string, boolean> = {
  t: true,
  f: false,
  true: true,
  false: false,
};

export function toQueryResult(r: BackendQueryResult): QueryResult {
  const columns = r.columns.map((c) => ({ name: c.name, type: toSqlType(c.type) }));
  const boolCols = new Set(
    columns.flatMap((c, i) => (c.type === "boolean" ? [i] : []))
  );
  // NOTE: Postgres' text protocol returns booleans as "t"/"f" — normalise them
  // so the grid displays true/false and staged edits emit boolean literals.
  const rows =
    boolCols.size === 0
      ? r.rows
      : r.rows.map((row) =>
          row.map((v, i) =>
            boolCols.has(i) && typeof v === "string" && v in BOOLEAN_TEXT
              ? BOOLEAN_TEXT[v]
              : v
          )
        );
  return {
    columns,
    rows,
    rowCount: r.rowCount,
    truncated: r.truncated,
    limit: r.limit,
    durationMs: Math.round(r.durationMs * 100) / 100,
  };
}

// Mirrors crypto.rs KEYCHAIN_ERROR_PREFIX: every backend error caused by a
// denied/failed macOS Keychain access carries this marker. The app cannot
// decrypt stored passwords without the Keychain, so App.tsx listens for this
// event and shows a blocking error screen.
const KEYCHAIN_ERROR_MARKER = "keychain:";
export const KEYCHAIN_ERROR_EVENT = "gatehouse:keychain-error";

function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes(KEYCHAIN_ERROR_MARKER)) {
      window.dispatchEvent(
        new CustomEvent(KEYCHAIN_ERROR_EVENT, { detail: message })
      );
    }
    throw e;
  });
}

export const ipc = {
  classifySql: (sql: string, engine: string) =>
    inv<BackendClassification>("classify_sql", { sql, engine }),
  listProfiles: () => inv<BackendProfile[]>("list_profiles"),
  saveProfile: (profile: BackendProfile, password?: string, sshSecret?: string) =>
    inv<void>("save_profile", {
      profile,
      password: password ?? null,
      sshSecret: sshSecret ?? null,
    }),
  deleteProfile: (id: string) => inv<void>("delete_profile", { id }),
  getSchema: (profileId: string, database?: string) =>
    inv<BackendSchema>("get_schema", { profileId, database: database ?? null }),
  testConnection: (profile: BackendProfile, password?: string, sshSecret?: string) =>
    inv<number>("test_connection", {
      profile,
      password: password ?? null,
      sshSecret: sshSecret ?? null,
    }),
  runQuery: (
    profileId: string,
    sql: string,
    limit: number,
    opts?: { queryId?: string; timeoutMs?: number; database?: string }
  ) =>
    inv<BackendQueryResult>("run_query", {
      profileId,
      sql,
      limit,
      queryId: opts?.queryId ?? null,
      timeoutMs: opts?.timeoutMs ?? null,
      database: opts?.database ?? null,
    }),
  explainQuery: (profileId: string, sql: string, database?: string) =>
    inv<BackendQueryResult>("explain_query", { profileId, sql, database: database ?? null }),
  cancelQuery: (queryId: string) => inv<void>("cancel_query", { queryId }),
  uiStateGet: (key: string) => inv<string | null>("ui_state_get", { key }),
  uiStateSet: (key: string, value: string) =>
    inv<void>("ui_state_set", { key, value }),
  requestWrite: (origin: string, profileId: string, database: string, sql: string) =>
    inv<BackendWriteRequest>("request_write", { origin, profileId, database, sql }),
  queueResolve: (id: string, approve: boolean) =>
    inv<BackendWriteRequest>("queue_resolve", { id, approve }),
  queueApproveExecute: (id: string) =>
    inv<ApproveOutcome>("queue_approve_execute", { id }),
  auditList: () => inv<BackendAuditList>("audit_list"),
  queueList: () => inv<BackendWriteRequest[]>("queue_list"),
  mcpPairNew: (name: string) =>
    inv<{ client: BackendMcpClient; token: string }>("mcp_pair_new", { name }),
  mcpClientsList: () => inv<BackendMcpClient[]>("mcp_clients_list"),
  mcpClientRevoke: (id: string) => inv<void>("mcp_client_revoke", { id }),
  mcpServerInfo: () => inv<BackendMcpServerInfo>("mcp_server_info"),
};
