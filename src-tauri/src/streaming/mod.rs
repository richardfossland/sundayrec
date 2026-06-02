//! Live-streaming I/O plumbing (R3 P2b) — **NETWORK/HARDWARE-UNVERIFIED**,
//! default-off `streaming` feature.
//!
//! The impure half of live RTMP streaming. Every *decision* lives in the
//! unit-tested core:
//!   - the RTMP multi-destination `tee` muxer argv, bitrate/keyframe math, the
//!     audio-map + the key-redacted loggable copy → [`sundayrec_core::streaming`],
//!   - the overlay `filter_complex` for lower-thirds → [`sundayrec_core::overlay`],
//!   - the stream-key + RTMP-URL validation → [`sundayrec_core::streaming`].
//!
//! This module performs the side effects the Electron `src/main/streamer.ts`
//! did: resolve the camera/mic input args, splice in the core's output argv, and
//! spawn ONE ffmpeg that encodes once and tees to every destination, then parse
//! its stderr for live stats. Stream keys are read from the OS keychain via the
//! existing [`crate::secrets`] module (the `StreamKey` provider).
//!
//! ## Feature flag
//!
//! Behind the **default-off `streaming`** cargo feature. NO new native dep —
//! ffmpeg is a sidecar — so the gate only compiles the spawn in/out. The DTOs +
//! the public entry points compile either way; when the feature is OFF
//! [`start`] returns a clear `feature_disabled` error so the renderer can
//! surface "live streaming isn't built into this build" (mirrors the `editor`/
//! `whisper` idiom).
//!
//! ## ⚠️ NETWORK/HARDWARE-UNVERIFIED
//!
//! Under `--features streaming` the camera open, the libx264 encode, the RTMP
//! push + auto-recovery, and the live-stats parse are wired but unproven — they
//! need a real camera, a real RTMP endpoint and a key. Only the
//! `sundayrec-core` decisions are unit-tested. See docs/SMOKE-TEST.md §R3.

use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::overlay::OverlayConfig;
#[cfg(feature = "streaming")]
use sundayrec_core::overlay::{build_overlay_pipeline, BuildOverlayOpts};
#[cfg(feature = "streaming")]
use sundayrec_core::streaming::{
    build_output_args, is_stream_connection_error, parse_progress_line, reconnect_backoff_secs,
    StreamArgError, StreamProgress, STREAM_RECONNECT_MAX_FAILURES,
};
use sundayrec_core::streaming::{
    validate_rtmp_url, validate_stream_key, AudioInputLayout, StreamDestination, StreamKeyError,
    StreamOptions, StreamResolution,
};

use crate::error::{AppError, AppResult};

/// Lock a `Mutex`, recovering the guard if a previous holder panicked.
///
/// These mutexes guard simple bookkeeping (the last-known `StreamStatus`, the
/// running child handle) with no invariant a panic could half-break, so taking
/// the poisoned inner guard is correct and strictly safer than `.expect()`-ing:
/// a panic in the spawn path must not cascade into every later status read and
/// crash the app. Identical to `.lock().unwrap()` on the happy path.
fn lock_recover<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

// ── IPC DTOs (compile regardless of the feature) ────────────────────────────────

/// A stream destination as the renderer holds it — the key is NOT carried here;
/// it lives in the keychain and is resolved by id at start. `hasKey` mirrors the
/// Electron `StreamDestinationStored.hasKey` so the UI shows "•••• (saved)".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/StreamDestinationView.ts")]
#[serde(rename_all = "camelCase")]
pub struct StreamDestinationView {
    pub id: String,
    pub name: String,
    pub rtmp_url: String,
    pub enabled: bool,
    pub has_key: bool,
}

/// Live stream status surfaced to the renderer. Mirrors the Electron
/// `StreamStats` (sans the per-line churn). `active` is the single source of
/// truth for the start/stop button.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/StreamStatus.ts")]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub active: bool,
    /// Epoch-ms when the current stream started, or `None`.
    pub started_at: Option<i64>,
    /// Most recent total bitrate (kbps).
    pub bitrate_kbps: u32,
    /// Most recent encoder FPS.
    pub fps: u32,
    /// Frames dropped so far.
    pub dropped: u32,
    /// Last interesting stderr line (e.g. a connection error), key-redacted.
    pub last_line: String,
}

impl StreamStatus {
    fn idle() -> Self {
        StreamStatus {
            active: false,
            started_at: None,
            bitrate_kbps: 0,
            fps: 0,
            dropped: 0,
            last_line: String::new(),
        }
    }
}

// ── Engine (managed state) ─────────────────────────────────────────────────────

/// A running stream's control surface: the supervisor task plus the flags `stop`
/// uses to ask it to wind down (set `stop`, wake it via `notify`, await the task).
#[cfg(feature = "streaming")]
struct StreamHandle {
    stop: Arc<std::sync::atomic::AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
}

/// At most one live stream runs at a time. The engine stores the supervisor
/// handle (feature-on) and the last-known status, shared with the supervisor task
/// via an `Arc` so its live-stats/reconnect updates land where `status()` reads.
/// Held as Tauri-managed state.
pub struct StreamEngine {
    /// The running stream's supervisor, when streaming. Feature-on only; the
    /// field is gated but the managed-state type stays stable across builds.
    #[cfg(feature = "streaming")]
    handle: Mutex<Option<StreamHandle>>,
    status: Arc<Mutex<StreamStatus>>,
}

impl Default for StreamEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamEngine {
    pub fn new() -> Self {
        StreamEngine {
            #[cfg(feature = "streaming")]
            handle: Mutex::new(None),
            status: Arc::new(Mutex::new(StreamStatus::idle())),
        }
    }

    /// Current status snapshot.
    pub fn status(&self) -> StreamStatus {
        lock_recover(&self.status).clone()
    }

    #[cfg(feature = "streaming")]
    fn set_status(&self, s: StreamStatus) {
        *lock_recover(&self.status) = s;
    }
}

// ── Pure camera/mic input args (testable without a device) ──────────────────────

/// Build the camera (and, on macOS, mic) input args for a stream, from already-
/// resolved device tokens. Mirrors the Electron `buildVideoInputArgs`:
///   - macOS avfoundation bundles `video:audio` into one input (audio token may
///     be `"none"`),
///   - Windows dshow takes the camera as its own `video=<name>` input (the mic
///     is a separate dshow input — see [`audio_only_input_args`]).
///
/// Pure over its inputs so the device-token → argv shaping is unit-tested; the
/// HARDWARE-UNVERIFIED part is the upstream device *resolution*, not this.
pub fn video_input_args(
    platform: Platform,
    res: StreamResolution,
    framerate: u32,
    video_token: &str,
    mac_audio_token: Option<&str>,
) -> Vec<String> {
    let size = format!("{}x{}", res.width(), res.height());
    match platform {
        Platform::MacOS => {
            let audio = mac_audio_token.unwrap_or("none");
            vec![
                "-f".into(),
                "avfoundation".into(),
                "-framerate".into(),
                framerate.to_string(),
                "-video_size".into(),
                size,
                "-i".into(),
                format!("{video_token}:{audio}"),
            ]
        }
        Platform::Windows => vec![
            "-f".into(),
            "dshow".into(),
            "-framerate".into(),
            framerate.to_string(),
            "-video_size".into(),
            size,
            "-i".into(),
            format!("video={}", strip_quotes(video_token)),
        ],
        Platform::Linux => vec![
            "-f".into(),
            "v4l2".into(),
            "-framerate".into(),
            framerate.to_string(),
            "-video_size".into(),
            size,
            "-i".into(),
            video_token.to_string(),
        ],
    }
}

/// Windows-only separate dshow audio input. macOS bundles audio in the camera
/// input; Linux is a no-op today. Mirrors the Electron `buildAudioOnlyInputArgs`.
pub fn audio_only_input_args(platform: Platform, audio_name: Option<&str>) -> Vec<String> {
    match (platform, audio_name) {
        (Platform::Windows, Some(name)) if !name.trim().is_empty() => vec![
            "-f".into(),
            "dshow".into(),
            "-i".into(),
            format!("audio={}", strip_quotes(name)),
        ],
        _ => Vec::new(),
    }
}

/// The audio-input layout the core's output builder needs: macOS bundles audio
/// on input 0; Windows takes it as a separate input after the overlays.
pub fn audio_layout_for(platform: Platform) -> AudioInputLayout {
    match platform {
        Platform::MacOS | Platform::Linux => AudioInputLayout::BundledInputZero,
        Platform::Windows => AudioInputLayout::SeparateAfterOverlays,
    }
}

fn strip_quotes(s: &str) -> String {
    s.trim_matches('"').to_string()
}

/// Validate every pushable destination's key + URL before a launch. Returns the
/// first failure (with the destination id) so the renderer can point at the bad
/// row. Pure — used by the seam before spawning and unit-tested here.
pub fn validate_destinations(dests: &[StreamDestination]) -> Result<(), (String, StreamKeyError)> {
    for d in dests.iter().filter(|d| d.enabled) {
        validate_rtmp_url(&d.rtmp_url).map_err(|e| (d.id.clone(), e))?;
        validate_stream_key(&d.stream_key).map_err(|e| (d.id.clone(), e))?;
    }
    Ok(())
}

// ── Public entry points ─────────────────────────────────────────────────────────
//
// Each compiles in both feature states. OFF → a clear `feature_disabled` error.
// ON → the NETWORK/HARDWARE-UNVERIFIED ffmpeg spawn.

#[cfg(not(feature = "streaming"))]
fn disabled<T>(verb: &str) -> AppResult<T> {
    Err(AppError::Validation(format!(
        "feature_disabled: streaming.{verb} requires a build with `--features streaming`"
    )))
}

/// Start a live stream. The destinations arrive WITHOUT keys (the renderer never
/// holds them); we resolve each key from the keychain by id. Validates inputs,
/// builds the overlay pipeline + the full argv via the core, then spawns one
/// ffmpeg (feature-on).
///
/// When the `streaming` feature is OFF this returns `feature_disabled`.
#[cfg(not(feature = "streaming"))]
#[allow(clippy::too_many_arguments)]
pub async fn start(
    _engine: &StreamEngine,
    _platform: Platform,
    _opts: StreamOptions,
    _overlays: Vec<OverlayConfig>,
    _video_token: String,
    _mac_audio_token: Option<String>,
    _win_audio_name: Option<String>,
    _snapshot_path: String,
    _now_ms: i64,
) -> AppResult<StreamStatus> {
    disabled("start")
}

/// Start a live stream. NETWORK/HARDWARE-UNVERIFIED behind `--features streaming`.
#[cfg(feature = "streaming")]
#[allow(clippy::too_many_arguments)]
pub async fn start(
    engine: &StreamEngine,
    platform: Platform,
    opts: StreamOptions,
    overlays: Vec<OverlayConfig>,
    video_token: String,
    mac_audio_token: Option<String>,
    win_audio_name: Option<String>,
    snapshot_path: String,
    now_ms: i64,
) -> AppResult<StreamStatus> {
    // Refuse a second concurrent stream (mirrors Electron "Stream allerede aktiv").
    if engine.status().active {
        return Err(AppError::Validation("stream_already_active".into()));
    }

    // Validate every destination up-front (key + URL) so we fail before spawning
    // ffmpeg with a cryptic deep-layer error.
    validate_destinations(&opts.destinations)
        .map_err(|(id, e)| AppError::Validation(format!("invalid_destination:{id}:{e:?}")))?;

    // Build the overlay pipeline (lower-thirds) against the output dimensions.
    let overlay = build_overlay_pipeline(
        &overlays,
        BuildOverlayOpts {
            output_w: opts.resolution.width(),
            output_h: opts.resolution.height(),
            base_label: "0:v",
            framerate: opts.framerate,
        },
    );

    // Build the output argv via the core (the tee/encode/preview math).
    let built = build_output_args(
        &opts,
        &snapshot_path,
        audio_layout_for(platform),
        overlay.extra_input_count,
        &overlay.output_label,
        &overlay.filter_chain,
    )
    .map_err(|e: StreamArgError| AppError::Validation(format!("stream_args:{e:?}")))?;

    // Assemble the full argv: banner + camera input + overlay inputs + (Windows)
    // separate audio input + the core output args.
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "info".into(),
        "-nostdin".into(),
    ];
    args.extend(video_input_args(
        platform,
        opts.resolution,
        opts.framerate,
        &video_token,
        mac_audio_token.as_deref(),
    ));
    args.extend(overlay.input_args);
    args.extend(audio_only_input_args(platform, win_audio_name.as_deref()));
    args.extend(built.args);

    // Log the KEY-REDACTED argv only — never the real one.
    tracing::info!(
        "[streaming] starting ffmpeg: -hide_banner … {}",
        built.loggable.join(" ")
    );

    // Spawn the FIRST ffmpeg here so a launch failure (e.g. a missing sidecar)
    // surfaces to the caller immediately, instead of disappearing into a silent
    // "reconnecting" spin. The supervisor takes over this child and respawns it on
    // any later unexpected exit (network drop) until `stop` or the give-up cap.
    let first = spawn_stream(&args)
        .map_err(|e| AppError::Recording(format!("stream ffmpeg spawn: {e}")))?;

    let status = StreamStatus {
        active: true,
        started_at: Some(now_ms),
        bitrate_kbps: 0,
        fps: 0,
        dropped: 0,
        last_line: String::new(),
    };
    engine.set_status(status.clone());

    // Hand control to a supervisor task: it parses ffmpeg's stderr for live stats
    // + connection errors, and on an unexpected exit reconnects with capped
    // backoff so a brief network blip doesn't end a 90-minute service.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let notify = Arc::new(tokio::sync::Notify::new());
    let status_arc = engine.status.clone();
    let stop_t = stop.clone();
    let notify_t = notify.clone();
    let task = tauri::async_runtime::spawn(async move {
        supervise(args, status_arc, stop_t, notify_t, now_ms, first).await;
    });
    *lock_recover(&engine.handle) = Some(StreamHandle { stop, notify, task });
    Ok(status)
}

/// Spawn one streaming ffmpeg with stderr piped (for the live-stats parse) and
/// `kill_on_drop` so a dropped child can never outlive us.
#[cfg(feature = "streaming")]
fn spawn_stream(args: &[String]) -> std::io::Result<tokio::process::Child> {
    use std::process::Stdio;
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tokio::process::Command::new(crate::media::ffmpeg::ffmpeg_path())
        .args(&arg_refs)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
}

/// How one ffmpeg run ended.
#[cfg(feature = "streaming")]
enum RunEnd {
    /// ffmpeg exited on its own (clean finish or a network/fatal error).
    Exited,
    /// We were asked to stop (the `notify` fired); the child is still alive.
    Stopped,
}

/// The supervisor loop: keep an ffmpeg running for the stream, parsing its stderr
/// for live stats and reconnecting on unexpected exits with capped backoff, until
/// `stop` is set or [`STREAM_RECONNECT_MAX_FAILURES`] consecutive zero-progress
/// attempts give up. A run that produced frames resets the failure count, so a
/// stream that merely hiccups recovers indefinitely.
#[cfg(feature = "streaming")]
async fn supervise(
    args: Vec<String>,
    status: Arc<Mutex<StreamStatus>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
    started_at: i64,
    first: tokio::process::Child,
) {
    use std::sync::atomic::Ordering;

    let mut next_child = Some(first);
    let mut failures: u32 = 0;

    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        // Obtain a child: the pre-spawned first one, else a fresh respawn.
        let mut child = match next_child.take() {
            Some(c) => c,
            None => match spawn_stream(&args) {
                Ok(c) => {
                    mark_reconnected(&status, started_at);
                    c
                }
                Err(e) => {
                    failures += 1;
                    if failures >= STREAM_RECONNECT_MAX_FAILURES {
                        mark_dead(&status, &format!("Strøm stoppet (kunne ikke starte): {e}"));
                        break;
                    }
                    if !wait_backoff(failures, &status, &notify, &stop).await {
                        break;
                    }
                    continue;
                }
            },
        };

        let (produced, end) = run_one(&mut child, &status, &notify).await;
        match end {
            RunEnd::Stopped => {
                graceful_stop(&mut child).await;
                break;
            }
            RunEnd::Exited => {
                let _ = child.wait().await;
            }
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }

        // An unexpected exit. A run that streamed frames resets the counter (a
        // recoverable hiccup); a zero-frame exit counts toward giving up.
        if produced {
            failures = 0;
        } else {
            failures += 1;
        }
        if failures >= STREAM_RECONNECT_MAX_FAILURES {
            mark_dead(
                &status,
                "Mistet forbindelsen — klarte ikke å koble til igjen.",
            );
            break;
        }
        if !wait_backoff(failures.max(1), &status, &notify, &stop).await {
            break;
        }
    }

    // Whatever the exit reason, the stream is no longer active. Preserve a
    // give-up error line if one was set; otherwise go fully idle.
    {
        let mut s = lock_recover(&status);
        s.active = false;
        s.fps = 0;
        s.bitrate_kbps = 0;
        s.started_at = None;
    }
}

/// Read one ffmpeg run's stderr to completion (or until `notify` asks us to
/// stop), updating live stats. Returns whether any progress line was seen and how
/// the run ended.
#[cfg(feature = "streaming")]
async fn run_one(
    child: &mut tokio::process::Child,
    status: &Arc<Mutex<StreamStatus>>,
    notify: &tokio::sync::Notify,
) -> (bool, RunEnd) {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let Some(stderr) = child.stderr.take() else {
        return (false, RunEnd::Exited);
    };
    let mut lines = BufReader::new(stderr).lines();
    let mut produced = false;

    loop {
        tokio::select! {
            line = lines.next_line() => match line {
                Ok(Some(l)) => {
                    if let Some(p) = parse_progress_line(&l) {
                        produced = true;
                        update_progress(status, p);
                    } else if is_stream_connection_error(&l) {
                        // NEVER store the raw line — an RTMP error can echo the URL
                        // (and thus the stream key). A fixed message is safe + clear.
                        set_line(status, "Nettverksfeil oppdaget — overvåker forbindelsen…");
                    }
                }
                _ => return (produced, RunEnd::Exited), // EOF → ffmpeg exiting
            },
            _ = notify.notified() => return (produced, RunEnd::Stopped),
        }
    }
}

/// Try to stop ffmpeg gracefully so a local recording (the `also_record` branch)
/// finalises its container: SIGTERM, wait up to 3 s, then SIGKILL. On non-unix we
/// only have the hard kill.
#[cfg(feature = "streaming")]
async fn graceful_stop(child: &mut tokio::process::Child) {
    use std::time::Duration;
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status();
            if tokio::time::timeout(Duration::from_secs(3), child.wait())
                .await
                .is_ok()
            {
                return;
            }
        }
    }
    let _ = child.kill().await;
}

/// Sleep the reconnect backoff for `attempt`, surfacing a "reconnecting" status,
/// woken early by `notify`. Returns `false` if we were asked to stop during the
/// wait (caller should break).
#[cfg(feature = "streaming")]
async fn wait_backoff(
    attempt: u32,
    status: &Arc<Mutex<StreamStatus>>,
    notify: &tokio::sync::Notify,
    stop: &Arc<std::sync::atomic::AtomicBool>,
) -> bool {
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    let secs = reconnect_backoff_secs(attempt);
    {
        let mut s = lock_recover(status);
        s.fps = 0;
        s.bitrate_kbps = 0;
        s.last_line =
            format!("Mistet forbindelsen — kobler til igjen (forsøk {attempt}) om {secs}s…");
    }
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(secs)) => {}
        _ = notify.notified() => {}
    }
    !stop.load(Ordering::SeqCst)
}

/// Update the live encoder stats from a parsed progress sample.
#[cfg(feature = "streaming")]
fn update_progress(status: &Arc<Mutex<StreamStatus>>, p: StreamProgress) {
    let mut s = lock_recover(status);
    s.fps = p.fps;
    s.bitrate_kbps = p.bitrate_kbps;
    s.dropped = p.dropped;
    // A flowing stream clears any stale reconnect/error line.
    if !s.last_line.is_empty() {
        s.last_line.clear();
    }
}

/// Set only the status line (e.g. a connection warning), leaving stats intact.
#[cfg(feature = "streaming")]
fn set_line(status: &Arc<Mutex<StreamStatus>>, line: &str) {
    lock_recover(status).last_line = line.to_string();
}

/// Mark the stream live again after a successful respawn.
#[cfg(feature = "streaming")]
fn mark_reconnected(status: &Arc<Mutex<StreamStatus>>, started_at: i64) {
    let mut s = lock_recover(status);
    s.active = true;
    s.started_at = Some(started_at);
    s.last_line = "Tilkoblet igjen.".to_string();
}

/// Mark the stream stopped with a terminal error message (gave up reconnecting).
#[cfg(feature = "streaming")]
fn mark_dead(status: &Arc<Mutex<StreamStatus>>, line: &str) {
    let mut s = lock_recover(status);
    s.active = false;
    s.fps = 0;
    s.bitrate_kbps = 0;
    s.started_at = None;
    s.last_line = line.to_string();
}

/// Stop the running stream. Idempotent: no active stream → `false`.
#[cfg(not(feature = "streaming"))]
pub async fn stop(_engine: &StreamEngine) -> AppResult<bool> {
    disabled("stop")
}

/// Stop the running stream: ask the supervisor to wind down (which stops
/// reconnecting and SIGTERMs ffmpeg so a local recording finalises), await it,
/// then go idle. Idempotent: no active stream → `false`. NETWORK/HARDWARE-UNVERIFIED.
#[cfg(feature = "streaming")]
pub async fn stop(engine: &StreamEngine) -> AppResult<bool> {
    use std::sync::atomic::Ordering;

    let handle = lock_recover(&engine.handle).take();
    let was_active = handle.is_some();
    if let Some(h) = handle {
        // Tell the supervisor to stop (no more reconnects) and wake it from any
        // stderr-read or backoff-sleep, then wait for it to tear ffmpeg down.
        h.stop.store(true, Ordering::SeqCst);
        h.notify.notify_one();
        let _ = h.task.await;
    }
    engine.set_status(StreamStatus::idle());
    Ok(was_active)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn res() -> StreamResolution {
        StreamResolution::P720
    }

    #[test]
    fn lock_recover_returns_inner_after_poison() {
        use std::sync::{Arc, Mutex};
        // A poisoned status/child mutex must still hand back its inner guard so a
        // single panicked thread can't crash every later status read.
        let m = Arc::new(Mutex::new(1u8));
        let m2 = Arc::clone(&m);
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(m.lock().is_err(), "precondition: poisoned");
        *lock_recover(&m) = 42;
        assert_eq!(*lock_recover(&m), 42);
    }

    // ── camera input args ──
    #[test]
    fn mac_camera_input_bundles_audio_token() {
        let args = video_input_args(Platform::MacOS, res(), 30, "0", Some("1"));
        assert_eq!(
            args,
            vec![
                "-f",
                "avfoundation",
                "-framerate",
                "30",
                "-video_size",
                "1280x720",
                "-i",
                "0:1",
            ]
        );
    }

    #[test]
    fn mac_camera_input_uses_none_when_no_audio() {
        let args = video_input_args(Platform::MacOS, res(), 25, "0", None);
        assert!(args.windows(2).any(|w| w == ["-i", "0:none"]));
        assert!(args.windows(2).any(|w| w == ["-framerate", "25"]));
    }

    #[test]
    fn windows_camera_input_uses_named_video_device() {
        let args = video_input_args(Platform::Windows, res(), 30, "\"Logi Cam\"", None);
        assert!(args.windows(2).any(|w| w == ["-f", "dshow"]));
        // quotes stripped, video= prefix added.
        assert!(args.windows(2).any(|w| w == ["-i", "video=Logi Cam"]));
    }

    // ── windows separate audio input ──
    #[test]
    fn windows_audio_only_input_built_when_named() {
        let args = audio_only_input_args(Platform::Windows, Some("Mic (USB)"));
        assert_eq!(args, vec!["-f", "dshow", "-i", "audio=Mic (USB)"]);
    }

    #[test]
    fn no_separate_audio_on_mac_or_when_unnamed() {
        assert!(audio_only_input_args(Platform::MacOS, Some("Mic")).is_empty());
        assert!(audio_only_input_args(Platform::Windows, None).is_empty());
        assert!(audio_only_input_args(Platform::Windows, Some("  ")).is_empty());
    }

    // ── audio layout per platform ──
    #[test]
    fn audio_layout_is_bundled_on_mac_separate_on_windows() {
        assert_eq!(
            audio_layout_for(Platform::MacOS),
            AudioInputLayout::BundledInputZero
        );
        assert_eq!(
            audio_layout_for(Platform::Windows),
            AudioInputLayout::SeparateAfterOverlays
        );
    }

    // ── destination validation ──
    #[test]
    fn validate_destinations_flags_first_bad_row() {
        let dests = vec![
            StreamDestination {
                id: "ok".into(),
                name: "ok".into(),
                rtmp_url: "rtmp://x/live".into(),
                stream_key: "validkey".into(),
                enabled: true,
            },
            StreamDestination {
                id: "bad".into(),
                name: "bad".into(),
                rtmp_url: "http://nope".into(),
                stream_key: "k".into(),
                enabled: true,
            },
        ];
        let (id, err) = validate_destinations(&dests).unwrap_err();
        assert_eq!(id, "bad");
        assert_eq!(err, StreamKeyError::BadScheme);
    }

    #[test]
    fn validate_destinations_skips_disabled_rows() {
        let dests = vec![StreamDestination {
            id: "off".into(),
            name: "off".into(),
            rtmp_url: "garbage".into(),
            stream_key: "".into(),
            enabled: false,
        }];
        assert!(validate_destinations(&dests).is_ok());
    }

    #[test]
    fn validate_destinations_rejects_short_key() {
        let dests = vec![StreamDestination {
            id: "d".into(),
            name: "d".into(),
            rtmp_url: "rtmp://x/live".into(),
            stream_key: "ab".into(),
            enabled: true,
        }];
        let (id, err) = validate_destinations(&dests).unwrap_err();
        assert_eq!(id, "d");
        assert_eq!(err, StreamKeyError::TooShort);
    }

    // ── engine status default + feature-off start ──
    #[test]
    fn engine_starts_idle() {
        let e = StreamEngine::new();
        let s = e.status();
        assert!(!s.active);
        assert_eq!(s.started_at, None);
    }

    #[cfg(not(feature = "streaming"))]
    #[tokio::test]
    async fn start_is_disabled_without_the_feature() {
        let e = StreamEngine::new();
        let err = start(
            &e,
            Platform::MacOS,
            StreamOptions {
                resolution: StreamResolution::P720,
                framerate: 30,
                video_bitrate_kbps: None,
                audio_bitrate_kbps: None,
                destinations: vec![],
                also_record_path: None,
            },
            vec![],
            "0".into(),
            None,
            None,
            "/tmp/p.jpg".into(),
            0,
        )
        .await
        .unwrap_err();
        assert_eq!(err.code(), "validation");
        assert!(err.to_string().contains("feature_disabled"));
    }

    #[cfg(not(feature = "streaming"))]
    #[tokio::test]
    async fn stop_is_disabled_without_the_feature() {
        let e = StreamEngine::new();
        let err = stop(&e).await.unwrap_err();
        assert!(err.to_string().contains("feature_disabled"));
    }
}
