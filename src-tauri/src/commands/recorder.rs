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

/// The latest in-recording camera preview frame, base64-encoded, or `None` if no
/// frame is available yet. For a VIDEO recording the recording ffmpeg writes a
/// low-fps JPEG to a fixed temp file (`-update 1`, a deadlock-proof FILE sink —
/// never a pipe, so it can't freeze the capture). The renderer polls this ~4×/s
/// while recording and shows the result in the camera tile. The JPEG SOI guard
/// (`FF D8`) drops a partial/empty read so the UI keeps its last good frame
/// instead of flickering.
#[tauri::command]
pub async fn recording_preview_frame() -> Option<String> {
    use base64::Engine as _;
    let path = crate::recorder::engine::recording_preview_path();
    match tokio::fs::read(&path).await {
        Ok(bytes) if bytes.len() > 2 && bytes[0] == 0xFF && bytes[1] == 0xD8 => {
            Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
        }
        _ => None,
    }
}

/// Plan the full [`RecordingOpts`] for a manual "Start opptak nå" from the
/// persisted settings — the SAME save-folder + liturgical-filename + audio
/// processing logic the scheduler uses, so a manually-started recording lands
/// in the right folder with the right name. The returned `output_path` is the
/// real save path (shown in the recording UI's "Lagres som …" line); the
/// renderer passes the opts straight to `start_recording`.
#[tauri::command]
pub async fn plan_recording_opts(
    app: AppHandle,
    db: State<'_, Db>,
    custom_name: Option<String>,
    max_minutes: Option<u32>,
    // The Home video toggle (local UI state, not persisted) — overrides the
    // `video_enabled` setting so a manual video recording lands as `.mp4`.
    video: Option<bool>,
) -> AppResult<RecordingOpts> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    crate::scheduler::build_opts(
        &app,
        &s,
        custom_name.as_deref(),
        max_minutes.unwrap_or(0),
        video,
    )
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
    preview: State<'_, crate::media::preview::PreviewEngine>,
    db: State<'_, Db>,
    opts: RecordingOpts,
) -> AppResult<()> {
    // Two independent device hand-offs must finish before the engine opens its
    // devices: (1) release the camera preview, and (2) harvest the pre-roll clip
    // (which also frees the mic). They touch DIFFERENT devices (camera vs mic), so
    // we run them CONCURRENTLY instead of back-to-back — when both apply (video +
    // pre-roll + a live preview), this shaves off roughly the smaller of the two
    // waits from the felt start time.
    //
    // - Preview release: on macOS a camera has a single owner; while the HOME
    //   preview's ffmpeg child still holds it, the recorder's avfoundation video
    //   input can't open it and video silently fails. We await its full release.
    // - Pre-roll harvest (F3.2): stop the rolling capture loop and grab the trimmed
    //   clip of audio captured BEFORE this press, honouring `pre_roll_seconds`.
    //   `None` window / inactive loop / nothing-captured → no clip.
    let pre_roll_seconds = crate::settings::load(&db.pool).await?.pre_roll_seconds;
    let harvest = async {
        match (pre_roll_seconds, preroll.is_active()) {
            (secs, true) if secs > 0 => {
                // Match the recording's REAL codec + container so the F3.3a prepend
                // concat is a lossless `-c copy`. The codec is derived from the
                // recording's own output extension (mp3→libmp3lame, wav→pcm_s16le,
                // flac→flac, m4a/aac→aac) — NOT hardcoded to AAC, which would mux an
                // AAC clip onto a non-AAC recording and corrupt the file. Channels
                // and sample rate mirror the recording's resolved opts.
                let channels = match opts.channel_mode {
                    sundayrec_core::settings::ChannelMode::Stereo => 2,
                    _ => 1,
                };
                let container_ext = std::path::Path::new(&opts.output_path)
                    .extension()
                    .map(|e| e.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let codec = sundayrec_core::capture::codec_for_extension(&container_ext);
                // Empty/unknown extension → use the fallback codec's own container
                // so codec and container always agree.
                let harvest_ext = if container_ext.is_empty() {
                    codec.default_extension().to_string()
                } else {
                    container_ext
                };
                // Lossy codecs carry the recording's bitrate; PCM/FLAC must omit it.
                let bitrate = codec.uses_bitrate().then_some(opts.bitrate_kbps);
                preroll
                    .harvest(
                        secs as u32,
                        // The recording may capture at the device's NATIVE rate
                        // (`opts.sample_rate == None`). The harvest fn needs a
                        // concrete u32 to re-encode the few-second pre-roll clip
                        // for the lossless `-c copy` prepend; with Auto we don't
                        // know the device rate here, so pin a fixed 48 kHz clip —
                        // a short fixed-rate clip concatenated in front is
                        // acceptable. Forced rates pass through unchanged.
                        opts.sample_rate.unwrap_or(48_000),
                        channels,
                        codec.ffmpeg_name(),
                        bitrate,
                        &harvest_ext,
                    )
                    .await
            }
            _ => None,
        }
    };
    let (_, clip) = tokio::join!(preview.stop_and_release(), harvest);
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

/// The current auto-stop deadline (absolute epoch ms), or null when none is
/// armed. Lets a screen that (re)mounts mid-recording rehydrate the countdown
/// synchronously instead of waiting for the next `recording://state` event
/// (which only fires on a lifecycle transition).
#[tauri::command]
pub fn recording_scheduled_stop_ms(engine: State<'_, RecorderEngine>) -> Option<u64> {
    engine.scheduled_stop_ms()
}

/// Extend the running recording's auto-stop by `minutes` (the "+30 min" button).
/// Adds to the live deadline so it never shortens; the running loop picks up the
/// change and re-emits `recording://state` with the new `scheduled_stop_ms`. A
/// no-op when nothing is recording (the stored value just isn't observed).
#[tauri::command]
pub fn recording_extend_autostop(engine: State<'_, RecorderEngine>, minutes: u32) -> AppResult<()> {
    engine.extend_autostop(minutes);
    Ok(())
}

/// Cancel the running recording's auto-stop entirely so it records until a manual
/// stop. The loop clears its real timer and re-emits state with `scheduled_stop_ms
/// = null`.
#[tauri::command]
pub fn recording_cancel_autostop(engine: State<'_, RecorderEngine>) -> AppResult<()> {
    engine.cancel_autostop();
    Ok(())
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
