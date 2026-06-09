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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sundayrec_core::capture::{resolve_camera_mode, CameraMode, VideoCaptureMode};
use sundayrec_core::ffmpeg::Platform;

/// A camera's advertised modes are stable for the life of the device, so a short
/// TTL cache lets back-to-back video recordings of the SAME camera skip the
/// 200–1500 ms `ffmpeg -framerate 1000` re-probe on the record-start path. The
/// TTL is generous (modes don't change) but bounded so a swapped device behind
/// the same token is re-probed within a couple of minutes. Empty probes are NOT
/// cached, so a transient open-failure retries next time.
const MODE_CACHE_TTL: Duration = Duration::from_secs(120);

/// token → (probed-at, advertised modes).
type ModeCache = Mutex<HashMap<String, (Instant, Vec<CameraMode>)>>;

fn mode_cache() -> &'static ModeCache {
    static CACHE: OnceLock<ModeCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A fresh cached probe for `token`, if any (within [`MODE_CACHE_TTL`]).
fn cached_modes(token: &str) -> Option<Vec<CameraMode>> {
    let guard = mode_cache().lock().ok()?;
    let (at, modes) = guard.get(token)?;
    (at.elapsed() < MODE_CACHE_TTL).then(|| modes.clone())
}

/// Remember a non-empty probe result for `token`.
fn store_modes(token: &str, modes: &[CameraMode]) {
    if let Ok(mut guard) = mode_cache().lock() {
        guard.insert(token.to_string(), (Instant::now(), modes.to_vec()));
    }
}

/// Probe a camera's advertised capture modes. Bounded by a short timeout so a
/// wedged device-open can't delay a recording/preview start. Empty on non-macOS
/// or any failure → caller uses its legacy fallback.
///
/// ⚠️ HARDWARE-UNVERIFIED in the test suite (opens the real camera).
pub async fn probe_camera_modes(token: &str, platform: Platform) -> Vec<CameraMode> {
    if !matches!(platform, Platform::MacOS) {
        return Vec::new();
    }
    // Reuse a recent probe of the same device instead of re-opening the camera on
    // every video record-start (the probe is 200–1500 ms of avfoundation negotiation).
    if let Some(modes) = cached_modes(token) {
        return modes;
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
    let modes = sundayrec_core::capture::parse_avfoundation_modes(&buf);
    // Only cache a real result; an empty list is a probe failure/fallback and
    // should be retried next time rather than pinned for the TTL.
    if !modes.is_empty() {
        store_modes(token, &modes);
    }
    modes
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mode(w: u32, h: u32) -> CameraMode {
        CameraMode {
            width: w,
            height: h,
            framerates: vec![30],
        }
    }

    #[test]
    fn cache_store_then_read_returns_the_modes() {
        let token = "test-token-store-read";
        assert!(cached_modes(token).is_none(), "cold cache is empty");
        let modes = vec![mode(1280, 720), mode(1920, 1080)];
        store_modes(token, &modes);
        assert_eq!(cached_modes(token), Some(modes), "fresh entry is returned");
    }

    #[test]
    fn cache_is_keyed_by_token() {
        store_modes("token-a", &[mode(640, 480)]);
        assert!(
            cached_modes("token-b-unseen").is_none(),
            "a different token does not hit token-a's entry"
        );
    }
}
