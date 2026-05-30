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

use base64::Engine;
use serde::{Deserialize, Serialize};
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::mjpeg::{read_jpeg_dimensions, MjpegFrameSplitter};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use ts_rs::TS;

use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::spawn_ffmpeg;

/// The Tauri event channel the renderer listens on for preview frames.
pub const PREVIEW_EVENT: &str = "preview://frame";

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
    pub fn start(&self, app: AppHandle, device: Option<String>, fps: Option<u32>) -> AppResult<()> {
        self.stop();

        let args = build_preview_args(
            current_platform(),
            device.as_deref(),
            fps.unwrap_or(DEFAULT_FPS),
            None,
        );

        // Confirm ffmpeg actually spawned before reporting success, so the UI
        // gets a real error (e.g. camera permission denied) instead of a silent
        // dead preview.
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<AppResult<()>>();

        let task = tauri::async_runtime::spawn(async move {
            run_preview(app, args, ready_tx).await;
        });

        match ready_rx.recv() {
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

/// The reader task body: spawn ffmpeg, signal readiness, then pump stdout
/// through the frame splitter and emit each completed JPEG to the renderer.
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real camera; see the module header.
async fn run_preview(
    app: AppHandle,
    args: Vec<String>,
    ready: std::sync::mpsc::Sender<AppResult<()>>,
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

    let b64 = base64::engine::general_purpose::STANDARD;
    let mut splitter = MjpegFrameSplitter::new();
    let mut read_buf = vec![0u8; 64 * 1024];
    let mut seq: u64 = 0;

    loop {
        let n = match stdout.read(&mut read_buf).await {
            Ok(0) => break, // ffmpeg closed stdout — stream ended
            Ok(n) => n,
            Err(e) => {
                tracing::warn!("preview stdout read error: {e}");
                break;
            }
        };

        for frame in splitter.push(&read_buf[..n]) {
            let (width, height) = match read_jpeg_dimensions(&frame) {
                Some((w, h)) => (Some(w), Some(h)),
                None => (None, None),
            };
            seq += 1;
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
}
