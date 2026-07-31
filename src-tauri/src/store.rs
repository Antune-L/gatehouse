//! Local profile + settings store — a single SQLite file in the app data dir
//! (Decisions §3). Passwords live in an AES-GCM encrypted column; the master
//! key is in the Keychain (see crypto.rs). Credentials only ever exist in clear
//! in process memory.

use crate::crypto;
use rand::RngCore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub group: String,
    pub color: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub environment: String,
    pub ssl: bool,
    pub ssh_tunnel: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    #[serde(default)]
    pub ssh_key_path: String,
    pub read_only: bool,
    pub agent_access: bool,
    pub save_password: bool,
}

fn default_ssh_port() -> u16 {
    22
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("crypto: {0}")]
    Crypto(#[from] crypto::CryptoError),
    #[error("no app data dir")]
    NoDataDir,
    #[error("stored secrets were encrypted with a different master key — re-save the password")]
    KeyMismatch,
}

/// Canary blob (Decisions §13): a known value encrypted at first use, so a
/// Keychain key loss/regeneration is diagnosed as such instead of surfacing
/// as opaque per-password decrypt failures.
const CANARY_KEY: &str = "crypto_canary";
const CANARY_AAD: &str = "gatehouse-canary";
const CANARY_VALUE: &str = "gatehouse";

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub fn open() -> Result<Self, StoreError> {
        let dir = data_dir()?;
        std::fs::create_dir_all(&dir).ok();
        Self::open_at(dir.join("gatehouse.db"))
    }

    pub fn open_at(path: PathBuf) -> Result<Self, StoreError> {
        let conn = Connection::open(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                engine TEXT NOT NULL,
                grp TEXT NOT NULL,
                color TEXT NOT NULL,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                usr TEXT NOT NULL,
                database TEXT NOT NULL,
                environment TEXT NOT NULL,
                ssl INTEGER NOT NULL,
                ssh_tunnel INTEGER NOT NULL,
                ssh_host TEXT NOT NULL DEFAULT '',
                ssh_port INTEGER NOT NULL DEFAULT 22,
                ssh_user TEXT NOT NULL DEFAULT '',
                ssh_key_path TEXT NOT NULL DEFAULT '',
                read_only INTEGER NOT NULL,
                agent_access INTEGER NOT NULL,
                save_password INTEGER NOT NULL,
                password_enc TEXT,
                ssh_secret_enc TEXT
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS mcp_clients (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL,
                last_activity INTEGER,
                revoked INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS ssh_known_hosts (
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                key TEXT NOT NULL,
                first_seen INTEGER NOT NULL,
                PRIMARY KEY (host, port)
            );",
        )?;
        migrate_profiles_ssh(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn upsert(
        &self,
        p: &Profile,
        password: Option<&str>,
        ssh_secret: Option<&str>,
    ) -> Result<(), StoreError> {
        let password_enc = match (p.save_password, password) {
            (true, Some(pw)) if !pw.is_empty() => {
                let aad = crypto::target_aad(&p.host, p.port, &p.user, p.ssl);
                let enc = crypto::encrypt(pw, &aad)?;
                self.ensure_canary()?;
                Some(enc)
            }
            _ => None,
        };
        // The SSH secret (key passphrase or SSH password) is bound to the SSH
        // target, like the DB password is bound to the DB target (Decisions
        // §10: AAD étendue à la cible SSH).
        let ssh_secret_enc = match ssh_secret {
            Some(s) if !s.is_empty() && p.ssh_tunnel => {
                let aad = crypto::ssh_aad(&p.ssh_host, p.ssh_port, &p.ssh_user);
                let enc = crypto::encrypt(s, &aad)?;
                self.ensure_canary()?;
                Some(enc)
            }
            _ => None,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO profiles
                (id,name,engine,grp,color,host,port,usr,database,environment,ssl,ssh_tunnel,
                 ssh_host,ssh_port,ssh_user,ssh_key_path,
                 read_only,agent_access,save_password,password_enc,ssh_secret_enc)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21)
             ON CONFLICT(id) DO UPDATE SET
                name=?2,engine=?3,grp=?4,color=?5,host=?6,port=?7,usr=?8,database=?9,
                environment=?10,ssl=?11,ssh_tunnel=?12,
                ssh_host=?13,ssh_port=?14,ssh_user=?15,ssh_key_path=?16,
                read_only=?17,agent_access=?18,save_password=?19,
                password_enc=COALESCE(?20,password_enc),
                ssh_secret_enc=COALESCE(?21,ssh_secret_enc)",
            rusqlite::params![
                p.id,
                p.name,
                p.engine,
                p.group,
                p.color,
                p.host,
                p.port,
                p.user,
                p.database,
                p.environment,
                p.ssl as i32,
                p.ssh_tunnel as i32,
                p.ssh_host,
                p.ssh_port,
                p.ssh_user,
                p.ssh_key_path,
                p.read_only as i32,
                p.agent_access as i32,
                p.save_password as i32,
                password_enc,
                ssh_secret_enc
            ],
        )?;
        Ok(())
    }

    fn ensure_canary(&self) -> Result<(), StoreError> {
        if self.setting(CANARY_KEY)?.is_none() {
            self.set_setting(CANARY_KEY, &crypto::encrypt(CANARY_VALUE, CANARY_AAD)?)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<Profile>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id,name,engine,grp,color,host,port,usr,database,environment,ssl,ssh_tunnel,ssh_host,ssh_port,ssh_user,ssh_key_path,read_only,agent_access,save_password FROM profiles ORDER BY grp,name",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    engine: r.get(2)?,
                    group: r.get(3)?,
                    color: r.get(4)?,
                    host: r.get(5)?,
                    port: r.get::<_, i64>(6)? as u16,
                    user: r.get(7)?,
                    database: r.get(8)?,
                    environment: r.get(9)?,
                    ssl: r.get::<_, i32>(10)? != 0,
                    ssh_tunnel: r.get::<_, i32>(11)? != 0,
                    ssh_host: r.get(12)?,
                    ssh_port: r.get::<_, i64>(13)? as u16,
                    ssh_user: r.get(14)?,
                    ssh_key_path: r.get(15)?,
                    read_only: r.get::<_, i32>(16)? != 0,
                    agent_access: r.get::<_, i32>(17)? != 0,
                    save_password: r.get::<_, i32>(18)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM profiles WHERE id=?1", [id])?;
        Ok(())
    }

    /// Decrypt a stored password — only ever called just before opening a
    /// connection, never returned to the frontend or the MCP layer.
    pub fn password(&self, id: &str) -> Result<Option<String>, StoreError> {
        // NOTE: the lock must be released before the canary check below —
        // `setting()` re-locks the same mutex and would self-deadlock.
        let row: Option<(String, String, u16, String, i32)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT password_enc,host,port,usr,ssl FROM profiles WHERE id=?1 AND password_enc IS NOT NULL",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u16, r.get(3)?, r.get(4)?)),
            )
            .ok()
        };
        match row {
            Some((enc, host, port, user, ssl)) => {
                let aad = crypto::target_aad(&host, port, &user, ssl != 0);
                match crypto::decrypt(&enc, &aad) {
                    Ok(pw) => Ok(Some(pw)),
                    // A Keychain access failure is not a key mismatch — it is
                    // recoverable by granting access, so it must keep its
                    // `keychain:` marker for the frontend.
                    Err(e @ crypto::CryptoError::Keyring(_)) => Err(e.into()),
                    // Any other decrypt failure means this blob cannot be
                    // read with the current master key (key regenerated, or
                    // blob corrupt — profiles saved before the canary existed
                    // can't tell the difference). The remedy is identical:
                    // re-save the password.
                    Err(_) => Err(StoreError::KeyMismatch),
                }
            }
            None => Ok(None),
        }
    }

    /// Decrypt the stored SSH secret (key passphrase or SSH password) — same
    /// contract as [`Store::password`].
    pub fn ssh_secret(&self, id: &str) -> Result<Option<String>, StoreError> {
        let row: Option<(String, String, u16, String)> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT ssh_secret_enc,ssh_host,ssh_port,ssh_user FROM profiles WHERE id=?1 AND ssh_secret_enc IS NOT NULL",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)? as u16, r.get(3)?)),
            )
            .ok()
        };
        match row {
            Some((enc, host, port, user)) => {
                match crypto::decrypt(&enc, &crypto::ssh_aad(&host, port, &user)) {
                    Ok(secret) => Ok(Some(secret)),
                    Err(e @ crypto::CryptoError::Keyring(_)) => Err(e.into()),
                    Err(_) => Err(StoreError::KeyMismatch),
                }
            }
            None => Ok(None),
        }
    }

    /// App-owned SSH host-key store (Decisions §10): openssh-format public key
    /// recorded at first contact, exact-matched afterwards.
    pub fn ssh_host_key(&self, host: &str, port: u16) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let key = conn
            .query_row(
                "SELECT key FROM ssh_known_hosts WHERE host=?1 AND port=?2",
                rusqlite::params![host, port],
                |r| r.get(0),
            )
            .ok();
        Ok(key)
    }

    pub fn set_ssh_host_key(&self, host: &str, port: u16, key: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO ssh_known_hosts (host, port, key, first_seen) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(host, port) DO UPDATE SET key=?3",
            rusqlite::params![host, port, key, now()],
        )?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let value = conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .ok();
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value=?2",
            [key, value],
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientRow {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    pub last_activity: Option<u64>,
    pub revoked: bool,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn map_mcp_client_row(r: &rusqlite::Row) -> rusqlite::Result<McpClientRow> {
    Ok(McpClientRow {
        id: r.get(0)?,
        name: r.get(1)?,
        created_at: r.get(2)?,
        last_activity: r.get(3)?,
        revoked: r.get::<_, i32>(4)? != 0,
    })
}

impl Store {
    /// Pair a new MCP client. The 32-byte token is returned exactly once —
    /// only its SHA-256 hash is stored, so it is never recoverable later
    /// (Decisions §13: a lost token is replaced by re-pairing).
    pub fn mcp_pair(&self, name: &str) -> Result<(McpClientRow, String), StoreError> {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let token = hex::encode(raw);
        // The id must not be derived from the token — it is displayed in the
        // UI while the token hash is the credential.
        let mut id_bytes = [0u8; 6];
        rand::thread_rng().fill_bytes(&mut id_bytes);
        let row = McpClientRow {
            id: format!("mc_{}", hex::encode(id_bytes)),
            name: name.to_string(),
            created_at: now(),
            last_activity: None,
            revoked: false,
        };
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO mcp_clients (id, name, token_hash, created_at, revoked)
             VALUES (?1, ?2, ?3, ?4, 0)",
            rusqlite::params![row.id, row.name, token_hash(&token), row.created_at],
        )?;
        Ok((row, token))
    }

    pub fn mcp_clients(&self) -> Result<Vec<McpClientRow>, StoreError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, name, created_at, last_activity, revoked
             FROM mcp_clients ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], map_mcp_client_row)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// Resolve a presented pairing token to its active (non-revoked) client.
    /// Revocation is re-checked on every call, so it takes effect immediately.
    pub fn mcp_client_for_token(&self, token: &str) -> Result<Option<McpClientRow>, StoreError> {
        let hash = token_hash(token);
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT id, name, created_at, last_activity, revoked
                 FROM mcp_clients WHERE token_hash = ?1 AND revoked = 0",
                [hash],
                map_mcp_client_row,
            )
            .ok();
        Ok(row)
    }

    pub fn mcp_revoke(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE mcp_clients SET revoked = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn mcp_touch(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE mcp_clients SET last_activity = ?1 WHERE id = ?2",
            rusqlite::params![now(), id],
        )?;
        Ok(())
    }
}

/// Pre-SSH databases lack the ssh_* profile columns — add them in place.
fn migrate_profiles_ssh(conn: &Connection) -> Result<(), StoreError> {
    let mut stmt = conn.prepare("PRAGMA table_info(profiles)")?;
    let has_ssh_host = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|c| c == "ssh_host");
    if !has_ssh_host {
        conn.execute_batch(
            "ALTER TABLE profiles ADD COLUMN ssh_host TEXT NOT NULL DEFAULT '';
             ALTER TABLE profiles ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
             ALTER TABLE profiles ADD COLUMN ssh_user TEXT NOT NULL DEFAULT '';
             ALTER TABLE profiles ADD COLUMN ssh_key_path TEXT NOT NULL DEFAULT '';
             ALTER TABLE profiles ADD COLUMN ssh_secret_enc TEXT;",
        )?;
    }
    Ok(())
}

fn data_dir() -> Result<PathBuf, StoreError> {
    dirs::data_dir()
        .map(|d| d.join("Gatehouse"))
        .ok_or(StoreError::NoDataDir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(name: &str) -> Store {
        let p = std::env::temp_dir().join(format!("gatehouse_store_{name}.db"));
        let _ = std::fs::remove_file(&p);
        Store::open_at(p).unwrap()
    }

    // NOTE: regression test — this used to self-deadlock: `password()` held the
    // store lock while the decrypt-failure path called `setting()`.
    #[test]
    fn password_decrypt_failure_reports_key_mismatch_without_deadlock() {
        crypto::preset_master_key_for_tests();
        let store = temp_store("pw_mismatch");
        store.set_setting(CANARY_KEY, "deadbeef").unwrap();
        {
            let conn = store.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO profiles (id,name,engine,grp,color,host,port,usr,database,environment,ssl,ssh_tunnel,read_only,agent_access,save_password,password_enc)
                 VALUES ('p1','P','postgres','g','green','h',5432,'u','db','development',0,0,1,0,1,'deadbeef')",
                [],
            )
            .unwrap();
        }
        assert!(matches!(store.password("p1"), Err(StoreError::KeyMismatch)));
    }

    #[test]
    fn ssh_secret_roundtrips_and_is_bound_to_the_ssh_target() {
        crypto::preset_master_key_for_tests();
        let store = temp_store("ssh_secret");
        let profile = Profile {
            id: "p_ssh".into(),
            name: "P".into(),
            engine: "postgres".into(),
            group: "g".into(),
            color: "green".into(),
            host: "db.internal".into(),
            port: 5432,
            user: "app".into(),
            database: "appdb".into(),
            environment: "development".into(),
            ssl: false,
            ssh_tunnel: true,
            ssh_host: "bastion".into(),
            ssh_port: 22,
            ssh_user: "ali".into(),
            ssh_key_path: "~/.ssh/id_ed25519".into(),
            read_only: false,
            agent_access: false,
            save_password: false,
        };
        store.upsert(&profile, None, Some("passphrase")).unwrap();
        assert_eq!(store.ssh_secret("p_ssh").unwrap().unwrap(), "passphrase");

        // Re-saving without a secret keeps the stored one (COALESCE).
        store.upsert(&profile, None, None).unwrap();
        assert_eq!(store.ssh_secret("p_ssh").unwrap().unwrap(), "passphrase");

        // Retargeting the SSH host invalidates the blob (AAD) → KeyMismatch.
        let mut moved = profile.clone();
        moved.ssh_host = "other-bastion".into();
        store.upsert(&moved, None, None).unwrap();
        assert!(matches!(
            store.ssh_secret("p_ssh"),
            Err(StoreError::KeyMismatch)
        ));
    }

    #[test]
    fn ssh_host_keys_are_recorded_and_replaced() {
        let store = temp_store("ssh_hosts");
        assert!(store.ssh_host_key("bastion", 22).unwrap().is_none());
        store
            .set_ssh_host_key("bastion", 22, "ssh-ed25519 AAAA1")
            .unwrap();
        assert_eq!(
            store.ssh_host_key("bastion", 22).unwrap().unwrap(),
            "ssh-ed25519 AAAA1"
        );
        // Distinct port = distinct identity.
        assert!(store.ssh_host_key("bastion", 2222).unwrap().is_none());
        store
            .set_ssh_host_key("bastion", 22, "ssh-ed25519 AAAA2")
            .unwrap();
        assert_eq!(
            store.ssh_host_key("bastion", 22).unwrap().unwrap(),
            "ssh-ed25519 AAAA2"
        );
    }

    #[test]
    fn mcp_pairing_token_roundtrip_and_revocation() {
        let store = temp_store("mcp_pair");
        let (client, token) = store.mcp_pair("claude-code").unwrap();
        assert_eq!(token.len(), 64);
        assert!(!client.id.contains(&token[..8]));

        let resolved = store.mcp_client_for_token(&token).unwrap().unwrap();
        assert_eq!(resolved.id, client.id);
        assert!(store.mcp_client_for_token("deadbeef").unwrap().is_none());

        store.mcp_revoke(&client.id).unwrap();
        assert!(store.mcp_client_for_token(&token).unwrap().is_none());
        assert!(store.mcp_clients().unwrap()[0].revoked);
    }

    #[test]
    fn mcp_token_is_stored_hashed_only() {
        let store = temp_store("mcp_hash");
        let (_, token) = store.mcp_pair("codex").unwrap();
        let conn = store.conn.lock().unwrap();
        let stored: String = conn
            .query_row("SELECT token_hash FROM mcp_clients", [], |r| r.get(0))
            .unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored, token_hash(&token));
    }
}
