//! Settings persistence — the thin sqlx shell over the pure core model.
//!
//! The whole [`Settings`](sundayrec_core::settings::Settings) struct is stored
//! as one JSON string in the `app_setting` key/value bag under the key
//! [`SETTINGS_KEY`]. This replaces the Electron `electron-store` JSON blob; the
//! per-field defaults, validation (clamping) and partial-JSON merge all live in
//! `sundayrec-core` (and carry the tests). This module only reads/writes that
//! one row and threads the core's `from_json_merged` → `validate` pipeline.

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
}
