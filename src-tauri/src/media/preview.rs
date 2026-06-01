//! The MJPEG camera-preview engine: spawn ffmpeg to capture the camera as a
//! raw MJPEG stream, reassemble whole JPEG frames with the pure
//! [`MjpegFrameSplitter`], and push each frame to the renderer over a Tauri
//! event as a base64 data URL payload.
//!
//! WHY this design (see `docs/MIGRATION-TAURI2.md`, risk register "Webview
//! media"): decoding camera frames in ffmpeg and shipping ready-made JPEGs to a
//! plain `<img>` means the preview never depends on the webview's `getUserMedia`
//! or its built-in video codecs — the exact fragility that bit the Electron
//! build. The webview only ever paints a JPEG.
//!
//! ⚠️ HARDWARE-UNVERIFIED. [`build_preview_args`] is a pure, unit-tested string
//! builder, but actually opening a camera (`run_preview`) needs real hardware
//! and is therefore not exercised by the test suite. It must be smoke-tested on
//! a real camera before the preview is declared done: open the app, start the
//! preview, and confirm the live image renders.
//!
//! Stop semantics: a preview is a *throwaway* stream piped to us — nothing is
//! being written to a file — so stopping aborts the reader task and lets
//! `kill_on_drop` terminate ffmpeg. (The recorder, by contrast, will send a
//! graceful stdin `q` so it can finalise its output container — Spike B.)

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use sundayrec_core::device_enum::find_best_video_device_match;
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::mjpeg::{read_jpeg_dimensions, MjpegFrameSplitter};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use ts_rs::TS;

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::spawn_ffmpeg;

/// The Tauri event channel the renderer listens on for preview frames.
pub const PREVIEW_EVENT: &str = "preview://frame";

/// The Tauri event channel the renderer listens on for a preview *failure*
/// (no camera, permission denied, device error). Lets the UI replace the dead
/// placeholder with a real message instead of a silently-blank preview.
pub const PREVIEW_ERROR_EVENT: &str = "preview://error";

/// How long after ffmpeg spawns we wait for the first frame before declaring the
/// preview dead. macOS camera negotiation + the first MJPEG frame comfortably
/// fits in a couple of seconds; 6s leaves slack for a slow USB camera while still
/// failing fast enough that the user isn't left staring at a blank box.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(6);

/// Default preview frame-rate. Low on purpose: a preview only needs to look
/// live, and a low rate keeps both the camera negotiation and the base64/IPC
/// overhead modest. The recorder captures at the user's real rate separately.
const DEFAULT_FPS: u32 = 15;

/// One preview frame delivered to the renderer. `data` is a base64-encoded JPEG
/// (drop it straight into `src="data:image/jpeg;base64,…"`).
///
/// base64 roughly +33% over the raw bytes; acceptable for a low-fps preview, and
/// it keeps the payload plain JSON. A raw-binary channel is a later optimisation
/// if the preview rate ever climbs.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/PreviewFrame.ts")]
pub struct PreviewFrame {
    /// Base64-encoded JPEG bytes (no data-URL prefix).
    pub data: String,
    /// Frame width in pixels, when the JPEG header could be parsed.
    pub width: Option<u16>,
    /// Frame height in pixels, when the JPEG header could be parsed.
    pub height: Option<u16>,
    /// Monotonic frame counter since this preview session started (1-based).
    #[ts(type = "number")]
    pub seq: u64,
}

/// A preview failure surfaced to the renderer over [`PREVIEW_ERROR_EVENT`]. The
/// `message` is already user-facing (Norwegian) so the UI can show it verbatim
/// instead of the silent dead-placeholder the old preview left behind.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/PreviewError.ts")]
pub struct PreviewError {
    /// User-facing failure message.
    pub message: String,
}

/// Build the ffmpeg arguments for an MJPEG camera-preview stream on `platform`.
///
/// Pure and deterministic so the argument shape is unit-tested without a camera.
/// `device` is the platform's camera identifier (an avfoundation index/name on
/// macOS, a dshow device name on Windows); `None` falls back to the first
/// device. `size` (`"WxH"`) requests a resolution; `None` lets the device pick
/// its native mode.
///
/// NOTE: this is the single-config spike form. The Electron build carried a
/// per-device retry matrix (`MAC_CONFIGS`, framerate/format fallbacks) — that
/// robustness layer is reintroduced in Phase 2, on top of this primitive.
pub fn build_preview_args(
    platform: Platform,
    device: Option<&str>,
    fps: u32,
    size: Option<&str>,
) -> Vec<String> {
    let fps = fps.to_string();
    match platform {
        Platform::MacOS => {
            // avfoundation: `-i "<video>:<audio>"`; `:none` captures video only.
            let dev = device.unwrap_or("0");
            let mut args = vec!["-f".into(), "avfoundation".into(), "-framerate".into(), fps];
            if let Some(s) = size {
                args.push("-video_size".into());
                args.push(s.into());
            }
            args.push("-i".into());
            args.push(format!("{dev}:none"));
            args.extend(mjpeg_output());
            args
        }
        Platform::Windows => {
            // dshow camera by name. rtbufsize guards against frame drops on slow
            // USB buses (mirrors the Electron dshow preview).
            let dev = device.unwrap_or("0");
            let mut args = vec![
                "-f".into(),
                "dshow".into(),
                "-rtbufsize".into(),
                "100M".into(),
                "-framerate".into(),
                fps,
            ];
            if let Some(s) = size {
                args.push("-video_size".into());
                args.push(s.into());
            }
            args.push("-i".into());
            args.push(format!("video={dev}"));
            args.extend(mjpeg_output());
            args
        }
        Platform::Linux => {
            // v4l2 — best-effort; Linux is not a shipping target but keeps the
            // match exhaustive and the dev box usable.
            let dev = device.unwrap_or("/dev/video0");
            let mut args = vec!["-f".into(), "v4l2".into(), "-framerate".into(), fps];
            if let Some(s) = size {
                args.push("-video_size".into());
                args.push(s.into());
            }
            args.push("-i".into());
            args.push(dev.into());
            args.extend(mjpeg_output());
            args
        }
    }
}

/// The shared output tail: encode to MJPEG and write to stdout (`pipe:1`).
fn mjpeg_output() -> Vec<String> {
    vec![
        "-f".into(),
        "mjpeg".into(),
        // Modest quality — a preview, not the recording. 2..31, lower = better.
        "-q:v".into(),
        "8".into(),
        "pipe:1".into(),
    ]
}

/// The platform we're running on, mapped to the core [`Platform`] enum.
fn current_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOS
    } else {
        Platform::Linux
    }
}

/// A running preview session: the spawned reader task. Aborting it drops the
/// ffmpeg child (`kill_on_drop`) and stops capture.
struct PreviewSession {
    task: tauri::async_runtime::JoinHandle<()>,
}

/// The engine handle stored in Tauri-managed state. At most one preview runs at
/// a time; starting again stops the previous one first.
#[derive(Default)]
pub struct PreviewEngine {
    session: Mutex<Option<PreviewSession>>,
}

impl PreviewEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Start previewing `device` (or the first camera when `None`) at `fps`
    /// (defaulting to [`DEFAULT_FPS`]). Stops any previous session first. Returns
    /// once ffmpeg has spawned, so a failure to launch surfaces to the caller.
    pub async fn start(
        &self,
        app: AppHandle,
        device: Option<String>,
        fps: Option<u32>,
    ) -> AppResult<()> {
        self.stop();

        // Resolve the camera token the SAME way the recorder does: a stored
        // camera *name* (e.g. "FaceTime HD Camera") is not what avfoundation's
        // `-i` accepts on macOS — it needs the device *index*. Feeding ffmpeg the
        // raw name produced an invalid input and zero frames (the silent dead
        // preview). We enumerate + fuzzy-match to the avfoundation index here.
        let resolved = resolve_preview_device(device).await;

        let args = build_preview_args(
            current_platform(),
            resolved.as_deref(),
            fps.unwrap_or(DEFAULT_FPS),
            None,
        );

        // Confirm ffmpeg actually spawned before reporting success, so the UI
        // gets a real error (e.g. camera permission denied) instead of a silent
        // dead preview. Readiness is awaited over a `tokio::oneshot` — a blocking
        // `recv()` here on the async command worker would starve the runtime that
        // the spawned `run_preview` task needs to make progress → deadlock →
        // beachball (the camera preview never appears).
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

        let task = tauri::async_runtime::spawn(async move {
            run_preview(app, args, ready_tx).await;
        });

        match ready_rx.await {
            Ok(Ok(())) => {
                *self.session.lock().expect("preview mutex") = Some(PreviewSession { task });
                Ok(())
            }
            Ok(Err(e)) => {
                task.abort();
                Err(e)
            }
            Err(_) => {
                task.abort();
                Err(AppError::Recording(
                    "preview task exited before signalling".into(),
                ))
            }
        }
    }

    /// Stop the current preview, if any. Safe to call when nothing is running.
    pub fn stop(&self) {
        let session = self.session.lock().expect("preview mutex").take();
        if let Some(session) = session {
            // Aborting drops the future → drops the ffmpeg `Child` →
            // `kill_on_drop` terminates the process.
            session.task.abort();
        }
    }
}

/// Resolve a stored camera identifier into the token ffmpeg's `-i` accepts: on
/// macOS the avfoundation *index*, on Windows/dshow the device *name*. Mirrors
/// the recorder (`RecorderEngine::start`): enumerate, fuzzy-match with
/// [`find_best_video_device_match`], then take the matched device's
/// index-or-name token.
///
/// Pass-through cases (no enumeration needed):
///   * `None` → `None` (the arg builder falls back to avfoundation `"0"`).
///   * an all-digit string (already an index, e.g. `"0"`) → unchanged.
///
/// Resilient by design: enumeration failure or a non-matching name falls back to
/// index `"0"` (the default camera) rather than erroring — a wrong-but-present
/// preview is recoverable, and the no-frames watchdog will surface a real error
/// if `"0"` also yields nothing.
async fn resolve_preview_device(device: Option<String>) -> Option<String> {
    let name = device?;
    // Already a pure index — leave it. (Also covers an empty string defensively.)
    if name.is_empty() || name.chars().all(|c| c.is_ascii_digit()) {
        return Some(name);
    }

    match enumerate_ffmpeg_devices().await {
        Ok(inv) => match find_best_video_device_match(&inv.video_inputs, &name) {
            // avfoundation index when known; dshow falls back to the name.
            Some(dev) => Some(
                dev.index
                    .map_or_else(|| dev.name.clone(), |i| i.to_string()),
            ),
            None => {
                tracing::warn!(
                    requested = %name,
                    "preview: no camera matched stored name; falling back to index 0"
                );
                Some("0".into())
            }
        },
        Err(e) => {
            tracing::warn!("preview: device enumeration failed ({e}); falling back to index 0");
            Some("0".into())
        }
    }
}

/// Classify an ffmpeg avfoundation/dshow stderr line as a fatal camera error and,
/// if so, return a user-facing (Norwegian) message. Best-effort and conservative:
/// only lines that clearly indicate "no camera / access denied / cannot open"
/// trip it, so a benign warning never kills a working preview.
fn classify_camera_error(line: &str) -> Option<&'static str> {
    let l = line.to_lowercase();
    if l.contains("permission") || l.contains("not authorized") || l.contains("denied") {
        Some("Kameratilgang nektet. Gi appen tilgang til kameraet i Systemvalg.")
    } else if l.contains("input/output error")
        || l.contains("could not open")
        || l.contains("cannot open")
        || l.contains("no such")
        || l.contains("error opening input")
        || l.contains("input device")
    {
        Some("Fant ikke kameraet. Sjekk at det er tilkoblet og ikke i bruk.")
    } else {
        None
    }
}

/// The reader task body: spawn ffmpeg, signal readiness, then pump stdout
/// through the frame splitter and emit each completed JPEG to the renderer.
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real camera; see the module header.
async fn run_preview(
    app: AppHandle,
    args: Vec<String>,
    ready: tokio::sync::oneshot::Sender<AppResult<()>>,
) {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // `child` stays owned in this scope for the task's whole life, so dropping
    // the task (on stop/abort) drops the child and `kill_on_drop` fires.
    let mut child = match spawn_ffmpeg(&arg_refs).await {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let Some(mut stdout) = child.stdout.take() else {
        let _ = ready.send(Err(AppError::Recording(
            "ffmpeg preview produced no stdout".into(),
        )));
        return;
    };

    // We're live.
    let _ = ready.send(Ok(()));

    // Drain stderr in the background so we can (a) classify a fatal camera error
    // into a user-facing `preview://error`, and (b) not let a full stderr pipe
    // stall ffmpeg. Non-blocking and best-effort. The first classified error
    // wins and is forwarded back to the reader loop so it can surface it once and
    // stop. We also keep the raw lines in the logs for diagnostics.
    let (err_tx, mut err_rx) = tokio::sync::mpsc::channel::<&'static str>(1);
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "preview_ffmpeg", "{line}");
                if let Some(msg) = classify_camera_error(&line) {
                    // Best-effort: if the channel is full/closed the first error
                    // already won, so dropping this one is fine.
                    let _ = err_tx.try_send(msg);
                }
            }
        });
    }

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut splitter = MjpegFrameSplitter::new();
    let mut read_buf = vec![0u8; 64 * 1024];
    let mut seq: u64 = 0;
    // The no-frames watchdog: if no frame arrives before this fires, the camera
    // is dead/blocked even though ffmpeg "spawned". We then emit `preview://error`
    // so the UI shows a message instead of a silently-blank box. Disarmed (set to
    // `None`) once the first frame lands.
    let mut first_frame_deadline = Some(Box::pin(tokio::time::sleep(FIRST_FRAME_TIMEOUT)));

    loop {
        let n = tokio::select! {
            // A classified stderr error: surface it immediately and stop.
            Some(msg) = err_rx.recv() => {
                let _ = app.emit(
                    PREVIEW_ERROR_EVENT,
                    PreviewError { message: msg.into() },
                );
                return;
            }
            // No first frame within the timeout: the preview is dead.
            () = async { first_frame_deadline.as_mut().unwrap().as_mut().await },
                if first_frame_deadline.is_some() =>
            {
                tracing::warn!("preview: no frame within {FIRST_FRAME_TIMEOUT:?}");
                let _ = app.emit(
                    PREVIEW_ERROR_EVENT,
                    PreviewError {
                        message: "Ingen videostrøm fra kameraet. Sjekk tilkobling og tilgang."
                            .into(),
                    },
                );
                return;
            }
            read = stdout.read(&mut read_buf) => match read {
                Ok(0) => break, // ffmpeg closed stdout — stream ended
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("preview stdout read error: {e}");
                    break;
                }
            },
        };

        for frame in splitter.push(&read_buf[..n]) {
            let (width, height) = match read_jpeg_dimensions(&frame) {
                Some((w, h)) => (Some(w), Some(h)),
                None => (None, None),
            };
            seq += 1;
            // First frame in: disarm the no-frames watchdog.
            first_frame_deadline = None;
            let payload = PreviewFrame {
                data: b64.encode(&frame),
                width,
                height,
                seq,
            };
            // A failed emit means the window/listener is gone — end the stream.
            if app.emit(PREVIEW_EVENT, payload).is_err() {
                return;
            }
        }
    }
    // `child` drops here → `kill_on_drop` ensures ffmpeg is gone.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_args_capture_video_only_to_mjpeg_stdout() {
        let args = build_preview_args(Platform::MacOS, Some("1"), 30, None);
        assert!(args.windows(2).any(|w| w == ["-f", "avfoundation"]));
        assert!(args.windows(2).any(|w| w == ["-framerate", "30"]));
        // video-only input: "<device>:none"
        assert!(args.iter().any(|a| a == "1:none"));
        // MJPEG to stdout
        assert!(args.windows(2).any(|w| w == ["-f", "mjpeg"]));
        assert_eq!(args.last().unwrap(), "pipe:1");
    }

    #[test]
    fn mac_args_default_device_is_zero() {
        let args = build_preview_args(Platform::MacOS, None, 15, None);
        assert!(args.iter().any(|a| a == "0:none"));
    }

    #[test]
    fn mac_args_include_video_size_when_requested() {
        let args = build_preview_args(Platform::MacOS, Some("0"), 30, Some("1280x720"));
        assert!(args.windows(2).any(|w| w == ["-video_size", "1280x720"]));
    }

    #[test]
    fn windows_args_use_dshow_named_device_with_rtbufsize() {
        let args = build_preview_args(Platform::Windows, Some("Logitech BRIO"), 30, None);
        assert!(args.windows(2).any(|w| w == ["-f", "dshow"]));
        assert!(args.windows(2).any(|w| w == ["-rtbufsize", "100M"]));
        // dshow names the camera as `video=<name>`
        assert!(args.iter().any(|a| a == "video=Logitech BRIO"));
        assert!(args.windows(2).any(|w| w == ["-f", "mjpeg"]));
    }

    #[test]
    fn event_name_is_stable() {
        assert_eq!(PREVIEW_EVENT, "preview://frame");
    }

    #[test]
    fn engine_stop_is_safe_when_idle() {
        let engine = PreviewEngine::new();
        engine.stop();
        engine.stop();
    }

    #[test]
    fn error_event_name_is_stable() {
        assert_eq!(PREVIEW_ERROR_EVENT, "preview://error");
    }

    #[tokio::test]
    async fn resolve_passes_through_none() {
        assert_eq!(resolve_preview_device(None).await, None);
    }

    #[tokio::test]
    async fn resolve_passes_through_numeric_index_without_enumerating() {
        // A pure index is already what avfoundation accepts — must be returned
        // verbatim and must NOT touch ffmpeg enumeration.
        assert_eq!(
            resolve_preview_device(Some("0".into())).await,
            Some("0".into())
        );
        assert_eq!(
            resolve_preview_device(Some("2".into())).await,
            Some("2".into())
        );
    }

    #[test]
    fn classify_camera_error_flags_permission_denied() {
        assert!(
            classify_camera_error("[avfoundation] permission to capture video was denied")
                .is_some()
        );
        assert!(classify_camera_error("Operation not authorized").is_some());
    }

    #[test]
    fn classify_camera_error_flags_open_failure() {
        assert!(classify_camera_error("Error opening input: Input/output error").is_some());
        assert!(classify_camera_error("Could not open video device").is_some());
    }

    #[test]
    fn classify_camera_error_ignores_benign_lines() {
        // Routine ffmpeg banner / progress lines must NOT trip the error path.
        assert!(classify_camera_error("frame=  120 fps= 15 q=8.0 size=…").is_none());
        assert!(classify_camera_error("Stream #0:0: Video: mjpeg").is_none());
    }
}
