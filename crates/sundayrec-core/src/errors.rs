//! Centralised ffmpeg-stderr error classification.
//!
//! Ported from the Electron `recorder-utils.ts` `classifyRecordingError`
//! (single source of truth shared by audio-only, video-only and unified
//! capture). Earlier each recorder had its own classifier with slightly
//! different patterns — audio-disconnect errors slipped through the video
//! classifier as a generic device error, causing 20-attempt reconnect loops on
//! what should have been a fail-stop. This one set covers BOTH audio and video
//! failure modes so the unified process can use it directly.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Stable error codes the recorder watchdog and the UI localisation switch on.
///
/// Serialised in `snake_case` to match the Electron string union
/// (`device_not_found`, `device_permission_denied`, …) so existing
/// expectations and any persisted data line up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/RecordingErrorCode.ts")]
#[serde(rename_all = "snake_case")]
pub enum RecordingErrorCode {
    DeviceNotFound,
    DevicePermissionDenied,
    DeviceBusy,
    DiskFull,
    DeviceDisconnected,
    /// No pattern matched — the watchdog treats this as transient and retries.
    DeviceError,
}

/// (code, patterns) groups, in priority order. Mirrors the Electron
/// `PATTERN_GROUPS` array verbatim — both the strings and their ordering.
///
/// Order matters: the more specific groups (permission, busy, disk_full) are
/// listed before the catch-all `device_disconnected` so they win when stderr
/// contains overlapping signals (e.g. a permission error that also mentions
/// "i/o error" further down).
const PATTERN_GROUPS: &[(RecordingErrorCode, &[&str])] = &[
    (
        RecordingErrorCode::DeviceNotFound,
        &[
            "device not found",
            "no such audio device",
            "no such audio input",
            "no such file or directory",
            "no devices found",
            "no audio endpoint",
            "no audio endpoint device",
            "no audio device",
            "audio device not found",
            "no video device",
            "no such video",
            "video device not found",
            "could not find audio",
            "cannot find audio",
            "failed to find audio",
            "could not find video",
            "failed to find video",
            "no capture device",
            "avfoundation: device",
            "the handle is invalid",
            "the system cannot find the file specified",
            "audclnt_e_device_not_active",
            "mmdevapi",
            "failed to create audio client",
        ],
    ),
    (
        RecordingErrorCode::DevicePermissionDenied,
        &[
            "access is denied",
            "access denied",
            "permission",
            "not permitted",
            "avfoundation: video not enabled",
            "authorization",
            "microphone access",
            "camera access",
            "privacy",
            "tcm_access",
            "e_accessdenied",
        ],
    ),
    (
        RecordingErrorCode::DeviceBusy,
        &[
            "already in use",
            "device busy",
            "being used by another",
            "resource busy",
            "device or resource busy",
            "audclnt_e_device_in_use",
            "audclnt_e_exclusive_mode_not_allowed",
            "audclnt_e_already_initialized",
            "audclnt_e_wrong_endpoint_type",
        ],
    ),
    (
        RecordingErrorCode::DiskFull,
        &[
            "no space left",
            "disk full",
            "enospc",
            // Locale / quota / newer-ffmpeg phrasings of "out of space".
            "disk quota exceeded",
            "out of disk space",
            "not enough space",
        ],
    ),
    (
        RecordingErrorCode::DeviceDisconnected,
        &[
            "broken pipe",
            "i/o error",
            "input/output",
            "unplugged",
            "audclnt_e_device_invalidated",
            "connection reset",
            "eof",
            // Mid-recording device loss phrasings (USB pull, sleep, hub reset).
            "device disconnected",
            "device removed",
            "device not responding",
            "no longer available",
        ],
    ),
];

/// Map an ffmpeg stderr blob to a stable error code.
///
/// Matching is case-insensitive (we lowercase the input once). Returns
/// [`RecordingErrorCode::DeviceError`] when nothing matches.
pub fn classify_recording_error(stderr: &str) -> RecordingErrorCode {
    let s = stderr.to_lowercase();
    for (code, patterns) in PATTERN_GROUPS {
        if patterns.iter().any(|p| s.contains(p)) {
            return *code;
        }
    }
    RecordingErrorCode::DeviceError
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unmatched_stderr_is_device_error() {
        assert_eq!(
            classify_recording_error("some totally unrelated noise"),
            RecordingErrorCode::DeviceError
        );
    }

    #[test]
    fn detects_device_not_found() {
        assert_eq!(
            classify_recording_error("[AVFoundation indev] No such audio device"),
            RecordingErrorCode::DeviceNotFound
        );
    }

    #[test]
    fn detects_permission_denied() {
        assert_eq!(
            classify_recording_error("Error: access is denied to the microphone"),
            RecordingErrorCode::DevicePermissionDenied
        );
    }

    #[test]
    fn detects_device_busy() {
        assert_eq!(
            classify_recording_error("AUDCLNT_E_DEVICE_IN_USE: device busy"),
            RecordingErrorCode::DeviceBusy
        );
    }

    #[test]
    fn detects_disk_full() {
        assert_eq!(
            classify_recording_error("av_interleaved_write_frame(): No space left on device"),
            RecordingErrorCode::DiskFull
        );
    }

    #[test]
    fn detects_disconnected() {
        assert_eq!(
            classify_recording_error("Broken pipe while writing"),
            RecordingErrorCode::DeviceDisconnected
        );
    }

    #[test]
    fn detects_quota_and_disconnect_variants() {
        assert_eq!(
            classify_recording_error("write failed: Disk quota exceeded"),
            RecordingErrorCode::DiskFull
        );
        assert_eq!(
            classify_recording_error("avfoundation: capture device disconnected"),
            RecordingErrorCode::DeviceDisconnected
        );
        assert_eq!(
            classify_recording_error("USB audio device removed during capture"),
            RecordingErrorCode::DeviceDisconnected
        );
    }

    #[test]
    fn classification_is_case_insensitive() {
        assert_eq!(
            classify_recording_error("DEVICE BUSY"),
            RecordingErrorCode::DeviceBusy
        );
    }

    #[test]
    fn specific_pattern_wins_over_catch_all() {
        // Contains both a permission signal ("access is denied") AND a
        // disconnect signal ("i/o error"). Permission is listed first and must
        // win.
        let stderr = "access is denied; subsequent i/o error on stream";
        assert_eq!(
            classify_recording_error(stderr),
            RecordingErrorCode::DevicePermissionDenied
        );
    }
}
