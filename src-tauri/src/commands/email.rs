//! Email-alert commands (PU-1 P2b) — the thin IPC layer over `crate::email`.
//!
//! `email_status` reports whether this build can send (the `email` cargo
//! feature) and whether a Gmail refresh token is stored, so the renderer can
//! render the panel WITHOUT having to provoke a failed send. `email_send_test`
//! dispatches a localized "email works" test message via the chosen transport.
//!
//! The send path (SMTP socket / Gmail POST) is behind the **default-off `email`**
//! feature; in the default build `email_send_test` returns a clear
//! `feature_disabled` error so the panel shows a calm "not built into this build"
//! hint. The SMTP password is never persisted — it travels with the test request
//! and is dropped after the send (mirrors the Electron `smtpPass` arg to
//! `mailer.ts` `sendTest`). NETWORK-UNVERIFIED behind `--features email`.

use tauri::State;

use sundayrec_core::email::{EmailStatus, EmailTransportKind};
use sundayrec_core::webhook::{build_webhook_body, WebhookPayload};

use crate::db::Db;
use crate::error::AppResult;
use crate::settings;

/// Whether this build can send email + whether Gmail is already connected. Works
/// in every build: `feature_built` reflects the compile-time `email` feature and
/// `gmail_connected` reads the keychain for a stored Gmail refresh token.
#[tauri::command]
pub fn email_status() -> EmailStatus {
    EmailStatus {
        feature_built: cfg!(feature = "email"),
        gmail_connected: crate::secrets::has(crate::secrets::SecretProvider::Gmail),
    }
}

/// Send a localized "email works" test message to `recipient` via `transport`.
///
/// For [`EmailTransportKind::Smtp`] the `host`/`port`/`user`/`pass`/`from` fields
/// are required (the pass is used once and dropped); for
/// [`EmailTransportKind::Gmail`] they're ignored and the stored Gmail token is
/// used. `language` picks the localized subject/body (defaults to Norwegian).
///
/// NETWORK-UNVERIFIED behind `--features email`; returns `feature_disabled` in
/// the default build.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
#[cfg_attr(not(feature = "email"), allow(unused_variables))]
pub async fn email_send_test(
    transport: EmailTransportKind,
    recipient: String,
    language: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    user: Option<String>,
    pass: Option<String>,
    from: Option<String>,
) -> AppResult<()> {
    #[cfg(not(feature = "email"))]
    {
        Err(crate::error::AppError::Validation(
            "feature_disabled: email requires a build with `--features email`".into(),
        ))
    }

    #[cfg(feature = "email")]
    {
        use crate::cloud::config::GoogleOAuthConfig;
        use crate::email::Transport;
        use crate::error::AppError;

        let transport = match transport {
            EmailTransportKind::Gmail => Transport::Gmail {
                config: GoogleOAuthConfig::resolve().ok_or_else(|| {
                    AppError::Validation("no_config: Google OAuth not configured".into())
                })?,
            },
            EmailTransportKind::Smtp => Transport::Smtp {
                host: host
                    .filter(|h| !h.trim().is_empty())
                    .ok_or_else(|| AppError::Validation("no_config: smtp host".into()))?,
                port: port.unwrap_or(587),
                user: user.filter(|u| !u.trim().is_empty()),
                pass: pass.ok_or_else(|| AppError::Validation("no_config: smtp pass".into()))?,
                from: from
                    .filter(|f| !f.trim().is_empty())
                    .ok_or_else(|| AppError::Validation("no_config: smtp from".into()))?,
            },
        };
        crate::email::send_test(&transport, &recipient, language.as_deref()).await
    }
}

/// Send a test notification to `url` to verify a webhook before relying on it
/// during a recording failure. The body shaping (URL validation, Slack/Discord
/// detection, the structured-vs-chat payload) is the unit-tested
/// [`sundayrec_core::webhook`]; the church name comes from settings. Returns the
/// `no_url` error for an invalid URL (matching the Electron handler). The POST
/// itself is NETWORK-UNVERIFIED (reuses the always-present `reqwest`, no feature).
#[tauri::command]
pub async fn email_test_webhook(db: State<'_, Db>, url: String) -> AppResult<bool> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    let ts = chrono::Utc::now().to_rfc3339();
    let payload = WebhookPayload::test(&s.church_name, &ts);
    let Some(body) = build_webhook_body(&url, &payload) else {
        return Err(crate::error::AppError::Validation("no_url".into()));
    };
    // NETWORK-UNVERIFIED: a 10 s-bounded POST; any non-success status / transport
    // error means the webhook isn't reachable (returns Ok(false), not an error,
    // so the panel shows "didn't work" rather than a stack-trace).
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await;
    Ok(matches!(resp, Ok(r) if r.status().is_success()))
}

/// Wipe the stored SMTP password from the OS keychain (the user disabled email
/// notifications or switched to Gmail). Mirrors the Electron `clear-smtp-password`
/// handler. A missing entry is success, not an error.
#[tauri::command]
pub fn email_clear_smtp_password() -> AppResult<bool> {
    crate::secrets::delete(crate::secrets::SecretProvider::SmtpPassword)?;
    Ok(true)
}
