//! Embedded MCP server (Decisions §4, §10).
//!
//! Transport: a Unix domain socket in the app data dir with `0600` perms and
//! a peer-UID check; the app ships a `gatehouse-mcp` stdio proxy (see
//! `src/bin/gatehouse-mcp.rs`) that MCP clients launch. No TCP port — this
//! removes DNS rebinding and Origin-validation concerns. Pairing is
//! per-client: the proxy presents a token on a preamble line before MCP
//! starts; only the token's SHA-256 hash is stored (store.rs), revocation is
//! re-checked on every tool call. Every tool call is audited (SEC-12,
//! fail-closed: no audit → no agent operation).

use crate::store::McpClientRow;
use crate::{audit_detail, audit_log, AppState};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, ErrorData};
use rmcp::{serve_server, tool, tool_router};
use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncBufReadExt;

/// Token-frugal limits (Decisions §4): columns declared once, rows as arrays,
/// capped at 1000 rows / 5 MiB with an explicit truncation flag.
pub const AGENT_MAX_ROWS: usize = 1000;
pub const AGENT_TIMEOUT_MS: u64 = 30_000;
const PREAMBLE_MAX_LEN: usize = 4096;

pub const ACTIVITY_EVENT: &str = "gatehouse://agent-activity";
pub const QUEUE_EVENT: &str = "gatehouse://queue-changed";

pub fn tool_schemas() -> Value {
    json!({
        "tools": [
            {
                "name": "list_profiles",
                "description": "List connection profiles the agent may address (names only, never credentials).",
                "input": {}
            },
            {
                "name": "get_schema",
                "description": "Tables, columns, types and foreign keys for a profile in a compact format.",
                "input": { "profile": "string" }
            },
            {
                "name": "query",
                "description": "Run a read-only statement. Executed in a guaranteed/best-effort read-only context; capped at 1000 rows / 5 MiB.",
                "input": { "profile": "string", "sql": "string" }
            },
            {
                "name": "request_write",
                "description": "Submit a write for human approval. Returns a request id and status only — never the result before approval.",
                "input": { "profile": "string", "sql": "string" }
            }
        ],
        "limits": { "max_rows": AGENT_MAX_ROWS, "max_bytes": crate::engine::READ_BYTE_CAP },
        "guarantees": {
            "credentials_never_exposed": true,
            "writes_require_human_approval": true,
            "single_statement_per_call": true
        }
    })
}

pub fn socket_path() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("Gatehouse").join("gatehouse.sock"))
}

pub fn start(app: AppHandle) {
    let Some(path) = socket_path() else {
        eprintln!("[gatehouse] MCP server not started: no app data dir");
        return;
    };
    start_at(app, path);
}

fn start_at(app: AppHandle, path: PathBuf) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app, path).await {
            eprintln!("[gatehouse] MCP server stopped: {e}");
        }
    });
}

async fn serve(
    app: AppHandle,
    path: PathBuf,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).ok();
    }
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    loop {
        let (stream, _) = listener.accept().await?;
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = handle_connection(app, stream).await {
                eprintln!("[gatehouse] MCP connection ended: {e}");
            }
        });
    }
}

/// Same-user check: the connecting process must run as the same effective UID
/// as the app. Defense in depth on top of the 0600 socket mode.
fn check_peer_uid(stream: &tokio::net::UnixStream) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    let rc = unsafe { libc::getpeereid(fd, &mut uid, &mut gid) };
    if rc != 0 {
        return Err("getpeereid failed".into());
    }
    let own = unsafe { libc::geteuid() };
    if uid != own {
        return Err(format!("peer uid {uid} does not match app uid {own}"));
    }
    Ok(())
}

async fn handle_connection(
    app: AppHandle,
    stream: tokio::net::UnixStream,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    check_peer_uid(&stream)?;
    let (read_half, write_half) = stream.into_split();
    let mut reader = tokio::io::BufReader::new(read_half);

    // Pairing preamble: one JSON line before MCP starts. Fail closed on
    // anything unexpected — unknown/revoked tokens get a silent close (no
    // oracle about which clients exist).
    let mut line = String::new();
    let n = reader.read_line(&mut line).await?;
    if n == 0 || n > PREAMBLE_MAX_LEN {
        return Err("missing pairing preamble".into());
    }
    let preamble: Value = serde_json::from_str(line.trim())?;
    let token = preamble
        .get("gatehouse_pairing")
        .and_then(|v| v.as_str())
        .ok_or("malformed pairing preamble")?;
    let client = {
        let state = app.state::<AppState>();
        state
            .store
            .mcp_client_for_token(token)
            .map_err(|e| e.to_string())?
    };
    let Some(client) = client else {
        return Err("unknown or revoked pairing token".into());
    };

    let server = GatehouseMcp {
        app: app.clone(),
        client,
    };
    let running = serve_server(server, (reader, write_half)).await?;
    running.waiting().await?;
    Ok(())
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct ProfileParam {
    /// Profile name or id, as returned by list_profiles.
    profile: String,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct SqlParam {
    /// Profile name or id, as returned by list_profiles.
    profile: String,
    /// A single SQL statement.
    sql: String,
}

#[derive(Serialize, Clone)]
struct ActivityPayload<'a> {
    client: &'a str,
    tool: &'a str,
    duration_ms: f64,
    rows: Option<usize>,
}

#[derive(Clone)]
struct GatehouseMcp {
    app: AppHandle,
    client: McpClientRow,
}

fn tool_err(msg: impl Into<String>) -> ErrorData {
    ErrorData::invalid_params(msg.into(), None)
}

fn text_result(v: &impl Serialize) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::json(v)?]))
}

impl GatehouseMcp {
    /// Generic resolution error (Decisions §10): never reveal whether the
    /// profile exists, is disabled, or is out of scope.
    fn agent_profile(&self, reference: &str) -> Result<crate::store::Profile, ErrorData> {
        let state = self.app.state::<AppState>();
        let profiles = state
            .store
            .list()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let p = profiles
            .into_iter()
            .find(|p| (p.id == reference || p.name == reference) && p.agent_access)
            .ok_or_else(|| tool_err("profile is not available for agent access"))?;
        crate::ensure_profile_supported(&p).map_err(tool_err)?;
        Ok(p)
    }

    /// SEC-12 fail-closed pre-check: agents may not operate while the audit
    /// trail is unavailable or invalid.
    fn require_audit(&self) -> Result<(), ErrorData> {
        let state = self.app.state::<AppState>();
        let ok = state.audit.get().map(|a| a.is_valid()).unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err(tool_err(
                "audit trail unavailable — agent operations are refused (SEC-12)",
            ))
        }
    }

    fn audit(
        &self,
        profile: &crate::store::Profile,
        action: &str,
        detail: &str,
        outcome: &str,
    ) -> Result<(), ErrorData> {
        let state = self.app.state::<AppState>();
        audit_log(
            &state,
            &self.client.name,
            &profile.id,
            &profile.name,
            action,
            detail,
            outcome,
        )
        .map_err(tool_err)
    }

    fn touch_activity(&self, tool: &str, duration_ms: f64, rows: Option<usize>) {
        let state = self.app.state::<AppState>();
        let _ = state.store.mcp_touch(&self.client.id);
        let _ = self.app.emit(
            ACTIVITY_EVENT,
            ActivityPayload {
                client: &self.client.name,
                tool,
                duration_ms,
                rows,
            },
        );
    }
}

#[tool_router(server_handler)]
impl GatehouseMcp {
    #[tool(
        name = "list_profiles",
        description = "List connection profiles this agent may address (names only, never credentials)."
    )]
    async fn list_profiles(&self) -> Result<CallToolResult, ErrorData> {
        let state = self.app.state::<AppState>();
        let profiles = state
            .store
            .list()
            .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let out: Vec<Value> = profiles
            .iter()
            .filter(|p| p.agent_access)
            .map(|p| {
                json!({
                    "id": p.id,
                    "name": p.name,
                    "engine": p.engine,
                    "database": p.database,
                    "environment": p.environment,
                })
            })
            .collect();
        self.touch_activity("list_profiles", 0.0, None);
        text_result(&json!({ "profiles": out }))
    }

    #[tool(
        name = "get_schema",
        description = "Tables, columns, types and foreign keys for a profile, in a compact format."
    )]
    async fn get_schema(
        &self,
        Parameters(ProfileParam { profile }): Parameters<ProfileParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.require_audit()?;
        let p = self.agent_profile(&profile)?;
        let started = std::time::Instant::now();
        let state = self.app.state::<AppState>();
        let store = state.store.clone();
        let engine_profile = p.clone();
        let tables = tauri::async_runtime::spawn_blocking(move || {
            crate::engine_schema(&store, &engine_profile, None)
        })
        .await
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?
        .map_err(tool_err)?;
        self.audit(&p, "get_schema", "", "read")?;
        let compact: Vec<Value> = tables
            .iter()
            .map(|t| {
                json!({
                    "schema": t.schema,
                    "name": t.name,
                    "kind": t.kind,
                    "columns": t.columns.iter().map(|c| {
                        let mut col = json!({ "name": c.name, "type": c.col_type });
                        if !c.nullable { col["notNull"] = json!(true); }
                        if c.primary_key { col["pk"] = json!(true); }
                        if let Some(r) = &c.references {
                            col["fk"] = json!(format!("{}.{}", r.table, r.column));
                        }
                        col
                    }).collect::<Vec<_>>(),
                })
            })
            .collect();
        self.touch_activity("get_schema", started.elapsed().as_secs_f64() * 1000.0, None);
        text_result(&json!({ "tables": compact }))
    }

    #[tool(
        name = "query",
        description = "Run a single read-only SQL statement. Writes are refused — use request_write. Capped at 1000 rows / 5 MiB."
    )]
    async fn query(
        &self,
        Parameters(SqlParam { profile, sql }): Parameters<SqlParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.require_audit()?;
        let p = self.agent_profile(&profile)?;
        let c = crate::classifier::classify(&sql, &p.engine);
        if c.is_write {
            return Err(tool_err(format!(
                "refused: {} — writes must go through request_write and human approval",
                c.reason
            )));
        }
        let started = std::time::Instant::now();
        let state = self.app.state::<AppState>();
        let store = state.store.clone();
        let engine_profile = p.clone();
        let sql_owned = sql.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::engine_read_query(
                &store,
                &engine_profile,
                None,
                &sql_owned,
                AGENT_MAX_ROWS,
                Some(AGENT_TIMEOUT_MS),
                |_| {},
            )
        })
        .await
        .map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        let outcome = if result.is_ok() { "read" } else { "failed" };
        self.audit(&p, "query", &audit_detail(&sql), outcome)?;
        let result = result.map_err(tool_err)?;
        self.touch_activity(
            "query",
            started.elapsed().as_secs_f64() * 1000.0,
            Some(result.rows.len()),
        );
        text_result(&result)
    }

    #[tool(
        name = "request_write",
        description = "Submit a write statement for human approval. Returns a request id and status only — never the result before approval."
    )]
    async fn request_write(
        &self,
        Parameters(SqlParam { profile, sql }): Parameters<SqlParam>,
    ) -> Result<CallToolResult, ErrorData> {
        self.require_audit()?;
        let p = self.agent_profile(&profile)?;
        let c = crate::classifier::classify(&sql, &p.engine);
        if !c.is_write {
            return Err(tool_err(
                "this statement is read-only — run it directly via query",
            ));
        }
        let kind = format!("{:?}", c.kind).to_lowercase();
        self.audit(
            &p,
            &format!("request_write · {kind}"),
            &audit_detail(&sql),
            "pending",
        )?;
        let state = self.app.state::<AppState>();
        let req = state
            .queue
            .enqueue(&self.client.name, &p.id, &p.database, &sql, &kind);
        let _ = self.app.emit(QUEUE_EVENT, &req.id);
        self.touch_activity("request_write", 0.0, None);
        text_result(&json!({ "id": req.id, "status": "pending", "expiresAt": req.expires_at }))
    }
}
