//! Per-deliverable finalisation — stitch a deliverable's fragments (and the
//! pre-roll clip, for the first deliverable) into ONE lossless file (Fase 3.3a).
//!
//! This is the I/O shell over the pure concat decisions in
//! [`sundayrec_core::recorder`] ([`concat_needed`], [`concat_inputs`],
//! [`build_concat_list`], [`build_concat_args`], [`escape_concat_path`]). It is a
//! faithful port of the Electron `mergeSegments` + pre-roll-concat path:
//!
//!   1. ask the core whether a concat is even needed (a single fragment with no
//!      pre-roll is already the finished file → return it untouched),
//!   2. write the concat-demuxer list to a temp `.txt` next to the primary file,
//!   3. run ffmpeg `-f concat -safe 0 -i list -c copy -y tmp` under a 15-minute
//!      watchdog (a concat-copy of even a very long service is fast; anything
//!      longer means ffmpeg is hung),
//!   4. atomically replace the deliverable's primary file with the muxed temp
//!      (rename on POSIX; copy+unlink on Windows, where rename across an existing
//!      target can fail — mirrors Electron),
//!   5. delete the now-merged fragment files (`fragments[1..]`) + the list.
//!
//! ## Codec matching — why this is a lossless `-c copy`
//!
//! The unified recorder encodes **AAC @ 48 kHz** for every segment
//! ([`build_unified_capture_args`] hardcodes `-c:a aac`), and every reconnect /
//! split fragment is the SAME ffmpeg invocation, so all fragments share one
//! codec. The pre-roll harvest re-encodes its clip to the recording's audio
//! format too (see [`crate::recorder::preroll`] — `build_preroll_trim_args` is
//! driven with the recording's codec/sample-rate/channels), so the pre-roll clip
//! matches as well. With every input sharing a codec, the concat demuxer's
//! `-c copy` is a true stream-copy: the main recording is never transcoded. The
//! pre-roll clip and the recording use the same `.m4a`/AAC container the recorder
//! writes, so the demuxer accepts them without re-encoding.
//!
//! ## ⚠️ HARDWARE-UNVERIFIED (process side)
//!
//! Every argument/path decision is pure and unit-tested in core. The ffmpeg
//! concat run + the atomic file replace touch the filesystem and spawn a process;
//! they are NOT exercised by the test suite and must be smoke-tested on a rig.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use sundayrec_core::recorder::{
    build_concat_args, build_concat_list, concat_inputs, concat_needed, Deliverable,
};

use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::ffmpeg_path;

/// Hard limit on the concat-copy ffmpeg run. A stream-copy of even a multi-hour
/// service is fast; anything past this means ffmpeg is wedged. Ports the Electron
/// `mergeSegments` 15-minute watchdog.
const CONCAT_WATCHDOG: Duration = Duration::from_secs(15 * 60);

/// `true` on Windows — selects the concat-path escaping (`\` → `/`) and the
/// copy+unlink atomic replace (vs POSIX rename).
fn is_windows() -> bool {
    cfg!(target_os = "windows")
}

/// Finalise ONE deliverable: stitch its fragments (pre-roll first, when supplied)
/// into the deliverable's primary file and return the final path.
///
/// When [`concat_needed`] is false (a single fragment, no pre-roll) the primary
/// file is already the finished deliverable and is returned untouched — no ffmpeg
/// is spawned. Otherwise the fragments (and `preroll_clip_path`, if any) are
/// concatenated losslessly, the result atomically replaces `primary_path`, and
/// the merged fragment files + the temp list are deleted.
///
/// `preroll_clip_path` MUST be `Some` only for the FIRST deliverable of a session
/// (the engine owns that decision); it is prepended as the first concat input.
///
/// On a concat failure the original fragment files are LEFT ON DISK (so no audio
/// is lost) and an error is returned — the caller logs it and still keeps the
/// primary as the history file.
///
/// ⚠️ HARDWARE-UNVERIFIED — spawns ffmpeg + touches the filesystem.
pub async fn finalize_deliverable(
    deliverable: &Deliverable,
    preroll_clip_path: Option<&str>,
) -> AppResult<String> {
    let primary = deliverable.primary_path.clone();

    if !concat_needed(&deliverable.fragments, preroll_clip_path.is_some()) {
        // Single fragment, no pre-roll → the primary file is already complete.
        return Ok(primary);
    }

    let inputs = concat_inputs(&deliverable.fragments, preroll_clip_path);
    let primary_path = PathBuf::from(&primary);
    let (list_path, tmp_path) = scratch_paths(&primary_path);

    // 1. Write the concat-demuxer list.
    let list_body = build_concat_list(&inputs, is_windows());
    tokio::fs::write(&list_path, list_body.as_bytes())
        .await
        .map_err(|e| {
            AppError::Recording(format!(
                "concat: failed to write list {}: {e}",
                list_path.display()
            ))
        })?;

    // 2. Run ffmpeg concat (-c copy) under the watchdog.
    let args = build_concat_args(&list_path.to_string_lossy(), &tmp_path.to_string_lossy());
    let run = run_concat(&args).await;
    if let Err(e) = run {
        // Leave the fragments on disk; only the (incomplete) temp + list are litter.
        let _ = tokio::fs::remove_file(&tmp_path).await;
        let _ = tokio::fs::remove_file(&list_path).await;
        return Err(e);
    }

    // 3. Atomically replace the primary file with the muxed temp.
    atomic_replace(&tmp_path, &primary_path).await?;

    // 4. Delete the now-merged fragment files (fragments[1..]) + the list.
    //    `fragments[0]` == primary_path, which now holds the merged result.
    for frag in deliverable.fragments.iter().skip(1) {
        let _ = tokio::fs::remove_file(frag).await;
    }
    let _ = tokio::fs::remove_file(&list_path).await;

    tracing::info!(
        inputs = inputs.len(),
        output = %primary,
        "recorder: finalised deliverable (concat -c copy)"
    );
    Ok(primary)
}

/// Build the scratch paths next to the primary file: the concat-list `.txt` and
/// the muxed temp (same extension as the primary so the demuxer picks the right
/// muxer). Mirrors Electron's `${base}_merge.txt` / `${base}_merge_tmp${ext}`.
fn scratch_paths(primary: &Path) -> (PathBuf, PathBuf) {
    let dir = primary.parent().unwrap_or_else(|| Path::new("."));
    let stem = primary
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recording".to_string());
    let ext = primary
        .extension()
        .map(|e| e.to_string_lossy().into_owned());
    let list = dir.join(format!("{stem}_merge.txt"));
    let tmp = match &ext {
        Some(e) => dir.join(format!("{stem}_merge_tmp.{e}")),
        None => dir.join(format!("{stem}_merge_tmp")),
    };
    (list, tmp)
}

/// Atomically move `tmp` onto `target`. POSIX: a single `rename`. Windows: a
/// `rename` over an existing file can fail, so copy then unlink — mirrors the
/// Electron `copyFileSync`+`unlinkSync` Windows branch.
async fn atomic_replace(tmp: &Path, target: &Path) -> AppResult<()> {
    if is_windows() {
        tokio::fs::copy(tmp, target).await.map_err(|e| {
            AppError::Recording(format!(
                "concat: failed to copy {} → {}: {e}",
                tmp.display(),
                target.display()
            ))
        })?;
        let _ = tokio::fs::remove_file(tmp).await;
    } else {
        tokio::fs::rename(tmp, target).await.map_err(|e| {
            AppError::Recording(format!(
                "concat: failed to rename {} → {}: {e}",
                tmp.display(),
                target.display()
            ))
        })?;
    }
    Ok(())
}

/// Run the concat ffmpeg to completion under the [`CONCAT_WATCHDOG`] timeout.
/// `-c copy` so this is a fast lossless mux; a timeout means ffmpeg hung and is
/// killed. Returns an error on a non-zero exit, a spawn failure, or a timeout.
///
/// ⚠️ HARDWARE-UNVERIFIED — spawns ffmpeg.
async fn run_concat(args: &[String]) -> AppResult<()> {
    let mut child = tokio::process::Command::new(ffmpeg_path())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Recording(format!("concat: failed to spawn ffmpeg: {e}")))?;

    match tokio::time::timeout(CONCAT_WATCHDOG, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(AppError::Recording(format!(
            "concat: ffmpeg exited with status {status}"
        ))),
        Ok(Err(e)) => Err(AppError::Recording(format!(
            "concat: failed to await ffmpeg: {e}"
        ))),
        Err(_) => {
            // Timed out → kill the wedged process (kill_on_drop also covers the
            // handle being dropped, but be explicit).
            let _ = child.start_kill();
            Err(AppError::Recording(
                "concat: ffmpeg exceeded the 15-minute watchdog — killed".into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deliverable(primary: &str, frags: &[&str]) -> Deliverable {
        Deliverable {
            primary_path: primary.to_string(),
            fragments: frags.iter().map(|s| s.to_string()).collect(),
            started_at_ms: 0,
        }
    }

    #[tokio::test]
    async fn single_fragment_no_preroll_returns_primary_untouched() {
        // No concat needed → returns the primary path without spawning ffmpeg or
        // touching the filesystem (the file need not even exist for this path).
        let d = deliverable("/rec/g.mp3", &["/rec/g.mp3"]);
        let out = finalize_deliverable(&d, None).await.unwrap();
        assert_eq!(out, "/rec/g.mp3");
    }

    #[test]
    fn scratch_paths_sit_next_to_the_primary_with_its_extension() {
        let (list, tmp) = scratch_paths(Path::new("/rec/sermon.m4a"));
        assert_eq!(list, Path::new("/rec/sermon_merge.txt"));
        assert_eq!(tmp, Path::new("/rec/sermon_merge_tmp.m4a"));
    }

    #[test]
    fn scratch_paths_handle_no_extension() {
        let (list, tmp) = scratch_paths(Path::new("/rec/sermon"));
        assert_eq!(list, Path::new("/rec/sermon_merge.txt"));
        assert_eq!(tmp, Path::new("/rec/sermon_merge_tmp"));
    }

    #[tokio::test]
    async fn atomic_replace_posix_moves_file() {
        if is_windows() {
            return; // POSIX rename path only.
        }
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().join("tmp.bin");
        let target = dir.path().join("final.bin");
        tokio::fs::write(&tmp, b"merged").await.unwrap();
        atomic_replace(&tmp, &target).await.unwrap();
        assert!(!tmp.exists(), "temp consumed");
        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"merged");
    }
}
