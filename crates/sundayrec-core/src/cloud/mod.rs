//! Cloud-backup backbone — pure, GUI-free, network-free.
//!
//! Ported from the Electron main process `src/main/cloud/*` (the behavioural
//! specification). That code interleaved the *decisions* (PKCE derivation,
//! auth-URL shaping, OAuth-callback validation, retry classification, the
//! upload-queue state machine, Drive's resumable-chunk arithmetic) with the
//! actual I/O (`fetch`, `electron-store`, `safeStorage`, an `http` loopback
//! server). Here we keep ONLY the deterministic decisions: every function takes
//! already-gathered facts (a callback's query params, an HTTP status, the
//! current queue snapshot, a byte offset) and returns the next decision.
//!
//! The `src-tauri` shell owns everything impure: the random PKCE verifier, the
//! `reqwest` calls, the `keyring` token vault, the loopback `TcpListener`, the
//! sqlx-backed queue persistence, and the Tauri commands/events. It feeds facts
//! in and acts on what these functions return — so this module stays fully
//! unit-testable without a network, a browser, or a secret store.
//!
//! **Google-only.** The shipping Electron app hid Dropbox/OneDrive (v4.54.5,
//! "Google-only sky-backup"), so this rebuild carries only the Google backbone:
//! Drive (backup), YouTube (publish), and Gmail (mail notifications) all share
//! one OAuth client via the Desktop loopback flow. The Dropbox/OneDrive custom-
//! scheme path and their content-hash helpers are intentionally dropped.
//!
//! Submodules:
//!   - [`oauth`] — PKCE challenge, auth-URL + token-request builders, token-response parsing, loopback-callback validation, state-replay guard, refresh-error classification
//!   - [`retry`] — transient-error classification, `Retry-After` parsing, exponential-backoff delay (the deterministic part of `withRetry`)
//!   - [`queue`] — the upload-queue state machine (enqueue/dedup, select-next, success/failure transitions, backoff schedule, next-wakeup)
//!   - [`drive`] — Drive resumable-upload arithmetic: chunk planning, `Content-Range` building, resume-offset parsing, MIME mapping

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod drive;
pub mod oauth;
pub mod queue;
pub mod retry;

/// A cloud service the user can connect via OAuth. Serialised kebab-case to
/// match the Electron `TokenServiceId` strings exactly (`'google-drive'`,
/// `'youtube'`, `'gmail'`) so saved tokens and log shapes carry across the
/// migration. All three share a single Google OAuth client (different scopes);
/// each is stored under its own key so a user can connect Drive without
/// granting YouTube, etc. (`config.ts:40`, `token-store.ts:5`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/CloudService.ts")]
#[serde(rename_all = "kebab-case")]
pub enum CloudService {
    /// Google Drive — the recording backup target (`drive.file` scope).
    GoogleDrive,
    /// YouTube — publish-only target (`youtube.upload` scope).
    Youtube,
    /// Gmail — OAuth-based mail notifications (`gmail.send` scope), so users can
    /// skip SMTP config + app-passwords entirely.
    Gmail,
}

impl CloudService {
    /// The Google OAuth scope string for this service. Mirrors `config.ts`
    /// (`drive.file` / `youtube.upload` / `gmail.send`) plus the shared
    /// `openid email profile` so the consent screen returns the account
    /// identity we show in the UI.
    pub fn scope(self) -> &'static str {
        match self {
            CloudService::GoogleDrive => {
                "https://www.googleapis.com/auth/drive.file openid email profile"
            }
            CloudService::Youtube => {
                "https://www.googleapis.com/auth/youtube.upload openid email profile"
            }
            CloudService::Gmail => {
                "https://www.googleapis.com/auth/gmail.send openid email profile"
            }
        }
    }
}

/// The Google OAuth authorization endpoint (shared by all three services).
pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// The Google OAuth token endpoint (code-exchange + refresh).
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// A token set as returned by the Google token endpoint, with `expires_in`
/// already resolved to an absolute `expires_at` (unix ms). Mirrors the shape
/// `exchangeCode`/`refreshAccessToken` resolve in `oauth.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/TokenResponse.ts")]
pub struct TokenResponse {
    pub access_token: String,
    /// Absent on refresh responses that don't rotate the refresh token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// Unix ms when the access token expires; `None` if the endpoint omitted
    /// `expires_in`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(type = "number | null")]
    pub expires_at: Option<i64>,
}

/// Whether a cloud service currently holds a stored refresh token. UI-facing
/// status the `src-tauri` shell fills from the keychain (Fase 6). Defined here,
/// next to [`CloudService`], so the generated TS binding resolves cleanly.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(
    export,
    export_to = "../../../src/lib/bindings/CloudConnectionStatus.ts"
)]
#[serde(rename_all = "camelCase")]
pub struct CloudConnectionStatus {
    pub service: CloudService,
    pub connected: bool,
}
