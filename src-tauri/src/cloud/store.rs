//! SQLite persistence for the cloud upload queue (Fase 6).
//!
//! The decisions live in `sundayrec-core::cloud::queue` (a pure state machine
//! over `Vec<QueueEntry>`); this module is the durable mirror. Every function
//! takes `&SqlitePool`, so they unit-test against a throwaway database with no
//! network and no token store — see the tests at the bottom. The queue table is
//! the single source of truth: commands load it, apply a core transition, and
//! persist the affected row(s).

use sqlx::{Row, SqlitePool};

use sundayrec_core::cloud::queue::QueueEntry;
use sundayrec_core::cloud::CloudService;

use crate::error::{AppError, AppResult};

/// Serialise a core enum to its kebab-case wire string (the same string the
/// renderer and persisted rows use), via serde so the mapping never drifts.
fn enum_to_db<T: serde::Serialize>(value: &T) -> AppResult<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| AppError::Internal("enum did not serialise to a string".into()))
}

fn enum_from_db<T: serde::de::DeserializeOwned>(s: &str) -> AppResult<T> {
    Ok(serde_json::from_value(serde_json::Value::String(
        s.to_string(),
    ))?)
}

/// Load the whole queue (newest-enqueued last, then by id for stable ordering).
pub async fn load_queue(pool: &SqlitePool) -> AppResult<Vec<QueueEntry>> {
    let rows = sqlx::query(
        "SELECT id, service, file_path, entry_timestamp, attempts, next_attempt,
                last_error, enqueued_at, status
         FROM upload_queue ORDER BY enqueued_at, id",
    )
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(QueueEntry {
            id: r.get("id"),
            service: enum_from_db(&r.get::<String, _>("service"))?,
            file_path: r.get("file_path"),
            entry_timestamp: r.get::<Option<i64>, _>("entry_timestamp"),
            attempts: r.get::<i64, _>("attempts") as u32,
            next_attempt: r.get::<i64, _>("next_attempt"),
            last_error: r.get::<Option<String>, _>("last_error"),
            enqueued_at: r.get::<i64, _>("enqueued_at"),
            status: enum_from_db(&r.get::<String, _>("status"))?,
        });
    }
    Ok(out)
}

/// Insert or replace one entry (keyed by id).
pub async fn upsert_entry(pool: &SqlitePool, e: &QueueEntry) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO upload_queue
            (id, service, file_path, entry_timestamp, attempts, next_attempt,
             last_error, enqueued_at, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            service = excluded.service,
            file_path = excluded.file_path,
            entry_timestamp = excluded.entry_timestamp,
            attempts = excluded.attempts,
            next_attempt = excluded.next_attempt,
            last_error = excluded.last_error,
            enqueued_at = excluded.enqueued_at,
            status = excluded.status",
    )
    .bind(&e.id)
    .bind(enum_to_db(&e.service)?)
    .bind(&e.file_path)
    .bind(e.entry_timestamp)
    .bind(i64::from(e.attempts))
    .bind(e.next_attempt)
    .bind(&e.last_error)
    .bind(e.enqueued_at)
    .bind(enum_to_db(&e.status)?)
    .execute(pool)
    .await?;
    Ok(())
}

/// Delete one entry by id. No-op if missing.
pub async fn delete_entry(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM upload_queue WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Delete every permanently-failed entry. Returns the number removed.
pub async fn clear_failed(pool: &SqlitePool) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM upload_queue WHERE status = 'failed'")
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

/// Remove every entry (used by a full disconnect / reset).
pub async fn clear_all(pool: &SqlitePool) -> AppResult<()> {
    sqlx::query("DELETE FROM upload_queue")
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop all entries for one service (e.g. when that service is disconnected).
pub async fn clear_service(pool: &SqlitePool, service: CloudService) -> AppResult<u64> {
    let res = sqlx::query("DELETE FROM upload_queue WHERE service = ?1")
        .bind(enum_to_db(&service)?)
        .execute(pool)
        .await?;
    Ok(res.rows_affected())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::store::open_pool;
    use sundayrec_core::cloud::queue::UploadStatus;

    async fn temp_pool() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (pool, dir)
    }

    fn entry(id: &str, service: CloudService, path: &str) -> QueueEntry {
        QueueEntry {
            id: id.to_string(),
            service,
            file_path: path.to_string(),
            entry_timestamp: Some(111),
            attempts: 0,
            next_attempt: 1_000,
            last_error: None,
            enqueued_at: 1_000,
            status: UploadStatus::Pending,
        }
    }

    #[tokio::test]
    async fn migration_creates_empty_queue() {
        let (pool, _d) = temp_pool().await;
        assert!(load_queue(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn upsert_load_round_trips_all_fields() {
        let (pool, _d) = temp_pool().await;
        let mut e = entry("a", CloudService::GoogleDrive, "/rec/a.mp4");
        e.attempts = 3;
        e.next_attempt = 9_999;
        e.last_error = Some("boom".into());
        e.status = UploadStatus::Failed;
        upsert_entry(&pool, &e).await.unwrap();

        let back = load_queue(&pool).await.unwrap();
        assert_eq!(back, vec![e]);
    }

    #[tokio::test]
    async fn upsert_replaces_on_same_id() {
        let (pool, _d) = temp_pool().await;
        let mut e = entry("a", CloudService::Youtube, "/rec/a.mp4");
        upsert_entry(&pool, &e).await.unwrap();
        e.status = UploadStatus::Uploading;
        e.attempts = 1;
        upsert_entry(&pool, &e).await.unwrap();
        let back = load_queue(&pool).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].status, UploadStatus::Uploading);
        assert_eq!(back[0].attempts, 1);
    }

    #[tokio::test]
    async fn dedup_index_blocks_a_second_service_path_pair() {
        let (pool, _d) = temp_pool().await;
        upsert_entry(&pool, &entry("a", CloudService::Gmail, "/rec/a.mp4"))
            .await
            .unwrap();
        // Same (service, file_path) under a different id violates the unique index.
        let dup = entry("b", CloudService::Gmail, "/rec/a.mp4");
        assert!(upsert_entry(&pool, &dup).await.is_err());
    }

    #[tokio::test]
    async fn delete_and_clear_failed() {
        let (pool, _d) = temp_pool().await;
        let mut failed = entry("a", CloudService::GoogleDrive, "/rec/a.mp4");
        failed.status = UploadStatus::Failed;
        let pending = entry("b", CloudService::GoogleDrive, "/rec/b.mp4");
        upsert_entry(&pool, &failed).await.unwrap();
        upsert_entry(&pool, &pending).await.unwrap();

        assert_eq!(clear_failed(&pool).await.unwrap(), 1);
        let back = load_queue(&pool).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].id, "b");

        delete_entry(&pool, "b").await.unwrap();
        assert!(load_queue(&pool).await.unwrap().is_empty());
        // Deleting a missing id is a no-op.
        delete_entry(&pool, "ghost").await.unwrap();
    }

    #[tokio::test]
    async fn clear_service_only_drops_that_service() {
        let (pool, _d) = temp_pool().await;
        upsert_entry(&pool, &entry("a", CloudService::GoogleDrive, "/a.mp4"))
            .await
            .unwrap();
        upsert_entry(&pool, &entry("b", CloudService::Youtube, "/b.mp4"))
            .await
            .unwrap();
        assert_eq!(
            clear_service(&pool, CloudService::GoogleDrive)
                .await
                .unwrap(),
            1
        );
        let back = load_queue(&pool).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].service, CloudService::Youtube);
    }
}
