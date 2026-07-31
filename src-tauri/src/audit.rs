//! Tamper-evident audit trail (Decisions §13, SEC-12).
//!
//! Records are AES-GCM encrypted under the `k_audit_enc` HKDF subkey — only
//! `seq` and the timestamp stay in clear. Each record carries an HMAC-SHA256
//! (`k_audit`) chained over the previous record's MAC, so modification,
//! deletion and reordering are all detectable. The chain head anchor
//! `(key_id, last_seq, last_mac)` lives in the Keychain and is updated
//! *before* an append is acknowledged: no acknowledged record can be
//! truncated without detection. Purge appends an authenticated checkpoint
//! and moves the chain base forward. Startup recovery: a SQLite chain ahead
//! of the anchor but valid under `k_audit` advances the anchor; anything
//! else fails closed (agent paths are refused while the chain is invalid).
//!
//! NOTE: single key generation (key_id 0) for now, matching crypto.rs —
//! rotation (re-encrypt + re-MAC in one transaction) is a documented
//! follow-up in GoLive.md.

use crate::crypto;
use hmac::{Hmac, Mac};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

pub const RETENTION_DAYS: u64 = 180;
const KEY_ID: u8 = 0;
const LABEL_MAC: &str = "gatehouse/audit/mac/v1/0";
const LABEL_ENC: &str = "gatehouse/audit/enc/v1/0";
const SERVICE: &str = "com.gatehouse.app";
const ANCHOR_USER: &str = "audit-anchor";
const GENESIS_MAC: [u8; 32] = [0u8; 32];
const META_BASE_SEQ: &str = "base_seq";
const META_BASE_MAC: &str = "base_mac";

#[derive(Debug, thiserror::Error)]
pub enum AuditError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("crypto: {0}")]
    Crypto(#[from] crypto::CryptoError),
    #[error("audit chain is invalid — audit and agent access are disabled (SEC-12)")]
    ChainInvalid,
    #[error("audit anchor: {0}")]
    Anchor(String),
    #[error("decode error")]
    Decode,
    #[error("no app data dir")]
    NoDataDir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub key_id: u8,
    pub seq: i64,
    pub mac: [u8; 32],
}

pub trait AnchorStore: Send + Sync {
    fn load(&self) -> Result<Option<Anchor>, AuditError>;
    fn save(&self, anchor: &Anchor) -> Result<(), AuditError>;
}

/// Production anchor: a dedicated Keychain entry, distinct from the master
/// key, holding `key_id|seq|mac_hex`.
struct KeychainAnchor;

impl AnchorStore for KeychainAnchor {
    fn load(&self) -> Result<Option<Anchor>, AuditError> {
        let entry = keyring::Entry::new(SERVICE, ANCHOR_USER)
            .map_err(|e| AuditError::Anchor(e.to_string()))?;
        match entry.get_password() {
            Ok(raw) => parse_anchor(&raw).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AuditError::Anchor(e.to_string())),
        }
    }

    fn save(&self, anchor: &Anchor) -> Result<(), AuditError> {
        let entry = keyring::Entry::new(SERVICE, ANCHOR_USER)
            .map_err(|e| AuditError::Anchor(e.to_string()))?;
        entry
            .set_password(&format!(
                "{}|{}|{}",
                anchor.key_id,
                anchor.seq,
                hex::encode(anchor.mac)
            ))
            .map_err(|e| AuditError::Anchor(e.to_string()))
    }
}

fn parse_anchor(raw: &str) -> Result<Anchor, AuditError> {
    let mut parts = raw.split('|');
    let (Some(key_id), Some(seq), Some(mac_hex)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(AuditError::Decode);
    };
    let mac_bytes = hex::decode(mac_hex).map_err(|_| AuditError::Decode)?;
    let mac: [u8; 32] = mac_bytes.try_into().map_err(|_| AuditError::Decode)?;
    Ok(Anchor {
        key_id: key_id.parse().map_err(|_| AuditError::Decode)?,
        seq: seq.parse().map_err(|_| AuditError::Decode)?,
        mac,
    })
}

/// What gets encrypted — never visible in the SQLite file.
#[derive(Debug, Serialize, Deserialize)]
struct RecordBody {
    origin: String,
    profile_id: String,
    profile_name: String,
    action: String,
    detail: String,
    outcome: String,
}

/// Decrypted entry served to the (trusted) frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    pub seq: i64,
    pub at: u64,
    pub origin: String,
    pub profile_id: String,
    pub profile_name: String,
    pub action: String,
    pub detail: String,
    pub outcome: String,
}

pub struct AuditEvent<'a> {
    pub origin: &'a str,
    pub profile_id: &'a str,
    pub profile_name: &'a str,
    pub action: &'a str,
    pub detail: &'a str,
    pub outcome: &'a str,
}

struct Inner {
    conn: Connection,
    head_seq: i64,
    head_mac: [u8; 32],
    valid: bool,
}

pub struct Audit {
    inner: Mutex<Inner>,
    mac_key: Zeroizing<[u8; 32]>,
    enc_key: Zeroizing<[u8; 32]>,
    anchor: Box<dyn AnchorStore>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn chain_mac(key: &[u8; 32], prev: &[u8; 32], seq: i64, at: u64, record_enc: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(prev);
    mac.update(&seq.to_le_bytes());
    mac.update(&at.to_le_bytes());
    mac.update(record_enc);
    mac.finalize().into_bytes().into()
}

fn record_aad(seq: i64, at: u64) -> String {
    format!("audit|{KEY_ID}|{seq}|{at}")
}

impl Audit {
    pub fn open() -> Result<Self, AuditError> {
        let dir = dirs::data_dir()
            .map(|d| d.join("Gatehouse"))
            .ok_or(AuditError::NoDataDir)?;
        std::fs::create_dir_all(&dir).ok();
        Self::open_at_with(
            dir.join("audit.db"),
            crypto::labeled_key(LABEL_MAC)?,
            crypto::labeled_key(LABEL_ENC)?,
            Box::new(KeychainAnchor),
        )
    }

    pub fn open_at_with(
        path: PathBuf,
        mac_key: Zeroizing<[u8; 32]>,
        enc_key: Zeroizing<[u8; 32]>,
        anchor: Box<dyn AnchorStore>,
    ) -> Result<Self, AuditError> {
        let conn = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS audit_log (
                seq INTEGER PRIMARY KEY,
                at INTEGER NOT NULL,
                record_enc BLOB NOT NULL,
                mac BLOB NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )?;
        let audit = Self {
            inner: Mutex::new(Inner {
                conn,
                head_seq: 0,
                head_mac: GENESIS_MAC,
                valid: false,
            }),
            mac_key,
            enc_key,
            anchor,
        };
        audit.verify_and_recover()?;
        // An invalid chain still opens (fail-closed, observable via
        // `is_valid`) — it must never be silently purged.
        if audit.is_valid() {
            audit.purge(RETENTION_DAYS)?;
        }
        Ok(audit)
    }

    /// Verify the full chain against the base and the anchor (Decisions §13).
    /// Chain ahead of the anchor but valid → advance the anchor before
    /// serving. Anything inconsistent → the trail stays fail-closed.
    fn verify_and_recover(&self) -> Result<(), AuditError> {
        let mut inner = self.inner.lock().unwrap();
        let (base_seq, base_mac) = read_base(&inner.conn)?;
        let rows: Vec<(i64, u64, Vec<u8>, Vec<u8>)> = {
            let mut stmt = inner
                .conn
                .prepare("SELECT seq, at, record_enc, mac FROM audit_log ORDER BY seq")?;
            let r = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            r
        };

        let mut prev = base_mac;
        let mut expected_seq = base_seq + 1;
        let mut anchor_mac_in_chain: Option<[u8; 32]> = None;
        let stored_anchor = self.anchor.load()?;
        for (seq, at, record_enc, mac) in &rows {
            let computed = chain_mac(&self.mac_key, &prev, *seq, *at, record_enc);
            if *seq != expected_seq || mac.as_slice() != computed {
                return Ok(());
            }
            if let Some(a) = &stored_anchor {
                if a.seq == *seq {
                    anchor_mac_in_chain = Some(computed);
                }
            }
            prev = computed;
            expected_seq += 1;
        }
        let head_seq = expected_seq - 1;
        let head_mac = prev;

        match &stored_anchor {
            Some(a) => {
                if a.key_id != KEY_ID {
                    return Ok(());
                }
                // Anchor points below the purged base: the checkpointed purge
                // moved the base past it — the base MAC continuity already
                // covers those records.
                let anchored_ok = if a.seq <= base_seq {
                    a.seq < base_seq || (a.seq == base_seq && a.mac == base_mac)
                } else {
                    anchor_mac_in_chain.map(|m| m == a.mac).unwrap_or(false)
                };
                if !anchored_ok || head_seq < a.seq {
                    return Ok(());
                }
                if head_seq > a.seq {
                    self.anchor.save(&Anchor {
                        key_id: KEY_ID,
                        seq: head_seq,
                        mac: head_mac,
                    })?;
                }
            }
            None => {
                // No anchor: fresh install (empty chain) is the only benign
                // case. A non-empty but self-consistent chain means the
                // Keychain entry was lost — recoverable, re-anchor it.
                if head_seq > base_seq || base_seq > 0 {
                    self.anchor.save(&Anchor {
                        key_id: KEY_ID,
                        seq: head_seq,
                        mac: head_mac,
                    })?;
                }
            }
        }

        inner.head_seq = head_seq;
        inner.head_mac = head_mac;
        inner.valid = true;
        Ok(())
    }

    pub fn is_valid(&self) -> bool {
        self.inner.lock().unwrap().valid
    }

    /// Append one event. The anchor is persisted *before* returning: an
    /// acknowledged record can never be silently truncated.
    pub fn append(&self, event: AuditEvent) -> Result<i64, AuditError> {
        let mut inner = self.inner.lock().unwrap();
        if !inner.valid {
            return Err(AuditError::ChainInvalid);
        }
        let seq = inner.head_seq + 1;
        let at = now();
        let body = serde_json::to_vec(&RecordBody {
            origin: event.origin.to_string(),
            profile_id: event.profile_id.to_string(),
            profile_name: event.profile_name.to_string(),
            action: event.action.to_string(),
            detail: event.detail.to_string(),
            outcome: event.outcome.to_string(),
        })
        .map_err(|_| AuditError::Decode)?;
        let record_enc = crypto::seal_with_key(&self.enc_key, &body, &record_aad(seq, at))?;
        let mac = chain_mac(&self.mac_key, &inner.head_mac, seq, at, &record_enc);
        inner.conn.execute(
            "INSERT INTO audit_log (seq, at, record_enc, mac) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![seq, at, record_enc, mac.as_slice()],
        )?;
        self.anchor.save(&Anchor {
            key_id: KEY_ID,
            seq,
            mac,
        })?;
        inner.head_seq = seq;
        inner.head_mac = mac;
        Ok(seq)
    }

    /// Decrypted entries, newest first. Refused while the chain is invalid.
    pub fn list(&self, limit: usize) -> Result<Vec<AuditEntry>, AuditError> {
        let inner = self.inner.lock().unwrap();
        if !inner.valid {
            return Err(AuditError::ChainInvalid);
        }
        let mut stmt = inner
            .conn
            .prepare("SELECT seq, at, record_enc FROM audit_log ORDER BY seq DESC LIMIT ?1")?;
        let rows = stmt
            .query_map([limit], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, Vec<u8>>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (seq, at, record_enc) in rows {
            let body = crypto::open_with_key(&self.enc_key, &record_enc, &record_aad(seq, at))?;
            let body: RecordBody = serde_json::from_slice(&body).map_err(|_| AuditError::Decode)?;
            out.push(AuditEntry {
                seq,
                at,
                origin: body.origin,
                profile_id: body.profile_id,
                profile_name: body.profile_name,
                action: body.action,
                detail: body.detail,
                outcome: body.outcome,
            });
        }
        Ok(out)
    }

    /// Retention purge with an authenticated checkpoint (Decisions §13): the
    /// checkpoint record is appended (and anchored) first, then the expired
    /// prefix is deleted and the chain base moves to the last purged record.
    pub fn purge(&self, retention_days: u64) -> Result<usize, AuditError> {
        self.purge_before(
            now().saturating_sub(retention_days * 86_400),
            retention_days,
        )
    }

    fn purge_before(&self, cutoff: u64, retention_days: u64) -> Result<usize, AuditError> {
        let prefix: Vec<(i64, Vec<u8>)> = {
            let inner = self.inner.lock().unwrap();
            if !inner.valid {
                return Err(AuditError::ChainInvalid);
            }
            let (base_seq, _) = read_base(&inner.conn)?;
            let mut stmt = inner
                .conn
                .prepare("SELECT seq, at, mac FROM audit_log ORDER BY seq")?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, Vec<u8>>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            rows.into_iter()
                .skip_while(|(seq, _, _)| *seq <= base_seq)
                .take_while(|(_, at, _)| *at < cutoff)
                .map(|(seq, _, mac)| (seq, mac))
                .collect()
        };
        let Some((last_seq, last_mac)) = prefix.last().cloned() else {
            return Ok(0);
        };
        let first_seq = prefix[0].0;
        self.append(AuditEvent {
            origin: "system",
            profile_id: "",
            profile_name: "",
            action: "purge_checkpoint",
            detail: &format!("purged seq {first_seq}..{last_seq} (retention {retention_days}d)"),
            outcome: "executed",
        })?;
        let inner = self.inner.lock().unwrap();
        inner
            .conn
            .execute("DELETE FROM audit_log WHERE seq <= ?1", [last_seq])?;
        write_base(&inner.conn, last_seq, &last_mac)?;
        Ok(prefix.len())
    }
}

fn read_base(conn: &Connection) -> Result<(i64, [u8; 32]), AuditError> {
    let get = |key: &str| -> Option<String> {
        conn.query_row("SELECT value FROM audit_meta WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .ok()
    };
    match (get(META_BASE_SEQ), get(META_BASE_MAC)) {
        (Some(seq), Some(mac_hex)) => {
            let mac_bytes = hex::decode(mac_hex).map_err(|_| AuditError::Decode)?;
            let mac: [u8; 32] = mac_bytes.try_into().map_err(|_| AuditError::Decode)?;
            Ok((seq.parse().map_err(|_| AuditError::Decode)?, mac))
        }
        _ => Ok((0, GENESIS_MAC)),
    }
}

fn write_base(conn: &Connection, seq: i64, mac: &[u8]) -> Result<(), AuditError> {
    let upsert = "INSERT INTO audit_meta (key, value) VALUES (?1, ?2)
                  ON CONFLICT(key) DO UPDATE SET value=?2";
    conn.execute(upsert, [META_BASE_SEQ, &seq.to_string()])?;
    conn.execute(upsert, [META_BASE_MAC, &hex::encode(mac)])?;
    Ok(())
}

#[cfg(test)]
pub mod test_support {
    use super::*;
    use std::sync::Mutex as StdMutex;

    pub struct MemAnchor(pub StdMutex<Option<Anchor>>);

    impl MemAnchor {
        pub fn empty() -> Box<Self> {
            Box::new(Self(StdMutex::new(None)))
        }
    }

    impl AnchorStore for MemAnchor {
        fn load(&self) -> Result<Option<Anchor>, AuditError> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, anchor: &Anchor) -> Result<(), AuditError> {
            *self.0.lock().unwrap() = Some(anchor.clone());
            Ok(())
        }
    }

    pub fn open_for_tests(path: PathBuf) -> Audit {
        Audit::open_at_with(
            path,
            Zeroizing::new([7u8; 32]),
            Zeroizing::new([9u8; 32]),
            MemAnchor::empty(),
        )
        .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    fn temp_db(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("gatehouse_audit_{name}.db"));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn event<'a>(outcome: &'a str) -> AuditEvent<'a> {
        AuditEvent {
            origin: "claude-code",
            profile_id: "p1",
            profile_name: "PG local",
            action: "request_write · update",
            detail: "UPDATE orders",
            outcome,
        }
    }

    fn reopen(path: &PathBuf, anchor: Box<dyn AnchorStore>) -> Result<Audit, AuditError> {
        Audit::open_at_with(
            path.clone(),
            Zeroizing::new([7u8; 32]),
            Zeroizing::new([9u8; 32]),
            anchor,
        )
    }

    #[test]
    fn append_list_roundtrip_encrypted_at_rest() {
        let path = temp_db("roundtrip");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        audit.append(event("approved")).unwrap();
        let entries = audit.list(10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].outcome, "approved");
        assert_eq!(entries[1].origin, "claude-code");
        // The SQLite file must not contain any plaintext from the records.
        drop(audit);
        let raw = std::fs::read(&path).unwrap();
        let raw_str = String::from_utf8_lossy(&raw);
        assert!(!raw_str.contains("claude-code"));
        assert!(!raw_str.contains("UPDATE orders"));
    }

    #[test]
    fn tampered_record_invalidates_chain() {
        let path = temp_db("tamper");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        audit.append(event("approved")).unwrap();
        let anchor = MemAnchor(std::sync::Mutex::new(audit.anchor.load().unwrap()));
        drop(audit);
        let conn = Connection::open(&path).unwrap();
        conn.execute("UPDATE audit_log SET at = at + 1 WHERE seq = 1", [])
            .unwrap();
        drop(conn);
        let reopened = reopen(&path, Box::new(anchor)).unwrap();
        assert!(!reopened.is_valid());
        assert!(matches!(
            reopened.append(event("pending")),
            Err(AuditError::ChainInvalid)
        ));
        assert!(matches!(reopened.list(10), Err(AuditError::ChainInvalid)));
    }

    #[test]
    fn deleted_and_reordered_records_are_detected() {
        let path = temp_db("delete");
        let audit = open_for_tests(path.clone());
        for _ in 0..3 {
            audit.append(event("pending")).unwrap();
        }
        let anchor_state = audit.anchor.load().unwrap();
        drop(audit);
        let conn = Connection::open(&path).unwrap();
        conn.execute("DELETE FROM audit_log WHERE seq = 2", [])
            .unwrap();
        drop(conn);
        let reopened = reopen(
            &path,
            Box::new(MemAnchor(std::sync::Mutex::new(anchor_state))),
        )
        .unwrap();
        assert!(!reopened.is_valid());
    }

    #[test]
    fn truncation_after_acknowledgment_is_detected() {
        let path = temp_db("truncate");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        audit.append(event("approved")).unwrap();
        let anchor_state = audit.anchor.load().unwrap();
        drop(audit);
        // Drop the last (anchored) record: the chain itself stays
        // self-consistent, only the anchor can catch it.
        let conn = Connection::open(&path).unwrap();
        conn.execute("DELETE FROM audit_log WHERE seq = 2", [])
            .unwrap();
        drop(conn);
        let reopened = reopen(
            &path,
            Box::new(MemAnchor(std::sync::Mutex::new(anchor_state))),
        )
        .unwrap();
        assert!(!reopened.is_valid());
    }

    #[test]
    fn chain_ahead_of_anchor_recovers_and_advances() {
        let path = temp_db("recover");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        let stale = audit.anchor.load().unwrap();
        audit.append(event("approved")).unwrap();
        drop(audit);
        let anchor = MemAnchor(std::sync::Mutex::new(stale));
        let reopened = reopen(&path, Box::new(anchor)).unwrap();
        assert!(reopened.is_valid());
        let advanced = reopened.anchor.load().unwrap().unwrap();
        assert_eq!(advanced.seq, 2);
        assert_eq!(reopened.list(10).unwrap().len(), 2);
    }

    #[test]
    fn purge_writes_checkpoint_and_chain_survives() {
        // NOTE: `at` participates in the MAC, so records cannot be aged from
        // outside — a 0-day retention purge exercises the same path.
        let path = temp_db("purge");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        audit.append(event("approved")).unwrap();
        audit.append(event("executed")).unwrap();
        // Nothing is old enough: purge is a no-op.
        assert_eq!(audit.purge(RETENTION_DAYS).unwrap(), 0);
        // Everything is behind a future cutoff: purged behind a checkpoint.
        let purged = audit.purge_before(now() + 10, 0).unwrap();
        assert_eq!(purged, 3);
        let entries = audit.list(10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].action, "purge_checkpoint");
        // The pruned chain must still verify from the new base after reopen.
        let anchor_state = audit.anchor.load().unwrap();
        drop(audit);
        let reopened = reopen(
            &path,
            Box::new(MemAnchor(std::sync::Mutex::new(anchor_state))),
        )
        .unwrap();
        assert!(reopened.is_valid());
        assert_eq!(reopened.list(10).unwrap().len(), 1);
    }

    #[test]
    fn lost_anchor_with_consistent_chain_reanchors() {
        let path = temp_db("lost_anchor");
        let audit = open_for_tests(path.clone());
        audit.append(event("pending")).unwrap();
        drop(audit);
        let reopened = reopen(&path, MemAnchor::empty()).unwrap();
        assert!(reopened.is_valid());
        assert_eq!(reopened.anchor.load().unwrap().unwrap().seq, 1);
    }
}
