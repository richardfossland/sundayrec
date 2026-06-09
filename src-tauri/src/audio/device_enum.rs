//! Real ffmpeg device enumeration (F2.1) — the plumbing that drives the pure
//! core parsers with a live `ffmpeg -list_devices` run.
//!
//! This replaces the Spike-B stub in `recorder::engine::list_recording_devices`
//! (which reused the cpal input list as `FfmpegDevice`s with no avfoundation
//! index). Here we ask ffmpeg to ENUMERATE devices and parse its stderr with the
//! fixtures-tested [`sundayrec_core::device_enum`] parsers, so the recorder gets
//! the real avfoundation indices / dshow names it needs to address a capture.
//!
//! ## ⚠️ HARDWARE / GUI-UNVERIFIED
//!
//! The parsers are fully fixtures-tested in core, but the actual `ffmpeg
//! -list_devices` spawn here needs a real machine with real devices to exercise:
//! the unit test below only checks the platform argument shape (pure), never the
//! process. It MUST be smoke-tested on real hardware (open the app → device
//! picker lists the connected mic + camera) before F2.1 is declared done.
//!
//! ## audio: cpal vs ffmpeg
//!
//! Two audio lists serve two jobs. **cpal**
//! ([`crate::audio::devices::list_input_devices`]) drives the live **VU meter**
//! — cpal opens the input stream the meter reads. **ffmpeg** (here) supplies the
//! names/avfoundation-indices the **recorder** addresses for capture. They're
//! related by device *name* (the fuzzy device-match moat bridges any naming
//! differences between the two backends). For F2.1 we return both ffmpeg lists in
//! the inventory and leave the cpal list to the existing `list_input_devices`
//! command the VU meter already calls.

use serde::{Deserialize, Serialize};
use sundayrec_core::device_enum::{
    parse_avfoundation_device_list, parse_dshow_device_list, parse_video_avfoundation_device_list,
    parse_video_dshow_device_list,
};
use sundayrec_core::device_match::FfmpegDevice;
use tokio::io::AsyncReadExt;
use ts_rs::TS;

use crate::error::AppResult;
use crate::media::ffmpeg::spawn_ffmpeg;

/// The capture devices ffmpeg can see, split by direction. Audio inputs feed the
/// recorder's mic match; video inputs feed the camera match.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Default)]
#[ts(export, export_to = "../../src/lib/bindings/DeviceInventory.ts")]
pub struct DeviceInventory {
    /// Microphones / line inputs ffmpeg enumerated (avfoundation index on macOS,
    /// dshow name on Windows). The VU meter still uses the cpal list; these carry
    /// the addressing the recorder needs. See module docs.
    pub audio_inputs: Vec<FfmpegDevice>,
    /// Cameras ffmpeg enumerated. Empty on audio-only setups.
    pub video_inputs: Vec<FfmpegDevice>,
}

/// The ffmpeg args that ask it to *enumerate* (not capture) on this platform.
/// Pure so the argument shape is unit-tested without spawning ffmpeg.
///
///   - macOS:   `-f avfoundation -list_devices true -i "" -hide_banner`
///   - Windows: `-list_devices true -f dshow -i dummy -hide_banner`
///
/// On both, ffmpeg prints the device list to **stderr** and exits non-zero (no
/// real input) — the caller must not treat that as a failure.
fn list_devices_args() -> Vec<&'static str> {
    if cfg!(target_os = "windows") {
        vec![
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
            "-hide_banner",
        ]
    } else {
        // macOS avfoundation (and a harmless default on Linux dev boxes, which
        // simply yields an empty list).
        vec![
            "-f",
            "avfoundation",
            "-list_devices",
            "true",
            "-i",
            "",
            "-hide_banner",
        ]
    }
}

/// Parse an enumeration `stderr` blob into a [`DeviceInventory`] for the current
/// platform. Pure — the spawn/IO is separate so this is unit-testable with
/// fixtures (and shares the core parsers).
fn parse_inventory(stderr: &str) -> DeviceInventory {
    if cfg!(target_os = "windows") {
        DeviceInventory {
            audio_inputs: parse_dshow_device_list(stderr),
            video_inputs: parse_video_dshow_device_list(stderr),
        }
    } else {
        DeviceInventory {
            audio_inputs: parse_avfoundation_device_list(stderr),
            video_inputs: parse_video_avfoundation_device_list(stderr),
        }
    }
}

/// Run `ffmpeg -list_devices` and parse its stderr into a [`DeviceInventory`].
///
/// `-list_devices` writes to **stderr** and ffmpeg exits **non-zero by design**
/// (there is no input to capture) — we therefore read stderr to EOF and ignore
/// the exit status entirely; a non-zero code here is NOT an error. A genuine
/// spawn failure (no ffmpeg binary) propagates as [`AppError`].
///
/// ⚠️ HARDWARE-UNVERIFIED — see module header.
pub async fn enumerate_ffmpeg_devices() -> AppResult<DeviceInventory> {
    let args = list_devices_args();
    let mut child = spawn_ffmpeg(&args).await?;

    // Drain stderr fully. We deliberately do NOT inspect the exit code.
    let mut stderr_buf = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut bytes = Vec::new();
        // Best-effort read; partial output still parses (each line is independent).
        let _ = stderr.read_to_end(&mut bytes).await;
        stderr_buf = String::from_utf8_lossy(&bytes).into_owned();
    }
    // Reap the child so we don't leave a zombie (status ignored by design).
    let _ = child.wait().await;

    Ok(parse_inventory(&stderr_buf))
}

/// Short time-to-live for the cached enumeration below. Long enough to fold the
/// device picker's back-to-back calls (audio list + video list + the "is it seen
/// by ffmpeg" warn) into ONE `ffmpeg -list_devices` spawn — which on Windows
/// dshow can take hundreds of ms — but short enough that a freshly-plugged device
/// shows up almost immediately.
const ENUM_CACHE_TTL: std::time::Duration = std::time::Duration::from_millis(1500);

type EnumCache = std::sync::Mutex<Option<(std::time::Instant, DeviceInventory)>>;
static ENUM_CACHE: EnumCache = std::sync::Mutex::new(None);

/// Enumerate ffmpeg devices for the UI device picker, reusing a result from the
/// last [`ENUM_CACHE_TTL`] if available. The recorder `start()` uses
/// [`enumerate_ffmpeg_devices_within`] with a short [`RECORD_START_ENUM_MAX_AGE`]
/// window (warmed when the record modal opens), and diagnostics / test-recording
/// still call the uncached [`enumerate_ffmpeg_devices`].
pub async fn enumerate_ffmpeg_devices_cached() -> AppResult<DeviceInventory> {
    enumerate_ffmpeg_devices_within(ENUM_CACHE_TTL).await
}

/// Enumerate, reusing the cache only if its entry is younger than `max_age`,
/// otherwise doing a fresh spawn (and refreshing the cache). Shared by the UI
/// picker (1.5 s) and the record-start path (a few seconds, warmed when the record
/// modal opens — see below).
pub async fn enumerate_ffmpeg_devices_within(
    max_age: std::time::Duration,
) -> AppResult<DeviceInventory> {
    if let Ok(guard) = ENUM_CACHE.lock() {
        if let Some((at, inv)) = guard.as_ref() {
            if at.elapsed() < max_age {
                return Ok(inv.clone());
            }
        }
    }
    let inv = enumerate_ffmpeg_devices().await?;
    if let Ok(mut guard) = ENUM_CACHE.lock() {
        *guard = Some((std::time::Instant::now(), inv.clone()));
    }
    Ok(inv)
}

/// How fresh the cached enumeration must be for the RECORDER START to reuse it
/// (R4). The record modal warms the cache on open (via `list_devices`), so the
/// press that follows seconds later reuses that result instead of paying another
/// `ffmpeg -list_devices` (50–500 ms). The window is deliberately short: a device
/// plugged/unplugged within these few seconds is the only staleness risk, and the
/// recorder's fuzzy device-match + the start-path timeout already tolerate a miss.
/// Beyond the window the start falls back to a fresh enumeration (the old
/// always-uncached behaviour).
pub const RECORD_START_ENUM_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(4);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_devices_args_match_platform_shape() {
        let args = list_devices_args();
        assert!(args.contains(&"-list_devices"));
        assert!(args.contains(&"true"));
        assert!(args.contains(&"-hide_banner"));
        if cfg!(target_os = "windows") {
            assert!(args.windows(2).any(|w| w == ["-f", "dshow"]));
            assert!(args.windows(2).any(|w| w == ["-i", "dummy"]));
        } else {
            assert!(args.windows(2).any(|w| w == ["-f", "avfoundation"]));
            // empty input string on macOS avfoundation
            assert!(args.windows(2).any(|w| w == ["-i", ""]));
        }
    }

    #[test]
    fn parse_inventory_splits_audio_and_video_on_current_platform() {
        // A synthetic stderr that carries BOTH an avfoundation and a dshow shape;
        // each platform's parser only picks up its own format, so this asserts the
        // dispatch wires the right core parsers without needing real ffmpeg.
        let stderr = if cfg!(target_os = "windows") {
            "\
[dshow @ 1] DirectShow video devices
[dshow @ 1]  \"Logitech BRIO\"
[dshow @ 1] DirectShow audio devices
[dshow @ 1]  \"Microphone (USB Audio CODEC)\""
        } else {
            "\
[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro-mikrofon"
        };
        let inv = parse_inventory(stderr);
        assert_eq!(inv.audio_inputs.len(), 1);
        assert_eq!(inv.video_inputs.len(), 1);
        if cfg!(target_os = "windows") {
            assert_eq!(inv.audio_inputs[0].name, "Microphone (USB Audio CODEC)");
            assert_eq!(inv.video_inputs[0].name, "Logitech BRIO");
        } else {
            assert_eq!(inv.audio_inputs[0].name, "MacBook Pro-mikrofon");
            assert_eq!(inv.audio_inputs[0].index, Some(0));
            assert_eq!(inv.video_inputs[0].name, "FaceTime HD Camera");
        }
    }

    #[test]
    fn device_inventory_serde_roundtrip() {
        let inv = DeviceInventory {
            audio_inputs: vec![FfmpegDevice::new("Mic", "avfoundation", Some(1))],
            video_inputs: vec![FfmpegDevice::new("Cam", "avfoundation", Some(0))],
        };
        let json = serde_json::to_string(&inv).unwrap();
        let back: DeviceInventory = serde_json::from_str(&json).unwrap();
        assert_eq!(inv, back);
    }
}
