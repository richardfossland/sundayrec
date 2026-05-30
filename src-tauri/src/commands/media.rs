//! Media commands — the thin IPC layer over `crate::media`.
//!
//! Spike A: the ffmpeg sidecar health-check the diagnostics view calls on
//! startup, plus the MJPEG camera-preview start/stop. The recorder commands land
//! in Spike B.

use tauri::{AppHandle, State};

use crate::error::AppResult;
use crate::media::ffmpeg::{ffmpeg_health as probe_health, FfmpegHealth};
use crate::media::preview::PreviewEngine;

/// Probe the bundled ffmpeg sidecar and report whether it resolved + its
/// version banner. Infallible — a missing binary is rendered by the UI, not an
/// error.
#[tauri::command]
pub fn ffmpeg_health() -> FfmpegHealth {
    probe_health()
}

/// Start the MJPEG camera preview on `device` (or the first camera when `None`)
/// at `fps` (default 15). Streams `preview://frame` events until `stop_preview`.
/// Stops any previous preview first.
#[tauri::command]
pub fn start_preview(
    app: AppHandle,
    engine: State<'_, PreviewEngine>,
    device: Option<String>,
    fps: Option<u32>,
) -> AppResult<()> {
    engine.start(app, device, fps)
}

/// Stop the camera preview. Safe to call when nothing is running.
#[tauri::command]
pub fn stop_preview(engine: State<'_, PreviewEngine>) -> AppResult<()> {
    engine.stop();
    Ok(())
}
