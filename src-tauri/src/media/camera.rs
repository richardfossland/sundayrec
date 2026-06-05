//! Shared camera helpers: probing the camera's advertised capture modes.
//!
//! avfoundation only LISTS a device's supported modes when you request an
//! UNSUPPORTED one — so we ask for `-framerate 1` and parse the "Supported modes"
//! block it prints to stderr. Both the recorder (to pin a supported INPUT mode)
//! and the live preview (to open a KNOWN-good mode instead of thrashing a
//! guess-matrix) use this, so a camera that only does 15/30 never gets fed the
//! 25/29.97 it rejects.
//!
//! macOS-only (avfoundation is the only backend with this hard rejection); other
//! platforms get an empty list and fall back to their legacy guess.

use sundayrec_core::capture::{resolve_camera_mode, CameraMode, VideoCaptureMode};
use sundayrec_core::ffmpeg::Platform;

/// Probe a camera's advertised capture modes. Bounded by a short timeout so a
/// wedged device-open can't delay a recording/preview start. Empty on non-macOS
/// or any failure → caller uses its legacy fallback.
///
/// ⚠️ HARDWARE-UNVERIFIED in the test suite (opens the real camera).
pub async fn probe_camera_modes(token: &str, platform: Platform) -> Vec<CameraMode> {
    if !matches!(platform, Platform::MacOS) {
        return Vec::new();
    }
    use tokio::io::AsyncReadExt;
    let input = format!("{token}:none");
    // avfoundation only PRINTS "Supported modes:" when the requested format can't
    // be satisfied. The old `-framerate 1` is actually SUPPORTED by some cameras
    // (e.g. the FaceTime HD camera lists 1.0 fps), so ffmpeg opened successfully
    // and never listed the modes → the probe came back empty and the recorder
    // ignored the resolution setting. An impossible framerate (1000) is rejected
    // by every camera, reliably triggering the modes listing.
    let spawn = tokio::process::Command::new(crate::media::ffmpeg::ffmpeg_path())
        .args([
            "-hide_banner",
            "-f",
            "avfoundation",
            "-framerate",
            "1000",
            "-i",
        ])
        .arg(&input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut child = match spawn {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("camera: mode probe spawn failed: {e}");
            return Vec::new();
        }
    };
    let Some(mut stderr) = child.stderr.take() else {
        return Vec::new();
    };
    let mut buf = String::new();
    let read = async {
        let _ = stderr.read_to_string(&mut buf).await;
    };
    // ffmpeg exits ~immediately (the bad framerate errors out); 6 s is a generous
    // ceiling for a slow USB device-open.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(6), read).await;
    let _ = child.start_kill();
    let _ = child.wait().await;
    sundayrec_core::capture::parse_avfoundation_modes(&buf)
}

/// Pick the live-preview capture modes — REAL, advertised ones — most-preferred
/// first (≈720p, then 1080p, then 480p), each at a supported frame rate. The
/// preview opens these in order; the first that yields a frame stays. Empty when
/// the camera advertised nothing (caller falls back to the legacy guess-matrix).
///
/// Using probed modes is the fix for the preview "stutter": the old hardcoded
/// matrix tried 7 modes (incl. 25 fps ones the camera rejects) at 2 s each,
/// thrashing the camera with rapid open/close cycles; here every entry is a mode
/// the device actually supports, so the first attempt simply works.
pub fn preview_modes_from(modes: &[CameraMode]) -> Vec<VideoCaptureMode> {
    let mut out: Vec<VideoCaptureMode> = Vec::new();
    for (w, h) in [(1280u32, 720u32), (1920, 1080), (854, 480)] {
        if let Some(m) = resolve_camera_mode(modes, w, h, 30) {
            if !out.contains(&m) {
                out.push(m);
            }
        }
    }
    out
}
