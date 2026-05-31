//! Settings persistence — the thin sqlx shell over the pure core model.
//!
//! The whole [`Settings`](sundayrec_core::settings::Settings) struct is stored
//! as one JSON string in the `app_setting` key/value bag under the key
//! [`SETTINGS_KEY`]. This replaces the Electron `electron-store` JSON blob; the
//! per-field defaults, validation (clamping) and partial-JSON merge all live in
//! `sundayrec-core` (and carry the tests). This module only reads/writes that
//! one row and threads the core's `from_json_merged` → `validate` pipeline.

use std::path::Path;

use sqlx::SqlitePool;
use sundayrec_core::settings::Settings;

use crate::db::store;
use crate::error::AppResult;

/// The `app_setting` key the whole settings blob lives under.
pub const SETTINGS_KEY: &str = "settings";

/// Load the settings: read the stored JSON (or fall back to defaults when the
/// key is absent), merge it over the defaults so older/partial blobs never
/// crash, then validate (clamp numeric ranges). The result is always a valid
/// [`Settings`].
pub async fn load(pool: &SqlitePool) -> AppResult<Settings> {
    let raw = store::get_setting(pool, SETTINGS_KEY).await?;
    let mut settings = match raw {
        Some(json) => Settings::from_json_merged(&json),
        None => Settings::default(),
    };
    settings.validate();
    Ok(settings)
}

/// Validate then persist the settings, returning the stored (validated) value.
pub async fn save(pool: &SqlitePool, mut settings: Settings) -> AppResult<Settings> {
    settings.validate();
    let json = serde_json::to_string(&settings)?;
    store::set_setting(pool, SETTINGS_KEY, &json).await?;
    Ok(settings)
}

/// Reset to the defaults, persisting them, and return the defaults.
pub async fn reset(pool: &SqlitePool) -> AppResult<Settings> {
    save(pool, Settings::default()).await
}

/// Export the current (validated) settings as pretty-printed JSON.
pub async fn export(pool: &SqlitePool) -> AppResult<String> {
    let settings = load(pool).await?;
    Ok(serde_json::to_string_pretty(&settings)?)
}

/// Import a (possibly partial/older) settings JSON: merge over defaults,
/// validate, persist, and return the stored value. Mirrors the Electron
/// `importProfile` resilience — a partial or unknown-field blob is accepted,
/// missing fields take their defaults.
pub async fn import(pool: &SqlitePool, json: &str) -> AppResult<Settings> {
    let merged = Settings::from_json_merged(json);
    save(pool, merged).await
}

/// Export the current settings as pretty JSON and write them to `path`. The
/// renderer picks the destination through the native save dialog (F1.3); this
/// thin wrapper only does the file I/O so the dialog plumbing stays in JS.
/// An I/O failure surfaces as [`AppError::Io`](crate::error::AppError::Io).
pub async fn export_to_path(pool: &SqlitePool, path: &Path) -> AppResult<()> {
    let json = export(pool).await?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Read a settings JSON file from `path` and import it (merge over defaults →
/// validate → persist), returning the stored value. The renderer picks the
/// source through the native open dialog (F1.3). A read failure surfaces as
/// [`AppError::Io`](crate::error::AppError::Io); malformed-but-readable JSON is
/// tolerated by the merge (unknown/missing fields take their defaults).
pub async fn import_from_path(pool: &SqlitePool, path: &Path) -> AppResult<Settings> {
    let json = std::fs::read_to_string(path)?;
    import(pool, &json).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sundayrec_core::settings::{ChannelMode, FileFormat};

    /// A pool over a temp-dir database file, fully migrated.
    async fn temp_pool() -> (SqlitePool, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let pool = store::open_pool(&dir.path().join("test.sqlite"))
            .await
            .expect("open_pool");
        (pool, dir)
    }

    #[tokio::test]
    async fn load_returns_defaults_when_unset() {
        let (pool, _d) = temp_pool().await;
        let s = load(&pool).await.unwrap();
        assert_eq!(s, Settings::default());
    }

    #[tokio::test]
    async fn save_then_load_round_trips() {
        let (pool, _d) = temp_pool().await;
        let s = Settings {
            language: Some("en".to_string()),
            channels: ChannelMode::MonoMix,
            format: FileFormat::Wav,
            input_volume: 150,
            ..Default::default()
        };

        let stored = save(&pool, s.clone()).await.unwrap();
        assert_eq!(stored, s);

        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded, s);
    }

    #[tokio::test]
    async fn save_validates_before_persisting() {
        let (pool, _d) = temp_pool().await;
        let s = Settings {
            sample_rate: 999_999,
            input_volume: 5_000,
            ..Default::default()
        };
        let stored = save(&pool, s).await.unwrap();
        assert_eq!(stored.sample_rate, 192_000);
        assert_eq!(stored.input_volume, 200);
        // Persisted value is the clamped one.
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded.sample_rate, 192_000);
        assert_eq!(loaded.input_volume, 200);
    }

    #[tokio::test]
    async fn load_merges_partial_stored_blob_over_defaults() {
        let (pool, _d) = temp_pool().await;
        // Simulate an older/partial blob written directly to the store.
        store::set_setting(&pool, SETTINGS_KEY, r#"{ "sampleRate": 44100 }"#)
            .await
            .unwrap();
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded.sample_rate, 44_100);
        // Everything else defaulted.
        assert_eq!(loaded.input_volume, 100);
        assert_eq!(loaded.channels, ChannelMode::Stereo);
    }

    #[tokio::test]
    async fn reset_persists_defaults() {
        let (pool, _d) = temp_pool().await;
        let s = Settings {
            input_volume: 150,
            ..Default::default()
        };
        save(&pool, s).await.unwrap();

        let after = reset(&pool).await.unwrap();
        assert_eq!(after, Settings::default());
        assert_eq!(load(&pool).await.unwrap(), Settings::default());
    }

    #[tokio::test]
    async fn export_then_import_round_trips() {
        let (pool, _d) = temp_pool().await;
        let s = Settings {
            language: Some("de".to_string()),
            format: FileFormat::Flac,
            ..Default::default()
        };
        save(&pool, s.clone()).await.unwrap();

        let json = export(&pool).await.unwrap();
        assert!(json.contains("\"language\""));

        // Fresh database — import the exported JSON.
        let (pool2, _d2) = temp_pool().await;
        let imported = import(&pool2, &json).await.unwrap();
        assert_eq!(imported, s);
        assert_eq!(load(&pool2).await.unwrap(), s);
    }

    #[tokio::test]
    async fn import_accepts_partial_json() {
        let (pool, _d) = temp_pool().await;
        let imported = import(&pool, r#"{ "language": "fr" }"#).await.unwrap();
        assert_eq!(imported.language, Some("fr".to_string()));
        assert_eq!(imported.input_volume, 100);
    }

    #[tokio::test]
    async fn export_to_path_then_import_from_path_round_trips() {
        let (pool, _d) = temp_pool().await;
        let s = Settings {
            language: Some("de".to_string()),
            format: FileFormat::Flac,
            input_volume: 150,
            ..Default::default()
        };
        save(&pool, s.clone()).await.unwrap();

        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("settings.json");
        export_to_path(&pool, &file).await.unwrap();

        // The file is real, pretty JSON.
        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert!(on_disk.contains("\"language\""));
        assert!(on_disk.contains('\n'), "expected pretty (multi-line) JSON");

        // Fresh database — import the file back.
        let (pool2, _d2) = temp_pool().await;
        let imported = import_from_path(&pool2, &file).await.unwrap();
        assert_eq!(imported, s);
        assert_eq!(load(&pool2).await.unwrap(), s);
    }

    #[tokio::test]
    async fn import_from_path_errors_on_missing_file() {
        let (pool, _d) = temp_pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist.json");
        let err = import_from_path(&pool, &missing).await.unwrap_err();
        assert_eq!(err.code(), "io");
    }

    #[tokio::test]
    async fn save_overwrites_the_prior_blob_rather_than_appending() {
        let (pool, _d) = temp_pool().await;
        save(
            &pool,
            Settings {
                input_volume: 150,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        // A second save with a different value must REPLACE, not stack a row —
        // there is exactly one settings key and the latest value wins.
        save(
            &pool,
            Settings {
                input_volume: 80,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(load(&pool).await.unwrap().input_volume, 80);
        // Exactly one row backs the settings key.
        assert_eq!(
            store::get_all_settings(&pool)
                .await
                .unwrap()
                .iter()
                .filter(|(k, _)| k == SETTINGS_KEY)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn import_whitespace_only_json_falls_back_to_defaults() {
        let (pool, _d) = temp_pool().await;
        // A blank/whitespace blob isn't valid JSON; the merge tolerates it and
        // yields the defaults (mirrors the Electron importProfile resilience).
        let imported = import(&pool, "   \n  ").await.unwrap();
        assert_eq!(imported, Settings::default());
        assert_eq!(load(&pool).await.unwrap(), Settings::default());
    }

    #[tokio::test]
    async fn import_clamps_out_of_range_values_before_persisting() {
        let (pool, _d) = temp_pool().await;
        // An imported blob with an out-of-range numeric is clamped on the way in.
        let imported = import(&pool, r#"{ "inputVolume": 9000, "sampleRate": 1 }"#)
            .await
            .unwrap();
        assert_eq!(imported.input_volume, 200);
        assert_eq!(imported.sample_rate, 8_000);
        // The persisted value is the clamped one, not the raw import.
        let loaded = load(&pool).await.unwrap();
        assert_eq!(loaded.input_volume, 200);
        assert_eq!(loaded.sample_rate, 8_000);
    }

    #[tokio::test]
    async fn export_to_path_overwrites_an_existing_file() {
        let (pool, _d) = temp_pool().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("settings.json");
        // Pre-seed the destination with stale content.
        std::fs::write(&file, "STALE CONTENT THAT MUST BE REPLACED").unwrap();

        save(
            &pool,
            Settings {
                language: Some("sv".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        export_to_path(&pool, &file).await.unwrap();

        let on_disk = std::fs::read_to_string(&file).unwrap();
        assert!(!on_disk.contains("STALE"), "stale content must be gone");
        assert!(on_disk.contains("\"sv\""), "fresh export written");
    }
}
