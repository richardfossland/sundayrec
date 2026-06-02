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
use crate::media::permissions;
use crate::util::{detect_platform, lock_recover};

/// The Tauri event channel the renderer listens on for preview frames.
pub const PREVIEW_EVENT: &str = "preview://frame";

/// The Tauri event channel the renderer listens on for a preview *failure*
/// (no camera, permission denied, device error). Lets the UI replace the dead
/// placeholder with a real message instead of a silently-blank preview.
pub const PREVIEW_ERROR_EVENT: &str = "preview://error";

/// How long after ffmpeg spawns we wait for the first frame before declaring a
/// single (non-mode-retry) attempt dead. Used on non-macOS, where there is no
/// mode matrix to walk. macOS camera negotiation + the first MJPEG frame
/// comfortably fits in a couple of seconds; 6s leaves slack for a slow USB camera
/// while still failing fast enough that the user isn't left staring at a blank box.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(6);

/// Per-attempt first-frame deadline when walking the macOS mode matrix. Short on
/// purpose: with five modes a single 6 s window per mode would feel glacial, so we
/// give each mode ~2 s — long enough for avfoundation to negotiate and emit a
/// frame if the mode is supported, short enough that five misses still resolve in
/// ~10 s. A mode that is going to work almost always produces its first frame well
/// inside this.
const MODE_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(2);

/// Ordered avfoundation capture modes to try for a macOS preview, most-likely-good
/// first. avfoundation produces ZERO frames if the requested `-video_size`/
/// `-framerate` pair is not a mode the device advertises (the silent dead
/// preview), and different cameras advertise different modes (the FaceTime HD,
/// for instance, often offers 1920x1080@30 but not 720p). So rather than betting
/// on one hardcoded mode we walk this matrix and keep the first that yields a
/// frame.
///
/// The final `(None, 30)` entry is the escape hatch: a bare `-framerate 30` with
/// NO `-video_size`, for devices that reject every explicit size and only work
/// when ffmpeg is left to pick the native mode.
///
/// ⚠️ HARDWARE-UNVERIFIED — which mode actually wins depends on the real camera.
const MAC_PREVIEW_MODES: &[(Option<&str>, u32)] = &[
    (Some("1280x720"), 30),
    (Some("1920x1080"), 30),
    // PAL (25 fps) variants: European HDMI capture cards / cameras commonly
    // advertise ONLY 25 fps, so a 30-fps-only matrix would never find their mode
    // (the old Electron build carried these as MAC_CONFIGS 4 & 5).
    (Some("1920x1080"), 25),
    (Some("1280x720"), 25),
    (Some("640x480"), 30),
    // Escape hatches: bare `-framerate` with NO `-video_size`, for devices that
    // reject every explicit size and only work at their native mode — at 30 then
    // 25 (a PAL-only grabber rejects a bare 30 too).
    (None, 30),
    (None, 25),
];

/// Default preview frame-rate. Low on purpose: a preview only needs to look
/// live, and a low rate keeps both the camera negotiation and the base64/IPC
/// overhead modest. The recorder captures at the user's real rate separately.
const DEFAULT_FPS: u32 = 15;

/// How long the live stream may go WITHOUT a new frame before we treat it as a
/// stall and restart. macOS idling/sleeping the camera leaves the long-running
/// preview ffmpeg's MJPEG stream stalled or degraded (a frozen/garbled/doubled
/// image) with no recovery of its own — there is only a first-frame deadline per
/// mode attempt, nothing once frames are flowing. At even the lowest sensible
/// preview rate a fresh frame should arrive every ~67–200 ms; 3 s is far longer
/// than any legitimate inter-frame gap, so it fires only on a genuine stall while
/// staying well clear of false positives on a merely slow camera.
const STREAM_STALL_TIMEOUT: Duration = Duration::from_secs(3);

/// How many CONSECUTIVE stall-restarts that delivered ZERO frames we tolerate
/// before giving up and surfacing an error. A stall *after* frames flowed is the
/// normal "camera woke up" case and restarts quietly with the counter reset; only
/// a restart that then produces no frame at all counts toward the cap, so a
/// genuinely-gone camera stops spinning after a few tries instead of forever.
const MAX_STALL_RESTARTS: u32 = 4;

/// Backoff before each stall-restart, scaled by how many zero-frame restarts we
/// have already burned. Keeps a genuinely-dead camera from busy-spinning ffmpeg
/// spawns while a real "woke up" stall (counter reset to 0) restarts promptly.
fn stall_restart_backoff(consecutive_zero_frame_restarts: u32) -> Duration {
    // 0 → 150ms (the woke-up case: near-instant), then 300ms, 600ms, 1200ms…
    let base_ms: u64 = 150;
    let shift = consecutive_zero_frame_restarts.min(3);
    Duration::from_millis(base_ms << shift)
}

/// Pure decision: should the preview restart from the top of the mode matrix after
/// the live stream went quiet?
///
/// A restart is warranted only once the gap since the last emitted frame has
/// exceeded [`STREAM_STALL_TIMEOUT`] AND we are actually in the streaming phase
/// (`frames_seen > 0` — before the first frame the per-attempt first-frame
/// deadline owns the decision, not this watchdog). Factored out so the threshold
/// logic is unit-tested without spawning ffmpeg.
fn should_restart_after_stall(ms_since_last_frame: u64, frames_seen: u64) -> bool {
    frames_seen > 0 && ms_since_last_frame >= STREAM_STALL_TIMEOUT.as_millis() as u64
}

/// Pure decision: have we exhausted the stall-restart budget and should give up
/// (emit an error and stop) rather than restart again?
///
/// Only restarts that produced ZERO frames count — a restart that streamed real
/// frames resets the counter, so the normal "camera slept then woke" loop never
/// trips this. Once [`MAX_STALL_RESTARTS`] consecutive zero-frame restarts pile
/// up, the camera is genuinely gone and we stop spinning.
fn should_give_up_after_stalls(consecutive_zero_frame_restarts: u32) -> bool {
    consecutive_zero_frame_restarts >= MAX_STALL_RESTARTS
}

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
/// device. `output_fps` is the throttled preview rate emitted to the renderer.
///
/// `input_fps` and `size` come from the capture mode being attempted (on macOS,
/// an entry of [`MAC_PREVIEW_MODES`]): `input_fps` is the framerate requested on
/// the INPUT, and `size` (`"WxH"`) the resolution. `size == None` means "do NOT
/// pin a video size" — emit only `-framerate {input_fps}` and let ffmpeg pick the
/// device's native mode (the matrix's last-resort escape hatch).
pub fn build_preview_args(
    platform: Platform,
    device: Option<&str>,
    output_fps: u32,
    input_fps: u32,
    size: Option<&str>,
) -> Vec<String> {
    let output_fps = output_fps.to_string();
    let input_fps = input_fps.to_string();
    match platform {
        Platform::MacOS => {
            // avfoundation: `-i "<video>:<audio>"`; `:none` captures video only.
            let dev = device.unwrap_or("0");
            // avfoundation produces ZERO frames if the requested `-framerate`/
            // `-video_size` pair is not a mode the device advertises → negotiation
            // fails ("Selected framerate is not supported" / "Input/output error")
            // → the silent dead preview. The caller walks `MAC_PREVIEW_MODES` and
            // feeds us one mode at a time; we request it on the INPUT, then drop
            // the OUTPUT rate to the low preview `output_fps` with `-r` so the
            // stream stays light over IPC.
            let mut args = vec![
                "-f".into(),
                "avfoundation".into(),
                "-framerate".into(),
                input_fps,
            ];
            // `size == None` = the bare-framerate escape hatch: no `-video_size`.
            if let Some(s) = size {
                args.push("-video_size".into());
                args.push(s.into());
            }
            args.push("-i".into());
            args.push(format!("{dev}:none"));
            // Throttle the OUTPUT to the preview rate (the camera still captures at
            // its supported input rate above).
            args.push("-r".into());
            args.push(output_fps);
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
                input_fps,
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
            let mut args = vec!["-f".into(), "v4l2".into(), "-framerate".into(), input_fps];
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

/// The shared output tail: downscale, then encode to MJPEG and write to stdout
/// (`pipe:1`).
///
/// The INPUT mode negotiation (the `-video_size`/`-framerate` matrix above) is
/// what actually makes the camera open, so it is left untouched. But the camera
/// is opened at up to 1280x720 (or 1080p), and shipping those full frames as
/// base64 over the Tauri IPC was ~3 MB/s and made the preview laggy. We DOWNSCALE
/// the OUTPUT to ~640px wide (`-vf scale=640:-2`, the `-2` keeps the height even
/// and the aspect ratio) BEFORE the mjpeg encode, and raise `-q:v` (lower quality)
/// — together this cuts the per-frame base64 payload roughly 4×. The recorder
/// captures full quality on its own separate path, so the preview shrink is free.
fn mjpeg_output() -> Vec<String> {
    vec![
        // Downscale the preview output to ~640px wide; `-2` = even height,
        // aspect-preserved. Independent of the INPUT capture size.
        "-vf".into(),
        "scale=640:-2".into(),
        "-f".into(),
        "mjpeg".into(),
        // A preview, not the recording — bias toward smaller frames over crispness.
        // 2..31, lower = better; 10 (up from 8) trims the payload further.
        "-q:v".into(),
        "10".into(),
        "pipe:1".into(),
    ]
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

        // Fail FAST + CLEAR on a denied/restricted camera. avfoundation on a
        // blocked device usually emits only "Input/output error" or zero frames,
        // which the user reads as the misleading "Fant ikke kameraet" — and we'd
        // have burned ~10 s walking the mode matrix first. Asking AVFoundation for
        // the authorization status up front lets us point them straight at System
        // Settings. NotDetermined/Unknown fall through (opening the device is what
        // triggers the OS prompt; Unknown means we couldn't tell → behave as before).
        let cam = permissions::status(permissions::MediaKind::Camera);
        if let Some(message) = permissions::blocked_message(permissions::MediaKind::Camera, cam) {
            let _ = app.emit(
                PREVIEW_ERROR_EVENT,
                PreviewError {
                    message: message.clone(),
                },
            );
            return Err(AppError::Recording(message));
        }

        // Resolve the camera token the SAME way the recorder does: a stored
        // camera *name* (e.g. "FaceTime HD Camera") is not what avfoundation's
        // `-i` accepts on macOS — it needs the device *index*. Feeding ffmpeg the
        // raw name produced an invalid input and zero frames (the silent dead
        // preview). We enumerate + fuzzy-match to the avfoundation index here.
        //
        // Trust change: a *specifically requested* camera that no longer matches
        // (or an enumeration failure) is NOT silently swapped for the default
        // camera — we surface a real error so the user knows their pick is gone.
        let device_token = match resolve_preview_device(device).await {
            ResolvedDevice::Index(idx) => idx,
            ResolvedDevice::NoMatch(name) => {
                let message = format!(
                    "Fant ikke kameraet «{name}». Sjekk at det er tilkoblet og at \
                     appen har kameratilgang."
                );
                let _ = app.emit(
                    PREVIEW_ERROR_EVENT,
                    PreviewError {
                        message: message.clone(),
                    },
                );
                return Err(AppError::Recording(message));
            }
            ResolvedDevice::EnumFailed => {
                let message = "Kunne ikke lese kameraliste.".to_string();
                let _ = app.emit(
                    PREVIEW_ERROR_EVENT,
                    PreviewError {
                        message: message.clone(),
                    },
                );
                return Err(AppError::Recording(message));
            }
        };

        let platform = detect_platform();
        let output_fps = fps.unwrap_or(DEFAULT_FPS);

        // Confirm ffmpeg actually produced a frame before reporting success, so
        // the UI gets a real error (e.g. camera permission denied) instead of a
        // silent dead preview. Readiness is awaited over a `tokio::oneshot` — a
        // blocking `recv()` here on the async command worker would starve the
        // runtime that the spawned `run_preview` task needs to make progress →
        // deadlock → beachball (the camera preview never appears).
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

        let task = tauri::async_runtime::spawn(async move {
            run_preview(app, platform, device_token, output_fps, ready_tx).await;
        });

        match ready_rx.await {
            Ok(Ok(())) => {
                *lock_recover(&self.session) = Some(PreviewSession { task });
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
        let session = lock_recover(&self.session).take();
        if let Some(session) = session {
            // Aborting drops the future → drops the ffmpeg `Child` →
            // `kill_on_drop` terminates the process.
            session.task.abort();
        }
    }

    /// Stop the current preview AND wait until the camera is actually released.
    ///
    /// The recorder must call this BEFORE it opens the camera: on macOS a camera
    /// has a single owner, so as long as the preview's ffmpeg child still holds
    /// the device the recorder's avfoundation video input can't open it and video
    /// silently fails to capture. The synchronous [`Self::stop`] aborts the reader
    /// task and lets `kill_on_drop` fire, but `kill_on_drop` sends the kill
    /// asynchronously and does NOT wait — so the recorder could race the camera's
    /// release. Here we abort the task and AWAIT its `JoinHandle`: the task only
    /// finishes once its future (and the owned ffmpeg `Child`) has been fully
    /// dropped, which mirrors how the VU/pre-roll stop blocks until the mic is
    /// free. A short settle then gives the OS a beat to reclaim the device node.
    ///
    /// ⚠️ HARDWARE-UNVERIFIED — the actual camera-release timing needs a real rig.
    pub async fn stop_and_release(&self) {
        let session = lock_recover(&self.session).take();
        if let Some(session) = session {
            session.task.abort();
            // Await the aborted task: it resolves once the future — and the owned
            // ffmpeg `Child` inside it — is dropped, so `kill_on_drop` has fired.
            // A `JoinError::Cancelled` here is expected and ignored.
            let _ = session.task.await;
            // Give the OS a brief beat to release the camera device node before
            // the recorder opens it (avfoundation can lag a hair behind the
            // process exit).
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }
}

/// The outcome of resolving a stored camera identifier into the token ffmpeg's
/// `-i` accepts.
///
/// The distinction matters because the old "always fall back to index 0" policy
/// silently previewed the WRONG camera when a specifically-requested device was
/// unplugged or the name no longer matched — no feedback, just the default camera
/// pretending to be the one the user picked. We now keep the failure explicit so
/// the caller can surface a real error instead.
#[derive(Debug, Clone, PartialEq, Eq)]
enum ResolvedDevice {
    /// A usable device token: an avfoundation *index* (macOS) or a dshow *name*
    /// (Windows). This is what `build_preview_args` consumes.
    Index(String),
    /// A SPECIFIC camera name was requested but matched nothing in the device
    /// list. Carries the requested name for the user-facing message.
    NoMatch(String),
    /// Device enumeration itself failed, so no match could even be attempted.
    EnumFailed,
}

/// Pure decision: given the requested `device` token and an *already-enumerated*
/// device list (or `None` for "enumeration failed"), decide the resolution.
/// Factored out of [`resolve_preview_device`] so the trust logic is unit-tested
/// without touching ffmpeg.
///
///   * `None` / empty request → default camera, `Index("0")` (legitimate "use the
///     default camera"; not a failure).
///   * an all-digit string (already an index, e.g. `"0"`) → `Index(name)` verbatim.
///   * `devices == None` (enumeration failed) for a specific name → `EnumFailed`.
///   * a specific name that matches → `Index(idx-or-name)`.
///   * a specific name that does NOT match → `NoMatch(name)` (NOT a silent `"0"`).
fn decide_resolved_device(
    device: Option<&str>,
    devices: Option<&[sundayrec_core::device_match::FfmpegDevice]>,
) -> ResolvedDevice {
    // No request, or an empty one → the default camera. avfoundation's `"0"`.
    let name = match device {
        Some(n) if !n.is_empty() => n,
        _ => return ResolvedDevice::Index("0".into()),
    };

    // Already a pure index — leave it untouched, no enumeration needed.
    if name.chars().all(|c| c.is_ascii_digit()) {
        return ResolvedDevice::Index(name.to_string());
    }

    let Some(devices) = devices else {
        return ResolvedDevice::EnumFailed;
    };

    match find_best_video_device_match(devices, name) {
        // avfoundation index when known; dshow falls back to the name.
        Some(dev) => ResolvedDevice::Index(
            dev.index
                .map_or_else(|| dev.name.clone(), |i| i.to_string()),
        ),
        None => ResolvedDevice::NoMatch(name.to_string()),
    }
}

/// Resolve a stored camera identifier into the token ffmpeg's `-i` accepts: on
/// macOS the avfoundation *index*, on Windows/dshow the device *name*. Mirrors
/// the recorder (`RecorderEngine::start`): enumerate, fuzzy-match with
/// [`find_best_video_device_match`], then take the matched device's
/// index-or-name token.
///
/// Pass-through cases (no enumeration needed):
///   * `None` / empty → `Index("0")` (the legitimate default camera).
///   * an all-digit string (already an index, e.g. `"0"`) → unchanged.
///
/// Trust change (vs the old "always index 0" fallback): a *specifically requested*
/// camera that no longer matches, or an enumeration failure, returns
/// [`ResolvedDevice::NoMatch`] / [`ResolvedDevice::EnumFailed`] so the caller can
/// surface a real error rather than silently previewing the WRONG camera.
async fn resolve_preview_device(device: Option<String>) -> ResolvedDevice {
    // Pass-through cases never need enumeration; decide directly so we don't spawn
    // ffmpeg for `None`/index requests.
    if device
        .as_deref()
        .is_none_or(|n| n.is_empty() || (!n.is_empty() && n.chars().all(|c| c.is_ascii_digit())))
    {
        return decide_resolved_device(device.as_deref(), None);
    }

    match enumerate_ffmpeg_devices().await {
        Ok(inv) => decide_resolved_device(device.as_deref(), Some(&inv.video_inputs)),
        Err(e) => {
            tracing::warn!("preview: device enumeration failed ({e})");
            decide_resolved_device(device.as_deref(), None)
        }
    }
}

/// Classify an ffmpeg avfoundation/dshow stderr line as a fatal camera error and,
/// if so, return a user-facing (Norwegian) message. Best-effort and conservative:
/// only lines that clearly indicate "no camera / access denied / cannot open"
/// trip it, so a benign warning never kills a working preview.
fn classify_camera_error(line: &str) -> Option<&'static str> {
    let l = line.to_lowercase();
    if is_permission_fatal_line(&l) {
        Some("Kameratilgang nektet. Gi appen tilgang til kameraet i Systemvalg.")
    } else if is_camera_in_use_line(&l) {
        // A camera held by Zoom/Teams/Photo Booth etc. No capture mode will free
        // it, so this is fatal for the whole matrix — surface it fast.
        Some("Kameraet er i bruk av et annet program. Lukk det og prøv igjen.")
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

/// Whether an (already-lowercased) stderr line indicates the camera is held by
/// ANOTHER application/session. avfoundation surfaces this as plain text on most
/// builds and as OSStatus `-11804` (AVErrorDeviceAlreadyUsedByAnotherSession) on
/// others. Retrying other capture modes can't free a busy device, so the caller
/// treats this as fatal (short-circuits the matrix).
fn is_camera_in_use_line(lowercased: &str) -> bool {
    lowercased.contains("in use")
        || lowercased.contains("resource busy")
        || lowercased.contains("device or resource busy")
        || lowercased.contains("device is busy")
        || lowercased.contains("already in use")
        || lowercased.contains("-11804")
}

/// Whether an (already-lowercased) stderr line indicates a PERMISSION/access
/// failure. A permission error is fatal for the whole mode matrix: retrying other
/// capture modes cannot grant camera access, so the caller must short-circuit
/// immediately instead of grinding through every mode's deadline.
fn is_permission_fatal_line(lowercased: &str) -> bool {
    lowercased.contains("permission")
        || lowercased.contains("not authorized")
        || lowercased.contains("denied")
}

/// Whether the message produced by [`classify_camera_error`] is the fatal
/// permission variant (vs a retry-eligible open/format error).
fn is_permission_fatal(msg: &str) -> bool {
    msg == "Kameratilgang nektet. Gi appen tilgang til kameraet i Systemvalg."
}

/// Whether a classified message is fatal for the WHOLE mode matrix — no other
/// capture mode can fix it, so the walk short-circuits. Covers both a permission
/// denial AND a camera held by another app (busy); a plain open/format error
/// stays retry-eligible so the matrix can try the next mode.
fn is_fatal_camera_error(msg: &str) -> bool {
    is_permission_fatal(msg)
        || msg == "Kameraet er i bruk av et annet program. Lukk det og prøv igjen."
}

/// The capture modes to try for `platform`, in attempt order, as
/// `(input_fps, size)` pairs fed to [`build_preview_args`].
///
/// macOS walks the full [`MAC_PREVIEW_MODES`] negotiation matrix (the camera may
/// not advertise the first mode we ask for). Every other platform makes a single
/// attempt with its native single config: `(output_fps, None)` lets the
/// arg-builder use the device's native mode (Windows/Linux do not have the
/// avfoundation "must pin a supported size" constraint).
fn preview_modes_for(platform: Platform, output_fps: u32) -> Vec<(u32, Option<&'static str>)> {
    match platform {
        Platform::MacOS => MAC_PREVIEW_MODES
            .iter()
            .map(|&(size, fps)| (fps, size))
            .collect(),
        _ => vec![(output_fps, None)],
    }
}

/// The outcome of one [`attempt_preview_mode`] try.
enum AttemptOutcome {
    /// A frame arrived and the stream was pumped to completion (stop/exit/
    /// listener-gone). The whole preview is done; do not try further modes.
    Streamed,
    /// No frame arrived within the per-attempt deadline, or ffmpeg exited early
    /// without producing one. Carries the last classified (retry-eligible) error
    /// seen on stderr, if any, so the caller can surface the REAL reason if every
    /// mode fails. Try the next mode.
    NoFrame { last_err: Option<&'static str> },
    /// A PERMISSION error was seen: retrying other modes cannot help. Short-circuit
    /// the whole matrix and surface this immediately.
    Fatal(&'static str),
    /// The live stream went quiet for longer than [`STREAM_STALL_TIMEOUT`] (the
    /// camera idled/slept and ffmpeg's MJPEG stream stalled or degraded). Carries
    /// whether ANY frame was delivered during this run so the caller can decide
    /// between a quiet "camera woke up" restart and counting toward the give-up cap.
    /// The whole preview must restart from the top of the mode matrix with a fresh
    /// child + splitter, so the matrix walk does NOT continue to the next mode.
    Stalled { delivered_frame: bool },
}

/// The reader task body: walk the platform's capture-mode matrix, and for the
/// FIRST mode that yields a frame, signal readiness once and pump frames to the
/// renderer until the stream ends. If no mode produces a frame, surface the real
/// classified error. A permission error short-circuits the matrix.
///
/// A *stall* of the live stream (the camera idled/slept and ffmpeg's MJPEG output
/// went quiet for [`STREAM_STALL_TIMEOUT`]) is NOT the end of the preview: we tear
/// the stalled child down and RESTART the whole matrix walk from the top with a
/// fresh child + [`MjpegFrameSplitter`], re-negotiating the camera rather than
/// leaving a frozen/garbled image on screen. A stall *after* frames were flowing
/// (the normal "camera woke up" case) restarts quietly; only consecutive restarts
/// that then deliver zero frames count toward [`MAX_STALL_RESTARTS`], after which
/// we give up with a real error so a genuinely-gone camera stops spinning.
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real camera and depends on which avfoundation
/// mode the device actually advertises; see the module header. The spawn/retry
/// path is wired but unexercised by the (hardware-free) test suite.
async fn run_preview(
    app: AppHandle,
    platform: Platform,
    device_token: String,
    output_fps: u32,
    ready: tokio::sync::oneshot::Sender<AppResult<()>>,
) {
    // PROBE the camera's REAL advertised modes once and open a KNOWN-good one,
    // instead of thrashing a hardcoded guess-matrix (the preview-stutter fix). The
    // old matrix tried 7 modes — several of them rates this camera rejects — at
    // 2 s each, rapidly opening/closing the camera until it destabilised. With
    // probed modes every attempt is a real one, so the first simply works, and a
    // stall restart re-opens the SAME good mode fast. Falls back to the legacy
    // matrix only if the probe yields nothing.
    let (preview_modes, attempt_timeout): (Vec<(u32, Option<String>)>, Duration) = {
        let probed = crate::media::camera::preview_modes_from(
            &crate::media::camera::probe_camera_modes(&device_token, platform).await,
        );
        if probed.is_empty() {
            let legacy = preview_modes_for(platform, output_fps)
                .into_iter()
                .map(|(f, s)| (f, s.map(String::from)))
                .collect();
            // A guess-matrix needs the short per-mode deadline to walk fast.
            let to = if matches!(platform, Platform::MacOS) {
                MODE_ATTEMPT_TIMEOUT
            } else {
                FIRST_FRAME_TIMEOUT
            };
            (legacy, to)
        } else {
            let modes = probed
                .into_iter()
                .map(|m| (m.input_fps, Some(format!("{}x{}", m.width, m.height))))
                .collect();
            // Real modes → allow proper camera WARM-UP (a 2 s deadline mistook
            // warmup for failure and forced a restart).
            (modes, FIRST_FRAME_TIMEOUT)
        }
    };

    // `ready` is consumed exactly once — Ok on the first frame from any mode, or
    // Err after every mode fails / we give up. We thread it through as `Option` so
    // a borrow across attempts and restarts is safe.
    let mut ready = Some(ready);

    // Consecutive stall-restarts that delivered ZERO frames. Reset whenever a
    // restart manages to stream at least one frame, so the normal sleep/wake loop
    // never trips the give-up cap; only a truly dead camera accumulates these.
    let mut zero_frame_restarts: u32 = 0;

    // Outer loop = the restart boundary. Each pass is a complete, fresh matrix
    // walk (fresh ffmpeg child + fresh `MjpegFrameSplitter` per attempt inside
    // `attempt_preview_mode`, so stale partial bytes can never concatenate into a
    // doubled/garbled frame across a restart).
    loop {
        match run_matrix_walk(
            &app,
            platform,
            &device_token,
            output_fps,
            &preview_modes,
            attempt_timeout,
            &mut ready,
        )
        .await
        {
            // The stream finished cleanly (stop/unplug/listener-gone) or a fatal
            // error was already surfaced — nothing more to do.
            MatrixWalk::Done => return,
            // The live stream stalled (camera idled/slept). Decide between a quiet
            // restart and giving up.
            MatrixWalk::Stalled { delivered_frame } => {
                if delivered_frame {
                    // The normal "camera woke up" case: frames WERE flowing, so this
                    // is not an error. Reset the give-up counter and restart quietly.
                    zero_frame_restarts = 0;
                    tracing::debug!("preview: live stream stalled after frames; restarting");
                } else {
                    // A restart that produced no frame at all → count it toward the
                    // cap so a genuinely-gone camera stops spinning.
                    zero_frame_restarts += 1;
                    if should_give_up_after_stalls(zero_frame_restarts) {
                        let message =
                            "Mistet kontakt med kameraet. Sjekk tilkobling og tilgang.".to_string();
                        tracing::warn!("preview: giving up after {zero_frame_restarts} stalls");
                        let _ = app.emit(
                            PREVIEW_ERROR_EVENT,
                            PreviewError {
                                message: message.clone(),
                            },
                        );
                        if let Some(tx) = ready.take() {
                            let _ = tx.send(Err(AppError::Recording(message)));
                        }
                        return;
                    }
                }
                // Back off (scaled by how many zero-frame restarts we've burned),
                // then loop to re-negotiate from the top of the matrix.
                tokio::time::sleep(stall_restart_backoff(zero_frame_restarts)).await;
            }
        }
    }
}

/// The result of one full matrix walk inside [`run_preview`].
enum MatrixWalk {
    /// The walk reached a terminal state: the stream ended cleanly, a permission
    /// error was surfaced, or every mode failed (error already emitted). Stop.
    Done,
    /// The live stream stalled mid-flight; the caller should restart from the top.
    Stalled { delivered_frame: bool },
}

/// One full pass over the platform's capture-mode matrix. Returns [`MatrixWalk`]
/// so [`run_preview`] can either stop or restart on a stall. Each attempt inside
/// uses a fresh ffmpeg child and a fresh [`MjpegFrameSplitter`].
async fn run_matrix_walk(
    app: &AppHandle,
    platform: Platform,
    device_token: &str,
    output_fps: u32,
    modes: &[(u32, Option<String>)],
    attempt_timeout: Duration,
    ready: &mut Option<tokio::sync::oneshot::Sender<AppResult<()>>>,
) -> MatrixWalk {
    let mut last_err: Option<&'static str> = None;

    for (input_fps, size) in modes {
        let args = build_preview_args(
            platform,
            Some(device_token),
            output_fps,
            *input_fps,
            size.as_deref(),
        );
        match attempt_preview_mode(app, &args, attempt_timeout, ready).await {
            AttemptOutcome::Streamed => return MatrixWalk::Done, // a mode worked; done.
            AttemptOutcome::Stalled { delivered_frame } => {
                // The live stream stalled — hand back up so the whole preview
                // restarts with a fresh child/splitter, NOT the next matrix mode.
                return MatrixWalk::Stalled { delivered_frame };
            }
            AttemptOutcome::Fatal(msg) => {
                // Permission denied — no mode will help. Surface and stop.
                let _ = app.emit(
                    PREVIEW_ERROR_EVENT,
                    PreviewError {
                        message: msg.into(),
                    },
                );
                if let Some(tx) = ready.take() {
                    let _ = tx.send(Err(AppError::Recording(msg.into())));
                }
                return MatrixWalk::Done;
            }
            AttemptOutcome::NoFrame { last_err: e } => {
                if e.is_some() {
                    last_err = e;
                }
                // Try the next mode.
            }
        }
    }

    // Every mode failed. Surface the REAL classified last error if we captured
    // one, else a generic "no stream" message — never a blank dead preview.
    let message = last_err
        .unwrap_or("Ingen videostrøm fra kameraet. Sjekk tilkobling og tilgang.")
        .to_string();
    tracing::warn!("preview: all capture modes failed ({message})");
    let _ = app.emit(
        PREVIEW_ERROR_EVENT,
        PreviewError {
            message: message.clone(),
        },
    );
    if let Some(tx) = ready.take() {
        let _ = tx.send(Err(AppError::Recording(message)));
    }
    MatrixWalk::Done
}

/// Aborts the held task when dropped — stops the preview emit task on any of
/// [`attempt_preview_mode`]'s many exit points without threading an explicit abort
/// through each `return`.
struct AbortOnDrop(tauri::async_runtime::JoinHandle<()>);
impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// One capture-mode attempt: spawn ffmpeg with `args`, wait up to `attempt_timeout`
/// for the first frame, and — if it arrives — signal `ready` Ok (once) and pump
/// frames to the renderer until the stream ends.
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real camera; see the module header.
async fn attempt_preview_mode(
    app: &AppHandle,
    args: &[String],
    attempt_timeout: Duration,
    ready: &mut Option<tokio::sync::oneshot::Sender<AppResult<()>>>,
) -> AttemptOutcome {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    // `child` stays owned for this attempt; dropping it (on return) drops the
    // child and `kill_on_drop` fires, so a failed mode leaves no orphan ffmpeg.
    let mut child = match spawn_ffmpeg(&arg_refs).await {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("preview: ffmpeg spawn failed: {e}");
            return AttemptOutcome::NoFrame { last_err: None };
        }
    };

    let Some(mut stdout) = child.stdout.take() else {
        return AttemptOutcome::NoFrame { last_err: None };
    };

    // Drain stderr in the background so we can (a) classify a fatal/retry-eligible
    // camera error and (b) not let a full stderr pipe stall ffmpeg. The first
    // classified error of each severity wins; we forward it back so the reader
    // loop can short-circuit (permission) or remember it (retry-eligible).
    let (err_tx, mut err_rx) = tokio::sync::mpsc::channel::<(&'static str, bool)>(2);
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!(target: "preview_ffmpeg", "{line}");
                if let Some(msg) = classify_camera_error(&line) {
                    let fatal = is_fatal_camera_error(msg);
                    // Best-effort: a full/closed channel means an error already won.
                    let _ = err_tx.try_send((msg, fatal));
                }
            }
        });
    }

    // DECOUPLE the emit from the stdout read. Emitting each frame synchronously in
    // the read loop meant a slow/busy webview back-pressured the `pipe:1` — the
    // macOS pipe buffer (~64 KB ≈ 6 frames) fills, ffmpeg BLOCKS on write, no new
    // frames arrive, and the 3 s stall watchdog restarts the whole preview: the
    // visible stutter. Now the read loop just drops the latest frame into this
    // `watch` slot (instant, non-blocking) and a separate task emits it — DROPPING
    // intermediate frames under load, exactly how a live preview should behave
    // (never block the source). So the read loop always keeps the pipe drained and
    // ffmpeg flows smoothly.
    let (frame_tx, frame_rx) = tokio::sync::watch::channel::<Option<PreviewFrame>>(None);
    let emit_app = app.clone();
    let emit_task = tauri::async_runtime::spawn(async move {
        let mut rx = frame_rx;
        while rx.changed().await.is_ok() {
            let latest = rx.borrow_and_update().clone();
            if let Some(f) = latest {
                if emit_app.emit(PREVIEW_EVENT, f).is_err() {
                    break; // window/listener gone
                }
            }
        }
    });
    // Abort the emit task on every exit (its `watch` sender drops too, but this is
    // immediate and tidy).
    let _emit_guard = AbortOnDrop(emit_task);

    let b64 = base64::engine::general_purpose::STANDARD;
    // A FRESH splitter per attempt (and therefore per restart, since each restart
    // is a fresh `attempt_preview_mode` call): stale partial bytes from a stalled
    // stream can never carry over and concatenate into a doubled/garbled frame.
    let mut splitter = MjpegFrameSplitter::new();
    let mut read_buf = vec![0u8; 64 * 1024];
    let mut seq: u64 = 0;
    let mut last_err: Option<&'static str> = None;
    // The per-attempt first-frame deadline. Disarmed (`None`) once the first frame
    // lands; from then on the stream is live and we pump until it ends.
    let mut first_frame_deadline = Some(Box::pin(tokio::time::sleep(attempt_timeout)));
    // The ONGOING stall watchdog, armed only while streaming (after the first
    // frame). Reset on every delivered frame; if it ever fires the camera went
    // quiet (idled/slept) and we bail to `Stalled` so the preview restarts with a
    // fresh child/splitter instead of sitting on a frozen image.
    let mut stall_deadline = Box::pin(tokio::time::sleep(STREAM_STALL_TIMEOUT));
    // When the last frame was emitted, so the stall decision can be re-derived from
    // the elapsed gap via the pure `should_restart_after_stall` helper (rather than
    // trusting the timer alone). Set on the first frame.
    let mut last_frame_at: Option<tokio::time::Instant> = None;
    // Frames delivered THIS attempt — drives the quiet-restart vs count-toward-
    // give-up decision when a stall fires, and feeds the pure stall helper.
    let mut frames_seen: u64 = 0;

    loop {
        let n = tokio::select! {
            // A classified stderr error. Permission → fatal, short-circuit the
            // whole matrix. Otherwise remember it and let the deadline/exit decide
            // (so a benign-looking line doesn't abort a mode that's still warming).
            Some((msg, fatal)) = err_rx.recv() => {
                if fatal {
                    return AttemptOutcome::Fatal(msg);
                }
                last_err = Some(msg);
                continue;
            }
            // No first frame within the deadline: this mode is dead. Try the next.
            () = async { first_frame_deadline.as_mut().unwrap().as_mut().await },
                if first_frame_deadline.is_some() =>
            {
                tracing::warn!("preview: no frame within {attempt_timeout:?} for this mode");
                return AttemptOutcome::NoFrame { last_err };
            }
            // The stream went quiet for STREAM_STALL_TIMEOUT while live: the camera
            // stalled/slept. Bail so the whole preview restarts (re-negotiates) with
            // a fresh child + splitter, rather than leaving a frozen/garbled image.
            // Only armed once streaming (first_frame_deadline disarmed).
            () = &mut stall_deadline, if first_frame_deadline.is_none() => {
                let ms_since = last_frame_at
                    .map_or(0, |t| t.elapsed().as_millis() as u64);
                // Confirm via the pure decision before bailing (defends against a
                // spurious early wake of the timer).
                if should_restart_after_stall(ms_since, frames_seen) {
                    tracing::warn!(
                        "preview: live stream stalled (no frame for {ms_since}ms); restarting"
                    );
                    return AttemptOutcome::Stalled {
                        delivered_frame: frames_seen > 0,
                    };
                }
                // Not actually past the threshold yet — re-arm for the remainder.
                stall_deadline
                    .as_mut()
                    .reset(tokio::time::Instant::now() + STREAM_STALL_TIMEOUT);
                continue;
            }
            read = stdout.read(&mut read_buf) => match read {
                // ffmpeg closed stdout. If we already delivered a frame (deadline
                // disarmed), the live stream simply ended (stop/unplug) → done.
                // If not, this mode never produced a frame → try the next.
                Ok(0) if first_frame_deadline.is_none() => return AttemptOutcome::Streamed,
                Ok(0) => return AttemptOutcome::NoFrame { last_err },
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("preview stdout read error: {e}");
                    if first_frame_deadline.is_none() {
                        return AttemptOutcome::Streamed;
                    }
                    return AttemptOutcome::NoFrame { last_err };
                }
            },
        };

        for frame in splitter.push(&read_buf[..n]) {
            let (width, height) = match read_jpeg_dimensions(&frame) {
                Some((w, h)) => (Some(w), Some(h)),
                None => (None, None),
            };
            seq += 1;
            frames_seen += 1;
            // First frame in: we're live. Disarm the deadline and signal Ok once.
            if first_frame_deadline.is_some() {
                first_frame_deadline = None;
                if let Some(tx) = ready.take() {
                    let _ = tx.send(Ok(()));
                }
            }
            // Re-arm the stall watchdog: a frame just arrived, so the clock to the
            // next-frame stall restarts from now.
            let now = tokio::time::Instant::now();
            last_frame_at = Some(now);
            stall_deadline.as_mut().reset(now + STREAM_STALL_TIMEOUT);
            let payload = PreviewFrame {
                data: b64.encode(&frame),
                width,
                height,
                seq,
            };
            // Hand to the emit task (instant, coalescing — drops stale frames so a
            // slow webview never back-pressures the pipe). A closed channel means
            // the emit task ended (window gone) → end the stream.
            if frame_tx.send(Some(payload)).is_err() {
                return AttemptOutcome::Streamed;
            }
        }
    }
    // Unreachable: every loop exit is an explicit `return`. `child` drops on
    // return → `kill_on_drop` ensures ffmpeg is gone.
}

#[cfg(test)]
mod tests {
    use super::*;

    use sundayrec_core::device_match::FfmpegDevice;

    #[test]
    fn mac_args_capture_video_only_to_mjpeg_stdout() {
        // output_fps=15, input mode = 1280x720@30 (the first matrix entry).
        let args = build_preview_args(Platform::MacOS, Some("1"), 15, 30, Some("1280x720"));
        assert!(args.windows(2).any(|w| w == ["-f", "avfoundation"]));
        // The INPUT requests the mode's framerate + size (avfoundation rejects a
        // bare framerate without a paired video size → "Input/output error").
        assert!(args.windows(2).any(|w| w == ["-framerate", "30"]));
        assert!(args.windows(2).any(|w| w == ["-video_size", "1280x720"]));
        // The OUTPUT is throttled to the low preview rate with `-r`.
        assert!(args.windows(2).any(|w| w == ["-r", "15"]));
        // video-only input: "<device>:none"
        assert!(args.iter().any(|a| a == "1:none"));
        // MJPEG to stdout, downscaled to a light preview payload.
        assert!(args.windows(2).any(|w| w == ["-vf", "scale=640:-2"]));
        assert!(args.windows(2).any(|w| w == ["-f", "mjpeg"]));
        assert_eq!(args.last().unwrap(), "pipe:1");
    }

    #[test]
    fn preview_output_is_downscaled_on_every_platform() {
        // The OUTPUT scale filter shrinks the base64/IPC payload ~4× regardless of
        // the (large) INPUT capture size; it must be present on every platform.
        let mac = build_preview_args(Platform::MacOS, Some("0"), 15, 30, Some("1280x720"));
        assert!(mac.windows(2).any(|w| w == ["-vf", "scale=640:-2"]));
        let win = build_preview_args(Platform::Windows, Some("Cam"), 15, 30, None);
        assert!(win.windows(2).any(|w| w == ["-vf", "scale=640:-2"]));
        let linux = build_preview_args(Platform::Linux, None, 15, 30, None);
        assert!(linux.windows(2).any(|w| w == ["-vf", "scale=640:-2"]));
    }

    #[test]
    fn bare_framerate_fallback_input_has_no_video_size_but_output_is_scaled() {
        // The escape-hatch INPUT must NOT pin a `-video_size` (that's what lets a
        // picky camera open), but the OUTPUT is still downscaled. The two must not
        // be confused: `-video_size` absent on input, `scale=640:-2` present on
        // output.
        let args = build_preview_args(Platform::MacOS, Some("0"), 15, 30, None);
        assert!(
            !args.iter().any(|a| a == "-video_size"),
            "bare-framerate fallback must not pin an input video size"
        );
        assert!(
            args.windows(2).any(|w| w == ["-vf", "scale=640:-2"]),
            "output must still be downscaled"
        );
    }

    #[test]
    fn mac_args_default_device_is_zero() {
        let args = build_preview_args(Platform::MacOS, None, 15, 30, Some("1280x720"));
        assert!(args.iter().any(|a| a == "0:none"));
    }

    #[test]
    fn mac_args_each_sized_mode_emits_its_size_and_framerate() {
        // Every (Some(size), fps) mode must emit BOTH `-video_size {size}` and
        // `-framerate {fps}` on the input.
        for &(size, fps) in MAC_PREVIEW_MODES {
            let args = build_preview_args(Platform::MacOS, Some("0"), 15, fps, size);
            assert!(
                args.windows(2)
                    .any(|w| w == ["-framerate", &fps.to_string()]),
                "mode {size:?}@{fps} must emit its input framerate"
            );
            match size {
                Some(s) => assert!(
                    args.windows(2).any(|w| w == ["-video_size", s]),
                    "sized mode {s} must emit -video_size {s}"
                ),
                None => assert!(
                    !args.iter().any(|a| a == "-video_size"),
                    "the (None) escape-hatch mode must NOT emit -video_size"
                ),
            }
        }
    }

    #[test]
    fn mac_args_none_size_fallback_omits_video_size() {
        // The escape-hatch mode: bare -framerate, no -video_size, for devices that
        // reject every explicit size.
        let args = build_preview_args(Platform::MacOS, Some("0"), 15, 30, None);
        assert!(args.windows(2).any(|w| w == ["-framerate", "30"]));
        assert!(
            !args.iter().any(|a| a == "-video_size"),
            "None size must not pin a video size"
        );
    }

    #[test]
    fn mac_preview_modes_matrix_is_well_formed() {
        assert!(!MAC_PREVIEW_MODES.is_empty(), "matrix must be non-empty");
        // The last entry is the bare-framerate escape hatch (no video size).
        assert_eq!(
            MAC_PREVIEW_MODES.last().unwrap().0,
            None,
            "the last mode must have None size (the escape hatch)"
        );
    }

    #[test]
    fn windows_args_use_dshow_named_device_with_rtbufsize() {
        let args = build_preview_args(Platform::Windows, Some("Logitech BRIO"), 30, 30, None);
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

    fn cam(name: &str, index: Option<u32>) -> FfmpegDevice {
        FfmpegDevice::new(name, "avfoundation", index)
    }

    #[test]
    fn decide_none_or_empty_request_is_default_index() {
        // No request and an empty request both mean "the default camera" → "0",
        // a legitimate default, NOT a failure.
        assert_eq!(
            decide_resolved_device(None, None),
            ResolvedDevice::Index("0".into())
        );
        assert_eq!(
            decide_resolved_device(Some(""), None),
            ResolvedDevice::Index("0".into())
        );
    }

    #[test]
    fn decide_numeric_index_passthrough() {
        // A pure index is already what avfoundation accepts — verbatim, no list
        // consulted (pass `None` to prove enumeration isn't required).
        assert_eq!(
            decide_resolved_device(Some("0"), None),
            ResolvedDevice::Index("0".into())
        );
        assert_eq!(
            decide_resolved_device(Some("2"), None),
            ResolvedDevice::Index("2".into())
        );
    }

    #[test]
    fn decide_matching_name_resolves_to_index() {
        let devices = vec![
            cam("FaceTime HD Camera", Some(0)),
            cam("Logitech BRIO", Some(1)),
        ];
        assert_eq!(
            decide_resolved_device(Some("FaceTime HD Camera"), Some(&devices)),
            ResolvedDevice::Index("0".into())
        );
        assert_eq!(
            decide_resolved_device(Some("Logitech BRIO"), Some(&devices)),
            ResolvedDevice::Index("1".into())
        );
    }

    #[test]
    fn decide_non_matching_specific_name_is_no_match_not_index_zero() {
        // The trust change: a specific camera that no longer matches must NOT
        // silently become the default index "0".
        let devices = vec![cam("FaceTime HD Camera", Some(0))];
        assert_eq!(
            decide_resolved_device(Some("Blackmagic UltraStudio"), Some(&devices)),
            ResolvedDevice::NoMatch("Blackmagic UltraStudio".into())
        );
    }

    #[test]
    fn decide_enumeration_failure_for_specific_name_is_enum_failed() {
        // A specific name + a failed enumeration (`None`) → EnumFailed, not "0".
        assert_eq!(
            decide_resolved_device(Some("FaceTime HD Camera"), None),
            ResolvedDevice::EnumFailed
        );
    }

    #[tokio::test]
    async fn resolve_passes_through_none() {
        assert_eq!(
            resolve_preview_device(None).await,
            ResolvedDevice::Index("0".into())
        );
    }

    #[tokio::test]
    async fn resolve_passes_through_numeric_index_without_enumerating() {
        // A pure index is already what avfoundation accepts — must be returned
        // verbatim and must NOT touch ffmpeg enumeration.
        assert_eq!(
            resolve_preview_device(Some("0".into())).await,
            ResolvedDevice::Index("0".into())
        );
        assert_eq!(
            resolve_preview_device(Some("2".into())).await,
            ResolvedDevice::Index("2".into())
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

    #[test]
    fn classify_camera_error_flags_camera_in_use_distinctly() {
        // A camera held by another app gets its OWN actionable message…
        let busy = classify_camera_error("[avfoundation] device is in use by another process")
            .expect("in-use line classifies");
        assert!(busy.contains("i bruk"), "in-use message: {busy}");
        assert!(
            classify_camera_error("AVCaptureSessionRuntimeError -11804").is_some(),
            "the AVFoundation already-used OSStatus is recognised"
        );
        // …and it's distinct from the generic not-found message.
        let notfound = classify_camera_error("Could not open video device").unwrap();
        assert_ne!(busy, notfound);
    }

    #[test]
    fn fatal_covers_permission_and_in_use_but_not_open_errors() {
        let perm = classify_camera_error("permission to capture video was denied").unwrap();
        let busy = classify_camera_error("camera already in use").unwrap();
        let open = classify_camera_error("Input/output error").unwrap();
        assert!(is_fatal_camera_error(perm), "permission short-circuits");
        assert!(is_fatal_camera_error(busy), "in-use short-circuits");
        assert!(
            !is_fatal_camera_error(open),
            "a plain open error stays retry-eligible so the matrix tries the next mode"
        );
    }

    #[test]
    fn mac_mode_matrix_includes_pal_and_native_escape_hatches() {
        // PAL (25 fps) sized modes AND bare-framerate escape hatches at both 30
        // and 25 must be present — a European HDMI grabber that only advertises
        // 25 fps would otherwise never negotiate.
        assert!(MAC_PREVIEW_MODES.contains(&(Some("1920x1080"), 25)));
        assert!(MAC_PREVIEW_MODES.contains(&(None, 30)));
        assert!(
            MAC_PREVIEW_MODES.contains(&(None, 25)),
            "a PAL-only grabber needs a bare-framerate 25 fallback"
        );
    }

    #[test]
    fn permission_error_is_fatal_open_error_is_retry_eligible() {
        // A permission/access stderr line → the fatal variant: retrying capture
        // modes can't grant access, so it must short-circuit the matrix.
        let perm = classify_camera_error("permission to capture video was denied").unwrap();
        assert!(is_permission_fatal(perm), "permission error must be fatal");

        // An open/format error → retry-eligible (a different mode might succeed).
        let open = classify_camera_error("Error opening input: Input/output error").unwrap();
        assert!(
            !is_permission_fatal(open),
            "open/format error must be retry-eligible"
        );
    }

    #[test]
    fn stall_watchdog_restarts_only_after_threshold_and_while_streaming() {
        let threshold = STREAM_STALL_TIMEOUT.as_millis() as u64;

        // Before the first frame (frames_seen == 0) the first-frame deadline owns
        // the decision, NOT the stall watchdog — never restart, however long.
        assert!(!should_restart_after_stall(threshold + 5_000, 0));

        // Streaming, but the gap is still under the threshold → a merely slow
        // camera, not a stall. Don't restart (no false positives).
        assert!(!should_restart_after_stall(threshold - 1, 10));

        // Streaming AND quiet past the threshold → the camera stalled/slept.
        assert!(should_restart_after_stall(threshold, 10));
        assert!(should_restart_after_stall(threshold + 2_000, 1));
    }

    #[test]
    fn stall_give_up_only_after_max_consecutive_zero_frame_restarts() {
        // A stall after frames flowed resets the counter to 0 (the normal "woke up"
        // case) — must never give up.
        assert!(!should_give_up_after_stalls(0));
        // Below the cap → keep restarting.
        assert!(!should_give_up_after_stalls(MAX_STALL_RESTARTS - 1));
        // At/over the cap → a genuinely-gone camera; give up instead of spinning.
        assert!(should_give_up_after_stalls(MAX_STALL_RESTARTS));
        assert!(should_give_up_after_stalls(MAX_STALL_RESTARTS + 3));
    }

    #[test]
    fn stall_restart_backoff_grows_then_caps() {
        // The "camera woke up" restart (counter reset to 0) is near-instant.
        assert_eq!(stall_restart_backoff(0), Duration::from_millis(150));
        // Each consecutive zero-frame restart doubles the wait so a dead camera
        // doesn't busy-spin ffmpeg spawns…
        assert_eq!(stall_restart_backoff(1), Duration::from_millis(300));
        assert_eq!(stall_restart_backoff(2), Duration::from_millis(600));
        assert_eq!(stall_restart_backoff(3), Duration::from_millis(1200));
        // …and the shift caps so the backoff can't grow without bound.
        assert_eq!(stall_restart_backoff(4), stall_restart_backoff(3));
        assert_eq!(stall_restart_backoff(99), stall_restart_backoff(3));
    }

    #[test]
    fn preview_modes_macos_is_the_full_matrix_other_platforms_single() {
        // macOS walks the whole negotiation matrix.
        let mac = preview_modes_for(Platform::MacOS, 15);
        assert_eq!(mac.len(), MAC_PREVIEW_MODES.len());
        // Other platforms make exactly one attempt at the requested rate.
        assert_eq!(preview_modes_for(Platform::Windows, 15), vec![(15, None)]);
        assert_eq!(preview_modes_for(Platform::Linux, 20), vec![(20, None)]);
    }
}
