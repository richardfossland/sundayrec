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
// Bridge Integration #2 — the Rec-side live cue-bridge consumer. The
// channel-name + LiveEvent→chapter fold live in `sundayrec_core`; this seam
// owns the Supabase Realtime subscribe behind the default-off `bridge` feature
// (INFRA-UNVERIFIED). The pure decode/channel helpers compile either way.
pub mod bridge_live;
pub mod cloud;
pub mod commands;
pub mod db;
pub mod diagnostics;
// R1 non-destructive editor — ffmpeg-driven load/peaks/segments/mastering/export
// over the unit-tested `sundayrec_core::{editor,mastering,audio_analysis}`. The
// DTOs + `feature_disabled` stubs compile in the default build; the impure ffmpeg
// runs are gated behind the default-off `editor` feature (HARDWARE-UNVERIFIED).
pub mod editor;
// PU-1 email alerts — default-off `email` feature (NETWORK-UNVERIFIED). The pure
// templates/throttle/MIME live in `sundayrec_core::email`; this seam sends.
#[cfg(feature = "email")]
pub mod email;
pub mod error;
pub mod media;
// R3 NDI receiver — default-off `ndi` feature (STUB; SDK not bundled). The
// source-discovery/pixfmt/input-arg logic is `sundayrec_core::ndi`; this seam
// returns `feature_disabled` (default) or a clear "NDI SDK not bundled" error.
pub mod ndi;
pub mod preflight;
// PU-3 podcast RSS publish — default-off `publish` feature (NETWORK-UNVERIFIED).
// The XML shaping is `sundayrec_core::feed`; this seam maps history + writes/uploads.
#[cfg(feature = "publish")]
pub mod publish;
pub mod recorder;
pub mod scheduler;
pub mod secrets;
pub mod settings;
// R3 live RTMP streaming — default-off `streaming` feature (NETWORK/HARDWARE-
// UNVERIFIED). The tee/encode/overlay argv + key validation are
// `sundayrec_core::{streaming,overlay}`; this seam spawns ffmpeg + reads the
// per-destination keys from the keychain. `stream_start` returns
// `feature_disabled` in the default build.
pub mod streaming;
// PU-2 menubar tray + `sundayrec://` deep-link handling — default-off `tray`
// feature (GUI-UNVERIFIED). The menu-model + link parse are in `sundayrec_core`;
// this seam maps them to tauri menu/tray + the scheme handler.
#[cfg(feature = "tray")]
pub mod tray;
pub mod wake;
// PU-5 whisper transcription — default-off `whisper` feature (HARDWARE-UNVERIFIED).
// The model registry/argv/normalise are `sundayrec_core::whisper`; this seam runs
// inference (whisper-rs). The pure list/status entry points compile without it;
// `transcribe` returns `feature_disabled` when off.
pub mod whisper;

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
        // R3: the live-stream engine holds at most one running RTMP ffmpeg.
        // Compiles in every build; only the spawn is feature-gated.
        .manage(streaming::StreamEngine::new())
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
            // R1 non-destructive editor (DTOs pure; ffmpeg runs gated by `editor`).
            commands::editor::editor_load_recording,
            commands::editor::editor_peaks,
            commands::editor::editor_segments,
            commands::editor::editor_mastering_analyze,
            commands::editor::editor_export,
            commands::scheduler::scheduler_reschedule,
            commands::scheduler::scheduler_status,
            commands::scheduler::scheduler_check_missed,
            commands::wake::wake_capabilities,
            commands::wake::wake_get_sleep_config,
            commands::wake::wake_fix_sleep,
            commands::wake::wake_verify,
            commands::wake::wake_reschedule,
            // PU-5 whisper transcription (model registry pure; transcribe gated).
            commands::whisper::whisper_list_models,
            commands::whisper::whisper_model_status,
            commands::whisper::whisper_transcribe,
            // PU-6 episode prep + review queue + Stage import.
            commands::review::prep_build_episode,
            commands::review::review_queue_list,
            commands::review::review_mark_published,
            commands::review::review_mark_discarded,
            commands::review::review_process_reminders,
            commands::review::stage_import_manifest,
            // Bridge #2 — live cue → chapter mapping (renderer-driven).
            commands::bridge_live::live_bridge_channel,
            commands::bridge_live::live_bridge_map_event,
            // R3 live streaming (tee/overlay argv pure; spawn gated by `streaming`).
            commands::streaming::stream_status,
            commands::streaming::stream_start,
            commands::streaming::stream_stop,
            commands::streaming::stream_set_key,
            commands::streaming::stream_delete_key,
            // R3 NDI source discovery + receiver (STUB; gated by `ndi`).
            commands::ndi::ndi_list_sources,
            commands::ndi::ndi_start_receiver,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
