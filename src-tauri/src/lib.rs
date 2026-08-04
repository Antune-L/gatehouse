mod audit;
mod classifier;
mod crypto;
mod engine;
mod mcp;
mod pool;
mod queue;
mod store;
mod tunnel;

use classifier::Classification;
use engine::{ExecResult, QueryResult, TableSchema};
use queue::WriteRequest;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use store::{Profile, Store};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager, State};

/// Live read statements, keyed by the frontend-issued query id, so a separate
/// `cancel_query` invocation can interrupt them mid-flight.
enum ActiveQuery {
    Sqlite(rusqlite::InterruptHandle),
    Pg(postgres::CancelToken, bool),
    MySql(engine::MySqlCancel),
    MsSql(tokio::sync::oneshot::Sender<()>),
}

type QueryRegistry = Arc<Mutex<HashMap<String, ActiveQuery>>>;

/// Lazily-opened audit trail: opening touches the Keychain (subkeys + anchor),
/// and dev builds are ad-hoc signed — eager opening would prompt at every
/// launch. First audited event or Settings visit pays the cost instead.
pub struct AuditHandle(Mutex<Option<Arc<audit::Audit>>>);

impl AuditHandle {
    fn lazy() -> Self {
        Self(Mutex::new(None))
    }

    #[cfg(test)]
    fn preset(a: audit::Audit) -> Self {
        Self(Mutex::new(Some(Arc::new(a))))
    }

    fn get(&self) -> Result<Arc<audit::Audit>, String> {
        let mut guard = self.0.lock().unwrap();
        if let Some(a) = &*guard {
            return Ok(a.clone());
        }
        let a = Arc::new(audit::Audit::open().map_err(|e| e.to_string())?);
        *guard = Some(a.clone());
        Ok(a)
    }
}

pub struct AppState {
    // Arc so blocking closures (engine work, SSH tunnels) can hold the store
    // without borrowing the managed state.
    store: Arc<Store>,
    queue: queue::Queue,
    queries: QueryRegistry,
    audit: AuditHandle,
}

/// Append an audit event. Human-origin operations survive an unavailable
/// audit trail (stderr warning); agent-origin operations are refused —
/// the product promise is that agent activity is always audited (SEC-12).
fn audit_log(
    state: &AppState,
    origin: &str,
    profile_id: &str,
    profile_name: &str,
    action: &str,
    detail: &str,
    outcome: &str,
) -> Result<(), String> {
    let appended = state.audit.get().and_then(|a| {
        a.append(audit::AuditEvent {
            origin,
            profile_id,
            profile_name,
            action,
            detail,
            outcome,
        })
        .map_err(|e| e.to_string())
    });
    match appended {
        Ok(_) => Ok(()),
        Err(e) if origin != "human-ui" => Err(format!(
            "audit trail unavailable — agent operation refused (SEC-12): {e}"
        )),
        Err(e) => {
            eprintln!("[gatehouse] audit append failed (human path continues): {e}");
            Ok(())
        }
    }
}

/// SQL is encrypted at rest in the audit record, but still cap what we store.
fn audit_detail(sql: &str) -> String {
    const MAX: usize = 500;
    if sql.len() > MAX {
        let mut end = MAX;
        while !sql.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &sql[..end])
    } else {
        sql.to_string()
    }
}

/// Expand a leading `~` so profiles can store portable paths.
fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

/// SQLite's `EXPLAIN [QUERY PLAN]` prefix is not standard SQL — strip it so the
/// classifier judges the underlying statement (plain EXPLAIN never executes).
fn strip_sqlite_explain(sql: &str) -> &str {
    fn strip_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
        s.get(..prefix.len())
            .filter(|head| head.eq_ignore_ascii_case(prefix))
            .map(|_| &s[prefix.len()..])
    }
    let t = sql.trim_start();
    if let Some(rest) = strip_ci(t, "EXPLAIN QUERY PLAN ") {
        return rest;
    }
    if strip_ci(t, "EXPLAIN ANALYZE").is_none() {
        if let Some(rest) = strip_ci(t, "EXPLAIN ") {
            return rest;
        }
    }
    t
}

#[tauri::command]
fn classify_sql(sql: String, engine: String) -> Classification {
    classifier::classify(&sql, &engine)
}

#[tauri::command]
fn list_profiles(state: State<AppState>) -> Result<Vec<Profile>, String> {
    state.store.list().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_profile(
    state: State<AppState>,
    profile: Profile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<(), String> {
    state
        .store
        .upsert(&profile, password.as_deref(), ssh_secret.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_profile(state: State<AppState>, id: String) -> Result<(), String> {
    state.store.delete(&id).map_err(|e| e.to_string())
}

fn find_profile(profiles: &[Profile], id: &str) -> Result<Profile, String> {
    profiles
        .iter()
        .find(|p| p.id == id)
        .cloned()
        .ok_or_else(|| "unknown profile".to_string())
}

const NETWORK_ENGINES: [&str; 3] = ["postgres", "mysql", "mssql"];

/// Fail-closed guard: stored options with no implementation behind them must
/// refuse to connect rather than silently ignore the setting.
fn ensure_profile_supported(p: &Profile) -> Result<(), String> {
    if p.ssh_tunnel {
        if !NETWORK_ENGINES.contains(&p.engine.as_str()) {
            return Err("SSH tunnel is not applicable to this engine".into());
        }
        if p.ssh_host.trim().is_empty() || p.ssh_user.trim().is_empty() {
            return Err("SSH tunnel is enabled but the SSH host or user is missing".into());
        }
    }
    Ok(())
}

/// Errors (Keychain denied, key mismatch) must reach the caller: silently
/// connecting without the stored password yields a misleading auth failure.
fn password_for(store: &Store, p: &Profile) -> Result<Option<String>, String> {
    if NETWORK_ENGINES.contains(&p.engine.as_str()) {
        store.password(&p.id).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}

/// Resolve a profile into a connectable target: stored password + SSH tunnel
/// when enabled (`tcp` then points at the tunnel's local end). Blocking
/// (Keychain, SSH handshake) — only call inside spawn_blocking.
fn resolve_net_target(
    store: &Store,
    p: &Profile,
    password_override: Option<String>,
    ssh_secret_override: Option<String>,
) -> Result<engine::NetTarget, String> {
    let password = match password_override {
        Some(pw) if !pw.is_empty() => Some(pw),
        _ => password_for(store, p)?,
    };
    let mut target = engine::NetTarget {
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        dbname: p.database.clone(),
        password,
        ssl: p.ssl,
        tcp: None,
    };
    if p.ssh_tunnel {
        let local_port = tunnel::ensure(
            store,
            &p.id,
            &p.ssh_host,
            p.ssh_port,
            &p.ssh_user,
            &p.ssh_key_path,
            ssh_secret_override,
            &p.host,
            p.port,
        )?;
        target.tcp = Some((
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            local_port,
        ));
    }
    Ok(target)
}

/// Resolve a read target, optionally pointing at another database of the same
/// server than the profile's default (the sidebar database selector). Only the
/// dbname moves: host/port/user/tls — and therefore the credential AAD
/// (crypto::target_aad, Decisions §10) — are untouched, so decryption is
/// unaffected. Writes never take this path: an approval is bound to
/// `profile.database` (SEC-05, Decisions §5).
fn resolve_read_target(
    store: &Store,
    p: &Profile,
    database: Option<&str>,
) -> Result<engine::NetTarget, String> {
    let mut t = resolve_net_target(store, p, None, None)?;
    if let Some(db) = database.map(str::trim).filter(|d| !d.is_empty()) {
        t.dbname = db.to_string();
    }
    Ok(t)
}

fn engine_schema(
    store: &Store,
    p: &Profile,
    database: Option<&str>,
) -> Result<Vec<TableSchema>, String> {
    if p.engine == "sqlite" {
        return engine::sqlite_schema(&expand_home(&p.database)).map_err(|e| e.to_string());
    }
    let t = resolve_read_target(store, p, database)?;
    let key = engine::pool_key(&p.id, &t);
    match p.engine.as_str() {
        "postgres" => engine::pg_schema(&t, &key),
        "mysql" => engine::mysql_schema(&t, &key),
        "mssql" => engine::mssql_schema(&t, &key),
        other => Err(engine::EngineError::NotImplemented(other.to_string())),
    }
    .map_err(|e| e.to_string())
}

/// Databases selectable for this profile. Fail-open by design: enumeration is
/// a convenience, so an unsupported engine or a refused catalog read degrades
/// to the connected database instead of failing the schema load.
fn engine_databases(store: &Store, p: &Profile, current: &str) -> Vec<String> {
    let only_current = || vec![current.to_string()];
    if p.engine == "sqlite" {
        return only_current();
    }
    let Ok(t) = resolve_read_target(store, p, Some(current)) else {
        return only_current();
    };
    let key = engine::pool_key(&p.id, &t);
    let listed = match p.engine.as_str() {
        "postgres" => engine::pg_databases(&t, &key).ok(),
        "mysql" => engine::mysql_databases(&t, &key).ok(),
        _ => None,
    };
    match listed {
        Some(dbs) if dbs.iter().any(|d| d == current) => dbs,
        Some(dbs) if !dbs.is_empty() => [only_current(), dbs].concat(),
        _ => only_current(),
    }
}

fn engine_read_query(
    store: &Store,
    p: &Profile,
    database: Option<&str>,
    sql: &str,
    limit: usize,
    timeout_ms: Option<u64>,
    register: impl FnOnce(ActiveQuery),
) -> Result<QueryResult, String> {
    if p.engine == "sqlite" {
        return engine::sqlite_query(&expand_home(&p.database), sql, limit, timeout_ms, |h| {
            register(ActiveQuery::Sqlite(h))
        })
        .map_err(|e| e.to_string());
    }
    let t = resolve_read_target(store, p, database)?;
    let key = engine::pool_key(&p.id, &t);
    match p.engine.as_str() {
        "postgres" => {
            let ssl = p.ssl;
            engine::pg_query(&t, &key, sql, limit, timeout_ms, |token| {
                register(ActiveQuery::Pg(token, ssl))
            })
        }
        "mysql" => engine::mysql_query(&t, &key, sql, limit, timeout_ms, |cancel| {
            register(ActiveQuery::MySql(cancel))
        }),
        "mssql" => engine::mssql_query(
            &t,
            &key,
            sql,
            limit,
            timeout_ms,
            engine::MssqlRead::Rows,
            |tx| register(ActiveQuery::MsSql(tx)),
        ),
        other => Err(engine::EngineError::NotImplemented(other.to_string())),
    }
    .map_err(|e| e.to_string())
}

/// Every engine spells "show me the plan" differently, and MS SQL has no
/// `EXPLAIN` keyword at all — it needs a session setting around its own batch.
/// Keeping that here lets the frontend send bare SQL.
fn engine_explain_query(
    store: &Store,
    p: &Profile,
    database: Option<&str>,
    sql: &str,
) -> Result<QueryResult, String> {
    const EXPLAIN_LIMIT: usize = 500;
    if p.engine == "sqlite" {
        let prefixed = format!("EXPLAIN QUERY PLAN {sql}");
        return engine::sqlite_query(
            &expand_home(&p.database),
            &prefixed,
            EXPLAIN_LIMIT,
            None,
            |_| {},
        )
        .map_err(|e| e.to_string());
    }
    let t = resolve_read_target(store, p, database)?;
    let key = engine::pool_key(&p.id, &t);
    match p.engine.as_str() {
        "postgres" => engine::pg_query(
            &t,
            &key,
            &format!("EXPLAIN {sql}"),
            EXPLAIN_LIMIT,
            None,
            |_| {},
        ),
        "mysql" => engine::mysql_query(
            &t,
            &key,
            &format!("EXPLAIN {sql}"),
            EXPLAIN_LIMIT,
            None,
            |_| {},
        ),
        "mssql" => engine::mssql_query(
            &t,
            &key,
            sql,
            EXPLAIN_LIMIT,
            None,
            engine::MssqlRead::Plan,
            |_| {},
        ),
        other => Err(engine::EngineError::NotImplemented(other.to_string())),
    }
    .map_err(|e| e.to_string())
}

fn engine_execute(store: &Store, p: &Profile, sql: &str) -> Result<ExecResult, String> {
    if p.engine == "sqlite" {
        return engine::sqlite_execute(&expand_home(&p.database), sql).map_err(|e| e.to_string());
    }
    let t = resolve_net_target(store, p, None, None)?;
    match p.engine.as_str() {
        "postgres" => engine::pg_execute(&t, sql),
        "mysql" => engine::mysql_execute(&t, sql),
        "mssql" => engine::mssql_execute(&t, sql),
        other => Err(engine::EngineError::NotImplemented(other.to_string())),
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn sqlite_list_tables(path: String) -> Result<Vec<String>, String> {
    engine::sqlite_tables(&expand_home(&path)).map_err(|e| e.to_string())
}

/// Schema of one database plus the databases the profile can switch to
/// (sidebar selector). `database` overrides the profile's default; the read
/// stays on the engine's read-only path.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SchemaPayload {
    database: String,
    databases: Vec<String>,
    tables: Vec<TableSchema>,
}

/// Async + spawn_blocking: schema loads open network connections and may
/// trigger a blocking Keychain prompt — neither may run on the main thread.
#[tauri::command]
async fn get_schema(
    state: State<'_, AppState>,
    profile_id: String,
    database: Option<String>,
) -> Result<SchemaPayload, String> {
    let profiles = state.store.list().map_err(|e| e.to_string())?;
    let p = find_profile(&profiles, &profile_id)?;
    ensure_profile_supported(&p)?;
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let current = match database.as_deref().map(str::trim) {
            Some(db) if !db.is_empty() && p.engine != "sqlite" => db.to_string(),
            _ => p.database.clone(),
        };
        let tables = engine_schema(&store, &p, Some(&current))?;
        let databases = engine_databases(&store, &p, &current);
        Ok(SchemaPayload {
            database: current,
            databases,
            tables,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Test connectivity with a transient profile (the form's current values, not
/// necessarily saved yet). Falls back to the stored password when none is
/// provided, so testing a saved profile does not require retyping it.
#[tauri::command]
async fn test_connection(
    state: State<'_, AppState>,
    profile: Profile,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> Result<f64, String> {
    ensure_profile_supported(&profile)?;
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if profile.engine == "sqlite" {
            return engine::sqlite_test(&expand_home(&profile.database)).map_err(|e| e.to_string());
        }
        let t = resolve_net_target(&store, &profile, password, ssh_secret)?;
        match profile.engine.as_str() {
            "postgres" => engine::pg_test(&t).map_err(|e| e.to_string()),
            "mysql" => engine::mysql_test(&t).map_err(|e| e.to_string()),
            "mssql" => engine::mssql_test(&t).map_err(|e| e.to_string()),
            other => Err(format!("engine `{other}` is not yet wired")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Run a read statement on the profile's engine. Writes are refused here —
/// they must go through `request_write` and the validation queue (Decisions
/// §4, §7). Credentials are resolved backend-side and never cross IPC.
/// Async + spawn_blocking so long reads never block the main thread and a
/// concurrent `cancel_query` can interrupt them.
#[tauri::command]
async fn run_query(
    state: State<'_, AppState>,
    profile_id: String,
    sql: String,
    limit: usize,
    query_id: Option<String>,
    timeout_ms: Option<u64>,
    database: Option<String>,
) -> Result<QueryResult, String> {
    let profiles = state.store.list().map_err(|e| e.to_string())?;
    let p = find_profile(&profiles, &profile_id)?;
    let to_classify = if p.engine == "sqlite" {
        strip_sqlite_explain(&sql)
    } else {
        &sql
    };
    let c = classifier::classify(to_classify, &p.engine);
    if c.is_write {
        return Err(format!(
            "Refused: {} — writes must go through the validation queue",
            c.reason
        ));
    }
    ensure_profile_supported(&p)?;
    let store = state.store.clone();
    let registry = state.queries.clone();
    let reg_id = query_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let register = |q: ActiveQuery| {
            if let Some(id) = &reg_id {
                registry.lock().unwrap().insert(id.clone(), q);
            }
        };
        engine_read_query(&store, &p, database.as_deref(), &sql, limit, timeout_ms, register)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(id) = &query_id {
        state.queries.lock().unwrap().remove(id);
    }
    result
}

/// Return the query plan for a read statement. Takes bare SQL — the per-engine
/// explain syntax is applied backend-side. Writes are refused as in `run_query`:
/// a plan is never worth executing a statement the queue has not approved.
#[tauri::command]
async fn explain_query(
    state: State<'_, AppState>,
    profile_id: String,
    sql: String,
    database: Option<String>,
) -> Result<QueryResult, String> {
    let profiles = state.store.list().map_err(|e| e.to_string())?;
    let p = find_profile(&profiles, &profile_id)?;
    let c = classifier::classify(&sql, &p.engine);
    if c.is_write {
        return Err(format!(
            "Refused: {} — writes must go through the validation queue",
            c.reason
        ));
    }
    ensure_profile_supported(&p)?;
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        engine_explain_query(&store, &p, database.as_deref(), &sql)
    })
        .await
        .map_err(|e| e.to_string())?
}

/// Interrupt a read statement previously started with a `query_id`.
/// Async: the MySQL path opens a control connection (network) for KILL QUERY.
#[tauri::command]
async fn cancel_query(state: State<'_, AppState>, query_id: String) -> Result<(), String> {
    let entry = state.queries.lock().unwrap().remove(&query_id);
    match entry {
        Some(ActiveQuery::Sqlite(handle)) => {
            handle.interrupt();
            Ok(())
        }
        Some(ActiveQuery::Pg(token, ssl)) => tauri::async_runtime::spawn_blocking(move || {
            if ssl {
                token
                    .cancel_query(engine::pg_tls().map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())
            } else {
                token
                    .cancel_query(postgres::NoTls)
                    .map_err(|e| e.to_string())
            }
        })
        .await
        .map_err(|e| e.to_string())?,
        Some(ActiveQuery::MySql(cancel)) => tauri::async_runtime::spawn_blocking(move || {
            engine::mysql_kill(cancel).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?,
        Some(ActiveQuery::MsSql(tx)) => {
            let _ = tx.send(());
            Ok(())
        }
        None => Ok(()),
    }
}

/// Write path: classify, then enqueue for human approval. Agent callers only
/// ever receive a request id + status (Decisions §10); agent access to the
/// Pre-flight check at staging time: parse/plan the statement server-side
/// without ever executing it, so a doomed write fails when the user clicks
/// "Review" instead of after human approval.
fn validate_write_sql(store: &Store, p: &Profile, sql: &str) -> Result<(), String> {
    match p.engine.as_str() {
        "sqlite" => {
            engine::sqlite_validate(&expand_home(&p.database), sql).map_err(|e| e.to_string())
        }
        "postgres" => {
            let t = resolve_read_target(store, p, None)?;
            let key = engine::pool_key(&p.id, &t);
            engine::pg_validate(&t, &key, sql).map_err(|e| e.to_string())
        }
        // TODO(ali): no parse-only validation path wired for mysql/mssql yet.
        _ => Ok(()),
    }
}

/// profile must be explicitly enabled.
#[tauri::command]
fn request_write(
    state: State<AppState>,
    origin: String,
    profile_id: String,
    database: String,
    sql: String,
) -> Result<WriteRequest, String> {
    let profiles = state.store.list().map_err(|e| e.to_string())?;
    let profile = find_profile(&profiles, &profile_id)?;
    if origin != "human-ui" && !profile.agent_access {
        return Err("agent access is disabled for this profile".into());
    }
    // SEC-05: approvals execute against `profile.database`. The sidebar can
    // point reads at another database of the same server, but a write staged
    // from there would target the wrong one — refuse at staging time rather
    // than let the approval fail (or worse, succeed elsewhere).
    if database != profile.database {
        return Err(
            "writes must target the profile's database — switch the database selector back (SEC-05)"
                .into(),
        );
    }
    let c = classifier::classify(&sql, &profile.engine);
    if !c.is_write {
        return Err("This statement is read-only — run it directly via `query`.".into());
    }
    validate_write_sql(&state.store, &profile, &sql)?;
    let kind = format!("{:?}", c.kind).to_lowercase();
    audit_log(
        &state,
        &origin,
        &profile.id,
        &profile.name,
        &format!("request_write · {kind}"),
        &audit_detail(&sql),
        "pending",
    )?;
    Ok(state
        .queue
        .enqueue(&origin, &profile_id, &database, &sql, &kind))
}

#[tauri::command]
fn queue_list(state: State<AppState>) -> Vec<WriteRequest> {
    state.queue.list()
}

#[tauri::command]
fn queue_resolve(
    state: State<AppState>,
    id: String,
    approve: bool,
) -> Result<WriteRequest, String> {
    let req = state
        .queue
        .list()
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| "unknown request".to_string())?;
    let profile_name = profile_name_of(&state, &req.profile_id);
    // Audited before the status flips: approving an agent request while the
    // audit trail is down must fail closed; a rejection is always allowed.
    let logged = audit_log(
        &state,
        &req.origin,
        &req.profile_id,
        &profile_name,
        &format!("queue_resolve · {}", req.statement_kind),
        &audit_detail(&req.sql),
        if approve { "approved" } else { "rejected" },
    );
    if approve {
        logged?;
    }
    state
        .queue
        .resolve(&id, approve)
        .ok_or_else(|| "unknown request".into())
}

fn profile_name_of(state: &AppState, profile_id: &str) -> String {
    state
        .store
        .list()
        .unwrap_or_default()
        .iter()
        .find(|p| p.id == profile_id)
        .map(|p| p.name.clone())
        .unwrap_or_default()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveOutcome {
    request: WriteRequest,
    result: ExecResult,
}

/// Human approval that actually executes: consume the single-use approval,
/// re-classify (defense in depth), run the write, report real affected rows.
/// Async + spawn_blocking: the write is a network/disk operation and may
/// trigger a blocking Keychain prompt — neither may run on the main thread.
#[tauri::command]
async fn queue_approve_execute(
    state: State<'_, AppState>,
    id: String,
) -> Result<ApproveOutcome, String> {
    let profiles = state.store.list().map_err(|e| e.to_string())?;
    // Fail closed before consuming the approval: an agent-originated write may
    // not execute while the audit trail is unavailable (SEC-12).
    if let Some(pending) = state.queue.list().into_iter().find(|r| r.id == id) {
        if pending.origin != "human-ui" {
            let available = state.audit.get().map(|a| a.is_valid()).unwrap_or(false);
            if !available {
                return Err(
                    "audit trail unavailable — agent write execution refused (SEC-12)".into(),
                );
            }
        }
    }
    let req = state.queue.consume_for_execution(&id)?;
    let profile = profiles
        .iter()
        .find(|p| p.id == req.profile_id)
        .ok_or_else(|| {
            state.queue.mark_failed(&id);
            "unknown profile".to_string()
        })?;
    // SEC-05: the approval targeted a specific database; refuse if the profile
    // was repointed between staging and approval.
    if profile.database != req.database {
        state.queue.mark_failed(&id);
        return Err("approval target no longer matches the profile database (SEC-05)".into());
    }
    let c = classifier::classify(&req.sql, &profile.engine);
    if !c.is_write {
        state.queue.mark_failed(&id);
        return Err("approved statement no longer classifies as a write".into());
    }
    if let Err(e) = ensure_profile_supported(profile) {
        state.queue.mark_failed(&id);
        return Err(e);
    }
    let exec_profile = profile.clone();
    let sql = req.sql.clone();
    let store = state.store.clone();
    let executed =
        tauri::async_runtime::spawn_blocking(move || engine_execute(&store, &exec_profile, &sql))
            .await
            .map_err(|e| e.to_string())?;
    let outcome = if executed.is_ok() {
        "executed"
    } else {
        "failed"
    };
    let _ = audit_log(
        &state,
        &req.origin,
        &req.profile_id,
        &profile.name,
        &format!("execute · {}", req.statement_kind),
        &audit_detail(&req.sql),
        outcome,
    );
    match executed {
        Ok(result) => Ok(ApproveOutcome {
            request: req,
            result,
        }),
        Err(e) => {
            state.queue.mark_failed(&id);
            Err(e.to_string())
        }
    }
}

#[tauri::command]
fn mcp_tool_schemas() -> serde_json::Value {
    mcp::tool_schemas()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpPairOutcome {
    client: store::McpClientRow,
    /// Shown exactly once — only the hash is stored (Decisions §13).
    token: String,
}

#[tauri::command]
fn mcp_pair_new(state: State<AppState>, name: String) -> Result<McpPairOutcome, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("client name is required".into());
    }
    let (client, token) = state.store.mcp_pair(trimmed).map_err(|e| e.to_string())?;
    Ok(McpPairOutcome { client, token })
}

#[tauri::command]
fn mcp_clients_list(state: State<AppState>) -> Result<Vec<store::McpClientRow>, String> {
    state.store.mcp_clients().map_err(|e| e.to_string())
}

#[tauri::command]
fn mcp_client_revoke(state: State<AppState>, id: String) -> Result<(), String> {
    state.store.mcp_revoke(&id).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerInfo {
    socket_path: Option<String>,
    proxy_path: Option<String>,
}

#[tauri::command]
fn mcp_server_info() -> McpServerInfo {
    let proxy = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("gatehouse-mcp")))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string());
    McpServerInfo {
        socket_path: mcp::socket_path().map(|p| p.to_string_lossy().to_string()),
        proxy_path: proxy,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditListOut {
    chain_valid: bool,
    entries: Vec<audit::AuditEntry>,
}

const AUDIT_LIST_LIMIT: usize = 200;

/// Verified audit entries for the Settings screen. An invalid chain is
/// reported as such (fail-closed alert) instead of serving unverifiable rows.
#[tauri::command]
fn audit_list(state: State<AppState>) -> Result<AuditListOut, String> {
    let a = state.audit.get()?;
    match a.list(AUDIT_LIST_LIMIT) {
        Ok(entries) => Ok(AuditListOut {
            chain_valid: true,
            entries,
        }),
        Err(audit::AuditError::ChainInvalid) => Ok(AuditListOut {
            chain_valid: false,
            entries: Vec::new(),
        }),
        Err(e) => Err(e.to_string()),
    }
}

/// Session-persistence for the frontend (tabs, history, saved queries,
/// settings) — plain JSON values in the local store's settings table.
#[tauri::command]
fn ui_state_get(state: State<AppState>, key: String) -> Result<Option<String>, String> {
    state
        .store
        .setting(&format!("ui/{key}"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ui_state_set(state: State<AppState>, key: String, value: String) -> Result<(), String> {
    state
        .store
        .set_setting(&format!("ui/{key}"), &value)
        .map_err(|e| e.to_string())
}

/// Menu item ids forwarded to the webview. The default Tauri menu binds ⌘W to
/// "Close Window" and ⌘Z/⇧⌘Z to the native responder chain, so those keys
/// never reach the frontend; custom items reclaim them and emit an event the
/// frontend routes (tab close, quit confirmation, grid undo/redo).
const MENU_EVENT: &str = "gatehouse://menu";
const FORWARDED_MENU_IDS: [&str; 5] = ["quit", "undo", "redo", "copy", "close-tab"];

fn build_menu(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle();
    let app_menu = Submenu::with_items(
        handle,
        "Gatehouse",
        true,
        &[
            &PredefinedMenuItem::about(handle, None, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::services(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "quit", "Quit Gatehouse", true, Some("CmdOrCtrl+Q"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &MenuItem::with_id(handle, "undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(handle, "redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &MenuItem::with_id(handle, "copy", "Copy", true, Some("CmdOrCtrl+C"))?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(handle, None)?],
    )?;
    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?,
        ],
    )?;
    let menu = Menu::with_items(handle, &[&app_menu, &edit_menu, &view_menu, &window_menu])?;
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        let id = event.id().as_ref();
        if FORWARDED_MENU_IDS.contains(&id) {
            let _ = handle.emit(MENU_EVENT, id);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let store = Arc::new(Store::open().expect("failed to open local store"));
    let state = AppState {
        store,
        queue: queue::Queue::default(),
        queries: QueryRegistry::default(),
        audit: AuditHandle::lazy(),
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            build_menu(app)?;
            // Seed the local store on first run so the app is populated.
            let state = app.state::<AppState>();
            if state.store.list().map(|p| p.is_empty()).unwrap_or(false) {
                seed_default_profiles(&state.store);
            }
            mcp::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            classify_sql,
            list_profiles,
            save_profile,
            delete_profile,
            sqlite_list_tables,
            get_schema,
            test_connection,
            run_query,
            explain_query,
            cancel_query,
            request_write,
            queue_list,
            queue_resolve,
            queue_approve_execute,
            mcp_tool_schemas,
            mcp_pair_new,
            mcp_clients_list,
            mcp_client_revoke,
            mcp_server_info,
            audit_list,
            ui_state_get,
            ui_state_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Gatehouse");
}

#[cfg(test)]
mod ipc_tests {
    use super::*;
    use serde_json::json;
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    use tauri::WebviewWindowBuilder;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("gatehouse_ipc_{name}"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn make_app(test_name: &str) -> (tauri::App<tauri::test::MockRuntime>, String) {
        let db_path = temp_path(&format!("{test_name}.db"));
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER DEFAULT 0);
             INSERT INTO items (label, qty) VALUES ('widget', 3), ('gadget', 7);",
        )
        .unwrap();
        drop(conn);

        let store = Store::open_at(temp_path(&format!("{test_name}_store.db"))).unwrap();
        let profile = Profile {
            id: "p_test".into(),
            name: "Test".into(),
            engine: "sqlite".into(),
            group: "Local files".into(),
            color: "#fff".into(),
            host: String::new(),
            port: 0,
            user: String::new(),
            database: db_path.to_string_lossy().to_string(),
            environment: "local".into(),
            ssl: false,
            ssh_tunnel: false,
            ssh_host: String::new(),
            ssh_port: 22,
            ssh_user: String::new(),
            ssh_key_path: String::new(),
            read_only: false,
            agent_access: false,
            save_password: false,
            has_password: false,
            has_ssh_secret: false,
        };
        store.upsert(&profile, None, None).unwrap();

        let app = mock_builder()
            .manage(AppState {
                store: Arc::new(store),
                queue: queue::Queue::default(),
                queries: QueryRegistry::default(),
                audit: AuditHandle::preset(audit::test_support::open_for_tests(temp_path(
                    &format!("{test_name}_audit.db"),
                ))),
            })
            .invoke_handler(tauri::generate_handler![
                classify_sql,
                list_profiles,
                save_profile,
                delete_profile,
                sqlite_list_tables,
                get_schema,
                test_connection,
                run_query,
                explain_query,
                request_write,
                queue_list,
                queue_resolve,
                queue_approve_execute,
                mcp_tool_schemas,
                mcp_pair_new,
                mcp_clients_list,
                mcp_client_revoke,
                audit_list,
                ui_state_get,
                ui_state_set,
                cancel_query,
            ])
            .build(mock_context(noop_assets()))
            .unwrap();
        (app, db_path.to_string_lossy().to_string())
    }

    fn invoke(
        webview: &tauri::WebviewWindow<tauri::test::MockRuntime>,
        cmd: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value> {
        tauri::test::get_ipc_response(
            webview,
            InvokeRequest {
                cmd: cmd.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: "tauri://localhost".parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            },
        )
        .map(|b| b.deserialize::<serde_json::Value>().unwrap())
    }

    #[test]
    fn read_and_write_flow_over_ipc() {
        let (app, db_path) = make_app("flow");
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();

        let schema = invoke(&webview, "get_schema", json!({ "profileId": "p_test" })).unwrap();
        let tables = schema["tables"].as_array().unwrap();
        assert_eq!(tables[0]["name"], "items");
        assert_eq!(tables[0]["schema"], "main");
        assert_eq!(tables[0]["rowCount"], 2);
        assert_eq!(tables[0]["columns"][0]["primaryKey"], true);
        // SQLite is one file per database: the selector stays single-entry and
        // an override is ignored rather than repointing the profile.
        assert_eq!(schema["database"], json!(db_path.clone()));
        assert_eq!(schema["databases"], json!([db_path.clone()]));
        let overridden = invoke(
            &webview,
            "get_schema",
            json!({ "profileId": "p_test", "database": "other" }),
        )
        .unwrap();
        assert_eq!(overridden["database"], json!(db_path.clone()));

        let res = invoke(
            &webview,
            "run_query",
            json!({ "profileId": "p_test", "sql": "SELECT label, qty FROM items ORDER BY id", "limit": 100 }),
        )
        .unwrap();
        assert_eq!(res["rowCount"], 2);
        assert_eq!(res["rows"][0][0], "widget");
        assert_eq!(res["columns"][1]["type"], "integer");

        let refused = invoke(
            &webview,
            "run_query",
            json!({ "profileId": "p_test", "sql": "DELETE FROM items", "limit": 100 }),
        );
        assert!(refused.is_err());

        let req = invoke(
            &webview,
            "request_write",
            json!({
                "origin": "human-ui",
                "profileId": "p_test",
                "database": db_path,
                "sql": "UPDATE items SET qty = 99 WHERE label = 'widget'"
            }),
        )
        .unwrap();
        let req_id = req["id"].as_str().unwrap().to_string();
        assert_eq!(req["status"], "pending");

        let outcome = invoke(&webview, "queue_approve_execute", json!({ "id": req_id })).unwrap();
        assert_eq!(outcome["result"]["affectedRows"], 1);
        assert_eq!(outcome["request"]["status"], "used");

        let check = invoke(
            &webview,
            "run_query",
            json!({ "profileId": "p_test", "sql": "SELECT qty FROM items WHERE label = 'widget'", "limit": 10 }),
        )
        .unwrap();
        assert_eq!(check["rows"][0][0], 99);

        let replay = invoke(&webview, "queue_approve_execute", json!({ "id": req_id }));
        assert!(replay.is_err());
    }

    #[test]
    fn retargeted_profile_refuses_approval() {
        let (app, db_path) = make_app("retarget");
        let webview = WebviewWindowBuilder::new(&app, "retarget", Default::default())
            .build()
            .unwrap();
        let req = invoke(
            &webview,
            "request_write",
            json!({
                "origin": "human-ui",
                "profileId": "p_test",
                "database": db_path,
                "sql": "UPDATE items SET qty = 1 WHERE label = 'widget'"
            }),
        )
        .unwrap();
        let req_id = req["id"].as_str().unwrap().to_string();

        // Repoint the profile to another database between staging and approval.
        let other_db = temp_path("retarget_other.db").to_string_lossy().to_string();
        let mut profile = invoke(&webview, "list_profiles", json!({})).unwrap()[0].clone();
        profile["database"] = json!(other_db);
        invoke(
            &webview,
            "save_profile",
            json!({ "profile": profile, "password": null }),
        )
        .unwrap();

        let refused = invoke(&webview, "queue_approve_execute", json!({ "id": req_id }));
        let err = refused.unwrap_err();
        assert!(
            err.to_string().contains("SEC-05"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn ui_state_roundtrips() {
        let (app, _db) = make_app("ui_state");
        let webview = WebviewWindowBuilder::new(&app, "ui_state", Default::default())
            .build()
            .unwrap();
        let empty = invoke(&webview, "ui_state_get", json!({ "key": "workspace" })).unwrap();
        assert!(empty.is_null());
        invoke(
            &webview,
            "ui_state_set",
            json!({ "key": "workspace", "value": "{\"tabs\":[]}" }),
        )
        .unwrap();
        let stored = invoke(&webview, "ui_state_get", json!({ "key": "workspace" })).unwrap();
        assert_eq!(stored, json!("{\"tabs\":[]}"));
        invoke(
            &webview,
            "ui_state_set",
            json!({ "key": "workspace", "value": "{\"tabs\":[1]}" }),
        )
        .unwrap();
        let updated = invoke(&webview, "ui_state_get", json!({ "key": "workspace" })).unwrap();
        assert_eq!(updated, json!("{\"tabs\":[1]}"));
    }

    #[test]
    fn write_flow_is_audited() {
        let (app, db_path) = make_app("audited");
        let webview = WebviewWindowBuilder::new(&app, "audited", Default::default())
            .build()
            .unwrap();
        let req = invoke(
            &webview,
            "request_write",
            json!({
                "origin": "human-ui",
                "profileId": "p_test",
                "database": db_path,
                "sql": "UPDATE items SET qty = 4 WHERE label = 'gadget'"
            }),
        )
        .unwrap();
        let req_id = req["id"].as_str().unwrap().to_string();
        invoke(&webview, "queue_approve_execute", json!({ "id": req_id })).unwrap();

        let out = invoke(&webview, "audit_list", json!({})).unwrap();
        assert_eq!(out["chainValid"], true);
        let entries = out["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["action"], "execute · update");
        assert_eq!(entries[0]["outcome"], "executed");
        assert_eq!(entries[0]["profileName"], "Test");
        assert_eq!(entries[1]["action"], "request_write · update");
        assert_eq!(entries[1]["outcome"], "pending");
    }

    #[test]
    fn mcp_pairing_over_ipc() {
        let (app, _db) = make_app("mcp_pair");
        let webview = WebviewWindowBuilder::new(&app, "mcp_pair", Default::default())
            .build()
            .unwrap();
        let refused = invoke(&webview, "mcp_pair_new", json!({ "name": "  " }));
        assert!(refused.is_err());

        let paired = invoke(&webview, "mcp_pair_new", json!({ "name": "claude-code" })).unwrap();
        assert_eq!(paired["token"].as_str().unwrap().len(), 64);
        let id = paired["client"]["id"].as_str().unwrap().to_string();

        let listed = invoke(&webview, "mcp_clients_list", json!({})).unwrap();
        assert_eq!(listed[0]["name"], "claude-code");
        assert_eq!(listed[0]["revoked"], false);

        invoke(&webview, "mcp_client_revoke", json!({ "id": id })).unwrap();
        let listed = invoke(&webview, "mcp_clients_list", json!({})).unwrap();
        assert_eq!(listed[0]["revoked"], true);
    }

    #[test]
    fn agent_write_requires_agent_access() {
        let (app, db_path) = make_app("agent");
        let webview = WebviewWindowBuilder::new(&app, "agent", Default::default())
            .build()
            .unwrap();
        let refused = invoke(
            &webview,
            "request_write",
            json!({
                "origin": "agent",
                "profileId": "p_test",
                "database": db_path,
                "sql": "DELETE FROM items"
            }),
        );
        assert!(refused.is_err());
    }
}

fn seed_default_profiles(store: &Store) {
    let p = Profile {
        id: "p_local_cache".into(),
        name: "Cache".into(),
        engine: "sqlite".into(),
        group: "Local files".into(),
        color: "#f2c94c".into(),
        host: String::new(),
        port: 0,
        user: String::new(),
        database: "~/gatehouse/cache.db".into(),
        environment: "local".into(),
        ssl: false,
        ssh_tunnel: false,
        ssh_host: String::new(),
        ssh_port: 22,
        ssh_user: String::new(),
        ssh_key_path: String::new(),
        read_only: false,
        // Agent access is opt-in per profile — never enabled by default
        // (Decisions §10, SEC-04).
        agent_access: false,
        save_password: false,
        has_password: false,
        has_ssh_secret: false,
    };
    let _ = store.upsert(&p, None, None);
}
