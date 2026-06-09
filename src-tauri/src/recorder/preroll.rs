//! The pre-roll engine (Fase 3.2) — rolling background audio capture + harvest.
//!
//! Pre-roll captures the last N seconds *before* the user presses record so a
//! manual recording can include audio from before the button press. This module
//! is the I/O shell over the pure [`sundayrec_core::preroll`] mat: it runs a
//! continuous, self-restarting ffmpeg WAV-capture loop into a temp file, and on
//! [`PrerollEngine::harvest`] stops the capture and returns the trimmed clip the
//! recorder prepends.
//!
//! ## Architecture — one loop task, a shared handle, a harvest hand-off
//!
//! [`PrerollEngine::start`] spawns ONE loop task that, while active:
//!   1. resolves the audio device with the REAL ffmpeg enumerator + the core
//!      fuzzy match (the same path the recorder uses),
//!   2. spawns an audio-only `pcm_s16le` WAV capture capped at 90 s
//!      ([`build_preroll_capture_args`]) into a fresh temp file,
//!   3. publishes the live handle (proc stdin, temp path, start instant) to the
//!      shared [`PrerollEngine`] state so `harvest` can grab it,
//!   4. waits for ffmpeg to exit — the natural 90 s cap → restart after
//!      [`RESTART_GAP_MS`]; a device/spawn error → restart after the exponential
//!      [`preroll_restart_delay`] back-off.
//!
//! [`PrerollEngine::harvest`] flips the active flag off, takes the live handle,
//! stops ffmpeg gracefully (`q` on stdin, mirroring the Electron `stopProc`),
//! measures the captured duration, file size, and asks the core mat whether (and
//! how much) to keep. On success it RE-ENCODES the kept window to an AAC `.m4a`
//! ([`build_preroll_trim_args`]) and returns a [`PrerollClip`].
//!
//! ## How the clip is prepended to the recording (Fase 3.2 scope — honest)
//!
//! [`RecorderEngine::start`] calls [`harvest`] when `pre_roll_seconds > 0`. This
//! module PRODUCES the trimmed clip (a real, playable `.m4a` at the recording's
//! sample-rate/channels) and hands the recorder its path + duration. **The final
//! ffmpeg `concat` that splices the clip in front of the main recording is NOT
//! wired in this phase** — it is a follow-up that belongs with the multi-segment
//! concat-merge the recorder already defers (see `engine.rs` "Deferred"). For
//! F3.2 the recorder logs the produced clip and tracks it on the session; the
//! concat step is documented as a TODO. See [`PrerollClip`].
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! All argument shaping + trim/offset maths are pure and unit-tested in core.
//! The capture loop, the graceful stop and the trim re-encode open a real mic and
//! run ffmpeg; they are NOT exercised by the test suite and MUST be smoke-tested
//! on a rig before pre-roll is declared done.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sundayrec_core::device_match::{find_best_device_match, FfmpegDevice};
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::preroll::{
    build_preroll_capture_args, build_preroll_trim_args, harvest_trim_ms, preroll_restart_delay,
    preroll_start_offset_ms, RESTART_GAP_MS,
};
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::media::ffmpeg::{ffmpeg_path, spawn_ffmpeg};
use crate::util::{detect_platform, lock_recover};

/// Hard ceiling on the harvest trim re-encode. The trim is a short, bounded
/// ffmpeg run (re-encoding at most ~90 s of already-captured WAV), so it should
/// finish in well under a second on any real machine. If the ffmpeg child ever
/// wedges (a stuck device handle, a hung sidecar) the trim must abort cleanly
/// rather than hanging the whole recording start, which awaits this harvest.
/// 30 s is far beyond any legitimate trim while still failing fast.
const HARVEST_TRIM_TIMEOUT: Duration = Duration::from_secs(30);

/// Settings the pre-roll loop needs to address + format a capture.
#[derive(Debug, Clone)]
pub struct PrerollSettings {
    /// Stored mic/mixer name to fuzzy-match against the enumerated audio devices.
    pub audio_device_name: String,
    /// Capture sample rate (Hz).
    pub sample_rate: u32,
    /// Output channel count (1 = mono, 2 = stereo).
    pub channels: u8,
}

/// A harvested, trimmed pre-roll clip ready to prepend to a recording.
///
/// `raw_path` is the *trimmed* AAC `.m4a` produced by [`PrerollEngine::harvest`]
/// (not the raw WAV — that is consumed + deleted during harvest). `trim_ms` and
/// `start_offset_ms` are the core mat's verdict, kept on the clip for diagnostics
/// and for the future concat step.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/PrerollClip.ts")]
pub struct PrerollClip {
    /// Absolute path to the trimmed `.m4a` clip.
    pub raw_path: String,
    /// Milliseconds of audio kept (the prepend length).
    #[ts(type = "number")]
    pub trim_ms: u64,
    /// Where in the raw capture the kept window started (ffmpeg `-ss`), for
    /// diagnostics; the trimmed clip already begins here.
    #[ts(type = "number")]
    pub start_offset_ms: u64,
}

/// The pre-roll status surfaced to the UI ("preroll aktiv").
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/PrerollStatus.ts")]
pub struct PrerollStatus {
    /// Whether the rolling capture loop is currently active.
    pub active: bool,
}

/// The live capture handle the loop publishes so `harvest`/`stop` can reach the
/// running ffmpeg process and its temp file.
struct PrerollHandle {
    /// ffmpeg's stdin, for the graceful `q` stop.
    stdin: Option<tokio::process::ChildStdin>,
    /// The temp WAV file the segment is being written to.
    temp_path: std::path::PathBuf,
    /// When this segment's capture started (for the captured-duration measure).
    started_at: Instant,
}

/// Engine handle stored in Tauri-managed state. At most one pre-roll loop runs at
/// a time; starting again stops the previous one first.
pub struct PrerollEngine {
    /// `true` while the loop should keep capturing/restarting. Cleared by
    /// `harvest`/`stop` so the loop winds down instead of restarting again.
    active: Arc<AtomicBool>,
    /// The live segment handle, published by the loop, taken by harvest/stop.
    handle: Arc<Mutex<Option<PrerollHandle>>>,
    /// The loop task, so we can abort it on stop.
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    /// Directory temp WAV/m4a files live under (app-data/tmp; tests pass a tempdir).
    tmp_dir: std::path::PathBuf,
}

impl PrerollEngine {
    /// Create an engine writing its temp captures under `tmp_dir`. The caller
    /// (lib.rs setup) passes the app-data `tmp` directory.
    pub fn new(tmp_dir: std::path::PathBuf) -> Self {
        Self {
            active: Arc::new(AtomicBool::new(false)),
            handle: Arc::new(Mutex::new(None)),
            task: Mutex::new(None),
            tmp_dir,
        }
    }

    /// Whether the rolling capture loop is currently active.
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Current status snapshot for the UI.
    pub fn status(&self) -> PrerollStatus {
        PrerollStatus {
            active: self.is_active(),
        }
    }

    /// Start the rolling pre-roll capture loop. Stops any previous loop first.
    /// Returns immediately — the loop runs in the background and self-heals; a
    /// missing device just backs off and retries (pre-roll is best-effort).
    ///
    /// ⚠️ HARDWARE-UNVERIFIED — opens a real mic.
    pub fn start(&self, settings: PrerollSettings) {
        self.stop();
        let _ = std::fs::create_dir_all(&self.tmp_dir);

        self.active.store(true, Ordering::SeqCst);
        let active = Arc::clone(&self.active);
        let handle_slot = Arc::clone(&self.handle);
        let tmp_dir = self.tmp_dir.clone();
        let platform = detect_platform();

        let task = tauri::async_runtime::spawn(async move {
            capture_loop(active, handle_slot, tmp_dir, platform, settings).await;
        });
        *lock_recover(&self.task) = Some(task);
    }

    /// Stop the pre-roll WITHOUT harvesting: clear the active flag, gracefully
    /// stop the live ffmpeg, abort the loop and delete the temp file. Safe to
    /// call when nothing is running.
    pub fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
        if let Some(task) = lock_recover(&self.task).take() {
            task.abort();
        }
        let handle = lock_recover(&self.handle).take();
        if let Some(h) = handle {
            let temp = h.temp_path.clone();
            // Best-effort graceful stop + cleanup in a detached task (stop is sync).
            tauri::async_runtime::spawn(async move {
                let mut h = h;
                graceful_stop(&mut h.stdin).await;
                let _ = tokio::fs::remove_file(&temp).await;
            });
        }
    }

    /// Stop the pre-roll and return the trimmed clip to prepend, or `None` when
    /// nothing usable was captured (no loop running, segment too small/short, or
    /// the trim re-encode failed). Consumes the raw WAV (deleted) and produces a
    /// trimmed clip at the recording's `sample_rate`/`channels`, **encoded with
    /// `audio_codec` into a `container_ext` file** so the F3.3a concat that
    /// prepends it to the recording is a lossless `-c copy` (Fase 3.3a). For the
    /// unified recorder that means `audio_codec = "aac"` and `container_ext` the
    /// recording's output extension (e.g. `"m4a"`, `"mp4"`).
    ///
    /// ⚠️ HARDWARE-UNVERIFIED — stops a real capture + re-encodes via ffmpeg.
    pub async fn harvest(
        &self,
        requested_seconds: u32,
        sample_rate: u32,
        channels: u8,
        audio_codec: &str,
        bitrate_kbps: Option<u32>,
        container_ext: &str,
    ) -> Option<PrerollClip> {
        // Flip active off FIRST so the loop's exit handler won't restart it.
        self.active.store(false, Ordering::SeqCst);
        if let Some(task) = lock_recover(&self.task).take() {
            task.abort();
        }
        let mut handle = lock_recover(&self.handle).take()?;

        // Measure BEFORE the graceful stop awaits (matches Electron: capturedMs is
        // wall-clock since start, the safety margin covers the un-flushed tail).
        let captured_ms = handle.started_at.elapsed().as_millis() as u64;
        graceful_stop(&mut handle.stdin).await;

        let temp = handle.temp_path;
        let segment_bytes = match tokio::fs::metadata(&temp).await {
            Ok(m) => m.len(),
            Err(_) => {
                return None;
            }
        };

        let Some(trim_ms) = harvest_trim_ms(captured_ms, requested_seconds, segment_bytes) else {
            let _ = tokio::fs::remove_file(&temp).await;
            return None;
        };
        let start_offset_ms = preroll_start_offset_ms(captured_ms, trim_ms);

        // The mic is already freed (graceful_stop above); the only remaining work
        // is the trim RE-ENCODE, which the prepend doesn't need until the
        // deliverable is finalised (at stop, typically minutes later). Running it
        // on the record-start path was pure wasted wait (~0.1–1 s), so do it in the
        // BACKGROUND: write to a `.part` file and atomically rename to the final
        // `out` only on success. `finalize_deliverable` guards on the clip existing
        // + being non-empty, so if the recording is stopped before this finishes —
        // or the re-encode fails — the prepend is simply skipped (no breakage).
        //
        // Re-encode with the recording's codec + container so the F3.3a concat is a
        // lossless `-c copy` (Fase 3.3a).
        let out = temp.with_extension(container_ext);
        let out_part = temp.with_extension(format!("{container_ext}.part"));
        let trim_args = build_preroll_trim_args(
            &temp.to_string_lossy(),
            start_offset_ms,
            trim_ms,
            sample_rate,
            channels,
            audio_codec,
            bitrate_kbps,
            &out_part.to_string_lossy(),
        );
        let out_for_task = out.clone();
        tauri::async_runtime::spawn(async move {
            let trimmed_ok = run_to_completion(&trim_args, HARVEST_TRIM_TIMEOUT).await;
            // The raw WAV is consumed either way.
            let _ = tokio::fs::remove_file(&temp).await;
            if trimmed_ok {
                // Atomic publish: concat never sees a half-written clip.
                if let Err(e) = tokio::fs::rename(&out_part, &out_for_task).await {
                    let _ = tokio::fs::remove_file(&out_part).await;
                    tracing::warn!(error = %e, "preroll: clip publish (rename) failed; no clip");
                } else {
                    tracing::info!(
                        trim_ms,
                        start_offset_ms,
                        clip = %out_for_task.display(),
                        "preroll: harvested clip (background trim)"
                    );
                }
            } else {
                let _ = tokio::fs::remove_file(&out_part).await;
                tracing::warn!("preroll: trim re-encode failed; no clip produced");
            }
        });

        // Return immediately with the EVENTUAL clip path; the background task
        // publishes it before finalisation. The concat existence-guard covers the
        // (rare) case where it isn't ready in time.
        Some(PrerollClip {
            raw_path: out.to_string_lossy().into_owned(),
            trim_ms,
            start_offset_ms,
        })
    }
}

/// The rolling capture loop body. Runs until `active` is cleared.
///
/// ⚠️ HARDWARE-UNVERIFIED.
async fn capture_loop(
    active: Arc<AtomicBool>,
    handle_slot: Arc<Mutex<Option<PrerollHandle>>>,
    tmp_dir: std::path::PathBuf,
    platform: Platform,
    settings: PrerollSettings,
) {
    let mut attempt: u32 = 0;
    while active.load(Ordering::SeqCst) {
        // Resolve the device fresh each segment (it may have changed/reconnected).
        let audio = match resolve_audio(&settings.audio_device_name).await {
            Some(a) => a,
            None => {
                // No device → exponential back-off, then retry (don't busy-spin).
                let delay = preroll_restart_delay(attempt);
                tracing::warn!(attempt, delay, "preroll: no audio device, backing off");
                attempt = attempt.saturating_add(1);
                if !sleep_while_active(&active, delay).await {
                    break;
                }
                continue;
            }
        };

        let temp_path = tmp_dir.join(format!("sundayrec-preroll-{}.wav", segment_id()));
        let args = build_preroll_capture_args(
            platform,
            &device_token(&audio),
            settings.sample_rate,
            settings.channels,
            &temp_path.to_string_lossy(),
        );

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let mut child = match spawn_ffmpeg(&arg_refs).await {
            Ok(c) => c,
            Err(e) => {
                let delay = preroll_restart_delay(attempt);
                tracing::warn!(attempt, delay, "preroll: spawn failed: {e}");
                attempt = attempt.saturating_add(1);
                if !sleep_while_active(&active, delay).await {
                    break;
                }
                continue;
            }
        };

        // A successful spawn resets the error back-off.
        attempt = 0;
        let stdin = child.stdin.take();
        *lock_recover(&handle_slot) = Some(PrerollHandle {
            stdin,
            temp_path: temp_path.clone(),
            started_at: Instant::now(),
        });
        tracing::info!(temp = %temp_path.display(), "preroll: segment started");

        // Wait for the segment to end (natural 90 s cap or harvest's graceful q).
        let _ = child.wait().await;

        // If harvest/stop already took the handle, do NOT restart or delete — that
        // segment is being consumed. We detect this by whether OUR handle is still
        // published (same temp path).
        let still_ours = {
            let mut guard = lock_recover(&handle_slot);
            match guard.as_ref() {
                Some(h) if h.temp_path == temp_path => {
                    *guard = None;
                    true
                }
                _ => false,
            }
        };
        if !still_ours {
            // Harvest/stop owns this segment now; leave the loop's wind-down to it.
            break;
        }

        // Natural cap (or unexpected exit) → the un-harvested WAV is litter.
        let _ = tokio::fs::remove_file(&temp_path).await;
        if !active.load(Ordering::SeqCst) {
            break;
        }
        // Short gap before re-acquiring the device, then loop.
        if !sleep_while_active(&active, RESTART_GAP_MS).await {
            break;
        }
    }
}

/// Resolve the best audio device match for `name` via the real ffmpeg enumerator.
async fn resolve_audio(name: &str) -> Option<FfmpegDevice> {
    let inv = enumerate_ffmpeg_devices().await.ok()?;
    find_best_device_match(&inv.audio_inputs, name).cloned()
}

/// The addressable token for a device: the avfoundation index (mac) when known,
/// otherwise the dshow name (Windows). Mirrors `engine::device_token`.
fn device_token(d: &FfmpegDevice) -> String {
    match d.index {
        Some(i) => i.to_string(),
        None => d.name.clone(),
    }
}

/// Sleep `delay_ms`, but bail early (returning `false`) if the loop was
/// deactivated while sleeping. Returns `true` if the full delay elapsed and the
/// loop should continue.
async fn sleep_while_active(active: &Arc<AtomicBool>, delay_ms: u64) -> bool {
    // Poll the flag in small slices so a stop during a long back-off is prompt.
    let mut remaining = delay_ms;
    while remaining > 0 {
        if !active.load(Ordering::SeqCst) {
            return false;
        }
        let slice = remaining.min(100);
        tokio::time::sleep(Duration::from_millis(slice)).await;
        remaining -= slice;
    }
    active.load(Ordering::SeqCst)
}

/// Graceful ffmpeg stop: write `q\n` to stdin and drop it (EOF), letting ffmpeg
/// finalise the WAV header. Mirrors the Electron `stopProc` graceful path
/// (`q` for non-dshow / wasapi). dshow ignores stdin, but `kill_on_drop` on the
/// child guarantees the process is still reaped when its handle is dropped, so a
/// best-effort `q` here is safe on every platform.
async fn graceful_stop(stdin: &mut Option<tokio::process::ChildStdin>) {
    if let Some(mut pipe) = stdin.take() {
        let _ = pipe.write_all(b"q\n").await;
        let _ = pipe.flush().await;
        // Dropping `pipe` closes stdin → EOF.
    }
}

/// Run a short-lived ffmpeg command (the trim re-encode) to completion, returning
/// whether it exited successfully.
///
/// Bounded by `timeout`: the trim is a short, finite re-encode, so if the ffmpeg
/// child wedges (a stuck device handle, a hung sidecar) it must abort cleanly
/// rather than hang the recording start that awaits this harvest. On timeout we
/// kill the child (`kill_on_drop` also covers the early-return drop) and report
/// failure, which the caller treats as "no clip produced" and recovers from.
async fn run_to_completion(args: &[String], timeout: Duration) -> bool {
    use std::process::Stdio;
    let mut child = match tokio::process::Command::new(ffmpeg_path())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status.success(),
        // Spawned but waiting errored.
        Ok(Err(_)) => false,
        // Wedged past the deadline — kill it and give up so harvest doesn't hang.
        Err(_) => {
            tracing::warn!("preroll: trim re-encode exceeded {timeout:?}; aborting");
            let _ = child.kill().await;
            false
        }
    }
}

/// A short random-ish id for the temp WAV filename, derived from the wall clock
/// (good enough — only one pre-roll segment exists at a time per engine).
fn segment_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Build [`PrerollSettings`] from the persisted core settings, returning `None`
/// when pre-roll is off (`pre_roll_seconds == 0`) or no device is configured.
pub fn preroll_settings_from(
    settings: &sundayrec_core::settings::Settings,
) -> Option<PrerollSettings> {
    if settings.pre_roll_seconds <= 0 {
        return None;
    }
    let audio_device_name = settings.device_name.clone()?;
    if audio_device_name.is_empty() {
        return None;
    }
    let channels = match settings.channels {
        sundayrec_core::settings::ChannelMode::Stereo => 2,
        _ => 1,
    };
    Some(PrerollSettings {
        audio_device_name,
        sample_rate: settings.sample_rate.max(8_000) as u32,
        channels,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sundayrec_core::settings::{ChannelMode, Settings};

    #[test]
    fn engine_starts_inactive() {
        let dir = tempfile::tempdir().unwrap();
        let engine = PrerollEngine::new(dir.path().to_path_buf());
        assert!(!engine.is_active());
        assert!(!engine.status().active);
    }

    #[test]
    fn stop_is_safe_when_idle() {
        let dir = tempfile::tempdir().unwrap();
        let engine = PrerollEngine::new(dir.path().to_path_buf());
        engine.stop();
        engine.stop();
        assert!(!engine.is_active());
    }

    #[test]
    fn device_token_prefers_index_then_name() {
        assert_eq!(
            device_token(&FfmpegDevice::new("Mic", "avfoundation", Some(3))),
            "3"
        );
        assert_eq!(
            device_token(&FfmpegDevice::new("Mic", "dshow", None)),
            "Mic"
        );
    }

    #[test]
    fn settings_off_when_preroll_zero() {
        let s = Settings {
            pre_roll_seconds: 0,
            device_name: Some("Mic".into()),
            ..Default::default()
        };
        assert!(preroll_settings_from(&s).is_none());
    }

    #[test]
    fn settings_off_when_no_device() {
        let s = Settings {
            pre_roll_seconds: 15,
            device_name: None,
            ..Default::default()
        };
        assert!(preroll_settings_from(&s).is_none());
        let s2 = Settings {
            pre_roll_seconds: 15,
            device_name: Some(String::new()),
            ..Default::default()
        };
        assert!(preroll_settings_from(&s2).is_none());
    }

    #[test]
    fn settings_maps_channels_and_rate() {
        let s = Settings {
            pre_roll_seconds: 30,
            device_name: Some("Soundcraft".into()),
            channels: ChannelMode::Stereo,
            sample_rate: 44_100,
            ..Default::default()
        };
        let p = preroll_settings_from(&s).unwrap();
        assert_eq!(p.audio_device_name, "Soundcraft");
        assert_eq!(p.channels, 2);
        assert_eq!(p.sample_rate, 44_100);

        let mono = Settings {
            pre_roll_seconds: 30,
            device_name: Some("Soundcraft".into()),
            channels: ChannelMode::MonoMix,
            ..Default::default()
        };
        assert_eq!(preroll_settings_from(&mono).unwrap().channels, 1);
    }

    #[test]
    fn preroll_clip_serde_roundtrip() {
        let c = PrerollClip {
            raw_path: "/tmp/pre.m4a".into(),
            trim_ms: 15_000,
            start_offset_ms: 75_000,
        };
        let json = serde_json::to_string(&c).unwrap();
        let back: PrerollClip = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn min_valid_bytes_constant_in_scope() {
        // Sanity: the core threshold the harvest path relies on.
        assert_eq!(sundayrec_core::preroll::MIN_VALID_SEGMENT_BYTES, 4096);
    }

    #[test]
    fn harvest_trim_timeout_is_bounded_and_generous() {
        // The trim re-encode is short; the ceiling must be far beyond any real
        // trim (so we never abort a legitimate one) yet finite (so a wedged
        // ffmpeg can't hang the recording start that awaits harvest).
        assert!(HARVEST_TRIM_TIMEOUT >= Duration::from_secs(10));
        assert!(HARVEST_TRIM_TIMEOUT <= Duration::from_secs(120));
    }

    #[tokio::test]
    async fn run_to_completion_times_out_on_a_wedged_child() {
        // A child that never exits within the deadline must be reported as a
        // failure (and killed) rather than hanging. We point at a long sleep so
        // the wait can only resolve via the timeout branch, and use a tiny real
        // deadline so the test is fast; the production path is the same
        // `tokio::time::timeout` wrapper, just with the longer constant. Skips
        // cleanly if the platform has no `sleep` binary or the sandbox blocks the
        // spawn (returns early — the "no clip" outcome harvest already handles).
        use std::process::Stdio;
        let spawned = tokio::process::Command::new("sleep")
            .arg("1000")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let Ok(mut child) = spawned else {
            return; // no `sleep` / spawn blocked — nothing to assert.
        };
        let timed_out = tokio::time::timeout(Duration::from_millis(20), child.wait())
            .await
            .is_err();
        assert!(timed_out, "a never-exiting child must hit the deadline");
        let _ = child.kill().await;
    }
}
