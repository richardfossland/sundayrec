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

    // ── Extended facts (the comprehensive diagnose) ──────────────────────────
    /// Free bytes on the save-folder volume, or `None` if it couldn't be read.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub free_disk_bytes: Option<u64>,
    /// Whether the save folder is writable, or `None` if not probed.
    #[serde(default)]
    pub save_folder_writable: Option<bool>,
    /// Microphone permission: `"authorized"`/`"denied"`/`"not_determined"`/`None`.
    #[serde(default)]
    pub mic_permission: Option<String>,
    /// Camera permission, same vocabulary. `None` when not probed / video off.
    #[serde(default)]
    pub camera_permission: Option<String>,
    /// Which audio engine the recorder LAST used (`"wasapi"`/`"asio"`/
    /// `"directshow"`/`"coreaudio"`), or `None` if it hasn't recorded yet.
    #[serde(default)]
    pub audio_engine: Option<String>,
    /// If the modern engine fell back, WHY (human text). `None` = no fallback.
    #[serde(default)]
    pub audio_engine_fallback: Option<String>,
    /// ASIO devices seen (Windows + `asio` feature). Empty otherwise.
    #[serde(default)]
    pub asio_devices: Vec<String>,
    /// The most recent classified recording error written to `last-error.json`.
    #[serde(default)]
    pub last_error: Option<LastErrorInfo>,
    /// Whether the Windows orphan-guard Job Object is active this session.
    #[serde(default)]
    pub orphan_guard_active: Option<bool>,
}

/// The most recent recording error, read back from `last-error.json` (written by
/// the recorder on a classified failure). Lets the diagnose tool explain what
/// stopped the previous recording even though it can't see in-process events.
#[derive(Debug, Clone, Default, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../../src/lib/bindings/LastErrorInfo.ts")]
#[serde(rename_all = "camelCase")]
pub struct LastErrorInfo {
    pub code: String,
    pub message: String,
    pub timestamp: String,
}

/// Severity of a [`DiagnosticFinding`], driving the UI badge + the support triage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/DiagnosticSeverity.ts")]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    /// Healthy — informational confirmation.
    Ok,
    /// Worth knowing, not blocking (e.g. fell back to a working backend).
    Info,
    /// Likely to cause trouble (low disk, video on but no camera).
    Warning,
    /// Will block / has blocked recording (no device, ffmpeg missing, denied).
    Critical,
}

/// A single diagnose result with a STABLE support code. The `code` (e.g.
/// `"SR-AUDIO-01"`) never changes meaning across versions, so a user can read it
/// out and support knows exactly which situation it is — the "fishing" the user
/// asked for. `detail` carries the specifics (device name, free GB, …) and `hint`
/// the concrete next step.
#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[ts(export, export_to = "../../../src/lib/bindings/DiagnosticFinding.ts")]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticFinding {
    pub code: String,
    pub severity: DiagnosticSeverity,
    pub title: String,
    pub detail: String,
    pub hint: String,
}

impl DiagnosticFinding {
    fn new(
        code: &str,
        severity: DiagnosticSeverity,
        title: &str,
        detail: impl Into<String>,
        hint: &str,
    ) -> Self {
        Self {
            code: code.to_string(),
            severity,
            title: title.to_string(),
            detail: detail.into(),
            hint: hint.to_string(),
        }
    }
}

/// Disk headroom (bytes) below which recording is at risk — mirrors the recorder
/// guard's video threshold (4 GB) as the conservative warning line for diagnose.
const DISK_WARN_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Turn the gathered facts into stable-coded findings — the heart of the
/// "feilkode-system". Pure + fully unit-tested; the I/O layer only feeds facts in.
///
/// Codes are grouped by area: `SR-FFMPEG-*`, `SR-AUDIO-*`, `SR-VIDEO-*`,
/// `SR-DISK-*`, `SR-PERM-*`, `SR-ENGINE-*`. Order: criticals first.
pub fn detect_issues(input: &DiagnosticsInput) -> Vec<DiagnosticFinding> {
    use DiagnosticSeverity::*;
    let mut out: Vec<DiagnosticFinding> = Vec::new();

    // ffmpeg binary.
    if input.ffmpeg_version.is_none() {
        out.push(DiagnosticFinding::new(
            "SR-FFMPEG-01",
            Critical,
            "Opptaksmotor (ffmpeg) mangler",
            "ffmpeg-binæren ble ikke funnet eller svarte ikke.",
            "Reinstaller SundayRec — opptaksmotoren følger med appen.",
        ));
    }

    // Audio devices.
    if input.audio_devices.is_empty() && input.asio_devices.is_empty() {
        out.push(DiagnosticFinding::new(
            "SR-AUDIO-01",
            Critical,
            "Ingen lydenhet funnet",
            "Verken Windows-lyd, ASIO eller ffmpeg fant en mikrofon/lydkort.",
            "Sjekk at lydkortet er tilkoblet og driveren installert. På delt PC: er Windows Audio-tjenesten oppe?",
        ));
    } else if let Some(sel) = input.settings.device_name.as_deref() {
        // A device is selected but is nowhere in the enumerated lists.
        let known = input
            .audio_devices
            .iter()
            .chain(input.asio_devices.iter())
            .any(|d| d.eq_ignore_ascii_case(sel) || d.contains(sel) || sel.contains(d.as_str()));
        if !known && !sel.is_empty() {
            out.push(DiagnosticFinding::new(
                "SR-AUDIO-02",
                Warning,
                "Valgt lydenhet ble ikke funnet",
                format!("Innstillingen peker på «{sel}», men den er ikke blant enhetene nå."),
                "Koble til enheten, eller velg en annen under Innstillinger → Lyd.",
            ));
        }
    }

    // Audio-engine fallback (ASIO/WASAPI → DirectShow) — informational.
    if let Some(reason) = input.audio_engine_fallback.as_deref() {
        out.push(DiagnosticFinding::new(
            "SR-AUDIO-10",
            Info,
            "Falt tilbake til DirectShow",
            format!("Moderne lyd-motor (WASAPI/ASIO) startet ikke: {reason}"),
            "Opptak fungerer fortsatt. Vil du tvinge moderne motor, sjekk driver/ASIO og at enheten ikke er opptatt.",
        ));
    }

    // Video enabled but no camera.
    if input.settings.video_enabled && input.video_devices.is_empty() {
        out.push(DiagnosticFinding::new(
            "SR-VIDEO-01",
            Warning,
            "Video er på, men ingen kamera funnet",
            "Videoopptak er aktivert, men ingen kameraenhet ble enumerert.",
            "Koble til kameraet, eller slå av video under Innstillinger.",
        ));
    }

    // Disk.
    if let Some(free) = input.free_disk_bytes {
        if free < DISK_WARN_BYTES {
            out.push(DiagnosticFinding::new(
                "SR-DISK-01",
                Warning,
                "Lite ledig diskplass",
                format!("{} ledig på lagringsstedet.", fmt_bytes(free)),
                "Frigjør plass eller velg en annen lagringsmappe før et langt opptak.",
            ));
        }
    }
    if input.save_folder_writable == Some(false) {
        out.push(DiagnosticFinding::new(
            "SR-DISK-02",
            Critical,
            "Kan ikke skrive til lagringsmappen",
            "Lagringsmappen er ikke skrivbar.",
            "Velg en mappe du har skrivetilgang til under Innstillinger → Lagring.",
        ));
    }

    // Permissions.
    if input.mic_permission.as_deref() == Some("denied") {
        out.push(DiagnosticFinding::new(
            "SR-PERM-01",
            Critical,
            "Mikrofontilgang er nektet",
            "Operativsystemet blokkerer mikrofontilgang for SundayRec.",
            "Gi tilgang i Systeminnstillinger → Personvern → Mikrofon, og start appen på nytt.",
        ));
    }
    if input.settings.video_enabled && input.camera_permission.as_deref() == Some("denied") {
        out.push(DiagnosticFinding::new(
            "SR-PERM-02",
            Critical,
            "Kameratilgang er nektet",
            "Operativsystemet blokkerer kameratilgang for SundayRec.",
            "Gi tilgang i Systeminnstillinger → Personvern → Kamera, og start appen på nytt.",
        ));
    }

    // Last recording error.
    if let Some(err) = &input.last_error {
        out.push(DiagnosticFinding::new(
            "SR-ENGINE-01",
            Warning,
            "Forrige opptak endte med en feil",
            format!("[{}] {} ({})", err.code, err.message, err.timestamp),
            "Se feilkoden over. Kjør en test-opptak for å bekrefte at det fungerer nå.",
        ));
    }

    // All clear.
    if out.is_empty() {
        out.push(DiagnosticFinding::new(
            "SR-OK",
            Ok,
            "Ingen problemer oppdaget",
            "Alle sjekker passerte.",
            "Du er klar til å ta opp.",
        ));
    }
    out
}

/// Human-friendly byte size (MB/GB) for findings + the report.
fn fmt_bytes(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else {
        format!("{:.0} MB", b / MB)
    }
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

    // ── Funn (feilkoder) — the actionable summary FIRST ───────────────────────
    let findings = detect_issues(&input);
    lines.push("## Funn".to_string());
    for f in &findings {
        let badge = match f.severity {
            DiagnosticSeverity::Ok => "✅",
            DiagnosticSeverity::Info => "ℹ️",
            DiagnosticSeverity::Warning => "⚠️",
            DiagnosticSeverity::Critical => "🔴",
        };
        lines.push(format!("- {badge} **{}** — {}", f.code, f.title));
        if !f.detail.is_empty() {
            lines.push(format!("  - {}", f.detail));
        }
        if !f.hint.is_empty() {
            lines.push(format!("  - 👉 {}", f.hint));
        }
    }
    lines.push(String::new());

    // ── System ──────────────────────────────────────────────────────────────
    lines.push("## System".to_string());
    lines.push(format!("- **App-versjon:** {}", input.app_version));
    lines.push(format!(
        "- **Plattform:** {} ({})",
        input.platform, input.arch
    ));
    if let Some(active) = input.orphan_guard_active {
        lines.push(format!(
            "- **Orphan-guard (Job Object):** {}",
            if active { "aktiv" } else { "ikke aktiv" }
        ));
    }
    lines.push(String::new());

    // ── Lyd-motor ─────────────────────────────────────────────────────────────
    if input.audio_engine.is_some() || input.audio_engine_fallback.is_some() {
        lines.push("## Lyd-motor".to_string());
        lines.push(format!(
            "- **Sist brukt:** {}",
            input.audio_engine.as_deref().unwrap_or("ukjent")
        ));
        if let Some(reason) = &input.audio_engine_fallback {
            lines.push(format!("- **Fallback:** {reason}"));
        }
        lines.push(String::new());
    }

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
    if !input.asio_devices.is_empty() {
        lines.push(format!("### ASIO-enheter ({})", input.asio_devices.len()));
        for d in &input.asio_devices {
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

    // ── Lagring ───────────────────────────────────────────────────────────────
    lines.push("## Lagring".to_string());
    match input.free_disk_bytes {
        Some(free) => lines.push(format!("- **Ledig plass:** {}", fmt_bytes(free))),
        None => lines.push("- **Ledig plass:** ukjent".to_string()),
    }
    if let Some(w) = input.save_folder_writable {
        lines.push(format!(
            "- **Skrivbar mappe:** {}",
            if w { "ja" } else { "NEI" }
        ));
    }
    lines.push(String::new());

    // ── Tilganger ─────────────────────────────────────────────────────────────
    if input.mic_permission.is_some() || input.camera_permission.is_some() {
        lines.push("## Tilganger".to_string());
        if let Some(m) = &input.mic_permission {
            lines.push(format!("- **Mikrofon:** {m}"));
        }
        if let Some(c) = &input.camera_permission {
            lines.push(format!("- **Kamera:** {c}"));
        }
        lines.push(String::new());
    }

    // ── Siste feil ────────────────────────────────────────────────────────────
    if let Some(err) = &input.last_error {
        lines.push("## Siste opptaksfeil".to_string());
        lines.push(format!("- **Kode:** `{}`", err.code));
        lines.push(format!("- **Melding:** {}", err.message));
        lines.push(format!("- **Tidspunkt:** {}", err.timestamp));
        lines.push(String::new());
    }

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
            ..Default::default()
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
    fn healthy_input_yields_single_ok_finding() {
        let f = detect_issues(&sample_input());
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].code, "SR-OK");
        assert_eq!(f[0].severity, DiagnosticSeverity::Ok);
    }

    #[test]
    fn missing_ffmpeg_and_no_devices_are_critical_findings() {
        let mut input = sample_input();
        input.ffmpeg_version = None;
        input.audio_devices.clear();
        let f = detect_issues(&input);
        assert!(f
            .iter()
            .any(|x| x.code == "SR-FFMPEG-01" && x.severity == DiagnosticSeverity::Critical));
        assert!(f
            .iter()
            .any(|x| x.code == "SR-AUDIO-01" && x.severity == DiagnosticSeverity::Critical));
        assert!(!f.iter().any(|x| x.code == "SR-OK"));
    }

    #[test]
    fn selected_device_missing_warns() {
        let mut input = sample_input();
        input.settings.device_name = Some("Soundcraft MADI USB".to_string());
        // audio_devices only has the MacBook mic → selected one is absent.
        let f = detect_issues(&input);
        assert!(f.iter().any(|x| x.code == "SR-AUDIO-02"));
    }

    #[test]
    fn audio_engine_fallback_is_info() {
        let mut input = sample_input();
        input.audio_engine_fallback = Some("driveren var opptatt".to_string());
        let f = detect_issues(&input);
        let e = f
            .iter()
            .find(|x| x.code == "SR-AUDIO-10")
            .expect("fallback finding");
        assert_eq!(e.severity, DiagnosticSeverity::Info);
        assert!(e.detail.contains("driveren var opptatt"));
    }

    #[test]
    fn low_disk_warns_and_unwritable_is_critical() {
        let mut input = sample_input();
        input.free_disk_bytes = Some(1024 * 1024 * 1024); // 1 GB < 4 GB
        input.save_folder_writable = Some(false);
        let f = detect_issues(&input);
        assert!(f
            .iter()
            .any(|x| x.code == "SR-DISK-01" && x.severity == DiagnosticSeverity::Warning));
        assert!(f
            .iter()
            .any(|x| x.code == "SR-DISK-02" && x.severity == DiagnosticSeverity::Critical));
    }

    #[test]
    fn denied_mic_permission_is_critical() {
        let mut input = sample_input();
        input.mic_permission = Some("denied".to_string());
        let f = detect_issues(&input);
        assert!(f
            .iter()
            .any(|x| x.code == "SR-PERM-01" && x.severity == DiagnosticSeverity::Critical));
    }

    #[test]
    fn last_error_surfaces_as_finding_and_report_section() {
        let mut input = sample_input();
        input.last_error = Some(LastErrorInfo {
            code: "device_disconnected".into(),
            message: "USB pulled".into(),
            timestamp: "2026-06-07T12:00:00+02:00".into(),
        });
        assert!(detect_issues(&input)
            .iter()
            .any(|x| x.code == "SR-ENGINE-01"));
        let md = build_report_markdown(input);
        assert!(md.contains("Siste opptaksfeil"));
        assert!(md.contains("device_disconnected"));
    }

    #[test]
    fn report_findings_section_lists_codes() {
        let mut input = sample_input();
        input.ffmpeg_version = None;
        let md = build_report_markdown(input);
        assert!(md.contains("## Funn"));
        assert!(md.contains("SR-FFMPEG-01"));
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
