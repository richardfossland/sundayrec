//! Diagnostics I/O plumbing (F2.2) — gathers the facts, lets the core format.
//!
//! The markdown *layout* (sections, GB formatting, the "ikke testet" tri-state,
//! the secrets-cannot-leak settings summary) lives in
//! [`sundayrec_core::diagnostics`] and carries the tests. This module only does
//! the probing the core can't: the ffmpeg version banner, device enumeration,
//! and writing the finished report to a file under the app-data dir.
//!
//! ## Capture test — honestly deferred
//!
//! The Electron build ran a real 2-second audio (and video) capture and reported
//! `captureOk`/`videoOk`. That needs real hardware and is flaky on a headless
//! CI box, so F2.2 sets both to `None` ("ikke testet") and defers the live
//! capture test to **Fase 3** (the recorder hardware phase). The report renders
//! the tri-state correctly today; only the live probe is absent. This is an
//! honest gap, not a fake green.

use sqlx::SqlitePool;
use sundayrec_core::diagnostics::{build_report_markdown, DiagnosticsInput, SettingsSummary};
use tauri::{AppHandle, Manager};

use crate::audio::device_enum::enumerate_ffmpeg_devices;
use crate::audio::devices::list_input_devices;
use crate::error::AppResult;
use crate::media::ffmpeg::ffmpeg_version;
use crate::settings;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The result the renderer gets back: the report markdown, where it was saved
/// (if anywhere), and the tri-state capture results. Mirrors the non-secret
/// subset of the Electron `DiagnosticsReport`; `clipboardOk` is dropped because
/// the clipboard write is a UI-side concern (`navigator.clipboard`).
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/lib/bindings/DiagnosticsReport.ts")]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    /// The full markdown report (rendered by the panel + copied to clipboard).
    pub markdown: String,
    /// Absolute path the report was written to, or `None` if the save failed.
    pub saved_to: Option<String>,
    /// Audio capture test: `None` in F2.2 (deferred to Fase 3 — see module docs).
    pub capture_ok: Option<bool>,
    /// Video capture test: `None` in F2.2 (deferred to Fase 3).
    pub video_ok: Option<bool>,
}

/// Run diagnostics: gather facts, build the report via the core, and save it
/// under the app-data dir. Never fails on a save error — it returns the report
/// with `saved_to: None` rather than erroring, so the user always gets the text.
pub async fn run_diagnostics(app: &AppHandle, pool: &SqlitePool) -> AppResult<DiagnosticsReport> {
    let s = settings::load(pool).await.unwrap_or_default();

    // ffmpeg version banner (None when the binary doesn't resolve).
    let ffmpeg_version = ffmpeg_version().ok();

    // Audio device names: prefer the ffmpeg enumeration (what the recorder
    // addresses); fall back to the cpal input list when ffmpeg can't enumerate.
    let inventory = enumerate_ffmpeg_devices().await.ok();
    let (mut audio_devices, video_devices) = match inventory {
        Some(inv) => (
            inv.audio_inputs
                .into_iter()
                .map(|d| d.name)
                .collect::<Vec<_>>(),
            inv.video_inputs
                .into_iter()
                .map(|d| d.name)
                .collect::<Vec<_>>(),
        ),
        None => (Vec::new(), Vec::new()),
    };
    if audio_devices.is_empty() {
        if let Ok(list) = list_input_devices() {
            audio_devices = list.inputs.into_iter().map(|d| d.name).collect();
        }
    }

    let input = DiagnosticsInput {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        ffmpeg_version,
        audio_devices,
        video_devices,
        settings: SettingsSummary::from_settings(&s),
        // Capture test deferred to Fase 3 — see module docs.
        capture_ok: None,
        video_ok: None,
    };

    let markdown = build_report_markdown(input);
    let saved_to = save_report(app, &markdown);

    Ok(DiagnosticsReport {
        markdown,
        saved_to,
        capture_ok: None,
        video_ok: None,
    })
}

/// Write the report under the app-data dir as `SundayRec-diagnose.md`. Best
/// effort: any failure (no dir, no permission) returns `None` so diagnostics
/// still surfaces the text to the user.
fn save_report(app: &AppHandle, markdown: &str) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("SundayRec-diagnose.md");
    std::fs::write(&path, markdown).ok()?;
    Some(path.to_string_lossy().into_owned())
}
