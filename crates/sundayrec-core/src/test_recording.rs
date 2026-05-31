//! Test-recording decisions — pure, GUI-free, fs/network-free.
//!
//! Ports the Electron `src/main/test-recorder.ts` decisions: the short test
//! capture's ffmpeg argv, the file-size sanity floor, the stderr → error-kind
//! classifier, and the `astats` RMS → signal-strength classifier. The Electron
//! module interleaved these with the actual `spawn`/`stat`/`unlink` I/O; here we
//! keep ONLY the deterministic parts so they're unit-tested without ffmpeg.
//!
//! The `src-tauri` shell (behind a HARDWARE-UNVERIFIED seam) spawns the ffmpeg
//! sidecar with [`build_test_args`], stats the output, runs the `astats` pass,
//! and feeds the stderr/size facts back into the classifiers here.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Duration of the test capture, seconds. Matches Electron `TEST_DURATION_SEC`.
pub const TEST_DURATION_SEC: u32 = 10;

/// A test file smaller than this almost certainly captured no audio. Matches the
/// Electron `stat.size < 5_000` "no_audio" floor.
pub const MIN_TEST_SIZE_BYTES: u64 = 5_000;

/// Why a test recording failed. Mirrors the Electron error strings so the
/// renderer's i18n keys carry across unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/TestRecordingError.ts")]
#[serde(rename_all = "snake_case")]
pub enum TestRecordingError {
    /// ffmpeg couldn't find the named device.
    DeviceNotFound,
    /// The OS denied microphone access (macOS TCC / Windows privacy).
    DevicePermissionDenied,
    /// Any other non-zero ffmpeg exit.
    FfmpegError,
    /// ffmpeg succeeded but the file was implausibly small (no signal captured).
    NoAudio,
}

/// Measured signal strength of a test recording. Mirrors the Electron
/// `'silent' | 'low' | 'normal'` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/TestRecordingSignal.ts")]
#[serde(rename_all = "lowercase")]
pub enum TestRecordingSignal {
    /// Effectively muted / unplugged (RMS < −55 dB).
    Silent,
    /// Weak signal — gain too low or mic too far (−55 ≤ RMS < −30 dB).
    Low,
    /// Normal speech level.
    Normal,
}

/// Build the ffmpeg argv for a short test capture to `out_path` from the resolved
/// input (`input_format` is the platform capture format, `device` the address).
/// Mirrors the Electron arg list: `-nostdin -hide_banner -f <fmt> [-rtbufsize
/// 50M for wasapi] -i <device> -t <dur> <codec…> -y <out>`. The mp3/128 mono
/// codec is fixed (a quick, small test file) — same as Electron's
/// `buildCodecArgs({ format: 'mp3', bitrate: '128' })` collapsed to its result.
pub fn build_test_args(input_format: &str, device: &str, out_path: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-f".into(),
        input_format.into(),
    ];
    // Windows WASAPI needs a real-time buffer to avoid xruns at startup.
    if input_format == "wasapi" {
        args.push("-rtbufsize".into());
        args.push("50M".into());
    }
    args.push("-i".into());
    // WASAPI default device is the empty string → ffmpeg wants `:`.
    let dev = if input_format == "wasapi" && device.is_empty() {
        ":".to_string()
    } else {
        device.to_string()
    };
    args.push(dev);
    args.push("-t".into());
    args.push(TEST_DURATION_SEC.to_string());
    // Fixed mp3/128k mono encode for a fast, small test file.
    args.extend([
        "-ac".into(),
        "1".into(),
        "-c:a".into(),
        "libmp3lame".into(),
        "-b:a".into(),
        "128k".into(),
    ]);
    args.push("-y".into());
    args.push(out_path.into());
    args
}

/// Build the ffmpeg argv for the `astats` RMS measurement pass over `path`.
/// Mirrors the Electron `measureRms` argv.
pub fn build_astats_args(path: &str) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-i".into(),
        path.into(),
        "-af".into(),
        "astats=metadata=1:reset=0".into(),
        "-f".into(),
        "null".into(),
        "-".into(),
    ]
}

/// Classify a non-zero ffmpeg exit's stderr into an error kind. Direct port of
/// the Electron substring checks (case-insensitive): "no such"/"not found" →
/// device-not-found; "permission"/"access is denied" → permission; else generic.
pub fn classify_ffmpeg_error(stderr: &str) -> TestRecordingError {
    let lower = stderr.to_lowercase();
    if lower.contains("no such") || lower.contains("not found") {
        TestRecordingError::DeviceNotFound
    } else if lower.contains("permission") || lower.contains("access is denied") {
        TestRecordingError::DevicePermissionDenied
    } else {
        TestRecordingError::FfmpegError
    }
}

/// Whether a test file's byte size is large enough to be plausible audio.
pub fn size_is_plausible(size_bytes: u64) -> bool {
    size_bytes >= MIN_TEST_SIZE_BYTES
}

/// Parse the strongest `RMS level dB:` value out of an `astats` stderr blob.
/// Returns `None` when no value parses (caller treats that as "normal" rather
/// than flagging a working test as silent). Mirrors the Electron regex sweep.
pub fn parse_strongest_rms(stderr: &str) -> Option<f64> {
    const MARKER: &str = "RMS level dB:";
    let mut strongest = f64::NEG_INFINITY;
    let mut found = false;
    for line in stderr.lines() {
        if let Some(idx) = line.find(MARKER) {
            let tail = line[idx + MARKER.len()..].trim();
            // Take the leading numeric token (e.g. "-23.4" from "-23.4 something").
            let token: String = tail
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '.' || *c == '+')
                .collect();
            if let Ok(v) = token.parse::<f64>() {
                if v.is_finite() && v > strongest {
                    strongest = v;
                    found = true;
                }
            }
        }
    }
    found.then_some(strongest)
}

/// Classify a strongest-RMS dB value into a signal-strength bucket. Mirrors the
/// Electron thresholds: < −55 dB silent, < −30 dB low, else normal. A `None`
/// (parse failure) maps to `Normal` so a working test isn't mislabelled.
pub fn classify_signal(strongest_rms_db: Option<f64>) -> TestRecordingSignal {
    match strongest_rms_db {
        Some(db) if db < -55.0 => TestRecordingSignal::Silent,
        Some(db) if db < -30.0 => TestRecordingSignal::Low,
        _ => TestRecordingSignal::Normal,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_avfoundation_shape() {
        let a = build_test_args("avfoundation", ":0", "/tmp/t.mp3");
        assert_eq!(a[0], "-nostdin");
        assert!(a.contains(&"avfoundation".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-i" && w[1] == ":0"));
        assert!(a.windows(2).any(|w| w[0] == "-t" && w[1] == "10"));
        assert!(a.contains(&"libmp3lame".to_string()));
        assert_eq!(a.last().unwrap(), "/tmp/t.mp3");
        // No wasapi rtbufsize on non-wasapi.
        assert!(!a.contains(&"-rtbufsize".to_string()));
    }

    #[test]
    fn args_wasapi_adds_rtbufsize_and_default_colon() {
        let a = build_test_args("wasapi", "", "C:\\t.mp3");
        assert!(a.windows(2).any(|w| w[0] == "-rtbufsize" && w[1] == "50M"));
        // empty wasapi device → ":"
        assert!(a.windows(2).any(|w| w[0] == "-i" && w[1] == ":"));
    }

    #[test]
    fn args_wasapi_named_device_passes_through() {
        let a = build_test_args("wasapi", "audio=Mic", "C:\\t.mp3");
        assert!(a.windows(2).any(|w| w[0] == "-i" && w[1] == "audio=Mic"));
    }

    #[test]
    fn astats_args_shape() {
        let a = build_astats_args("/tmp/t.mp3");
        assert!(a.contains(&"astats=metadata=1:reset=0".to_string()));
        assert!(a.windows(2).any(|w| w[0] == "-i" && w[1] == "/tmp/t.mp3"));
        assert_eq!(a.last().unwrap(), "-");
    }

    #[test]
    fn classify_device_not_found() {
        assert_eq!(
            classify_ffmpeg_error("Input/output error: No such device"),
            TestRecordingError::DeviceNotFound
        );
        assert_eq!(
            classify_ffmpeg_error("device not found"),
            TestRecordingError::DeviceNotFound
        );
    }

    #[test]
    fn classify_permission() {
        assert_eq!(
            classify_ffmpeg_error("Operation not permitted (Permission denied)"),
            TestRecordingError::DevicePermissionDenied
        );
        assert_eq!(
            classify_ffmpeg_error("Access is denied."),
            TestRecordingError::DevicePermissionDenied
        );
    }

    #[test]
    fn classify_generic() {
        assert_eq!(
            classify_ffmpeg_error("Conversion failed!"),
            TestRecordingError::FfmpegError
        );
    }

    #[test]
    fn size_floor() {
        assert!(!size_is_plausible(4_999));
        assert!(size_is_plausible(5_000));
        assert!(size_is_plausible(200_000));
    }

    #[test]
    fn rms_picks_strongest() {
        let stderr = "\
[Parsed_astats] RMS level dB: -40.0
[Parsed_astats] RMS level dB: -23.4
[Parsed_astats] RMS level dB: -60.0";
        assert_eq!(parse_strongest_rms(stderr), Some(-23.4));
    }

    #[test]
    fn rms_none_when_absent() {
        assert_eq!(parse_strongest_rms("no stats here"), None);
    }

    #[test]
    fn signal_thresholds() {
        assert_eq!(classify_signal(Some(-60.0)), TestRecordingSignal::Silent);
        assert_eq!(classify_signal(Some(-55.0)), TestRecordingSignal::Low); // boundary: not < -55
        assert_eq!(classify_signal(Some(-40.0)), TestRecordingSignal::Low);
        assert_eq!(classify_signal(Some(-30.0)), TestRecordingSignal::Normal); // boundary
        assert_eq!(classify_signal(Some(-12.0)), TestRecordingSignal::Normal);
        // parse failure → normal (don't flag a working test as silent)
        assert_eq!(classify_signal(None), TestRecordingSignal::Normal);
    }
}
