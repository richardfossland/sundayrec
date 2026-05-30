//! SQLite-backed local store (sqlx).
//!
//! Replaces the Electron build's `electron-store` JSON blob. All queries are
//! runtime-checked (`sqlx::query`/`query_as` + `.bind()`), so building needs no
//! `DATABASE_URL` or `.sqlx` cache. Every function takes `&SqlitePool`, so they
//! are unit-tested against a throwaway temp database with no app or device —
//! see the tests at the bottom.
//!
//! One database file for the app (settings + recording history). The schema
//! lives in `migrations/` and is applied by [`open_pool`].

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};
use ts_rs::TS;
use uuid::Uuid;

use crate::error::AppResult;

/// Epoch milliseconds as f64 — matches the REAL columns and the TS `number`.
pub fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// A fresh time-ordered id (UUID v7).
pub fn new_id() -> String {
    Uuid::now_v7().to_string()
}

/// Open (creating if needed) the SQLite database at `db_path` and run all
/// pending migrations. Foreign keys are enforced.
pub async fn open_pool(db_path: &Path) -> AppResult<SqlitePool> {
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePool::connect_with(opts).await?;
    sqlx::migrate!().run(&pool).await?;
    Ok(pool)
}

// ── Settings (key/value bag) ─────────────────────────────────────────────────

/// Read a setting's raw (JSON-encoded) value, or `None` if unset.
pub async fn get_setting(pool: &SqlitePool, key: &str) -> AppResult<Option<String>> {
    let row = sqlx::query("SELECT value FROM app_setting WHERE key = ?1")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| r.get::<String, _>("value")))
}

/// Insert or update a setting (UPSERT) — there is no separate "save" step.
pub async fn set_setting(pool: &SqlitePool, key: &str, value: &str) -> AppResult<()> {
    sqlx::query(
        "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// All settings as `(key, value)` pairs, ordered by key for stable output.
pub async fn get_all_settings(pool: &SqlitePool) -> AppResult<Vec<(String, String)>> {
    let rows = sqlx::query("SELECT key, value FROM app_setting ORDER BY key")
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|r| (r.get::<String, _>("key"), r.get::<String, _>("value")))
        .collect())
}

/// Remove a setting. No-op if it doesn't exist.
pub async fn delete_setting(pool: &SqlitePool, key: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM app_setting WHERE key = ?1")
        .bind(key)
        .execute(pool)
        .await?;
    Ok(())
}

// ── Recording history ────────────────────────────────────────────────────────

/// One recording-history row. `id`/`created_at` are assigned by
/// [`insert_recording`] when omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingRow.ts")]
pub struct RecordingRow {
    pub id: String,
    pub file_path: String,
    pub device_name: Option<String>,
    pub started_at: f64,
    pub duration_ms: Option<f64>,
    #[ts(type = "number")]
    pub byte_size: Option<i64>,
    pub created_at: f64,
}

/// Insert a recording. If `id` is empty a fresh UUID v7 is assigned; if
/// `created_at` is 0 it is stamped with [`now_ms`]. Returns the stored row.
pub async fn insert_recording(pool: &SqlitePool, mut row: RecordingRow) -> AppResult<RecordingRow> {
    if row.id.is_empty() {
        row.id = new_id();
    }
    if row.created_at == 0.0 {
        row.created_at = now_ms();
    }
    sqlx::query(
        "INSERT INTO recording
            (id, file_path, device_name, started_at, duration_ms, byte_size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )
    .bind(&row.id)
    .bind(&row.file_path)
    .bind(&row.device_name)
    .bind(row.started_at)
    .bind(row.duration_ms)
    .bind(row.byte_size)
    .bind(row.created_at)
    .execute(pool)
    .await?;
    Ok(row)
}

/// List recordings, newest first.
pub async fn list_recordings(pool: &SqlitePool) -> AppResult<Vec<RecordingRow>> {
    let rows = sqlx::query(
        "SELECT id, file_path, device_name, started_at, duration_ms, byte_size, created_at
         FROM recording ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| RecordingRow {
            id: r.get("id"),
            file_path: r.get("file_path"),
            device_name: r.get("device_name"),
            started_at: r.get("started_at"),
            duration_ms: r.get("duration_ms"),
            byte_size: r.get("byte_size"),
            created_at: r.get("created_at"),
        })
        .collect())
}

/// Delete a recording-history row by id. No-op if it doesn't exist.
pub async fn delete_recording(pool: &SqlitePool, id: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM recording WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pool over a temp-dir database file, fully migrated.
    async fn temp_pool() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (pool, dir)
    }

    fn sample(file: &str, started: f64) -> RecordingRow {
        RecordingRow {
            id: String::new(),
            file_path: file.to_string(),
            device_name: Some("Built-in Microphone".to_string()),
            started_at: started,
            duration_ms: Some(1234.0),
            byte_size: Some(4096),
            created_at: 0.0,
        }
    }

    #[tokio::test]
    async fn migrations_create_tables() {
        let (pool, _d) = temp_pool().await;
        // Both tables must exist and be queryable on a fresh database.
        assert!(get_all_settings(&pool).await.unwrap().is_empty());
        assert!(list_recordings(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn setting_upsert_get_and_delete() {
        let (pool, _d) = temp_pool().await;
        assert_eq!(get_setting(&pool, "theme").await.unwrap(), None);

        set_setting(&pool, "theme", "\"dark\"").await.unwrap();
        assert_eq!(
            get_setting(&pool, "theme").await.unwrap().as_deref(),
            Some("\"dark\"")
        );

        // UPSERT overwrites rather than erroring on the existing key.
        set_setting(&pool, "theme", "\"light\"").await.unwrap();
        assert_eq!(
            get_setting(&pool, "theme").await.unwrap().as_deref(),
            Some("\"light\"")
        );

        delete_setting(&pool, "theme").await.unwrap();
        assert_eq!(get_setting(&pool, "theme").await.unwrap(), None);
        // Deleting a missing key is a no-op, not an error.
        delete_setting(&pool, "theme").await.unwrap();
    }

    #[tokio::test]
    async fn get_all_settings_is_sorted_by_key() {
        let (pool, _d) = temp_pool().await;
        set_setting(&pool, "zebra", "1").await.unwrap();
        set_setting(&pool, "alpha", "2").await.unwrap();
        let all = get_all_settings(&pool).await.unwrap();
        assert_eq!(
            all,
            vec![
                ("alpha".to_string(), "2".to_string()),
                ("zebra".to_string(), "1".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn insert_assigns_id_and_created_at() {
        let (pool, _d) = temp_pool().await;
        let stored = insert_recording(&pool, sample("/tmp/a.mp3", 100.0))
            .await
            .unwrap();
        assert!(!stored.id.is_empty(), "id should be assigned");
        assert!(stored.created_at > 0.0, "created_at should be stamped");
    }

    #[tokio::test]
    async fn list_recordings_is_newest_first() {
        let (pool, _d) = temp_pool().await;
        let mut a = sample("/tmp/old.mp3", 1.0);
        a.created_at = 1_000.0;
        let mut b = sample("/tmp/new.mp3", 2.0);
        b.created_at = 2_000.0;
        insert_recording(&pool, a).await.unwrap();
        insert_recording(&pool, b).await.unwrap();

        let list = list_recordings(&pool).await.unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].file_path, "/tmp/new.mp3");
        assert_eq!(list[1].file_path, "/tmp/old.mp3");
    }

    #[tokio::test]
    async fn delete_recording_removes_the_row() {
        let (pool, _d) = temp_pool().await;
        let stored = insert_recording(&pool, sample("/tmp/x.mp3", 5.0))
            .await
            .unwrap();
        delete_recording(&pool, &stored.id).await.unwrap();
        assert!(list_recordings(&pool).await.unwrap().is_empty());
        // Deleting a missing id is a no-op.
        delete_recording(&pool, "nonexistent").await.unwrap();
    }

    #[tokio::test]
    async fn optional_columns_round_trip_as_null() {
        let (pool, _d) = temp_pool().await;
        let row = RecordingRow {
            id: String::new(),
            file_path: "/tmp/partial.mp3".to_string(),
            device_name: None,
            started_at: 10.0,
            duration_ms: None,
            byte_size: None,
            created_at: 0.0,
        };
        let stored = insert_recording(&pool, row).await.unwrap();
        let back = list_recordings(&pool).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].device_name, None);
        assert_eq!(back[0].duration_ms, None);
        assert_eq!(back[0].byte_size, None);
        assert_eq!(back[0].id, stored.id);
    }
}
