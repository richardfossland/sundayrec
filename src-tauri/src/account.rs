//! Sunday Account (SSO) — the desktop login for "one Sunday account, whole
//! suite". **NETWORK/HARDWARE-UNVERIFIED.**
//!
//! The impure loopback PKCE shell over the unit-tested `sunday_auth` crate: bind
//! `127.0.0.1:0`, open the system browser at the Supabase GoTrue authorize URL,
//! await the redirect, validate `state`, exchange the code for a Supabase
//! session, and persist it to the **shared** session file
//! (`<app-data>/SundaySuite/session.json`) so every other Sunday app on the
//! machine is logged in too. Every *decision* (PKCE challenge, authorize-URL /
//! request-body shaping, response parsing, refresh-error classification, the
//! atomic session write) lives in `sunday_auth::{pkce,supabase,session}`; this
//! module is only the `TcpListener`, the browser, and the `reqwest` POST.
//!
//! Token model (see the SSO plan):
//!   - refresh token (rotated) → shared session file, written ATOMICALLY on
//!     every exchange/refresh (Supabase invalidates the old one each time),
//!   - access token (JWT) → never persisted; re-minted from the refresh token,
//!   - cached claims (`sub`/churches/grants) → the session file, for offline UI.
//!
//! Local-first: a missing session = signed out = the app runs fully offline.
//! Auth state only gates cloud / cross-app features, never local recording.

use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use sunday_auth::{pkce, session, supabase};

use crate::cloud::{http_client, now_ms};
use crate::error::{AppError, AppResult};

/// How long we wait for the user to finish the browser login before giving up.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

/// Offline-grace for cached claims: how long after a successful login an app may
/// trust the cached `church_ids`/`app_grants` for UI without re-verifying. After
/// this, cloud writes should force a refresh — but local features stay usable.
const CLAIMS_GRACE_MS: i64 = 30 * 24 * 60 * 60 * 1000; // 30 days

/// The social provider used for the Sunday Account login. Churches overwhelmingly
/// have Google Workspace / Gmail, so Google is the one-button default.
const LOGIN_PROVIDER: &str = "google";

/// The resolved Supabase project this build authenticates against. `base_url` is
/// the issuer origin (the alias `https://auth.sundaysuite.app` once the custom
/// domain is live, or the raw `*.supabase.co` until then); `anon_key` is the
/// public anon key GoTrue requires as the `apikey` header (not a secret — RLS is
/// the trust boundary).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupabaseConfig {
    pub base_url: String,
    pub anon_key: String,
}

impl SupabaseConfig {
    /// Resolve from the runtime env (`SUNDAY_SUPABASE_URL` /
    /// `SUNDAY_SUPABASE_ANON_KEY`), then values baked in at build time via the
    /// same names, then the production Sunday project compiled into
    /// `sunday-auth` — so a stock build signs in with zero configuration while
    /// an override (staging, local stack) still wins. Suite-wide names (not
    /// `SUNDAYREC_*`) so every Sunday app points at the same issuer.
    pub fn resolve() -> Option<Self> {
        let url = std::env::var("SUNDAY_SUPABASE_URL")
            .ok()
            .or_else(|| option_env!("SUNDAY_SUPABASE_URL").map(str::to_string))
            .or_else(|| Some(sunday_auth::SUNDAY_PROD_SUPABASE_URL.to_string()));
        let key = std::env::var("SUNDAY_SUPABASE_ANON_KEY")
            .ok()
            .or_else(|| option_env!("SUNDAY_SUPABASE_ANON_KEY").map(str::to_string))
            .or_else(|| Some(sunday_auth::SUNDAY_PROD_SUPABASE_ANON_KEY.to_string()));
        Self::normalize(url, key)
    }

    /// Pure construction: blank/missing url or key yields `None`.
    pub fn normalize(url: Option<String>, key: Option<String>) -> Option<Self> {
        let base_url = url.filter(|s| !s.trim().is_empty())?.trim().to_string();
        let anon_key = key.filter(|s| !s.trim().is_empty())?.trim().to_string();
        Some(Self { base_url, anon_key })
    }

    /// The issuer (`iss`) tokens from this project carry — the base origin plus
    /// GoTrue's `/auth/v1`. Recorded in the session so a later issuer migration
    /// is detectable.
    fn issuer(&self) -> String {
        format!("{}/auth/v1", self.base_url.trim_end_matches('/'))
    }
}

/// The account state the renderer renders. `signed_in=false` means no shared
/// session (or it was cleared); all other fields are then defaults.
#[derive(Debug, Clone, Serialize)]
pub struct AccountStatus {
    pub signed_in: bool,
    pub sub: String,
    pub email: Option<String>,
    #[serde(rename = "churchIds")]
    pub church_ids: Vec<String>,
    #[serde(rename = "appGrants")]
    pub app_grants: std::collections::BTreeMap<String, Vec<String>>,
    /// Whether the cached claims are still within the offline-grace window. When
    /// `false` the UI can show a soft "reconnect to verify access" hint.
    #[serde(rename = "claimsFresh")]
    pub claims_fresh: bool,
}

impl AccountStatus {
    /// The signed-out state (no shared session present).
    pub fn signed_out() -> Self {
        Self {
            signed_in: false,
            sub: String::new(),
            email: None,
            church_ids: Vec::new(),
            app_grants: std::collections::BTreeMap::new(),
            claims_fresh: false,
        }
    }

    /// Project a stored session into the renderer-facing status. Pure.
    pub fn from_session(data: &session::SessionData, now_ms: i64) -> Self {
        let c = &data.cached_claims;
        Self {
            signed_in: true,
            sub: c.sub.clone(),
            email: c.email.clone(),
            church_ids: c.church_ids.clone(),
            app_grants: c.app_grants.clone(),
            claims_fresh: data.claims_fresh(now_ms),
        }
    }
}

/// Resolve the shared session-file path, or a clear error in an odd environment
/// where the platform data dir can't be determined.
fn session_path() -> AppResult<std::path::PathBuf> {
    session::default_path()
        .ok_or_else(|| AppError::Internal("kunne ikke finne delt sesjons-katalog".into()))
}

/// Read the current account status from the shared session (signed-out if none).
pub fn status() -> AppResult<AccountStatus> {
    let path = session_path()?;
    match session::read(&path).map_err(|e| AppError::Internal(e.to_string()))? {
        Some(data) => Ok(AccountStatus::from_session(&data, now_ms())),
        None => Ok(AccountStatus::signed_out()),
    }
}

/// GoTrue logout endpoint. `scope=global` revokes EVERY refresh token this user
/// holds (sign out of all devices — the single-logout backbone); `local` would
/// drop only this session. `base` is the issuer origin, like the other endpoints.
fn logout_endpoint(base: &str, scope: &str) -> String {
    format!(
        "{}/auth/v1/logout?scope={}",
        base.trim_end_matches('/'),
        scope
    )
}

/// Best-effort server-side revocation: POST GoTrue `/logout?scope=global` with
/// the user's own access token as the Bearer (the anon key stays the `apikey`).
/// `Ok` on 2xx; any other status / network failure is an error the caller
/// deliberately ignores so a logout is never blocked by being offline.
async fn revoke_all_sessions(config: &SupabaseConfig, access_token: &str) -> AppResult<()> {
    let url = logout_endpoint(&config.base_url, "global");
    let resp = http_client()
        .post(&url)
        .header("apikey", &config.anon_key)
        .header("authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("logout request: {e}")))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(AppError::Internal(format!(
            "logout returned HTTP {}",
            status.as_u16()
        )))
    }
}

/// Sign out everywhere. Two halves, mirroring the SSO plan's single-logout
/// design:
///   1. AUTHORITATIVE — when a config + live session are available, mint a fresh
///      access token and ask GoTrue to revoke ALL of this user's refresh tokens
///      (`scope=global`). Every other Sunday session — other devices, web tabs —
///      then fails its next refresh (`refresh_token_revoked`) and falls back to
///      signed-out within one access-token lifetime.
///   2. LOCAL — always clear the shared session file so every Sunday app on THIS
///      machine is logged out immediately.
///
/// Best-effort + offline-safe: step 1 is skipped (never failed) when there is no
/// config or the device is offline, so the local clear in step 2 always wins.
/// `config` is optional because the renderer may sign out before the project is
/// configured (or with no network) — the local clear still has to work.
pub async fn sign_out(config: Option<&SupabaseConfig>) -> AppResult<()> {
    let path = session_path()?;
    if let Some(config) = config {
        // `access_token` refreshes against the live session; on a dead refresh
        // token it already clears the session for us, so either way we fall
        // through to the local clear below. Revocation errors are ignored.
        if let Ok(token) = access_token(config).await {
            let _ = revoke_all_sessions(config, &token).await;
        }
    }
    session::clear(&path).map_err(|e| AppError::Internal(e.to_string()))
}

/// Run the full browser login and persist the resulting shared session.
///
/// `cancel` lets the renderer abort a pending login (mirrors the cloud connect
/// flow): the callback wait races it and a fired notify returns a clear
/// `cancelled` error instead of hanging until the 300 s timeout.
pub async fn sign_in(
    app: &AppHandle,
    config: &SupabaseConfig,
    cancel: Option<std::sync::Arc<tokio::sync::Notify>>,
) -> AppResult<AccountStatus> {
    let verifier =
        pkce::generate_code_verifier().map_err(|e| AppError::Internal(format!("pkce rng: {e}")))?;
    let challenge = pkce::code_challenge_s256(&verifier);
    let state = uuid_v4();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Internal(format!("loopback bind: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("loopback addr: {e}")))?
        .port();
    // GoTrue preserves the redirect_to query string and appends `&code=…`, so we
    // carry our CSRF `state` inside it; the callback then has both params.
    let redirect_to = format!("http://127.0.0.1:{port}/?state={state}");

    let auth_url =
        supabase::authorize_url(&config.base_url, LOGIN_PROVIDER, &redirect_to, &challenge);
    app.opener()
        .open_url(auth_url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("open browser: {e}")))?;

    let callback = await_callback(&listener, &state);
    let code = match cancel {
        Some(notify) => {
            tokio::select! {
                biased;
                _ = notify.notified() => return Err(AppError::Validation("cancelled".into())),
                r = tokio::time::timeout(CONSENT_TIMEOUT, callback) => {
                    r.map_err(|_| AppError::Internal("login timed out".into()))??
                }
            }
        }
        None => tokio::time::timeout(CONSENT_TIMEOUT, callback)
            .await
            .map_err(|_| AppError::Internal("login timed out".into()))??,
    };

    // Exchange the authorization code (+ verifier) for a Supabase session.
    let url = supabase::token_endpoint(&config.base_url, "pkce");
    let body = supabase::build_pkce_exchange_body(&code, &verifier);
    let (status_code, text) = send_json(&url, &config.anon_key, body).await?;
    if !status_code.is_success() {
        tracing::debug!(
            status = status_code.as_u16(),
            "sunday account: pkce exchange error"
        );
        return Err(AppError::Internal(format!(
            "login token endpoint returned HTTP {}",
            status_code.as_u16()
        )));
    }
    let session = supabase::parse_session(&text, now_ms())
        .map_err(|e| AppError::Internal(format!("login token response: {e}")))?;

    persist_session(config, &session)?;
    status()
}

/// Obtain a fresh access token (JWT) for calling a Sunday service, refreshing the
/// shared session against Supabase and persisting the rotated refresh token.
///
/// On a dead refresh token ([`supabase::RefreshOutcome::Reauth`]) the shared
/// session is cleared and a `reauth_required` validation error is returned so the
/// renderer can prompt a fresh login. Transient failures surface as `Internal`.
pub async fn access_token(config: &SupabaseConfig) -> AppResult<String> {
    let path = session_path()?;
    let current = session::read(&path)
        .map_err(|e| AppError::Internal(e.to_string()))?
        .ok_or_else(|| AppError::Validation("not_signed_in".into()))?;

    let url = supabase::token_endpoint(&config.base_url, "refresh_token");
    let body = supabase::build_refresh_body(&current.refresh_token);
    let (status_code, text) = send_json(&url, &config.anon_key, body).await?;

    if !status_code.is_success() {
        return match supabase::classify_refresh_error(&text) {
            supabase::RefreshOutcome::Reauth => {
                // Refresh token is dead — drop the shared session and ask for a
                // fresh login. Never leave a zombie session behind.
                let _ = session::clear(&path);
                Err(AppError::Validation("reauth_required".into()))
            }
            supabase::RefreshOutcome::Retry => Err(AppError::Internal(format!(
                "token refresh returned HTTP {} (transient)",
                status_code.as_u16()
            ))),
        };
    }

    let refreshed = supabase::parse_session(&text, now_ms())
        .map_err(|e| AppError::Internal(format!("refresh response: {e}")))?;
    let access = refreshed.access_token.clone();
    persist_session(config, &refreshed)?;
    Ok(access)
}

/// Write a freshly-obtained Supabase session to the shared file: cache the
/// (unverified — it's our own TLS-fetched token) claims, stamp the offline-grace
/// expiry, and record the issuer. Atomic so a concurrent reader never sees a
/// torn session.
fn persist_session(config: &SupabaseConfig, s: &supabase::SupabaseSession) -> AppResult<()> {
    let cached_claims = session::decode_claims_unverified(&s.access_token).unwrap_or_default();
    let data = session::SessionData {
        schema_version: session::SESSION_SCHEMA_VERSION,
        refresh_token: s.refresh_token.clone(),
        cached_claims,
        claims_expires_at_ms: now_ms() + CLAIMS_GRACE_MS,
        issuer: config.issuer(),
    };
    let path = session_path()?;
    session::write_atomic(&path, &data).map_err(|e| AppError::Internal(e.to_string()))
}

/// A v4 UUID string for the CSRF `state` (reuses the crate's `uuid` dep).
fn uuid_v4() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Accept loopback connections until the GoTrue redirect arrives, validate it via
/// `sunday_auth::parse_oauth_callback` (CSRF state-match), ACK the browser, and
/// return the authorization code.
async fn await_callback(listener: &TcpListener, expected_state: &str) -> AppResult<String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::Internal(format!("loopback accept: {e}")))?;

        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        // First line: `GET /?state=…&code=… HTTP/1.1`.
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");

        // Requests without our params (favicon, etc.): keep waiting.
        if !target.contains("code=") && !target.contains("error=") {
            let _ = respond(&mut stream, "Venter på innlogging …").await;
            continue;
        }

        match sunday_auth::parse_oauth_callback(target, expected_state) {
            Ok(cb) => {
                let _ = respond(
                    &mut stream,
                    "Innlogging fullført. Du kan lukke dette vinduet.",
                )
                .await;
                return Ok(cb.code);
            }
            Err(e) => {
                let _ = respond(
                    &mut stream,
                    "Innlogging feilet. Du kan lukke dette vinduet.",
                )
                .await;
                return Err(AppError::Internal(format!("login callback: {e:?}")));
            }
        }
    }
}

/// Write a minimal `text/html` 200 response and close the connection.
async fn respond(stream: &mut tokio::net::TcpStream, message: &str) -> std::io::Result<()> {
    let body =
        format!("<!doctype html><meta charset=utf-8><title>SundayRec</title><p>{message}</p>");
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await
}

/// POST a JSON body to a GoTrue endpoint with the required `apikey` header and
/// return `(status, body)`. Unlike the cloud `post_form`, the caller inspects the
/// status itself — a refresh needs the error body to classify reauth-vs-retry, so
/// we don't collapse non-2xx into an error here.
async fn send_json(
    url: &str,
    anon_key: &str,
    body: String,
) -> AppResult<(reqwest::StatusCode, String)> {
    let client = http_client();
    let resp = client
        .post(url)
        .header("content-type", "application/json")
        .header("apikey", anon_key)
        .header("authorization", format!("Bearer {anon_key}"))
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("auth request: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("auth response body: {e}")))?;
    Ok((status, text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_defaults_to_the_prod_issuer_with_no_env() {
        // A stock build must be able to sign in with zero configuration.
        // (Env overrides still win — exercised implicitly by CI builds that
        // set SUNDAY_SUPABASE_URL; here we only assert the fallback exists.)
        if std::env::var("SUNDAY_SUPABASE_URL").is_ok() {
            return; // an explicit override is configured; nothing to assert
        }
        let c = SupabaseConfig::resolve().expect("prod fallback");
        assert_eq!(c.base_url, sunday_auth::SUNDAY_PROD_SUPABASE_URL);
        assert_eq!(c.anon_key, sunday_auth::SUNDAY_PROD_SUPABASE_ANON_KEY);
    }

    #[test]
    fn logout_endpoint_targets_global_scope_and_trims_base() {
        assert_eq!(
            logout_endpoint("https://auth.sundaysuite.app/", "global"),
            "https://auth.sundaysuite.app/auth/v1/logout?scope=global"
        );
        assert_eq!(
            logout_endpoint("https://proj.supabase.co", "local"),
            "https://proj.supabase.co/auth/v1/logout?scope=local"
        );
    }

    #[test]
    fn config_normalize_requires_both_fields() {
        assert_eq!(SupabaseConfig::normalize(None, Some("k".into())), None);
        assert_eq!(SupabaseConfig::normalize(Some("u".into()), None), None);
        assert_eq!(
            SupabaseConfig::normalize(Some("  ".into()), Some("k".into())),
            None
        );
        let c = SupabaseConfig::normalize(
            Some("  https://proj.supabase.co  ".into()),
            Some(" anon ".into()),
        )
        .unwrap();
        assert_eq!(c.base_url, "https://proj.supabase.co");
        assert_eq!(c.anon_key, "anon");
    }

    #[test]
    fn issuer_appends_auth_v1_once() {
        let c = SupabaseConfig {
            base_url: "https://auth.sundaysuite.app/".into(),
            anon_key: "k".into(),
        };
        assert_eq!(c.issuer(), "https://auth.sundaysuite.app/auth/v1");
    }

    #[test]
    fn signed_out_status_is_empty() {
        let s = AccountStatus::signed_out();
        assert!(!s.signed_in);
        assert!(s.church_ids.is_empty());
        assert!(!s.claims_fresh);
    }

    #[test]
    fn from_session_projects_claims_and_freshness() {
        let mut grants = std::collections::BTreeMap::new();
        grants.insert("c1".to_string(), vec!["rec".to_string()]);
        let data = session::SessionData {
            schema_version: session::SESSION_SCHEMA_VERSION,
            refresh_token: "RT".into(),
            cached_claims: session::SundayClaims {
                sub: "u1".into(),
                church_ids: vec!["c1".into()],
                app_grants: grants,
                email: Some("a@b.no".into()),
            },
            claims_expires_at_ms: 1_000,
            issuer: "https://auth.sundaysuite.app/auth/v1".into(),
        };
        let fresh = AccountStatus::from_session(&data, 999);
        assert!(fresh.signed_in);
        assert_eq!(fresh.sub, "u1");
        assert_eq!(fresh.church_ids, vec!["c1".to_string()]);
        assert_eq!(
            fresh.app_grants.get("c1").unwrap(),
            &vec!["rec".to_string()]
        );
        assert!(fresh.claims_fresh);
        // Past the grace expiry, signed_in stays true but claims_fresh flips.
        let stale = AccountStatus::from_session(&data, 2_000);
        assert!(stale.signed_in);
        assert!(!stale.claims_fresh);
    }
}
