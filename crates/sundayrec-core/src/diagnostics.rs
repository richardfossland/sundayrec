//! The diagnostics markdown report — pure builder.
//!
//! Ported from the Electron main process `src/main/diagnostics.ts` (the
//! behavioural specification). That code gathered facts via I/O (ffmpeg
//! `-version`, device enumeration, capture test) and then assembled a markdown
//! report. Here we keep ONLY the assembly: [`build_report_markdown`] takes the
//! already-gathered facts in [`DiagnosticsInput`] and returns the markdown
//! string, so the formatting is deterministic and fully unit-tested. The
//! `src-tauri` `diagnostics` module performs the actual probing and feeds the
//! results in.
//!
//! ## Secrets cannot leak — by construction
//!
//! The Electron `sanitizeSettings` (`diagnostics.ts:172`) hand-picked which
//! settings fields went into the report, deliberately omitting passwords,
//! e-mail addresses and stream keys ("Innstillinger (alle, unntatt
//! passord/e-post)"). We go one better: [`SettingsSummary`] simply has no field
//! for any secret. There is no code path that can place a password / e-mail /
//! stream key into the report because the input type cannot represent one.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A non-secret summary of the user's settings for the report. EVERY field here
/// is safe to print. Secrets (cloud tokens, e-mail/SMTP credentials, stream
/// keys) are intentionally absent — see the module docs: the report cannot leak
/// what the type cannot hold.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/SettingsSummary.ts")]
#[serde(rename_all = "camelCase")]
pub struct SettingsSummary {
    pub language: Option<String>,
    pub device_name: Option<String>,
    pub channels: String,
    pub sample_rate: i32,
    pub input_volume: i32,
    pub format: String,
    pub bitrate: String,
    pub filename_pattern: String,
    pub video_enabled: bool,
    pub video_device_name: Option<String>,
    pub stop_on_silence: bool,
    pub silence_threshold: i32,
    pub split_minutes: i32,
    pub trim_silence: bool,
    pub auto_delete_days: i32,
    pub save_folder: Option<String>,
}

impl SettingsSummary {
    /// Project the full [`Settings`](crate::settings::Settings) down to the
    /// non-secret subset. The F2.2 `Settings` model carries no secret fields yet
    /// (cloud/stream/e-mail land in later phases), but this projection is the
    /// single, explicit allow-list so adding those fields later cannot
    /// accidentally widen the report.
    pub fn from_settings(s: &crate::settings::Settings) -> Self {
        Self {
            language: s.language.clone(),
            device_name: s.device_name.clone(),
            channels: serde_plain_tag(&s.channels),
            sample_rate: s.sample_rate,
            input_volume: s.input_volume,
            format: serde_plain_tag(&s.format),
            bitrate: s.bitrate.clone(),
            filename_pattern: serde_plain_tag(&s.filename_pattern),
            video_enabled: s.video_enabled,
            video_device_name: s.video_device_name.clone(),
            stop_on_silence: s.stop_on_silence,
            silence_threshold: s.silence_threshold,
            split_minutes: s.split_minutes,
            trim_silence: s.trim_silence,
            auto_delete_days: s.auto_delete_days,
            save_folder: s.save_folder.clone(),
        }
    }
}

/// Serialise a small serde enum to its bare string tag (e.g. `"mp3"`,
/// `"stereo"`) for the human-readable settings dump. Falls back to `"?"` if the
/// value somehow isn't a JSON string (it always is for our `#[serde(rename_all)]`
/// unit enums).
fn serde_plain_tag<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|val| val.as_str().map(str::to_string))
        .unwrap_or_else(|| "?".to_string())
}

/// Everything the `src-tauri` layer gathered, ready to be formatted. No secrets
/// can appear here (see [`SettingsSummary`] / module docs).
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/DiagnosticsInput.ts")]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsInput {
    /// App semver (e.g. `"0.1.0"`).
    pub app_version: String,
    /// Target OS (`std::env::consts::OS` — `"macos"`, `"windows"`, …).
    pub platform: String,
    /// CPU architecture (`std::env::consts::ARCH`).
    pub arch: String,
    /// First line of `ffmpeg -version`, or `None` when ffmpeg did not resolve.
    pub ffmpeg_version: Option<String>,
    /// Audio capture device names ffmpeg / cpal enumerated.
    pub audio_devices: Vec<String>,
    /// Video capture device names ffmpeg enumerated.
    pub video_devices: Vec<String>,
    /// The non-secret settings summary.
    pub settings: SettingsSummary,
    /// Audio capture test result: `Some(true)`=ok, `Some(false)`=failed,
    /// `None`=not tested (the F2.2 default — the live test is Fase-3 hardware).
    pub capture_ok: Option<bool>,
    /// Video capture test result, same tri-state. `None` when not tested /
    /// video disabled.
    pub video_ok: Option<bool>,
}

/// Render a tri-state test result the way the report shows it.
fn render_test(ok: Option<bool>) -> &'static str {
    match ok {
        Some(true) => "✅ OK",
        Some(false) => "❌ Feil",
        None => "ikke testet",
    }
}

/// Build the diagnostics markdown report from the gathered facts. Pure and
/// deterministic — the same input always yields the same string. Sections:
/// System, ffmpeg, Enheter (devices), Innstillinger (settings), Capture-test.
pub fn build_report_markdown(input: DiagnosticsInput) -> String {
    let mut lines: Vec<String> = Vec::new();

    lines.push("# SundayRec Diagnostics".to_string());
    lines.push(String::new());

    // ── System ──────────────────────────────────────────────────────────────
    lines.push("## System".to_string());
    lines.push(format!("- **App-versjon:** {}", input.app_version));
    lines.push(format!(
        "- **Plattform:** {} ({})",
        input.platform, input.arch
    ));
    lines.push(String::new());

    // ── ffmpeg ──────────────────────────────────────────────────────────────
    lines.push("## ffmpeg".to_string());
    match &input.ffmpeg_version {
        Some(v) => lines.push(format!("- **Versjon:** {v}")),
        None => lines.push("- **Versjon:** ikke funnet".to_string()),
    }
    lines.push(String::new());

    // ── Enheter ─────────────────────────────────────────────────────────────
    lines.push("## Enheter".to_string());
    lines.push(format!("### Lydenheter ({})", input.audio_devices.len()));
    if input.audio_devices.is_empty() {
        lines.push("_Ingen funnet_".to_string());
    } else {
        for d in &input.audio_devices {
            lines.push(format!("- `{d}`"));
        }
    }
    lines.push(format!("### Videoenheter ({})", input.video_devices.len()));
    if input.video_devices.is_empty() {
        lines.push("_Ingen funnet_".to_string());
    } else {
        for d in &input.video_devices {
            lines.push(format!("- `{d}`"));
        }
    }
    lines.push(String::new());

    // ── Capture-test ────────────────────────────────────────────────────────
    lines.push("## Capture-test".to_string());
    lines.push(format!("- **Lyd:** {}", render_test(input.capture_ok)));
    lines.push(format!("- **Video:** {}", render_test(input.video_ok)));
    lines.push(String::new());

    // ── Innstillinger (non-secret) ──────────────────────────────────────────
    lines.push("## Innstillinger (unntatt passord/e-post)".to_string());
    lines.push("```json".to_string());
    // Pretty JSON of the summary — never contains secrets (type has no field).
    let json = serde_json::to_string_pretty(&input.settings).unwrap_or_else(|_| "{}".to_string());
    lines.push(json);
    lines.push("```".to_string());

    lines.push(String::new());
    lines.push("---".to_string());
    lines.push("_Generert av SundayRec Diagnostics_".to_string());

    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Settings;

    fn sample_input() -> DiagnosticsInput {
        DiagnosticsInput {
            app_version: "0.1.0".to_string(),
            platform: "macos".to_string(),
            arch: "aarch64".to_string(),
            ffmpeg_version: Some("ffmpeg version 6.0".to_string()),
            audio_devices: vec!["MacBook Pro-mikrofon".to_string()],
            video_devices: vec!["FaceTime HD Camera".to_string()],
            settings: SettingsSummary::from_settings(&Settings::default()),
            capture_ok: None,
            video_ok: None,
        }
    }

    #[test]
    fn report_includes_version_platform_and_ffmpeg_line() {
        let md = build_report_markdown(sample_input());
        assert!(md.contains("**App-versjon:** 0.1.0"));
        assert!(md.contains("macos (aarch64)"));
        assert!(md.contains("ffmpeg version 6.0"));
    }

    #[test]
    fn report_lists_device_names() {
        let md = build_report_markdown(sample_input());
        assert!(md.contains("MacBook Pro-mikrofon"));
        assert!(md.contains("FaceTime HD Camera"));
        assert!(md.contains("Lydenheter (1)"));
        assert!(md.contains("Videoenheter (1)"));
    }

    #[test]
    fn report_shows_no_devices_placeholder() {
        let mut input = sample_input();
        input.audio_devices.clear();
        input.video_devices.clear();
        let md = build_report_markdown(input);
        assert!(md.contains("Lydenheter (0)"));
        assert!(md.contains("_Ingen funnet_"));
    }

    #[test]
    fn missing_ffmpeg_renders_not_found() {
        let mut input = sample_input();
        input.ffmpeg_version = None;
        let md = build_report_markdown(input);
        assert!(md.contains("**Versjon:** ikke funnet"));
        assert!(!md.contains("ffmpeg version"));
    }

    #[test]
    fn capture_tristate_renders_correctly() {
        // None → "ikke testet"
        let md_none = build_report_markdown(sample_input());
        assert!(md_none.contains("**Lyd:** ikke testet"));
        assert!(md_none.contains("**Video:** ikke testet"));

        // Some(true) → OK, Some(false) → Feil
        let mut ok = sample_input();
        ok.capture_ok = Some(true);
        ok.video_ok = Some(false);
        let md = build_report_markdown(ok);
        assert!(md.contains("**Lyd:** ✅ OK"));
        assert!(md.contains("**Video:** ❌ Feil"));
    }

    #[test]
    fn summary_carries_no_secret_fields_even_if_settings_had_them() {
        // The summary type structurally cannot hold a secret. Prove the rendered
        // JSON has only the allow-listed keys and nothing password/email/token-ish.
        let summary = SettingsSummary::from_settings(&Settings {
            device_name: Some("Soundcraft USB".into()),
            ..Default::default()
        });
        let json = serde_json::to_string(&summary).unwrap();
        for forbidden in [
            "password",
            "passord",
            "email",
            "epost",
            "token",
            "streamKey",
            "secret",
        ] {
            assert!(
                !json.to_lowercase().contains(&forbidden.to_lowercase()),
                "summary JSON should not contain `{forbidden}`: {json}"
            );
        }
        // It does carry the safe fields.
        assert!(json.contains("Soundcraft USB"));
        assert!(json.contains("sampleRate"));
    }

    #[test]
    fn settings_summary_reflects_enum_tags() {
        let md = build_report_markdown(sample_input());
        // Defaults: mp3 / stereo / date pattern serialise as their Electron tags.
        assert!(md.contains("\"format\": \"mp3\""));
        assert!(md.contains("\"channels\": \"stereo\""));
        assert!(md.contains("\"filenamePattern\": \"date\""));
    }
}
