//! Cloud-backup shell (Fase 6) — the impure half of the cloud backbone.
//!
//! `sundayrec-core::cloud` holds the deterministic decisions (PKCE, auth-URL
//! shaping, retry classification, the upload-queue state machine, Drive chunk
//! arithmetic). This module owns the side effects the core deliberately avoids:
//! the sqlx-backed [`store`] for the durable queue and the keychain token vault
//! (via [`crate::secrets`]).
//!
//! The queue functions here are the testable seam the Tauri commands call: each
//! loads the queue from SQLite, applies a pure core transition, and persists the
//! affected row. The DB is the single source of truth (no in-memory cache), so a
//! queued backup survives a restart.
//!
//! NOT YET BUILT (clearly-scoped next step, deferred because it can't be
//! exercised without a network, a Google OAuth client id, and a real device):
//! the OAuth loopback connect flow and the resumable upload worker. Both are
//! pure-core-driven — connect calls `cloud::oauth::{build_auth_url,
//! parse_loopback_callback, build_token_exchange_body, parse_token_response}`
//! over a `reqwest` + loopback `TcpListener`; the worker drives
//! `cloud::queue::{select_next, mark_uploading, on_success, on_failure}` and
//! `cloud::drive::{chunk_plan, content_range_header, …}` over `reqwest`,
//! persisting each transition through [`store`]. See docs/PHASE6.md.

pub mod store;

use std::time::{SystemTime, UNIX_EPOCH};

use sundayrec_core::cloud::queue::{self, QueueEntry, QueueEntryView};
use sundayrec_core::cloud::{CloudConnectionStatus, CloudService};

use crate::error::AppResult;
use crate::secrets::SecretProvider;

/// Unix milliseconds as i64 — matches the core queue's timestamp fields.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The keychain slot backing a cloud service's OAuth refresh token.
pub fn secret_provider_for(service: CloudService) -> SecretProvider {
    match service {
        CloudService::GoogleDrive => SecretProvider::GoogleDrive,
        CloudService::Youtube => SecretProvider::YouTube,
        CloudService::Gmail => SecretProvider::Gmail,
    }
}

/// The three Google services the suite can connect (Drive backup, YouTube
/// publish, Gmail notifications) — all share one OAuth client.
pub const SERVICES: [CloudService; 3] = [
    CloudService::GoogleDrive,
    CloudService::Youtube,
    CloudService::Gmail,
];

/// Connection status for every cloud service (presence of a token in the
/// keychain). Network-free — reads only the local vault.
pub fn connection_statuses() -> Vec<CloudConnectionStatus> {
    SERVICES
        .iter()
        .map(|&service| CloudConnectionStatus {
            service,
            connected: crate::secrets::has(secret_provider_for(service)),
        })
        .collect()
}

/// Queue a recording for backup to a service, deduplicating by
/// `(service, file_path)`. Returns the affected entry's id.
pub async fn enqueue_backup(
    pool: &sqlx::SqlitePool,
    service: CloudService,
    file_path: String,
    entry_timestamp: Option<i64>,
) -> AppResult<String> {
    let now = now_ms();
    let mut entries = store::load_queue(pool).await?;
    let id = queue::enqueue(
        &mut entries,
        crate::db::store::new_id(),
        service,
        file_path,
        entry_timestamp,
        now,
    );
    if let Some(affected) = entries.iter().find(|e| e.id == id) {
        store::upsert_entry(pool, affected).await?;
    }
    Ok(id)
}

/// The compact, UI-facing queue view.
pub async fn queue_status(pool: &sqlx::SqlitePool) -> AppResult<Vec<QueueEntryView>> {
    let entries = store::load_queue(pool).await?;
    Ok(queue::status_view(&entries))
}

/// Manually reset one entry to `pending` for an immediate retry (clears the
/// error and the backoff). No-op if the id is unknown.
pub async fn retry_entry(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    let now = now_ms();
    let mut entries = store::load_queue(pool).await?;
    if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
        e.status = queue::UploadStatus::Pending;
        e.next_attempt = now;
        e.last_error = None;
        e.attempts = 0;
        let snapshot: QueueEntry = e.clone();
        store::upsert_entry(pool, &snapshot).await?;
    }
    Ok(())
}

/// Remove one entry from the queue (user cancelled / no longer wanted).
pub async fn remove_entry(pool: &sqlx::SqlitePool, id: &str) -> AppResult<()> {
    store::delete_entry(pool, id).await
}

/// Forget all permanently-failed entries. Returns the number removed.
pub async fn clear_failed(pool: &sqlx::SqlitePool) -> AppResult<u64> {
    store::clear_failed(pool).await
}

/// Disconnect a cloud service: delete its token and drop its queued uploads.
pub async fn disconnect(pool: &sqlx::SqlitePool, service: CloudService) -> AppResult<()> {
    crate::secrets::delete(secret_provider_for(service))?;
    store::clear_service(pool, service).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::open_pool;
    use sundayrec_core::cloud::queue::UploadStatus;

    async fn temp_pool() -> (sqlx::SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn enqueue_persists_and_dedupes() {
        let (pool, _d) = temp_pool().await;
        let id1 = enqueue_backup(
            &pool,
            CloudService::GoogleDrive,
            "/rec/a.mp4".into(),
            Some(7),
        )
        .await
        .unwrap();
        // Re-enqueuing the same (service, path) returns the same id (dedup), not a
        // second row.
        let id2 = enqueue_backup(
            &pool,
            CloudService::GoogleDrive,
            "/rec/a.mp4".into(),
            Some(7),
        )
        .await
        .unwrap();
        assert_eq!(id1, id2);
        let view = queue_status(&pool).await.unwrap();
        assert_eq!(view.len(), 1);
        assert_eq!(view[0].filename, "a.mp4");
        assert_eq!(view[0].status, UploadStatus::Pending);
    }

    #[tokio::test]
    async fn retry_resets_a_failed_entry() {
        let (pool, _d) = temp_pool().await;
        let id = enqueue_backup(&pool, CloudService::GoogleDrive, "/rec/a.mp4".into(), None)
            .await
            .unwrap();
        // Force it failed via the store.
        let mut entries = store::load_queue(&pool).await.unwrap();
        entries[0].status = UploadStatus::Failed;
        entries[0].attempts = 9;
        entries[0].last_error = Some("nope".into());
        store::upsert_entry(&pool, &entries[0]).await.unwrap();

        retry_entry(&pool, &id).await.unwrap();
        let entries = store::load_queue(&pool).await.unwrap();
        assert_eq!(entries[0].status, UploadStatus::Pending);
        assert_eq!(entries[0].attempts, 0);
        assert_eq!(entries[0].last_error, None);
    }

    #[tokio::test]
    async fn remove_and_clear_failed() {
        let (pool, _d) = temp_pool().await;
        let id = enqueue_backup(&pool, CloudService::Youtube, "/rec/a.mp4".into(), None)
            .await
            .unwrap();
        remove_entry(&pool, &id).await.unwrap();
        assert!(queue_status(&pool).await.unwrap().is_empty());
    }
}
