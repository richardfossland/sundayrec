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
pub mod platform;
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
pub mod test_recording;
// PU-2 menubar tray + `sundayrec://` deep-link handling — default-off `tray`
// feature (GUI-UNVERIFIED). The menu-model + link parse are in `sundayrec_core`;
// this seam maps them to tauri menu/tray + the scheme handler.
#[cfg(feature = "tray")]
pub mod tray;
// R7 auto-update — default-off `updater` feature (NETWORK/GUI-UNVERIFIED). The
// status model + dev-check guard + semver decision are `sundayrec_core::update`;
// this seam drives `tauri-plugin-updater` (check/download/install) + relaunch.
// The DTO + `UpdateEngine` compile in every build; `update_check`/
// `update_download_install` return `feature_disabled` when the feature is off.
pub mod update;
pub mod util;
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

    // Windows orphan-guard: before anything spawns, put THIS process in a Job
    // Object that kills its children when it dies (even on a Task-Manager kill), so
    // a crashed/force-quit SundayRec never leaves an ffmpeg holding the audio
    // device. No-op off Windows. (FIKS 2b.)
    crate::platform::guard_child_processes();

    let builder = tauri::Builder::default();
    // Single-instance MUST be the FIRST plugin (Tauri requirement). A second launch
    // focuses the existing window instead of starting another process — the
    // root-cause fix for the piled-up instances that crashed Windows Audio. (FIKS 1.)
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        use tauri::Manager;
        tracing::info!("a second SundayRec launch was blocked — focusing the existing window");
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        // Launch-at-login: registers an OS login item (LaunchAgent on macOS) so
        // scheduled recordings fire after a reboot. Toggled by `set_launch_at_login`.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ));

    // R7 auto-update: register the updater plugin only under `--features
    // updater` (it needs a signed feed + the public key in tauri.conf.json).
    // NETWORK/GUI-UNVERIFIED.
    #[cfg(feature = "updater")]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    // PU-2: register the `sundayrec://` deep-link plugin only under `--features
    // tray` (the scheme handler feeds `tray::dispatch_deep_link`). GUI-UNVERIFIED.
    #[cfg(feature = "tray")]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder
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
        // R3 NDI: the transmit engine holds at most one running NDI output
        // (camera → libndi). Compiles in every build; the sender is feature-gated.
        .manage(ndi::NdiOutputEngine::new())
        // R7: the update engine holds the live check/download status the
        // renderer polls. Compiles in every build; the network/install seam is
        // gated behind the default-off `updater` feature.
        .manage(update::UpdateEngine::new())
        // P1 editor parity: the mastering-apply engine tracks in-flight jobs so
        // the UI can cancel a long render by id. The pure JobRegistry inside is
        // tested in core; the real ffmpeg children are held feature-on.
        .manage(editor::MasterEngine::new())
        // Tracks in-flight OAuth connects so `cloud_cancel_connect` can abort a
        // pending consent before the 300 s timeout.
        .manage(cloud::ConnectGuard::new())
        // Tracks in-flight whisper model downloads so `whisper_cancel_download`
        // can abort one (one entry per active model id).
        .manage(whisper::DownloadGuard::new())
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

            // Crash recovery: if a previous run was interrupted mid-recording, its
            // orphaned segment fragments are finalised into playable files +
            // history rows on this launch (best-effort, in the background so it
            // never delays startup). A clean recording leaves no manifest.
            {
                let recover_app = app.handle().clone();
                let recover_pool = pool.clone();
                tauri::async_runtime::spawn(async move {
                    recorder::recovery::scan_and_recover(recover_app, recover_pool).await;
                });
            }

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

            // PU-2: install the menubar tray (default-off `tray` feature). The
            // menu shape is the unit-tested core model; start/stop/show are
            // wired to commands via `handle_menu_event`. We keep the returned
            // `TrayIcon` alive by leaking it for the process lifetime (it lives
            // as long as the app; dropping it would remove the tray). The deep-
            // link plugin (`sundayrec://`) is registered for the OAuth/import
            // hand-off. GUI-UNVERIFIED.
            #[cfg(feature = "tray")]
            {
                use sundayrec_core::tray::{TrayLang, TrayState};
                use tauri_plugin_deep_link::DeepLinkExt;
                let lang = TrayLang::from_code(None); // hydrated by the renderer later
                match tray::install(app.handle(), &TrayState::default(), lang) {
                    Ok(icon) => {
                        // Hold the handle for the whole process lifetime.
                        std::mem::forget(icon);
                    }
                    Err(e) => tracing::warn!("tray install failed: {e}"),
                }

                // Route inbound `sundayrec://…` links through the unit-tested
                // core parser + the shell dispatcher. GUI-UNVERIFIED.
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = tray::dispatch_deep_link(&handle, url.as_str());
                    }
                });
            }

            tracing::info!("SundayRec backend ready (db at {})", db_path.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::app::set_launch_at_login,
            commands::app::get_launch_at_login,
            commands::audio::list_input_devices,
            commands::audio::list_audio_devices,
            commands::audio::list_audio_input_channels,
            commands::audio::list_devices,
            commands::audio::list_video_devices,
            commands::audio::get_camera_capabilities,
            commands::audio::diagnose_audio,
            commands::audio::start_vu,
            commands::audio::stop_vu,
            commands::media::ffmpeg_health,
            commands::media::start_preview,
            commands::media::stop_preview,
            commands::media::media_permissions,
            commands::recorder::list_recording_devices,
            commands::recorder::recording_preview_frame,
            commands::recorder::plan_recording_opts,
            commands::recorder::start_recording,
            commands::recorder::stop_recording,
            commands::recorder::recording_status,
            commands::recorder::recording_scheduled_stop_ms,
            commands::recorder::recording_extend_autostop,
            commands::recorder::recording_cancel_autostop,
            commands::recorder::preroll_start,
            commands::recorder::preroll_stop,
            commands::recorder::preroll_status,
            commands::recorder::get_disk_space,
            commands::recorder::run_test_recording,
            commands::db::setting_get,
            commands::db::setting_set,
            commands::db::recordings_list,
            commands::db::transcripts_list,
            commands::db::recordings_delete,
            commands::db::recordings_clear,
            commands::db::recording_update_note,
            commands::db::recordings_prune,
            commands::calendar::liturgical_month,
            commands::cloud::cloud_connection_status,
            commands::cloud::cloud_is_configured,
            commands::cloud::cloud_connect,
            commands::cloud::cloud_cancel_connect,
            commands::cloud::cloud_list_folders,
            commands::cloud::cloud_set_folder,
            commands::cloud::cloud_get_folder,
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
            // Trackpad haptics (macOS Force Touch; no-op elsewhere). The editor
            // fires subtle, throttled taps on snap / limit / marker-crossing.
            commands::haptics::haptic_perform,
            // R1 non-destructive editor (DTOs pure; ffmpeg runs gated by `editor`).
            commands::editor::editor_load_recording,
            commands::editor::editor_peaks,
            commands::editor::editor_segments,
            commands::editor::editor_master_presets,
            commands::editor::editor_detect_chapters,
            commands::editor::editor_diagnose_channels,
            commands::editor::editor_auto_process,
            commands::editor::editor_mastering_analyze,
            commands::editor::editor_export,
            commands::editor::editor_extract_frame,
            // P1 parity: sidecar persistence, stream probe, inline guard,
            // temp-file cleanup, and the full mastering preview/apply/cancel flow.
            commands::editor::editor_read_sidecar,
            commands::editor::editor_write_sidecar,
            commands::editor::editor_delete_sidecar,
            commands::editor::editor_probe_streams,
            commands::editor::editor_read_file,
            commands::editor::editor_cleanup_temp_files,
            commands::editor::editor_master_preview,
            commands::editor::editor_master_apply,
            commands::editor::editor_master_cancel,
            // PU-1 email alerts (status pure; send gated by `email`).
            commands::email::email_status,
            commands::email::email_send_test,
            commands::email::email_test_webhook,
            commands::email::email_clear_smtp_password,
            commands::scheduler::scheduler_reschedule,
            commands::scheduler::scheduler_status,
            commands::scheduler::scheduler_check_missed,
            commands::wake::wake_capabilities,
            commands::wake::wake_get_sleep_config,
            commands::wake::wake_fix_sleep,
            commands::wake::wake_verify,
            commands::wake::wake_reschedule,
            commands::wake::wake_test,
            commands::wake::wake_cancel_test,
            commands::wake::wake_failure_history,
            commands::wake::wake_clear_failure_history,
            // PU-5 whisper transcription (model registry pure; transcribe gated).
            commands::whisper::whisper_list_models,
            commands::whisper::whisper_model_status,
            commands::whisper::whisper_download_model,
            commands::whisper::whisper_cancel_download,
            commands::whisper::whisper_delete_model,
            commands::whisper::whisper_transcribe,
            commands::whisper::whisper_export_transcript,
            // PU-6 episode prep + review queue + Stage import.
            commands::review::prep_build_episode,
            commands::review::review_queue_list,
            commands::review::review_mark_published,
            commands::review::review_mark_discarded,
            commands::review::review_process_reminders,
            commands::review::stage_import_manifest,
            // P2b Sunday-suite integrations — typed settings + Song/Plan/Verbatim
            // hand-offs (pure mappers in sundayrec-core; HTTP NETWORK-UNVERIFIED).
            commands::integrations::integrations_get_settings,
            commands::integrations::integrations_set_settings,
            commands::integrations::integrations_get_service_link,
            commands::integrations::integrations_song_set_apikey,
            commands::integrations::integrations_song_has_apikey,
            commands::integrations::integrations_song_submit_usage,
            commands::integrations::integrations_plan_fetch_services,
            commands::integrations::integrations_plan_update_service,
            commands::integrations::integrations_verbatim_send,
            commands::integrations::integrations_verbatim_import,
            // Bridge #2 — live cue → chapter mapping (renderer-driven).
            commands::bridge_live::live_bridge_status,
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
            commands::ndi::ndi_output_runtime_available,
            commands::ndi::ndi_output_start,
            commands::ndi::ndi_output_stop,
            // PU-3 podcast RSS publish (feed shaping pure; write/upload gated by `publish`).
            commands::publish::publish_feed_status,
            commands::publish::publish_feed_preview,
            commands::publish::publish_generate_feed,
            // R7 auto-update (status pure; check/download/relaunch gated by `updater`).
            commands::update::update_status,
            commands::update::update_check,
            commands::update::update_download_install,
            commands::update::update_relaunch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // FIKS 2a: on app exit, stop every capture sidecar FIRST so nothing keeps
        // the audio/camera device open (graceful complement to the Job Object).
        // Best-effort — `stop()` is safe to call when idle.
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                app_handle
                    .state::<recorder::engine::RecorderEngine>()
                    .stop();
                app_handle.state::<media::preview::PreviewEngine>().stop();
                app_handle.state::<audio::vu::VuEngine>().stop();
                tracing::info!("app exit requested — stopped recorder/preview/vu sidecars");
            }
        });
}
