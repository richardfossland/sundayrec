//! Recorder commands — the thin IPC layer over `crate::recorder` (Fase 3).
//!
//! The renderer calls:
//!   - `list_recording_devices` to discover capture devices (real ffmpeg
//!     enumerator),
//!   - `start_recording(opts)` / `stop_recording` to drive a unified capture,
//!     listening for `recording://{state,started,progress,silence,error,
//!     reconnecting,reconnected}` events,
//!   - `recording_status` to read the current [`RecorderState`] synchronously.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use ts_rs::TS;

use sundayrec_core::device_match::FfmpegDevice;
use sundayrec_core::recorder::RecorderState;

use crate::db::Db;
use crate::error::AppResult;
use crate::recorder::engine::{list_recording_devices as enumerate, RecorderEngine, RecordingOpts};
use crate::recorder::preroll::{preroll_settings_from, PrerollEngine, PrerollStatus};
use crate::settings;
use crate::test_recording::{run_test_recording as run_test, TestRecordingResult};

/// List capture (audio) devices the recorder can match against, via the real
/// ffmpeg device enumerator (F2.1).
#[tauri::command]
pub async fn list_recording_devices() -> AppResult<Vec<FfmpegDevice>> {
    enumerate().await
}

/// Start a unified recording for `opts`. Streams the `recording://*` events
/// (including `recording://state`) until `stop_recording`. Stops any previous
/// recording first. On completion a single history row is written for the
/// session (multi-segment sessions are one row at the primary segment).
#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    engine: State<'_, RecorderEngine>,
    preroll: State<'_, PrerollEngine>,
    db: State<'_, Db>,
    opts: RecordingOpts,
) -> AppResult<()> {
    // Pre-roll harvest (F3.2): if the rolling capture loop is running, stop it and
    // grab the trimmed clip of audio captured BEFORE this press, so the recorder
    // can prepend it. Honours the persisted `pre_roll_seconds` window. Harvesting
    // also releases the mic before the recorder opens it (one device owner on
    // macOS). A `None` window / inactive loop / nothing-captured → no clip.
    let clip = {
        let settings = crate::settings::load(&db.pool).await?;
        match (settings.pre_roll_seconds, preroll.is_active()) {
            (secs, true) if secs > 0 => {
                let channels = match settings.channels {
                    sundayrec_core::settings::ChannelMode::Stereo => 2,
                    _ => 1,
                };
                // Match the recording's codec + container so the F3.3a prepend
                // concat is a lossless `-c copy`. The unified recorder always
                // encodes AAC; the container extension comes from the recording's
                // output path (e.g. `m4a`, `mp4`).
                let container_ext = std::path::Path::new(&opts.output_path)
                    .extension()
                    .map(|e| e.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "m4a".to_string());
                preroll
                    .harvest(
                        secs as u32,
                        settings.sample_rate.max(8_000) as u32,
                        channels,
                        "aac",
                        &container_ext,
                    )
                    .await
            }
            _ => None,
        }
    };
    engine.start(app, Some(db.pool.clone()), opts, clip).await
}

/// Start the rolling pre-roll capture loop from the persisted settings. A no-op
/// (returns `false`) when pre-roll is off or no device is configured. Returns
/// whether the loop was started. Safe to call repeatedly (restarts the loop).
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real mic in the background.
#[tauri::command]
pub async fn preroll_start(
    preroll: State<'_, PrerollEngine>,
    db: State<'_, Db>,
) -> AppResult<bool> {
    let settings = crate::settings::load(&db.pool).await?;
    match preroll_settings_from(&settings) {
        Some(ps) => {
            preroll.start(ps);
            Ok(true)
        }
        None => {
            // Pre-roll disabled or no device — make sure nothing is left running.
            preroll.stop();
            Ok(false)
        }
    }
}

/// Stop the rolling pre-roll capture loop without harvesting (deletes the temp
/// capture). Safe to call when nothing is running.
#[tauri::command]
pub fn preroll_stop(preroll: State<'_, PrerollEngine>) -> AppResult<()> {
    preroll.stop();
    Ok(())
}

/// The pre-roll loop status, for the settings UI's "preroll aktiv" indicator.
#[tauri::command]
pub fn preroll_status(preroll: State<'_, PrerollEngine>) -> PrerollStatus {
    preroll.status()
}

/// Stop the recording gracefully (sends ffmpeg `q` so the container finalises).
/// Safe to call when nothing is running.
#[tauri::command]
pub fn stop_recording(engine: State<'_, RecorderEngine>) -> AppResult<()> {
    engine.stop();
    Ok(())
}

/// The current recorder lifecycle state (best-effort snapshot).
#[tauri::command]
pub fn recording_status(engine: State<'_, RecorderEngine>) -> RecorderState {
    engine.current_state()
}

/// Free bytes on the volume holding the save folder, or `null` when the platform
/// can't report it. Mirrors the Electron `get-disk-space` handler, but uses the
/// `fs4` cross-platform probe (already a dep, used by preflight) instead of
/// shelling out to `df`/`powershell`. Fully testable — no device, no ffmpeg.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/DiskSpace.ts")]
#[serde(rename_all = "camelCase")]
pub struct DiskSpace {
    /// Free space in bytes, or `null` when unavailable.
    #[ts(type = "number | null")]
    pub free_bytes: Option<u64>,
}

/// Read the free disk space for the configured save folder.
#[tauri::command]
pub async fn get_disk_space(app: AppHandle, db: State<'_, Db>) -> AppResult<DiskSpace> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    let folder = s.save_folder.clone().unwrap_or_else(|| {
        app.path()
            .document_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    });
    // Fall back to the documents dir when the configured folder is gone (mirrors
    // the Electron `if (!fs.existsSync(folder)) folder = documents` guard).
    let path = std::path::Path::new(&folder);
    let probe = if path.exists() {
        path.to_path_buf()
    } else {
        app.path()
            .document_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
    };
    Ok(DiskSpace {
        free_bytes: fs4::available_space(&probe).ok(),
    })
}

/// Run a ~10 s test capture for the configured mic and report size + measured
/// signal level. The argv + classifiers are the unit-tested core; the spawn/
/// astats path is HARDWARE-UNVERIFIED (needs a real mic + the ffmpeg sidecar).
#[tauri::command]
pub async fn run_test_recording(db: State<'_, Db>) -> AppResult<TestRecordingResult> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    let device = s.device_name.clone().unwrap_or_default();
    run_test(&device).await
}
