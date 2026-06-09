//! Live-streaming commands (R3 P2b) — the thin IPC layer over `crate::streaming`
//! + the `crate::secrets` stream-key vault.
//!
//! `stream_start`/`stream_stop`/`stream_status` drive the ffmpeg stream;
//! `stream_set_key`/`stream_delete_key` manage the per-destination keys in the
//! OS keychain. The renderer NEVER holds a key — it sends destination metadata
//! (id/name/url/enabled) and we resolve each key from the vault at start.
//!
//! The stream spawn is behind the default-off `streaming` feature; in the
//! default build `stream_start`/`stream_stop` return `feature_disabled` so the
//! panel shows a calm "not built into this build" hint. The vault commands +
//! `stream_status` work regardless (so the user can save keys ahead of a build
//! that has streaming enabled).

use tauri::{AppHandle, Manager, State};

use sundayrec_core::device_enum::find_best_video_device_match;
use sundayrec_core::device_match::{find_best_device_match, FfmpegDevice};
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::overlay::OverlayConfig;
use sundayrec_core::streaming::{StreamDestination, StreamOptions, StreamResolution};

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::db::store::now_ms;
use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::secrets;
use crate::settings;
use crate::streaming::{self as seam, StreamDestinationView, StreamEngine, StreamStatus};

/// avfoundation index (`"0"`) or dshow name — the device token ffmpeg addresses.
/// Mirrors the recorder's `device_token`.
fn device_token(d: &FfmpegDevice) -> String {
    match d.index {
        Some(i) => i.to_string(),
        None => d.name.clone(),
    }
}

/// Deterministic path the live stream writes its preview JPG to (and that
/// `stream_preview_path` returns to the renderer).
fn stream_snapshot_path(app: &AppHandle) -> AppResult<String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Internal(format!("cache dir: {e}")))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir
        .join("stream-preview.jpg")
        .to_string_lossy()
        .into_owned())
}

/// The on-disk path the live-preview JPG is written to while streaming, so the
/// renderer can show it. Works in every build (just a path).
#[tauri::command]
pub fn stream_preview_path(app: AppHandle) -> AppResult<String> {
    stream_snapshot_path(&app)
}

/// The current host platform, mapped onto the core's [`Platform`].
fn host_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOS
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// Validate + store a destination's stream key in the OS keychain. Validation is
/// the core's (`validate_stream_key`) so a paste artefact is rejected with a
/// stable code before it's saved.
#[tauri::command]
pub fn stream_set_key(dest_id: String, key: String) -> AppResult<()> {
    sundayrec_core::streaming::validate_stream_key(&key)
        .map_err(|e| AppError::Validation(format!("invalid_key:{e:?}")))?;
    secrets::set_stream_key(&dest_id, &key)
}

/// Delete a destination's stored stream key (missing key is success).
#[tauri::command]
pub fn stream_delete_key(dest_id: String) -> AppResult<()> {
    secrets::delete_stream_key(&dest_id)
}

/// Current live-stream status (active/idle + last stats). Works in every build.
#[tauri::command]
pub fn stream_status(engine: State<'_, StreamEngine>) -> StreamStatus {
    engine.status()
}

/// Start a live stream. The destinations arrive WITHOUT keys; we resolve each
/// from the keychain by id and skip any that has none stored. Overlays are the
/// lower-thirds (image/text) composited before the encode.
///
/// NETWORK/HARDWARE-UNVERIFIED behind `--features streaming`; returns
/// `feature_disabled` in the default build.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stream_start(
    engine: State<'_, StreamEngine>,
    app: AppHandle,
    db: State<'_, Db>,
    destinations: Vec<StreamDestinationView>,
    resolution: StreamResolution,
    framerate: u32,
    video_bitrate_kbps: Option<u32>,
    audio_bitrate_kbps: Option<u32>,
    also_record: bool,
    overlays: Vec<OverlayConfig>,
) -> AppResult<StreamStatus> {
    let s = settings::load(&db.pool).await.unwrap_or_default();
    let platform = host_platform();

    // Resolve the camera + mic device tokens from the saved device NAMES, using
    // the SAME ffmpeg enumeration + fuzzy match the recorder uses (the renderer
    // only knows names, not avfoundation indices). Streaming requires a camera.
    let inv = enumerate_ffmpeg_devices().await?;
    let cam_name = s.video_device_name.as_deref().unwrap_or_default();
    let video = find_best_video_device_match(&inv.video_inputs, cam_name)
        .ok_or_else(|| AppError::Validation("no_camera".into()))?;
    let video_token = device_token(video);

    let mic_name = s.device_name.as_deref().unwrap_or_default();
    let audio = find_best_device_match(&inv.audio_inputs, mic_name);
    let (mac_audio_token, win_audio_name) = match (platform, audio) {
        (Platform::Windows, Some(a)) => (None, Some(device_token(a))),
        (_, Some(a)) => (Some(device_token(a)), None),
        (_, None) => (None, None),
    };

    // Live-preview JPG sink + (optional) simultaneous recording file. The record
    // path reuses the recorder's planner so the file is named/placed identically.
    let snapshot_path = stream_snapshot_path(&app)?;
    let also_record_path = if also_record {
        crate::scheduler::build_opts(&app, &s, None, 0, Some(true))
            .ok()
            .map(|o| o.output_path)
    } else {
        None
    };

    // Resolve each destination's key from the vault, producing the core's
    // key-carrying `StreamDestination`. A destination with no stored key is kept
    // (enabled stays as-is) but its empty key makes it non-pushable downstream.
    let dests: Vec<StreamDestination> = destinations
        .into_iter()
        .map(|d| StreamDestination {
            stream_key: secrets::get_stream_key(&d.id).unwrap_or_default(),
            id: d.id,
            name: d.name,
            rtmp_url: d.rtmp_url,
            enabled: d.enabled,
        })
        .collect();

    let opts = StreamOptions {
        resolution,
        framerate,
        video_bitrate_kbps,
        audio_bitrate_kbps,
        destinations: dests,
        also_record_path,
    };

    seam::start(
        &engine,
        platform,
        opts,
        overlays,
        video_token,
        mac_audio_token,
        win_audio_name,
        snapshot_path,
        now_ms() as i64,
    )
    .await
}

/// Stop the running stream. Returns whether one was active. NETWORK/HARDWARE-
/// UNVERIFIED behind `--features streaming`; returns `feature_disabled` otherwise.
#[tauri::command]
pub async fn stream_stop(engine: State<'_, StreamEngine>) -> AppResult<bool> {
    seam::stop(&engine).await
}
