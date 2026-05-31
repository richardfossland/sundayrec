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
use sundayrec_core::capture::{build_unified_capture_args, CaptureOpts, Channels};
use sundayrec_core::device_match::{find_best_device_match, FfmpegDevice};
use sundayrec_core::errors::{classify_recording_error, RecordingErrorCode};
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::progress::{parse_size_kb, StartupResolver};
use sundayrec_core::reconnect::{WatchdogState, WatchdogVerdict};
use sundayrec_core::recorder::{RecorderState, RecordingSession, RecoveryDecision};
use sundayrec_core::silence::{SilenceAction, SilenceEvent, SilenceWatcher};
use sundayrec_core::timeouts::RecorderTimeouts;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use ts_rs::TS;

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::db::store::{insert_recording, RecordingRow};
use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::spawn_ffmpeg;
use crate::recorder::concat::finalize_deliverable;
use crate::recorder::preroll::PrerollClip;

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
    /// `true` → stereo, `false` → mono.
    pub stereo: bool,
    /// Rotate to a fresh segment every N minutes (0 = off).
    pub split_minutes: u32,
    /// Auto-stop the whole session after N minutes (0 = off).
    pub manual_max_minutes: u32,
}

/// A progress heartbeat sent to the renderer.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/RecordingProgress.ts")]
pub struct RecordingProgress {
    /// Total bytes ffmpeg has written to the current segment so far.
    #[ts(type = "number")]
    pub bytes_written: u64,
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
}

/// Map the running OS to the core [`Platform`] enum.
fn current_platform() -> Platform {
    if cfg!(target_os = "windows") {
        Platform::Windows
    } else if cfg!(target_os = "macos") {
        Platform::MacOS
    } else {
        Platform::Linux
    }
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
        channels: if opts.stereo {
            Channels::Stereo
        } else {
            Channels::Mono
        },
    };
    build_unified_capture_args(
        platform,
        video_token.as_deref(),
        &audio_token,
        output_path,
        &capture,
    )
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
}

impl Default for RecorderEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl RecorderEngine {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            last_state: Arc::new(Mutex::new(RecorderState::Idle)),
        }
    }

    /// The last state the engine emitted (best-effort; the supervisor updates it
    /// on every transition). Used by the `recording_status` command.
    pub fn current_state(&self) -> RecorderState {
        *self.last_state.lock().expect("recorder state mutex")
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
        let inv = enumerate_ffmpeg_devices().await?;
        let audio = find_best_device_match(&inv.audio_inputs, &opts.audio_device_name)
            .cloned()
            .ok_or_else(|| {
                AppError::Recording(format!(
                    "no audio device matched '{}'",
                    opts.audio_device_name
                ))
            })?;
        // Video resolution uses the dedicated video-input list + the video match
        // ladder (F2.1). None unless the user enabled video AND a name matches.
        let video = match &opts.video_device_name {
            Some(name) if !name.is_empty() => {
                sundayrec_core::device_enum::find_best_video_device_match(&inv.video_inputs, name)
                    .cloned()
            }
            _ => None,
        };

        let (stop_tx, stop_rx) = tokio::sync::mpsc::channel::<()>(1);
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<AppResult<()>>();

        let sup_app = app.clone();
        let last_state = Arc::clone(&self.last_state);
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
            )
            .await;
        });

        match ready_rx.recv() {
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

        *self.session.lock().expect("recorder mutex") = Some(RecorderSession {
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
        let session = self.session.lock().expect("recorder mutex").take();
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
) {
    {
        let mut guard = last_state.lock().expect("recorder state mutex");
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
        },
    );
}

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
    ready: std::sync::mpsc::Sender<AppResult<()>>,
    last_state: Arc<Mutex<RecorderState>>,
) {
    let start_ms = now_ms();
    let mut session = RecordingSession::new(opts.output_path.clone(), start_ms);
    // How many deliverables have already been finalised (concat + history row).
    // Each split closes one; session end finalises the rest. The pre-roll clip is
    // prepended only to deliverable 0 (`finalize_one` checks `index == 0`).
    let mut finalized: usize = 0;
    set_state(&app, &last_state, RecorderState::Preparing, 0);

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
            set_state(&app, &last_state, RecorderState::Failed, 0);
            return;
        }
    };

    set_state(&app, &last_state, RecorderState::Recording, 0);

    loop {
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
        )
        .await;

        match outcome {
            SegmentOutcome::GracefulStop
            | SegmentOutcome::AutoStop
            | SegmentOutcome::SilenceStop => {
                break;
            }
            SegmentOutcome::Split => {
                // The split CLOSES the current deliverable. Finalise it (concat
                // its fragments + write its history row) BEFORE opening the next.
                let close_ms = now_ms();
                finalize_pending(
                    &pool,
                    &session,
                    &mut finalized,
                    close_ms,
                    &preroll_clip,
                    &audio,
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
                        set_state(
                            &app,
                            &last_state,
                            RecorderState::Failed,
                            session.reconnect_count(),
                        );
                        finalize_pending(
                            &pool,
                            &session,
                            &mut finalized,
                            now_ms(),
                            &preroll_clip,
                            &audio,
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
                            Ok(()) => set_state(&app, &last_state, RecorderState::Stopped, 0),
                            Err(e) => {
                                emit_error(&app, "device_error", &e.to_string());
                                set_state(&app, &last_state, RecorderState::Failed, 0);
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
                        set_state(
                            &app,
                            &last_state,
                            RecorderState::Failed,
                            session.reconnect_count(),
                        );
                        finalize_pending(
                            &pool,
                            &session,
                            &mut finalized,
                            now_ms(),
                            &preroll_clip,
                            &audio,
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
                        set_state(
                            &app,
                            &last_state,
                            RecorderState::Reconnecting,
                            session.reconnect_count(),
                        );
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
                                set_state(
                                    &app,
                                    &last_state,
                                    RecorderState::Recording,
                                    session.reconnect_count(),
                                );
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
                                                set_state(
                                                    &app,
                                                    &last_state,
                                                    RecorderState::Recording,
                                                    session.reconnect_count(),
                                                );
                                            }
                                            Err(e2) => {
                                                emit_error(&app, "device_error", &e2.to_string());
                                                set_state(
                                                    &app,
                                                    &last_state,
                                                    RecorderState::Failed,
                                                    session.reconnect_count(),
                                                );
                                                finalize_pending(
                                                    &pool,
                                                    &session,
                                                    &mut finalized,
                                                    now_ms(),
                                                    &preroll_clip,
                                                    &audio,
                                                )
                                                .await;
                                                return;
                                            }
                                        }
                                    }
                                    RecoveryDecision::GiveUp => {
                                        emit_error(&app, "device_disconnected", &e.to_string());
                                        set_state(
                                            &app,
                                            &last_state,
                                            RecorderState::Failed,
                                            session.reconnect_count(),
                                        );
                                        finalize_pending(
                                            &pool,
                                            &session,
                                            &mut finalized,
                                            now_ms(),
                                            &preroll_clip,
                                            &audio,
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
    set_state(
        &app,
        &last_state,
        RecorderState::Stopping,
        session.reconnect_count(),
    );
    finalize_pending(
        &pool,
        &session,
        &mut finalized,
        now_ms(),
        &preroll_clip,
        &audio,
    )
    .await;
    set_state(
        &app,
        &last_state,
        RecorderState::Stopped,
        session.reconnect_count(),
    );
    tracing::info!("recorder: session stopped cleanly");
}

/// Run ONE ffmpeg segment to completion. Owns the child, spawns its stderr
/// reader, and runs the `select!` over reader events + the stop request + the
/// timer ticks (watchdog poll, split, manual-max, silence stop/warn). Returns
/// the [`SegmentOutcome`] telling the supervisor what to do next. On any
/// graceful path (stop / split / auto-stop / silence-stop) it sends ffmpeg `q`
/// and waits for it to finalise before returning.
///
/// ⚠️ HARDWARE-UNVERIFIED.
async fn run_segment(
    app: &AppHandle,
    mut child: tokio::process::Child,
    opts: &RecordingOpts,
    session: &RecordingSession,
    segment_bytes: Arc<AtomicU64>,
    stop_rx: &mut tokio::sync::mpsc::Receiver<()>,
) -> SegmentOutcome {
    let Some(stderr) = child.stderr.take() else {
        return SegmentOutcome::UnexpectedExit { last_error: None };
    };
    let mut stdin = child.stdin.take();

    // Reader task: stream stderr → ReaderMsg over a channel so the supervisor's
    // select! owns all decisions. The reader holds NO state machine; it only
    // classifies lines with the pure core helpers.
    let (msg_tx, mut msg_rx) = tokio::sync::mpsc::channel::<ReaderMsg>(64);
    let reader = tauri::async_runtime::spawn(async move {
        let mut startup = StartupResolver::new();
        let mut lines = BufReader::new(stderr).lines();
        let mut last_error: Option<RecordingErrorCode> = None;
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if let Some(b) = parse_size_kb(&line) {
                        if startup.observe_progress() {
                            let _ = msg_tx.send(ReaderMsg::Started).await;
                        }
                        let _ = msg_tx.send(ReaderMsg::Progress(b)).await;
                    } else if let Some(ev) = SilenceEvent::from_stderr(&line) {
                        let _ = msg_tx.send(ReaderMsg::Silence(ev)).await;
                    } else if looks_like_error(&line) {
                        let code = classify_recording_error(&line);
                        if code != RecordingErrorCode::DeviceError {
                            last_error = Some(code);
                            let _ = msg_tx.send(ReaderMsg::Error(code, line.clone())).await;
                        }
                    }
                }
                Ok(None) => break, // stderr closed → ffmpeg exited
                Err(e) => {
                    tracing::warn!("recorder stderr read error: {e}");
                    break;
                }
            }
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

    // Split + manual-max timers fire relative to NOW (this segment for split,
    // whole session for auto-stop). We arm one-shot sleeps, recomputed each loop.
    let split_deadline = if opts.split_minutes > 0 {
        Some(Duration::from_secs(u64::from(opts.split_minutes) * 60))
    } else {
        None
    };
    // For auto-stop we measure remaining time against the session start.
    let auto_stop_remaining =
        |opts: &RecordingOpts, session: &RecordingSession| -> Option<Duration> {
            if opts.manual_max_minutes == 0 {
                return None;
            }
            let total = u64::from(opts.manual_max_minutes) * 60_000;
            let elapsed = session.elapsed_ms(now_ms());
            Some(Duration::from_millis(total.saturating_sub(elapsed)))
        };

    // Pin the timers. We use a helper that yields "never" when disabled.
    let split_sleep = sleep_opt(split_deadline);
    tokio::pin!(split_sleep);
    let auto_sleep = sleep_opt(auto_stop_remaining(opts, session));
    tokio::pin!(auto_sleep);
    // Silence timers, initially disarmed.
    let mut silence_stop: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;
    let mut silence_warn: Option<std::pin::Pin<Box<tokio::time::Sleep>>> = None;

    let outcome = loop {
        tokio::select! {
            // Reader events.
            msg = msg_rx.recv() => {
                match msg {
                    Some(ReaderMsg::Started) => { let _ = app.emit(STARTED_EVENT, ()); }
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
            // Split timer.
            _ = &mut split_sleep, if split_deadline.is_some() => {
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::Split;
            }
            // Manual-max auto-stop.
            _ = &mut auto_sleep, if opts.manual_max_minutes > 0 => {
                graceful_q(&mut stdin).await;
                let _ = child.wait().await;
                break SegmentOutcome::AutoStop;
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
async fn finalize_pending(
    pool: &Option<SqlitePool>,
    session: &RecordingSession,
    finalized: &mut usize,
    end_ms: u64,
    preroll_clip: &Option<PrerollClip>,
    audio: &FfmpegDevice,
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
        finalize_one(pool, d, index, deliverable_end, preroll_clip, audio).await;
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
async fn finalize_one(
    pool: &Option<SqlitePool>,
    deliverable: &sundayrec_core::recorder::Deliverable,
    index: usize,
    end_ms: u64,
    preroll_clip: &Option<PrerollClip>,
    audio: &FfmpegDevice,
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
        file_path: final_path,
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
}

/// Epoch milliseconds (the engine's clock; core takes this as an argument).
fn now_ms() -> u64 {
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
            stereo: true,
            split_minutes: 0,
            manual_max_minutes: 0,
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
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("reconnecting"));
        let back: RecorderStatePayload = serde_json::from_str(&json).unwrap();
        assert_eq!(p, back);
    }
}
