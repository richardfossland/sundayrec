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
pub mod cloud;
pub mod commands;
pub mod db;
pub mod diagnostics;
// PU-1 email alerts — default-off `email` feature (NETWORK-UNVERIFIED). The pure
// templates/throttle/MIME live in `sundayrec_core::email`; this seam sends.
#[cfg(feature = "email")]
pub mod email;
pub mod error;
pub mod media;
pub mod preflight;
// PU-3 podcast RSS publish — default-off `publish` feature (NETWORK-UNVERIFIED).
// The XML shaping is `sundayrec_core::feed`; this seam maps history + writes/uploads.
#[cfg(feature = "publish")]
pub mod publish;
pub mod recorder;
pub mod scheduler;
pub mod secrets;
pub mod settings;
// PU-2 menubar tray + `sundayrec://` deep-link handling — default-off `tray`
// feature (GUI-UNVERIFIED). The menu-model + link parse are in `sundayrec_core`;
// this seam maps them to tauri menu/tray + the scheme handler.
#[cfg(feature = "tray")]
pub mod tray;
pub mod wake;

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
        .plugin(tauri_plugin_notification::init())
        // The VU engine holds at most one running cpal session; commands reach
        // it through managed state.
        .manage(audio::vu::VuEngine::new())
        // The scheduler engine runs one supervisor task firing scheduled
        // start/stop/reminder/preflight events (Fase 5). Started in setup once
        // the db pool is managed.
        .manage(scheduler::SchedulerEngine::new())
        // The wake engine schedules OS wake-from-sleep timers (pmset/schtasks)
        // for upcoming recordings + dedups repeated reschedules (Fase 5.2).
        .manage(wake::WakeEngine::new())
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

            // Fase 6: drain the durable cloud-upload queue in the background.
            // Idles cleanly when Google OAuth isn't configured (no spinning).
            cloud::worker::spawn(pool.clone(), cloud::config::GoogleOAuthConfig::resolve());

            app.manage(db::Db::new(pool));

            // The pre-roll engine (F3.2) writes its rolling temp captures under
            // a `tmp` dir in app-data (cleaned up on harvest/stop). Managed here
            // because it needs the resolved app-data path. At most one loop runs.
            let tmp_dir = db_dir.join("tmp");
            app.manage(recorder::preroll::PrerollEngine::new(tmp_dir));

            // Launch the scheduler supervisor now that the db pool + recorder
            // engine are managed. It reads slots/specials from settings and
            // fires start/stop/reminder/preflight on the wall clock.
            app.state::<scheduler::SchedulerEngine>()
                .start(app.handle().clone());

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
            commands::recorder::recording_status,
            commands::recorder::preroll_start,
            commands::recorder::preroll_stop,
            commands::recorder::preroll_status,
            commands::db::setting_get,
            commands::db::setting_set,
            commands::db::recordings_list,
            commands::db::recordings_delete,
            commands::db::recordings_clear,
            commands::db::recording_update_note,
            commands::cloud::cloud_connection_status,
            commands::cloud::cloud_connect,
            commands::cloud::cloud_process_queue_now,
            commands::cloud::cloud_queue_status,
            commands::cloud::cloud_enqueue_backup,
            commands::cloud::cloud_retry_upload,
            commands::cloud::cloud_remove_upload,
            commands::cloud::cloud_clear_failed,
            commands::cloud::cloud_disconnect,
            commands::bridge::open_in_sundayedit,
            commands::bridge::open_in_sundaystudio,
            commands::settings::settings_get,
            commands::settings::settings_save,
            commands::settings::settings_reset,
            commands::settings::settings_export,
            commands::settings::settings_import,
            commands::settings::settings_export_to_file,
            commands::settings::settings_import_from_file,
            commands::diagnostics::run_preflight,
            commands::diagnostics::run_diagnostics,
            commands::scheduler::scheduler_reschedule,
            commands::scheduler::scheduler_status,
            commands::scheduler::scheduler_check_missed,
            commands::wake::wake_capabilities,
            commands::wake::wake_get_sleep_config,
            commands::wake::wake_fix_sleep,
            commands::wake::wake_verify,
            commands::wake::wake_reschedule,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
