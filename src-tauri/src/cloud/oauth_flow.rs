//! OAuth connect flow (Fase 6) — **NETWORK/HARDWARE-UNVERIFIED**.
//!
//! The Desktop loopback PKCE flow: bind `127.0.0.1:0`, open the system browser
//! at the Google consent URL, await the redirect, validate it, exchange the
//! code for tokens, and store the refresh token in the keychain. Every
//! *decision* comes from the unit-tested `sundayrec-core::cloud::oauth` (PKCE
//! challenge, auth-URL shaping, callback validation + replay guard, token-body
//! shaping, response parsing); this module is only the impure I/O — the
//! `TcpListener`, the browser, and the `reqwest` POST — so it compiles and is
//! wired, but the wire behaviour is only proven on a real device + network.

use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

use sundayrec_core::cloud::{oauth, CloudService, GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL};

use crate::cloud::{now_ms, secret_provider_for};
use crate::error::{AppError, AppResult};

/// How long we wait for the user to finish consent before giving up.
const CONSENT_TIMEOUT: Duration = Duration::from_secs(300);

use super::config::GoogleOAuthConfig;

/// Run the full connect flow for `service`, storing its refresh token on success.
///
/// `cancel` (when given) lets the renderer abort a pending consent via
/// `cloud_cancel_connect`: the callback wait races it, and firing the notify
/// returns a clear `cancelled` error instead of hanging until the 300 s timeout.
pub async fn connect(
    app: &AppHandle,
    service: CloudService,
    config: &GoogleOAuthConfig,
    cancel: Option<std::sync::Arc<tokio::sync::Notify>>,
) -> AppResult<()> {
    let verifier = make_verifier();
    let challenge = oauth::pkce_challenge(&verifier);
    let state = Uuid::new_v4().to_string();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Internal(format!("loopback bind: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Internal(format!("loopback addr: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let auth_url = oauth::build_auth_url(
        GOOGLE_AUTH_URL,
        &config.client_id,
        &redirect_uri,
        &state,
        &challenge,
        service.scope(),
    );

    app.opener()
        .open_url(auth_url, None::<&str>)
        .map_err(|e| AppError::Internal(format!("open browser: {e}")))?;

    // Race the consent callback against (a) the overall timeout and (b) a
    // renderer-initiated cancel. A cancel returns a clear `cancelled` error.
    let callback = await_callback(&listener, &state);
    let code = match cancel {
        Some(notify) => {
            tokio::select! {
                biased;
                _ = notify.notified() => return Err(AppError::Validation("cancelled".into())),
                r = tokio::time::timeout(CONSENT_TIMEOUT, callback) => {
                    r.map_err(|_| AppError::Internal("OAuth consent timed out".into()))??
                }
            }
        }
        None => tokio::time::timeout(CONSENT_TIMEOUT, callback)
            .await
            .map_err(|_| AppError::Internal("OAuth consent timed out".into()))??,
    };

    let body = oauth::build_token_exchange_body(
        &config.client_id,
        config.client_secret.as_deref(),
        &redirect_uri,
        &code,
        &verifier,
    );
    let response = post_form(GOOGLE_TOKEN_URL, body).await?;
    let tokens = oauth::parse_token_response(&response, now_ms())
        .map_err(|e| AppError::Internal(format!("token response: {e:?}")))?;
    let refresh = tokens
        .refresh_token
        .ok_or_else(|| AppError::Internal("token endpoint returned no refresh_token".into()))?;

    crate::secrets::set(secret_provider_for(service), &refresh)?;
    Ok(())
}

/// A 43-char PKCE verifier from 32 bytes of OS entropy (two v4 UUIDs).
fn make_verifier() -> String {
    let mut bytes = [0u8; 32];
    bytes[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    bytes[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    oauth::base64url(&bytes)
}

/// Accept loopback connections until the OAuth redirect arrives, validate it via
/// the core, ACK the browser, and return the authorization code.
async fn await_callback(listener: &TcpListener, expected_state: &str) -> AppResult<String> {
    let mut replay = oauth::StateReplayGuard::new();
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| AppError::Internal(format!("loopback accept: {e}")))?;

        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        // First line: `GET /?code=…&state=… HTTP/1.1`.
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");
        let pairs = oauth::decode_query_pairs(target);

        // Ignore requests without OAuth params (favicon, etc.) and keep waiting.
        if pairs.is_empty() {
            let _ = respond(&mut stream, "Venter på innlogging …").await;
            continue;
        }

        match oauth::parse_loopback_callback(&pairs, expected_state, &mut replay, now_ms()) {
            Ok(code) => {
                let _ = respond(
                    &mut stream,
                    "Innlogging fullført. Du kan lukke dette vinduet.",
                )
                .await;
                return Ok(code);
            }
            Err(e) => {
                let _ = respond(
                    &mut stream,
                    "Innlogging feilet. Du kan lukke dette vinduet.",
                )
                .await;
                return Err(AppError::Internal(format!("oauth callback: {e:?}")));
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

/// POST an `application/x-www-form-urlencoded` body and return the response text,
/// erroring on a non-2xx status (the body is included for diagnostics).
async fn post_form(url: &str, body: String) -> AppResult<String> {
    // Bounded connect + request timeouts: the CONSENT_TIMEOUT above only caps the
    // browser-callback wait, not this token exchange, so without a per-request
    // bound a hung token endpoint would block the connect command forever.
    let client = super::http_client();
    let resp = client
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("token request: {e}")))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("token body: {e}")))?;
    if !status.is_success() {
        // Don't surface the raw token-endpoint body (it reaches the UI). Status
        // only; the body goes to the local debug log for troubleshooting.
        tracing::debug!(%status, "cloud token endpoint error");
        return Err(AppError::Internal(format!(
            "token endpoint returned HTTP {}",
            status.as_u16()
        )));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_is_43_unreserved_chars() {
        let v = make_verifier();
        assert_eq!(v.len(), 43);
        assert!(v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')));
        // base64url(verifier) feeds a stable challenge.
        assert_eq!(oauth::pkce_challenge(&v), oauth::pkce_challenge(&v));
    }
}
