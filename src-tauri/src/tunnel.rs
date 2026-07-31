//! SSH tunnels (Decisions §6: managed by the app via `russh`, never by the
//! agent; §10: app-owned host-key store, hard failure when a key changes,
//! read-only import of `~/.ssh/known_hosts`, private keys referenced by path
//! with 0600 permissions enforced).
//!
//! One tunnel per profile, shared by every connection of that profile: a local
//! listener on `127.0.0.1:0` forwards each accepted connection through a
//! `direct-tcpip` channel to the database host as seen from the SSH server.

use crate::store::Store;
use russh::client;
use russh::keys::{self, HashAlg, PublicKey};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE: Duration = Duration::from_secs(30);

pub struct Tunnel {
    pub local_port: u16,
    sig: String,
    closed: Arc<AtomicBool>,
    tasks: Vec<tokio::task::AbortHandle>,
}

impl Tunnel {
    fn is_alive(&self, sig: &str) -> bool {
        self.sig == sig && !self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("gatehouse-ssh")
            .enable_io()
            .enable_time()
            .build()
            .expect("failed to build SSH runtime")
    })
}

fn manager() -> &'static Mutex<HashMap<String, Arc<Tunnel>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Tunnel>>>> = OnceLock::new();
    M.get_or_init(Mutex::default)
}

/// Everything needed to establish a tunnel, resolved from the profile before
/// entering async code (no Store access inside the runtime).
struct Spec {
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    key_path: String,
    secret: Option<String>,
    db_host: String,
    db_port: u16,
}

impl Spec {
    fn sig(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}",
            self.ssh_host, self.ssh_port, self.ssh_user, self.key_path, self.db_host, self.db_port
        )
    }
}

fn fingerprint_of(openssh: &str) -> String {
    PublicKey::from_openssh(openssh)
        .map(|k| k.fingerprint(HashAlg::Sha256).to_string())
        .unwrap_or_else(|_| "<unparseable stored key>".to_string())
}

/// Host-key policy: exact match against the app store when a key is recorded;
/// otherwise `~/.ssh/known_hosts` is consulted (read-only import) and unknown
/// hosts are accepted-and-recorded (TOFU). A changed key is a hard failure.
struct HostKeyCheck {
    host: String,
    port: u16,
    expected: Option<String>,
    learned: Arc<Mutex<Option<String>>>,
    mismatch: Arc<Mutex<Option<String>>>,
}

impl client::Handler for HostKeyCheck {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let Ok(offered) = key.to_openssh() else {
            return Ok(false);
        };
        let offered_fp = key.fingerprint(HashAlg::Sha256).to_string();
        if let Some(expected) = &self.expected {
            if *expected == offered {
                return Ok(true);
            }
            *self.mismatch.lock().unwrap() = Some(format!(
                "SSH host key for {}:{} has CHANGED — expected {}, got {offered_fp}. \
                 Refusing to connect (fail-closed). If the server was legitimately \
                 reinstalled, remove the recorded key and reconnect.",
                self.host,
                self.port,
                fingerprint_of(expected),
            ));
            return Ok(false);
        }
        match keys::known_hosts::check_known_hosts(&self.host, self.port, key) {
            // Known and matching in ~/.ssh/known_hosts, or unknown host:
            // accept and record in the app store (trust on first use).
            Ok(_) => {}
            Err(keys::Error::KeyChanged { line }) => {
                *self.mismatch.lock().unwrap() = Some(format!(
                    "SSH host key for {}:{} does not match ~/.ssh/known_hosts (line {line}) — \
                     refusing to connect (fail-closed).",
                    self.host, self.port,
                ));
                return Ok(false);
            }
            // No known_hosts file / unreadable: fall through to TOFU.
            Err(_) => {}
        }
        *self.learned.lock().unwrap() = Some(offered);
        Ok(true)
    }
}

fn expand_home(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    path.to_string()
}

#[cfg(unix)]
fn ensure_key_permissions(path: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("cannot read SSH key `{path}`: {e}"))?;
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(format!(
            "SSH key `{path}` is readable by other users — run `chmod 600` on it (fail-closed)"
        ));
    }
    Ok(())
}

async fn authenticate(
    handle: &mut client::Handle<HostKeyCheck>,
    spec: &Spec,
) -> Result<(), String> {
    let user = spec.ssh_user.clone();
    let mut tried: Vec<&str> = Vec::new();

    if !spec.key_path.trim().is_empty() {
        let path = expand_home(spec.key_path.trim());
        ensure_key_permissions(&path)?;
        let key = keys::load_secret_key(&path, spec.secret.as_deref()).map_err(|e| {
            format!("cannot load SSH key `{path}`: {e} (wrong passphrase or unsupported format?)")
        })?;
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| e.to_string())?
            .flatten();
        let res = handle
            .authenticate_publickey(user, keys::PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await
            .map_err(|e| e.to_string())?;
        return match res {
            russh::client::AuthResult::Success => Ok(()),
            _ => Err(format!(
                "SSH server refused the key `{path}` for user `{}`",
                spec.ssh_user
            )),
        };
    }

    if let Ok(mut agent) = keys::agent::client::AgentClient::connect_env().await {
        tried.push("ssh-agent");
        if let Ok(identities) = agent.request_identities().await {
            for identity in identities {
                let keys::agent::AgentIdentity::PublicKey { key, .. } = identity else {
                    continue;
                };
                let hash = handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| e.to_string())?
                    .flatten();
                let res = handle
                    .authenticate_publickey_with(user.clone(), key, hash, &mut agent)
                    .await;
                if matches!(res, Ok(russh::client::AuthResult::Success)) {
                    return Ok(());
                }
            }
        }
    }

    if let Some(secret) = &spec.secret {
        tried.push("password");
        let res = handle
            .authenticate_password(user, secret.clone())
            .await
            .map_err(|e| e.to_string())?;
        if matches!(res, russh::client::AuthResult::Success) {
            return Ok(());
        }
    }

    if tried.is_empty() {
        Err(
            "no SSH authentication method available — set a key path, load a key \
             into ssh-agent, or store an SSH password"
                .to_string(),
        )
    } else {
        Err(format!(
            "SSH authentication failed for user `{}` (tried: {})",
            spec.ssh_user,
            tried.join(", ")
        ))
    }
}

async fn establish(
    spec: Spec,
    expected: Option<String>,
) -> Result<(Tunnel, Option<String>), String> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(KEEPALIVE),
        ..Default::default()
    });
    let learned = Arc::new(Mutex::new(None));
    let mismatch: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = HostKeyCheck {
        host: spec.ssh_host.clone(),
        port: spec.ssh_port,
        expected,
        learned: learned.clone(),
        mismatch: mismatch.clone(),
    };

    let connect = client::connect(config, (spec.ssh_host.as_str(), spec.ssh_port), handler);
    let mut handle = match tokio::time::timeout(CONNECT_TIMEOUT, connect).await {
        Ok(Ok(h)) => h,
        Ok(Err(e)) => {
            let detail = mismatch.lock().unwrap().take();
            return Err(detail.unwrap_or_else(|| {
                format!(
                    "SSH connection to {}:{} failed: {e}",
                    spec.ssh_host, spec.ssh_port
                )
            }));
        }
        Err(_) => {
            return Err(format!(
                "SSH connection to {}:{} timed out",
                spec.ssh_host, spec.ssh_port
            ))
        }
    };

    authenticate(&mut handle, &spec).await?;

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("cannot bind local tunnel port: {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let closed = Arc::new(AtomicBool::new(false));
    let accept_closed = closed.clone();
    let db_host = spec.db_host.clone();
    let db_port = spec.db_port;
    let accept = tokio::spawn(async move {
        loop {
            let Ok((mut sock, peer)) = listener.accept().await else {
                accept_closed.store(true, Ordering::SeqCst);
                break;
            };
            let channel = handle
                .channel_open_direct_tcpip(
                    db_host.clone(),
                    u32::from(db_port),
                    "127.0.0.1",
                    u32::from(peer.port()),
                )
                .await;
            match channel {
                Ok(ch) => {
                    tokio::spawn(async move {
                        let mut stream = ch.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                    });
                }
                // The SSH session is gone: mark the tunnel dead so the next
                // call re-establishes it (never a silent per-query retry).
                Err(_) => {
                    accept_closed.store(true, Ordering::SeqCst);
                    break;
                }
            }
        }
    });

    let sig = spec.sig();
    let learned_key = learned.lock().unwrap().take();
    Ok((
        Tunnel {
            local_port,
            sig,
            closed,
            tasks: vec![accept.abort_handle()],
        },
        learned_key,
    ))
}

/// Return the local port of a live tunnel for this profile, establishing it if
/// needed. Blocking (SSH handshake) — must be called off the main thread.
pub fn ensure(
    store: &Store,
    profile_id: &str,
    ssh_host: &str,
    ssh_port: u16,
    ssh_user: &str,
    ssh_key_path: &str,
    secret_override: Option<String>,
    db_host: &str,
    db_port: u16,
) -> Result<u16, String> {
    let spec = Spec {
        ssh_host: ssh_host.trim().to_string(),
        ssh_port,
        ssh_user: ssh_user.trim().to_string(),
        key_path: ssh_key_path.to_string(),
        secret: match secret_override {
            Some(s) if !s.is_empty() => Some(s),
            _ => store.ssh_secret(profile_id).map_err(|e| e.to_string())?,
        },
        db_host: db_host.to_string(),
        db_port,
    };
    let sig = spec.sig();

    if let Some(existing) = manager().lock().unwrap().get(profile_id) {
        if existing.is_alive(&sig) {
            return Ok(existing.local_port);
        }
    }

    let expected = store
        .ssh_host_key(&spec.ssh_host, spec.ssh_port)
        .map_err(|e| e.to_string())?;
    let first_contact = expected.is_none();
    let (tunnel, learned) = runtime().block_on(establish(spec, expected))?;
    if first_contact {
        if let Some(key) = learned {
            store
                .set_ssh_host_key(ssh_host.trim(), ssh_port, &key)
                .map_err(|e| e.to_string())?;
        }
    }

    let mut map = manager().lock().unwrap();
    // A concurrent caller may have established a tunnel meanwhile — keep the
    // winner, drop ours (Drop aborts its tasks).
    if let Some(existing) = map.get(profile_id) {
        if existing.is_alive(&tunnel.sig) {
            return Ok(existing.local_port);
        }
    }
    let port = tunnel.local_port;
    map.insert(profile_id.to_string(), Arc::new(tunnel));
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: needs a reachable sshd + env vars — GATEHOUSE_SSH_HOST/USER
    // (optional GATEHOUSE_SSH_PORT/KEY/SECRET) and a TCP service to reach
    // through the tunnel via GATEHOUSE_SSH_DB_HOST/DB_PORT (defaults to the
    // SSH host's port 5432). Run: cargo test -- --ignored
    #[test]
    #[ignore = "needs a reachable sshd (see GATEHOUSE_SSH_* env vars)"]
    fn tunnel_forwards_tcp_end_to_end() {
        crate::crypto::preset_master_key_for_tests();
        let host = std::env::var("GATEHOUSE_SSH_HOST").expect("GATEHOUSE_SSH_HOST");
        let user = std::env::var("GATEHOUSE_SSH_USER").expect("GATEHOUSE_SSH_USER");
        let port: u16 = std::env::var("GATEHOUSE_SSH_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(22);
        let key_path = std::env::var("GATEHOUSE_SSH_KEY").unwrap_or_default();
        let secret = std::env::var("GATEHOUSE_SSH_SECRET").ok();
        let db_host = std::env::var("GATEHOUSE_SSH_DB_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let db_port: u16 = std::env::var("GATEHOUSE_SSH_DB_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(5432);

        let store_path = std::env::temp_dir().join("gatehouse_tunnel_test_store.db");
        let _ = std::fs::remove_file(&store_path);
        let store = Store::open_at(store_path).unwrap();

        let local_port = ensure(
            &store,
            "p_tunnel_test",
            &host,
            port,
            &user,
            &key_path,
            secret.clone(),
            &db_host,
            db_port,
        )
        .unwrap();
        // TOFU: the host key must have been recorded on first contact.
        assert!(store.ssh_host_key(&host, port).unwrap().is_some());
        // The local end must accept TCP connections.
        assert!(std::net::TcpStream::connect(("127.0.0.1", local_port)).is_ok());
        // Second call reuses the same tunnel.
        let again = ensure(
            &store,
            "p_tunnel_test",
            &host,
            port,
            &user,
            &key_path,
            secret,
            &db_host,
            db_port,
        )
        .unwrap();
        assert_eq!(local_port, again);
    }
}
