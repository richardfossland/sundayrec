//! Wake-from-sleep decision core (Fase 5.2) — pure, OS-free.
//!
//! Ported from the Electron `src/main/wake.ts` and `src/main/wake-verification.ts`.
//! Those files interleaved the *decisions* (which wake points to schedule, how to
//! format a `pmset`/`schtasks` time, classifying an error string, parsing the OS
//! power tools' text output, matching expected wakes against observed ones,
//! deciding platform capabilities) with the actual I/O (`execFile` of
//! `pmset`/`osascript`/`powershell`/`powercfg`, `powerSaveBlocker`,
//! `powerMonitor`). Here we keep ONLY the deterministic decisions; the
//! `src-tauri` `wake` shell owns the process spawning and the power blocker.
//!
//! Platform reality this module encodes (the canonical truth, from the Electron
//! header):
//!   - macOS Apple Silicon: `pmset` *wake* works, *poweron* does not; deep-sleep
//!     (standby) can sabotage wake.
//!   - macOS Intel: wake works, poweron needs a manual System-Settings toggle.
//!   - Windows: Task Scheduler `WakeToRun` works from S3/S4; S5 needs a BIOS
//!     toggle we can't reach. Laptops often disable wake timers on battery.
//!   - Linux/other: no supported wake mechanism.

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Timelike};
use regex::Regex;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Wake the machine this many minutes before a scheduled recording, so it's
/// fully up and the recorder/preflight have run. (`wake.ts` `LEAD_MINUTES`.)
pub const WAKE_LEAD_MINUTES: i64 = 10;

/// ±slack when matching an expected wake against an OS-observed one: `pmset`
/// rounds to the minute, `powercfg` can lag a few seconds.
/// (`wake-verification.ts` `WAKE_MATCH_TOLERANCE_MS`.)
pub const WAKE_MATCH_TOLERANCE_MS: i64 = 60_000;

/// Keep the app un-suspended when a recording is within this window, so the
/// supervisor's timers actually fire. (`wake.ts` `updateBlocker` `soonMs`.)
pub const BLOCKER_SOON_MS: i64 = 30 * 60_000;

// ─────────────────────────────────────────────────────────────────────────────
//   Platform + capabilities
// ─────────────────────────────────────────────────────────────────────────────

/// The host class for wake purposes. Serialised to the EXACT Electron
/// `WakePlatform` strings (`'mac-arm' | 'mac-intel' | 'win' | 'linux' | 'other'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/WakePlatform.ts")]
#[serde(rename_all = "kebab-case")]
pub enum WakePlatform {
    MacArm,
    MacIntel,
    Win,
    Linux,
    Other,
}

/// Honest, OS-grounded statement of what wake can and can't do on this host.
/// Mirrors the Electron `WakeCapabilities`. The `knownIssues`/`recommendations`
/// are user-facing Norwegian, ported verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/WakeCapabilities.ts")]
#[serde(rename_all = "camelCase")]
pub struct WakeCapabilities {
    pub platform: WakePlatform,
    /// Wake from S3 sleep — usually true on supported platforms.
    pub can_wake_from_sleep: bool,
    /// Wake from S5 (off) — false on Apple Silicon, BIOS-dependent on Windows.
    pub can_wake_from_off: bool,
    /// Scheduling wakes typically needs an admin/UAC prompt.
    pub needs_admin: bool,
    pub known_issues: Vec<String>,
    pub recommendations: Vec<String>,
}

/// Build the capability statement for `platform`. Pure port of
/// `wake-verification.ts` `detectCapabilities` (the platform/arch branch is the
/// shell's job — it passes the resolved [`WakePlatform`] in).
pub fn detect_capabilities(platform: WakePlatform) -> WakeCapabilities {
    match platform {
        WakePlatform::MacArm => WakeCapabilities {
            platform,
            can_wake_from_sleep: true,
            can_wake_from_off: false,
            needs_admin: true,
            known_issues: vec![
                "Apple Silicon kan ikke starte fra fullstendig avslått tilstand — kun fra dvale."
                    .to_string(),
            ],
            recommendations: vec![
                "La maskinen stå i dvale (ikke slå den av) etter forberedelsene.".to_string(),
                "Slå av dyp dvale (standby) med «Fiks automatisk»-knappen nedenfor.".to_string(),
                "Tilkoblet strøm må være på — Mac vekker ikke pålitelig på batteri.".to_string(),
            ],
        },
        WakePlatform::MacIntel => WakeCapabilities {
            platform,
            can_wake_from_sleep: true,
            can_wake_from_off: true,
            needs_admin: true,
            known_issues: vec![
                "Intel Mac kan starte fra avslått, men du må aktivere «Start opp eller vekk» manuelt i Systemvalg → Batteri."
                    .to_string(),
            ],
            recommendations: vec![
                "Tilkoblet strøm må være på — Mac vekker ikke pålitelig på batteri.".to_string(),
            ],
        },
        WakePlatform::Win => WakeCapabilities {
            platform,
            can_wake_from_sleep: true,
            can_wake_from_off: false,
            needs_admin: false,
            known_issues: vec![
                "Wake fra fullstendig avslått (S5) krever at «Wake on RTC from S5» er aktivert i BIOS — kan ikke aktiveres fra programvare."
                    .to_string(),
            ],
            recommendations: vec![
                "Sett maskinen i dvale (Sleep/Hibernate), ikke skru den av.".to_string(),
                "Tilkoblet strøm bør være på — mange bærbare deaktiverer vekketimere på batteri."
                    .to_string(),
                "Hvis test-wake feiler, sjekk BIOS for «Wake on RTC» og slå på «Tillat vekketimere» i strømalternativer."
                    .to_string(),
            ],
        },
        WakePlatform::Linux => WakeCapabilities {
            platform,
            can_wake_from_sleep: false,
            can_wake_from_off: false,
            needs_admin: false,
            known_issues: vec![
                "Linux støttes ikke for automatisk oppvåkning fra SundayRec.".to_string(),
            ],
            recommendations: vec![
                "Bruk Mac eller Windows for å aktivere automatisk wake.".to_string(),
            ],
        },
        WakePlatform::Other => WakeCapabilities {
            platform,
            can_wake_from_sleep: false,
            can_wake_from_off: false,
            needs_admin: false,
            known_issues: vec!["Plattformen støttes ikke for automatisk oppvåkning.".to_string()],
            recommendations: vec![],
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Wake-point selection + scheduler-command builders
// ─────────────────────────────────────────────────────────────────────────────

/// Subtract the lead and drop any point already in the past → the wake times to
/// register with the OS. Pure port of the `scheduleOsWakes` mapping in `wake.ts`.
pub fn wake_points(
    upcoming: &[NaiveDateTime],
    now: NaiveDateTime,
    lead_minutes: i64,
) -> Vec<NaiveDateTime> {
    upcoming
        .iter()
        .map(|d| *d - Duration::minutes(lead_minutes))
        .filter(|d| *d > now)
        .collect()
}

/// True if any upcoming recording is within [`BLOCKER_SOON_MS`] — the app should
/// hold an app-suspension blocker so its in-process timers fire. Port of the
/// `hasSoon` decision in `wake.ts` `updateBlocker`.
pub fn should_block(upcoming: &[NaiveDateTime], now: NaiveDateTime) -> bool {
    upcoming.iter().any(|d| {
        let delta = (*d - now).num_milliseconds();
        delta > 0 && delta < BLOCKER_SOON_MS
    })
}

/// Stable dedup key for a set of wake points — if the next scheduling request
/// matches the last, the shell skips the work. Port of `wake.ts` `keyOf`.
pub fn key_of(dates: &[NaiveDateTime]) -> String {
    dates
        .iter()
        .map(|d| d.and_utc().timestamp_millis().to_string())
        .collect::<Vec<_>>()
        .join("|")
}

/// `pmset schedule wake` time format: `MM/DD/YY HH:MM:00`. Port of `formatPmsetDate`.
pub fn format_pmset_date(d: NaiveDateTime) -> String {
    format!(
        "{:02}/{:02}/{:02} {:02}:{:02}:00",
        d.month(),
        d.day(),
        d.year() % 100,
        d.hour(),
        d.minute(),
    )
}

/// Windows `New-ScheduledTaskTrigger -At` format: `YYYY-MM-DDTHH:MM:00`. Port of
/// `formatWinDateTime`.
pub fn format_win_datetime(d: NaiveDateTime) -> String {
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:00",
        d.year(),
        d.month(),
        d.day(),
        d.hour(),
        d.minute(),
    )
}

/// Build the PowerShell that registers one `SundayRec-Wake-N` scheduled task per
/// wake point (each `-WakeToRun`, 1-minute limit, runs `cmd /c exit`). Direct
/// port of `wake.ts` `buildWinTaskDefs`. `elevated` adds `-RunLevel Highest`.
pub fn build_win_task_defs(wake_points: &[NaiveDateTime], elevated: bool) -> String {
    wake_points
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let dt = format_win_datetime(*d);
            let run_level = if elevated { "-RunLevel Highest " } else { "" };
            [
                format!("$t{i} = New-ScheduledTaskTrigger -Once -At '{dt}'"),
                format!("$s{i} = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1)"),
                format!("$a{i} = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'"),
                format!(
                    "Register-ScheduledTask -TaskName 'SundayRec-Wake-{}' -TaskPath '\\SundayRec' -Action $a{i} -Trigger $t{i} -Settings $s{i} {run_level}-Force | Out-Null",
                    i + 1
                ),
            ]
            .join("; ")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Why an OS wake-scheduling attempt failed — the `reason` the UI localises.
/// Serialises to the EXACT Electron `WakeResult.reason` union
/// (`'disabled' | 'cancelled' | 'permission' | 'unsupported' | 'error'`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeErrorReason {
    /// The user has turned wake-from-sleep off.
    Disabled,
    /// The admin/UAC prompt was dismissed.
    Cancelled,
    /// Scheduling needs elevation we don't have.
    Permission,
    /// This platform has no supported wake mechanism.
    Unsupported,
    /// Any other failure.
    Error,
}

impl WakeErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            WakeErrorReason::Disabled => "disabled",
            WakeErrorReason::Cancelled => "cancelled",
            WakeErrorReason::Permission => "permission",
            WakeErrorReason::Unsupported => "unsupported",
            WakeErrorReason::Error => "error",
        }
    }
}

/// How a Windows scheduling failure should be classified. Port of `classifyWinError`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WinErrorKind {
    /// Access-denied / unauthorized / privilege — retry without elevation, or surface a permission error.
    Permission,
    /// Anything else.
    Error,
}

/// Classify a Windows scheduling stderr string. Based on `wake.ts`
/// `classifyWinError`, with one deliberate improvement: the Electron pattern
/// `access.?denied` only matches `accessdenied` / `access denied`, NOT the
/// canonical Windows wording "**Access is denied.**" — so the original would
/// mis-classify the most common permission failure as a generic error and skip
/// the un-elevated retry. We accept `access is denied` too.
pub fn classify_win_error(msg: &str) -> WinErrorKind {
    let re = Regex::new(r"(?i)access\s*(is\s+)?denied|unauthorized|privilege").unwrap();
    if re.is_match(msg) {
        WinErrorKind::Permission
    } else {
        WinErrorKind::Error
    }
}

/// The delta classification a test-wake applies once it observes a resume.
/// `> 30 s` late ⇒ the wake fired too late to be useful. Port of the threshold
/// in `wake.ts` `testWake`'s resume handler. (The resume *listening* is OS-level
/// and lives in the shell / a later slice; this is the pure verdict.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TestWakeVerdict {
    Ok,
    TooLate,
}

/// `delta_sec` = observed − scheduled, in seconds (negative = woke early).
pub fn classify_test_wake_delta(delta_sec: i64) -> TestWakeVerdict {
    if delta_sec > 30 {
        TestWakeVerdict::TooLate
    } else {
        TestWakeVerdict::Ok
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//   Observed-wake parsing + tolerance match
// ─────────────────────────────────────────────────────────────────────────────

/// A wake the OS reports it has actually scheduled (from `pmset -g sched` /
/// `powercfg -waketimers`). Internal — the shell maps it to ISO strings for the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedWake {
    pub scheduled_at: NaiveDateTime,
    pub owner_label: String,
}

/// Parse `pmset -g sched`, capturing only absolute one-off wakes in the
/// "Scheduled power events" section (repeating events are skipped — we don't
/// schedule them). `ref_year` guards against year typos. Port of `parsePmsetSched`.
pub fn parse_pmset_sched(stdout: &str, ref_year: Option<i32>) -> Vec<VerifiedWake> {
    let row = Regex::new(
        r#"(?i)\bwake\s+at\s+(\d{1,2})/(\d{1,2})/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+by\s+['"]?([^'"]+?)['"]?\s*$"#,
    )
    .unwrap();
    let sched_hdr = Regex::new(r"(?i)^Scheduled power events:?").unwrap();
    let repeat_hdr = Regex::new(r"(?i)^Repeating power events:?").unwrap();

    let mut out = Vec::new();
    let mut in_one_off = false;
    for raw in stdout.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if sched_hdr.is_match(line) {
            in_one_off = true;
            continue;
        }
        if repeat_hdr.is_match(line) {
            in_one_off = false;
            continue;
        }
        if !in_one_off {
            continue;
        }
        if let Some(c) = row.captures(line) {
            let month: u32 = c[1].parse().unwrap_or(0);
            let day: u32 = c[2].parse().unwrap_or(0);
            let mut year: i32 = c[3].parse().unwrap_or(0);
            if year < 100 {
                year += 2000;
            }
            let hour: u32 = c[4].parse().unwrap_or(99);
            let min: u32 = c[5].parse().unwrap_or(99);
            let sec: u32 = c.get(6).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            if let Some(r) = ref_year {
                if (year - r).abs() > 5 {
                    continue;
                }
            }
            if let Some(dt) = NaiveDate::from_ymd_opt(year, month, day)
                .and_then(|d| d.and_hms_opt(hour, min, sec))
            {
                out.push(VerifiedWake {
                    scheduled_at: dt,
                    owner_label: c[7].trim().to_string(),
                });
            }
        }
    }
    out
}

/// Parse `powercfg -waketimers`, extracting each timer's expiry + owning task.
/// Port of `parsePowercfgWaketimers`.
pub fn parse_powercfg_waketimers(stdout: &str) -> Vec<VerifiedWake> {
    let block_split = Regex::new(r"\r?\n\s*\r?\n").unwrap();
    let expires = Regex::new(
        r"(?i)expires\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s+on\s+(\d{1,2})/(\d{1,2})/(\d{2,4})",
    )
    .unwrap();
    let task = Regex::new(r#"(?i)['"]([^'"]*SundayRec[^'"]*)['"]"#).unwrap();
    let reason = Regex::new(r"(?i)Reason:\s*(.+)").unwrap();

    let mut out = Vec::new();
    for block in block_split.split(stdout) {
        let Some(c) = expires.captures(block) else {
            continue;
        };
        let mut hour: u32 = c[1].parse().unwrap_or(99);
        let min: u32 = c[2].parse().unwrap_or(99);
        let sec: u32 = c.get(3).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
        match c.get(4).map(|m| m.as_str().to_uppercase()).as_deref() {
            Some("PM") if hour < 12 => hour += 12,
            Some("AM") if hour == 12 => hour = 0,
            _ => {}
        }
        let month: u32 = c[5].parse().unwrap_or(0);
        let day: u32 = c[6].parse().unwrap_or(0);
        let mut year: i32 = c[7].parse().unwrap_or(0);
        if year < 100 {
            year += 2000;
        }
        let Some(dt) =
            NaiveDate::from_ymd_opt(year, month, day).and_then(|d| d.and_hms_opt(hour, min, sec))
        else {
            continue;
        };

        // Owner: task name from the path, else the Reason line, else 'unknown'.
        let owner = if let Some(t) = task.captures(block) {
            let path = &t[1];
            path.split('\\')
                .next_back()
                .filter(|s| !s.is_empty())
                .unwrap_or(path)
                .to_string()
        } else if let Some(r) = reason.captures(block) {
            r[1].trim().chars().take(80).collect()
        } else {
            "unknown".to_string()
        };
        out.push(VerifiedWake {
            scheduled_at: dt,
            owner_label: owner,
        });
    }
    out
}

/// Compare expected wakes to observed ones within `tolerance_ms`. Returns
/// `(has_mismatch, missing)`. Port of `compareExpectedToObserved`.
pub fn compare_expected_to_observed(
    expected: &[NaiveDateTime],
    observed: &[VerifiedWake],
    tolerance_ms: i64,
) -> (bool, Vec<NaiveDateTime>) {
    let mut missing = Vec::new();
    for exp in expected {
        let found = observed
            .iter()
            .any(|o| (o.scheduled_at - *exp).num_milliseconds().abs() <= tolerance_ms);
        if !found {
            missing.push(*exp);
        }
    }
    (!missing.is_empty(), missing)
}

// ─────────────────────────────────────────────────────────────────────────────
//   Sleep-config + power-source parsing
// ─────────────────────────────────────────────────────────────────────────────

/// The sleep/power configuration the UI surfaces (with "fix" buttons). Mirrors
/// the Electron `SleepConfig`; every probe is optional so a partial read still
/// renders. `wakeTimersEnabled` is Windows-only; the mac fields are macOS-only.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/SleepConfig.ts")]
#[serde(rename_all = "camelCase")]
pub struct SleepConfig {
    // mac
    pub autopoweroff: Option<bool>,
    pub autopoweroff_delay: Option<i32>,
    pub standby: Option<bool>,
    pub standby_delay: Option<i32>,
    pub hibernate_mode: Option<i32>,
    // windows
    pub wake_timers_enabled: Option<bool>,
    // common
    pub error: Option<String>,
}

/// Read an integer `\b{key}\s+(\d+)` from `pmset -g` output.
fn pmset_int(stdout: &str, key: &str) -> Option<i32> {
    let re = Regex::new(&format!(r"\b{}\s+(\d+)", regex::escape(key))).unwrap();
    re.captures(stdout).and_then(|c| c[1].parse().ok())
}

/// Parse `pmset -g` into the macOS half of [`SleepConfig`]. Port of the darwin
/// branch of `getSleepConfig`.
pub fn parse_mac_sleep_config(stdout: &str) -> SleepConfig {
    SleepConfig {
        autopoweroff: pmset_int(stdout, "autopoweroff").map(|v| v == 1),
        autopoweroff_delay: Some(pmset_int(stdout, "autopoweroffdelay").unwrap_or(0)),
        standby: pmset_int(stdout, "standby").map(|v| v == 1),
        standby_delay: Some(pmset_int(stdout, "standbydelay").unwrap_or(0)),
        hibernate_mode: Some(pmset_int(stdout, "hibernatemode").unwrap_or(3)),
        wake_timers_enabled: None,
        error: None,
    }
}

/// Parse the "Allow wake timers" index from a `powercfg /query …` block →
/// `Some(true)` if enabled, `Some(false)` if disabled, `None` if not found.
/// Port of the win32 branch of `getSleepConfig`.
pub fn parse_win_wake_timers(stdout: &str) -> Option<bool> {
    let re = Regex::new(r"(?i)Current AC Power Setting Index:\s+(0x[0-9a-f]+)").unwrap();
    let c = re.captures(stdout)?;
    let val = i64::from_str_radix(c[1].trim_start_matches("0x"), 16).ok()?;
    Some(val > 0)
}

/// True if on battery, false if AC / no battery (desktop), `None` if unknown.
/// Port of `parsePmsetBatt`.
pub fn parse_pmset_batt(stdout: &str) -> Option<bool> {
    let ac = Regex::new(r"(?i)AC\s*Power").unwrap();
    let batt = Regex::new(r"(?i)Battery\s*Power").unwrap();
    if ac.is_match(stdout) {
        return Some(false);
    }
    if batt.is_match(stdout) {
        return Some(true);
    }
    let has_battery = Regex::new(r"(?i)InternalBattery").unwrap().is_match(stdout)
        || Regex::new(r"(?i)Battery").unwrap().is_match(stdout);
    if !has_battery {
        return Some(false); // desktop → on AC
    }
    None
}

/// Parse `wmic path Win32_Battery get BatteryStatus` → on-battery? Port of
/// `parseWmicBatteryStatus`. 1 = discharging (on battery); 2+ = AC.
pub fn parse_wmic_battery_status(stdout: &str) -> Option<bool> {
    let num = Regex::new(r"(?i)BatteryStatus\s*=\s*(\d+)").unwrap();
    if let Some(c) = num.captures(stdout) {
        return c[1].parse::<i32>().ok().map(|s| s == 1);
    }
    if Regex::new(r"(?i)BatteryStatus\s*=")
        .unwrap()
        .is_match(stdout)
    {
        return None; // mentioned but non-numeric → malformed
    }
    Some(false) // no battery row → desktop → on AC
}

/// True if macOS standby (deep sleep) is enabled — it can sabotage wake on Apple
/// Silicon. `None` if the line is absent. Port of `parsePmsetStandby`.
pub fn parse_pmset_standby(stdout: &str) -> Option<bool> {
    let re = Regex::new(r"\bstandby\s+(\d+)\b").unwrap();
    re.captures(stdout).map(|c| &c[1] == "1")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap()
    }
    fn dtm(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    #[test]
    fn capabilities_per_platform() {
        let arm = detect_capabilities(WakePlatform::MacArm);
        assert!(arm.can_wake_from_sleep && !arm.can_wake_from_off && arm.needs_admin);
        let intel = detect_capabilities(WakePlatform::MacIntel);
        assert!(intel.can_wake_from_off);
        let win = detect_capabilities(WakePlatform::Win);
        assert!(win.can_wake_from_sleep && !win.can_wake_from_off && !win.needs_admin);
        let lin = detect_capabilities(WakePlatform::Linux);
        assert!(!lin.can_wake_from_sleep);
        assert!(!detect_capabilities(WakePlatform::Other).can_wake_from_sleep);
    }

    #[test]
    fn wake_platform_serialises_to_electron_strings() {
        assert_eq!(
            serde_json::to_string(&WakePlatform::MacArm).unwrap(),
            "\"mac-arm\""
        );
        assert_eq!(
            serde_json::to_string(&WakePlatform::MacIntel).unwrap(),
            "\"mac-intel\""
        );
        assert_eq!(
            serde_json::to_string(&WakePlatform::Win).unwrap(),
            "\"win\""
        );
    }

    #[test]
    fn wake_points_subtracts_lead_and_drops_past() {
        let now = dtm("2026-06-07 09:00");
        let up = vec![
            dtm("2026-06-07 09:05"), // 09:05 − 10min = 08:55 < now → dropped
            dtm("2026-06-07 11:00"), // → 10:50 future → kept
            dtm("2026-06-14 11:00"), // → next week 10:50 → kept
        ];
        let wp = wake_points(&up, now, WAKE_LEAD_MINUTES);
        assert_eq!(wp, vec![dtm("2026-06-07 10:50"), dtm("2026-06-14 10:50")]);
    }

    #[test]
    fn should_block_within_30_min() {
        let now = dtm("2026-06-07 10:40");
        assert!(should_block(&[dtm("2026-06-07 11:00")], now)); // 20 min away
        assert!(!should_block(&[dtm("2026-06-07 11:30")], now)); // 50 min away
        assert!(!should_block(&[dtm("2026-06-07 10:00")], now)); // in the past
    }

    #[test]
    fn key_of_is_order_sensitive_join() {
        let a = key_of(&[dtm("2026-06-07 11:00"), dtm("2026-06-14 11:00")]);
        let b = key_of(&[dtm("2026-06-07 11:00")]);
        assert!(a.contains('|'));
        assert_ne!(a, b);
    }

    #[test]
    fn wake_points_empty_input_and_stable_dedup_key() {
        let now = dtm("2026-06-07 09:00");
        // No upcoming recordings → no wake points, and an empty, stable key (the
        // WakeEngine treats an unchanged empty schedule as a cheap no-op).
        assert!(wake_points(&[], now, WAKE_LEAD_MINUTES).is_empty());
        assert_eq!(key_of(&[]), "");

        // The same upcoming set yields the same points and therefore the same
        // dedup key on a repeated reschedule — the engine's no-op contract.
        let up = vec![dtm("2026-06-07 11:00"), dtm("2026-06-14 11:00")];
        let wp1 = wake_points(&up, now, WAKE_LEAD_MINUTES);
        let wp2 = wake_points(&up, now, WAKE_LEAD_MINUTES);
        assert_eq!(key_of(&wp1), key_of(&wp2));
        assert!(!wp1.is_empty());
    }

    #[test]
    fn wake_points_drops_a_point_landing_exactly_on_now() {
        // A point whose lead-adjusted time equals `now` is dropped (strict `>`),
        // so we never schedule a wake for a moment already upon us.
        let now = dtm("2026-06-07 10:50");
        let up = vec![dtm("2026-06-07 11:00")]; // − 10min lead = 10:50 == now
        assert!(wake_points(&up, now, WAKE_LEAD_MINUTES).is_empty());
    }

    #[test]
    fn pmset_and_win_date_formats() {
        let d = dt("2026-05-31 10:30:00");
        assert_eq!(format_pmset_date(d), "05/31/26 10:30:00");
        assert_eq!(format_win_datetime(d), "2026-05-31T10:30:00");
    }

    #[test]
    fn win_task_defs_contains_wake_to_run_and_indexed_names() {
        let defs = build_win_task_defs(&[dt("2026-05-31 10:30:00")], false);
        assert!(defs.contains("New-ScheduledTaskTrigger -Once -At '2026-05-31T10:30:00'"));
        assert!(defs.contains("-WakeToRun"));
        assert!(defs.contains("SundayRec-Wake-1"));
        assert!(!defs.contains("-RunLevel Highest"));
        let elevated = build_win_task_defs(&[dt("2026-05-31 10:30:00")], true);
        assert!(elevated.contains("-RunLevel Highest"));
    }

    #[test]
    fn classify_win_error_detects_permission() {
        assert_eq!(
            classify_win_error("Access is denied."),
            WinErrorKind::Permission
        );
        assert_eq!(
            classify_win_error("Unauthorized operation"),
            WinErrorKind::Permission
        );
        assert_eq!(
            classify_win_error("some other failure"),
            WinErrorKind::Error
        );
    }

    #[test]
    fn test_wake_delta_threshold() {
        assert_eq!(classify_test_wake_delta(10), TestWakeVerdict::Ok);
        assert_eq!(classify_test_wake_delta(30), TestWakeVerdict::Ok);
        assert_eq!(classify_test_wake_delta(31), TestWakeVerdict::TooLate);
        assert_eq!(classify_test_wake_delta(-5), TestWakeVerdict::Ok); // woke early
    }

    #[test]
    fn parse_pmset_sched_captures_one_off_wakes() {
        let out = "\
Repeating power events:
  wake at 11:30AM every weekday

Scheduled power events:
 [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'
 [1]  wake at 06/07/2026 10:30:00 by 'SundayRec'
";
        let wakes = parse_pmset_sched(out, Some(2026));
        assert_eq!(wakes.len(), 2);
        assert_eq!(wakes[0].scheduled_at, dt("2026-05-31 10:30:00"));
        assert_eq!(wakes[0].owner_label, "SundayRec");
        assert_eq!(wakes[1].scheduled_at, dt("2026-06-07 10:30:00"));
    }

    #[test]
    fn parse_pmset_sched_skips_repeating_and_bad_year() {
        // The repeating event must not be captured (it's outside the one-off section).
        let out = "Repeating power events:\n  wake at 11:30AM every weekday\n";
        assert!(parse_pmset_sched(out, Some(2026)).is_empty());
        // A wildly off year is rejected by the ref_year guard.
        let bad = "Scheduled power events:\n [0]  wake at 5/31/2099 10:30:00 by 'SundayRec'\n";
        assert!(parse_pmset_sched(bad, Some(2026)).is_empty());
    }

    #[test]
    fn parse_powercfg_waketimers_extracts_time_and_owner() {
        let out = "\
Timer set by [SYSTEM\\TaskScheduler] expires at 5:30:00 PM on 5/31/2026.
  Reason: Windows will execute 'NT TASK\\SundayRec\\SundayRec-Wake-1' scheduled task
";
        let wakes = parse_powercfg_waketimers(out);
        assert_eq!(wakes.len(), 1);
        assert_eq!(wakes[0].scheduled_at, dt("2026-05-31 17:30:00"));
        assert_eq!(wakes[0].owner_label, "SundayRec-Wake-1");
    }

    #[test]
    fn parse_powercfg_handles_am_and_no_timers() {
        let am = "Timer set by [X] expires at 12:05:00 AM on 1/2/2026.\n  Reason: 'SundayRec-Wake-2' task";
        let wakes = parse_powercfg_waketimers(am);
        assert_eq!(wakes[0].scheduled_at, dt("2026-01-02 00:05:00"));
        assert!(
            parse_powercfg_waketimers("There are no active wake timers in the system.").is_empty()
        );
    }

    #[test]
    fn compare_expected_to_observed_within_tolerance() {
        let expected = vec![dt("2026-05-31 10:30:00"), dt("2026-06-07 10:30:00")];
        let observed = vec![
            VerifiedWake {
                scheduled_at: dt("2026-05-31 10:30:30"), // 30 s off → within 60 s
                owner_label: "SundayRec".to_string(),
            },
            // second expected has no match
        ];
        let (mismatch, missing) =
            compare_expected_to_observed(&expected, &observed, WAKE_MATCH_TOLERANCE_MS);
        assert!(mismatch);
        assert_eq!(missing, vec![dt("2026-06-07 10:30:00")]);

        // Both present within tolerance → no mismatch.
        let observed2 = vec![
            VerifiedWake {
                scheduled_at: dt("2026-05-31 10:30:00"),
                owner_label: "x".into(),
            },
            VerifiedWake {
                scheduled_at: dt("2026-06-07 10:29:30"),
                owner_label: "x".into(),
            },
        ];
        let (m2, miss2) =
            compare_expected_to_observed(&expected, &observed2, WAKE_MATCH_TOLERANCE_MS);
        assert!(!m2);
        assert!(miss2.is_empty());
    }

    #[test]
    fn parse_mac_sleep_config_reads_pmset_g() {
        let out = "\
 autopoweroff         1
 autopoweroffdelay    28800
 standby              1
 standbydelay         86400
 hibernatemode        3
";
        let cfg = parse_mac_sleep_config(out);
        assert_eq!(cfg.autopoweroff, Some(true));
        assert_eq!(cfg.autopoweroff_delay, Some(28800));
        assert_eq!(cfg.standby, Some(true));
        assert_eq!(cfg.standby_delay, Some(86400));
        assert_eq!(cfg.hibernate_mode, Some(3));
        assert_eq!(cfg.wake_timers_enabled, None);
    }

    #[test]
    fn parse_win_wake_timers_reads_index() {
        let on = "Current AC Power Setting Index: 0x00000001";
        let off = "Current AC Power Setting Index: 0x00000000";
        assert_eq!(parse_win_wake_timers(on), Some(true));
        assert_eq!(parse_win_wake_timers(off), Some(false));
        assert_eq!(parse_win_wake_timers("no index here"), None);
    }

    #[test]
    fn parse_pmset_batt_distinguishes_sources() {
        // AC present → not on battery.
        assert_eq!(parse_pmset_batt("Now drawing from 'AC Power'"), Some(false));
        // "Battery Power" (no AC) → on battery.
        assert_eq!(
            parse_pmset_batt("Now drawing from 'Battery Power'"),
            Some(true)
        );
        // Desktop: no battery mentioned at all → on AC.
        assert_eq!(parse_pmset_batt("no power info"), Some(false));
    }

    #[test]
    fn parse_wmic_battery_status_values() {
        assert_eq!(parse_wmic_battery_status("BatteryStatus=1"), Some(true));
        assert_eq!(parse_wmic_battery_status("BatteryStatus=2"), Some(false));
        assert_eq!(parse_wmic_battery_status("BatteryStatus=abc"), None);
        assert_eq!(parse_wmic_battery_status("no battery row"), Some(false));
    }

    #[test]
    fn parse_pmset_standby_flag() {
        assert_eq!(parse_pmset_standby(" standby              1"), Some(true));
        assert_eq!(parse_pmset_standby(" standby              0"), Some(false));
        assert_eq!(parse_pmset_standby("no standby line"), None);
    }
}
