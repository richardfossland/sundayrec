//! The preflight "ready-to-record" check — pure decision logic.
//!
//! Ported from the Electron main process `src/main/preflight.ts` (the
//! behavioural specification). That code interleaved I/O (statfs, mkdir-probe,
//! `getMediaAccessStatus`, device resolution) with the *decisions* about which
//! findings to raise. Here we keep ONLY the decisions: every function takes the
//! already-gathered facts (free bytes, writable?, video active?, …) and returns
//! the [`PreflightFinding`]s. The `src-tauri` `preflight` module does the actual
//! filesystem/device I/O and feeds the results in, so this stays deterministic
//! and fully unit-tested without a disk, a device, or a process.
//!
//! The serde tags mirror the Electron string unions EXACTLY (`severity`
//! `"warn"`/`"error"`, `category` `"cloud" | "preroll" | "wake" | "disk" |
//! "device"`) so the same renderer logic / log shapes carry across the
//! migration.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// How serious a finding is. Serialised lowercase to match the Electron
/// `'warn' | 'error'` union (`preflight.ts:21`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/PreflightSeverity.ts")]
#[serde(rename_all = "lowercase")]
pub enum PreflightSeverity {
    /// The recording can still proceed, but something is off.
    Warn,
    /// Recording will (likely) fail — needs the user's attention.
    Error,
}

/// Which part of the pipeline a finding is about. Serialised lowercase to match
/// the Electron `'cloud' | 'preroll' | 'wake' | 'disk' | 'device'` union
/// (`preflight.ts:21`). `Cloud`/`Preroll`/`Wake` are reserved for their later
/// phases (cloud upload, pre-roll buffer, wake-from-sleep) and are not raised by
/// the F2.2 plumbing yet — they exist so the type already matches Electron.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/PreflightCategory.ts")]
#[serde(rename_all = "lowercase")]
pub enum PreflightCategory {
    /// Cloud connectivity for auto-upload (Fase 7).
    Cloud,
    /// Pre-roll buffer readiness (Fase 5).
    Preroll,
    /// Wake-from-sleep for scheduled jobs (Fase 5).
    Wake,
    /// Disk: writable save folder + free space.
    Disk,
    /// Capture device / ffmpeg binary.
    Device,
}

/// A single thing the preflight check found. Mirrors the Electron
/// `PreflightFinding` interface field-for-field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/PreflightFinding.ts")]
#[serde(rename_all = "camelCase")]
pub struct PreflightFinding {
    pub severity: PreflightSeverity,
    pub category: PreflightCategory,
    pub message: String,
}

impl PreflightFinding {
    fn error(category: PreflightCategory, message: impl Into<String>) -> Self {
        Self {
            severity: PreflightSeverity::Error,
            category,
            message: message.into(),
        }
    }
}

/// 500 MB — comfortable headroom for a ~1.5 h MP3. Matches Electron
/// `MIN_DISK_AUDIO_BYTES` (`preflight.ts:26`).
pub const MIN_DISK_AUDIO_BYTES: u64 = 500 * 1024 * 1024;
/// 4 GB — comfortable headroom for a ~1.5 h video. Matches Electron
/// `MIN_DISK_VIDEO_BYTES` (`preflight.ts:27`).
pub const MIN_DISK_VIDEO_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The disk headroom for the given capture mode — the same threshold the
/// pre-flight check uses, reused by the during-recording guard.
pub fn min_disk_headroom_bytes(video_active: bool) -> u64 {
    if video_active {
        MIN_DISK_VIDEO_BYTES
    } else {
        MIN_DISK_AUDIO_BYTES
    }
}

/// DURING-recording guard: should the recorder stop NOW because free space has
/// fallen below `headroom_bytes`? Stopping gracefully here finalises a playable
/// file BEFORE ffmpeg hits `ENOSPC` and leaves a corrupt container. Pure so the
/// threshold logic is unit-tested; the engine owns the periodic `fs4` probe.
pub fn low_disk_should_stop(free_bytes: u64, headroom_bytes: u64) -> bool {
    free_bytes < headroom_bytes
}

/// Bytes-per-GB the Electron message used for its `.toFixed(1)` GB string
/// (`1_073_741_824` = 1024³, see `preflight.ts:55`).
const BYTES_PER_GB: f64 = 1_073_741_824.0;

/// Decide whether the free disk space warrants a finding.
///
/// Direct port of the Electron disk-space branch (`preflight.ts:52-61`): the
/// threshold is 4 GB when video is active, else 500 MB; below it we raise an
/// `error`/`disk` finding whose message includes the free space as GB with one
/// decimal (the `.toFixed(1)` formatting). At or above the threshold there is no
/// finding.
pub fn disk_space_finding(free_bytes: u64, video_active: bool) -> Option<PreflightFinding> {
    let min = if video_active {
        MIN_DISK_VIDEO_BYTES
    } else {
        MIN_DISK_AUDIO_BYTES
    };
    if free_bytes < min {
        let gb = format_gb(free_bytes);
        Some(PreflightFinding::error(
            PreflightCategory::Disk,
            format!("Bare {gb} GB ledig på lagringsdisken — kanskje ikke nok for et helt opptak."),
        ))
    } else {
        None
    }
}

/// Format a byte count as GB with one decimal place, matching JS
/// `(bytes / 1_073_741_824).toFixed(1)`.
fn format_gb(bytes: u64) -> String {
    format!("{:.1}", bytes as f64 / BYTES_PER_GB)
}

/// Whether a recording will actually capture video, mirroring the Electron
/// `videoActive` predicate (`preflight.ts:52`): video is enabled AND a camera is
/// selected (by name OR by index).
pub fn video_active(settings: &crate::settings::Settings) -> bool {
    settings.video_enabled
        && (settings.video_device_name.is_some() || settings.video_device_index.is_some())
}

/// The already-gathered facts the `src-tauri` I/O layer hands to
/// [`assemble_findings`]. Keeping this a plain value struct means the whole
/// decision is testable without touching a disk or a device.
#[derive(Debug, Clone, Copy)]
pub struct PreflightFacts {
    /// The bundled ffmpeg binary could not be resolved/run.
    pub ffmpeg_missing: bool,
    /// The save folder exists and a probe file could be written + removed.
    pub folder_writable: bool,
    /// Free bytes on the save-folder volume, when the platform could report it.
    /// `None` skips the space check (Electron's `statfs`-unsupported branch).
    pub free_bytes: Option<u64>,
    /// Whether the recording will capture video (raises the GB threshold).
    pub video_active: bool,
    /// macOS microphone permission was explicitly denied/restricted. `false` on
    /// platforms / builds where we cannot query it (best-effort — see the
    /// `src-tauri` `preflight` module note about the deferred permission probe).
    pub mic_denied: bool,
    /// macOS camera permission denied/restricted (only relevant when
    /// [`Self::video_active`]).
    pub cam_denied: bool,
}

/// Assemble the preflight findings from the gathered facts, in the SAME order
/// the Electron `runPreflight` produced them (`preflight.ts:33-95`):
///   1. ffmpeg binary missing            → error/device
///   2. save folder not writable         → error/disk
///   3. low free space                   → error/disk  (via [`disk_space_finding`])
///   4. mic permission denied (macOS)    → error/device
///   5. cam permission denied (macOS)    → error/device  (only when video active)
///
/// The cloud-connectivity and device-name-mismatch findings the Electron build
/// also raised need live I/O (an HTTP probe / a device resolve) that belongs to
/// later phases; they are deliberately NOT synthesised here so the function
/// stays a pure decision over the facts we actually have in F2.2.
pub fn assemble_findings(facts: PreflightFacts) -> Vec<PreflightFinding> {
    let mut findings = Vec::new();

    if facts.ffmpeg_missing {
        findings.push(PreflightFinding::error(
            PreflightCategory::Device,
            "ffmpeg-binær mangler. SundayRec må installeres på nytt.",
        ));
    }

    if !facts.folder_writable {
        findings.push(PreflightFinding::error(
            PreflightCategory::Disk,
            "Lagringsmappen kan ikke skrives.",
        ));
    }

    if let Some(free) = facts.free_bytes {
        if let Some(finding) = disk_space_finding(free, facts.video_active) {
            findings.push(finding);
        }
    }

    if facts.mic_denied {
        findings.push(PreflightFinding::error(
            PreflightCategory::Device,
            "Mikrofontilgang er ikke gitt. Åpne Systeminnstillinger → Personvern → Mikrofon.",
        ));
    }

    if facts.video_active && facts.cam_denied {
        findings.push(PreflightFinding::error(
            PreflightCategory::Device,
            "Kameratilgang er ikke gitt.",
        ));
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    fn all_clear() -> PreflightFacts {
        PreflightFacts {
            ffmpeg_missing: false,
            folder_writable: true,
            free_bytes: Some(MIN_DISK_VIDEO_BYTES * 2),
            video_active: false,
            mic_denied: false,
            cam_denied: false,
        }
    }

    // ── during-recording low-disk guard ─────────────────────────────────────

    #[test]
    fn low_disk_should_stop_below_headroom() {
        let audio = min_disk_headroom_bytes(false);
        assert_eq!(audio, MIN_DISK_AUDIO_BYTES);
        assert!(low_disk_should_stop(audio - 1, audio), "just under → stop");
        assert!(
            !low_disk_should_stop(audio, audio),
            "exactly at → keep going"
        );
        assert!(
            !low_disk_should_stop(audio * 10, audio),
            "plenty → keep going"
        );
        // Video raises the bar to 4 GB.
        assert_eq!(min_disk_headroom_bytes(true), MIN_DISK_VIDEO_BYTES);
        assert!(low_disk_should_stop(
            MIN_DISK_AUDIO_BYTES,
            min_disk_headroom_bytes(true)
        ));
    }

    // ── disk_space_finding ───────────────────────────────────────────────────

    #[test]
    fn disk_audio_under_threshold_warns() {
        let f = disk_space_finding(MIN_DISK_AUDIO_BYTES - 1, false).expect("finding");
        assert_eq!(f.severity, PreflightSeverity::Error);
        assert_eq!(f.category, PreflightCategory::Disk);
        assert!(f.message.contains("ledig"));
    }

    #[test]
    fn disk_audio_at_or_over_threshold_is_clear() {
        assert!(disk_space_finding(MIN_DISK_AUDIO_BYTES, false).is_none());
        assert!(disk_space_finding(MIN_DISK_AUDIO_BYTES + 1, false).is_none());
    }

    #[test]
    fn disk_video_under_threshold_warns() {
        // 1 GB free is plenty for audio but under the 4 GB video bar.
        let one_gb = 1024 * 1024 * 1024;
        assert!(disk_space_finding(one_gb, false).is_none());
        let f = disk_space_finding(one_gb, true).expect("video threshold is higher");
        assert_eq!(f.category, PreflightCategory::Disk);
    }

    #[test]
    fn disk_video_at_or_over_threshold_is_clear() {
        assert!(disk_space_finding(MIN_DISK_VIDEO_BYTES, true).is_none());
        assert!(disk_space_finding(MIN_DISK_VIDEO_BYTES + 1, true).is_none());
    }

    #[test]
    fn disk_message_formats_gb_with_one_decimal() {
        // 1.5 GiB exactly → "1.5 GB" (matches JS toFixed(1) on 1024³ base).
        let one_and_half = (1.5 * BYTES_PER_GB) as u64;
        let f = disk_space_finding(one_and_half, true).expect("finding");
        assert!(
            f.message.contains("1.5 GB"),
            "expected 1.5 GB in: {}",
            f.message
        );
    }

    #[test]
    fn format_gb_rounds_like_tofixed() {
        // 250 MB → 0.2 GB; 0 bytes → 0.0 GB.
        assert_eq!(format_gb(250 * 1024 * 1024), "0.2");
        assert_eq!(format_gb(0), "0.0");
    }

    // ── video_active ─────────────────────────────────────────────────────────

    #[test]
    fn video_active_all_combinations() {
        // disabled → never active, even with a device selected.
        let s = Settings {
            video_enabled: false,
            video_device_name: Some("Cam".into()),
            video_device_index: Some(0),
            ..Default::default()
        };
        assert!(!video_active(&s));

        // enabled but no device → not active.
        let s = Settings {
            video_enabled: true,
            video_device_name: None,
            video_device_index: None,
            ..Default::default()
        };
        assert!(!video_active(&s));

        // enabled + name only → active.
        let s = Settings {
            video_enabled: true,
            video_device_name: Some("Cam".into()),
            video_device_index: None,
            ..Default::default()
        };
        assert!(video_active(&s));

        // enabled + index only → active.
        let s = Settings {
            video_enabled: true,
            video_device_name: None,
            video_device_index: Some(2),
            ..Default::default()
        };
        assert!(video_active(&s));

        // enabled + both → active.
        let s = Settings {
            video_enabled: true,
            video_device_name: Some("Cam".into()),
            video_device_index: Some(2),
            ..Default::default()
        };
        assert!(video_active(&s));
    }

    // ── assemble_findings ────────────────────────────────────────────────────

    #[test]
    fn assemble_all_clear_is_empty() {
        assert!(assemble_findings(all_clear()).is_empty());
    }

    #[test]
    fn assemble_orders_findings_like_electron() {
        // Trip every branch at once; assert the exact order ffmpeg → folder →
        // disk → mic → cam.
        let facts = PreflightFacts {
            ffmpeg_missing: true,
            folder_writable: false,
            free_bytes: Some(0),
            video_active: true,
            mic_denied: true,
            cam_denied: true,
        };
        let findings = assemble_findings(facts);
        assert_eq!(findings.len(), 5);
        assert_eq!(findings[0].category, PreflightCategory::Device); // ffmpeg
        assert!(findings[0].message.contains("ffmpeg"));
        assert_eq!(findings[1].category, PreflightCategory::Disk); // folder
        assert!(findings[1].message.contains("skrives"));
        assert_eq!(findings[2].category, PreflightCategory::Disk); // free space
        assert!(findings[2].message.contains("ledig"));
        assert_eq!(findings[3].category, PreflightCategory::Device); // mic
        assert!(findings[3].message.contains("Mikrofon"));
        assert_eq!(findings[4].category, PreflightCategory::Device); // cam
        assert!(findings[4].message.contains("Kamera"));
    }

    #[test]
    fn assemble_skips_disk_check_when_free_bytes_unknown() {
        // None free_bytes mirrors Electron's statfs-unsupported branch: no
        // disk-space finding, but the other checks still run.
        let facts = PreflightFacts {
            free_bytes: None,
            ffmpeg_missing: true,
            ..all_clear()
        };
        let findings = assemble_findings(facts);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].message.contains("ffmpeg"));
    }

    #[test]
    fn assemble_cam_finding_only_when_video_active() {
        // cam_denied but video NOT active → no camera finding.
        let facts = PreflightFacts {
            cam_denied: true,
            video_active: false,
            ..all_clear()
        };
        assert!(assemble_findings(facts).is_empty());

        // cam_denied AND video active → camera finding.
        let facts = PreflightFacts {
            cam_denied: true,
            video_active: true,
            // bump free space over the video bar so disk doesn't also fire.
            free_bytes: Some(MIN_DISK_VIDEO_BYTES + 1),
            ..all_clear()
        };
        let findings = assemble_findings(facts);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].message.contains("Kamera"));
    }

    #[test]
    fn assemble_writable_folder_with_low_space_raises_only_space() {
        let facts = PreflightFacts {
            folder_writable: true,
            free_bytes: Some(MIN_DISK_AUDIO_BYTES - 1),
            ..all_clear()
        };
        let findings = assemble_findings(facts);
        assert_eq!(findings.len(), 1);
        assert!(findings[0].message.contains("ledig"));
    }

    #[test]
    fn severity_and_category_serialise_to_electron_strings() {
        assert_eq!(
            serde_json::to_string(&PreflightSeverity::Warn).unwrap(),
            "\"warn\""
        );
        assert_eq!(
            serde_json::to_string(&PreflightSeverity::Error).unwrap(),
            "\"error\""
        );
        assert_eq!(
            serde_json::to_string(&PreflightCategory::Disk).unwrap(),
            "\"disk\""
        );
        assert_eq!(
            serde_json::to_string(&PreflightCategory::Device).unwrap(),
            "\"device\""
        );
        assert_eq!(
            serde_json::to_string(&PreflightCategory::Cloud).unwrap(),
            "\"cloud\""
        );
        // Finding keys are camelCase, matching the Electron interface.
        let f = PreflightFinding::error(PreflightCategory::Disk, "x");
        let v = serde_json::to_value(&f).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("severity"));
        assert!(obj.contains_key("category"));
        assert!(obj.contains_key("message"));
    }
}
