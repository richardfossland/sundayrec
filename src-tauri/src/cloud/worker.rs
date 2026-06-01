//! Cloud upload worker (Fase 6) — **NETWORK/HARDWARE-UNVERIFIED**.
//!
//! Drains the durable upload queue to Google Drive. Every *decision* is the
//! unit-tested core's: which entry runs next and its status transitions
//! (`cloud::queue`), the resumable-chunk arithmetic and status classification
//! (`cloud::drive`), token-body shaping + refresh-error classification
//! (`cloud::oauth`). This module is only the impure shell — the `reqwest` PUTs,
//! the `tokio::fs` chunk reads, the keychain token read — so it compiles and is
//! wired, but the wire behaviour is proven only on a real device + network.

use std::path::Path;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use sundayrec_core::cloud::queue::{self, FailureKind, QueueEntry};
use sundayrec_core::cloud::{drive, oauth, CloudService, GOOGLE_TOKEN_URL};

use super::config::GoogleOAuthConfig;
use super::{now_ms, secret_provider_for, store};
use crate::error::{AppError, AppResult};

/// Drive resumable-session init endpoint.
const UPLOAD_INIT_URL: &str =
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable";
/// How long the worker sleeps when there's nothing to do (or it's unconfigured).
const IDLE_SLEEP: Duration = Duration::from_secs(3600);

/// The result of trying to mint an access token for a service.
pub(crate) enum TokenOutcome {
    Ok(String),
    /// Refresh token revoked — pause the entry (`reauth-required`).
    NeedsReauth,
    /// A transient failure (network / 5xx) — retry with backoff.
    Transient(String),
}

/// Exchange the stored refresh token for a fresh access token.
pub(crate) async fn access_token(
    service: CloudService,
    config: &GoogleOAuthConfig,
) -> TokenOutcome {
    let refresh = match crate::secrets::get(secret_provider_for(service)) {
        Some(r) if !r.trim().is_empty() => r,
        _ => return TokenOutcome::NeedsReauth,
    };
    let body =
        oauth::build_refresh_body(&config.client_id, config.client_secret.as_deref(), &refresh);
    let client = reqwest::Client::new();
    let resp = match client
        .post(GOOGLE_TOKEN_URL)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => return TokenOutcome::Transient(format!("refresh request: {e}")),
    };
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return match oauth::classify_refresh_error(&text) {
            oauth::RefreshErrorKind::InvalidGrant => TokenOutcome::NeedsReauth,
            oauth::RefreshErrorKind::Other => {
                TokenOutcome::Transient(format!("refresh {status}: {text}"))
            }
        };
    }
    match oauth::parse_token_response(&text, now_ms()) {
        Ok(t) => TokenOutcome::Ok(t.access_token),
        Err(e) => TokenOutcome::Transient(format!("refresh parse: {e:?}")),
    }
}

/// Upload one file to Drive via a resumable session. The chunk loop is driven by
/// `drive::chunk_plan` / `content_range_header` / `chunk_status_outcome` /
/// `parse_resume_offset`.
async fn upload_file(access_token: &str, file_path: &str) -> AppResult<()> {
    let path = Path::new(file_path);
    let filename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("recording");
    let mime = drive::audio_mime(filename);
    let description = drive::build_description(&drive::DriveMetadata {
        title: Some(filename.to_string()),
        ..Default::default()
    });
    let total = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::Internal(format!("stat {file_path}: {e}")))?
        .len();

    let client = reqwest::Client::new();

    // 1. Initiate the resumable session; the server returns the upload URI.
    let init = client
        .post(UPLOAD_INIT_URL)
        .bearer_auth(access_token)
        .header("content-type", "application/json; charset=UTF-8")
        .header("x-upload-content-type", mime)
        .body(drive::build_init_body(filename, &description, None))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("init session: {e}")))?;
    if !init.status().is_success() {
        return Err(AppError::Internal(format!(
            "resumable init returned {}",
            init.status()
        )));
    }
    let session_uri = init
        .headers()
        .get("location")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| AppError::Internal("resumable init missing Location header".into()))?
        .to_string();

    // 2. Send chunks until the server reports completion.
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::Internal(format!("open {file_path}: {e}")))?;
    let mut offset = 0u64;
    while let Some(plan) = drive::chunk_plan(offset, total) {
        file.seek(std::io::SeekFrom::Start(plan.offset))
            .await
            .map_err(|e| AppError::Internal(format!("seek: {e}")))?;
        let mut buf = vec![0u8; plan.len as usize];
        file.read_exact(&mut buf)
            .await
            .map_err(|e| AppError::Internal(format!("read chunk: {e}")))?;

        let put = client
            .put(&session_uri)
            .header("content-range", drive::content_range_header(&plan, total))
            .body(buf)
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("chunk PUT: {e}")))?;

        match drive::chunk_status_outcome(put.status().as_u16()) {
            drive::ChunkOutcome::Complete => return Ok(()),
            drive::ChunkOutcome::Incomplete => {
                offset = put
                    .headers()
                    .get("range")
                    .and_then(|h| h.to_str().ok())
                    .and_then(drive::parse_resume_offset)
                    .unwrap_or(plan.offset + plan.len);
            }
            drive::ChunkOutcome::Error => {
                return Err(AppError::Internal(format!(
                    "chunk PUT returned {}",
                    put.status()
                )));
            }
        }
    }
    Ok(())
}

/// Persist the (possibly mutated) entry with `id` back to the queue table.
async fn persist_entry(pool: &SqlitePool, entries: &[QueueEntry], id: &str) -> AppResult<()> {
    if let Some(e) = entries.iter().find(|e| e.id == id) {
        store::upsert_entry(pool, e).await?;
    }
    Ok(())
}

/// Process the single next-due queue entry, if any. Returns whether it did work
/// (so the caller's loop can keep draining without sleeping). Every transition
/// is applied by the core and persisted.
pub async fn process_once(pool: &SqlitePool, config: &GoogleOAuthConfig) -> AppResult<bool> {
    let mut entries = store::load_queue(pool).await?;
    let id = match queue::select_next(&entries, now_ms()) {
        Some(id) => id,
        None => return Ok(false),
    };
    let (service, file_path) = match entries.iter().find(|e| e.id == id) {
        Some(e) => (e.service, e.file_path.clone()),
        None => return Ok(false),
    };

    // Pre-attempt guard: a missing file fails permanently without burning a
    // network attempt (mirrors the Electron `processQueue` guard).
    if tokio::fs::metadata(&file_path).await.is_err() {
        queue::mark_failed(&mut entries, &id, "file_not_found");
        persist_entry(pool, &entries, &id).await?;
        return Ok(true);
    }

    queue::mark_uploading(&mut entries, &id);
    persist_entry(pool, &entries, &id).await?;

    let token = match access_token(service, config).await {
        TokenOutcome::Ok(t) => t,
        TokenOutcome::NeedsReauth => {
            queue::on_failure(
                &mut entries,
                &id,
                FailureKind::NeedsReauth,
                "reauth required",
                now_ms(),
            );
            persist_entry(pool, &entries, &id).await?;
            return Ok(true);
        }
        TokenOutcome::Transient(msg) => {
            queue::on_failure(&mut entries, &id, FailureKind::Retryable, msg, now_ms());
            persist_entry(pool, &entries, &id).await?;
            return Ok(true);
        }
    };

    match upload_file(&token, &file_path).await {
        Ok(()) => {
            queue::on_success(&mut entries, &id);
            store::delete_entry(pool, &id).await?;
        }
        Err(e) => {
            queue::on_failure(
                &mut entries,
                &id,
                FailureKind::Retryable,
                e.to_string(),
                now_ms(),
            );
            persist_entry(pool, &entries, &id).await?;
        }
    }
    Ok(true)
}

/// Spawn the background worker loop. Idles (long sleep) when cloud isn't
/// configured or the queue is empty; otherwise drains and re-schedules itself
/// off `queue::next_wakeup_delay_ms`.
pub fn spawn(pool: SqlitePool, config: Option<GoogleOAuthConfig>) {
    // Use Tauri's async runtime handle, not bare `tokio::spawn`: this is called
    // from the synchronous `setup` hook on the main thread, where no tokio
    // runtime is *entered*, so `tokio::spawn` would panic ("must be called from
    // the context of a Tokio runtime"). Inside `setup` that panic crosses the
    // non-unwinding `did_finish_launching` ObjC callback and aborts the process
    // before the window ever opens. `tauri::async_runtime::spawn` holds a live
    // handle and works regardless of the current thread's context — matching
    // every other spawn in this crate (scheduler/preroll/engine/preview).
    tauri::async_runtime::spawn(async move {
        if config.is_none() {
            tracing::info!("cloud upload worker idle: Google OAuth client not configured");
        }
        loop {
            let Some(cfg) = config.as_ref() else {
                tokio::time::sleep(IDLE_SLEEP).await;
                continue;
            };
            match process_once(&pool, cfg).await {
                Ok(true) => {
                    // Did work — keep draining promptly.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                Ok(false) => {}
                Err(e) => tracing::warn!("cloud upload worker: {e}"),
            }
            let entries = store::load_queue(&pool).await.unwrap_or_default();
            let sleep = queue::next_wakeup_delay_ms(&entries, now_ms())
                .map(|ms| Duration::from_millis(ms.max(0) as u64))
                .unwrap_or(IDLE_SLEEP);
            tokio::time::sleep(sleep).await;
        }
    });
}
