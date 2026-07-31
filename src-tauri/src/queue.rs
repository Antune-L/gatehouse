//! In-memory validation queue (Decisions §10). Write requests — from agents or
//! the UI — live only in process memory: a restart invalidates them by
//! construction. Approval is single-use with a 5-minute expiry.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const EXPIRY_SECS: u64 = 300;

/// SEC-05: an approval is bound to what was reviewed — the exact SQL and the
/// exact target (profile, database). The fingerprint is computed when the
/// request is staged and re-verified when the approval is consumed.
pub fn fingerprint(profile_id: &str, database: &str, sql: &str) -> String {
    let mut h = Sha256::new();
    h.update(profile_id.as_bytes());
    h.update([0]);
    h.update(database.as_bytes());
    h.update([0]);
    h.update(sql.as_bytes());
    hex::encode(h.finalize())
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Approved,
    Rejected,
    Expired,
    /// Approval consumed by an execution attempt — single-use (Decisions §10).
    Used,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct WriteRequest {
    pub id: String,
    pub origin: String,
    pub profile_id: String,
    pub database: String,
    pub sql: String,
    pub statement_kind: String,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: Status,
    pub fingerprint: String,
}

#[derive(Default)]
pub struct Queue {
    inner: Mutex<Vec<WriteRequest>>,
    counter: Mutex<u64>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Queue {
    pub fn enqueue(
        &self,
        origin: &str,
        profile_id: &str,
        database: &str,
        sql: &str,
        kind: &str,
    ) -> WriteRequest {
        let mut c = self.counter.lock().unwrap();
        *c += 1;
        let id = format!("wr_{}", *c);
        let t = now();
        let req = WriteRequest {
            id,
            origin: origin.to_string(),
            profile_id: profile_id.to_string(),
            database: database.to_string(),
            sql: sql.to_string(),
            statement_kind: kind.to_string(),
            created_at: t,
            expires_at: t + EXPIRY_SECS,
            status: Status::Pending,
            fingerprint: fingerprint(profile_id, database, sql),
        };
        self.inner.lock().unwrap().push(req.clone());
        req
    }

    pub fn list(&self) -> Vec<WriteRequest> {
        let t = now();
        let mut guard = self.inner.lock().unwrap();
        for r in guard.iter_mut() {
            if r.status == Status::Pending && t > r.expires_at {
                r.status = Status::Expired;
            }
        }
        guard.clone()
    }

    pub fn resolve(&self, id: &str, approve: bool) -> Option<WriteRequest> {
        let t = now();
        let mut guard = self.inner.lock().unwrap();
        let r = guard.iter_mut().find(|r| r.id == id)?;
        if r.status != Status::Pending {
            return Some(r.clone());
        }
        if t > r.expires_at {
            r.status = Status::Expired;
            return Some(r.clone());
        }
        r.status = if approve {
            Status::Approved
        } else {
            Status::Rejected
        };
        Some(r.clone())
    }

    /// Approve-and-consume in one step: the request must be pending and not
    /// expired. The status flips to `Used` immediately so an approval can never
    /// be executed twice, even if the execution that follows fails.
    pub fn consume_for_execution(&self, id: &str) -> Result<WriteRequest, String> {
        let t = now();
        let mut guard = self.inner.lock().unwrap();
        let r = guard
            .iter_mut()
            .find(|r| r.id == id)
            .ok_or_else(|| "unknown request".to_string())?;
        if r.status != Status::Pending {
            return Err(format!("request is not pending (status: {:?})", r.status));
        }
        if t > r.expires_at {
            r.status = Status::Expired;
            return Err("request has expired".to_string());
        }
        if fingerprint(&r.profile_id, &r.database, &r.sql) != r.fingerprint {
            r.status = Status::Failed;
            return Err("approval fingerprint mismatch (SEC-05)".to_string());
        }
        r.status = Status::Used;
        Ok(r.clone())
    }

    pub fn mark_failed(&self, id: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(r) = guard.iter_mut().find(|r| r.id == id) {
            r.status = Status::Failed;
        }
    }

    #[cfg(test)]
    fn tamper_sql(&self, id: &str, sql: &str) {
        let mut guard = self.inner.lock().unwrap();
        if let Some(r) = guard.iter_mut().find(|r| r.id == id) {
            r.sql = sql.to_string();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_is_single_use() {
        let q = Queue::default();
        let req = q.enqueue(
            "human-ui",
            "p1",
            "db",
            "DELETE FROM x WHERE id = 1",
            "delete",
        );
        let taken = q.consume_for_execution(&req.id).unwrap();
        assert_eq!(taken.status, Status::Used);
        assert!(q.consume_for_execution(&req.id).is_err());
    }

    #[test]
    fn rejected_request_cannot_execute() {
        let q = Queue::default();
        let req = q.enqueue("human-ui", "p1", "db", "DELETE FROM x", "delete");
        q.resolve(&req.id, false);
        assert!(q.consume_for_execution(&req.id).is_err());
    }

    #[test]
    fn tampered_sql_is_refused() {
        let q = Queue::default();
        let req = q.enqueue(
            "human-ui",
            "p1",
            "db",
            "DELETE FROM x WHERE id = 1",
            "delete",
        );
        q.tamper_sql(&req.id, "DROP TABLE x");
        let err = q.consume_for_execution(&req.id).unwrap_err();
        assert!(err.contains("fingerprint"));
        assert_eq!(q.list()[0].status, Status::Failed);
    }

    #[test]
    fn fingerprint_is_target_bound() {
        let a = fingerprint("p1", "db1", "DELETE FROM x");
        assert_ne!(a, fingerprint("p1", "db2", "DELETE FROM x"));
        assert_ne!(a, fingerprint("p2", "db1", "DELETE FROM x"));
        assert_ne!(a, fingerprint("p1", "db1", "DELETE FROM y"));
        assert_eq!(a, fingerprint("p1", "db1", "DELETE FROM x"));
    }

    #[test]
    fn failed_execution_marks_failed() {
        let q = Queue::default();
        let req = q.enqueue("human-ui", "p1", "db", "DELETE FROM x", "delete");
        q.consume_for_execution(&req.id).unwrap();
        q.mark_failed(&req.id);
        let listed = q.list();
        assert_eq!(listed[0].status, Status::Failed);
    }
}
