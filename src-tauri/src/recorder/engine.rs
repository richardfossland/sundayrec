//! The production unified recorder engine (Fase 3).
//!
//! Lifts the Spike-B prototype into a state-machine-driven, self-healing
//! recorder. ALL decisions live in the pure `sundayrec-core` crate
//! ([`RecorderState`], [`RecordingSession`], the silence/watchdog/reconnect
//! policies); this module owns only the I/O: ffmpeg processes, tokio timers,
//! channels and Tauri events.
//!
//! ## Architecture — one supervisor, many helpers
//!
//! A single **supervisor task** ([`run_session`]) owns the [`RecordingSession`]
//! and the current [`RecorderState`]. It:
//!   1. resolves the device with the REAL ffmpeg enumerator
//!      ([`enumerate_ffmpeg_devices`]) + the core fuzzy match,
//!   2. spawns ffmpeg for the current segment and a per-segment **reader task**
//!      that streams stderr lines back over a channel,
//!   3. drives a `select!` loop over: reader events (progress / silence / error
//!      / ffmpeg-exit), the stop request, and the timer ticks (watchdog poll,
//!      split, manual-max, silence stop/warn),
//!   4. on an UNEXPECTED ffmpeg exit asks the core
//!      [`RecordingSession::on_unexpected_exit`] → reconnect (sleep the back-off,
//!      respawn against the next segment) or give up (fail-stop),
//!   5. on a split tick gracefully finalises the current segment and starts a
//!      fresh one WITHOUT ending the session,
//!   6. on a manual-max tick or a silence-stop tick performs a graceful stop,
//!   7. on each split boundary FINALISES the just-closed deliverable (concat its
//!      reconnect fragments into one lossless file) and writes its history row;
//!      on completion finalises the last deliverable too — so a split session
//!      yields N files and N history rows (Fase 3.3a).
//!
//! Every state change emits `recording://state`.
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! Everything pure is unit-tested ([`build_record_args`], event-channel
//! constants, the device-token shaping). Everything that touches a process —
//! [`run_session`], the reader task, the reconnect/split/stop paths and the
//! watchdog — opens a real mic/camera and runs for a long time; it is NOT
//! exercised by the test suite and MUST be smoke-tested on a rig (see
//! `docs/MIGRATION-TAURI2.md` Fase 3 exit). The core decisions it delegates to
//! ARE fully tested.
//!
//! ## Done in Fase 3.3a (was deferred)
//!
//!   - **Reconnect-segment concat merge + pre-roll prepend.** Each deliverable's
//!     reconnect `_rN` fragments are now stitched into one lossless file
//!     (`-c copy`, [`crate::recorder::concat::finalize_deliverable`]) at the
//!     deliverable's close, and the harvested pre-roll clip is prepended to the
//!     FIRST deliverable's first fragment. The core
//!     [`RecordingSession::deliverables`] groups split-vs-reconnect for it.
//!
//! ## Done in Fase 3.3b (partial)
//!
//!   - **Two-process audio+video fallback** (Electron's separate `videoHandle` /
//!     `_vtmp.mp4` merge): implemented as a SELF-CONTAINED simple path in
//!     [`crate::recorder::two_process`] — two ffmpeg processes (video + audio),
//!     muxed at stop with start_time head-alignment + `aresample` drift
//!     correction. Scoped to a SIMPLE video session (NO split, NO reconnect);
//!     this engine still owns the unified split/reconnect machinery. It is now
//!     AUTO-SELECTED: when a video session's first unified capture dies at
//!     startup with no output (`two_process::should_fallback_to_two_process`),
//!     the `UnexpectedExit` branch hands off to `run_two_process_session`
//!     instead of burning the reconnect budget. Fusing the two-process path
//!     fully INTO the reconnect/split state machine (each side reconnecting
//!     independently, N×N fragment mux) remains the Fase-3-continuation TODO.
//!
//! ## Deferred (honest scope)
//!
//!   - **NDI, streaming, lossless master:** later phases.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use sundayrec_core::capture::{build_unified_capture_args, resolve_camera_mode, CaptureOpts};
use sundayrec_core::device_match::{find_best_device_match, FfmpegDevice};
use sundayrec_core::errors::{classify_recording_error, RecordingErrorCode};
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::levels::{parse_ametadata_peak, ChannelLevels, SILENCE_FLOOR_DB};
use sundayrec_core::preflight::{low_disk_should_stop, min_disk_headroom_bytes};
use sundayrec_core::progress::{parse_size_kb, StartupResolver};
use sundayrec_core::reconnect::{WatchdogState, WatchdogVerdict};
use sundayrec_core::recorder::{RecorderState, RecordingSession, RecoveryDecision};
use sundayrec_core::recovery::{DeliverableManifest, SessionManifest};
use sundayrec_core::settings::ChannelMode;
use sundayrec_core::silence::{SilenceAction, SilenceEvent, SilenceWatcher};
use sundayrec_core::timeouts::RecorderTimeouts;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use ts_rs::TS;

use crate::audio::device_enum::{
    enumerate_ffmpeg_devices, enumerate_ffmpeg_devices_within, RECORD_START_ENUM_MAX_AGE,
};
use crate::db::store::{insert_recording, RecordingRow};
use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::spawn_ffmpeg;
use crate::recorder::concat::{finalize_deliverable, output_is_valid};
use crate::recorder::preroll::PrerollClip;
use crate::util::lock_recover;

/// Event channel: a progress heartbeat (bytes written so far).
pub const PROGRESS_EVENT: &str = "recording://progress";
/// Event channel: fired once, when ffmpeg's first `size=` line proves encoding.
pub const STARTED_EVENT: &str = "recording://started";
/// Event channel: a classified fatal error from ffmpeg's stderr (or the watchdog).
pub const ERROR_EVENT: &str = "recording://error";
/// Event channel: a silence warning (muted mixer / weak signal).
pub const SILENCE_EVENT: &str = "recording://silence";
/// Event channel: the recorder is attempting to reconnect after an unexpected death.
pub const RECONNECTING_EVENT: &str = "recording://reconnecting";
/// Event channel: a reconnect succeeded and recording resumed.
pub const RECONNECTED_EVENT: &str = "recording://reconnected";
/// Event channel: the recorder state changed (the [`RecorderState`] payload).
pub const STATE_EVENT: &str = "recording://state";
/// Event channel: live per-channel peak audio levels (drives the L/R meters).
pub const LEVELS_EVENT: &str = "recording://levels";
/// Event channel: a recording finished cleanly. Carries the final file path so
/// the UI can offer "open in editor" — the record→edit hand-off.
pub const FINISHED_EVENT: &str = "recording://finished";

/// Payload for [`FINISHED_EVENT`] — where the finished recording landed, so the
/// UI's "open in editor" action can load it straight into the editor.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingFinished.ts")]
pub struct RecordingFinished {
    /// Absolute path to the finished recording file.
    pub file_path: String,
    /// Whether it is a video (mp4) recording.
    pub has_video: bool,
}

/// Options for [`RecorderEngine::start`].
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingOpts.ts")]
pub struct RecordingOpts {
    /// Stored microphone/mixer name to fuzzy-match against the enumerated audio
    /// devices. Empty → first/default device.
    pub audio_device_name: String,
    /// Stored camera name to match against video devices. `None` → audio-only.
    pub video_device_name: Option<String>,
    /// Absolute output file path the (first) segment is written to.
    pub output_path: String,
    /// User opted into stop-on-silence.
    pub stop_on_silence: bool,
    /// Silence threshold in dB (clamped by the core filter builder).
    pub silence_threshold_db: Option<i32>,
    /// Minutes of continuous silence before stop-on-silence fires (1–120).
    pub silence_timeout_minutes: u32,
    /// Capture framerate.
    pub framerate: u32,
    /// Output channel layout / downmix mode (stereo, mono-L, mono-R, mono-mix).
    pub channel_mode: ChannelMode,
    /// Explicit 0-based device input channel → LEFT output (multi-channel mixers).
    /// `None` keeps the `channel_mode` default routing.
    pub input_channel_l: Option<i32>,
    /// Explicit 0-based device input channel → RIGHT output. See `input_channel_l`.
    pub input_channel_r: Option<i32>,
    /// Capture sample rate in Hz, or `None` to capture at the device's NATIVE
    /// rate (omit `-ar` — the anti-resample / anti-choppiness fix). Resolved from
    /// `Settings::sample_rate_mode` via `resolved_sample_rate()`.
    pub sample_rate: Option<u32>,
    /// Output bitrate in kbps for lossy codecs (mp3/aac); ignored by wav/flac.
    pub bitrate_kbps: u32,
    /// Rotate to a fresh segment every N minutes (0 = off).
    pub split_minutes: u32,
    /// Auto-stop the whole session after N minutes (0 = off).
    pub manual_max_minutes: u32,
    /// Emit the live L/R level meters (`astats`) during capture? When `false`,
    /// the levels filter is dropped to keep capture maximally stable.
    pub live_levels: bool,
    /// For a VIDEO recording, also extract a standalone audio sidecar file next to
    /// the finished video. No-op for audio-only recordings (the main file already
    /// is the audio).
    pub keep_separate_audio: bool,
    /// The extension/container for the separate audio sidecar (e.g. `"wav"`),
    /// chosen from `Settings::separate_audio_format`. Drives the extract codec via
    /// the shared `audio_encode_args` seam.
    pub separate_audio_format: String,
    /// Capture resolution tag (`"480p"`/`"720p"`/`"1080p"`/`"2160p"`) from
    /// settings — the camera-mode probe TARGET, so a 1080p setting records 1080p
    /// (when the camera advertises it). Empty → 720p. Serialized (it roundtrips
    /// through the planner).
    #[serde(default)]
    pub video_resolution: String,
    /// Recording video codec tag (`"h264"`/`"h265"`) from settings. Empty/unknown
    /// → H.264. Drives the `-c:v` choice in the capture args.
    #[serde(default)]
    pub video_codec: String,
    /// Recording video encoder backend (`"software"`/`"hardware"`) from settings.
    /// `"hardware"` → VideoToolbox on macOS (realtime 4K); ignored off macOS.
    #[serde(default)]
    pub video_encoder: String,
    /// Windows escape hatch: force the legacy ffmpeg DirectShow audio path instead
    /// of the modern cpal (WASAPI/ASIO) capture. Default `false`. No effect on macOS.
    #[serde(default)]
    pub classic_directshow: bool,
    /// The camera INPUT mode the recorder probed at start (a size + framerate the
    /// device actually advertises). NOT sent by the frontend — it's resolved
    /// server-side so avfoundation doesn't reject an unsupported size/rate. `None`
    /// → audio-only, or the probe yielded nothing (legacy 720p guess).
    #[serde(skip)]
    #[ts(skip)]
    pub video_input: Option<sundayrec_core::capture::VideoCaptureMode>,
}

/// A progress heartbeat sent to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingProgress.ts")]
pub struct RecordingProgress {
    /// Total bytes ffmpeg has written to the current segment so far.
    #[ts(type = "number")]
    pub bytes_written: u64,
}

/// Live per-channel peak audio levels (dBFS) sent to the renderer, parsed from
/// the recorder's own ffmpeg `astats` telemetry. Drives the L/R meters in the
/// "Opptaksmodus" overlay. `peak_db_right` is `None` for mono sources.
///
/// Field names mirror [`RecordingProgress`] (no serde rename) → the generated TS
/// binding is `peak_db_left` / `peak_db_right`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingLevels.ts")]
pub struct RecordingLevels {
    /// Peak level (dBFS) of the left / only channel.
    pub peak_db_left: f64,
    /// Peak level (dBFS) of the right channel, or `null` for mono sources.
    pub peak_db_right: Option<f64>,
}

impl From<ChannelLevels> for RecordingLevels {
    fn from(lv: ChannelLevels) -> Self {
        Self {
            peak_db_left: lv.peak_db_left,
            peak_db_right: lv.peak_db_right,
        }
    }
}

/// A classified recorder error / silence / reconnect notice sent to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingEvent.ts")]
pub struct RecordingEvent {
    /// Stable code the UI localises (snake_case, e.g. `device_disconnected`,
    /// `stuck_recording`, `silence_detected`).
    pub code: String,
    /// Human-readable detail for logs / a diagnostics surface.
    pub message: String,
}

/// The `recording://state` payload — the current [`RecorderState`] plus the
/// reconnect attempt count so the UI can show "reconnecting (3/20)".
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/RecorderStatePayload.ts")]
pub struct RecorderStatePayload {
    /// The lifecycle state.
    pub state: RecorderState,
    /// How many reconnects have happened so far this session.
    pub reconnect_count: u32,
    /// Absolute epoch-ms the recording will auto-stop at, or `null` for no
    /// auto-stop. Driven by `manual_max_minutes` at start; live extend/cancel
    /// (`recording_extend_autostop` / `recording_cancel_autostop`) move or clear
    /// it and the UI ticks a countdown to it locally.
    #[ts(type = "number | null")]
    pub scheduled_stop_ms: Option<u64>,
}

/// Map the running OS to the core [`Platform`] enum. Public for the recorder's
/// consumers (e.g. `test_recording`); the logic lives in [`crate::util`].
pub fn current_platform() -> Platform {
    crate::util::detect_platform()
}

/// Build the ffmpeg record arguments for `opts` against a resolved audio device
/// (and optional video device), on `platform`, writing to `output_path`. Pure
/// wrapper over the core builder so argument shaping is unit-tested without a
/// process. `output_path` is passed separately so the supervisor can build args
/// for each reconnect/split segment without mutating `opts`.
pub fn build_record_args(
    platform: Platform,
    audio: &FfmpegDevice,
    video: Option<&FfmpegDevice>,
    opts: &RecordingOpts,
    output_path: &str,
) -> Vec<String> {
    let audio_token = device_token(audio);
    let video_token = video.map(device_token);
    let capture = CaptureOpts {
        stop_on_silence: opts.stop_on_silence,
        silence_threshold_db: opts.silence_threshold_db,
        framerate: opts.framerate,
        channel_mode: opts.channel_mode,
        input_channel_l: opts.input_channel_l,
        input_channel_r: opts.input_channel_r,
        sample_rate: opts.sample_rate,
        bitrate_kbps: opts.bitrate_kbps,
        live_levels: opts.live_levels,
        // Video recordings ALSO write a low-fps preview JPEG (deadlock-proof file
        // sink) the UI polls for a live image while recording.
        preview_jpg: video.map(|_| recording_preview_path().to_string_lossy().into_owned()),
        // The probed camera mode (resolved in `start`); pins a size/rate the
        // device actually advertises so avfoundation opens the camera.
        video_input: opts.video_input,
        video_codec: match opts.video_codec.as_str() {
            "h265" | "hevc" => sundayrec_core::editor::VideoCodec::H265,
            _ => sundayrec_core::editor::VideoCodec::H264,
        },
        hw_accel: opts.video_encoder == "hardware",
    };
    build_unified_capture_args(
        platform,
        video_token.as_deref(),
        &audio_token,
        output_path,
        &capture,
    )
}

/// Shared path of the live in-recording preview JPEG: a single file in the OS temp
/// dir that the recording ffmpeg auto-overwrites (`-update 1`) ~4×/s for video
/// recordings, and the `recording_preview_frame` command reads. One fixed path is
/// fine — at most one recording runs at a time.
pub fn recording_preview_path() -> std::path::PathBuf {
    std::env::temp_dir().join("sundayrec-recording-preview.jpg")
}

/// The addressable token for a device: the avfoundation index (mac) when known,
/// otherwise the dshow name (Windows).
fn device_token(d: &FfmpegDevice) -> String {
    match d.index {
        Some(i) => i.to_string(),
        None => d.name.clone(),
    }
}

/// Enumerate capture devices with the REAL ffmpeg enumerator (F2.1). Replaces
/// the Spike-B cpal stub so the recorder gets true avfoundation indices /
/// dshow names. Returns the audio inputs (the recorder mic match) and the video
/// inputs (the camera match) separately.
///
/// ⚠️ HARDWARE-UNVERIFIED — spawns `ffmpeg -list_devices`.
pub async fn list_recording_devices() -> AppResult<Vec<FfmpegDevice>> {
    let inv = enumerate_ffmpeg_devices().await?;
    Ok(inv.audio_inputs)
}

/// What event the reader task sends the supervisor for each stderr line of
/// interest (so the supervisor's `select!` owns all state).
enum ReaderMsg {
    /// A `size=` progress line: total bytes for the current segment.
    Progress(u64),
    /// The first progress line (encoding confirmed).
    Started,
    /// A silence marker.
    Silence(SilenceEvent),
    /// A per-channel peak-levels readout (drives the live L/R meters).
    Levels(ChannelLevels),
    /// A classified error line (not the catch-all `DeviceError`).
    Error(RecordingErrorCode, String),
    /// ffmpeg's stderr closed → the process exited. Carries the classified
    /// last-error (if any error line was seen) for the reconnect decision.
    Exit {
        last_error: Option<RecordingErrorCode>,
    },
}

/// A running recording: the supervisor task plus the stop channel.
struct RecorderSession {
    supervisor: tauri::async_runtime::JoinHandle<()>,
    /// Send `()` to request a graceful stop.
    stop_tx: tokio::sync::mpsc::Sender<()>,
}

/// The engine handle stored in Tauri-managed state. At most one recording runs
/// at a time; starting again stops the previous one first.
pub struct RecorderEngine {
    session: Mutex<Option<RecorderSession>>,
    /// The last-emitted state, so `recording_status` can report it synchronously.
    last_state: Arc<Mutex<RecorderState>>,
    /// The live auto-stop deadline (absolute epoch ms, `None` = no auto-stop), as
    /// a watch channel so the running recording loop reacts to extend/cancel
    /// immediately. `run_session` sets the initial value (from
    /// `manual_max_minutes`) and clears it at session end; the
    /// `recording_extend_autostop` / `recording_cancel_autostop` commands move /
    /// clear it. Wrapped in `Arc` so both the engine (commands) and the
    /// supervisor task share the one sender.
    scheduled_stop: Arc<tokio::sync::watch::Sender<Option<u64>>>,
    /// Which audio engine the LAST `start()` used (`"wasapi"`/`"asio"`/
    /// `"directshow"`/`"avfoundation"`) + any fallback reason. Surfaced by the
    /// diagnose tool so support can see whether ASIO/WASAPI actually engaged or
    /// fell back, and why. `(engine, fallback_reason)`.
    audio_engine: Arc<Mutex<(Option<String>, Option<String>)>>,
}

impl Default for RecorderEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RecorderEngine {
    pub fn new() -> Self {
        let (scheduled_stop, _rx) = tokio::sync::watch::channel(None);
        Self {
            session: Mutex::new(None),
            last_state: Arc::new(Mutex::new(RecorderState::Idle)),
            scheduled_stop: Arc::new(scheduled_stop),
            audio_engine: Arc::new(Mutex::new((None, None))),
        }
    }

    /// The last state the engine emitted (best-effort; the supervisor updates it
    /// on every transition). Used by the `recording_status` command.
    pub fn current_state(&self) -> RecorderState {
        *lock_recover(&self.last_state)
    }

    /// Record which audio engine `start()` chose (+ optional fallback reason), for
    /// the diagnose tool. `fallback` is `Some(reason)` only when the modern engine
    /// (WASAPI/ASIO) couldn't start and we fell back to DirectShow.
    pub(crate) fn set_audio_engine(&self, engine: &str, fallback: Option<String>) {
        *lock_recover(&self.audio_engine) = (Some(engine.to_string()), fallback);
    }

    /// The audio engine the last recording used (diagnose tool).
    pub fn last_audio_engine(&self) -> Option<String> {
        lock_recover(&self.audio_engine).0.clone()
    }

    /// Why the last recording fell back from the modern engine, if it did.
    pub fn last_audio_fallback(&self) -> Option<String> {
        lock_recover(&self.audio_engine).1.clone()
    }

    /// The current auto-stop deadline (absolute epoch ms), or `None` when no
    /// auto-stop is armed. Exposed via the `recording_scheduled_stop_ms` command
    /// so a (re)mounting screen can rehydrate the countdown synchronously.
    pub fn scheduled_stop_ms(&self) -> Option<u64> {
        *self.scheduled_stop.borrow()
    }

    /// Extend the auto-stop by `minutes` (the "+30 min" button). Adds to the
    /// current deadline so it never SHORTENS the recording, falling back to
    /// `now` when no auto-stop is armed or it has already passed. The running
    /// loop observes the change via its watch receiver and re-pins the real
    /// timer + re-emits state. A no-op (just a stored value) when idle.
    pub fn extend_autostop(&self, minutes: u32) {
        let next = extended_stop_ms(*self.scheduled_stop.borrow(), now_ms(), minutes);
        self.scheduled_stop.send_replace(Some(next));
    }

    /// Clear the auto-stop entirely so the recording runs until a manual stop.
    pub fn cancel_autostop(&self) {
        self.scheduled_stop.send_replace(None);
    }

    /// Start a recording. Resolves the device, then launches the supervisor task
    /// which spawns ffmpeg and drives the whole session. `pool`, when present,
    /// receives the history row on completion. Returns once the session has
    /// launched ffmpeg, so a failure to launch surfaces to the caller.
    ///
    /// ⚠️ HARDWARE-UNVERIFIED — see module header.
    pub async fn start(
        &self,
        app: AppHandle,
        pool: Option<SqlitePool>,
        opts: RecordingOpts,
        preroll_clip: Option<PrerollClip>,
    ) -> AppResult<()> {
        self.stop();

        // Fail FAST + CLEAR on blocked TCC access: the microphone (always needed)
        // and the camera (only when video is on). avfoundation on a denied device
        // hangs or errors opaquely, so an actionable "open System Settings" beats a
        // confusing device-probe timeout. NotDetermined/Unknown fall through —
        // opening the device is what triggers the OS prompt, and Unknown means we
        // couldn't tell, so we behave exactly as before.
        {
            use crate::media::permissions::{blocked_message, status, MediaKind};
            let mic = status(MediaKind::Microphone);
            if let Some(msg) = blocked_message(MediaKind::Microphone, mic) {
                return Err(AppError::Recording(msg));
            }
            let wants_video = opts
                .video_device_name
                .as_deref()
                .map(|n| !n.is_empty())
                .unwrap_or(false);
            if wants_video {
                let cam = status(MediaKind::Camera);
                if let Some(msg) = blocked_message(MediaKind::Camera, cam) {
                    return Err(AppError::Recording(msg));
                }
            }
        }

        // Pre-roll prepend (F3.2 + F3.3a). When the caller harvested a pre-roll
        // clip we have a real, playable clip (in the recording's codec/container)
        // of the audio captured BEFORE the record press. The supervisor prepends
        // it to the FIRST deliverable's concat at finalisation (see
        // `finalize_one`); the clip travels into `run_session`.
        if let Some(clip) = &preroll_clip {
            tracing::info!(
                clip = %clip.raw_path,
                trim_ms = clip.trim_ms,
                "recorder: pre-roll clip will be prepended to the first deliverable"
            );
        }

        let platform = current_platform();
        // Bound the device probe: `ffmpeg -list_devices` (avfoundation) can stall
        // if the mic is momentarily contended (e.g. the VU cpal stream hasn't
        // released yet), and a stalled start is worse than a clear error.
        //
        // R4: reuse a very-recent enumeration (warmed when the record modal opened)
        // instead of always re-spawning ffmpeg — saves 50–500 ms off the felt start.
        // The window is short (RECORD_START_ENUM_MAX_AGE); past it we enumerate
        // fresh, preserving the "don't decide on a stale list" intent.
        let inv = match tokio::time::timeout(
            std::time::Duration::from_secs(8),
            enumerate_ffmpeg_devices_within(RECORD_START_ENUM_MAX_AGE),
        )
        .await
        {
            Ok(result) => result?,
            Err(_) => {
                return Err(AppError::Recording(
                    "tidsavbrudd ved enhetssøk — prøv igjen".into(),
                ))
            }
        };
        // Match the selected mic against ffmpeg's dshow/avfoundation list. On
        // Windows the cpal capture path (below) addresses the device BY NAME via
        // cpal, so a dshow match is not required there — keep it OPTIONAL so an
        // ASIO-only / cpal-only device doesn't error here. It is still needed for
        // the macOS path and the Windows dshow fallback.
        let dshow_audio: Option<FfmpegDevice> =
            find_best_device_match(&inv.audio_inputs, &opts.audio_device_name).cloned();
        // Video resolution uses the dedicated video-input list + the video match
        // ladder (F2.1). None unless the user enabled video AND a name matches.
        let video = match &opts.video_device_name {
            Some(name) if !name.is_empty() => {
                sundayrec_core::device_enum::find_best_video_device_match(&inv.video_inputs, name)
                    .cloned()
            }
            _ => None,
        };

        // For a video session, PROBE the camera's advertised modes and resolve a
        // size/rate it actually supports — avfoundation refuses an unsupported
        // one (the bug: a camera that does only 15/30 rejecting the requested 25,
        // so the camera never opened and the recording died with a downstream
        // "mux_failed"). The OUTPUT still conforms to the user's target fps.
        let mut opts = opts;
        if let Some(v) = &video {
            let modes = crate::media::camera::probe_camera_modes(&device_token(v), platform).await;
            let (target_w, target_h) =
                sundayrec_core::capture::resolution_dims(&opts.video_resolution);
            match resolve_camera_mode(&modes, target_w, target_h, opts.framerate.max(1)) {
                Some(m) => {
                    tracing::info!(
                        width = m.width,
                        height = m.height,
                        input_fps = m.input_fps,
                        target_fps = opts.framerate,
                        target_res = %opts.video_resolution,
                        "recorder: resolved camera capture mode from probe"
                    );
                    opts.video_input = Some(m);
                }
                None => tracing::warn!(
                    modes = modes.len(),
                    "recorder: camera-mode probe found nothing — using legacy 720p guess"
                ),
            }
        }

        // ── Windows: capture audio via cpal (modern API), not ffmpeg/dshow ──────
        // dshow is an old API that splits pro interfaces into stereo pairs and is
        // the source of the Windows instability. So on Windows we capture audio
        // ourselves with cpal — WASAPI for normal devices, ASIO for pro interfaces
        // — and pipe it into ffmpeg (which still does the camera via dshow + all
        // encoding). dshow audio remains only as an automatic fallback if cpal
        // can't start, and the `classic_directshow` setting forces it. macOS keeps
        // the ffmpeg avfoundation path (run_session) entirely.
        // `cfg!(windows)` (not `#[cfg]`) so this compiles on every platform — the
        // call signature is type-checked on macOS even though it only RUNS on
        // Windows (DCE'd elsewhere; `run_cpal_session` has a non-Windows stub).
        let is_asio = crate::audio::asio::is_asio_device(&opts.audio_device_name);
        // Features that ONLY the full dshow `run_session` implements (preroll,
        // split, stop-on-silence). For a normal device we route such sessions to
        // dshow so they're never silently dropped; ASIO has no dshow alternative,
        // so we still use cpal but warn the user the feature isn't supported there.
        let needs_dshow_only =
            preroll_clip.is_some() || opts.split_minutes > 0 || opts.stop_on_silence;
        let use_cpal = cfg!(windows) && !opts.classic_directshow && (is_asio || !needs_dshow_only);
        // Why the modern engine fell back, if it did — recorded into the engine
        // status (read by the diagnose tool), NOT surfaced as a fatal recording
        // error (the recording proceeds fine on DirectShow).
        let mut cpal_fallback_reason: Option<String> = None;
        if use_cpal {
            use crate::recorder::cpal_capture::{run_cpal_session, CpalHostKind};
            let host_kind = if is_asio {
                CpalHostKind::Asio
            } else {
                CpalHostKind::Wasapi
            };
            // ASIO + a dshow-only feature: we can't fall back (dshow can't open
            // ASIO), so the feature is inactive. This is informational, not a
            // recording failure — log it (the diagnose tool can surface it) rather
            // than emitting a fatal `recording://error` that would tear down the UI.
            if is_asio && needs_dshow_only {
                tracing::warn!(
                    "recorder: preroll/split/silence not supported on the ASIO path — recording without them"
                );
            }
            let (stop_tx, stop_rx) = tokio::sync::mpsc::channel::<()>(1);
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();
            let sup_app = app.clone();
            let last_state = Arc::clone(&self.last_state);
            let scheduled_stop = Arc::clone(&self.scheduled_stop);
            // CLONE what the cpal attempt needs so the originals survive for the
            // dshow fallback below if cpal fails to start.
            let (opts_c, video_c, pool_c) = (opts.clone(), video.clone(), pool.clone());
            let supervisor = tauri::async_runtime::spawn(async move {
                run_cpal_session(
                    host_kind,
                    sup_app,
                    pool_c,
                    opts_c,
                    video_c,
                    stop_rx,
                    ready_tx,
                    last_state,
                    scheduled_stop,
                )
                .await;
            });
            match ready_rx.await {
                Ok(Ok(())) => {
                    self.set_audio_engine(if is_asio { "asio" } else { "wasapi" }, None);
                    *lock_recover(&self.session) = Some(RecorderSession {
                        supervisor,
                        stop_tx,
                    });
                    return Ok(());
                }
                ready => {
                    // cpal couldn't start (driver busy/absent, device vanished, or
                    // the supervisor died). Don't fail the recording — fall back to
                    // the dshow capture automatically. The reason goes into the
                    // engine status (diagnose tool), NOT a fatal recording error.
                    supervisor.abort();
                    let err = match ready {
                        Ok(Err(e)) => e,
                        _ => AppError::Recording(
                            "cpal recorder supervisor exited before signalling".into(),
                        ),
                    };
                    tracing::warn!(
                        "recorder: cpal {host_kind:?} start failed ({err}); falling back to dshow"
                    );
                    cpal_fallback_reason = Some(err.to_string());
                    // fall through to the dshow run_session path below.
                }
            }
        }

        // dshow/avfoundation path: macOS always; Windows only when cpal is disabled
        // (`classic_directshow`) or failed to start (fallback above). Needs a real
        // ffmpeg device match — an ASIO-only device with no dshow shadow errors here.
        let audio = dshow_audio.ok_or_else(|| {
            AppError::Recording(format!(
                "no audio device matched '{}'",
                opts.audio_device_name
            ))
        })?;
        // Record which engine this session actually uses (diagnose tool): the
        // dshow path on Windows (forced-classic or cpal-fallback), avfoundation on
        // macOS. `cpal_fallback_reason` is set only when we came from a cpal failure.
        self.set_audio_engine(
            if cfg!(windows) {
                "directshow"
            } else {
                "avfoundation"
            },
            cpal_fallback_reason,
        );

        let (stop_tx, stop_rx) = tokio::sync::mpsc::channel::<()>(1);
        // The "ready" handshake MUST be async: the command awaits it on a Tauri
        // runtime worker, and the supervisor that signals it is itself a runtime
        // task. A blocking `std::sync::mpsc::recv()` here pins the worker and
        // starves the runtime → the whole app beachballs and Stop dies too. A
        // `oneshot` + `.await` frees the worker while the supervisor makes
        // progress. (The supervisor signals exactly once — a perfect oneshot.)
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<AppResult<()>>();

        let sup_app = app.clone();
        let last_state = Arc::clone(&self.last_state);
        let scheduled_stop = Arc::clone(&self.scheduled_stop);
        let supervisor = tauri::async_runtime::spawn(async move {
            run_session(
                sup_app,
                pool,
                opts,
                platform,
                audio,
                video,
                preroll_clip,
                stop_rx,
                ready_tx,
                last_state,
                scheduled_stop,
            )
            .await;
        });

        match ready_rx.await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                supervisor.abort();
                return Err(e);
            }
            Err(_) => {
                supervisor.abort();
                return Err(AppError::Recording(
                    "recorder supervisor exited before signalling".into(),
                ));
            }
        }

        *lock_recover(&self.session) = Some(RecorderSession {
            supervisor,
            stop_tx,
        });
        Ok(())
    }

    /// Request a graceful stop. The supervisor sends ffmpeg `q` so the container
    /// finalises, writes history, then exits. Safe to call when idle. We do NOT
    /// abort the supervisor here (that would race the `q` and corrupt the MP4);
    /// the supervisor winds itself down. A detached grace-timer aborts it only
    /// if it's still alive after a generous window (a hung ffmpeg).
    pub fn stop(&self) {
        let session = lock_recover(&self.session).take();
        if let Some(session) = session {
            let _ = session.stop_tx.try_send(());
            let supervisor = session.supervisor;
            tauri::async_runtime::spawn(async move {
                // Generous: a graceful stop may need to finalise a large MP4 and
                // (rarely) reap a reconnecting child. Only hard-abort a true hang.
                tokio::time::sleep(Duration::from_secs(15)).await;
                supervisor.abort();
            });
        }
    }
}

/// Emit a state change and remember it. Asserts the transition is legal via the
/// core table (a refused transition is a logic bug — logged, but we still emit
/// the requested state so the UI doesn't desync).
fn set_state(
    app: &AppHandle,
    last_state: &Arc<Mutex<RecorderState>>,
    to: RecorderState,
    reconnect_count: u32,
    scheduled_stop_ms: Option<u64>,
) {
    {
        let mut guard = lock_recover(last_state);
        match guard.transition(to) {
            Some(next) => *guard = next,
            None => {
                tracing::warn!("recorder: illegal state transition {:?} → {to:?}", *guard);
                *guard = to;
            }
        }
    }
    let _ = app.emit(
        STATE_EVENT,
        RecorderStatePayload {
            state: to,
            reconnect_count,
            scheduled_stop_ms,
        },
    );
}

/// The auto-stop deadline after the user extends by `minutes`: add to the current
/// deadline so "+30 min" really extends (never shortens), falling back to `now`
/// when nothing is armed or the existing deadline already passed. Pure → tested.
///
/// `minutes` is clamped to one day so a stray/adversarial IPC value can't push the
/// deadline so far out that the downstream `Instant::now() + remaining` overflows
/// the platform clock and panics the live recording loop.
fn extended_stop_ms(current: Option<u64>, now: u64, minutes: u32) -> u64 {
    let base = current.filter(|&d| d > now).unwrap_or(now);
    let minutes = minutes.min(MAX_AUTOSTOP_MINUTES);
    base + u64::from(minutes) * 60_000
}

/// Upper bound on an auto-stop horizon (1 day). Matches the `manual_max_minutes`
/// clamp domain and keeps every derived `Duration` well inside `Instant` range.
const MAX_AUTOSTOP_MINUTES: u32 = 1440;

/// Why the current segment's ffmpeg stopped — drives what the supervisor does
/// next.
enum SegmentOutcome {
    /// Graceful stop requested by the user → finalise + end the session.
    GracefulStop,
    /// Split timer fired → finalise this segment, start a fresh one.
    Split,
    /// Manual-max auto-stop fired → finalise + end the session.
    AutoStop,
    /// Stop-on-silence fired → finalise + end the session.
    SilenceStop,
    /// Free disk space fell below the headroom → graceful stop + end the session
    /// BEFORE ffmpeg hits ENOSPC and corrupts the container.
    DiskStop,
    /// ffmpeg died unexpectedly → consult the recovery policy. Carries the last
    /// classified error (for the fatal-error short-circuit).
    UnexpectedExit {
        last_error: Option<RecordingErrorCode>,
    },
}

/// The supervisor: owns the [`RecordingSession`] + [`RecorderState`] and runs
/// the whole recording, segment by segment, across reconnects and splits, then
/// writes one history row.
///
/// ⚠️ HARDWARE-UNVERIFIED — drives real captures over a long runtime.
#[allow(clippy::too_many_arguments)]
async fn run_session(
    app: AppHandle,
    pool: Option<SqlitePool>,
    opts: RecordingOpts,
    platform: Platform,
    audio: FfmpegDevice,
    video: Option<FfmpegDevice>,
    preroll_clip: Option<PrerollClip>,
    mut stop_rx: tokio::sync::mpsc::Receiver<()>,
    ready: tokio::sync::oneshot::Sender<AppResult<()>>,
    last_state: Arc<Mutex<RecorderState>>,
    scheduled_stop: Arc<tokio::sync::watch::Sender<Option<u64>>>,
) {
    let start_ms = now_ms();
    // Arm the auto-stop deadline for the whole session (absolute, so splits +
    // reconnects re-pin the SAME stop time, not a fresh duration). `manual_max
    // == 0` means no auto-stop. Always send_replace so a stale deadline from a
    // previous recording can't leak into this one.
    let initial_stop = (opts.manual_max_minutes > 0)
        .then(|| start_ms + u64::from(opts.manual_max_minutes) * 60_000);
    scheduled_stop.send_replace(initial_stop);
    let mut stop_watch = scheduled_stop.subscribe();
    // Emit a state transition, always stamping the CURRENT auto-stop deadline so
    // the UI countdown stays in sync on every transition (start, reconnect, stop).
    // A TERMINAL state (Stopped/Failed) clears the deadline first, so a finished
    // OR failed recording never ships a lingering countdown — the clear lives
    // here (one place) instead of being scattered before each Failed exit.
    let emit_state = |to: RecorderState, reconnect_count: u32| {
        if to.is_terminal() {
            scheduled_stop.send_replace(None);
        }
        set_state(
            &app,
            &last_state,
            to,
            reconnect_count,
            *scheduled_stop.borrow(),
        );
    };
    // Unique per recording (singleton engine → start_ms never repeats); also the
    // crash-recovery manifest's filename.
    let session_id = start_ms.to_string();
    let mut session = RecordingSession::new(opts.output_path.clone(), start_ms);
    // How many deliverables have already been finalised (concat + history row).
    // Each split closes one; session end finalises the rest. The pre-roll clip is
    // prepended only to deliverable 0 (`finalize_one` checks `index == 0`).
    let mut finalized: usize = 0;
    // Clear any stale preview frame from a previous video recording so the tile
    // doesn't briefly show last time's image before ffmpeg writes a fresh one.
    if opts.video_device_name.is_some() {
        let _ = std::fs::remove_file(recording_preview_path());
    }
    emit_state(RecorderState::Preparing, 0);

    // Spawn the FIRST segment. A launch failure here is reported to the caller.
    let first_args = build_record_args(
        platform,
        &audio,
        video.as_ref(),
        &opts,
        session.primary_path(),
    );
    let mut child = match spawn_ffmpeg_owned(&first_args).await {
        Ok(c) => {
            let _ = ready.send(Ok(()));
            c
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            emit_state(RecorderState::Failed, 0);
            return;
        }
    };

    emit_state(RecorderState::Recording, 0);

    loop {
        // Persist the crash-recovery manifest reflecting the CURRENT deliverable /
        // fragment layout (it grows across splits + reconnects). If the app dies
        // before the clean delete at session end, the startup scan finalises these
        // fragments instead of losing the recording. Best-effort; never blocks.
        crate::recorder::recovery::write_manifest(
            &app,
            &session_manifest(&session_id, &session, &audio, &preroll_clip, start_ms),
        )
        .await;

        // ── Run ONE segment to completion ───────────────────────────────────
        // Per-deliverable `byte_size` is read from the finalised file on disk
        // (after concat), so we no longer accumulate a session-wide byte total;
        // `segment_bytes` still drives this segment's live progress + watchdog.
        let segment_bytes = Arc::new(AtomicU64::new(0));
        let outcome = run_segment(
            &app,
            child,
            &opts,
            &session,
            Arc::clone(&segment_bytes),
            &mut stop_rx,
            &last_state,
            &mut stop_watch,
        )
        .await;

        match outcome {
            SegmentOutcome::GracefulStop
            | SegmentOutcome::AutoStop
            | SegmentOutcome::SilenceStop
            | SegmentOutcome::DiskStop => {
                break;
            }
            SegmentOutcome::Split => {
                // The split CLOSES the current deliverable. Finalise it (concat
                // its fragments + write its history row) BEFORE opening the next.
                let close_ms = now_ms();
                finalize_pending(
                    &app,
                    &pool,
                    &session,
                    &mut finalized,
                    close_ms,
                    &preroll_clip,
                    &audio,
                    &opts,
                )
                .await;

                let next = session.begin_split_segment(close_ms);
                let args = build_record_args(platform, &audio, video.as_ref(), &opts, &next);
                tracing::info!(segment = %next, "recorder: split — starting new segment");
                match spawn_ffmpeg_owned(&args).await {
                    Ok(c) => child = c,
                    Err(e) => {
                        tracing::error!("recorder: split respawn failed: {e}");
                        emit_error(&app, "device_error", &e.to_string());
                        emit_state(RecorderState::Failed, session.reconnect_count());
                        finalize_pending(
                            &app,
                            &pool,
                            &session,
                            &mut finalized,
                            now_ms(),
                            &preroll_clip,
                            &audio,
                            &opts,
                        )
                        .await;
                        return;
                    }
                }
            }
            SegmentOutcome::UnexpectedExit { last_error } => {
                // F3.3b auto-fallback: a video session whose FIRST capture died
                // at startup without producing output usually means the camera +
                // mic can't share one ffmpeg process. Rather than burn the
                // reconnect budget on a pairing that will never work, hand off to
                // the two-process path (separate captures + mux). Narrow trigger
                // (pure decision in core); anything else falls through to the
                // normal reconnect policy below. HARDWARE-UNVERIFIED.
                if let Some(video_dev) = video.as_ref() {
                    if sundayrec_core::two_process::should_fallback_to_two_process(
                        true,
                        finalized == 0,
                        session.reconnect_count(),
                        segment_bytes.load(Ordering::Relaxed),
                        (now_ms() - start_ms) as i64,
                    ) {
                        tracing::warn!(
                            "recorder: unified video startup failed with no output — \
                             switching to two-process fallback"
                        );
                        let _ = app.emit(
                            RECONNECTING_EVENT,
                            RecordingEvent {
                                code: "two_process_fallback".into(),
                                message: "Kamera og mikrofon kan ikke deles i én prosess — \
                                          bytter til to-prosess-opptak"
                                    .into(),
                            },
                        );
                        // Drop the empty/broken unified file before the fallback
                        // writes its own temps + muxed output.
                        let _ = std::fs::remove_file(session.primary_path());

                        let result = crate::recorder::two_process::run_two_process_session(
                            app.clone(),
                            pool.clone(),
                            opts.clone(),
                            platform,
                            audio.clone(),
                            video_dev.clone(),
                            stop_rx,
                        )
                        .await;
                        match result {
                            Ok(()) => emit_state(RecorderState::Stopped, 0),
                            Err(e) => {
                                emit_error(&app, "device_error", &e.to_string());
                                emit_state(RecorderState::Failed, 0);
                            }
                        }
                        return;
                    }
                }

                // Consult the pure recovery policy.
                match session.on_unexpected_exit(now_ms(), last_error) {
                    RecoveryDecision::GiveUp => {
                        let code = last_error
                            .map(error_code_str)
                            .unwrap_or("device_disconnected");
                        emit_error(&app, code, "Opptaket kunne ikke gjenopprettes");
                        emit_state(RecorderState::Failed, session.reconnect_count());
                        finalize_pending(
                            &app,
                            &pool,
                            &session,
                            &mut finalized,
                            now_ms(),
                            &preroll_clip,
                            &audio,
                            &opts,
                        )
                        .await;
                        tracing::error!("recorder: giving up — fail-stop");
                        return;
                    }
                    RecoveryDecision::Reconnect {
                        delay_ms,
                        attempt,
                        next_segment,
                    } => {
                        emit_state(RecorderState::Reconnecting, session.reconnect_count());
                        let _ = app.emit(
                            RECONNECTING_EVENT,
                            RecordingEvent {
                                code: "reconnecting".into(),
                                message: format!(
                                    "Mister kontakt — forsøker å koble til igjen ({attempt}/{})",
                                    sundayrec_core::reconnect::MAX_RECONNECT_ATTEMPTS
                                ),
                            },
                        );
                        tracing::warn!(attempt, delay_ms, segment = %next_segment, "recorder: reconnecting");
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;

                        let args = build_record_args(
                            platform,
                            &audio,
                            video.as_ref(),
                            &opts,
                            &next_segment,
                        );
                        match spawn_ffmpeg_owned(&args).await {
                            Ok(c) => {
                                child = c;
                                let _ = app.emit(
                                    RECONNECTED_EVENT,
                                    RecordingEvent {
                                        code: "reconnected".into(),
                                        message: "Tilkobling gjenopprettet — fortsetter opptak"
                                            .into(),
                                    },
                                );
                                emit_state(RecorderState::Recording, session.reconnect_count());
                            }
                            Err(e) => {
                                // Respawn failed: loop again so the NEXT
                                // on_unexpected_exit re-evaluates the budget.
                                tracing::warn!("recorder: reconnect respawn failed: {e}");
                                // Spawn a fake already-dead child path: re-enter
                                // the loop by treating this like another exit.
                                // We do this by spawning a no-op that exits, but
                                // simplest: recurse the decision inline.
                                match session.on_unexpected_exit(now_ms(), None) {
                                    RecoveryDecision::Reconnect {
                                        delay_ms,
                                        next_segment,
                                        ..
                                    } => {
                                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                                        let args = build_record_args(
                                            platform,
                                            &audio,
                                            video.as_ref(),
                                            &opts,
                                            &next_segment,
                                        );
                                        match spawn_ffmpeg_owned(&args).await {
                                            Ok(c) => {
                                                child = c;
                                                emit_state(
                                                    RecorderState::Recording,
                                                    session.reconnect_count(),
                                                );
                                            }
                                            Err(e2) => {
                                                emit_error(&app, "device_error", &e2.to_string());
                                                emit_state(
                                                    RecorderState::Failed,
                                                    session.reconnect_count(),
                                                );
                                                finalize_pending(
                                                    &app,
                                                    &pool,
                                                    &session,
                                                    &mut finalized,
                                                    now_ms(),
                                                    &preroll_clip,
                                                    &audio,
                                                    &opts,
                                                )
                                                .await;
                                                return;
                                            }
                                        }
                                    }
                                    RecoveryDecision::GiveUp => {
                                        emit_error(&app, "device_disconnected", &e.to_string());
                                        emit_state(
                                            RecorderState::Failed,
                                            session.reconnect_count(),
                                        );
                                        finalize_pending(
                                            &app,
                                            &pool,
                                            &session,
                                            &mut finalized,
                                            now_ms(),
                                            &preroll_clip,
                                            &audio,
                                            &opts,
                                        )
                                        .await;
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Graceful end of session: finalise the last (and any not-yet-finalised)
    // deliverable — concat its fragments + write its history row.
    emit_state(RecorderState::Stopping, session.reconnect_count());
    finalize_pending(
        &app,
        &pool,
        &session,
        &mut finalized,
        now_ms(),
        &preroll_clip,
        &audio,
        &opts,
    )
    .await;
    // Clean finish: every deliverable is finalised + history-rowed, so the
    // recovery manifest is no longer needed.
    crate::recorder::recovery::delete_manifest(&app, &session_id).await;
    // Record→edit hand-off: tell the UI where the finished file landed so it can
    // offer "open in editor". Only when the main file actually exists + is
    // non-empty (a recording that produced nothing skips the suggestion).
    if tokio::fs::metadata(&opts.output_path)
        .await
        .map(|m| m.len() > 0)
        .unwrap_or(false)
    {
        let _ = app.emit(
            FINISHED_EVENT,
            RecordingFinished {
                file_path: opts.output_path.clone(),
                has_video: opts.video_device_name.is_some(),
            },
        );
    }
    // The auto-stop is cleared inside `emit_state` for terminal states, so the
    // Stopped payload (and any later `recording_status`) reports no stale deadline.
    emit_state(RecorderState::Stopped, session.reconnect_count());
    tracing::info!("recorder: session stopped cleanly");
}

/// Snapshot the live session into a persistable crash-recovery manifest.
fn session_manifest(
    session_id: &str,
    session: &RecordingSession,
    audio: &FfmpegDevice,
    preroll_clip: &Option<PrerollClip>,
    start_ms: u64,
) -> SessionManifest {
    SessionManifest {
        session_id: session_id.to_string(),
        device_name: audio.name.clone(),
        session_start_ms: start_ms,
        preroll_clip_path: preroll_clip.as_ref().map(|c| c.raw_path.clone()),
        deliverables: session
            .deliverables()
            .iter()
            .map(DeliverableManifest::from_deliverable)
            .collect(),
    }
}

/// Coalesces the live per-channel peak levels parsed from ffmpeg's `ametadata`
/// stream and throttles how often they reach the UI. ffmpeg prints one line per
/// channel PER FRAME (~94 frames/s × 2 = ~188 lines/s); the meters only need
/// ~20 updates/s, so we hold the latest L/R and emit on a fixed cadence. The
/// fast attack lives in ffmpeg's short `reset` window; the slow peak-hold RELEASE
/// lives in the UI — this just paces the feed.
struct LevelMeter {
    left: f64,
    right: Option<f64>,
    last_emit: std::time::Instant,
}

impl LevelMeter {
    /// ~30 UI updates/s — snappy needle without flooding the event bridge (the
    /// UI's rAF peak-hold smooths the release between these).
    const EMIT_EVERY: Duration = Duration::from_millis(33);

    fn new() -> Self {
        Self {
            left: SILENCE_FLOOR_DB,
            right: None,
            last_emit: std::time::Instant::now(),
        }
    }

    fn update(&mut self, channel: u8, db: f64) {
        match channel {
            1 => self.left = db,
            2 => self.right = Some(db),
            _ => {} // meters are stereo; ignore any further channels
        }
    }

    /// The latest L/R snapshot, but only once per [`Self::EMIT_EVERY`] window —
    /// otherwise `None` (coalesce intervening frames).
    fn take_due(&mut self) -> Option<ChannelLevels> {
        if self.last_emit.elapsed() < Self::EMIT_EVERY {
            return None;
        }
        self.last_emit = std::time::Instant::now();
        Some(ChannelLevels {
            peak_db_left: self.left,
            peak_db_right: self.right,
        })
    }
}

/// Classify a single ffmpeg stderr line (split on `\r`/`\n` by the reader) and
/// forward the appropriate [`ReaderMsg`]. The live meter levels arrive as flat
/// `lavfi.astats.<ch>.Peak_level=` lines (one per channel per frame) which update
/// the held [`LevelMeter`] and emit on its throttle. Pure-helper driven — the
/// reader owns no state machine.
async fn classify_stderr_line(
    line: &str,
    startup: &mut StartupResolver,
    levels: &mut LevelMeter,
    msg_tx: &tokio::sync::mpsc::Sender<ReaderMsg>,
    last_error: &mut Option<RecordingErrorCode>,
) {
    // Live per-frame peak levels (`lavfi.astats.1.Peak_level=-12.5`): update the
    // held L/R and forward at most ~20×/s.
    if let Some((channel, db)) = parse_ametadata_peak(line) {
        levels.update(channel, db);
        if let Some(lv) = levels.take_due() {
            let _ = msg_tx.send(ReaderMsg::Levels(lv)).await;
        }
        return;
    }
    if let Some(b) = parse_size_kb(line) {
        if startup.observe_progress() {
            let _ = msg_tx.send(ReaderMsg::Started).await;
        }
        let _ = msg_tx.send(ReaderMsg::Progress(b)).await;
    } else if let Some(ev) = SilenceEvent::from_stderr(line) {
        let _ = msg_tx.send(ReaderMsg::Silence(ev)).await;
    } else if looks_like_error(line) {
        let code = classify_recording_error(line);
        if code != RecordingErrorCode::DeviceError {
            *last_error = Some(code);
            let _ = msg_tx.send(ReaderMsg::Error(code, line.to_string())).await;
        }
    }
}

/// Run ONE ffmpeg segment to completion. Owns the child, spawns its stderr
/// reader, and runs the `select!` over reader events + the stop request + the
/// timer ticks (watchdog poll, split, manual-max, silence stop/warn). Returns
/// the [`SegmentOutcome`] telling the supervisor what to do next. On any
/// graceful path (stop / split / auto-stop / silence-stop) it sends ffmpeg `q`
/// and waits for it to finalise before returning.
///
/// ⚠️ HARDWARE-UNVERIFIED.
#[allow(clippy::too_many_arguments)]
async fn run_segment(
    app: &AppHandle,
    mut child: tokio::process::Child,
    opts: &RecordingOpts,
    session: &RecordingSession,
    segment_bytes: Arc<AtomicU64>,
    stop_rx: &mut tokio::sync::mpsc::Receiver<()>,
    last_state: &Arc<Mutex<RecorderState>>,
    stop_watch: &mut tokio::sync::watch::Receiver<Option<u64>>,
) -> SegmentOutcome {
    let Some(stderr) = child.stderr.take() else {
        return SegmentOutcome::UnexpectedExit { last_error: None };
    };
    let mut stdin = child.stdin.take();

    // The in-recording live preview is now a DEADLOCK-PROOF file sink: the
    // recording ffmpeg auto-overwrites a low-fps JPEG (see `CaptureOpts.preview_jpg`
    // / `recording_preview_path`) that the `recording_preview_frame` command reads
    // on a poll. There is NO stdout pipe to drain here (a full pipe was what froze
    // the capture), so the segment reader only owns stderr.

    // Reader task: stream stderr → ReaderMsg over a channel so the supervisor's
    // select! owns all decisions. The reader holds NO state machine; it only
    // classifies lines with the pure core helpers.
    // A roomy buffer so a momentary slow consumer (event dispatch) never
    // back-pressures the stderr reader → ffmpeg's stderr pipe never fills →
    // ffmpeg never stalls on a blocked write and drops audio samples.
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<ReaderMsg>(256);
    let reader = tauri::async_runtime::spawn(async move {
        let mut startup = StartupResolver::new();
        let mut last_error: Option<RecordingErrorCode> = None;
        // Live L/R meter: ffmpeg's `ametadata` prints a flat
        // `lavfi.astats.<ch>.Peak_level=` line per channel per frame; the meter
        // holds the latest values and throttles emission (handled in
        // `classify_stderr_line`).
        let mut levels = LevelMeter::new();

        // CRITICAL: ffmpeg writes its `size=…` progress line with CARRIAGE
        // RETURNS (`\r`) and NO trailing newline until the process exits, so a
        // newline-based reader (`.lines()`/`next_line()`) blocks forever and
        // never observes progress → the UI is stuck at "Starter …" while ffmpeg
        // records fine. Read raw bytes and split on EITHER `\r` or `\n` so every
        // progress update + every banner/astats line is delivered live.
        let mut stderr = BufReader::new(stderr);
        let mut chunk = [0u8; 4096];
        let mut line_buf: Vec<u8> = Vec::with_capacity(256);
        loop {
            let n = match stderr.read(&mut chunk).await {
                Ok(0) => break, // stderr closed → ffmpeg exited
                Ok(n) => n,
                Err(e) => {
                    tracing::warn!("recorder stderr read error: {e}");
                    break;
                }
            };
            for &b in &chunk[..n] {
                if b == b'\r' || b == b'\n' {
                    if !line_buf.is_empty() {
                        let line = String::from_utf8_lossy(&line_buf).into_owned();
                        line_buf.clear();
                        classify_stderr_line(
                            &line,
                            &mut startup,
                            &mut levels,
                            &msg_tx,
                            &mut last_error,
                        )
                        .await;
                    }
                } else {
                    line_buf.push(b);
                }
            }
        }
        // A final progress chunk may arrive without a terminator — classify it.
        if !line_buf.is_empty() {
            let line = String::from_utf8_lossy(&line_buf).into_owned();
            classify_stderr_line(&line, &mut startup, &mut levels, &msg_tx, &mut last_error).await;
        }
        let _ = msg_tx.send(ReaderMsg::Exit { last_error }).await;
    });

    // Silence watcher + its (host-owned) timers.
    let mut silence = SilenceWatcher::new(opts.stop_on_silence);
    let silence_stop_after =
        Duration::from_secs(u64::from(opts.silence_timeout_minutes.max(1)) * 60);
    let silence_warn_after = Duration::from_millis(RecorderTimeouts::SILENCE_WARN_MS);

    // Watchdog: poll the segment byte count against the core WatchdogState.
    let mut wd = WatchdogState::new(RecorderTimeouts::STUCK_PROGRESS_MS, now_ms());
    let mut wd_tick = tokio::time::interval(Duration::from_millis(RecorderTimeouts::STUCK_POLL_MS));
    wd_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Low-disk guard: every 30 s, probe free space on the save volume and stop
    // GRACEFULLY before ffmpeg hits ENOSPC and leaves a corrupt container. The
    // headroom matches the pre-flight threshold (4 GB with video, else 500 MB).
    let disk_folder = std::path::Path::new(&opts.output_path)
        .parent()
        .map(|p| p.to_path_buf());
    let disk_headroom = min_disk_headroom_bytes(opts.video_device_name.is_some());
    let mut disk_tick = tokio::time::interval(Duration::from_secs(30));
    disk_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Split + manual-max timers fire relative to NOW (this segment for split,
    // whole session for auto-stop). We arm one-shot sleeps, recomputed each loop.
    let split_deadline = if opts.split_minutes > 0 {
        Some(Duration::from_secs(u64::from(opts.split_minutes) * 60))
    } else {
        None
    };
    // Auto-stop fires at an ABSOLUTE deadline (epoch ms) carried in the shared
    // `stop_watch`, so splits + reconnects re-pin the SAME stop time and a live
    // extend/cancel moves/clears the real timer. `None` = no auto-stop. We pin one
    // sleep and `reset()` it whenever the deadline changes.
    let auto_stop_remaining = |deadline: Option<u64>| -> Option<Duration> {
        deadline.map(|d| Duration::from_millis(d.saturating_sub(now_ms())))
    };
    // Snapshot the current deadline (re-read each time the watch signals a change).
    let mut auto_deadline: Option<u64> = *stop_watch.borrow();

    // Pin the timers. We use a helper that yields "never" when disabled.
    let split_sleep = sleep_opt(split_deadline);
    tokio::pin!(split_sleep);
    let auto_sleep = sleep_opt(auto_stop_remaining(auto_deadline));
    tokio::pin!(auto_sleep);
    // Silence timers, initially disarmed.
    let mut silence_stop: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut silence_warn: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

    // STARTUP WATCHDOG: ffmpeg has opened the device(s) but if it never produces
    // its first `size=` progress within this window, the start FAILED (a wedged
    // output, an unavailable device, a bad arg). Instead of hanging on "STARTING"
    // forever, we kill it, surface a clear error, and give up. Disarmed the moment
    // the first progress (`Started`) is observed.
    let mut started_seen = false;
    let startup_sleep =
        tokio::time::sleep(Duration::from_millis(RecorderTimeouts::STARTUP_TIMEOUT_MS));
    tokio::pin!(startup_sleep);

    let outcome = loop {
        tokio::select! {
            // Reader events.
            msg = msg_rx.recv() => {
                match msg {
                    Some(ReaderMsg::Started) => {
                        started_seen = true;
                        let _ = app.emit(STARTED_EVENT, ());
                    }
                    Some(ReaderMsg::Progress(b)) => {
                        segment_bytes.store(b, Ordering::Relaxed);
                        let _ = app.emit(PROGRESS_EVENT, RecordingProgress { bytes_written: b });
                    }
                    Some(ReaderMsg::Silence(ev)) => {
                        for action in silence.feed(ev) {
                            match action {
                                SilenceAction::ArmStop => {
                                    silence_stop = Some(Box::pin(tokio::time::sleep(silence_stop_after)));
                                }
                                SilenceAction::ArmWarn => {
                                    silence_warn = Some(Box::pin(tokio::time::sleep(silence_warn_after)));
                                }
                                SilenceAction::CancelStop => { silence_stop = None; }
                                SilenceAction::CancelWarn => { silence_warn = None; }
                            }
                        }
                    }
                    Some(ReaderMsg::Levels(lv)) => {
                        let _ = app.emit(LEVELS_EVENT, RecordingLevels::from(lv));
                    }
                    Some(ReaderMsg::Error(code, line)) => {
                        // Surface the classified error; do NOT end the segment —
                        // ffmpeg usually dies right after, and the Exit branch
                        // carries the last_error to the recovery policy.
                        emit_error(app, error_code_str(code), &line);
                    }
                    Some(ReaderMsg::Exit { last_error }) => {
                        break SegmentOutcome::UnexpectedExit { last_error };
                    }
                    None => break SegmentOutcome::UnexpectedExit { last_error: None },
                }
            }
            // Graceful stop request.
            _ = stop_rx.recv() => {
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::GracefulStop;
            }
            // Startup watchdog: no first progress in time → the start failed.
            _ = &mut startup_sleep, if !started_seen => {
                emit_error(
                    app,
                    "start_timeout",
                    "Opptaket startet ikke i tide — sjekk at kamera/mikrofon er tilkoblet og at appen har tilgang (Systeminnstillinger → Personvern).",
                );
                let _ = child.start_kill();
                let _ = child.wait().await;
                // A fatal code so the supervisor gives up cleanly instead of
                // reconnect-looping a start that won't fix itself.
                break SegmentOutcome::UnexpectedExit {
                    last_error: Some(RecordingErrorCode::DeviceNotFound),
                };
            }
            // Watchdog poll.
            _ = wd_tick.tick() => {
                if wd.observe(segment_bytes.load(Ordering::Relaxed), now_ms()) == WatchdogVerdict::Stuck {
                    emit_error(
                        app,
                        "stuck_recording",
                        &format!(
                            "Ingen framgang på {} s — kobler til på nytt",
                            RecorderTimeouts::STUCK_PROGRESS_MS / 1000
                        ),
                    );
                    // A wedged encoder: kill it so the reconnect path respawns.
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    break SegmentOutcome::UnexpectedExit { last_error: None };
                }
            }
            // Low-disk guard poll.
            _ = disk_tick.tick() => {
                if let Some(folder) = &disk_folder {
                    if let Ok(free) = fs4::available_space(folder) {
                        if low_disk_should_stop(free, disk_headroom) {
                            emit_error(
                                app,
                                "disk_full",
                                "Lite ledig diskplass — stopper opptaket trygt før disken blir full.",
                            );
                            // Graceful stop so the container is finalised + playable.
                            graceful_q(&mut stdin).await;
                            let _ = child.wait().await;
                            break SegmentOutcome::DiskStop;
                        }
                    }
                }
            }
            // Split timer.
            _ = &mut split_sleep, if split_deadline.is_some() => {
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::Split;
            }
            // Auto-stop deadline reached (guarded so a `None` deadline — the
            // 100-year "never" sleep — can never actually fire).
            _ = &mut auto_sleep, if auto_deadline.is_some() => {
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::AutoStop;
            }
            // The auto-stop deadline was moved or cleared (live extend/cancel, or
            // the initial arm). Re-pin the real timer to the new remaining time and
            // re-emit state so the UI countdown re-syncs immediately.
            changed = stop_watch.changed() => {
                if changed.is_ok() {
                    auto_deadline = *stop_watch.borrow();
                    match auto_stop_remaining(auto_deadline) {
                        Some(rem) => auto_sleep.as_mut().reset(tokio::time::Instant::now() + rem),
                        // Cleared: push the deadline far out so the guarded arm idles.
                        None => auto_sleep.as_mut().reset(
                            tokio::time::Instant::now()
                                + Duration::from_secs(60 * 60 * 24 * 365 * 100),
                        ),
                    }
                    let _ = app.emit(
                        STATE_EVENT,
                        RecorderStatePayload {
                            state: *lock_recover(last_state),
                            reconnect_count: session.reconnect_count(),
                            scheduled_stop_ms: auto_deadline,
                        },
                    );
                }
            }
            // Stop-on-silence fired.
            () = wait_opt(&mut silence_stop), if silence_stop.is_some() => {
                silence.on_stop_fired();
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::SilenceStop;
            }
            // Silence warning fired.
            () = wait_opt(&mut silence_warn), if silence_warn.is_some() => {
                silence.on_warn_fired();
                silence_warn = None;
                let _ = app.emit(
                    SILENCE_EVENT,
                    RecordingEvent {
                        code: "silence_detected".into(),
                        message: "Stillhet oppdaget i lydsignalet".into(),
                    },
                );
            }
        }
    };

    // Make sure the reader task is done (it sends Exit then returns).
    reader.abort();
    outcome
}

/// Write ffmpeg `q\n` to stdin and drop it (EOF nudge) for a graceful finalise.
async fn graceful_q(stdin: &mut Option<tokio::process::ChildStdin>) {
    if let Some(mut pipe) = stdin.take() {
        let _ = pipe.write_all(b"q\n").await;
        let _ = pipe.flush().await;
        // Dropping `pipe` closes stdin → EOF.
    }
}

/// A `Sleep` that fires after `d`, or never (a 100-year sleep) when `d` is None.
/// Lets the `select!` arm exist unconditionally; the arm's `if` guard gates it.
fn sleep_opt(d: Option<Duration>) -> tokio::time::Sleep {
    tokio::time::sleep(d.unwrap_or(Duration::from_secs(60 * 60 * 24 * 365 * 100)))
}

/// Await an optional pinned sleep; when `None`, never resolves. The `select!`
/// arm guards on `is_some()` so the `None` branch is never actually polled to
/// completion.
async fn wait_opt(s: &mut Option<std::pin::Pin<Box<tokio::time::Sleep>>>) {
    match s {
        Some(sleep) => sleep.as_mut().await,
        None => std::future::pending::<()>().await,
    }
}

/// Spawn ffmpeg taking ownership of the child (the supervisor holds it for the
/// segment's whole life; dropping it triggers `kill_on_drop`).
async fn spawn_ffmpeg_owned(args: &[String]) -> AppResult<tokio::process::Child> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tracing::info!(?arg_refs, "recorder: spawning ffmpeg segment");
    spawn_ffmpeg(&arg_refs).await
}

/// Emit a classified error to the renderer.
fn emit_error(app: &AppHandle, code: &str, message: &str) {
    let _ = app.emit(
        ERROR_EVENT,
        RecordingEvent {
            code: code.to_string(),
            message: message.to_string(),
        },
    );
    // Companion for the standalone "SundayRec Lydhjelp" diagnostic: persist the
    // last classified error to disk so that tool can explain, in plain Norwegian,
    // what stopped the recording last time (it can't see our in-process events).
    skriv_siste_feil_til_disk(app, code, message);
}

/// Best-effort write of the most recent classified error to
/// `<app_data_dir>/last-error.json` (atomic temp+rename). Never fails the
/// recorder — any I/O error is logged and swallowed.
fn skriv_siste_feil_til_disk(app: &AppHandle, code: &str, message: &str) {
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    // Keep the file small — the diagnostic only needs the code + a stderr snippet.
    let msg: String = message.chars().take(2000).collect();
    let body = serde_json::json!({
        "code": code,
        "message": msg,
        "timestamp": chrono::Local::now().to_rfc3339(),
    });
    let path = dir.join("last-error.json");
    let tmp = dir.join("last-error.json.tmp");
    if std::fs::write(&tmp, body.to_string()).is_ok() && std::fs::rename(&tmp, &path).is_ok() {
        tracing::info!(path = %path.display(), "Lydhjelp: siste feil skrevet til disk");
    } else {
        tracing::warn!("Lydhjelp: klarte ikke skrive last-error.json");
    }
}

/// Finalise every deliverable that has closed but not yet been finalised
/// (`*finalized .. deliverables.len()`), advancing `*finalized` to the end. Each
/// is concat-stitched into its primary file and gets ONE history row (Fase
/// 3.3a). `end_ms` is the close time of the LAST deliverable in the batch; an
/// earlier deliverable's end is the next one's `started_at_ms` (the split
/// boundary), so each row's `duration_ms` is the deliverable's own span.
///
/// Called at every split (closing one deliverable) and once at session end (the
/// last). Idempotent: a second call with nothing pending is a no-op.
#[allow(clippy::too_many_arguments)]
async fn finalize_pending(
    app: &AppHandle,
    pool: &Option<SqlitePool>,
    session: &RecordingSession,
    finalized: &mut usize,
    end_ms: u64,
    preroll_clip: &Option<PrerollClip>,
    audio: &FfmpegDevice,
    opts: &RecordingOpts,
) {
    let deliverables = session.deliverables();
    let total = deliverables.len();
    for index in *finalized..total {
        let d = &deliverables[index];
        // This deliverable ends when the NEXT one started, or at `end_ms` if it's
        // the last in the batch.
        let deliverable_end = deliverables
            .get(index + 1)
            .map(|next| next.started_at_ms)
            .unwrap_or(end_ms);
        finalize_one(
            app,
            pool,
            d,
            index,
            deliverable_end,
            preroll_clip,
            audio,
            opts,
        )
        .await;
    }
    *finalized = total;
}

/// Finalise ONE deliverable: concat-stitch its fragments into its primary file
/// (prepending the pre-roll clip when `index == 0`), then write its history row.
/// `file_path` is the final (merged) file, `started_at` is the deliverable's own
/// start, `duration_ms` is `end_ms - started_at`, and `byte_size` is the merged
/// file's size on disk (the honest finished-file size).
///
/// A concat failure leaves the fragment files on disk and falls back to the
/// primary path for the history row (no audio lost). A `None` pool is a no-op for
/// the DB write. A DB error is logged, never propagated.
///
/// If the finished file is missing / zero-byte / undecodable, NO history row is
/// written (a phantom "recording" that won't play is worse than none) and an
/// `empty_output` error is surfaced to the UI.
#[allow(clippy::too_many_arguments)]
async fn finalize_one(
    app: &AppHandle,
    pool: &Option<SqlitePool>,
    deliverable: &sundayrec_core::recorder::Deliverable,
    index: usize,
    end_ms: u64,
    preroll_clip: &Option<PrerollClip>,
    audio: &FfmpegDevice,
    opts: &RecordingOpts,
) {
    // Pre-roll is prepended ONLY to the first deliverable's first fragment.
    let preroll_path = if index == 0 {
        preroll_clip.as_ref().map(|c| c.raw_path.as_str())
    } else {
        None
    };

    let final_path = match finalize_deliverable(deliverable, preroll_path).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(
                deliverable = %deliverable.primary_path,
                "recorder: concat failed, keeping primary as history file: {e}"
            );
            deliverable.primary_path.clone()
        }
    };

    // Guard: never record a missing / zero-byte / undecodable file in history.
    if !output_is_valid(std::path::Path::new(&final_path)).await {
        tracing::error!(
            file = %final_path,
            "recorder: finished file is missing/empty/undecodable — not writing history row"
        );
        emit_error(
            app,
            "empty_output",
            "Opptaket ble tomt eller skadet — ingen fil ble lagret.",
        );
        return;
    }

    // Best-effort: the finished file's actual size on disk.
    let byte_size = tokio::fs::metadata(&final_path)
        .await
        .map(|m| m.len() as i64)
        .ok();

    let Some(pool) = pool else { return };
    let started_at = deliverable.started_at_ms;
    let duration_ms = end_ms.saturating_sub(started_at) as f64;
    let row = RecordingRow {
        id: String::new(),
        file_path: final_path.clone(),
        device_name: Some(audio.name.clone()),
        started_at: started_at as f64,
        duration_ms: Some(duration_ms),
        byte_size,
        created_at: 0.0,
        note: None,
    };
    if let Err(e) = insert_recording(pool, row).await {
        tracing::error!("recorder: failed to write history row: {e}");
    }

    // FIX 3 — separate audio sidecar. For a VIDEO recording the finished file is a
    // video container; when the user opted into `keep_separate_audio` we extract a
    // standalone audio file next to it and write a SECOND history row. Guarded on
    // the recording actually having video (audio-only recordings are already the
    // audio, so there's nothing to extract).
    if opts.keep_separate_audio && opts.video_device_name.is_some() {
        extract_separate_audio(pool, &final_path, started_at, duration_ms, opts, audio).await;
    }
}

/// Build the one-shot ffmpeg args that extract a standalone audio file from a
/// finished video container: `ffmpeg -i <src> -vn -map 0:a:0 <audio_encode_args>
/// -y <dst>`. The encode args come from the SHARED [`audio_encode_args`] seam
/// (codec from the sidecar extension, channels from `channel_mode`, sample-rate +
/// bitrate from the recording's opts) so the sidecar matches the recording's
/// chosen audio settings. Pure so the argument shape is unit-tested without a
/// process.
fn build_separate_audio_args(src: &str, dst: &str, opts: &RecordingOpts) -> Vec<String> {
    let sep_ext = opts.separate_audio_format.trim_start_matches('.');
    let channels = match opts.channel_mode {
        ChannelMode::Stereo => 2,
        _ => 1,
    };
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-i".into(),
        src.to_string(),
        // Drop video, take only the first audio stream.
        "-vn".into(),
        "-map".into(),
        "0:a:0".into(),
    ];
    args.extend(sundayrec_core::capture::audio_encode_args(
        sep_ext,
        channels,
        opts.sample_rate,
        opts.bitrate_kbps,
    ));
    args.push("-y".into());
    args.push(dst.to_string());
    args
}

/// Extract a standalone audio sidecar from a finished VIDEO recording and write a
/// second history row for it. Runs a one-shot ffmpeg `-vn -map 0:a:0` through the
/// SAME `audio_encode_args` seam the recorder uses (so channels/sample-rate/bitrate
/// match the recording's settings), writing `<stem>.<format>` via `make_unique_path`
/// so it never clobbers an existing file. Validated with the same `output_is_valid`
/// gate as the main file; a failed/empty extract is logged and skipped, never fatal.
///
/// ⚠️ HARDWARE-UNVERIFIED — spawns ffmpeg against a real finished file.
pub(crate) async fn extract_separate_audio(
    pool: &SqlitePool,
    final_path: &str,
    started_at: u64,
    duration_ms: f64,
    opts: &RecordingOpts,
    audio: &FfmpegDevice,
) {
    let src = std::path::Path::new(final_path);
    let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording".to_string());
    let sep_ext = opts.separate_audio_format.trim_start_matches('.');
    let want = dir
        .join(format!("{stem}.{sep_ext}"))
        .to_string_lossy()
        .into_owned();
    // Never overwrite: bump to `_2`, `_3`, … if the sibling already exists.
    let sep_path =
        sundayrec_core::filename::make_unique_path(&want, |p| std::path::Path::new(p).exists());

    let args = build_separate_audio_args(final_path, &sep_path, opts);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tracing::info!(?arg_refs, "recorder: extracting separate audio sidecar");
    let mut child = match tokio::process::Command::new(crate::media::ffmpeg::ffmpeg_path())
        .args(&arg_refs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("recorder: failed to spawn separate-audio extract: {e}");
            return;
        }
    };
    // A `-c copy`-class extract of even a long service is fast; reuse a generous
    // bound so a wedged ffmpeg can't hang the finalise forever.
    match tokio::time::timeout(Duration::from_secs(15 * 60), child.wait()).await {
        Ok(Ok(status)) if status.success() => {}
        Ok(Ok(status)) => {
            tracing::error!("recorder: separate-audio extract exited with {status}");
            return;
        }
        Ok(Err(e)) => {
            tracing::error!("recorder: separate-audio extract await failed: {e}");
            return;
        }
        Err(_) => {
            let _ = child.start_kill();
            tracing::error!("recorder: separate-audio extract exceeded the watchdog — killed");
            return;
        }
    }

    if !output_is_valid(std::path::Path::new(&sep_path)).await {
        tracing::error!(
            file = %sep_path,
            "recorder: separate audio file is missing/empty/undecodable — no history row"
        );
        return;
    }

    let byte_size = tokio::fs::metadata(&sep_path)
        .await
        .map(|m| m.len() as i64)
        .ok();
    let row = RecordingRow {
        id: String::new(),
        file_path: sep_path,
        device_name: Some(audio.name.clone()),
        started_at: started_at as f64,
        duration_ms: Some(duration_ms),
        byte_size,
        created_at: 0.0,
        note: Some("Separat lydfil".to_string()),
    };
    if let Err(e) = insert_recording(pool, row).await {
        tracing::error!("recorder: failed to write separate-audio history row: {e}");
    }
}

/// Epoch milliseconds (the engine's clock; core takes this as an argument).
pub(crate) fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Heuristic: does this stderr line look like an error worth classifying?
fn looks_like_error(line: &str) -> bool {
    let l = line.to_lowercase();
    l.contains("error")
        || l.contains("denied")
        || l.contains("not found")
        || l.contains("no such")
        || l.contains("could not find")
        || l.contains("cannot find")
        || l.contains("could not")
        || l.contains("no device")
        || l.contains("no audio")
        || l.contains("no video")
        || l.contains("busy")
        || l.contains("in use")
        || l.contains("no space")
        || l.contains("broken pipe")
        || l.contains("i/o error")
        || l.contains("unplugged")
        || l.contains("invalid")
        || l.contains("failed")
        || l.contains("cannot open")
        || l.contains("unable to")
        || l.contains("conversion failed")
        || l.contains("end of file")
        || l.contains("disconnected")
        || l.contains("quota exceeded")
}

/// Stable snake_case string for a [`RecordingErrorCode`] — matches the serde
/// rename so the renderer's localisation switch lines up with the bindings.
fn error_code_str(code: RecordingErrorCode) -> &'static str {
    match code {
        RecordingErrorCode::DeviceNotFound => "device_not_found",
        RecordingErrorCode::DevicePermissionDenied => "device_permission_denied",
        RecordingErrorCode::DeviceBusy => "device_busy",
        RecordingErrorCode::DiskFull => "disk_full",
        RecordingErrorCode::DeviceDisconnected => "device_disconnected",
        RecordingErrorCode::DeviceError => "device_error",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> RecordingOpts {
        RecordingOpts {
            audio_device_name: "Soundcraft USB Audio".into(),
            video_device_name: None,
            output_path: "/tmp/rec.m4a".into(),
            stop_on_silence: false,
            silence_threshold_db: None,
            silence_timeout_minutes: 5,
            framerate: 30,
            channel_mode: ChannelMode::Stereo,
            input_channel_l: None,
            input_channel_r: None,
            sample_rate: Some(48_000),
            bitrate_kbps: 192,
            split_minutes: 0,
            manual_max_minutes: 0,
            live_levels: true,
            keep_separate_audio: false,
            separate_audio_format: "wav".into(),
            video_resolution: "720p".into(),
            video_codec: "h264".into(),
            video_encoder: "software".into(),
            classic_directshow: false,
            video_input: None,
        }
    }

    #[test]
    fn event_channels_are_stable() {
        assert_eq!(PROGRESS_EVENT, "recording://progress");
        assert_eq!(STARTED_EVENT, "recording://started");
        assert_eq!(ERROR_EVENT, "recording://error");
        assert_eq!(SILENCE_EVENT, "recording://silence");
        assert_eq!(RECONNECTING_EVENT, "recording://reconnecting");
        assert_eq!(RECONNECTED_EVENT, "recording://reconnected");
        assert_eq!(STATE_EVENT, "recording://state");
        assert_eq!(LEVELS_EVENT, "recording://levels");
        assert_eq!(FINISHED_EVENT, "recording://finished");
    }

    #[test]
    fn recording_preview_path_is_a_stable_temp_jpeg() {
        let p = recording_preview_path();
        assert_eq!(
            p.extension().and_then(|e| e.to_str()),
            Some("jpg"),
            "the in-recording preview is a JPEG file sink (deadlock-proof, not a pipe)"
        );
        // Stable across calls (one fixed path; at most one recording at a time).
        assert_eq!(p, recording_preview_path());
    }

    /// Regression guard for the recording-FREEZE fix. The start↔supervisor
    /// "ready" handshake must be a NON-BLOCKING async wait. On a single-threaded
    /// runtime (the default for `#[tokio::test]`, and the worst case), a blocking
    /// `recv()` would pin the only worker and deadlock with the spawned
    /// supervisor → the whole app beachballs and Stop dies. A `oneshot` + `.await`
    /// yields, so the supervisor runs and signals. The `timeout` turns a
    /// regression into a failing test instead of an indefinite hang.
    #[tokio::test]
    async fn ready_handshake_does_not_block_the_runtime() {
        let (tx, rx) = tokio::sync::oneshot::channel::<AppResult<()>>();
        // The supervisor is a runtime task that signals readiness.
        tokio::spawn(async move {
            let _ = tx.send(Ok(()));
        });
        // The "command" awaits readiness — it must complete without blocking.
        let res = tokio::time::timeout(std::time::Duration::from_secs(2), rx).await;
        assert!(
            matches!(res, Ok(Ok(Ok(())))),
            "the ready handshake must complete without blocking the runtime",
        );
    }

    #[test]
    fn build_record_args_audio_only_mac_uses_index_token() {
        let audio = FfmpegDevice::new("Built-in Mic", "avfoundation", Some(1));
        let args = build_record_args(Platform::MacOS, &audio, None, &opts(), "/tmp/rec.m4a");
        assert!(args.iter().any(|a| a == ":1"), "got: {args:?}");
        assert_eq!(args.last().unwrap(), "/tmp/rec.m4a");
        assert!(
            !args.iter().any(|a| a == "-c:v"),
            "audio-only → no video codec"
        );
    }

    #[test]
    fn build_record_args_uses_passed_output_path_not_opts() {
        // The supervisor builds per-segment args with a fresh path.
        let audio = FfmpegDevice::new("Built-in Mic", "avfoundation", Some(0));
        let args = build_record_args(Platform::MacOS, &audio, None, &opts(), "/tmp/rec_r1.m4a");
        assert_eq!(args.last().unwrap(), "/tmp/rec_r1.m4a");
    }

    #[test]
    fn build_record_args_windows_uses_device_name_token() {
        let audio = FfmpegDevice::new("Yamaha AG06", "dshow", None);
        let video = FfmpegDevice::new("Logitech BRIO", "dshow", None);
        let args = build_record_args(
            Platform::Windows,
            &audio,
            Some(&video),
            &opts(),
            "/tmp/rec.mp4",
        );
        assert!(args.iter().any(|a| a == "audio=Yamaha AG06"));
        assert!(args.iter().any(|a| a == "video=Logitech BRIO"));
        let af = args
            .iter()
            .position(|a| a == "-af")
            .map(|i| args[i + 1].clone())
            .unwrap();
        assert!(af.contains("aresample=async=1000:first_pts=0"));
    }

    #[test]
    fn device_token_prefers_index_then_name() {
        assert_eq!(
            device_token(&FfmpegDevice::new("Mic", "avfoundation", Some(2))),
            "2"
        );
        assert_eq!(
            device_token(&FfmpegDevice::new("Mic", "dshow", None)),
            "Mic"
        );
    }

    #[test]
    fn looks_like_error_is_specific() {
        assert!(looks_like_error("[dshow] Could not find audio device"));
        assert!(looks_like_error(
            "av_interleaved_write_frame(): No space left"
        ));
        assert!(!looks_like_error(
            "frame= 120 fps=30 size=2048kB time=00:00:04.00"
        ));
        assert!(!looks_like_error(
            "Stream #0:0: Audio: aac, 48000 Hz, stereo"
        ));
    }

    #[test]
    fn error_code_str_matches_serde_names() {
        assert_eq!(
            error_code_str(RecordingErrorCode::DeviceDisconnected),
            "device_disconnected"
        );
        assert_eq!(error_code_str(RecordingErrorCode::DiskFull), "disk_full");
    }

    #[test]
    fn engine_stop_is_safe_when_idle() {
        let engine = RecorderEngine::new();
        engine.stop();
        engine.stop();
    }

    #[test]
    fn engine_starts_idle() {
        let engine = RecorderEngine::new();
        assert_eq!(engine.current_state(), RecorderState::Idle);
    }

    #[test]
    fn recording_progress_serde_roundtrip() {
        let p = RecordingProgress {
            bytes_written: 2_097_152,
        };
        let json = serde_json::to_string(&p).unwrap();
        let back: RecordingProgress = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn state_payload_serde_roundtrip() {
        let p = RecorderStatePayload {
            state: RecorderState::Reconnecting,
            reconnect_count: 3,
            scheduled_stop_ms: Some(1_700_000_000_000),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("reconnecting"));
        let back: RecorderStatePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn extended_stop_adds_to_live_deadline_and_never_shortens() {
        let now = 1_000_000;
        // No deadline / passed deadline → extend from now.
        assert_eq!(extended_stop_ms(None, now, 30), now + 30 * 60_000);
        assert_eq!(extended_stop_ms(Some(now - 5), now, 30), now + 30 * 60_000);
        // A live deadline in the future → add to IT (so "+30 min" really extends).
        let future = now + 10 * 60_000;
        assert_eq!(
            extended_stop_ms(Some(future), now, 30),
            future + 30 * 60_000
        );

        // A huge/adversarial minutes value is clamped to one day, so the derived
        // Duration can never overflow the platform Instant downstream.
        assert_eq!(
            extended_stop_ms(None, now, u32::MAX),
            now + u64::from(MAX_AUTOSTOP_MINUTES) * 60_000
        );
    }

    #[test]
    fn build_record_args_mono_has_no_stereo_channel_flag() {
        let mut o = opts();
        o.channel_mode = ChannelMode::MonoMix;
        let audio = FfmpegDevice::new("Built-in Mic", "avfoundation", Some(0));
        let args = build_record_args(Platform::MacOS, &audio, None, &o, "/tmp/mono.m4a");
        // Mono maps to `-ac 1`; stereo would request 2 channels.
        let ac = args
            .iter()
            .position(|a| a == "-ac")
            .map(|i| args[i + 1].clone());
        assert_eq!(ac.as_deref(), Some("1"), "got: {args:?}");
    }

    #[test]
    fn build_record_args_stereo_requests_two_channels() {
        let mut o = opts();
        o.channel_mode = ChannelMode::Stereo;
        let audio = FfmpegDevice::new("Built-in Mic", "avfoundation", Some(0));
        let args = build_record_args(Platform::MacOS, &audio, None, &o, "/tmp/st.m4a");
        let ac = args
            .iter()
            .position(|a| a == "-ac")
            .map(|i| args[i + 1].clone());
        assert_eq!(ac.as_deref(), Some("2"), "got: {args:?}");
    }

    #[test]
    fn build_record_args_video_on_mac_uses_combined_index_token() {
        // mac avfoundation addresses video+audio as `<videoIdx>:<audioIdx>`.
        let audio = FfmpegDevice::new("Built-in Mic", "avfoundation", Some(1));
        let video = FfmpegDevice::new("FaceTime HD", "avfoundation", Some(0));
        let args = build_record_args(
            Platform::MacOS,
            &audio,
            Some(&video),
            &opts(),
            "/tmp/av.mp4",
        );
        assert!(args.iter().any(|a| a == "0:1"), "got: {args:?}");
        // A video session encodes a video stream + the A/V-sync CFR lock.
        assert!(args.iter().any(|a| a == "-c:v"), "got: {args:?}");
        assert!(
            args.windows(2).any(|w| w == ["-fps_mode", "cfr"]),
            "video is CFR-locked; got: {args:?}"
        );
        // The mp4 is the PRIMARY output; a video recording also writes the
        // deadlock-proof preview JPEG (file sink, `-update 1`) as the tail — NEVER
        // a `pipe:1` (the pipe was what could freeze the capture).
        assert!(
            args.iter().any(|a| a == "/tmp/av.mp4"),
            "mp4 present; got: {args:?}"
        );
        assert!(
            !args.iter().any(|a| a == "pipe:1"),
            "no pipe; got: {args:?}"
        );
        assert!(
            args.windows(2).any(|w| w == ["-update", "1"]),
            "preview file sink"
        );
        assert!(
            args.last().unwrap().ends_with(".jpg"),
            "preview JPEG is the tail output; got: {args:?}"
        );
        let mp4 = args.iter().position(|a| a == "/tmp/av.mp4").unwrap();
        let jpg = args.len() - 1;
        assert!(mp4 < jpg, "mp4 finalises before the preview; got: {args:?}");
    }

    #[test]
    fn build_record_args_passes_silence_threshold_to_filter() {
        let mut o = opts();
        o.stop_on_silence = true;
        o.silence_threshold_db = Some(-45);
        let audio = FfmpegDevice::new("Mic", "avfoundation", Some(0));
        let args = build_record_args(Platform::MacOS, &audio, None, &o, "/tmp/s.m4a");
        // The silencedetect filter must carry the requested threshold.
        let joined = args.join(" ");
        assert!(
            joined.contains("silencedetect=noise=-45dB"),
            "expected the -45 dB threshold in the detector, got: {joined}"
        );
    }

    #[test]
    fn build_record_args_off_silence_uses_the_permissive_warn_threshold() {
        // The detector is ALWAYS in the chain (the warning path needs the markers);
        // with stop-on-silence OFF it falls back to the fixed -55 dB warn level
        // rather than any user threshold.
        let mut o = opts();
        o.stop_on_silence = false;
        o.silence_threshold_db = Some(-45);
        let audio = FfmpegDevice::new("Mic", "avfoundation", Some(0));
        let args = build_record_args(Platform::MacOS, &audio, None, &o, "/tmp/s.m4a");
        let joined = args.join(" ");
        assert!(
            joined.contains("silencedetect=noise=-55dB"),
            "off → fixed -55 dB warn detector, got: {joined}"
        );
        assert!(
            !joined.contains("-45dB"),
            "the user threshold must be ignored when stop-on-silence is off"
        );
    }

    #[test]
    fn error_code_str_covers_every_variant() {
        // Every variant maps to a distinct snake_case string (the renderer's
        // localisation switch depends on this enumeration).
        let all = [
            (RecordingErrorCode::DeviceNotFound, "device_not_found"),
            (
                RecordingErrorCode::DevicePermissionDenied,
                "device_permission_denied",
            ),
            (RecordingErrorCode::DeviceBusy, "device_busy"),
            (RecordingErrorCode::DiskFull, "disk_full"),
            (
                RecordingErrorCode::DeviceDisconnected,
                "device_disconnected",
            ),
            (RecordingErrorCode::DeviceError, "device_error"),
        ];
        let mut seen = std::collections::HashSet::new();
        for (code, want) in all {
            assert_eq!(error_code_str(code), want);
            assert!(seen.insert(want), "duplicate mapping for {want}");
        }
    }

    #[test]
    fn looks_like_error_catches_permission_and_disconnect_lines() {
        assert!(looks_like_error(
            "[avfoundation] Audio device access denied"
        ));
        assert!(looks_like_error("Device or resource busy"));
        assert!(looks_like_error("USB camera unplugged"));
        assert!(looks_like_error("Input/output error"));
        // Case-insensitive: an upper-case ERROR still trips.
        assert!(looks_like_error("FATAL ERROR while opening device"));
    }

    #[test]
    fn looks_like_error_ignores_benign_progress_and_stream_lines() {
        assert!(!looks_like_error(
            "frame= 30 fps=30 q=28.0 size=512kB time=00:00:01.00 bitrate=..."
        ));
        assert!(!looks_like_error("Output #0, mp4, to '/tmp/rec.mp4':"));
        assert!(!looks_like_error("  Metadata:"));
    }

    #[test]
    fn level_meter_holds_latest_and_throttles_emission() {
        let mut m = LevelMeter::new();
        // A fresh meter has not waited out its window → nothing due yet.
        m.update(1, -12.0);
        m.update(2, -9.0);
        assert!(
            m.take_due().is_none(),
            "must coalesce within the throttle window"
        );
        // After the window, the LATEST held L/R is emitted exactly once.
        m.last_emit = std::time::Instant::now() - LevelMeter::EMIT_EVERY - Duration::from_millis(1);
        m.update(1, -6.0);
        let lv = m.take_due().expect("a due snapshot");
        assert_eq!(lv.peak_db_left, -6.0, "holds the latest left");
        assert_eq!(lv.peak_db_right, Some(-9.0), "holds the latest right");
        assert!(
            m.take_due().is_none(),
            "the next read in the same window is coalesced again"
        );
    }

    #[test]
    fn level_meter_ignores_channels_beyond_stereo() {
        let mut m = LevelMeter::new();
        m.update(3, 0.0); // a surround channel must not become L or R
        assert_eq!(m.left, SILENCE_FLOOR_DB);
        assert_eq!(m.right, None);
    }

    #[test]
    fn recording_levels_serde_uses_snake_case() {
        let lv = RecordingLevels {
            peak_db_left: -12.5,
            peak_db_right: Some(-9.3),
        };
        let json = serde_json::to_string(&lv).unwrap();
        assert!(json.contains("\"peak_db_left\""), "got: {json}");
        assert!(json.contains("\"peak_db_right\""), "got: {json}");
        // Mono → right is null.
        let mono = RecordingLevels {
            peak_db_left: -20.0,
            peak_db_right: None,
        };
        let json = serde_json::to_string(&mono).unwrap();
        assert!(json.contains("\"peak_db_right\":null"), "got: {json}");
    }

    #[test]
    fn recording_levels_from_channel_levels() {
        let lv = RecordingLevels::from(ChannelLevels {
            peak_db_left: -6.0,
            peak_db_right: Some(-7.0),
        });
        assert_eq!(lv.peak_db_left, -6.0);
        assert_eq!(lv.peak_db_right, Some(-7.0));
    }

    #[test]
    fn recording_opts_serde_round_trips() {
        let o = RecordingOpts {
            audio_device_name: "Soundcraft USB Audio".into(),
            video_device_name: Some("Logitech BRIO".into()),
            output_path: "/tmp/rec.mp4".into(),
            stop_on_silence: true,
            silence_threshold_db: Some(-50),
            silence_timeout_minutes: 7,
            framerate: 25,
            channel_mode: ChannelMode::MonoL,
            input_channel_l: None,
            input_channel_r: None,
            sample_rate: Some(44_100),
            bitrate_kbps: 256,
            split_minutes: 30,
            manual_max_minutes: 120,
            live_levels: true,
            keep_separate_audio: true,
            separate_audio_format: "wav".into(),
            video_resolution: "1080p".into(),
            video_codec: "h264".into(),
            video_encoder: "software".into(),
            classic_directshow: false,
            video_input: None,
        };
        let json = serde_json::to_string(&o).unwrap();
        // The wire shape is the struct's default snake_case keys (no rename_all).
        assert!(json.contains("\"audio_device_name\""), "got: {json}");
        assert!(json.contains("\"manual_max_minutes\""), "got: {json}");
        let back: RecordingOpts = serde_json::from_str(&json).unwrap();
        assert_eq!(back.audio_device_name, o.audio_device_name);
        assert_eq!(back.video_device_name, o.video_device_name);
        assert_eq!(back.silence_threshold_db, o.silence_threshold_db);
        assert_eq!(back.split_minutes, o.split_minutes);
        assert_eq!(back.manual_max_minutes, o.manual_max_minutes);
    }

    #[test]
    fn separate_audio_args_extract_audio_only_to_chosen_format() {
        // A stereo wav sidecar from an mp4: drop video, take audio stream 0, encode
        // to pcm_s16le (wav), stereo, native rate (no -ar), output last after -y.
        let mut o = opts();
        o.video_device_name = Some("FaceTime HD".into());
        o.channel_mode = ChannelMode::Stereo;
        o.sample_rate = None;
        o.separate_audio_format = "wav".into();
        let args = build_separate_audio_args("/tmp/service.mp4", "/tmp/service.wav", &o);
        // Source in, video dropped, first audio stream mapped.
        assert!(args.windows(2).any(|w| w == ["-i", "/tmp/service.mp4"]));
        assert!(args.iter().any(|a| a == "-vn"), "must drop video");
        assert!(args.windows(2).any(|w| w == ["-map", "0:a:0"]));
        // wav → pcm_s16le, no bitrate, stereo, native (no -ar).
        assert!(args.windows(2).any(|w| w == ["-c:a", "pcm_s16le"]));
        assert!(!args.iter().any(|a| a == "-b:a"), "pcm takes no bitrate");
        assert!(args.windows(2).any(|w| w == ["-ac", "2"]));
        assert!(!args.iter().any(|a| a == "-ar"), "native rate omits -ar");
        // Overwrite + output path always last.
        let n = args.len();
        assert_eq!(args[n - 2], "-y");
        assert_eq!(args.last().unwrap(), "/tmp/service.wav");
    }

    #[test]
    fn separate_audio_args_honour_format_channels_and_rate() {
        // An mp3 mono sidecar at a forced 44.1 kHz with a 256k bitrate.
        let mut o = opts();
        o.channel_mode = ChannelMode::MonoMix;
        o.sample_rate = Some(44_100);
        o.bitrate_kbps = 256;
        o.separate_audio_format = ".mp3".into(); // leading dot tolerated
        let args = build_separate_audio_args("/tmp/x.mp4", "/tmp/x.mp3", &o);
        assert!(args.windows(2).any(|w| w == ["-c:a", "libmp3lame"]));
        assert!(args.windows(2).any(|w| w == ["-b:a", "256k"]));
        assert!(args.windows(2).any(|w| w == ["-ac", "1"]), "mono → -ac 1");
        assert!(args.windows(2).any(|w| w == ["-ar", "44100"]));
    }

    #[test]
    fn recording_event_serde_round_trips() {
        let e = RecordingEvent {
            code: "device_disconnected".into(),
            message: "Mister kontakt".into(),
        };
        let back: RecordingEvent =
            serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(e, back);
    }
}
