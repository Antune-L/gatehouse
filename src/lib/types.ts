export type Engine = "postgres" | "mysql" | "sqlite" | "mssql";

export type Environment = "local" | "staging" | "production";

export type ReadOnlyBadge = "guaranteed" | "best-effort" | "unknown";

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export interface ConnectionProfile {
  id: string;
  name: string;
  engine: Engine;
  group: string;
  color: string;
  host: string;
  port: number;
  user: string;
  database: string;
  environment: Environment;
  ssl: boolean;
  sshTunnel: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshKeyPath: string;
  readOnly: boolean;
  agentAccess: boolean;
  readOnlyBadge: ReadOnlyBadge;
  state: ConnectionState;
  savePassword: boolean;
}

export type SqlType =
  | "integer"
  | "bigint"
  | "text"
  | "varchar"
  | "boolean"
  | "timestamp"
  | "date"
  | "numeric"
  | "json"
  | "uuid";

export interface ColumnDef {
  name: string;
  type: SqlType;
  nullable: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  defaultValue?: string | null;
  references?: { table: string; column: string };
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TriggerDef {
  name: string;
  timing: string;
  event: string;
}

export type ObjectKind = "table" | "view" | "materialized_view";

export interface TableDef {
  name: string;
  kind: ObjectKind;
  schema: string;
  rowCount: number;
  columns: ColumnDef[];
  indexes: IndexDef[];
  triggers: TriggerDef[];
}

export interface SchemaTree {
  database: string;
  databases: string[];
  schemas: { name: string; tables: TableDef[] }[];
}

export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: { name: string; type: SqlType }[];
  rows: CellValue[][];
  rowCount: number;
  truncated: boolean;
  limit: number;
  durationMs: number;
  affectedRows?: number;
  totalRows?: number;
}

export type StatementKind =
  | "read"
  | "insert"
  | "update"
  | "delete"
  | "ddl"
  | "unknown";

export interface Classification {
  kind: StatementKind;
  isWrite: boolean;
  reason: string;
}

export type QueueOrigin = "human-ui" | "agent" | "schema-editor";

export type RiskLevel = "low" | "medium" | "high";

export interface RowDiff {
  column: string;
  oldValue: CellValue;
  newValue: CellValue;
}

export interface QueueEntry {
  id: string;
  origin: QueueOrigin;
  originLabel: string;
  profileId: string;
  profileName: string;
  database: string;
  environment: Environment;
  sql: string;
  statementKind: StatementKind;
  affectedRows: number | null;
  affectedLabel: string;
  risk: RiskLevel;
  targetObjects: string[];
  diffs?: RowDiff[];
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "used" | "rejected" | "failed";
  error?: string;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  sql: string;
  source: "human" | "agent";
  agentClient?: string;
  durationMs: number;
  rowCount: number;
  ranAt: string;
  ok: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  profileId: string;
  sql: string;
  updatedAt: string;
}

export interface McpClient {
  id: string;
  name: string;
  createdAt: string;
  lastActivity: string | null;
  revoked: boolean;
}

export interface AuditEntry {
  id: string;
  client: string;
  profileName: string;
  requestType: string;
  at: string;
  outcome: "approved" | "rejected" | "executed" | "read" | "pending" | "failed";
}

export interface EditorTab {
  id: string;
  title: string;
  profileId: string;
  sql: string;
  dirty: boolean;
}
