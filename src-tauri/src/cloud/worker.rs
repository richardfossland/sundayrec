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

/// Hard ceiling on a single file's resumable chunk loop. Drive resumable
/// sessions can stall indefinitely — a server that keeps answering `308 Resume
/// Incomplete` without ever advancing the offset, or a connection that hangs
/// mid-PUT — and without a bound the worker loops forever on one entry and
/// drains nothing else. 10 minutes is comfortably longer than any legitimate
/// recording upload on a usable connection; exceeding it aborts the attempt so
/// the entry fails *retryably* and the durable queue's existing backoff retries
/// it later (a fresh resumable session) instead of wedging the whole worker.
const UPLOAD_DEADLINE: Duration = Duration::from_secs(600);

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
    let client = super::http_client();
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
        // Classify from the body, but do NOT put the raw response into the error:
        // it's persisted to the queue's `last_error` and shown in the UI. Surface
        // only the status; the full body goes to the (local) debug log.
        tracing::debug!(%status, "cloud token refresh failed");
        return match oauth::classify_refresh_error(&text) {
            oauth::RefreshErrorKind::InvalidGrant => TokenOutcome::NeedsReauth,
            oauth::RefreshErrorKind::Other => TokenOutcome::Transient(format!(
                "token-oppdatering feilet (HTTP {})",
                status.as_u16()
            )),
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
async fn upload_file(
    access_token: &str,
    file_path: &str,
    folder_id: Option<&str>,
) -> AppResult<()> {
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

    // A connect timeout fails fast on a dead host. We deliberately DON'T set a
    // whole-request timeout here: a single resumable chunk on a slow-but-healthy
    // link can legitimately run minutes, and the overall attempt is already
    // bounded by `UPLOAD_DEADLINE` in `process_once`.
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    // 1. Initiate the resumable session; the server returns the upload URI.
    let init = client
        .post(UPLOAD_INIT_URL)
        .bearer_auth(access_token)
        .header("content-type", "application/json; charset=UTF-8")
        .header("x-upload-content-type", mime)
        .body(drive::build_init_body(filename, &description, folder_id))
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
                let next = put
                    .headers()
                    .get("range")
                    .and_then(|h| h.to_str().ok())
                    .and_then(drive::parse_resume_offset)
                    .unwrap_or(plan.offset + plan.len);
                // The new offset MUST advance past what we just sent. A server
                // that replays an old/short Range would otherwise make us re-send
                // the same chunk forever (until the 10-min deadline). Fail fast
                // (retryable) instead of spinning.
                if next <= plan.offset {
                    return Err(AppError::Internal(format!(
                        "resumable upload did not advance (offset {} after sending from {})",
                        next, plan.offset
                    )));
                }
                offset = next;
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

    // Honour the user's chosen Drive folder (set via the folder picker). Without
    // this every backup landed in Drive root regardless of the selection. A
    // missing/unreadable selection → root (Drive's default), as before.
    let folder_id = super::get_folder(pool, service)
        .await
        .ok()
        .flatten()
        .map(|f| f.folder_id)
        .filter(|f| !f.trim().is_empty());

    // Bound the whole resumable upload: a Drive session that stalls (308 forever
    // / a hung PUT) must give up rather than loop on this one entry indefinitely.
    // A timeout is treated as a retryable failure so the queue's backoff retries
    // it later with a fresh session.
    let outcome = match tokio::time::timeout(
        UPLOAD_DEADLINE,
        upload_file(&token, &file_path, folder_id.as_deref()),
    )
    .await
    {
        Ok(res) => res,
        Err(_) => {
            tracing::warn!("cloud upload worker: upload exceeded {UPLOAD_DEADLINE:?}; will retry");
            Err(AppError::Internal(format!(
                "upload exceeded {UPLOAD_DEADLINE:?}"
            )))
        }
    };
    match outcome {
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
        // Crash recovery: an entry left in `Uploading` was interrupted by a crash /
        // force-quit mid-upload. `select_next` only picks `Pending`, so without this
        // it would sit stuck forever and that backup would silently never happen.
        // At boot any `Uploading` is stale → requeue it (the upload restarts fresh).
        if let Ok(mut entries) = store::load_queue(&pool).await {
            let stale: Vec<String> = entries
                .iter()
                .filter(|e| e.status == queue::UploadStatus::Uploading)
                .map(|e| e.id.clone())
                .collect();
            if !stale.is_empty() {
                queue::reset_stale_uploading(&mut entries);
                tracing::info!(
                    "cloud upload: requeued {} interrupted upload(s) from a previous session",
                    stale.len()
                );
                for id in &stale {
                    let _ = persist_entry(&pool, &entries, id).await;
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_deadline_is_bounded_and_generous() {
        // The per-upload ceiling must be finite (so a stalled 308-forever session
        // can't wedge the worker on one entry) yet far longer than any legitimate
        // recording upload on a usable connection.
        assert!(UPLOAD_DEADLINE >= Duration::from_secs(60));
        assert!(UPLOAD_DEADLINE <= Duration::from_secs(3600));
    }

    #[tokio::test]
    async fn timeout_fires_on_a_stalled_upload() {
        // Model the "308 Resume Incomplete forever" stall: a future that never
        // completes must be cut off by the deadline and surface as an error
        // (which `process_once` maps to a retryable failure). Uses a tiny real
        // deadline so the test is fast; the production constant is the same
        // `tokio::time::timeout` wrapper, just longer.
        let stalled = std::future::pending::<AppResult<()>>();
        let res = tokio::time::timeout(Duration::from_millis(20), stalled).await;
        assert!(res.is_err(), "a never-completing upload must time out");
    }
}
