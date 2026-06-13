//! Sunday Account (SSO) commands — the thin IPC layer over `crate::account`.
//!
//! `sunday_account_configured` / `sunday_account_status` are network-free
//! (env check + reading the shared session file). `sunday_sign_in` opens the
//! browser and runs the loopback PKCE flow; `sunday_whoami_song` proves the
//! end-to-end loop by calling SundaySong's church-scoped endpoint with the
//! Sunday bearer. All NETWORK/HARDWARE-UNVERIFIED — they need a real Supabase
//! project + browser + a deployed SundaySong (rig test).

use tauri::AppHandle;

use crate::account::{self, AccountStatus, SupabaseConfig};
use crate::error::{AppError, AppResult};

/// Resolve the Supabase config or a clear "not configured" error.
fn require_config() -> AppResult<SupabaseConfig> {
    SupabaseConfig::resolve().ok_or_else(|| {
        AppError::Validation(
            "Sunday Account is not configured (set SUNDAY_SUPABASE_URL / SUNDAY_SUPABASE_ANON_KEY)"
                .into(),
        )
    })
}

/// Whether a Sunday Account issuer is configured in this build. Network-free
/// predicate the UI uses to gate the "Logg inn"-button.
#[tauri::command]
pub fn sunday_account_configured() -> bool {
    SupabaseConfig::resolve().is_some()
}

/// The current account status read from the shared session (signed-out if none).
/// Network-free.
#[tauri::command]
pub async fn sunday_account_status() -> AppResult<AccountStatus> {
    account::status()
}

/// Start the browser login and persist the shared session on success.
/// NETWORK/HARDWARE-UNVERIFIED.
#[tauri::command]
pub async fn sunday_sign_in(app: AppHandle) -> AppResult<AccountStatus> {
    account::sign_in(&app, &require_config()?, None).await
}

/// Sign out everywhere: best-effort GLOBAL server-side revocation (all devices /
/// web tabs) when configured + online, then always clear the shared session so
/// every Sunday app on this machine is logged out too. Offline-safe — config is
/// optional, so an unconfigured project (or no network) still clears locally.
#[tauri::command]
pub async fn sunday_sign_out() -> AppResult<()> {
    account::sign_out(require_config().ok().as_ref()).await
}

/// Pilot end-to-end probe: refresh a live access token and call SundaySong's
/// church-scoped `whoami` with it. Returns the raw JSON Song echoes back (the
/// token's claims), proving issuer → PKCE → refresh → JWKS-verify → per-church
/// authz across a desktop app and a web service. NETWORK-UNVERIFIED.
#[tauri::command]
pub async fn sunday_whoami_song(church_id: String) -> AppResult<String> {
    let config = require_config()?;
    let token = account::access_token(&config).await?;

    let base = std::env::var("SUNDAY_SONG_API_URL")
        .ok()
        .or_else(|| option_env!("SUNDAY_SONG_API_URL").map(str::to_string))
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation("SundaySong API not configured (set SUNDAY_SONG_API_URL)".into())
        })?;
    // church_id comes from the verified claims (a UUID), so it is URL-safe as-is.
    let url = format!(
        "{}/v1/account/whoami?church_id={}",
        base.trim_end_matches('/'),
        church_id
    );

    let client = crate::cloud::http_client();
    let resp = client
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("song request: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("song body: {e}")))?;
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "song whoami returned HTTP {}",
            status.as_u16()
        )));
    }
    Ok(text)
}
