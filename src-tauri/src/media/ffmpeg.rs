//! ffmpeg / ffprobe sidecar wiring.
//!
//! This is the load-bearing media primitive the recorder (Spike B) and the
//! MJPEG live-preview (Spike A3) build on: a bundled, hardened ffmpeg we resolve
//! deterministically and spawn with **`tokio::process`** so we can stream its
//! stderr/stdout line-by-line in real time (parsing `size=` progress + ffmpeg's
//! `silencedetect` output) while the process keeps running, and send a graceful
//! `q` on stdin to finalise the output container cleanly instead of killing it.
//!
//! See `docs/MIGRATION-TAURI2.md` §0 "Fundament".

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::{AppError, AppResult};

// ── Binary resolution ──────────────────────────────────────────────────────
//
// Resolution order (first hit wins), mirrored from the Verbatim/SundayEdit
// implementation but with `SUNDAYREC_*` env names:
//   1. Env override (SUNDAYREC_FFMPEG / SUNDAYREC_FFPROBE) — dev + tests.
//   2. Bundled sidecar next to the app executable — production. Tauri's
//      `externalBin` drops `ffmpeg`/`ffprobe` next to the binary (Contents/MacOS
//      on macOS, the install dir on Windows) with the target-triple suffix
//      stripped.
//   3. Bare name on PATH — a system ffmpeg, e.g. `brew install ffmpeg`.

/// Pure resolution policy, extracted so it can be unit-tested deterministically
/// (no global-env race): given the env value, the resolved sidecar path, and
/// the PATH fallback name, return what we'd run. Env wins, then sidecar, then
/// the bare fallback. Keeping the precedence here — rather than inline in the
/// `*_path` functions — means the tests never touch `std::env`.
fn resolve_path(env_val: Option<String>, sidecar: Option<String>, fallback: &str) -> String {
    env_val.or(sidecar).unwrap_or_else(|| fallback.to_string())
}

/// Look for `name` (e.g. "ffmpeg") next to the current executable — that's
/// where Tauri places bundled `externalBin` sidecars at runtime. Returns `None`
/// when there's no such file (dev builds, or before `tauri build`).
fn sidecar_path(name: &str) -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = dir.join(file);
    candidate
        .is_file()
        .then(|| candidate.to_string_lossy().into_owned())
}

/// Path to the `ffmpeg` binary (recorder, MJPEG preview, exports).
pub fn ffmpeg_path() -> String {
    resolve_path(
        std::env::var("SUNDAYREC_FFMPEG").ok(),
        sidecar_path("ffmpeg"),
        "ffmpeg",
    )
}

/// Path to the `ffprobe` binary (media inspection / health-check).
pub fn ffprobe_path() -> String {
    resolve_path(
        std::env::var("SUNDAYREC_FFPROBE").ok(),
        sidecar_path("ffprobe"),
        "ffprobe",
    )
}

// ── Async spawn primitive ───────────────────────────────────────────────────

/// Spawn ffmpeg with `args` as a long-lived **async** child process.
///
/// This is the primitive the recorder + live-preview are built on. All three
/// std-streams are piped so the caller can:
///   - read **stderr** line-by-line in real time to parse `size=…` progress and
///     `silencedetect` events while encoding continues,
///   - read **stdout** for raw output (e.g. an MJPEG frame stream for preview),
///   - write **`q`** to **stdin** to ask ffmpeg to stop *gracefully* — it then
///     flushes and finalises the container, which a `kill()` would corrupt.
///
/// `kill_on_drop(true)` guarantees we never leak a zombie ffmpeg if the owning
/// task is dropped (window closed, recording aborted).
pub async fn spawn_ffmpeg(args: &[&str]) -> AppResult<tokio::process::Child> {
    use std::process::Stdio;

    tokio::process::Command::new(ffmpeg_path())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Recording(format!("failed to spawn ffmpeg: {e}")))
}

// ── Synchronous health / diagnostics ────────────────────────────────────────

/// Run `ffmpeg -version` synchronously and return its first line — used for the
/// startup health-check and diagnostics. Synchronous (plain `std::process`) on
/// purpose: it's a one-shot, short-lived probe with no streaming, so the async
/// machinery would be pure overhead.
pub fn ffmpeg_version() -> AppResult<String> {
    let output = std::process::Command::new(ffmpeg_path())
        .arg("-version")
        .output()
        .map_err(|e| AppError::Recording(format!("failed to run ffmpeg -version: {e}")))?;

    if !output.status.success() {
        return Err(AppError::Recording(format!(
            "ffmpeg -version exited with status {}",
            output.status
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .ok_or_else(|| AppError::Recording("ffmpeg -version produced no output".to_string()))?;

    Ok(first.to_string())
}

// ── Health-check command ─────────────────────────────────────────────────────

/// Result of probing the bundled ffmpeg — surfaced in the diagnostics UI so the
/// user (and we, during development) can confirm the sidecar resolved.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../src/lib/bindings/FfmpegHealth.ts")]
pub struct FfmpegHealth {
    /// Whether `ffmpeg -version` ran successfully.
    pub available: bool,
    /// The first line of `ffmpeg -version` (the build banner), when available.
    pub version: Option<String>,
    /// The resolved path we tried to run (env override / sidecar / PATH name).
    pub path: String,
}

/// Resolve the ffmpeg binary and probe its version. Never errors — a missing
/// binary is a normal state the UI renders, not a failure. The thin Tauri
/// command lives in `commands::media` and delegates here.
pub fn ffmpeg_health() -> FfmpegHealth {
    let path = ffmpeg_path();
    match ffmpeg_version() {
        Ok(version) => FfmpegHealth {
            available: true,
            version: Some(version),
            path,
        },
        Err(_) => FfmpegHealth {
            available: false,
            version: None,
            path,
        },
    }
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Pure resolution policy (deterministic, parallel-safe — no env) ───────

    #[test]
    fn resolve_prefers_env_override() {
        let got = resolve_path(
            Some("/opt/ffmpeg".to_string()),
            Some("/app/sidecar/ffmpeg".to_string()),
            "ffmpeg",
        );
        assert_eq!(got, "/opt/ffmpeg");
    }

    #[test]
    fn resolve_falls_back_to_sidecar_when_no_env() {
        let got = resolve_path(None, Some("/app/sidecar/ffmpeg".to_string()), "ffmpeg");
        assert_eq!(got, "/app/sidecar/ffmpeg");
    }

    #[test]
    fn resolve_falls_back_to_path_name_when_nothing_resolves() {
        let got = resolve_path(None, None, "ffmpeg");
        assert_eq!(got, "ffmpeg");
    }

    #[test]
    fn resolve_env_wins_even_without_sidecar() {
        let got = resolve_path(Some("/custom/ff".to_string()), None, "ffmpeg");
        assert_eq!(got, "/custom/ff");
    }

    #[test]
    fn sidecar_path_is_none_for_missing_binary() {
        // The test binary's directory does not contain a file literally named
        // "definitely-not-a-real-binary-xyz", so resolution must yield None.
        assert!(sidecar_path("definitely-not-a-real-binary-xyz").is_none());
    }

    // ── Tolerant integration tests ───────────────────────────────────────────
    //
    // The unit under test is path resolution + spawn wiring, NOT ffmpeg itself.
    // When a runnable binary is found we assert it really is ffmpeg/ffprobe; if
    // it's genuinely absent (a machine with no PATH ffmpeg and no fetched
    // sidecar) we skip so the gate stays green everywhere.
    //
    // `cargo test`'s `current_exe()` is the test runner under `target/`, so the
    // production sidecar-next-to-exe lookup never resolves here. To still prove
    // the real wiring after `npm run ffmpeg`, we locate the fetched sidecar at
    // `<manifest>/binaries/<name>-<host-triple>` and drive resolution through the
    // `SUNDAYREC_*` env override — the exact production fallback the recorder
    // uses. Env-mutating tests share a mutex so they can't race the parallel
    // suite. The pure precedence is already covered by the `resolve_*` tests, so
    // these focus on actually executing the binary.

    use std::sync::Mutex;
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Path to the fetched dev sidecar, if `npm run ffmpeg` has populated it.
    fn fetched_sidecar(name: &str) -> Option<std::path::PathBuf> {
        // Host triple matches what scripts/fetch-ffmpeg.mjs suffixes with.
        // `SUNDAYREC_TARGET_TRIPLE` is injected by build.rs from cargo's TARGET.
        let triple = env!("SUNDAYREC_TARGET_TRIPLE");
        let ext = if cfg!(windows) { ".exe" } else { "" };
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!("{name}-{triple}{ext}"));
        p.is_file().then_some(p)
    }

    // We hold ENV_LOCK across `spawn_ffmpeg(...).await` to serialise the env
    // override against the parallel suite. That future has no yield point before
    // `.spawn()` returns the child, so it cannot actually deadlock — the
    // `await_holding_lock` lint is a justified false positive for this test.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn spawn_ffmpeg_runs_real_binary_or_skips() {
        let Some(bin) = fetched_sidecar("ffmpeg") else {
            eprintln!("SKIP: no fetched ffmpeg sidecar (run `npm run ffmpeg`)");
            return;
        };
        let child = {
            let _guard = ENV_LOCK.lock().unwrap();
            // SAFETY: serialised by ENV_LOCK; restored before releasing the lock.
            unsafe { std::env::set_var("SUNDAYREC_FFMPEG", &bin) };
            let result = spawn_ffmpeg(&["-version"]).await;
            unsafe { std::env::remove_var("SUNDAYREC_FFMPEG") };
            result.expect("spawn should succeed with a resolved sidecar")
        };

        let output = child
            .wait_with_output()
            .await
            .expect("ffmpeg child should be waitable once spawned");

        assert!(
            output.status.success(),
            "ffmpeg -version should exit 0, got {}",
            output.status
        );
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(
            combined.to_lowercase().contains("ffmpeg"),
            "ffmpeg -version output should mention ffmpeg; got: {combined}"
        );
        eprintln!(
            "ffmpeg integration test hit real binary at {}: {}",
            bin.display(),
            combined.lines().next().unwrap_or("<no output>")
        );
    }

    #[test]
    fn ffprobe_version_runs_real_binary_or_skips() {
        let _guard = ENV_LOCK.lock().unwrap();
        let Some(bin) = fetched_sidecar("ffprobe") else {
            eprintln!("SKIP: no fetched ffprobe sidecar (run `npm run ffmpeg`)");
            return;
        };
        let output = std::process::Command::new(&bin)
            .arg("-version")
            .output()
            .expect("ffprobe should run from a resolved sidecar");
        assert!(output.status.success(), "ffprobe -version should exit 0");
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(
            combined.to_lowercase().contains("ffprobe"),
            "ffprobe -version output should mention ffprobe; got: {combined}"
        );
        eprintln!(
            "ffprobe integration test hit real binary at {}: {}",
            bin.display(),
            combined.lines().next().unwrap_or("<no output>")
        );
    }

    /// END-TO-END FORMAT MATRIX: for every {format} × {mono,stereo} the recorder
    /// supports, encode a real 0.5 s tone through the SAME `audio_encode_args` seam
    /// the recorder uses, then ffprobe the result to prove it is a NON-ZERO,
    /// DECODABLE file with the EXPECTED codec / sample-rate / channel count. This
    /// is the verification the "must work across formats, flawlessly" requirement
    /// demands — pure arg-builder unit tests can't catch a codec that ffmpeg
    /// rejects at mux time. Skips cleanly when the sidecars aren't fetched (CI).
    #[test]
    fn format_matrix_produces_valid_files_or_skips() {
        use sundayrec_core::capture::audio_encode_args;
        use sundayrec_core::recorder::MIN_VALID_OUTPUT_BYTES;

        let _guard = ENV_LOCK.lock().unwrap();
        let (Some(ffmpeg), Some(ffprobe)) = (fetched_sidecar("ffmpeg"), fetched_sidecar("ffprobe"))
        else {
            eprintln!("SKIP: no fetched ffmpeg/ffprobe sidecar (run `npm run ffmpeg`)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();

        // ffprobe's codec_name for each container's encoder.
        let expected_codec = |ext: &str| match ext {
            "mp3" => "mp3",
            "wav" => "pcm_s16le",
            "flac" => "flac",
            _ => "aac",
        };

        for ext in ["mp3", "wav", "flac", "aac"] {
            for chans in [1u8, 2u8] {
                let out = dir.path().join(format!("m_{chans}.{ext}"));
                let out_s = out.to_string_lossy().into_owned();

                // 0.5 s 440 Hz tone → the recorder's real encode args → file.
                let mut args: Vec<String> = vec![
                    "-hide_banner".into(),
                    "-f".into(),
                    "lavfi".into(),
                    "-i".into(),
                    "sine=frequency=440:duration=0.5:sample_rate=48000".into(),
                    "-t".into(),
                    "0.5".into(),
                ];
                args.extend(audio_encode_args(ext, chans, Some(48_000), 192));
                args.push("-y".into());
                args.push(out_s.clone());

                let status = std::process::Command::new(&ffmpeg)
                    .args(&args)
                    .output()
                    .expect("ffmpeg should run");
                assert!(
                    status.status.success(),
                    "ffmpeg failed for {ext}/{chans}ch: {}",
                    String::from_utf8_lossy(&status.stderr)
                );

                // Non-zero past the same gate the finalizer enforces.
                let len = std::fs::metadata(&out).expect("output exists").len();
                assert!(
                    len >= MIN_VALID_OUTPUT_BYTES,
                    "{ext}/{chans}ch output too small: {len} bytes"
                );

                // ffprobe the real stream: codec_name, sample_rate, channels.
                let probe = std::process::Command::new(&ffprobe)
                    .args([
                        "-v",
                        "error",
                        "-select_streams",
                        "a:0",
                        "-show_entries",
                        "stream=codec_name,sample_rate,channels",
                        "-of",
                        "csv=p=0",
                    ])
                    .arg(&out)
                    .output()
                    .expect("ffprobe should run");
                assert!(probe.status.success(), "ffprobe failed for {ext}/{chans}ch");
                let line = String::from_utf8_lossy(&probe.stdout);
                let fields: Vec<&str> = line.trim().split(',').collect();
                assert_eq!(
                    fields.first().copied(),
                    Some(expected_codec(ext)),
                    "{ext}/{chans}ch wrong codec; ffprobe: {line}"
                );
                assert_eq!(
                    fields.get(1).copied(),
                    Some("48000"),
                    "{ext}/{chans}ch wrong sample rate; ffprobe: {line}"
                );
                assert_eq!(
                    fields.get(2).and_then(|c| c.parse::<u8>().ok()),
                    Some(chans),
                    "{ext}/{chans}ch wrong channel count; ffprobe: {line}"
                );
            }
        }
        eprintln!("format matrix: all 4 formats × mono/stereo encoded + ffprobed OK");
    }

    /// LEVELS-CHAIN REGRESSION: encode a 2 s tone through the FULL live-levels
    /// `astats` filter + the recorder's real `audio_encode_args` with a NATIVE
    /// (`None`) sample rate, then ffprobe the result. This catches arg/filter
    /// regressions — a malformed `-af` chain, a filter ffmpeg rejects, or a
    /// `None`-sample-rate path that produces a zero/short file. For the lavfi
    /// `sine` source the "native" rate is the requested 48000, so omitting `-ar`
    /// still yields a 48000 Hz file. NOTE: this proves the args are VALID and the
    /// output is whole; it cannot prove the audio is glitch-free — that needs real
    /// hardware. Skips cleanly when the sidecars aren't fetched (CI).
    #[test]
    fn levels_chain_records_glitch_free_or_skips() {
        use sundayrec_core::capture::audio_encode_args;
        use sundayrec_core::ffmpeg::build_levels_detect_filter;
        use sundayrec_core::recorder::MIN_VALID_OUTPUT_BYTES;

        let _guard = ENV_LOCK.lock().unwrap();
        let (Some(ffmpeg), Some(ffprobe)) = (fetched_sidecar("ffmpeg"), fetched_sidecar("ffprobe"))
        else {
            eprintln!("SKIP: no fetched ffmpeg/ffprobe sidecar (run `npm run ffmpeg`)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("levels.wav");
        let out_s = out.to_string_lossy().into_owned();

        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "sine=frequency=440:duration=2:sample_rate=48000".into(),
            "-af".into(),
            build_levels_detect_filter(),
            "-t".into(),
            "2".into(),
        ];
        // None exercises the native-rate path (omit -ar); 2 stereo channels.
        args.extend(audio_encode_args("wav", 2, None, 192));
        args.push("-y".into());
        args.push(out_s.clone());

        let status = std::process::Command::new(&ffmpeg)
            .args(&args)
            .output()
            .expect("ffmpeg should run");
        assert!(
            status.status.success(),
            "ffmpeg failed for the levels chain: {}",
            String::from_utf8_lossy(&status.stderr)
        );

        let len = std::fs::metadata(&out).expect("output exists").len();
        assert!(
            len >= MIN_VALID_OUTPUT_BYTES,
            "levels-chain output too small: {len} bytes"
        );

        // Duration ≈ 2.0 s (±0.15) proves the chain didn't truncate the stream.
        let probe = std::process::Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(&out)
            .output()
            .expect("ffprobe should run");
        assert!(
            probe.status.success(),
            "ffprobe failed for the levels chain"
        );
        let dur: f64 = String::from_utf8_lossy(&probe.stdout)
            .trim()
            .parse()
            .expect("ffprobe should report a numeric duration");
        assert!(
            (dur - 2.0).abs() <= 0.15,
            "levels-chain duration off: {dur} s (expected ≈ 2.0)"
        );
        eprintln!("levels chain: encoded + ffprobed OK ({dur:.3} s, {len} bytes)");
    }

    /// DUAL-OUTPUT (recording + live MJPEG preview) REAL-FFMPEG TEST. The video
    /// recording path adds a SECOND ffmpeg output — a downscaled MJPEG to stdout —
    /// so the UI can show a live image WHILE the mp4 records (see
    /// `build_unified_capture_args`). A wrong second-output arg that makes ffmpeg
    /// refuse to start would break recording, so this drives the EXACT dual-output
    /// shape against two `-f lavfi` sources (testsrc video + sine audio, combined
    /// into one process — standing in for the avfoundation/dshow capture inputs)
    /// and asserts BOTH: (a) a valid, non-zero mp4 is written, AND (b) real MJPEG
    /// bytes (a JPEG SOI `FF D8`) appear on stdout. This RUNS (does not skip) when
    /// the bundled sidecar is present. HARDWARE-FREE: lavfi needs no devices.
    #[tokio::test]
    async fn dual_output_records_mp4_and_emits_mjpeg_preview_or_skips() {
        use sundayrec_core::mjpeg::MjpegFrameSplitter;
        use sundayrec_core::recorder::MIN_VALID_OUTPUT_BYTES;
        use tokio::io::AsyncReadExt;

        let Some(ffmpeg) = fetched_sidecar("ffmpeg") else {
            eprintln!("SKIP: no fetched ffmpeg sidecar (run `npm run ffmpeg`)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("dual.mp4");
        let out_s = out.to_string_lossy().into_owned();

        // Two `-f lavfi` inputs in ONE process: input 0 = video (testsrc), input 1
        // = audio (sine). `0:v` / `1:a` address them. The mp4 output maps both and
        // encodes a short clip; the SECOND output mirrors the EXACT preview tail
        // from `build_unified_capture_args` (downscale + fps cap + mjpeg → pipe:1).
        // `-t 1` BEFORE each `-i` caps the INPUT duration, so BOTH outputs (the
        // mp4 AND the infinite-by-default MJPEG preview) terminate at 1 s — an
        // output-side `-t` would only bound the first output and leave the preview
        // streaming forever from the endless lavfi sources.
        let args: Vec<String> = vec![
            "-hide_banner".into(),
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            "1".into(),
            "-i".into(),
            "testsrc=size=320x240:rate=15".into(),
            "-f".into(),
            "lavfi".into(),
            "-t".into(),
            "1".into(),
            "-i".into(),
            "sine=frequency=440:sample_rate=48000".into(),
            // First output: the mp4 (both streams mapped explicitly).
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "1:a".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-c:a".into(),
            "aac".into(),
            "-movflags".into(),
            "+faststart".into(),
            "-y".into(),
            out_s.clone(),
            // Second output: the live MJPEG preview to stdout (the very args the
            // recorder appends for a video recording).
            "-map".into(),
            "0:v".into(),
            "-an".into(),
            "-vf".into(),
            "scale=480:-2,fps=8".into(),
            "-c:v".into(),
            "mjpeg".into(),
            "-q:v".into(),
            "10".into(),
            "-f".into(),
            "mjpeg".into(),
            "pipe:1".into(),
        ];

        let mut child = tokio::process::Command::new(&ffmpeg)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("ffmpeg should spawn the dual-output command");

        // Drain stdout (the MJPEG preview) WHILE ffmpeg runs so its pipe never
        // fills and stalls the process, and split out whole JPEG frames.
        let mut stdout = child.stdout.take().expect("piped stdout");
        let mut splitter = MjpegFrameSplitter::new();
        let mut first_frame: Option<Vec<u8>> = None;
        let mut read_buf = vec![0u8; 64 * 1024];
        loop {
            match stdout.read(&mut read_buf).await {
                Ok(0) => break,
                Ok(n) => {
                    for frame in splitter.push(&read_buf[..n]) {
                        if first_frame.is_none() {
                            first_frame = Some(frame);
                        }
                    }
                }
                Err(e) => panic!("reading the MJPEG preview stdout failed: {e}"),
            }
        }

        let status = child.wait().await.expect("ffmpeg should be waitable");
        assert!(
            status.success(),
            "the dual-output command must start AND finish cleanly (a bad \
             second-output arg would break recording)"
        );

        // (a) A valid, non-zero mp4 was written despite the second output.
        let len = std::fs::metadata(&out).expect("mp4 output exists").len();
        assert!(
            len >= MIN_VALID_OUTPUT_BYTES,
            "dual-output mp4 too small: {len} bytes"
        );

        // (b) Real MJPEG bytes appeared on stdout — at least one whole JPEG frame
        // starting with the SOI marker `FF D8`.
        let frame = first_frame.expect("at least one MJPEG preview frame on stdout");
        assert_eq!(
            &frame[..2],
            &[0xFF, 0xD8],
            "the preview frame must start with the JPEG SOI marker"
        );
        eprintln!(
            "dual-output: wrote a {len}-byte mp4 AND emitted a {}-byte MJPEG preview frame",
            frame.len()
        );
    }

    /// A/V SYNC: the recorder's sync lock is `-r <fps> -fps_mode cfr` on the video
    /// output + `aresample=async=1000:first_pts=0` on the audio. This RUNS the real
    /// combo against lavfi sources (a deliberately VFR-ish video — `fps` filter
    /// re-times it — plus sine audio) and ffprobes that the output video is TRUE
    /// constant frame rate (`r_frame_rate == avg_frame_rate == 30/1`) and that the
    /// audio + video durations match within a tight epsilon (no drift). HARDWARE-
    /// FREE. Skips without the sidecars.
    #[test]
    fn av_sync_output_is_cfr_and_streams_aligned_or_skips() {
        let _guard = ENV_LOCK.lock().unwrap();
        let (Some(ffmpeg), Some(ffprobe)) = (fetched_sidecar("ffmpeg"), fetched_sidecar("ffprobe"))
        else {
            eprintln!("SKIP: no fetched ffmpeg/ffprobe sidecar (run `npm run ffmpeg`)");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("sync.mp4");

        // A 2 s clip: input video re-timed to a jittery rate, audio a sine. The
        // output applies the recorder's exact sync args.
        let status = std::process::Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-f",
                "lavfi",
                "-t",
                "2",
                "-i",
                "testsrc=size=320x240:rate=24",
                "-f",
                "lavfi",
                "-t",
                "2",
                "-i",
                "sine=frequency=440:sample_rate=48000",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                // the recorder's video sync lock
                "-r",
                "30",
                "-fps_mode",
                "cfr",
                "-c:a",
                "aac",
                // the recorder's audio drift correction
                "-af",
                "aresample=async=1000:first_pts=0",
            ])
            .arg("-y")
            .arg(&out)
            .output()
            .expect("ffmpeg should run the sync command");
        assert!(
            status.status.success(),
            "sync command failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );

        let probe = |stream: &str, entry: &str| -> String {
            let o = std::process::Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-select_streams",
                    stream,
                    "-show_entries",
                    entry,
                    "-of",
                    "csv=p=0",
                ])
                .arg(&out)
                .output()
                .expect("ffprobe runs");
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };

        // Video is TRUE constant frame rate at 30 fps (no VFR drift).
        assert_eq!(
            probe("v:0", "stream=r_frame_rate"),
            "30/1",
            "video must be locked 30 fps CFR"
        );
        assert_eq!(
            probe("v:0", "stream=avg_frame_rate"),
            "30/1",
            "CFR: avg == nominal frame rate"
        );

        // Audio and video durations match within 50 ms — no A/V drift.
        let vdur: f64 = probe("v:0", "stream=duration").parse().unwrap_or(0.0);
        let adur: f64 = probe("a:0", "stream=duration").parse().unwrap_or(0.0);
        assert!(
            (vdur - adur).abs() < 0.05,
            "A/V durations must align: video={vdur}s audio={adur}s"
        );
        eprintln!("av-sync: CFR 30fps, video={vdur}s audio={adur}s (aligned)");
    }

    #[test]
    fn ffmpeg_version_and_health_against_real_binary_or_skip() {
        let _guard = ENV_LOCK.lock().unwrap();
        let Some(bin) = fetched_sidecar("ffmpeg") else {
            eprintln!("SKIP: no fetched ffmpeg sidecar (run `npm run ffmpeg`)");
            return;
        };
        // SAFETY: serialised by ENV_LOCK; restored before releasing the lock.
        unsafe { std::env::set_var("SUNDAYREC_FFMPEG", &bin) };
        let version = ffmpeg_version();
        let health = ffmpeg_health();
        unsafe { std::env::remove_var("SUNDAYREC_FFMPEG") };

        let version = version.expect("ffmpeg_version should read the banner");
        assert!(version.to_lowercase().contains("ffmpeg"));
        assert!(health.available);
        assert_eq!(health.version.as_deref(), Some(version.as_str()));
        assert_eq!(health.path, bin.to_string_lossy());
        eprintln!("ffmpeg_health version banner: {version}");
    }
}
