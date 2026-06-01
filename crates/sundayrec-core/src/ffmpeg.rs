//! Pure ffmpeg filter-string builders.
//!
//! Ported from the Electron `unified-recorder.ts` / `recorder-utils.ts`
//! behaviour. These functions only build strings — they never spawn ffmpeg.
//! That keeps them trivially testable and makes the *hardened argument
//! knowledge* (which took real field debugging to get right) the asset we
//! carry forward, independent of how the process is actually launched.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Capture host platform. We only branch on it where the underlying OS audio
/// stack actually forces a difference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/Platform.ts")]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    MacOS,
    Windows,
    Linux,
}

/// A/V drift-correction audio filter for the unified (single-process) capture.
///
/// WHY: on macOS, camera + microphone are captured through one avfoundation
/// input and therefore share a single hardware clock — no drift, so no filter.
/// On Windows the camera and the mic are two separate dshow inputs driven by
/// two independent clocks; over a 60–90-minute sermon they drift apart and the
/// audio slides out of sync. `aresample=async=1000:first_pts=0` resamples the
/// audio to track the video clock (stretching/compressing up to 1000 samples
/// per second) and pins the first PTS to 0 so the streams start aligned.
///
/// Returns `""` when no correction is needed (the caller simply omits the
/// filter from the chain).
pub fn unified_audio_drift_filter(platform: Platform) -> &'static str {
    match platform {
        Platform::Windows => "aresample=async=1000:first_pts=0",
        Platform::MacOS | Platform::Linux => "",
    }
}

/// Build the `silencedetect` filter string.
///
/// WHY: a muted mixer must never yield a 2-hour silent file with no alert.
/// `silencedetect` emits `silence_start` / `silence_end` markers on ffmpeg's
/// stderr, which the [`crate::silence`] watcher reacts to.
///
/// - When the user has opted into stop-on-silence, the threshold is the user's
///   chosen dB value, clamped to a sane `[-70, -10]` range (defaulting to
///   `-50` dB). A value above `-10` would trip on normal-but-quiet speech; a
///   value below `-70` would never trip at all.
/// - When stop-on-silence is off we still want the *warning* path armed, so we
///   emit a fixed, fairly permissive `-55 dB` detector. The watcher decides
///   what to do with the markers; this builder just guarantees they exist.
///
/// `duration=1` means a stretch must be silent for at least one second before
/// a `silence_start` is emitted — debounces brief gaps between sentences.
pub fn build_silence_detect_filter(
    stop_on_silence: bool,
    silence_threshold_db: Option<i32>,
) -> String {
    if stop_on_silence {
        let noise = silence_threshold_db.unwrap_or(-50).clamp(-70, -10);
        format!("silencedetect=noise={noise}dB:duration=1")
    } else {
        "silencedetect=noise=-55dB:duration=1".to_string()
    }
}

/// Build the live per-channel peak-level `astats` filter string.
///
/// WHY: the "Opptaksmodus" UI shows L/R level meters. Rather than open a SECOND
/// audio stream (which would grab the mic twice — see the old RecordingScreen
/// note), we have the recorder's OWN ffmpeg emit periodic per-channel peak
/// levels to stderr, which [`crate::levels::parse_levels`] reads and the engine
/// forwards to the UI.
///
/// `astats` is a **pass-through** filter: it copies its input to its output
/// untouched and only writes telemetry to stderr — so adding it to the `-af`
/// chain NEVER alters the recorded file.
///
/// - `metadata=1` makes astats publish the measurements as frame metadata.
/// - `reset=10` re-measures every 10 frames (~100 ms at 48 kHz/1024-sample
///   frames) → a responsive attack. The slow RELEASE (peak-hold) is done in the
///   UI, not here.
/// - `measure_perchannel=Peak_level` restricts the measurement to ONLY the
///   per-channel peak we need (keeps stderr small and the parser unambiguous).
/// - `ametadata=mode=print:file=/dev/stderr` is what makes the meter LIVE:
///   `astats` alone only logs its summary ONCE at EOF (the meter sat frozen for
///   the whole take); `ametadata` prints the current frame metadata every frame,
///   e.g. `lavfi.astats.1.Peak_level=-12.5` (ch1=left) / `…2.Peak_level=…`
///   (ch2=right), which [`crate::levels::parse_ametadata_peak`] reads. NOTE:
///   `/dev/stderr` is a unix path — the recorder is macOS-focused; Windows would
///   need a different sink (deferred).
pub fn build_levels_detect_filter() -> String {
    "astats=metadata=1:reset=10:measure_perchannel=Peak_level,ametadata=mode=print:file=/dev/stderr"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_filter_is_perchannel_peak_passthrough() {
        assert_eq!(
            build_levels_detect_filter(),
            "astats=metadata=1:reset=10:measure_perchannel=Peak_level,ametadata=mode=print:file=/dev/stderr"
        );
    }

    #[test]
    fn levels_filter_prints_live_per_frame_metadata() {
        let f = build_levels_detect_filter();
        assert!(f.starts_with("astats="), "must be an astats filter");
        assert!(f.contains("metadata=1"), "needs metadata output");
        assert!(f.contains("reset=10"), "needs a short, responsive window");
        assert!(
            f.contains("measure_perchannel=Peak_level"),
            "needs per-channel peak"
        );
        // The live part: ametadata prints per-frame metadata to stderr so the
        // meter updates DURING the take (astats alone only logs once at EOF).
        assert!(
            f.contains("ametadata=mode=print"),
            "needs ametadata to stream live levels"
        );
        assert!(
            f.contains("file=/dev/stderr"),
            "live levels must land on the recorder's stderr reader"
        );
    }

    #[test]
    fn windows_gets_aresample_drift_correction() {
        assert_eq!(
            unified_audio_drift_filter(Platform::Windows),
            "aresample=async=1000:first_pts=0"
        );
    }

    #[test]
    fn mac_and_linux_need_no_drift_correction() {
        assert_eq!(unified_audio_drift_filter(Platform::MacOS), "");
        assert_eq!(unified_audio_drift_filter(Platform::Linux), "");
    }

    #[test]
    fn silence_filter_uses_default_when_stop_on_and_no_threshold() {
        assert_eq!(
            build_silence_detect_filter(true, None),
            "silencedetect=noise=-50dB:duration=1"
        );
    }

    #[test]
    fn silence_filter_honours_user_threshold() {
        assert_eq!(
            build_silence_detect_filter(true, Some(-40)),
            "silencedetect=noise=-40dB:duration=1"
        );
    }

    #[test]
    fn silence_filter_clamps_extremes() {
        // Too loud -> clamped to -10.
        assert_eq!(
            build_silence_detect_filter(true, Some(0)),
            "silencedetect=noise=-10dB:duration=1"
        );
        // Too quiet -> clamped to -70.
        assert_eq!(
            build_silence_detect_filter(true, Some(-120)),
            "silencedetect=noise=-70dB:duration=1"
        );
    }

    #[test]
    fn silence_filter_fixed_when_stop_off() {
        // Threshold is ignored entirely when stop-on-silence is off.
        assert_eq!(
            build_silence_detect_filter(false, Some(-40)),
            "silencedetect=noise=-55dB:duration=1"
        );
        assert_eq!(
            build_silence_detect_filter(false, None),
            "silencedetect=noise=-55dB:duration=1"
        );
    }
}
