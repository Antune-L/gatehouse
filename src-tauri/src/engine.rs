//! Database engines. SQLite is fully implemented (Decisions §5: read-only is
//! *guaranteed* via the open flag + authorizer). Postgres reads run on a
//! session opened with `default_transaction_read_only=on` (best-effort per
//! Decisions §5); MySQL/MS SQL remain scaffolded.

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

#[derive(Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub row_count: usize,
    pub truncated: bool,
    pub limit: usize,
    pub duration_ms: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub affected_rows: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkRef {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    #[serde(rename = "type")]
    pub col_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
    pub references: Option<FkRef>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub row_count: i64,
    pub columns: Vec<ColumnSchema>,
    pub indexes: Vec<IndexSchema>,
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("postgres error: {}", pg_error_text(.0))]
    Postgres(#[from] postgres::Error),
    #[error("mysql error: {0}")]
    MySql(#[from] mysql::Error),
    #[error("mssql error: {0}")]
    MsSql(#[from] tiberius::error::Error),
    #[error("engine `{0}` is not yet wired")]
    NotImplemented(String),
    #[error("TLS error: {0}")]
    Tls(String),
    #[error("query interrupted (cancelled or statement timeout exceeded)")]
    Interrupted,
    #[error("connection pool exhausted for this target ({} in use) — gave up after {}s", crate::pool::MAX_PER_KEY, crate::pool::WAIT.as_secs())]
    PoolTimeout,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Result-size cap on the read path — mirrors the 5 MiB contract in mcp.rs.
pub const READ_BYTE_CAP: usize = 5 * 1024 * 1024;

fn json_value_size(v: &serde_json::Value) -> usize {
    match v {
        serde_json::Value::Null => 4,
        serde_json::Value::Bool(_) => 5,
        serde_json::Value::Number(_) => 8,
        serde_json::Value::String(s) => s.len() + 2,
        _ => 16,
    }
}

fn map_sqlite_err(e: rusqlite::Error) -> EngineError {
    if let rusqlite::Error::SqliteFailure(inner, _) = &e {
        if inner.code == rusqlite::ErrorCode::OperationInterrupted {
            return EngineError::Interrupted;
        }
    }
    EngineError::Sqlite(e)
}

fn value_to_json(v: ValueRef) -> serde_json::Value {
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Value::from(f),
        ValueRef::Text(t) => serde_json::Value::from(String::from_utf8_lossy(t).to_string()),
        ValueRef::Blob(_) => serde_json::Value::from("<blob>"),
    }
}

fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn map_decl_type(decl: &str) -> &'static str {
    let d = decl.to_uppercase();
    if d.contains("BOOL") {
        "boolean"
    } else if d.contains("BIGINT") {
        "bigint"
    } else if d.contains("INT") {
        "integer"
    } else if d.contains("VARCHAR") {
        "varchar"
    } else if d.contains("CHAR") || d.contains("CLOB") || d.contains("TEXT") {
        "text"
    } else if d.contains("TIMESTAMP") || d.contains("DATETIME") {
        "timestamp"
    } else if d.contains("DATE") {
        "date"
    } else if d.contains("REAL")
        || d.contains("FLOA")
        || d.contains("DOUB")
        || d.contains("NUMERIC")
        || d.contains("DECIMAL")
    {
        "numeric"
    } else if d.contains("JSON") {
        "json"
    } else if d.contains("UUID") {
        "uuid"
    } else {
        "text"
    }
}

/// SEC-03: allowlist of SQLite built-in functions permitted on the read path.
/// Anything else (load_extension, readfile/writefile, unknown extensions…) is
/// denied — fail closed.
const SQLITE_FUNCTION_ALLOWLIST: &[&str] = &[
    "abs",
    "avg",
    "ceil",
    "ceiling",
    "char",
    "coalesce",
    "concat",
    "concat_ws",
    "count",
    "cume_dist",
    "date",
    "datetime",
    "degrees",
    "dense_rank",
    "exp",
    "first_value",
    "floor",
    "format",
    "glob",
    "group_concat",
    "hex",
    "ifnull",
    "iif",
    "instr",
    "julianday",
    "lag",
    "last_value",
    "lead",
    "length",
    "like",
    "likelihood",
    "likely",
    "ln",
    "log",
    "log10",
    "log2",
    "lower",
    "ltrim",
    "max",
    "min",
    "mod",
    "nth_value",
    "ntile",
    "nullif",
    "octet_length",
    "percent_rank",
    "pi",
    "pow",
    "power",
    "printf",
    "quote",
    "radians",
    "random",
    "randomblob",
    "rank",
    "replace",
    "round",
    "row_number",
    "rtrim",
    "sign",
    "sin",
    "sqlite_version",
    "sqrt",
    "strftime",
    "string_agg",
    "substr",
    "substring",
    "sum",
    "tan",
    "time",
    "timediff",
    "total",
    "total_changes",
    "trim",
    "trunc",
    "typeof",
    "unhex",
    "unicode",
    "unixepoch",
    "unlikely",
    "upper",
    "zeroblob",
    "json",
    "jsonb",
    "json_array",
    "json_array_length",
    "json_each",
    "json_error_position",
    "json_extract",
    "json_group_array",
    "json_group_object",
    "json_object",
    "json_patch",
    "json_pretty",
    "json_quote",
    "json_remove",
    "json_set",
    "json_tree",
    "json_type",
    "json_valid",
];

/// Open a SQLite database read-only with an authorizer that refuses everything
/// except reads — including ATTACH (Decisions §5, "==Garanti==") — and only
/// allowlisted functions (SEC-03).
pub fn open_sqlite_readonly(path: &str) -> Result<Connection, EngineError> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.authorizer(Some(|ctx: rusqlite::hooks::AuthContext| {
        use rusqlite::hooks::AuthAction;
        match ctx.action {
            AuthAction::Select | AuthAction::Read { .. } | AuthAction::Recursive => {
                rusqlite::hooks::Authorization::Allow
            }
            AuthAction::Function { function_name } => {
                let name = function_name.to_ascii_lowercase();
                if SQLITE_FUNCTION_ALLOWLIST.contains(&name.as_str()) {
                    rusqlite::hooks::Authorization::Allow
                } else {
                    rusqlite::hooks::Authorization::Deny
                }
            }
            _ => rusqlite::hooks::Authorization::Deny,
        }
    }));
    Ok(conn)
}

/// Read-only open without the SQL authorizer — used exclusively for our own
/// fixed introspection statements (PRAGMA), which the authorizer would deny.
/// The SQLITE_OPEN_READ_ONLY flag still guarantees no write can happen.
fn open_sqlite_readonly_raw(path: &str) -> Result<Connection, EngineError> {
    Ok(Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?)
}

pub fn sqlite_tables(path: &str) -> Result<Vec<String>, EngineError> {
    let conn = open_sqlite_readonly(path)?;
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(names)
}

pub fn sqlite_schema(path: &str) -> Result<Vec<TableSchema>, EngineError> {
    let conn = open_sqlite_readonly_raw(path)?;
    let mut stmt = conn.prepare(
        "SELECT name, type FROM sqlite_master
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name",
    )?;
    let objects = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(objects.len());
    for (name, kind) in objects {
        let quoted = quote_ident(&name);

        let mut fks: Vec<(String, String, String)> = Vec::new();
        if kind == "table" {
            let mut fk_stmt = conn.prepare(&format!("PRAGMA foreign_key_list({quoted})"))?;
            let rows = fk_stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ))
            })?;
            for row in rows {
                fks.push(row?);
            }
        }

        let mut col_stmt = conn.prepare(&format!("PRAGMA table_info({quoted})"))?;
        let columns = col_stmt
            .query_map([], |r| {
                let col_name: String = r.get(1)?;
                let decl: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
                let notnull: i32 = r.get(3)?;
                let default_value: Option<String> = r.get(4)?;
                let pk: i32 = r.get(5)?;
                Ok((col_name, decl, notnull, default_value, pk))
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .map(|(col_name, decl, notnull, default_value, pk)| {
                let references =
                    fks.iter()
                        .find(|(from, _, _)| *from == col_name)
                        .map(|(_, table, to)| FkRef {
                            table: table.clone(),
                            column: to.clone(),
                        });
                ColumnSchema {
                    nullable: notnull == 0 && pk == 0,
                    primary_key: pk > 0,
                    col_type: map_decl_type(&decl).to_string(),
                    name: col_name,
                    default_value,
                    references,
                }
            })
            .collect::<Vec<_>>();

        let mut indexes = Vec::new();
        if kind == "table" {
            let mut idx_stmt = conn.prepare(&format!("PRAGMA index_list({quoted})"))?;
            let idx_rows = idx_stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(1)?, r.get::<_, i32>(2)? != 0))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (idx_name, unique) in idx_rows {
                let mut info =
                    conn.prepare(&format!("PRAGMA index_info({})", quote_ident(&idx_name)))?;
                let cols = info
                    .query_map([], |r| r.get::<_, Option<String>>(2))?
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .flatten()
                    .collect();
                indexes.push(IndexSchema {
                    name: idx_name,
                    columns: cols,
                    unique,
                });
            }
        }

        let row_count = if kind == "table" {
            conn.query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |r| r.get(0))
                .unwrap_or(0)
        } else {
            0
        };

        out.push(TableSchema {
            schema: "main".to_string(),
            name,
            kind,
            row_count,
            columns,
            indexes,
        });
    }
    Ok(out)
}

pub fn sqlite_query(
    path: &str,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    on_handle: impl FnOnce(rusqlite::InterruptHandle),
) -> Result<QueryResult, EngineError> {
    let start = std::time::Instant::now();
    let conn = open_sqlite_readonly(path)?;
    on_handle(conn.get_interrupt_handle());
    if let Some(ms) = timeout_ms {
        let deadline = std::time::Instant::now() + Duration::from_millis(ms);
        conn.progress_handler(100, Some(move || std::time::Instant::now() >= deadline));
    }
    let mut stmt = conn.prepare(sql).map_err(map_sqlite_err)?;
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            col_type: map_decl_type(c.decl_type().unwrap_or("")).to_string(),
        })
        .collect();
    let col_count = columns.len();

    let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut rows = stmt.query([]).map_err(map_sqlite_err)?;
    let mut count = 0usize;
    let mut bytes = 0usize;
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(map_sqlite_err)? {
        if count >= limit {
            truncated = true;
            break;
        }
        let mut r = Vec::with_capacity(col_count);
        for i in 0..col_count {
            r.push(value_to_json(row.get_ref(i)?));
        }
        bytes += r.iter().map(json_value_size).sum::<usize>();
        if bytes > READ_BYTE_CAP && !rows_out.is_empty() {
            truncated = true;
            break;
        }
        rows_out.push(r);
        count += 1;
    }

    Ok(QueryResult {
        columns,
        row_count: rows_out.len(),
        rows: rows_out,
        truncated,
        limit,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Write path — only ever reached through the validation queue after a human
/// approval (Decisions §7/§10). One statement per call, enforced upstream by
/// the classifier.
/// Parse-only validation of a write statement. Uses the raw read-only open —
/// the authorizer would deny preparing an INSERT — and never steps the
/// statement; SQLITE_OPEN_READ_ONLY still guarantees nothing can be written.
pub fn sqlite_validate(path: &str, sql: &str) -> Result<(), EngineError> {
    let conn = open_sqlite_readonly_raw(path)?;
    conn.prepare(sql)?;
    Ok(())
}

pub fn sqlite_execute(path: &str, sql: &str) -> Result<ExecResult, EngineError> {
    let conn = Connection::open(path)?;
    match conn.execute(sql, []) {
        Ok(n) => Ok(ExecResult { affected_rows: n }),
        Err(rusqlite::Error::ExecuteReturnedResults) => {
            let mut stmt = conn.prepare(sql)?;
            let mut rows = stmt.query([])?;
            let mut n = 0usize;
            while rows.next()?.is_some() {
                n += 1;
            }
            Ok(ExecResult { affected_rows: n })
        }
        Err(e) => Err(e.into()),
    }
}

pub fn sqlite_test(path: &str) -> Result<f64, EngineError> {
    let start = std::time::Instant::now();
    let conn = open_sqlite_readonly(path)?;
    conn.query_row("SELECT 1", [], |_| Ok(()))?;
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

/// Connection target for network engines. The password only ever exists here,
/// backend-side — it never crosses the IPC boundary (Decisions §3/§10).
/// `tcp` overrides the actual TCP endpoint (SSH tunnel local end) while `host`
/// stays the logical DB host so TLS verification/SNI still target it.
#[derive(Clone)]
pub struct NetTarget {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub dbname: String,
    pub password: Option<String>,
    pub ssl: bool,
    pub tcp: Option<(std::net::IpAddr, u16)>,
}

/// Pool key for this target under a profile: starts with `<profile_id>|` so
/// stale keys of an edited/re-tunneled profile can be purged (see pool.rs).
pub fn pool_key(profile_id: &str, t: &NetTarget) -> String {
    let tcp = t
        .tcp
        .map(|(ip, port)| format!("{ip}:{port}"))
        .unwrap_or_default();
    format!(
        "{profile_id}|{}|{}|{}|{}|{}|{tcp}",
        t.dbname, t.host, t.port, t.user, t.ssl
    )
}

const NET_CONNECT_TIMEOUT_SECS: u64 = 5;
const POOL_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const SYSTEM_SCHEMAS: &str = "('pg_catalog','information_schema')";

/// Full-verification TLS (chain + hostname, native-tls defaults) — Decisions
/// §10: no opt-out knobs in v1.
pub fn pg_tls() -> Result<postgres_native_tls::MakeTlsConnector, EngineError> {
    let connector = native_tls::TlsConnector::new().map_err(|e| EngineError::Tls(e.to_string()))?;
    Ok(postgres_native_tls::MakeTlsConnector::new(connector))
}

fn pg_connect(t: &NetTarget, read_only: bool) -> Result<postgres::Client, EngineError> {
    let mut cfg = postgres::Config::new();
    // NOTE: postgres::Config::port() appends to a one-port-per-host list —
    // calling it twice with a single host is "invalid number of ports".
    cfg.host(&t.host)
        .port(t.tcp.map_or(t.port, |(_, port)| port))
        .dbname(&t.dbname)
        .application_name("gatehouse")
        .connect_timeout(Duration::from_secs(NET_CONNECT_TIMEOUT_SECS));
    if let Some((ip, _)) = t.tcp {
        // TCP goes through the tunnel; `host` above still drives TLS
        // verification and SNI (Decisions §10: two distinct fields).
        cfg.hostaddr(ip);
    }
    if t.user.is_empty() {
        // Local trust-auth servers (e.g. Homebrew) expect the OS user.
        if let Ok(os_user) = std::env::var("USER") {
            cfg.user(&os_user);
        }
    } else {
        cfg.user(&t.user);
    }
    if let Some(pw) = &t.password {
        cfg.password(pw);
    }
    let mut client = if t.ssl {
        cfg.ssl_mode(postgres::config::SslMode::Require);
        cfg.connect(pg_tls()?)?
    } else {
        cfg.connect(postgres::NoTls)?
    };
    if read_only {
        // NOTE: a post-connect SET instead of the startup `options` parameter —
        // poolers like PgBouncer reject `options` ("unsupported startup
        // parameter"). Session-level equivalent; still best-effort (§13).
        client.simple_query("SET default_transaction_read_only = on")?;
    }
    Ok(client)
}

fn map_pg_type(name: &str) -> &'static str {
    match name {
        "int2" | "int4" | "integer" | "smallint" | "serial" => "integer",
        "int8" | "bigint" | "bigserial" => "bigint",
        "bool" | "boolean" => "boolean",
        "varchar" | "bpchar" | "character varying" | "character" => "varchar",
        "text" | "name" | "citext" => "text",
        "timestamp"
        | "timestamptz"
        | "timestamp without time zone"
        | "timestamp with time zone" => "timestamp",
        "date" => "date",
        "numeric" | "float4" | "float8" | "real" | "double precision" | "money" => "numeric",
        "json" | "jsonb" => "json",
        "uuid" => "uuid",
        _ => "text",
    }
}

pub fn pg_test(t: &NetTarget) -> Result<f64, EngineError> {
    let start = std::time::Instant::now();
    let mut client = pg_connect(t, true)?;
    client.simple_query("SELECT 1")?;
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

/// A server-side cancellation (our cancel token or statement_timeout) must
/// surface as Interrupted, like the SQLite path.
// NOTE: postgres::Error's Display is just the error kind ("db error") — the
// actual server message lives in the source chain, so surface it explicitly.
fn pg_error_text(e: &postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("{}: {}", db.severity(), db.message());
        if let Some(detail) = db.detail() {
            s.push_str(&format!(" — {detail}"));
        }
        if let Some(hint) = db.hint() {
            s.push_str(&format!(" (hint: {hint})"));
        }
        return s;
    }
    match std::error::Error::source(e) {
        Some(src) => format!("{e}: {src}"),
        None => e.to_string(),
    }
}

fn map_pg_err(e: postgres::Error) -> EngineError {
    if e.code() == Some(&postgres::error::SqlState::QUERY_CANCELED) {
        return EngineError::Interrupted;
    }
    EngineError::Postgres(e)
}

fn pg_pool() -> &'static crate::pool::Pool<postgres::Client> {
    static POOL: std::sync::OnceLock<crate::pool::Pool<postgres::Client>> =
        std::sync::OnceLock::new();
    POOL.get_or_init(Default::default)
}

fn pg_checkout<'a>(
    pool_key: &str,
    t: &NetTarget,
) -> Result<crate::pool::Lease<'a, postgres::Client>, EngineError> {
    pg_pool().checkout(
        pool_key,
        || pg_connect(t, true),
        |c| c.is_valid(POOL_PROBE_TIMEOUT).is_ok(),
        || EngineError::PoolTimeout,
    )
}

fn simple_rows(
    client: &mut postgres::Client,
    sql: &str,
) -> Result<Vec<Vec<Option<String>>>, EngineError> {
    let mut out = Vec::new();
    for msg in client.simple_query(sql)? {
        if let postgres::SimpleQueryMessage::Row(row) = msg {
            let mut r = Vec::with_capacity(row.len());
            for i in 0..row.len() {
                r.push(row.get(i).map(|s| s.to_string()));
            }
            out.push(r);
        }
    }
    Ok(out)
}

fn cell(row: &[Option<String>], i: usize) -> String {
    row.get(i).cloned().flatten().unwrap_or_default()
}

pub fn pg_schema(t: &NetTarget, pool_key: &str) -> Result<Vec<TableSchema>, EngineError> {
    let mut lease = pg_checkout(pool_key, t)?;
    let out = pg_schema_on(lease.conn());
    if out.is_err() {
        lease.destroy();
    }
    out
}

const PG_DATABASES_SQL: &str = "SELECT datname FROM pg_database \
     WHERE NOT datistemplate AND datallowconn ORDER BY datname";

/// Databases connectable with the current credentials, read on the same
/// read-only session as the schema. Callers treat a failure as "enumeration
/// unsupported" and fall back to the connected database only.
pub fn pg_databases(t: &NetTarget, pool_key: &str) -> Result<Vec<String>, EngineError> {
    let mut lease = pg_checkout(pool_key, t)?;
    let out = simple_rows(lease.conn(), PG_DATABASES_SQL);
    if out.is_err() {
        lease.destroy();
    }
    Ok(out?.iter().map(|r| cell(r, 0)).collect())
}

fn pg_schema_on(client: &mut postgres::Client) -> Result<Vec<TableSchema>, EngineError> {
    let mut pks: HashMap<(String, String), Vec<String>> = HashMap::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT n.nspname, c.relname, a.attname
             FROM pg_index i
             JOIN pg_class c ON c.oid = i.indrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
             WHERE i.indisprimary AND n.nspname NOT IN {SYSTEM_SCHEMAS}"
        ),
    )? {
        pks.entry((cell(&r, 0), cell(&r, 1)))
            .or_default()
            .push(cell(&r, 2));
    }

    let mut fks: HashMap<(String, String, String), FkRef> = HashMap::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT tc.table_schema, tc.table_name, kcu.column_name, ccu.table_name, ccu.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'FOREIGN KEY'
               AND tc.table_schema NOT IN {SYSTEM_SCHEMAS}"
        ),
    )? {
        fks.insert(
            (cell(&r, 0), cell(&r, 1), cell(&r, 2)),
            FkRef {
                table: cell(&r, 3),
                column: cell(&r, 4),
            },
        );
    }

    let mut row_counts: HashMap<(String, String), i64> = HashMap::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT n.nspname, c.relname, GREATEST(c.reltuples, 0)::bigint
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r','p') AND n.nspname NOT IN {SYSTEM_SCHEMAS}"
        ),
    )? {
        row_counts.insert((cell(&r, 0), cell(&r, 1)), cell(&r, 2).parse().unwrap_or(0));
    }

    let mut indexes: HashMap<(String, String), Vec<IndexSchema>> = HashMap::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT schemaname, tablename, indexname, indexdef
             FROM pg_indexes WHERE schemaname NOT IN {SYSTEM_SCHEMAS}"
        ),
    )? {
        let def = cell(&r, 3);
        let cols = def
            .split_once('(')
            .map(|(_, rest)| {
                rest.trim_end_matches(')')
                    .split(',')
                    .map(|c| c.trim().trim_matches('"').to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        indexes
            .entry((cell(&r, 0), cell(&r, 1)))
            .or_default()
            .push(IndexSchema {
                name: cell(&r, 2),
                columns: cols,
                unique: def.contains("UNIQUE"),
            });
    }

    let mut columns: HashMap<(String, String), Vec<ColumnSchema>> = HashMap::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default, is_identity
             FROM information_schema.columns
             WHERE table_schema NOT IN {SYSTEM_SCHEMAS}
             ORDER BY table_schema, table_name, ordinal_position"
        ),
    )? {
        let key = (cell(&r, 0), cell(&r, 1));
        let name = cell(&r, 2);
        let primary_key = pks.get(&key).map(|c| c.contains(&name)).unwrap_or(false);
        let references = fks
            .get(&(key.0.clone(), key.1.clone(), name.clone()))
            .map(|f| FkRef {
                table: f.table.clone(),
                column: f.column.clone(),
            });
        columns.entry(key).or_default().push(ColumnSchema {
            col_type: map_pg_type(&cell(&r, 3)).to_string(),
            nullable: cell(&r, 4) == "YES",
            primary_key,
            // NOTE: identity columns have no column_default — expose them as
            // auto-generated anyway so the UI knows the server fills them.
            default_value: r
                .get(5)
                .cloned()
                .flatten()
                .or_else(|| (cell(&r, 6) == "YES").then(|| "IDENTITY".to_string())),
            references,
            name,
        });
    }

    let mut out = Vec::new();
    for r in simple_rows(
        client,
        &format!(
            "SELECT table_schema, table_name, table_type
             FROM information_schema.tables
             WHERE table_schema NOT IN {SYSTEM_SCHEMAS}
             ORDER BY table_schema, table_name"
        ),
    )? {
        let key = (cell(&r, 0), cell(&r, 1));
        let kind = if cell(&r, 2) == "VIEW" {
            "view"
        } else {
            "table"
        };
        out.push(TableSchema {
            row_count: row_counts.get(&key).copied().unwrap_or(0),
            columns: columns.remove(&key).unwrap_or_default(),
            indexes: indexes.remove(&key).unwrap_or_default(),
            schema: key.0,
            name: key.1,
            kind: kind.to_string(),
        });
    }
    Ok(out)
}

/// Read a statement over the simple-query protocol: every value arrives as
/// text, which keeps type handling uniform. Column types come from a prepare()
/// round-trip when the statement is preparable (best effort).
pub fn pg_query(
    t: &NetTarget,
    pool_key: &str,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    on_cancel: impl FnOnce(postgres::CancelToken),
) -> Result<QueryResult, EngineError> {
    let mut lease = pg_checkout(pool_key, t)?;
    let client = lease.conn();
    on_cancel(client.cancel_token());
    let out = pg_query_on(client, sql, limit, timeout_ms);
    if out.is_err() {
        lease.destroy();
    }
    out
}

fn pg_query_on(
    client: &mut postgres::Client,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
) -> Result<QueryResult, EngineError> {
    let start = std::time::Instant::now();
    // Session settings persist on a pooled connection — always (re)set them.
    client
        .simple_query(&format!(
            "SET statement_timeout = {}",
            timeout_ms.unwrap_or(0)
        ))
        .map_err(map_pg_err)?;
    let mut columns: Vec<ColumnMeta> = client
        .prepare(sql)
        .map(|st| {
            st.columns()
                .iter()
                .map(|c| ColumnMeta {
                    name: c.name().to_string(),
                    col_type: map_pg_type(c.type_().name()).to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    // Server-side guard: `simple_query` buffers the whole result set, so cap
    // it at the source. `limit + 1` keeps the truncation flag accurate.
    let effective_sql = crate::classifier::with_server_limit(sql, "postgres", limit + 1);
    let sql = effective_sql.as_deref().unwrap_or(sql);

    let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut bytes = 0usize;
    for msg in client.simple_query(sql).map_err(map_pg_err)? {
        match msg {
            postgres::SimpleQueryMessage::RowDescription(cols) => {
                if columns.is_empty() {
                    columns = cols
                        .iter()
                        .map(|c| ColumnMeta {
                            name: c.name().to_string(),
                            col_type: "text".to_string(),
                        })
                        .collect();
                }
            }
            postgres::SimpleQueryMessage::Row(row) => {
                if rows_out.len() >= limit || bytes > READ_BYTE_CAP {
                    truncated = true;
                    continue;
                }
                let mut r = Vec::with_capacity(row.len());
                for i in 0..row.len() {
                    r.push(match row.get(i) {
                        Some(v) => serde_json::Value::from(v),
                        None => serde_json::Value::Null,
                    });
                }
                bytes += r.iter().map(json_value_size).sum::<usize>();
                rows_out.push(r);
            }
            _ => {}
        }
    }

    Ok(QueryResult {
        columns,
        row_count: rows_out.len(),
        rows: rows_out,
        truncated,
        limit,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Write path — only ever reached through the validation queue after a human
/// approval, on a session WITHOUT the read-only default.
/// Parse-only validation of a write statement: PREPARE via the extended
/// protocol on the pooled read-only session. The statement is never executed,
/// so the read-only guarantee holds — this catches syntax errors, missing
/// tables/columns and invalid literal casts before the write is staged.
pub fn pg_validate(t: &NetTarget, pool_key: &str, sql: &str) -> Result<(), EngineError> {
    let mut lease = pg_checkout(pool_key, t)?;
    let client = lease.conn();
    match client.prepare(sql) {
        Ok(_) => Ok(()),
        Err(e) => {
            // NOTE: a server-reported error leaves the session clean; anything
            // else (I/O, protocol) may have poisoned the pooled connection.
            if e.as_db_error().is_none() {
                lease.destroy();
            }
            Err(map_pg_err(e))
        }
    }
}

pub fn pg_execute(t: &NetTarget, sql: &str) -> Result<ExecResult, EngineError> {
    let mut client = pg_connect(t, false)?;
    let mut affected = 0usize;
    for msg in client.simple_query(sql)? {
        if let postgres::SimpleQueryMessage::CommandComplete(n) = msg {
            affected = usize::try_from(n).unwrap_or(usize::MAX);
        }
    }
    Ok(ExecResult {
        affected_rows: affected,
    })
}

// ---------------------------------------------------------------------------
// MySQL (crate `mysql`, sync). Reads run with `SET SESSION TRANSACTION READ
// ONLY` — best-effort per Decisions §5, the engine remains the barrier — and
// `max_execution_time` as the statement timeout (SELECT-only, MySQL ≥ 5.7.8).
// Cancellation: `KILL QUERY <id>` from an on-demand control connection (never
// carries user SQL); the worker surfaces ER_QUERY_INTERRUPTED, so the
// cancellation is only confirmed once the worker actually terminated
// (Decisions §10 "Ressources agent").

fn mysql_opts(t: &NetTarget) -> Result<mysql::Opts, EngineError> {
    if t.ssl && t.tcp.is_some() {
        // The mysql crate verifies the certificate against the address it
        // connects to — through a tunnel that would be 127.0.0.1. Fail closed;
        // the SSH tunnel already encrypts the traffic.
        return Err(EngineError::Tls(
            "TLS through an SSH tunnel is not supported for MySQL — disable SSL on \
             this profile (the tunnel already encrypts traffic)"
                .to_string(),
        ));
    }
    let (host, port) = match t.tcp {
        Some((ip, port)) => (ip.to_string(), port),
        None => (t.host.clone(), t.port),
    };
    let mut builder = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(host))
        .tcp_port(port)
        .db_name(Some(t.dbname.clone()))
        .tcp_connect_timeout(Some(Duration::from_secs(NET_CONNECT_TIMEOUT_SECS)));
    if !t.user.is_empty() {
        builder = builder.user(Some(t.user.clone()));
    }
    if let Some(pw) = &t.password {
        builder = builder.pass(Some(pw.clone()));
    }
    if t.ssl {
        // Default SslOpts = full certificate verification (no accept-invalid).
        builder = builder.ssl_opts(Some(mysql::SslOpts::default()));
    }
    Ok(mysql::Opts::from(builder))
}

fn mysql_connect(t: &NetTarget, read_only: bool) -> Result<mysql::Conn, EngineError> {
    use mysql::prelude::Queryable;
    let mut conn = mysql::Conn::new(mysql_opts(t)?)?;
    if read_only {
        conn.query_drop("SET SESSION TRANSACTION READ ONLY")?;
    }
    Ok(conn)
}

fn mysql_pool() -> &'static crate::pool::Pool<mysql::Conn> {
    static POOL: std::sync::OnceLock<crate::pool::Pool<mysql::Conn>> = std::sync::OnceLock::new();
    POOL.get_or_init(Default::default)
}

/// ER_QUERY_INTERRUPTED (KILL QUERY) / ER_QUERY_TIMEOUT (max_execution_time).
fn map_mysql_err(e: mysql::Error) -> EngineError {
    if let mysql::Error::MySqlError(inner) = &e {
        if inner.code == 1317 || inner.code == 3024 {
            return EngineError::Interrupted;
        }
    }
    EngineError::MySql(e)
}

/// Everything `cancel_query` needs to kill a running MySQL read.
pub struct MySqlCancel {
    pub conn_id: u32,
    pub opts: mysql::Opts,
}

/// Interrupt a running statement from a dedicated control connection.
pub fn mysql_kill(cancel: MySqlCancel) -> Result<(), EngineError> {
    use mysql::prelude::Queryable;
    let mut control = mysql::Conn::new(cancel.opts)?;
    control.query_drop(format!("KILL QUERY {}", cancel.conn_id))?;
    Ok(())
}

fn map_mysql_type(t: mysql::consts::ColumnType) -> &'static str {
    use mysql::consts::ColumnType as CT;
    match t {
        CT::MYSQL_TYPE_TINY | CT::MYSQL_TYPE_SHORT | CT::MYSQL_TYPE_INT24 | CT::MYSQL_TYPE_LONG => {
            "integer"
        }
        CT::MYSQL_TYPE_LONGLONG => "bigint",
        CT::MYSQL_TYPE_FLOAT
        | CT::MYSQL_TYPE_DOUBLE
        | CT::MYSQL_TYPE_DECIMAL
        | CT::MYSQL_TYPE_NEWDECIMAL => "numeric",
        CT::MYSQL_TYPE_DATE | CT::MYSQL_TYPE_NEWDATE => "date",
        CT::MYSQL_TYPE_TIMESTAMP
        | CT::MYSQL_TYPE_DATETIME
        | CT::MYSQL_TYPE_TIMESTAMP2
        | CT::MYSQL_TYPE_DATETIME2 => "timestamp",
        CT::MYSQL_TYPE_VARCHAR | CT::MYSQL_TYPE_VAR_STRING => "varchar",
        CT::MYSQL_TYPE_JSON => "json",
        _ => "text",
    }
}

fn mysql_value_to_json(v: mysql::Value) -> serde_json::Value {
    use mysql::Value as V;
    match v {
        V::NULL => serde_json::Value::Null,
        V::Bytes(b) => serde_json::Value::from(String::from_utf8_lossy(&b).to_string()),
        V::Int(i) => serde_json::Value::from(i),
        V::UInt(u) => serde_json::Value::from(u),
        V::Float(f) => serde_json::Value::from(f),
        V::Double(d) => serde_json::Value::from(d),
        V::Date(y, mo, d, 0, 0, 0, 0) => serde_json::Value::from(format!("{y:04}-{mo:02}-{d:02}")),
        V::Date(y, mo, d, h, mi, s, _) => {
            serde_json::Value::from(format!("{y:04}-{mo:02}-{d:02} {h:02}:{mi:02}:{s:02}"))
        }
        V::Time(neg, days, h, m, s, _) => {
            let sign = if neg { "-" } else { "" };
            serde_json::Value::from(format!(
                "{sign}{:02}:{m:02}:{s:02}",
                u32::from(h) + days * 24
            ))
        }
    }
}

pub fn mysql_test(t: &NetTarget) -> Result<f64, EngineError> {
    use mysql::prelude::Queryable;
    let start = std::time::Instant::now();
    let mut conn = mysql_connect(t, true)?;
    conn.query_drop("SELECT 1")?;
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

pub fn mysql_schema(t: &NetTarget, pool_key: &str) -> Result<Vec<TableSchema>, EngineError> {
    let mut lease = mysql_checkout(pool_key, t)?;
    let out = mysql_schema_on(lease.conn(), t);
    if out.is_err() {
        lease.destroy();
    }
    out
}

const MYSQL_DATABASES_SQL: &str = "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
     WHERE SCHEMA_NAME NOT IN ('information_schema','performance_schema','mysql','sys') \
     ORDER BY SCHEMA_NAME";

/// See [`pg_databases`] — same fail-open contract on the caller side.
pub fn mysql_databases(t: &NetTarget, pool_key: &str) -> Result<Vec<String>, EngineError> {
    use mysql::prelude::Queryable;
    let mut lease = mysql_checkout(pool_key, t)?;
    let out: Result<Vec<String>, _> = lease.conn().query(MYSQL_DATABASES_SQL);
    if out.is_err() {
        lease.destroy();
    }
    Ok(out?)
}

fn mysql_checkout<'a>(
    pool_key: &str,
    t: &NetTarget,
) -> Result<crate::pool::Lease<'a, mysql::Conn>, EngineError> {
    mysql_pool().checkout(
        pool_key,
        || mysql_connect(t, true),
        |c| c.ping().is_ok(),
        || EngineError::PoolTimeout,
    )
}

fn mysql_schema_on(conn: &mut mysql::Conn, t: &NetTarget) -> Result<Vec<TableSchema>, EngineError> {
    use mysql::prelude::Queryable;

    let mut fks: HashMap<(String, String), FkRef> = HashMap::new();
    let fk_rows: Vec<(String, String, String, String)> = conn.query(
        "SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL",
    )?;
    for (table, column, ref_table, ref_column) in fk_rows {
        fks.insert(
            (table, column),
            FkRef {
                table: ref_table,
                column: ref_column,
            },
        );
    }

    let mut indexes: HashMap<String, Vec<IndexSchema>> = HashMap::new();
    let idx_rows: Vec<(String, String, String, i64)> = conn.query(
        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE
         FROM information_schema.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    )?;
    for (table, index, column, non_unique) in idx_rows {
        let list = indexes.entry(table).or_default();
        match list.iter_mut().find(|i| i.name == index) {
            Some(existing) => existing.columns.push(column),
            None => list.push(IndexSchema {
                name: index,
                columns: vec![column],
                unique: non_unique == 0,
            }),
        }
    }

    let mut columns: HashMap<String, Vec<ColumnSchema>> = HashMap::new();
    let col_rows: Vec<(String, String, String, String, String, Option<String>)> = conn.query(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME, ORDINAL_POSITION",
    )?;
    for (table, name, data_type, is_nullable, column_key, default_value) in col_rows {
        let references = fks.get(&(table.clone(), name.clone())).map(|f| FkRef {
            table: f.table.clone(),
            column: f.column.clone(),
        });
        columns.entry(table).or_default().push(ColumnSchema {
            name,
            col_type: map_decl_type(&data_type).to_string(),
            nullable: is_nullable == "YES",
            primary_key: column_key == "PRI",
            default_value,
            references,
        });
    }

    let table_rows: Vec<(String, String, Option<i64>)> = conn.query(
        "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_NAME",
    )?;
    Ok(table_rows
        .into_iter()
        .map(|(name, table_type, row_count)| TableSchema {
            schema: t.dbname.clone(),
            kind: if table_type.contains("VIEW") {
                "view"
            } else {
                "table"
            }
            .to_string(),
            row_count: row_count.unwrap_or(-1),
            columns: columns.remove(&name).unwrap_or_default(),
            indexes: indexes.remove(&name).unwrap_or_default(),
            name,
        })
        .collect())
}

pub fn mysql_query(
    t: &NetTarget,
    pool_key: &str,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    on_cancel: impl FnOnce(MySqlCancel),
) -> Result<QueryResult, EngineError> {
    let mut lease = mysql_checkout(pool_key, t)?;
    let conn = lease.conn();
    on_cancel(MySqlCancel {
        conn_id: conn.connection_id(),
        opts: mysql_opts(t)?,
    });
    let out = mysql_query_on(conn, sql, limit, timeout_ms);
    if out.is_err() {
        lease.destroy();
    }
    out
}

fn mysql_query_on(
    conn: &mut mysql::Conn,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
) -> Result<QueryResult, EngineError> {
    use mysql::prelude::Queryable;
    let start = std::time::Instant::now();
    // Session settings persist on a pooled connection — always (re)set them.
    // SELECT-only server-side timeout; other read statements rely on caps.
    let _ = conn.query_drop(format!(
        "SET SESSION max_execution_time = {}",
        timeout_ms.unwrap_or(0)
    ));
    let effective_sql = crate::classifier::with_server_limit(sql, "mysql", limit + 1);
    let sql = effective_sql.as_deref().unwrap_or(sql);

    let mut result = conn.query_iter(sql).map_err(map_mysql_err)?;
    let columns: Vec<ColumnMeta> = result
        .columns()
        .as_ref()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name_str().to_string(),
            col_type: map_mysql_type(c.column_type()).to_string(),
        })
        .collect();
    let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
    let mut truncated = false;
    let mut bytes = 0usize;
    for row in result.by_ref() {
        let row = row.map_err(map_mysql_err)?;
        if rows_out.len() >= limit || bytes > READ_BYTE_CAP {
            truncated = true;
            continue;
        }
        let r: Vec<serde_json::Value> = row.unwrap().into_iter().map(mysql_value_to_json).collect();
        bytes += r.iter().map(json_value_size).sum::<usize>();
        rows_out.push(r);
    }

    Ok(QueryResult {
        columns,
        row_count: rows_out.len(),
        rows: rows_out,
        truncated,
        limit,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Write path — validation queue only, on a session WITHOUT the read-only
/// flag, outside the read pool.
pub fn mysql_execute(t: &NetTarget, sql: &str) -> Result<ExecResult, EngineError> {
    use mysql::prelude::Queryable;
    let mut conn = mysql_connect(t, false)?;
    let result = conn.query_iter(sql)?;
    Ok(ExecResult {
        affected_rows: usize::try_from(result.affected_rows()).unwrap_or(usize::MAX),
    })
}

// ---------------------------------------------------------------------------
// MS SQL (tiberius, async over a local current-thread runtime; pooled entries
// carry their runtime). No session read-only mode exists: reads are
// best-effort via the classifier only, and the badge stays "unknown" until
// the SEC-03 attack matrix runs in CI (Decisions §5). Timeout: `SET
// LOCK_TIMEOUT` + a client-side statement timeout. Cancellation: tiberius
// exposes no Attention signal, so cancel/timeout abandons the in-flight
// future and destroys the connection — the server aborts the query when the
// connection drops, and the result is reported as interrupted (the Decisions
// §10 fallback: uncertain state is destroyed, never reused).

fn mssql_runtime() -> Result<tokio::runtime::Runtime, EngineError> {
    Ok(tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?)
}

type MssqlClient = tiberius::Client<tokio_util::compat::Compat<tokio::net::TcpStream>>;

/// A pooled MS SQL connection with the current-thread runtime that drives it.
pub struct MssqlEntry {
    rt: tokio::runtime::Runtime,
    client: MssqlClient,
}

async fn mssql_connect(t: &NetTarget) -> Result<MssqlClient, EngineError> {
    use tokio_util::compat::TokioAsyncWriteCompatExt;
    let mut config = tiberius::Config::new();
    config.host(&t.host);
    config.port(t.port);
    config.database(&t.dbname);
    config.application_name("gatehouse");
    config.authentication(tiberius::AuthMethod::sql_server(
        &t.user,
        t.password.as_deref().unwrap_or(""),
    ));
    if t.ssl {
        config.encryption(tiberius::EncryptionLevel::Required);
    } else {
        config.encryption(tiberius::EncryptionLevel::NotSupported);
    }
    // TCP goes through the tunnel when set; `config.host` above still drives
    // TLS validation against the logical DB host.
    let addr = match t.tcp {
        Some((ip, port)) => std::net::SocketAddr::from((ip, port)).to_string(),
        None => config.get_addr(),
    };
    let tcp = tokio::time::timeout(
        Duration::from_secs(NET_CONNECT_TIMEOUT_SECS),
        tokio::net::TcpStream::connect(addr),
    )
    .await
    .map_err(|_| {
        EngineError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "connect timeout",
        ))
    })??;
    tcp.set_nodelay(true)?;
    Ok(tiberius::Client::connect(config, tcp.compat_write()).await?)
}

fn mssql_pool() -> &'static crate::pool::Pool<MssqlEntry> {
    static POOL: std::sync::OnceLock<crate::pool::Pool<MssqlEntry>> = std::sync::OnceLock::new();
    POOL.get_or_init(Default::default)
}

fn mssql_checkout<'a>(
    pool_key: &str,
    t: &NetTarget,
) -> Result<crate::pool::Lease<'a, MssqlEntry>, EngineError> {
    mssql_pool().checkout(
        pool_key,
        || {
            let rt = mssql_runtime()?;
            let client = rt.block_on(mssql_connect(t))?;
            Ok(MssqlEntry { rt, client })
        },
        |entry| {
            let MssqlEntry { rt, client } = entry;
            rt.block_on(async {
                match client.simple_query("SELECT 1").await {
                    Ok(stream) => stream.into_results().await.is_ok(),
                    Err(_) => false,
                }
            })
        },
        || EngineError::PoolTimeout,
    )
}

fn mssql_value_to_json(d: tiberius::ColumnData<'static>) -> serde_json::Value {
    use tiberius::ColumnData as C;
    fn opt<T: Into<serde_json::Value>>(v: Option<T>) -> serde_json::Value {
        v.map(Into::into).unwrap_or(serde_json::Value::Null)
    }
    match d {
        C::U8(v) => opt(v),
        C::I16(v) => opt(v),
        C::I32(v) => opt(v),
        C::I64(v) => opt(v),
        C::F32(v) => opt(v),
        C::F64(v) => opt(v),
        C::Bit(v) => opt(v),
        C::String(v) => opt(v.map(|s| s.to_string())),
        C::Guid(v) => opt(v.map(|g| g.to_string())),
        C::Numeric(v) => opt(v.map(|n| n.to_string())),
        C::Xml(v) => opt(v.map(|x| x.to_string())),
        C::Binary(_) => serde_json::Value::from("<binary>"),
        ref temporal @ (C::Date(_)
        | C::Time(_)
        | C::DateTime(_)
        | C::SmallDateTime(_)
        | C::DateTime2(_)
        | C::DateTimeOffset(_)) => {
            use tiberius::FromSql;
            if let Ok(Some(dt)) = chrono::NaiveDateTime::from_sql(temporal) {
                serde_json::Value::from(dt.format("%Y-%m-%d %H:%M:%S").to_string())
            } else if let Ok(Some(d)) = chrono::NaiveDate::from_sql(temporal) {
                serde_json::Value::from(d.format("%Y-%m-%d").to_string())
            } else if let Ok(Some(t)) = chrono::NaiveTime::from_sql(temporal) {
                serde_json::Value::from(t.format("%H:%M:%S").to_string())
            } else if let Ok(Some(dto)) = chrono::DateTime::<chrono::Utc>::from_sql(temporal) {
                serde_json::Value::from(dto.format("%Y-%m-%d %H:%M:%S%z").to_string())
            } else {
                serde_json::Value::Null
            }
        }
    }
}

fn map_mssql_type(t: tiberius::ColumnType) -> &'static str {
    use tiberius::ColumnType as CT;
    match t {
        CT::Int1 | CT::Int2 | CT::Int4 | CT::Intn => "integer",
        CT::Int8 => "bigint",
        CT::Bit | CT::Bitn => "boolean",
        CT::Float4
        | CT::Float8
        | CT::Floatn
        | CT::Decimaln
        | CT::Numericn
        | CT::Money
        | CT::Money4 => "numeric",
        CT::Daten => "date",
        CT::Datetime | CT::Datetime2 | CT::Datetime4 | CT::Datetimen | CT::DatetimeOffsetn => {
            "timestamp"
        }
        CT::Guid => "uuid",
        CT::BigVarChar | CT::NVarchar => "varchar",
        _ => "text",
    }
}

pub fn mssql_test(t: &NetTarget) -> Result<f64, EngineError> {
    let rt = mssql_runtime()?;
    let start = std::time::Instant::now();
    rt.block_on(async {
        let mut client = mssql_connect(t).await?;
        client
            .simple_query("SELECT 1")
            .await?
            .into_results()
            .await?;
        Ok::<_, EngineError>(())
    })?;
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

pub fn mssql_schema(t: &NetTarget, pool_key: &str) -> Result<Vec<TableSchema>, EngineError> {
    let mut lease = mssql_checkout(pool_key, t)?;
    let entry = lease.conn();
    let MssqlEntry { rt, client } = entry;
    let out = rt.block_on(mssql_schema_on(client));
    if out.is_err() {
        lease.destroy();
    }
    out
}

/// NOTE: `schema` must carry the SQL schema (`dbo`), never the database name —
/// the UI qualifies reads as `"<schema>"."<table>"`, and a two-part MS SQL name
/// is schema-qualified, so a database name there yields "Invalid object name".
async fn mssql_schema_on(client: &mut MssqlClient) -> Result<Vec<TableSchema>, EngineError> {
    {
        let text_rows = |sets: Vec<Vec<tiberius::Row>>| -> Vec<Vec<serde_json::Value>> {
            sets.into_iter()
                .flatten()
                .map(|row| row.into_iter().map(mssql_value_to_json).collect())
                .collect()
        };
        let cell = |r: &[serde_json::Value], i: usize| -> String {
            r.get(i)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };

        let mut fks: HashMap<(String, String, String), FkRef> = HashMap::new();
        for r in text_rows(
            client
                .simple_query(
                    "SELECT s.name, tp.name, cp.name, tr.name, cr.name
                     FROM sys.foreign_key_columns fkc
                     JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
                     JOIN sys.schemas s ON s.schema_id = tp.schema_id
                     JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
                     JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
                     JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id",
                )
                .await?
                .into_results()
                .await?,
        ) {
            fks.insert(
                (cell(&r, 0), cell(&r, 1), cell(&r, 2)),
                FkRef {
                    table: cell(&r, 3),
                    column: cell(&r, 4),
                },
            );
        }

        let mut pks: HashMap<(String, String), Vec<String>> = HashMap::new();
        for r in text_rows(
            client
                .simple_query(
                    "SELECT s.name, t.name, c.name
                     FROM sys.indexes i
                     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                     JOIN sys.tables t ON t.object_id = i.object_id
                     JOIN sys.schemas s ON s.schema_id = t.schema_id
                     WHERE i.is_primary_key = 1",
                )
                .await?
                .into_results()
                .await?,
        ) {
            pks.entry((cell(&r, 0), cell(&r, 1)))
                .or_default()
                .push(cell(&r, 2));
        }

        let mut columns: HashMap<(String, String), Vec<ColumnSchema>> = HashMap::new();
        for r in text_rows(
            client
                .simple_query(
                    "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
                     FROM INFORMATION_SCHEMA.COLUMNS
                     ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
                )
                .await?
                .into_results()
                .await?,
        ) {
            let schema = cell(&r, 0);
            let table = cell(&r, 1);
            let name = cell(&r, 2);
            let key = (schema, table);
            let primary_key = pks.get(&key).map(|c| c.contains(&name)).unwrap_or(false);
            let references = fks
                .get(&(key.0.clone(), key.1.clone(), name.clone()))
                .map(|f| FkRef {
                    table: f.table.clone(),
                    column: f.column.clone(),
                });
            let default_value = r.get(5).and_then(|v| v.as_str()).map(|s| s.to_string());
            columns.entry(key).or_default().push(ColumnSchema {
                name,
                col_type: map_decl_type(&cell(&r, 3)).to_string(),
                nullable: cell(&r, 4) == "YES",
                primary_key,
                default_value,
                references,
            });
        }

        let mut out = Vec::new();
        for r in text_rows(
            client
                .simple_query(
                    "SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
                     ORDER BY TABLE_SCHEMA, TABLE_NAME",
                )
                .await?
                .into_results()
                .await?,
        ) {
            let schema = cell(&r, 0);
            let name = cell(&r, 1);
            out.push(TableSchema {
                columns: columns.remove(&(schema.clone(), name.clone())).unwrap_or_default(),
                schema,
                kind: if cell(&r, 2).contains("VIEW") { "view" } else { "table" }.to_string(),
                row_count: -1,
                indexes: Vec::new(),
                name,
            });
        }
        Ok(out)
    }
}

/// `mode` selects a normal read or a `SHOWPLAN_ALL` plan capture — see
/// [`MssqlRead`]. Both share the pool, cancellation and timeout handling.
pub fn mssql_query(
    t: &NetTarget,
    pool_key: &str,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    mode: MssqlRead,
    on_cancel: impl FnOnce(tokio::sync::oneshot::Sender<()>),
) -> Result<QueryResult, EngineError> {
    let mut lease = mssql_checkout(pool_key, t)?;
    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
    on_cancel(cancel_tx);
    let entry = lease.conn();
    let MssqlEntry { rt, client } = entry;
    let out = rt.block_on(async {
        let work = mssql_query_on(client, sql, limit, timeout_ms, mode);
        tokio::pin!(work);
        let cancellable = async {
            tokio::select! {
                biased;
                r = &mut cancel_rx => match r {
                    Ok(()) => Err(EngineError::Interrupted),
                    // Sender dropped without firing: cancellation is not armed
                    // for this call (e.g. the MCP path) — just run the query.
                    Err(_) => work.await,
                },
                r = &mut work => r,
            }
        };
        // Client-side statement timeout: tiberius has no server-side one.
        match timeout_ms {
            Some(ms) => match tokio::time::timeout(Duration::from_millis(ms), cancellable).await {
                Ok(r) => r,
                Err(_) => Err(EngineError::Interrupted),
            },
            None => cancellable.await,
        }
    });
    // An abandoned in-flight future leaves the connection mid-protocol; any
    // error path destroys the connection (never reused in uncertain state).
    if out.is_err() {
        lease.destroy();
    }
    out
}

/// What an MS SQL read call should return.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MssqlRead {
    /// Execute the statement and return its rows.
    Rows,
    /// Compile the statement without executing it and return its estimated
    /// plan — MS SQL has no `EXPLAIN` keyword.
    Plan,
}

async fn mssql_query_on(
    client: &mut MssqlClient,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    mode: MssqlRead,
) -> Result<QueryResult, EngineError> {
    let start = std::time::Instant::now();
    {
        // Session settings persist on a pooled connection — always (re)set.
        let lock_timeout = timeout_ms.map(|ms| ms.to_string()).unwrap_or("-1".into());
        if let Ok(stream) = client
            .simple_query(format!("SET LOCK_TIMEOUT {lock_timeout}"))
            .await
        {
            let _ = stream.into_results().await;
        }
        // A row cap is a server-side TOP, which would change the very plan we
        // are asking for — never inject one when capturing a plan.
        let effective_sql = match mode {
            MssqlRead::Rows => crate::classifier::with_server_limit(sql, "mssql", limit + 1),
            MssqlRead::Plan => None,
        };
        let sql = effective_sql.as_deref().unwrap_or(sql);

        // SHOWPLAN_ALL must be its own batch, and it makes the session return
        // plans instead of results until switched off — so it is turned off
        // before returning. Any error below propagates, and the caller then
        // destroys the connection rather than pooling it still in plan mode.
        if mode == MssqlRead::Plan {
            client
                .simple_query("SET SHOWPLAN_ALL ON")
                .await?
                .into_results()
                .await?;
        }
        let sets = client.simple_query(sql).await?.into_results().await?;
        if mode == MssqlRead::Plan {
            client
                .simple_query("SET SHOWPLAN_ALL OFF")
                .await?
                .into_results()
                .await?;
        }
        let first = sets.into_iter().next().unwrap_or_default();
        let mut columns: Vec<ColumnMeta> = Vec::new();
        let mut rows_out: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut truncated = false;
        let mut bytes = 0usize;
        for row in first {
            if columns.is_empty() {
                columns = row
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        col_type: map_mssql_type(c.column_type()).to_string(),
                    })
                    .collect();
            }
            if rows_out.len() >= limit || bytes > READ_BYTE_CAP {
                truncated = true;
                continue;
            }
            let r: Vec<serde_json::Value> = row.into_iter().map(mssql_value_to_json).collect();
            bytes += r.iter().map(json_value_size).sum::<usize>();
            rows_out.push(r);
        }
        Ok(QueryResult {
            columns,
            row_count: rows_out.len(),
            rows: rows_out,
            truncated,
            limit,
            duration_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
}

/// Write path — validation queue only, outside the read pool. MS SQL has no
/// read-only session mode, so this is the same connection profile as reads
/// (classifier + human approval are the barrier here — Decisions §5 badge
/// stays "unknown").
pub fn mssql_execute(t: &NetTarget, sql: &str) -> Result<ExecResult, EngineError> {
    let rt = mssql_runtime()?;
    rt.block_on(async {
        let mut client = mssql_connect(t).await?;
        let result = client.execute(sql, &[]).await?;
        Ok(ExecResult {
            affected_rows: usize::try_from(result.total()).unwrap_or(usize::MAX),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("gatehouse_test_{name}.db"));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE customers (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email VARCHAR(120),
                active BOOLEAN DEFAULT 1
            );
            CREATE TABLE orders (
                id INTEGER PRIMARY KEY,
                customer_id INTEGER NOT NULL REFERENCES customers(id),
                total NUMERIC,
                created_at TIMESTAMP
            );
            CREATE INDEX idx_orders_customer ON orders(customer_id);
            CREATE VIEW active_customers AS SELECT * FROM customers WHERE active = 1;
            INSERT INTO customers (name, email) VALUES ('Ada', 'ada@x.io'), ('Linus', NULL);
            INSERT INTO orders (customer_id, total) VALUES (1, 42.5);",
        )
        .unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn function_allowlist_permits_common_and_blocks_rest() {
        let path = temp_db("fn_allowlist");
        let conn = open_sqlite_readonly(&path).unwrap();
        let upper: String = conn
            .query_row("SELECT upper(name) FROM customers WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(upper, "ADA");
        let agg: i64 = conn
            .query_row("SELECT count(*) FROM customers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(agg, 2);
        assert!(conn.prepare("SELECT load_extension('evil')").is_err());
    }

    #[test]
    fn schema_lists_tables_views_columns_fks() {
        let path = temp_db("schema");
        let schema = sqlite_schema(&path).unwrap();
        let names: Vec<_> = schema.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"customers"));
        assert!(names.contains(&"orders"));
        assert!(names.contains(&"active_customers"));

        let customers = schema.iter().find(|t| t.name == "customers").unwrap();
        assert_eq!(customers.kind, "table");
        assert_eq!(customers.row_count, 2);
        let id = customers.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.primary_key);
        assert_eq!(id.col_type, "integer");
        let email = customers
            .columns
            .iter()
            .find(|c| c.name == "email")
            .unwrap();
        assert_eq!(email.col_type, "varchar");
        assert!(email.nullable);

        let orders = schema.iter().find(|t| t.name == "orders").unwrap();
        let fk = orders
            .columns
            .iter()
            .find(|c| c.name == "customer_id")
            .unwrap();
        let refs = fk.references.as_ref().unwrap();
        assert_eq!(refs.table, "customers");
        assert!(orders
            .indexes
            .iter()
            .any(|i| i.name == "idx_orders_customer"));

        let view = schema
            .iter()
            .find(|t| t.name == "active_customers")
            .unwrap();
        assert_eq!(view.kind, "view");
        assert!(!view.columns.is_empty());
    }

    #[test]
    fn query_returns_typed_columns() {
        let path = temp_db("query");
        let res = sqlite_query(
            &path,
            "SELECT id, name, email FROM customers ORDER BY id",
            100,
            None,
            |_| {},
        )
        .unwrap();
        assert_eq!(res.row_count, 2);
        assert_eq!(res.columns[0].col_type, "integer");
        assert_eq!(res.columns[1].col_type, "text");
        assert_eq!(res.rows[1][2], serde_json::Value::Null);
    }

    #[test]
    fn readonly_connection_refuses_writes() {
        let path = temp_db("readonly");
        let conn = open_sqlite_readonly(&path).unwrap();
        assert!(conn.execute("DELETE FROM customers", []).is_err());
    }

    #[test]
    fn execute_runs_writes_and_counts_rows() {
        let path = temp_db("execute");
        let res = sqlite_execute(&path, "UPDATE customers SET active = 0 WHERE id = 1").unwrap();
        assert_eq!(res.affected_rows, 1);
        let check = sqlite_query(
            &path,
            "SELECT active FROM customers WHERE id = 1",
            10,
            None,
            |_| {},
        )
        .unwrap();
        assert_eq!(check.rows[0][0], serde_json::Value::from(0));

        let ins = sqlite_execute(&path, "INSERT INTO customers (name) VALUES ('Grace')").unwrap();
        assert_eq!(ins.affected_rows, 1);
    }

    const SLOW_QUERY: &str =
        "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";

    #[test]
    fn byte_cap_truncates_large_results() {
        let path = temp_db("byte_cap");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE big (chunk TEXT)").unwrap();
            let chunk = "x".repeat(1024 * 1024);
            for _ in 0..8 {
                conn.execute("INSERT INTO big (chunk) VALUES (?1)", [&chunk])
                    .unwrap();
            }
        }
        let res = sqlite_query(&path, "SELECT chunk FROM big", 100, None, |_| {}).unwrap();
        assert!(res.truncated);
        assert!(res.row_count < 8);
        assert!(res.row_count >= 1);
    }

    #[test]
    fn statement_timeout_interrupts_runaway_query() {
        let path = temp_db("timeout");
        let err = sqlite_query(&path, SLOW_QUERY, 10, Some(100), |_| {}).unwrap_err();
        assert!(matches!(err, EngineError::Interrupted), "got: {err}");
    }

    #[test]
    fn interrupt_handle_cancels_running_query() {
        let path = temp_db("cancel");
        let (tx, rx) = std::sync::mpsc::channel::<rusqlite::InterruptHandle>();
        std::thread::spawn(move || {
            let handle = rx.recv().unwrap();
            std::thread::sleep(Duration::from_millis(100));
            handle.interrupt();
        });
        let err = sqlite_query(&path, SLOW_QUERY, 10, None, |h| tx.send(h).unwrap()).unwrap_err();
        assert!(matches!(err, EngineError::Interrupted), "got: {err}");
    }

    #[test]
    fn test_connection_measures_latency() {
        let path = temp_db("latency");
        assert!(sqlite_test(&path).is_ok());
        assert!(sqlite_test("/nonexistent/nope.db").is_err());
    }

    // NOTE: the pg_* tests need a local Postgres with the gatehouse_pg_test
    // database (see docs/GoLive.md chantier 7). Run: cargo test -- --ignored
    fn pg_test_target() -> NetTarget {
        NetTarget {
            host: "127.0.0.1".to_string(),
            port: 5432,
            user: String::new(),
            dbname: "gatehouse_pg_test".to_string(),
            password: None,
            ssl: false,
            tcp: None,
        }
    }

    #[test]
    #[ignore = "needs a local postgres server"]
    fn pg_schema_lists_tables_views_columns_fks() {
        let schema = pg_schema(&pg_test_target(), "pg_test|schema").unwrap();
        let customers = schema
            .iter()
            .find(|t| t.name == "customers" && t.schema == "public")
            .unwrap();
        assert_eq!(customers.kind, "table");
        let id = customers.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.primary_key);
        assert_eq!(id.col_type, "integer");
        let email = customers
            .columns
            .iter()
            .find(|c| c.name == "email")
            .unwrap();
        assert_eq!(email.col_type, "varchar");
        assert!(email.nullable);

        let orders = schema.iter().find(|t| t.name == "orders").unwrap();
        let fk = orders
            .columns
            .iter()
            .find(|c| c.name == "customer_id")
            .unwrap();
        assert_eq!(fk.references.as_ref().unwrap().table, "customers");
        assert!(orders
            .indexes
            .iter()
            .any(|i| i.name == "idx_orders_customer"));

        let view = schema
            .iter()
            .find(|t| t.name == "active_customers")
            .unwrap();
        assert_eq!(view.kind, "view");
    }

    #[test]
    #[ignore = "needs a local postgres server"]
    fn pg_query_returns_typed_text_values() {
        let res = pg_query(
            &pg_test_target(),
            "pg_test|query",
            "SELECT id, name, email FROM customers ORDER BY id",
            100,
            None,
            |_| {},
        )
        .unwrap();
        assert_eq!(res.row_count, 2);
        assert_eq!(res.columns[0].col_type, "integer");
        assert_eq!(res.columns[1].col_type, "text");
        assert_eq!(res.rows[0][1], serde_json::Value::from("Ada"));
        assert_eq!(res.rows[1][2], serde_json::Value::Null);
    }

    #[test]
    #[ignore = "needs a local postgres server"]
    fn pg_readonly_session_refuses_writes() {
        let err = {
            let mut client = pg_connect(&pg_test_target(), true).unwrap();
            client.simple_query("DELETE FROM orders")
        };
        assert!(err.is_err());
    }

    #[test]
    #[ignore = "needs a local postgres server"]
    fn pg_execute_runs_writes_and_counts_rows() {
        let t = pg_test_target();
        let res = pg_execute(
            &t,
            "UPDATE customers SET active = false WHERE name = 'Linus'",
        )
        .unwrap();
        assert_eq!(res.affected_rows, 1);
        let back = pg_execute(
            &t,
            "UPDATE customers SET active = true WHERE name = 'Linus'",
        )
        .unwrap();
        assert_eq!(back.affected_rows, 1);
    }

    #[test]
    #[ignore = "needs a local postgres server"]
    fn pg_test_connection_measures_latency() {
        assert!(pg_test(&pg_test_target()).is_ok());
        let mut bad = pg_test_target();
        bad.port = 59999;
        assert!(pg_test(&bad).is_err());
    }

    // NOTE: the mysql_* tests need a reachable MySQL with credentials in
    // GATEHOUSE_MYSQL_USER / GATEHOUSE_MYSQL_PASSWORD / GATEHOUSE_MYSQL_DB
    // (the database must contain a `customers` table). Run with `-- --ignored`.
    fn mysql_test_target() -> NetTarget {
        NetTarget {
            host: "127.0.0.1".to_string(),
            port: 3306,
            user: std::env::var("GATEHOUSE_MYSQL_USER").unwrap_or_else(|_| "root".into()),
            dbname: std::env::var("GATEHOUSE_MYSQL_DB")
                .unwrap_or_else(|_| "gatehouse_mysql_test".into()),
            password: std::env::var("GATEHOUSE_MYSQL_PASSWORD").ok(),
            ssl: false,
            tcp: None,
        }
    }

    #[test]
    #[ignore = "needs a local mysql server (see GATEHOUSE_MYSQL_* env vars)"]
    fn mysql_readonly_session_refuses_writes() {
        let mut conn = mysql_connect(&mysql_test_target(), true).unwrap();
        use mysql::prelude::Queryable;
        assert!(conn.query_drop("DELETE FROM customers").is_err());
    }

    #[test]
    #[ignore = "needs a local mysql server (see GATEHOUSE_MYSQL_* env vars)"]
    fn mysql_query_and_schema_roundtrip() {
        let t = mysql_test_target();
        let res = mysql_query(
            &t,
            "mysql_test|query",
            "SELECT 1 AS one, NULL AS nothing",
            10,
            Some(30_000),
            |_| {},
        )
        .unwrap();
        assert_eq!(res.row_count, 1);
        assert_eq!(res.rows[0][0], serde_json::Value::from(1i64));
        assert_eq!(res.rows[0][1], serde_json::Value::Null);
        let schema = mysql_schema(&t, "mysql_test|schema").unwrap();
        assert!(schema.iter().any(|tb| tb.name == "customers"));
    }

    #[test]
    #[ignore = "needs a local mysql server (see GATEHOUSE_MYSQL_* env vars)"]
    fn mysql_kill_interrupts_running_query() {
        let t = mysql_test_target();
        let (tx, rx) = std::sync::mpsc::channel::<MySqlCancel>();
        std::thread::spawn(move || {
            let cancel = rx.recv().unwrap();
            std::thread::sleep(Duration::from_millis(200));
            mysql_kill(cancel).unwrap();
        });
        let err = mysql_query(&t, "mysql_test|kill", "SELECT SLEEP(30)", 10, None, |c| {
            tx.send(c).unwrap()
        })
        .unwrap_err();
        assert!(matches!(err, EngineError::Interrupted), "got: {err}");
    }
}
