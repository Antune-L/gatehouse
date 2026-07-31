import type {
  CellValue,
  Classification,
  QueryResult,
  SqlType,
  StatementKind,
} from "./types";
import { seedSchema, seedTableData, type SeedTableData } from "./seed";

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE)\b/i;
const DDL_KEYWORDS =
  /\b(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT\s+ON|RENAME)\b/i;
const DANGEROUS =
  /\b(COPY|INTO\s+OUTFILE|INTO\s+DUMPFILE|xp_cmdshell|LOAD_FILE)\b/i;

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
}

/**
 * Fail-closed classifier: anything not provably read-only routes to the
 * validation queue. Walks the whole statement so a modifying CTE
 * (WITH x AS (DELETE ... RETURNING) SELECT ...) is caught.
 */
export function classify(rawSql: string): Classification {
  const sql = stripComments(rawSql);
  if (!sql) return { kind: "unknown", isWrite: false, reason: "Empty statement" };

  if (DANGEROUS.test(sql)) {
    return {
      kind: "unknown",
      isWrite: true,
      reason: "Contains a file/program access construct — routed for review",
    };
  }

  const leading = sql.match(/^\s*([a-zA-Z]+)/);
  const head = leading ? leading[1].toUpperCase() : "";

  if (DDL_KEYWORDS.test(sql)) {
    return { kind: "ddl", isWrite: true, reason: "Schema-altering statement (DDL)" };
  }
  if (WRITE_KEYWORDS.test(sql)) {
    const kind: StatementKind = /^\s*INSERT/i.test(sql)
      ? "insert"
      : /^\s*UPDATE/i.test(sql)
        ? "update"
        : /^\s*DELETE/i.test(sql)
          ? "delete"
          : "update";
    return {
      kind,
      isWrite: true,
      reason: "Data-modifying statement — requires approval",
    };
  }
  if (head === "SELECT" || head === "WITH" || head === "SHOW" || head === "EXPLAIN") {
    if (/^\s*EXPLAIN\s+ANALYZE/i.test(sql)) {
      return {
        kind: "unknown",
        isWrite: true,
        reason: "EXPLAIN ANALYZE executes the query — routed for review",
      };
    }
    return { kind: "read", isWrite: false, reason: "Read-only statement" };
  }
  return {
    kind: "unknown",
    isWrite: true,
    reason: "Could not classify — treated as a write (fail-closed)",
  };
}

function findTable(name: string): SeedTableData | undefined {
  const key = name.replace(/^public\./i, "").replace(/["'`]/g, "").toLowerCase();
  return seedTableData[key];
}

function colType(table: string, col: string): SqlType {
  const t = seedSchema.schemas[0].tables.find((x) => x.name === table);
  const c = t?.columns.find((x) => x.name === col);
  return c?.type ?? "text";
}

function coerce(v: string): CellValue {
  const t = v.trim();
  if (/^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
  if (/^null$/i.test(t)) return null;
  return t;
}

export interface TableQueryOptions {
  sortColumn?: string;
  sortDir?: "asc" | "desc";
  filters?: { column: string; op: string; value: string }[];
  offset?: number;
  limit?: number;
  timeoutMs?: number;
}

function applyFilter(value: CellValue, op: string, target: string): boolean {
  const s = value === null ? "" : String(value);
  const isNull = value === null;
  switch (op) {
    case "=":
      return s === target;
    case "!=":
      return s !== target;
    case "contains":
      return s.toLowerCase().includes(target.toLowerCase());
    case "starts":
      return s.toLowerCase().startsWith(target.toLowerCase());
    case ">":
      return Number(value) > Number(target);
    case "<":
      return Number(value) < Number(target);
    case "is null":
      return isNull;
    case "is not null":
      return !isNull;
    default:
      return true;
  }
}

export function queryTable(
  tableName: string,
  opts: TableQueryOptions = {}
): QueryResult {
  const start = performance.now();
  const table = findTable(tableName);
  if (!table) {
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      limit: opts.limit ?? 500,
      durationMs: 0,
    };
  }
  let rows = table.rows.slice();

  if (opts.filters) {
    for (const f of opts.filters) {
      const ci = table.columns.indexOf(f.column);
      if (ci < 0) continue;
      rows = rows.filter((r) => applyFilter(r[ci], f.op, f.value));
    }
  }

  const total = rows.length;

  if (opts.sortColumn) {
    const ci = table.columns.indexOf(opts.sortColumn);
    if (ci >= 0) {
      const dir = opts.sortDir === "desc" ? -1 : 1;
      rows.sort((a, b) => {
        const av = a[ci];
        const bv = b[ci];
        if (av === null && bv === null) return 0;
        if (av === null) return 1;
        if (bv === null) return -1;
        if (typeof av === "number" && typeof bv === "number")
          return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
  }

  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;
  const page = rows.slice(offset, offset + limit);

  return {
    columns: table.columns.map((c) => ({
      name: c,
      type: colType(tableName, c),
    })),
    rows: page,
    rowCount: total,
    truncated: total > offset + limit,
    limit,
    totalRows: total,
    durationMs: Math.round((performance.now() - start) * 100) / 100,
  };
}

/**
 * Minimal SELECT executor over the seed dataset — enough for the editor to be
 * genuinely functional in the browser demo. The Tauri build runs real SQL.
 */
export function runSelect(rawSql: string): QueryResult | { error: string } {
  const sql = stripComments(rawSql).replace(/;$/, "");
  const from = sql.match(/\bfrom\s+([a-zA-Z_][\w.]*)/i);
  if (!from) {
    return { error: "Only SELECT ... FROM <table> is supported in the demo runtime." };
  }
  const tableName = from[1];
  const table = findTable(tableName);
  if (!table) {
    return { error: `relation "${tableName}" does not exist in the sample database` };
  }

  const countMatch = /select\s+count\s*\(\s*\*?\s*\)/i.test(sql);
  const limitMatch = sql.match(/\blimit\s+(\d+)/i);
  const orderMatch = sql.match(/\border\s+by\s+([a-zA-Z_]\w*)\s*(asc|desc)?/i);
  const whereMatch = sql.match(
    /\bwhere\s+([a-zA-Z_]\w*)\s*(=|!=|>|<)\s*('[^']*'|[\w.]+)/i
  );

  const opts: TableQueryOptions = {
    limit: limitMatch ? parseInt(limitMatch[1], 10) : 500,
  };
  if (orderMatch) {
    opts.sortColumn = orderMatch[1];
    opts.sortDir = (orderMatch[2]?.toLowerCase() as "asc" | "desc") ?? "asc";
  }
  if (whereMatch) {
    const val = coerce(whereMatch[3]);
    opts.filters = [
      { column: whereMatch[1], op: whereMatch[2], value: val === null ? "" : String(val) },
    ];
  }

  const res = queryTable(tableName, opts);

  if (countMatch) {
    return {
      columns: [{ name: "count", type: "bigint" }],
      rows: [[res.rowCount]],
      rowCount: 1,
      truncated: false,
      limit: 1,
      durationMs: res.durationMs,
    };
  }

  // Projection: SELECT col1, col2 FROM ...
  const proj = sql.match(/select\s+(.+?)\s+from/i);
  if (proj && proj[1].trim() !== "*") {
    const wanted = proj[1]
      .split(",")
      .map((c) => c.trim().replace(/^\w+\./, ""))
      .filter((c) => /^[a-zA-Z_]\w*$/.test(c));
    const idx = wanted
      .map((c) => res.columns.findIndex((rc) => rc.name === c))
      .filter((i) => i >= 0);
    if (idx.length > 0) {
      return {
        ...res,
        columns: idx.map((i) => res.columns[i]),
        rows: res.rows.map((r) => idx.map((i) => r[i])),
      };
    }
  }

  return res;
}
