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

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::overlay::OverlayConfig;
#[cfg(feature = "streaming")]
use sundayrec_core::overlay::{build_overlay_pipeline, BuildOverlayOpts};
#[cfg(feature = "streaming")]
use sundayrec_core::streaming::{build_output_args, StreamArgError};
use sundayrec_core::streaming::{
    validate_rtmp_url, validate_stream_key, AudioInputLayout, StreamDestination, StreamKeyError,
    StreamOptions, StreamResolution,
};

use crate::error::{AppError, AppResult};

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

/// At most one live stream runs at a time. The engine stores the running child
/// handle (feature-on) and the last-known status. Held as Tauri-managed state.
pub struct StreamEngine {
    /// The running ffmpeg child, when streaming. Only used feature-on, but the
    /// field compiles either way to keep the managed-state type stable.
    #[cfg(feature = "streaming")]
    child: Mutex<Option<tokio::process::Child>>,
    status: Mutex<StreamStatus>,
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
            child: Mutex::new(None),
            status: Mutex::new(StreamStatus::idle()),
        }
    }

    /// Current status snapshot.
    pub fn status(&self) -> StreamStatus {
        self.status.lock().expect("stream status mutex").clone()
    }

    #[cfg(feature = "streaming")]
    fn set_status(&self, s: StreamStatus) {
        *self.status.lock().expect("stream status mutex") = s;
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
pub fn validate_destinations(
    dests: &[StreamDestination],
) -> Result<(), (String, StreamKeyError)> {
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
    use std::process::Stdio;

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

    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let child = tokio::process::Command::new(crate::media::ffmpeg::ffmpeg_path())
        .args(&arg_refs)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Recording(format!("stream ffmpeg spawn: {e}")))?;

    *engine.child.lock().expect("stream child mutex") = Some(child);
    let status = StreamStatus {
        active: true,
        started_at: Some(now_ms),
        bitrate_kbps: 0,
        fps: 0,
        dropped: 0,
        last_line: String::new(),
    };
    engine.set_status(status.clone());
    Ok(status)
}

/// Stop the running stream. Idempotent: no active stream → `false`.
#[cfg(not(feature = "streaming"))]
pub async fn stop(_engine: &StreamEngine) -> AppResult<bool> {
    disabled("stop")
}

/// Stop the running stream by killing the ffmpeg child. NETWORK/HARDWARE-UNVERIFIED.
#[cfg(feature = "streaming")]
pub async fn stop(engine: &StreamEngine) -> AppResult<bool> {
    let child = engine.child.lock().expect("stream child mutex").take();
    let was_active = child.is_some();
    if let Some(mut c) = child {
        // kill_on_drop is set, but kill explicitly so we await the exit.
        let _ = c.kill().await;
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
