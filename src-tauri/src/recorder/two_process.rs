//! Two-process audio+video capture fallback — the I/O shell (Fase 3.3b).
//!
//! When the unified single-ffmpeg capture ([`crate::recorder::engine`]) can't
//! open the camera AND the mic as one input, the recorder falls back to TWO
//! separate ffmpeg processes — one capturing video, one capturing audio — and
//! **muxes** them together at stop with A/V-drift correction. This module owns
//! the I/O for that fallback; every argument/offset decision is pure and lives,
//! tested, in [`sundayrec_core::two_process`].
//!
//! It is a faithful port of the Electron separate-handle path
//! (`unified-recorder.ts` two-`-i` failure case) + `video-recorder.ts`
//! `muxAudioVideo` + `probeStartTimeSec`.
//!
//! ## ⚠️ Scope — honest about what is finished
//!
//! This implements the two-process fallback for a **simple video session**:
//!   - NO split (one continuous video + one continuous audio file), and
//!   - NO reconnect (a device death aborts the session — it does not respawn).
//!
//! That is deliberate. The unified engine's reconnect/split machinery
//! ([`crate::recorder::engine::run_session`]) is built around ONE child process
//! whose fragments concat losslessly; weaving a SECOND clock-independent process
//! through the same reconnect/split state machine (each side reconnecting
//! independently, then N video fragments muxed against N audio fragments with
//! per-fragment offset) is a substantial extension. The honest, shippable unit
//! delivered here is the **fallback that recovers the common case** (a device
//! pair ffmpeg refuses to combine, recorded straight through), which is exactly
//! what Electron's two-process path did. Full split/reconnect fusion is tracked
//! as a Fase-3-continuation TODO.
//!
//! The mux result becomes the session's single deliverable: one history row,
//! same model as a unified single-fragment deliverable in
//! [`crate::recorder::engine::finalize_one`].
//!
//! ## ⚠️ HARDWARE-UNVERIFIED
//!
//! Everything pure is unit-tested in core. `probe_start_time_sec`, the two
//! capture spawns, the graceful stop, and the mux run touch the filesystem and
//! spawn processes — they open a real camera + mic and run for a long time, and
//! are NOT exercised by the test suite. They MUST be smoke-tested on a rig.

use std::process::Stdio;
use std::time::Duration;

use sqlx::SqlitePool;
use sundayrec_core::device_match::FfmpegDevice;
use sundayrec_core::ffmpeg::Platform;
use sundayrec_core::two_process::{
    av_offset_decision, build_audio_capture_args, build_mux_args, build_video_capture_args,
};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncWriteExt, BufReader};

use crate::db::store::{insert_recording, RecordingRow};
use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::{ffprobe_path, spawn_ffmpeg};
use crate::recorder::engine::{RecordingOpts, ERROR_EVENT, STATE_EVENT};

/// Hard limit on the mux ffmpeg run. A `-c:v copy` mux of even a multi-hour
/// service is fast (audio re-encode dominates and is still real-time-ish);
/// anything past this means ffmpeg is wedged. Ports the Electron `muxAudioVideo`
/// 30-minute watchdog.
const MUX_WATCHDOG: Duration = Duration::from_secs(30 * 60);

/// Probe a media file's container `start_time`, in seconds, via **ffprobe**.
///
/// Both two-process captures use `-use_wallclock_as_timestamps 1`, so the
/// container `start_time` is a Unix epoch (a value `> 1_000_000_000`). We use
/// `ffprobe -show_entries format=start_time` (the dedicated probe binary, vs
/// Electron's `ffmpeg -i` stderr-scrape — ffprobe gives us a clean machine value
/// with no parsing). Returns:
///   - `Some(secs)` when the value parses AND looks like a wall-clock stamp,
///   - `None` when ffprobe fails, the field is `N/A`, or the value is below the
///     wall-clock threshold (a file without wall-clock timestamps — we then skip
///     head-alignment and rely on `aresample` for drift, exactly like Electron).
///
/// ⚠️ HARDWARE-UNVERIFIED (spawns ffprobe against a real file).
pub async fn probe_start_time_sec(path: &str) -> Option<f64> {
    let output = tokio::process::Command::new(ffprobe_path())
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=start_time",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            path,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let value: f64 = raw.trim().parse().ok()?;
    // Only trust it as an alignment anchor if it's a real wall-clock epoch;
    // mirrors Electron's `> 1_000_000_000` guard.
    (value > 1_000_000_000.0).then_some(value)
}

/// Run a SIMPLE (non-split, non-reconnect) two-process video session: spawn the
/// video + audio captures, record until `stop_rx` fires, gracefully stop both,
/// probe their start times, mux with the decided A/V offset, and write ONE
/// history row for the muxed deliverable.
///
/// `video` MUST be present (the fallback only exists for video sessions; an
/// audio-only session never needs it). `output_path` is the FINAL muxed file;
/// the two temp captures are derived from it (`<stem>_vtmp.mp4`,
/// `<stem>_atmp.m4a`) and cleaned up after a successful mux.
///
/// Returns `Ok(())` on a clean mux (history row written, temps removed) and
/// `Err` if a capture can't launch — so the caller can surface the failure. A
/// mux failure leaves BOTH temp files on disk (no audio/video lost) and records
/// a best-effort history row pointing at the video temp.
///
/// ⚠️ HARDWARE-UNVERIFIED — opens a real camera + mic and runs for a long time.
#[allow(clippy::too_many_arguments)]
pub async fn run_two_process_session(
    app: AppHandle,
    pool: Option<SqlitePool>,
    opts: RecordingOpts,
    platform: Platform,
    audio: FfmpegDevice,
    video: FfmpegDevice,
    mut stop_rx: tokio::sync::mpsc::Receiver<()>,
) -> AppResult<()> {
    let video_temp = derive_temp_path(&opts.output_path, "_vtmp", "mp4");
    let audio_temp = derive_temp_path(&opts.output_path, "_atmp", "m4a");

    let channels: u8 = if opts.stereo { 2 } else { 1 };
    let video_args =
        build_video_capture_args(platform, &device_token(&video), &video_temp, opts.framerate);
    let audio_args =
        build_audio_capture_args(platform, &device_token(&audio), &audio_temp, channels);

    let _ = app.emit(STATE_EVENT, ());

    // Spawn BOTH captures. If the second fails to launch, kill the first so we
    // don't leak a recording process, and report the failure.
    let mut video_child = spawn_owned(&video_args).await?;
    let mut audio_child = match spawn_owned(&audio_args).await {
        Ok(c) => c,
        Err(e) => {
            let _ = video_child.start_kill();
            let _ = video_child.wait().await;
            return Err(e);
        }
    };

    tracing::info!(
        video_temp = %video_temp,
        audio_temp = %audio_temp,
        "recorder: two-process fallback recording (no split / no reconnect)"
    );

    // Stream each child's stderr to the log so a failing capture is diagnosable
    // (the simple fallback does NOT classify per-line errors into the reconnect
    // policy — there is no reconnect here).
    let video_stderr = video_child.stderr.take();
    let audio_stderr = audio_child.stderr.take();
    let video_log = video_stderr.map(|s| tauri::async_runtime::spawn(drain_stderr(s, "video")));
    let audio_log = audio_stderr.map(|s| tauri::async_runtime::spawn(drain_stderr(s, "audio")));

    let mut video_stdin = video_child.stdin.take();
    let mut audio_stdin = audio_child.stdin.take();

    // Record until the user requests a stop (or either child dies — a death here
    // ends the session; reconnect is out of scope for the simple fallback).
    tokio::select! {
        _ = stop_rx.recv() => {
            tracing::info!("recorder: two-process — graceful stop requested");
        }
        status = video_child.wait() => {
            tracing::warn!(?status, "recorder: two-process — video process exited early");
        }
        status = audio_child.wait() => {
            tracing::warn!(?status, "recorder: two-process — audio process exited early");
        }
    }

    // Graceful stop BOTH: send `q` so each container finalises cleanly (a kill
    // would corrupt the MP4), then await both.
    graceful_q(&mut video_stdin).await;
    graceful_q(&mut audio_stdin).await;
    let _ = video_child.wait().await;
    let _ = audio_child.wait().await;
    if let Some(h) = video_log {
        h.abort();
    }
    if let Some(h) = audio_log {
        h.abort();
    }

    // Decide the head-alignment from each file's wall-clock start_time, then mux.
    let (audio_start, video_start) = tokio::join!(
        probe_start_time_sec(&audio_temp),
        probe_start_time_sec(&video_temp)
    );
    let offset = av_offset_decision(audio_start, video_start);
    tracing::info!(
        ?audio_start,
        ?video_start,
        ?offset,
        "recorder: two-process A/V offset decided"
    );

    let mux_args = build_mux_args(&audio_temp, &video_temp, &opts.output_path, offset);
    let final_path = match run_mux(&mux_args).await {
        Ok(()) => {
            // Clean up the temps — the muxed file is the deliverable.
            let _ = tokio::fs::remove_file(&video_temp).await;
            let _ = tokio::fs::remove_file(&audio_temp).await;
            opts.output_path.clone()
        }
        Err(e) => {
            // Keep both temps so nothing is lost; point history at the video temp
            // (it carries the picture; the audio temp sits beside it for manual
            // recovery).
            tracing::error!("recorder: two-process mux failed, keeping temps: {e}");
            emit_error(&app, "mux_failed", &e.to_string());
            video_temp.clone()
        }
    };

    write_history(&pool, &final_path, &audio, &opts).await;
    Ok(())
}

/// Run the mux ffmpeg under the watchdog. Succeeds only on exit code 0.
///
/// ⚠️ HARDWARE-UNVERIFIED (spawns ffmpeg).
async fn run_mux(args: &[String]) -> AppResult<()> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tracing::info!(?arg_refs, "recorder: two-process — muxing");
    let mut child = spawn_ffmpeg(&arg_refs).await?;
    match tokio::time::timeout(MUX_WATCHDOG, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(AppError::Recording(format!(
            "mux ffmpeg exited with status {status}"
        ))),
        Ok(Err(e)) => Err(AppError::Recording(format!("mux ffmpeg wait failed: {e}"))),
        Err(_) => {
            let _ = child.start_kill();
            Err(AppError::Recording("mux ffmpeg timed out".into()))
        }
    }
}

/// Write the muxed deliverable's history row (best-effort; a `None` pool or a DB
/// error is a no-op / logged). `started_at`/`duration_ms` are best-effort: the
/// container's own timeline drives playback, and the session-level timing model
/// is owned by the unified engine — the two-process simple path records the
/// finished-file size and the device name, matching `finalize_one`'s shape.
async fn write_history(
    pool: &Option<SqlitePool>,
    final_path: &str,
    audio: &FfmpegDevice,
    _opts: &RecordingOpts,
) {
    let byte_size = tokio::fs::metadata(final_path)
        .await
        .map(|m| m.len() as i64)
        .ok();
    let Some(pool) = pool else { return };
    let row = RecordingRow {
        id: String::new(),
        file_path: final_path.to_string(),
        device_name: Some(audio.name.clone()),
        started_at: 0.0,
        duration_ms: None,
        byte_size,
        created_at: 0.0,
        note: None,
    };
    if let Err(e) = insert_recording(pool, row).await {
        tracing::error!("recorder: two-process failed to write history row: {e}");
    }
}

/// Derive a temp capture path next to the final output: `<dir>/<stem><suffix>.<ext>`.
fn derive_temp_path(output_path: &str, suffix: &str, ext: &str) -> String {
    let p = std::path::Path::new(output_path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned());
    let dir = p.parent();
    match (dir, stem) {
        (Some(dir), Some(stem)) => dir
            .join(format!("{stem}{suffix}.{ext}"))
            .to_string_lossy()
            .into_owned(),
        _ => format!("{output_path}{suffix}.{ext}"),
    }
}

/// The addressable token for a device: the avfoundation index (mac) when known,
/// otherwise the dshow name (Windows). Mirrors `engine::device_token`.
fn device_token(d: &FfmpegDevice) -> String {
    match d.index {
        Some(i) => i.to_string(),
        None => d.name.clone(),
    }
}

/// Spawn ffmpeg taking ownership of the child (drop triggers `kill_on_drop`).
async fn spawn_owned(args: &[String]) -> AppResult<tokio::process::Child> {
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    tracing::info!(?arg_refs, "recorder: two-process — spawning capture");
    spawn_ffmpeg(&arg_refs).await
}

/// Write ffmpeg `q\n` to stdin and drop it (EOF nudge) for a graceful finalise.
/// Mirrors `engine::graceful_q`.
async fn graceful_q(stdin: &mut Option<tokio::process::ChildStdin>) {
    if let Some(mut pipe) = stdin.take() {
        let _ = pipe.write_all(b"q\n").await;
        let _ = pipe.flush().await;
    }
}

/// Drain a child's stderr to the trace log so a failing capture is diagnosable.
async fn drain_stderr<R>(stderr: R, which: &'static str)
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncBufReadExt;
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        tracing::trace!(target: "two_process_ffmpeg", which, "{line}");
    }
}

/// Emit a classified error to the renderer. Mirrors `engine::emit_error`.
fn emit_error(app: &AppHandle, code: &str, message: &str) {
    let _ = app.emit(
        ERROR_EVENT,
        crate::recorder::engine::RecordingEvent {
            code: code.to_string(),
            message: message.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_temp_path_places_temps_next_to_output() {
        let v = derive_temp_path("/recordings/service.mp4", "_vtmp", "mp4");
        let a = derive_temp_path("/recordings/service.mp4", "_atmp", "m4a");
        assert_eq!(v, "/recordings/service_vtmp.mp4");
        assert_eq!(a, "/recordings/service_atmp.m4a");
    }

    #[test]
    fn derive_temp_path_handles_no_extension() {
        let v = derive_temp_path("/recordings/service", "_vtmp", "mp4");
        assert_eq!(v, "/recordings/service_vtmp.mp4");
    }

    #[test]
    fn device_token_prefers_index_then_name() {
        assert_eq!(
            device_token(&FfmpegDevice::new("Cam", "avfoundation", Some(0))),
            "0"
        );
        assert_eq!(
            device_token(&FfmpegDevice::new("Cam", "dshow", None)),
            "Cam"
        );
    }
}
