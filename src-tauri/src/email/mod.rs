//! Email-alert plumbing (PU-1 P2b) — **NETWORK-UNVERIFIED**, default-off `email` feature.
//!
//! The impure half of the error/test mailer. Every *decision* — the localized
//! templates, the throttle/dedup gate, the RFC 2822 message + base64url
//! assembly — lives in the unit-tested [`sundayrec_core::email`]. This module
//! only performs the single side effect each path needs:
//!   - the Gmail-API send (a `reqwest` POST of the base64url raw message), reusing
//!     the cloud OAuth refresh-token machinery exactly like `oauth_flow.rs` does,
//!   - the SMTP send (a `lettre` async transport).
//!
//! Mirrors the Electron `src/main/mailer.ts` `sendError`/`sendTest` two-path
//! design (prefer Gmail OAuth when connected, fall back to SMTP). Whether to
//! send at all is the core [`AlertGate`]'s call; the shell holds one gate in
//! managed state and records a successful dispatch.
//!
//! ## ⚠️ NETWORK-UNVERIFIED
//!
//! The Gmail POST and the SMTP handshake are wired + compile under
//! `--features email`, but the wire behaviour (a real token, a reachable SMTP
//! server, deliverability) is only provable on a real account + network — see
//! docs/SMOKE-TEST.md. The default build excludes this module entirely.

use std::sync::Mutex;

use sundayrec_core::cloud::{oauth, CloudService, GOOGLE_TOKEN_URL};
use sundayrec_core::email::{
    base64url, build_mime, render_error, render_test, AlertDecision, AlertGate, MailLang,
    RenderedEmail,
};

use crate::cloud::config::GoogleOAuthConfig;
use crate::cloud::{now_ms, secret_provider_for};
use crate::error::{AppError, AppResult};

/// Gmail `messages.send` endpoint (base64url raw message in the JSON body).
const GMAIL_SEND_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

/// Which transport to use for a send. Mirrors `mailer.ts`'s "prefer Gmail OAuth
/// when connected, else SMTP" choice — the caller resolves it from settings +
/// the keychain.
pub enum Transport {
    /// Send via the Gmail API using the stored Gmail OAuth refresh token.
    Gmail { config: GoogleOAuthConfig },
    /// Send via an SMTP server. `pass` is the app-password / SMTP secret.
    Smtp {
        host: String,
        port: u16,
        user: Option<String>,
        pass: String,
        from: String,
    },
}

/// Managed-state wrapper around the pure [`AlertGate`] so the Tauri layer can
/// share one throttle window across the app's lifetime.
#[derive(Default)]
pub struct AlertGateState {
    inner: Mutex<AlertGate>,
}

impl AlertGateState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decide whether to send (delegates to the core gate at `now_ms`).
    pub fn decide(&self, recipient: &str, error_message: &str, now: i64) -> AlertDecision {
        self.inner
            .lock()
            .expect("alert gate lock")
            .decide(recipient, error_message, now)
    }

    /// Record a dispatched alert, opening the throttle window.
    pub fn record_sent(&self, recipient: &str, error_message: &str, now: i64) {
        self.inner
            .lock()
            .expect("alert gate lock")
            .record_sent(recipient, error_message, now)
    }
}

/// Send a recording-error alert to `recipient`, gated by [`AlertGateState`].
/// Returns `Ok(true)` when a mail was dispatched, `Ok(false)` when the gate
/// suppressed it (no recipient / throttled). `date` is the already-localized
/// human date string (the caller formats it; see [`MailLang::locale`]).
#[allow(clippy::too_many_arguments)]
pub async fn send_error_alert(
    gate: &AlertGateState,
    transport: &Transport,
    recipient: &str,
    lang_code: Option<&str>,
    church: &str,
    person: &str,
    date: &str,
    error_message: &str,
) -> AppResult<bool> {
    let now = now_ms();
    let decided = match gate.decide(recipient, error_message, now) {
        AlertDecision::Send { recipient } => recipient,
        AlertDecision::NoRecipient | AlertDecision::Throttled => return Ok(false),
    };
    let lang = MailLang::from_code(lang_code);
    let rendered = render_error(lang, church, person, date, error_message);
    dispatch(transport, &decided, &rendered).await?;
    gate.record_sent(&decided, error_message, now);
    Ok(true)
}

/// Send a localized "email works" test message to `recipient`. Ungated (the user
/// explicitly asked to test). Errors if `recipient` is blank.
pub async fn send_test(
    transport: &Transport,
    recipient: &str,
    lang_code: Option<&str>,
) -> AppResult<()> {
    let recipient = recipient.trim();
    if recipient.is_empty() {
        return Err(AppError::Validation("no_config".into()));
    }
    let rendered = render_test(MailLang::from_code(lang_code));
    dispatch(transport, recipient, &rendered).await
}

/// Perform the single side effect for the chosen transport.
async fn dispatch(
    transport: &Transport,
    recipient: &str,
    rendered: &RenderedEmail,
) -> AppResult<()> {
    match transport {
        Transport::Gmail { config } => send_via_gmail(config, recipient, rendered).await,
        Transport::Smtp {
            host,
            port,
            user,
            pass,
            from,
        } => {
            send_via_smtp(
                host,
                *port,
                user.as_deref(),
                pass,
                from,
                recipient,
                rendered,
            )
            .await
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Gmail API path (reuses the cloud OAuth refresh machinery)
// ─────────────────────────────────────────────────────────────────────────────

/// Send via the Gmail API. Mints a fresh access token from the stored Gmail
/// refresh token (same flow as the cloud worker), assembles the raw RFC 2822
/// message via the core, base64url-encodes it, and POSTs it.
async fn send_via_gmail(
    config: &GoogleOAuthConfig,
    recipient: &str,
    rendered: &RenderedEmail,
) -> AppResult<()> {
    let token = gmail_access_token(config).await?;
    // The Gmail account address would normally come from the stored identity;
    // `me` is Gmail's documented alias for the authenticated user as sender.
    let from = "\"SundayRec\" <me>";
    let seed = now_ms().to_string();
    let mime = build_mime(
        from,
        recipient,
        &rendered.subject,
        &rendered.text,
        &rendered.html,
        &seed,
    );
    let raw = base64url(mime.as_bytes());

    let client = reqwest::Client::new();
    let resp = client
        .post(GMAIL_SEND_URL)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "raw": raw }))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("gmail send request: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Internal(format!(
            "gmail send failed: {status} {}",
            text.chars().take(200).collect::<String>()
        )));
    }
    Ok(())
}

/// Exchange the stored Gmail refresh token for an access token. Same shape as
/// `cloud::worker::access_token` (kept local so the email feature is
/// self-contained and doesn't widen the worker's visibility).
async fn gmail_access_token(config: &GoogleOAuthConfig) -> AppResult<String> {
    let refresh = crate::secrets::get(secret_provider_for(CloudService::Gmail))
        .filter(|r| !r.trim().is_empty())
        .ok_or_else(|| AppError::Internal("gmail-not-authenticated".into()))?;
    let body =
        oauth::build_refresh_body(&config.client_id, config.client_secret.as_deref(), &refresh);
    let client = reqwest::Client::new();
    let resp = client
        .post(GOOGLE_TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("gmail token request: {e}")))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "gmail token refresh {status}: {text}"
        )));
    }
    oauth::parse_token_response(&text, now_ms())
        .map(|t| t.access_token)
        .map_err(|e| AppError::Internal(format!("gmail token parse: {e:?}")))
}

// ─────────────────────────────────────────────────────────────────────────────
//   SMTP path (lettre)
// ─────────────────────────────────────────────────────────────────────────────

/// Send via SMTP using `lettre`'s async tokio transport. Mirrors the
/// `mailer.ts` nodemailer config (587 STARTTLS / 465 implicit TLS, optional
/// auth). Both plaintext + HTML parts are attached when HTML is present.
async fn send_via_smtp(
    host: &str,
    port: u16,
    user: Option<&str>,
    pass: &str,
    from: &str,
    recipient: &str,
    rendered: &RenderedEmail,
) -> AppResult<()> {
    use lettre::message::{header::ContentType, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let from_addr = format!("SundayRec <{from}>");
    let from_mailbox = from_addr
        .parse::<lettre::message::Mailbox>()
        .map_err(|e| AppError::Validation(format!("from address: {e}")))?;
    let to_mailbox = recipient
        .parse::<lettre::message::Mailbox>()
        .map_err(|e| AppError::Validation(format!("to address: {e}")))?;

    // `Message::builder()` is consumed by `body`/`multipart`, so build one per
    // branch from the already-parsed mailboxes.
    let base = || {
        Message::builder()
            .from(from_mailbox.clone())
            .to(to_mailbox.clone())
            .subject(&rendered.subject)
    };

    let message = if rendered.html.is_empty() {
        base()
            .body(rendered.text.clone())
            .map_err(|e| AppError::Internal(format!("smtp body: {e}")))?
    } else {
        base()
            .multipart(
                MultiPart::alternative()
                    .singlepart(
                        SinglePart::builder()
                            .header(ContentType::TEXT_PLAIN)
                            .body(rendered.text.clone()),
                    )
                    .singlepart(
                        SinglePart::builder()
                            .header(ContentType::TEXT_HTML)
                            .body(rendered.html.clone()),
                    ),
            )
            .map_err(|e| AppError::Internal(format!("smtp multipart: {e}")))?
    };

    // 465 → implicit TLS, otherwise STARTTLS on the submission port.
    let mut transport_builder = if port == 465 {
        AsyncSmtpTransport::<Tokio1Executor>::relay(host)
            .map_err(|e| AppError::Internal(format!("smtp relay: {e}")))?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(host)
            .map_err(|e| AppError::Internal(format!("smtp starttls: {e}")))?
    }
    .port(port);

    if let Some(user) = user {
        transport_builder =
            transport_builder.credentials(Credentials::new(user.to_string(), pass.to_string()));
    }

    transport_builder
        .build()
        .send(message)
        .await
        .map_err(|e| AppError::Internal(format!("smtp send: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_state_threads_through_to_the_core() {
        let gate = AlertGateState::new();
        // No recipient → suppressed.
        assert!(matches!(
            gate.decide("", "err", 0),
            AlertDecision::NoRecipient
        ));
        // First real send allowed, then throttled until the window passes.
        assert!(matches!(
            gate.decide("a@b.no", "err", 1000),
            AlertDecision::Send { .. }
        ));
        gate.record_sent("a@b.no", "err", 1000);
        assert!(matches!(
            gate.decide(
                "a@b.no",
                "err",
                1000 + sundayrec_core::email::ALERT_THROTTLE_MS - 1
            ),
            AlertDecision::Throttled
        ));
    }
}
