//! Local secret encryption (Decisions §3, §10, §13).
//! A random master key lives in the macOS Keychain; secrets are AES-256-GCM
//! encrypted under an HKDF subkey with AAD bound to their target, in a
//! versioned blob `[version][key_id][nonce][ct‖tag]` so keys can rotate.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use std::sync::OnceLock;
use zeroize::Zeroizing;

const SERVICE: &str = "com.gatehouse.app";
const MASTER_KEY_USER: &str = "master-key";

const BLOB_VERSION: u8 = 1;
const ACTIVE_KEY_ID: u8 = 0;
const NONCE_LEN: usize = 12;
const HEADER_LEN: usize = 2;

/// Per-process cache: the Keychain is consulted once per launch, not on every
/// encrypt/decrypt. Dev builds are ad-hoc signed, so macOS re-prompts for
/// Keychain access after every rebuild — without this cache it prompted on
/// every single action touching a stored password.
static MASTER_KEY: OnceLock<[u8; 32]> = OnceLock::new();

/// Preset a fixed master key so tests never touch the real Keychain.
#[cfg(test)]
pub fn preset_master_key_for_tests() {
    let _ = MASTER_KEY.set([7u8; 32]);
}

fn master_key() -> Result<[u8; 32], CryptoError> {
    if let Some(k) = MASTER_KEY.get() {
        return Ok(*k);
    }
    let k = load_or_create_master_key()?;
    Ok(*MASTER_KEY.get_or_init(|| k))
}

/// Stable marker scanned by the frontend (src/lib/ipc.ts) to detect Keychain
/// access failures and show the blocking "app unusable" screen.
pub const KEYCHAIN_ERROR_PREFIX: &str = "keychain:";

#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("{KEYCHAIN_ERROR_PREFIX} {0}")]
    Keyring(String),
    #[error("crypto error")]
    Crypto,
    #[error("decode error")]
    Decode,
}

fn load_or_create_master_key() -> Result<[u8; 32], CryptoError> {
    let entry = keyring::Entry::new(SERVICE, MASTER_KEY_USER)
        .map_err(|e| CryptoError::Keyring(e.to_string()))?;
    match entry.get_password() {
        Ok(hex_key) => {
            let bytes = Zeroizing::new(hex::decode(hex_key).map_err(|_| CryptoError::Decode)?);
            let mut key = [0u8; 32];
            if bytes.len() != 32 {
                return Err(CryptoError::Decode);
            }
            key.copy_from_slice(&bytes);
            Ok(key)
        }
        // Only a confirmed missing entry may mint a key. A denied or failed
        // Keychain access must NOT: overwriting the entry with a fresh key
        // would make every stored password permanently undecryptable.
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            entry
                .set_password(&hex::encode(key))
                .map_err(|e| CryptoError::Keyring(e.to_string()))?;
            Ok(key)
        }
        Err(e) => Err(CryptoError::Keyring(e.to_string())),
    }
}

/// Derive the per-key-id encryption subkey from the master key (HKDF-SHA256),
/// so the master key itself never encrypts data and key ids can rotate.
fn subkey(master: &[u8; 32], key_id: u8) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    derive_labeled(
        master,
        &format!("gatehouse/secret/v{BLOB_VERSION}/{key_id}"),
    )
}

/// Derive a labeled subkey from the Keychain master key (Decisions §13 —
/// `k_audit`, `k_audit_enc`, …). Single key generation for now, matching
/// [`ACTIVE_KEY_ID`]; rotation is a documented follow-up.
pub fn labeled_key(label: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    derive_labeled(&master_key()?, label)
}

pub fn derive_labeled(master: &[u8; 32], label: &str) -> Result<Zeroizing<[u8; 32]>, CryptoError> {
    let hk = Hkdf::<Sha256>::new(None, master);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(label.as_bytes(), &mut *out)
        .map_err(|_| CryptoError::Crypto)?;
    Ok(out)
}

/// AEAD-seal raw bytes under an already-derived subkey: `nonce || ct‖tag`.
/// No version header — callers (the audit chain) version via the HKDF label.
pub fn seal_with_key(key: &[u8; 32], plaintext: &[u8], aad: &str) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Crypto)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Crypto)?;
    let mut blob = nonce_bytes.to_vec();
    blob.extend_from_slice(&ct);
    Ok(blob)
}

pub fn open_with_key(key: &[u8; 32], blob: &[u8], aad: &str) -> Result<Vec<u8>, CryptoError> {
    if blob.len() <= NONCE_LEN {
        return Err(CryptoError::Decode);
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    open_gcm(key, nonce_bytes, ct, aad)
}

fn encrypt_with_master(
    master: &[u8; 32],
    plaintext: &str,
    aad: &str,
) -> Result<String, CryptoError> {
    let key = subkey(master, ACTIVE_KEY_ID)?;
    let cipher = Aes256Gcm::new_from_slice(&*key).map_err(|_| CryptoError::Crypto)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Crypto)?;
    let mut blob = vec![BLOB_VERSION, ACTIVE_KEY_ID];
    blob.extend_from_slice(&nonce_bytes);
    blob.extend_from_slice(&ct);
    Ok(hex::encode(blob))
}

fn decrypt_with_master(
    master: &[u8; 32],
    blob_hex: &str,
    aad: &str,
) -> Result<String, CryptoError> {
    let blob = hex::decode(blob_hex).map_err(|_| CryptoError::Decode)?;
    if blob.len() > HEADER_LEN + NONCE_LEN && blob[0] == BLOB_VERSION {
        let key = subkey(master, blob[1])?;
        let (nonce_bytes, ct) = blob[HEADER_LEN..].split_at(NONCE_LEN);
        if let Ok(pt) = open_gcm(&key, nonce_bytes, ct, aad) {
            return String::from_utf8(pt).map_err(|_| CryptoError::Decode);
        }
    }
    // Legacy pre-versioning blobs: `nonce(12) || ct+tag` under the raw master
    // key. A random nonce can start with the version byte, hence the fallback
    // after an authenticated failure rather than a strict format switch.
    if blob.len() <= NONCE_LEN {
        return Err(CryptoError::Decode);
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let pt = open_gcm(master, nonce_bytes, ct, aad)?;
    String::from_utf8(pt).map_err(|_| CryptoError::Decode)
}

fn open_gcm(key: &[u8; 32], nonce: &[u8], ct: &[u8], aad: &str) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Crypto)?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Crypto)
}

/// Encrypt a secret into a hex-encoded `[version][key_id][nonce][ct‖tag]` blob.
pub fn encrypt(plaintext: &str, aad: &str) -> Result<String, CryptoError> {
    encrypt_with_master(&master_key()?, plaintext, aad)
}

/// Decrypt a blob produced by [`encrypt`] (or a legacy pre-versioning blob)
/// with the same AAD.
pub fn decrypt(blob_hex: &str, aad: &str) -> Result<String, CryptoError> {
    decrypt_with_master(&master_key()?, blob_hex, aad)
}

/// AAD binds a secret to its connection target (Decisions §10).
pub fn target_aad(host: &str, port: u16, user: &str, tls: bool) -> String {
    format!("{host}|{port}|{user}|tls={tls}")
}

/// AAD for SSH secrets (key passphrase / SSH password), bound to the SSH
/// target so retargeting the profile invalidates the blob (Decisions §10).
pub fn ssh_aad(host: &str, port: u16, user: &str) -> String {
    format!("ssh|{host}|{port}|{user}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: [u8; 32] = [7u8; 32];

    #[test]
    fn roundtrip_versioned_blob() {
        let blob = encrypt_with_master(&MASTER, "s3cret", "aad").unwrap();
        let raw = hex::decode(&blob).unwrap();
        assert_eq!(raw[0], BLOB_VERSION);
        assert_eq!(raw[1], ACTIVE_KEY_ID);
        assert_eq!(
            decrypt_with_master(&MASTER, &blob, "aad").unwrap(),
            "s3cret"
        );
    }

    #[test]
    fn wrong_aad_or_key_fails() {
        let blob = encrypt_with_master(&MASTER, "s3cret", "host|5432|user|tls=false").unwrap();
        assert!(decrypt_with_master(&MASTER, &blob, "other|5432|user|tls=false").is_err());
        assert!(decrypt_with_master(&[8u8; 32], &blob, "host|5432|user|tls=false").is_err());
    }

    #[test]
    fn tampered_blob_fails() {
        let blob = encrypt_with_master(&MASTER, "s3cret", "aad").unwrap();
        let mut raw = hex::decode(&blob).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0xff;
        assert!(decrypt_with_master(&MASTER, &hex::encode(raw), "aad").is_err());
    }

    #[test]
    fn legacy_unversioned_blob_still_decrypts() {
        let cipher = Aes256Gcm::new_from_slice(&MASTER).unwrap();
        let nonce = [3u8; NONCE_LEN];
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: b"old-secret",
                    aad: b"aad",
                },
            )
            .unwrap();
        let mut blob = nonce.to_vec();
        blob.extend_from_slice(&ct);
        assert_eq!(
            decrypt_with_master(&MASTER, &hex::encode(blob), "aad").unwrap(),
            "old-secret"
        );
    }
}
