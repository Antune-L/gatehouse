import { open } from "@tauri-apps/plugin-dialog";
import type {
  AuditEntry,
  CellValue,
  Classification,
  ConnectionProfile,
  McpClient,
  QueryResult,
  SchemaTree,
  StatementKind,
  TableDef,
} from "./types";
import { seedSchema } from "./seed";
import { classify, queryTable, runSelect, type TableQueryOptions } from "./sql";
import {
  inTauri,
  ipc,
  toBackendProfile,
  toConnectionProfile,
  toQueryResult,
  toSqlType,
  type BackendTable,
  type BackendWriteRequest,
} from "./ipc";

const REAL_ENGINES = ["sqlite", "postgres", "mysql", "mssql"];

/// A "real" profile talks to the Rust engine; browser mode runs on the
/// seeded demo dataset.
export function isRealProfile(p: ConnectionProfile | null): boolean {
  return !!p && REAL_ENGINES.includes(p.engine) && inTauri();
}

const STATEMENT_KINDS: StatementKind[] = [
  "read",
  "insert",
  "update",
  "delete",
  "ddl",
  "unknown",
];

function toStatementKind(v: string): StatementKind {
  return STATEMENT_KINDS.find((k) => k === v) ?? "unknown";
}

/// Classification authority (Decisions §5): in the desktop app the Rust
/// classifier decides read vs write; the TS mirror only serves browser mode.
/// Fail closed — an unreachable backend routes the statement to the queue.
export async function classifyStatement(
  sql: string,
  engine: string
): Promise<Classification> {
  if (!inTauri()) return classify(sql);
  try {
    const c = await ipc.classifySql(sql, engine);
    return { kind: toStatementKind(c.kind), isWrite: c.is_write, reason: c.reason };
  } catch (e) {
    return { kind: "unknown", isWrite: true, reason: String(e) };
  }
}

export function allTables(tree: SchemaTree): TableDef[] {
  return tree.schemas.flatMap((s) => s.tables);
}

function toTableDef(t: BackendTable): TableDef {
  return {
    name: t.name,
    kind: t.kind === "view" ? "view" : "table",
    schema: t.schema,
    rowCount: t.rowCount,
    columns: t.columns.map((c) => ({
      name: c.name,
      type: toSqlType(c.type),
      nullable: c.nullable,
      primaryKey: c.primaryKey || undefined,
      defaultValue: c.defaultValue,
      references: c.references ?? undefined,
    })),
    indexes: t.indexes.map((i) => ({
      name: i.name,
      columns: i.columns,
      unique: i.unique,
    })),
    triggers: [],
  };
}

const DEFAULT_SCHEMAS = ["public", "main", "dbo"];

export async function loadSchemaTree(
  p: ConnectionProfile | null,
  database?: string
): Promise<SchemaTree> {
  if (!isRealProfile(p) || !p) return seedSchema;
  const schema = await ipc.getSchema(p.id, database);
  const bySchema = new Map<string, TableDef[]>();
  for (const t of schema.tables) {
    const list = bySchema.get(t.schema) ?? [];
    list.push(toTableDef(t));
    bySchema.set(t.schema, list);
  }
  const names = [...bySchema.keys()].sort((a, b) => {
    const da = DEFAULT_SCHEMAS.includes(a) ? 0 : 1;
    const db = DEFAULT_SCHEMAS.includes(b) ? 0 : 1;
    return da - db || a.localeCompare(b);
  });
  return {
    database: schema.database,
    databases: schema.databases,
    schemas: names.map((name) => ({ name, tables: bySchema.get(name) ?? [] })),
  };
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlValueLiteral(value: string): string {
  if (/^-?\d+(\.\d+)?$/.test(value.trim())) return value.trim();
  return `'${value.replace(/'/g, "''")}'`;
}

function filterToSql(f: { column: string; op: string; value: string }): string | null {
  const col = quoteIdent(f.column);
  switch (f.op) {
    case "=":
    case "!=":
    case ">":
    case "<":
      return `${col} ${f.op} ${sqlValueLiteral(f.value)}`;
    case "contains":
      return `${col} LIKE '%${f.value.replace(/'/g, "''")}%'`;
    case "starts":
      return `${col} LIKE '${f.value.replace(/'/g, "''")}%'`;
    case "is null":
      return `${col} IS NULL`;
    case "is not null":
      return `${col} IS NOT NULL`;
    default:
      return null;
  }
}

export function qualifiedTable(schemaName: string | undefined, tableName: string): string {
  const table = quoteIdent(tableName);
  return schemaName ? `${quoteIdent(schemaName)}.${table}` : table;
}

export async function fetchTableData(
  p: ConnectionProfile | null,
  tableName: string,
  opts: TableQueryOptions,
  schemaName?: string,
  database?: string
): Promise<QueryResult> {
  if (!isRealProfile(p) || !p) {
    return queryTable(tableName, opts);
  }
  const where = (opts.filters ?? [])
    .map(filterToSql)
    .filter((c): c is string => c !== null);
  const parts = [`SELECT * FROM ${qualifiedTable(schemaName, tableName)}`];
  if (where.length > 0) parts.push(`WHERE ${where.join(" AND ")}`);
  if (opts.sortColumn) {
    parts.push(
      `ORDER BY ${quoteIdent(opts.sortColumn)} ${opts.sortDir === "desc" ? "DESC" : "ASC"}`
    );
  }
  const limit = opts.limit ?? 500;
  const raw = await ipc.runQuery(p.id, parts.join("\n"), limit, {
    timeoutMs: opts.timeoutMs,
    database,
  });
  const result = toQueryResult(raw);
  if (!result.truncated) return { ...result, totalRows: result.rowCount };
  const countSql = [
    `SELECT COUNT(*) FROM ${qualifiedTable(schemaName, tableName)}`,
    ...(where.length > 0 ? [`WHERE ${where.join(" AND ")}`] : []),
  ].join("\n");
  try {
    const countRaw = await ipc.runQuery(p.id, countSql, 1, {
      timeoutMs: opts.timeoutMs,
      database,
    });
    const value = Number(countRaw.rows[0]?.[0]);
    if (Number.isFinite(value)) return { ...result, totalRows: value };
  } catch (e) {
    console.error("row count query failed", e);
  }
  return result;
}

export const EXPORT_MAX_ROWS = 1_000_000;
const EXPORT_BATCH_ROWS = 2_000;
const EXPORT_MIN_BATCH_ROWS = 50;
const ROW_CAP_HEADROOM = 1;
const MSSQL_ENGINE = "mssql";

export interface ExportProgressControls {
  onProgress?: (rows: number) => void;
  isCancelled?: () => boolean;
}

export interface ExportControls extends ExportProgressControls {
  pkCol?: string;
}

export function sqlLiteral(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return `'${v.replace(/'/g, "''")}'`;
}

function orderTerm(column: string, dir?: "asc" | "desc"): string {
  return `${quoteIdent(column)} ${dir === "desc" ? "DESC" : "ASC"}`;
}

function paginationClause(engine: string, limit: number, offset: number): string {
  if (engine === MSSQL_ENGINE) {
    return `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  return offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
}

/// Full-table read for exports: same read-only path as the grid fetch (same
/// sort, filters and database), fetched in batches so each request stays under
/// the engine byte cap. Keyset pagination on the primary key when the grid is
/// unsorted, LIMIT/OFFSET otherwise; a batch that still trips the byte cap is
/// retried with a smaller size.
export async function fetchTableDataForExport(
  p: ConnectionProfile | null,
  tableName: string,
  opts: TableQueryOptions,
  schemaName?: string,
  database?: string,
  controls: ExportControls = {}
): Promise<QueryResult> {
  function fetchInSingleQuery(): Promise<QueryResult> {
    return fetchTableData(
      p,
      tableName,
      { ...opts, limit: EXPORT_MAX_ROWS },
      schemaName,
      database
    );
  }

  if (!isRealProfile(p) || !p) return fetchInSingleQuery();

  const { pkCol } = controls;
  const keysetPk = pkCol !== undefined && !opts.sortColumn ? pkCol : undefined;
  const orderTerms: string[] = [];
  if (keysetPk !== undefined) {
    orderTerms.push(orderTerm(keysetPk));
  } else {
    if (opts.sortColumn) orderTerms.push(orderTerm(opts.sortColumn, opts.sortDir));
    if (pkCol !== undefined) orderTerms.push(orderTerm(pkCol));
  }
  if (orderTerms.length === 0 && p.engine === MSSQL_ENGINE) {
    return fetchInSingleQuery();
  }

  const target = qualifiedTable(schemaName, tableName);
  const baseWhere = (opts.filters ?? [])
    .map(filterToSql)
    .filter((c): c is string => c !== null);

  const rows: CellValue[][] = [];
  let columns: QueryResult["columns"] = [];
  let batch = EXPORT_BATCH_ROWS;
  let lastPk: CellValue | undefined;
  let truncated = false;
  let durationMs = 0;

  while (rows.length < EXPORT_MAX_ROWS) {
    if (controls.isCancelled?.()) break;
    const size = Math.min(batch, EXPORT_MAX_ROWS - rows.length);
    const where = [...baseWhere];
    if (keysetPk !== undefined && lastPk !== undefined) {
      where.push(`${quoteIdent(keysetPk)} > ${sqlLiteral(lastPk)}`);
    }
    const parts = [`SELECT * FROM ${target}`];
    if (where.length > 0) parts.push(`WHERE ${where.join(" AND ")}`);
    if (orderTerms.length > 0) parts.push(`ORDER BY ${orderTerms.join(", ")}`);
    parts.push(
      paginationClause(p.engine, size, keysetPk !== undefined ? 0 : rows.length)
    );

    const raw = await ipc.runQuery(p.id, parts.join("\n"), size + ROW_CAP_HEADROOM, {
      timeoutMs: opts.timeoutMs,
      database,
    });
    const res = toQueryResult(raw);
    durationMs += res.durationMs;

    if (res.truncated && batch > EXPORT_MIN_BATCH_ROWS) {
      batch = Math.max(EXPORT_MIN_BATCH_ROWS, Math.floor(batch / 2));
      continue;
    }

    if (columns.length === 0) columns = res.columns;
    for (const row of res.rows) rows.push(row);
    controls.onProgress?.(rows.length);

    if (res.truncated) {
      truncated = true;
      break;
    }
    if (res.rows.length < size) break;
    if (keysetPk !== undefined) {
      const pkIndex = res.columns.findIndex((c) => c.name === keysetPk);
      const lastRow = res.rows[res.rows.length - 1];
      const nextPk = pkIndex >= 0 ? lastRow[pkIndex] : null;
      if (nextPk === null) {
        truncated = true;
        break;
      }
      lastPk = nextPk;
    }
  }

  return {
    columns,
    rows,
    rowCount: rows.length,
    truncated: truncated || rows.length >= EXPORT_MAX_ROWS,
    limit: EXPORT_MAX_ROWS,
    durationMs,
    totalRows: rows.length,
  };
}

export interface RunOptions {
  queryId?: string;
  timeoutMs?: number;
  database?: string;
}

export async function runEditorSql(
  p: ConnectionProfile | null,
  sql: string,
  limit: number,
  run?: RunOptions
): Promise<QueryResult | { error: string }> {
  if (!isRealProfile(p) || !p) return runSelect(sql);
  try {
    const raw = await ipc.runQuery(p.id, sql, limit, run);
    return toQueryResult(raw);
  } catch (e) {
    return { error: String(e) };
  }
}

export async function cancelRunningQuery(queryId: string): Promise<void> {
  if (!inTauri()) return;
  await ipc.cancelQuery(queryId);
}

export async function loadUiState(key: string): Promise<unknown> {
  if (!inTauri()) return null;
  try {
    const raw = await ipc.uiStateGet(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error("ui state load failed", e);
    return null;
  }
}

export async function saveUiState(key: string, value: unknown): Promise<void> {
  if (!inTauri()) return;
  try {
    await ipc.uiStateSet(key, JSON.stringify(value));
  } catch (e) {
    console.error("ui state save failed", e);
  }
}

export async function runExplain(
  p: ConnectionProfile | null,
  sql: string,
  database?: string
): Promise<QueryResult | { error: string } | null> {
  if (!isRealProfile(p) || !p) return null;
  try {
    const bare = sql.trim().replace(/;\s*$/, "");
    const raw = await ipc.explainQuery(p.id, bare, database);
    return toQueryResult(raw);
  } catch (e) {
    return { error: String(e) };
  }
}

export interface StagedWriteRef {
  id: string;
  createdAt: string;
  expiresAt: string;
}

export async function stageWrite(
  p: ConnectionProfile,
  sql: string,
  database?: string
): Promise<StagedWriteRef | null> {
  if (!isRealProfile(p)) return null;
  const req: BackendWriteRequest = await ipc.requestWrite(
    "human-ui",
    p.id,
    database || p.database,
    sql
  );
  return {
    id: req.id,
    createdAt: new Date(req.created_at * 1000).toISOString(),
    expiresAt: new Date(req.expires_at * 1000).toISOString(),
  };
}

export function isBackendRequestId(id: string): boolean {
  return id.startsWith("wr_");
}

export async function fetchBackendQueue(): Promise<BackendWriteRequest[]> {
  if (!inTauri()) return [];
  return ipc.queueList();
}

function toIso(seconds: number | null): string | null {
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

export async function listMcpClients(): Promise<McpClient[] | null> {
  if (!inTauri()) return null;
  const rows = await ipc.mcpClientsList();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: toIso(r.createdAt) ?? new Date(0).toISOString(),
    lastActivity: toIso(r.lastActivity),
    revoked: r.revoked,
  }));
}

export async function pairMcpClient(
  name: string
): Promise<{ token: string } | null> {
  if (!inTauri()) return null;
  const out = await ipc.mcpPairNew(name);
  return { token: out.token };
}

export async function revokeMcpClient(id: string): Promise<void> {
  if (!inTauri()) return;
  await ipc.mcpClientRevoke(id);
}

export async function fetchMcpServerInfo(): Promise<{
  socketPath: string | null;
  proxyPath: string | null;
} | null> {
  if (!inTauri()) return null;
  return ipc.mcpServerInfo();
}

export interface AuditState {
  chainValid: boolean;
  entries: AuditEntry[];
}

export async function fetchAudit(): Promise<AuditState | null> {
  if (!inTauri()) return null;
  const out = await ipc.auditList();
  return {
    chainValid: out.chainValid,
    entries: out.entries.map((e) => ({
      id: `a_${e.seq}`,
      client: e.origin === "human-ui" ? "Gatehouse" : e.origin,
      profileName: e.profileName,
      requestType: e.action,
      at: new Date(e.at * 1000).toISOString(),
      outcome: toAuditOutcome(e.outcome),
    })),
  };
}

const AUDIT_OUTCOMES: AuditEntry["outcome"][] = [
  "approved",
  "rejected",
  "executed",
  "read",
  "pending",
  "failed",
];

function toAuditOutcome(v: string): AuditEntry["outcome"] {
  return AUDIT_OUTCOMES.find((o) => o === v) ?? "executed";
}

export async function approveAndExecute(id: string): Promise<number> {
  const outcome = await ipc.queueApproveExecute(id);
  return outcome.result.affectedRows;
}

export async function rejectWrite(id: string): Promise<void> {
  await ipc.queueResolve(id, false);
}

export async function persistProfile(
  p: ConnectionProfile,
  password?: string,
  sshSecret?: string
): Promise<void> {
  if (!inTauri()) return;
  await ipc.saveProfile(toBackendProfile(p), password, sshSecret);
}

export async function removeProfile(p: ConnectionProfile): Promise<void> {
  if (!inTauri()) return;
  await ipc.deleteProfile(p.id);
}

export async function listPersistedProfiles(): Promise<ConnectionProfile[]> {
  if (!inTauri()) return [];
  const profiles = await ipc.listProfiles();
  return profiles.map(toConnectionProfile);
}

export async function testProfileConnection(
  p: ConnectionProfile,
  password?: string,
  sshSecret?: string
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  try {
    const ms = await ipc.testConnection(toBackendProfile(p), password, sshSecret);
    return { ok: true, latencyMs: Math.max(1, Math.round(ms)) };
  } catch (e) {
    return { ok: false, latencyMs: 0, error: String(e) };
  }
}

export async function pickSqliteFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  return typeof selected === "string" ? selected : null;
}
