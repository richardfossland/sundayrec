//! SundayRec main library — Tauri runtime entry point.
//!
//! Phase 0 wires up the bare bridge: structured logging (tracing), the
//! opener/dialog/process plugins, and a single `app_info` IPC command that
//! proves the Rust ↔ React bridge works and surfaces the running build's
//! identity on screen.
//!
//! All recorder *behaviour* lives in the `sundayrec-core` crate (pure, testable
//! Rust). This file and `commands::*` are the thin command/event layer on top —
//! see `docs/MIGRATION-TAURI2.md` §4 "Arkitektur".
//!
//! Module map (most are placeholders until their phase):
//!   audio     cpal backend — input-device enum + the VU metering engine
//!   commands  thin Tauri IPC handlers (`entity_verb`)
//!   error     centralised `AppError` (serialises to `{ code, message }`)
//!   media     bundled ffmpeg sidecar — resolution + tokio spawn primitive

pub mod audio;
pub mod commands;
pub mod db;
pub mod error;
pub mod media;
pub mod recorder;
pub mod secrets;
pub mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        // The VU engine holds at most one running cpal session; commands reach
        // it through managed state.
        .manage(audio::vu::VuEngine::new())
        // The preview engine holds at most one running ffmpeg MJPEG stream.
        .manage(media::preview::PreviewEngine::new())
        // The recorder engine holds at most one running unified ffmpeg capture
        // (Spike B). Commands reach it through managed state.
        .manage(recorder::engine::RecorderEngine::new())
        .setup(|app| {
            use tauri::Manager;

            // Open the app database (settings + recording history) once and
            // share it as managed state. Lives under the OS app-data dir so it
            // survives reinstalls and isn't tied to the executable location.
            let db_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("resolving app data dir: {e}"))?;
            std::fs::create_dir_all(&db_dir)
                .map_err(|e| format!("creating app data dir {}: {e}", db_dir.display()))?;
            let db_path = db_dir.join("sundayrec.sqlite");
            let pool = tauri::async_runtime::block_on(db::store::open_pool(&db_path))
                .map_err(|e| format!("opening database at {}: {e}", db_path.display()))?;
            app.manage(db::Db::new(pool));

            tracing::info!("SundayRec backend ready (db at {})", db_path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::audio::list_input_devices,
            commands::audio::list_devices,
            commands::audio::start_vu,
            commands::audio::stop_vu,
            commands::media::ffmpeg_health,
            commands::media::start_preview,
            commands::media::stop_preview,
            commands::recorder::list_recording_devices,
            commands::recorder::start_recording,
            commands::recorder::stop_recording,
            commands::db::setting_get,
            commands::db::setting_set,
            commands::db::recordings_list,
            commands::db::recordings_delete,
            commands::db::recordings_clear,
            commands::db::recording_update_note,
            commands::settings::settings_get,
            commands::settings::settings_save,
            commands::settings::settings_reset,
            commands::settings::settings_export,
            commands::settings::settings_import,
            commands::settings::settings_export_to_file,
            commands::settings::settings_import_from_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
