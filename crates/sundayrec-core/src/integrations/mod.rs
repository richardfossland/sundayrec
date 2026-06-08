//! Sunday-suite integrations — pure, GUI-free, fs/network-free (PU-6 + Bridge #2).
//!
//! Ported from the Electron `src/main/integrations/*` (the behavioural spec).
//! Opt-in connections to the sister apps (Stage, Plan, Song). Every shape here
//! is a *decision* or a *mapper*; the actual fs sidecars, HTTP submissions, and
//! Supabase Realtime subscription are I/O the `src-tauri` shell owns (some behind
//! the default-off `bridge` feature).
//!
//! Submodules:
//!   - [`stage`] — SundayStage manifest → chapter markers + setlist (the
//!     parse/align/collapse logic), and the `ServiceLink` builder
//!   - [`live_bridge`] — Integration #2: the live cue channel. The pure mapping
//!     of an inbound `LiveEvent` (cue.advanced / now_playing / service.live /
//!     service.ended) to recording metadata (chapter markers) + state, plus the
//!     channel-name helper.
//!
//! ## Contract mirror
//!
//! These types mirror the platform `sunday-contracts` shapes (the `ServiceLink`/
//! `SongUsage`/`ChapterMarker` records and the `LiveEvent` union published by
//! SundayStage's `liveEmitter.ts`). We cannot depend on `@sunday/*` /
//! `sunday-contracts` (unpublished), so the shapes are mirrored locally and kept
//! in this one module so a later swap to the published crate is a single edit.
//! Each mirrored type is tagged `// mirrors sunday-contracts; converge once published`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub mod live_bridge;
pub mod plan;
pub mod settings;
pub mod song;
pub mod stage;
pub mod sundayedit;

/// The service-link sidecar path for a recording: the file beside it with the
/// extension swapped for `.service.json` (e.g. `/rec/2026-05-31.mp3` →
/// `/rec/2026-05-31.service.json`). Mirrors the Electron `serviceLinkPath`. Pure
/// string work — the actual read/write is the shell's. Returns the input
/// unchanged when it has no extension to swap (defensive; recordings always do).
pub fn service_link_path(recording_path: &str) -> String {
    swap_extension(recording_path, ".service.json")
}

/// The transcript sidecar path (`<name>.transcript.json`) for a recording, used
/// by the SundayEdit caption import. Mirrors the Electron `importSundayEditCaptions`
/// path build (`base + '.transcript.json'`).
pub fn transcript_sidecar_path(recording_path: &str) -> String {
    swap_extension(recording_path, ".transcript.json")
}

/// Replace a path's final extension with `suffix` (which includes the leading
/// dot), keeping the directory. A path with no `.` in its basename just gets the
/// suffix appended.
fn swap_extension(path: &str, suffix: &str) -> String {
    // Split off the directory so a `.` in a parent dir isn't mistaken for the ext.
    let slash = path.rfind(['/', '\\']);
    let (dir, base) = match slash {
        Some(i) => (&path[..=i], &path[i + 1..]),
        None => ("", path),
    };
    let stem = match base.rfind('.') {
        Some(i) => &base[..i],
        None => base,
    };
    format!("{dir}{stem}{suffix}")
}

/// A song used in a service, with the cross-suite identifiers we may know.
/// Mirrors the renderer `SongUsage` (camelCase) and the platform contract.
// mirrors sunday-contracts; converge once published
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/SongUsage.ts")]
#[serde(rename_all = "camelCase")]
pub struct SongUsage {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tono_work_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ccli_song_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sundaysong_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_shown_sec: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub displayed_sec: Option<i64>,
}

/// The source of a [`ServiceLink`]. Mirrors the renderer `ServiceLink['source']`.
// mirrors sunday-contracts; converge once published
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/ServiceLinkSource.ts")]
#[serde(rename_all = "lowercase")]
pub enum ServiceLinkSource {
    Stage,
    Plan,
    Manual,
}

/// Links one recording to its external service context. Persisted as a
/// `<recording>.service.json` sidecar by the shell. Mirrors the renderer
/// `ServiceLink` (camelCase).
// mirrors sunday-contracts; converge once published
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/ServiceLink.ts")]
#[serde(rename_all = "camelCase")]
pub struct ServiceLink {
    pub source: ServiceLinkSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub church_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub was_streamed: Option<bool>,
    pub setlist: Vec<SongUsage>,
    #[ts(type = "number")]
    pub linked_at: i64,
}

/// A chapter marker on a recording. Mirrors the renderer `ChapterMarker`:
/// `time` in seconds from the start of the main content.
// mirrors sunday-contracts; converge once published
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/ChapterMarker.ts")]
pub struct ChapterMarker {
    #[ts(type = "number")]
    pub time: i64,
    pub title: String,
}

#[cfg(test)]
mod sidecar_path_tests {
    use super::*;

    #[test]
    fn service_link_path_swaps_extension_and_keeps_dir() {
        assert_eq!(
            service_link_path("/rec/2026-05-31.mp3"),
            "/rec/2026-05-31.service.json"
        );
        // Windows-style separator + multi-dot dir.
        assert_eq!(
            service_link_path("C:\\My.Recordings\\svc.mkv"),
            "C:\\My.Recordings\\svc.service.json"
        );
    }

    #[test]
    fn transcript_sidecar_path_swaps_to_transcript_json() {
        assert_eq!(
            transcript_sidecar_path("/rec/sermon.wav"),
            "/rec/sermon.transcript.json"
        );
    }

    #[test]
    fn no_extension_just_appends() {
        assert_eq!(service_link_path("/rec/noext"), "/rec/noext.service.json");
    }
}
