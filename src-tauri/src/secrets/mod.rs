//! OS-native secret storage (macOS Keychain / Windows Credential Manager) via
//! the `keyring` crate — NEVER plaintext files. Replaces Electron's
//! `safeStorage`.
//!
//! OAuth tokens (Drive/YouTube/Gmail) and stream keys are written here in later
//! phases (6/7); Phase 0 establishes the seam and the resolution precedence so
//! the rest of the app has one place to reach for a credential.

use keyring::Entry;

use crate::error::{AppError, AppResult};

/// Keychain service name — matches the Tauri bundle identifier so credentials
/// are namespaced to this app.
const SERVICE: &str = "no.sundayrec.app";

/// The credentials SundayRec stores. Each maps to a stable keychain *account*
/// under [`SERVICE`]; renaming a variant's account orphans existing entries, so
/// treat these strings as a storage contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretProvider {
    /// Google Drive OAuth refresh token (cloud backup / upload).
    GoogleDrive,
    /// YouTube OAuth refresh token (publish / live).
    YouTube,
    /// Gmail OAuth refresh token (notification mailer).
    Gmail,
    /// RTMP stream key (live streaming).
    StreamKey,
    /// SMTP password for the email-alert mailer (never persisted in settings;
    /// mirrors the Electron `emailSmtpPassEnc` keychain slot).
    SmtpPassword,
    /// SundaySong / SundayPlan API key (bearer). Encrypted in the keychain, never
    /// in the integration-settings blob — mirrors the Electron `setSongApiKey`.
    SongApiKey,
}

impl SecretProvider {
    /// The keychain account string for this provider.
    fn account(self) -> &'static str {
        match self {
            SecretProvider::GoogleDrive => "oauth.google_drive",
            SecretProvider::YouTube => "oauth.youtube",
            SecretProvider::Gmail => "oauth.gmail",
            SecretProvider::StreamKey => "stream.key",
            SecretProvider::SmtpPassword => "email.smtp_password",
            SecretProvider::SongApiKey => "integrations.song_api_key",
        }
    }

    /// All providers — handy for a "disconnect everything" sweep.
    pub fn all() -> [SecretProvider; 6] {
        [
            SecretProvider::GoogleDrive,
            SecretProvider::YouTube,
            SecretProvider::Gmail,
            SecretProvider::StreamKey,
            SecretProvider::SmtpPassword,
            SecretProvider::SongApiKey,
        ]
    }
}

fn entry(provider: SecretProvider) -> AppResult<Entry> {
    Entry::new(SERVICE, provider.account())
        .map_err(|e| AppError::Internal(format!("keychain entry: {e}")))
}

/// Store (or replace) a provider's secret.
pub fn set(provider: SecretProvider, value: &str) -> AppResult<()> {
    entry(provider)?
        .set_password(value)
        .map_err(|e| AppError::Internal(format!("keychain set: {e}")))
}

/// Read a provider's secret, or `None` if unset / unreadable.
pub fn get(provider: SecretProvider) -> Option<String> {
    entry(provider).ok()?.get_password().ok()
}

/// Whether a provider currently has a stored secret.
pub fn has(provider: SecretProvider) -> bool {
    get(provider).is_some()
}

/// Delete a provider's secret. A missing entry is success, not an error.
pub fn delete(provider: SecretProvider) -> AppResult<()> {
    match entry(provider)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Internal(format!("keychain delete: {e}"))),
    }
}

// ── Per-destination stream keys (R3) ──────────────────────────────────────────
//
// Live streaming pushes to MANY destinations, each with its own key — the single
// [`SecretProvider::StreamKey`] slot isn't enough. We namespace each destination
// under its own keychain account derived from the destination id. Mirrors the
// Electron `stream-keys.ts` per-`destId` store, but in the OS keychain (never a
// plaintext JSON file).

/// The keychain account for a destination's stream key. Pure so the namespacing
/// (and the fact that ids are kept distinct from the OAuth accounts above) is
/// unit-tested without a real keychain.
fn stream_key_account(dest_id: &str) -> String {
    format!("stream.key.{dest_id}")
}

fn stream_key_entry(dest_id: &str) -> AppResult<Entry> {
    Entry::new(SERVICE, &stream_key_account(dest_id))
        .map_err(|e| AppError::Internal(format!("keychain entry: {e}")))
}

/// Store (or replace) a destination's stream key.
pub fn set_stream_key(dest_id: &str, key: &str) -> AppResult<()> {
    stream_key_entry(dest_id)?
        .set_password(key)
        .map_err(|e| AppError::Internal(format!("keychain set: {e}")))
}

/// Read a destination's stream key, or `None` when unset/unreadable.
pub fn get_stream_key(dest_id: &str) -> Option<String> {
    stream_key_entry(dest_id).ok()?.get_password().ok()
}

/// Whether a destination has a stored stream key (drives the UI's "saved" badge).
pub fn has_stream_key(dest_id: &str) -> bool {
    get_stream_key(dest_id).is_some()
}

/// Delete a destination's stream key. A missing entry is success.
pub fn delete_stream_key(dest_id: &str) -> AppResult<()> {
    match stream_key_entry(dest_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Internal(format!("keychain delete: {e}"))),
    }
}

/// Resolve a credential from, in order: an explicit value (a non-blank override
/// the caller already holds), the keychain, then an environment variable. Pure
/// over its inputs so the precedence is unit-tested without a real keychain.
pub fn resolve(explicit: Option<String>, provider: SecretProvider, env_var: &str) -> String {
    resolve_from(explicit, get(provider), std::env::var(env_var).ok())
}

/// The pure precedence used by [`resolve`]: explicit → keychain → env → empty.
/// Blank/whitespace-only values are treated as unset so an empty override falls
/// through instead of masking a real stored secret.
fn resolve_from(explicit: Option<String>, keychain: Option<String>, env: Option<String>) -> String {
    [explicit, keychain, env]
        .into_iter()
        .flatten()
        .find(|v| !v.trim().is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_value_wins() {
        let got = resolve_from(
            Some("explicit".into()),
            Some("keychain".into()),
            Some("env".into()),
        );
        assert_eq!(got, "explicit");
    }

    #[test]
    fn blank_explicit_falls_through_to_keychain() {
        let got = resolve_from(
            Some("   ".into()),
            Some("keychain".into()),
            Some("env".into()),
        );
        assert_eq!(got, "keychain");
    }

    #[test]
    fn keychain_beats_env() {
        let got = resolve_from(None, Some("keychain".into()), Some("env".into()));
        assert_eq!(got, "keychain");
    }

    #[test]
    fn env_is_last_resort() {
        let got = resolve_from(None, None, Some("env".into()));
        assert_eq!(got, "env");
    }

    #[test]
    fn nothing_set_yields_empty() {
        assert_eq!(resolve_from(None, None, None), "");
        assert_eq!(resolve_from(Some("".into()), None, Some("  ".into())), "");
    }

    #[test]
    fn stream_key_accounts_are_namespaced_and_distinct_from_oauth() {
        assert_eq!(stream_key_account("yt"), "stream.key.yt");
        assert_ne!(stream_key_account("a"), stream_key_account("b"));
        // Must not collide with the single OAuth StreamKey slot's account.
        assert_ne!(stream_key_account("x"), SecretProvider::StreamKey.account());
    }

    // Tolerant: exercise the REAL keychain for a per-destination key when one is
    // reachable, otherwise skip so headless CI stays green.
    #[test]
    fn real_stream_key_round_trip_or_skip() {
        let id = "sundayrec-test-dest";
        let sentinel = "stream-key-sentinel-1234";
        match set_stream_key(id, sentinel) {
            Ok(()) => {
                assert_eq!(get_stream_key(id).as_deref(), Some(sentinel));
                assert!(has_stream_key(id));
                delete_stream_key(id).expect("delete should succeed");
                assert!(!has_stream_key(id));
            }
            Err(e) => eprintln!("SKIP: no reachable keychain: {e}"),
        }
    }

    #[test]
    fn provider_accounts_are_distinct() {
        let mut accounts: Vec<&str> = SecretProvider::all().iter().map(|p| p.account()).collect();
        let count = accounts.len();
        accounts.sort_unstable();
        accounts.dedup();
        assert_eq!(accounts.len(), count, "provider accounts must be unique");
    }

    // Tolerant integration test: exercises the REAL keychain when one is
    // reachable, otherwise skips so the gate stays green in headless CI. Uses
    // the StreamKey slot with a sentinel value it always cleans up.
    #[test]
    fn real_keychain_round_trip_or_skip() {
        let provider = SecretProvider::StreamKey;
        let sentinel = "sundayrec-test-sentinel-value";
        match set(provider, sentinel) {
            Ok(()) => {
                assert_eq!(get(provider).as_deref(), Some(sentinel));
                assert!(has(provider));
                delete(provider).expect("delete should succeed");
                assert!(!has(provider));
                eprintln!("keychain integration test hit a REAL keychain");
            }
            Err(e) => {
                eprintln!("SKIP: no reachable keychain in this environment: {e}");
            }
        }
    }
}
