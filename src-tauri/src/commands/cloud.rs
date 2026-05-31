//! Cloud-backup commands — the thin IPC layer over `crate::cloud`.
//!
//! These borrow the managed [`Db`] pool and delegate to the queue functions in
//! `crate::cloud` (which carry the tests) and the keychain vault in
//! `crate::secrets`. All of these are network-free: they manage the durable
//! upload queue and report/clear local connection state. The actual OAuth
//! connect flow and the upload worker (network I/O) are a separate, deferred
//! step — see `crate::cloud` docs.

use tauri::{AppHandle, State};

use sundayrec_core::cloud::queue::QueueEntryView;
use sundayrec_core::cloud::{CloudConnectionStatus, CloudService};

use crate::cloud::{self, config::GoogleOAuthConfig};
use crate::db::Db;
use crate::error::{AppError, AppResult};

/// Resolve the Google OAuth config or a clear "not configured" error.
fn require_config() -> AppResult<GoogleOAuthConfig> {
    GoogleOAuthConfig::resolve().ok_or_else(|| {
        AppError::Validation(
            "Google OAuth is not configured (set SUNDAYREC_GOOGLE_CLIENT_ID)".into(),
        )
    })
}

/// Which cloud services currently hold a stored token (Drive/YouTube/Gmail).
#[tauri::command]
pub async fn cloud_connection_status() -> AppResult<Vec<CloudConnectionStatus>> {
    Ok(cloud::connection_statuses())
}

/// Start the OAuth loopback connect flow for a service (opens the browser).
/// NETWORK/HARDWARE-UNVERIFIED.
#[tauri::command]
pub async fn cloud_connect(app: AppHandle, service: CloudService) -> AppResult<()> {
    cloud::oauth_flow::connect(&app, service, &require_config()?).await
}

/// Manually run the next due upload now (the background worker also drains the
/// queue on its own schedule). Returns whether it processed an entry.
#[tauri::command]
pub async fn cloud_process_queue_now(db: State<'_, Db>) -> AppResult<bool> {
    cloud::worker::process_once(&db.pool, &require_config()?).await
}

/// The compact upload-queue view for the cloud-backup panel.
#[tauri::command]
pub async fn cloud_queue_status(db: State<'_, Db>) -> AppResult<Vec<QueueEntryView>> {
    cloud::queue_status(&db.pool).await
}

/// Queue a recording file for backup (dedupes by service + path). Returns the
/// affected entry's id.
#[tauri::command]
pub async fn cloud_enqueue_backup(
    db: State<'_, Db>,
    service: CloudService,
    file_path: String,
    entry_timestamp: Option<i64>,
) -> AppResult<String> {
    cloud::enqueue_backup(&db.pool, service, file_path, entry_timestamp).await
}

/// Reset one entry to `pending` for an immediate retry.
#[tauri::command]
pub async fn cloud_retry_upload(db: State<'_, Db>, id: String) -> AppResult<()> {
    cloud::retry_entry(&db.pool, &id).await
}

/// Remove one entry from the queue.
#[tauri::command]
pub async fn cloud_remove_upload(db: State<'_, Db>, id: String) -> AppResult<()> {
    cloud::remove_entry(&db.pool, &id).await
}

/// Forget all permanently-failed entries. Returns the number removed.
#[tauri::command]
pub async fn cloud_clear_failed(db: State<'_, Db>) -> AppResult<u64> {
    cloud::clear_failed(&db.pool).await
}

/// Disconnect a service: delete its token and drop its queued uploads.
#[tauri::command]
pub async fn cloud_disconnect(db: State<'_, Db>, service: CloudService) -> AppResult<()> {
    cloud::disconnect(&db.pool, service).await
}
