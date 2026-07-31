//! SQL read/write classifier — the UX pre-filter (Decisions §5, layer 1).
//! Fail-closed: anything not provably read-only is treated as a write.
//! This is never the security barrier — the engine enforcement is (§5, layer 2).

use serde::Serialize;
use sqlparser::ast::{Expr, SetExpr, Statement, Top, TopQuantity, Value};
use sqlparser::dialect::{
    Dialect, GenericDialect, MsSqlDialect, MySqlDialect, PostgreSqlDialect, SQLiteDialect,
};
use sqlparser::parser::Parser;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatementKind {
    Read,
    Insert,
    Update,
    Delete,
    Ddl,
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct Classification {
    pub kind: StatementKind,
    pub is_write: bool,
    pub reason: String,
}

fn dialect_for(engine: &str) -> Box<dyn Dialect> {
    match engine {
        "postgres" => Box::new(PostgreSqlDialect {}),
        "mysql" => Box::new(MySqlDialect {}),
        "sqlite" => Box::new(SQLiteDialect {}),
        "mssql" => Box::new(MsSqlDialect {}),
        _ => Box::new(GenericDialect {}),
    }
}

/// MySQL executable comments `/*! ... */` are run by the server but treated as
/// comments by parsers — reject before classification (Decisions §5).
fn has_dangerous_construct(sql: &str) -> Option<&'static str> {
    let upper = sql.to_uppercase();
    if sql.contains("/*!") {
        return Some("MySQL executable comment");
    }
    if upper.starts_with("COPY ") || upper.contains(" COPY ") {
        return Some("file/program access construct");
    }
    for needle in ["INTO OUTFILE", "INTO DUMPFILE", "LOAD_FILE", "XP_CMDSHELL"] {
        if upper.contains(needle) {
            return Some("file/program access construct");
        }
    }
    None
}

/// Push the row cap into the server for a top-level query that has no
/// LIMIT/FETCH of its own — the Postgres read path buffers whole result sets
/// (`simple_query`), so a client-side cap alone would still stream an entire
/// huge table. Returns `None` for anything that is not a plain limitable
/// query (EXPLAIN, SHOW, existing LIMIT, multiple statements…); the
/// downstream row/byte caps still apply there.
///
/// MS SQL Server has no `LIMIT` — the cap is pushed as `SELECT TOP n` instead,
/// which only exists on a plain `SELECT` body (a top-level UNION yields `None`).
pub fn with_server_limit(sql: &str, engine: &str, max_rows: usize) -> Option<String> {
    let dialect = dialect_for(engine);
    let mut stmts = Parser::parse_sql(dialect.as_ref(), sql.trim()).ok()?;
    if stmts.len() != 1 {
        return None;
    }
    let Statement::Query(q) = &mut stmts[0] else {
        return None;
    };
    if q.limit.is_some() || q.fetch.is_some() {
        return None;
    }
    if engine == "mssql" {
        let SetExpr::Select(select) = q.body.as_mut() else {
            return None;
        };
        if select.top.is_some() {
            return None;
        }
        select.top = Some(Top {
            with_ties: false,
            percent: false,
            quantity: Some(TopQuantity::Constant(u64::try_from(max_rows).ok()?)),
        });
        select.top_before_distinct = false;
    } else {
        q.limit = Some(Expr::Value(Value::Number(max_rows.to_string(), false)));
    }
    Some(stmts[0].to_string())
}

pub fn classify(sql: &str, engine: &str) -> Classification {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Classification {
            kind: StatementKind::Unknown,
            is_write: false,
            reason: "Empty statement".into(),
        };
    }

    if let Some(what) = has_dangerous_construct(trimmed) {
        return Classification {
            kind: StatementKind::Unknown,
            is_write: true,
            reason: format!("Contains a {what} — routed for review"),
        };
    }

    let dialect = dialect_for(engine);
    let parsed = match Parser::parse_sql(dialect.as_ref(), trimmed) {
        Ok(stmts) => stmts,
        Err(_) => {
            // Fail-closed: unparseable SQL is treated as a write.
            return Classification {
                kind: StatementKind::Unknown,
                is_write: true,
                reason: "Could not parse — treated as a write (fail-closed)".into(),
            };
        }
    };

    // Enforce one statement per driver call (Decisions §5, non-negotiable rule).
    if parsed.len() != 1 {
        return Classification {
            kind: StatementKind::Unknown,
            is_write: true,
            reason: "Multiple statements per call are rejected".into(),
        };
    }

    let stmt = &parsed[0];
    let kind = classify_statement(stmt);
    let is_write = !matches!(kind, StatementKind::Read);
    let reason = match kind {
        StatementKind::Read => "Read-only statement".to_string(),
        StatementKind::Ddl => "Schema-altering statement (DDL)".to_string(),
        StatementKind::Unknown => "Could not classify — treated as a write".to_string(),
        _ => "Data-modifying statement — requires approval".to_string(),
    };

    Classification {
        kind,
        is_write,
        reason,
    }
}

fn classify_statement(stmt: &Statement) -> StatementKind {
    match stmt {
        Statement::Query(q) => {
            // A modifying CTE (WITH x AS (DELETE ... RETURNING) SELECT ...) parses
            // as a Query — walk the CTEs to catch it.
            if query_has_modifying_cte(q) {
                StatementKind::Delete
            } else {
                StatementKind::Read
            }
        }
        Statement::Insert { .. } => StatementKind::Insert,
        Statement::Update { .. } => StatementKind::Update,
        Statement::Delete { .. } => StatementKind::Delete,
        Statement::CreateTable { .. }
        | Statement::CreateView { .. }
        | Statement::CreateIndex { .. }
        | Statement::AlterTable { .. }
        | Statement::Drop { .. }
        | Statement::Truncate { .. }
        | Statement::CreateSchema { .. }
        | Statement::Grant { .. }
        | Statement::Revoke { .. } => StatementKind::Ddl,
        Statement::Explain {
            statement, analyze, ..
        } => {
            if *analyze {
                // EXPLAIN ANALYZE executes the underlying query.
                classify_statement(statement)
            } else {
                StatementKind::Read
            }
        }
        // SET / COPY / CALL / etc. — not provably read-only.
        _ => StatementKind::Unknown,
    }
}

fn set_expr_is_modifying(body: &sqlparser::ast::SetExpr) -> bool {
    use sqlparser::ast::SetExpr;
    match body {
        SetExpr::Insert(_) | SetExpr::Update(_) => true,
        SetExpr::Query(q) => query_has_modifying_cte(q) || set_expr_is_modifying(&q.body),
        SetExpr::SetOperation { left, right, .. } => {
            set_expr_is_modifying(left) || set_expr_is_modifying(right)
        }
        _ => false,
    }
}

fn query_has_modifying_cte(query: &sqlparser::ast::Query) -> bool {
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            if query_has_modifying_cte(&cte.query) {
                return true;
            }
        }
    }
    set_expr_is_modifying(&query.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_is_read() {
        assert_eq!(
            classify("SELECT * FROM users", "postgres").kind,
            StatementKind::Read
        );
    }

    #[test]
    fn server_limit_injected_when_absent() {
        let out = with_server_limit("SELECT * FROM users ORDER BY id", "postgres", 501).unwrap();
        assert_eq!(out, "SELECT * FROM users ORDER BY id LIMIT 501");
    }

    #[test]
    fn server_limit_uses_top_on_mssql() {
        let out = with_server_limit("SELECT * FROM users ORDER BY id", "mssql", 501).unwrap();
        assert_eq!(out, "SELECT TOP 501 * FROM users ORDER BY id");

        let distinct = with_server_limit("SELECT DISTINCT name FROM users", "mssql", 501).unwrap();
        assert_eq!(distinct, "SELECT DISTINCT TOP 501 name FROM users");

        let cte = with_server_limit(
            "WITH big AS (SELECT * FROM orders) SELECT * FROM big",
            "mssql",
            501,
        )
        .unwrap();
        assert_eq!(
            cte,
            "WITH big AS (SELECT * FROM orders) SELECT TOP 501 * FROM big"
        );

        assert!(with_server_limit("SELECT TOP 10 * FROM users", "mssql", 501).is_none());
        assert!(
            with_server_limit("SELECT a FROM t1 UNION SELECT a FROM t2", "mssql", 501).is_none()
        );
    }

    #[test]
    fn server_limit_respects_existing_limit_and_fetch() {
        assert!(with_server_limit("SELECT * FROM users LIMIT 10", "postgres", 501).is_none());
        assert!(with_server_limit(
            "SELECT * FROM users FETCH FIRST 5 ROWS ONLY",
            "postgres",
            501
        )
        .is_none());
    }

    #[test]
    fn server_limit_covers_ctes_but_not_non_queries() {
        let cte = with_server_limit(
            "WITH big AS (SELECT * FROM orders) SELECT * FROM big",
            "postgres",
            501,
        )
        .unwrap();
        assert!(cte.ends_with("LIMIT 501"), "unexpected: {cte}");
        assert!(with_server_limit("EXPLAIN SELECT * FROM users", "postgres", 501).is_none());
        assert!(with_server_limit("SHOW server_version", "postgres", 501).is_none());
        assert!(with_server_limit("SELECT 1; SELECT 2", "postgres", 501).is_none());
    }

    #[test]
    fn update_is_write() {
        assert!(classify("UPDATE users SET x = 1", "postgres").is_write);
    }

    #[test]
    fn delete_is_write() {
        assert_eq!(
            classify("DELETE FROM users", "postgres").kind,
            StatementKind::Delete
        );
    }

    #[test]
    fn ddl_is_write() {
        assert_eq!(
            classify("DROP TABLE users", "postgres").kind,
            StatementKind::Ddl
        );
    }

    #[test]
    fn multi_statement_rejected() {
        assert!(classify("SELECT 1; DROP TABLE users", "postgres").is_write);
    }

    #[test]
    fn unparseable_fails_closed() {
        assert!(classify("this is not sql ;;;", "postgres").is_write);
    }

    #[test]
    fn mysql_exec_comment_rejected() {
        assert!(classify("SELECT /*!32302 1/0 */ 1", "mysql").is_write);
    }

    #[test]
    fn copy_at_start_rejected() {
        assert!(classify("COPY users TO '/tmp/out.csv'", "postgres").is_write);
        assert!(classify("copy users FROM '/tmp/in.csv'", "postgres").is_write);
    }

    #[test]
    fn modifying_cte_is_write() {
        assert!(
            classify(
                "WITH x AS (UPDATE users SET active = false RETURNING id) SELECT * FROM x",
                "postgres"
            )
            .is_write
        );
        assert!(
            classify(
                "WITH x AS (INSERT INTO logs (msg) VALUES ('a') RETURNING id) SELECT * FROM x",
                "postgres"
            )
            .is_write
        );
        assert!(
            classify(
                "WITH x AS (DELETE FROM users WHERE id = 1 RETURNING id) SELECT * FROM x",
                "postgres"
            )
            .is_write
        );
        assert!(
            classify(
                "WITH y AS (SELECT 1), x AS (UPDATE users SET a = 1 RETURNING id) SELECT * FROM x",
                "postgres"
            )
            .is_write
        );
    }

    #[test]
    fn readonly_cte_with_write_looking_identifiers_is_read() {
        assert_eq!(
            classify(
                "WITH t AS (SELECT updated_at, deleted_at FROM orders) SELECT * FROM t",
                "postgres"
            )
            .kind,
            StatementKind::Read
        );
    }
}
