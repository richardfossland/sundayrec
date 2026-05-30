//! The typed, validated SundayRec settings model.
//!
//! Ported from the Electron build's `src/types/index.ts` `interface Settings`,
//! its defaults in `src/main/store.ts` (the `defaults` object, lines 6+), and
//! the `clampNum` validation it applied on profile import (lines 261+). The
//! Electron code is the behavioural specification; the values, ranges and
//! string enum-tags here mirror it EXACTLY so old/exported settings keep their
//! meaning across the migration.
//!
//! This module is pure: the [`Settings`] struct, its [`Default`] impl, the
//! [`Settings::validate`] clamping pass and [`Settings::from_json_merged`]
//! (partial-JSON-over-defaults parsing) are all deterministic and unit-tested
//! here. The `src-tauri` `settings` layer is the thin persistence/command shell
//! that serialises this to/from the SQLite `app_setting` bag.
//!
//! ## Scope (migration plan, Fase 1)
//!
//! This is the Fase-1 subset of the Electron `Settings`. Fields that belong to
//! later phases are deliberately NOT modelled yet and will be added in their
//! own phase so the model stays honest about what is actually wired:
//!   - `streamDestinations` (live streaming)               → Fase 7
//!   - `email*` / webhook / notify* (notifications)        → Fase 6
//!   - `editorIntroPath` / `editorOutroPath` (editor)      → Fase 4
//!   - `deviceChannels` (per-device channel maps)          → Fase 2/3
//!   - `video*`, cloud backup, church profile, integrations → their phases
//!
//! When those land, add the field here with its serde tag matching the Electron
//! key and extend [`Settings::validate`] / [`Default`] accordingly.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::schedule::{ScheduleSlot, SpecialRecording};

/// Input channel layout. Serialised to the EXACT Electron string union
/// (`'stereo' | 'monoL' | 'monoR' | 'monoMix'`, see `types/index.ts:1`), so the
/// tags are camelCase — NOT snake_case — to match stored/exported settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/ChannelMode.ts")]
#[serde(rename_all = "camelCase")]
pub enum ChannelMode {
    /// Both channels, stereo.
    Stereo,
    /// Mono from the left channel only.
    MonoL,
    /// Mono from the right channel only.
    MonoR,
    /// Mono mixed down from both channels.
    MonoMix,
}

/// Output audio container/codec. Serialised lowercase to match the Electron
/// union (`'mp3' | 'wav' | 'flac' | 'aac'`, see `types/index.ts:2`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/FileFormat.ts")]
#[serde(rename_all = "lowercase")]
pub enum FileFormat {
    Mp3,
    Wav,
    Flac,
    Aac,
}

/// How recording filenames are generated. Serialised lowercase to match the
/// Electron union (`'date' | 'church' | 'plain' | 'datetime'`,
/// see `types/index.ts:3`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/FilenamePattern.ts")]
#[serde(rename_all = "lowercase")]
pub enum FilenamePattern {
    /// Date only (the Electron default).
    Date,
    /// Liturgical/church name + date.
    Church,
    /// "Gudstjeneste" + date.
    Plain,
    /// Date + time.
    Datetime,
}

/// The complete (Fase-1 subset) settings model.
///
/// Every field carries `#[serde(default)]` so a partial or older JSON blob
/// deserialises by filling in the per-field [`Default`] — this is the Electron
/// `store.get(key, default)` semantics, see [`Settings::from_json_merged`].
/// Numeric ranges are enforced separately by [`Settings::validate`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/Settings.ts")]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    // ── System ──────────────────────────────────────────────────────────────
    /// UI language code (e.g. `"no"`, `"en"`), or `None` to follow the OS.
    #[serde(default = "default_language")]
    pub language: Option<String>,
    /// Has the app ever been launched? Gates first-run behaviour.
    #[serde(default)]
    pub has_launched: bool,
    /// Has the user completed onboarding?
    #[serde(default)]
    pub onboarding_done: bool,

    // ── Audio device ─────────────────────────────────────────────────────────
    /// Stored capture device id (browser `MediaDeviceInfo.deviceId` heritage).
    #[serde(default)]
    pub device_id: Option<String>,
    /// Stored capture device human-readable name (the device-match moat input).
    #[serde(default)]
    pub device_name: Option<String>,

    // ── Video device (F2.1 — "alt som mater opptak") ─────────────────────────
    /// Capture video (camera) alongside audio? Default false (audio-only is the
    /// common church-recording case).
    #[serde(default)]
    pub video_enabled: bool,
    /// Stored camera human-readable name — the device-match moat input for video
    /// (matched with [`crate::device_enum::find_best_video_device_match`]).
    #[serde(default)]
    pub video_device_name: Option<String>,
    /// Last-known avfoundation index for the chosen camera. A fallback for when
    /// the name lookup fails (e.g. after a reconnect); the name match wins when
    /// it succeeds. dshow cameras are addressed by name, so this stays `None`.
    #[serde(default)]
    pub video_device_index: Option<i32>,

    // ── Audio processing ───────────────────────────────────────────────────────
    /// Input channel layout.
    #[serde(default = "default_channels")]
    pub channels: ChannelMode,
    /// Sample rate in Hz. Valid 8000..=192000, default 48000.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: i32,
    /// Input gain as a percentage. Valid 0..=200, default 100.
    #[serde(default = "default_input_volume")]
    pub input_volume: i32,
    /// Bass EQ gain in dB. Valid -24..=24, default 0.
    #[serde(default)]
    pub eq_bass: i32,
    /// Mid EQ gain in dB. Valid -24..=24, default 0.
    #[serde(default)]
    pub eq_mid: i32,
    /// Treble EQ gain in dB. Valid -24..=24, default 0.
    #[serde(default)]
    pub eq_treble: i32,
    /// Is the compressor enabled?
    #[serde(default)]
    pub comp_enabled: bool,
    /// Compressor threshold in dBFS. Valid -60..=0, default -24.
    #[serde(default = "default_comp_threshold")]
    pub comp_threshold: f64,
    /// Compressor ratio. Valid 1..=100, default 4.
    #[serde(default = "default_comp_ratio")]
    pub comp_ratio: f64,
    /// Compressor attack in ms. Valid 0.1..=2000, default 10.
    #[serde(default = "default_comp_attack")]
    pub comp_attack: f64,
    /// Compressor release in ms. Valid 1..=9000, default 200.
    #[serde(default = "default_comp_release")]
    pub comp_release: f64,
    /// Is the limiter enabled? Default true.
    #[serde(default = "default_true")]
    pub limiter_enabled: bool,
    /// Limiter ceiling in dBFS. Valid -10..=0, default -1.
    #[serde(default = "default_limiter_ceiling")]
    pub limiter_ceiling: f64,

    // ── Output ─────────────────────────────────────────────────────────────────
    /// Output file format. Default mp3.
    #[serde(default = "default_format")]
    pub format: FileFormat,
    /// Bitrate (kbps) as a string, matching the Electron `'192'` heritage.
    #[serde(default = "default_bitrate")]
    pub bitrate: String,
    /// Filename generation pattern. Default `date`.
    #[serde(default = "default_filename_pattern")]
    pub filename_pattern: FilenamePattern,
    /// Folder recordings are written to, or `None` for the default location.
    #[serde(default)]
    pub save_folder: Option<String>,
    /// Auto-delete recordings older than N days. Valid 0..=3650, 0 = off.
    #[serde(default)]
    pub auto_delete_days: i32,

    // ── Recording behaviour ──────────────────────────────────────────────────
    /// Stop the recording after a sustained silent stretch?
    #[serde(default)]
    pub stop_on_silence: bool,
    /// Silence detection threshold in dBFS. Valid -90..=0, default -50.
    #[serde(default = "default_silence_threshold")]
    pub silence_threshold: i32,
    /// Minutes of silence before auto-stop. Valid 1..=120, default 5.
    #[serde(default = "default_silence_timeout_minutes")]
    pub silence_timeout_minutes: i32,
    /// Auto-split interval in minutes. Valid 0..=480, 0 = off.
    #[serde(default)]
    pub split_minutes: i32,
    /// Run ffmpeg `silenceremove` on the output (trim leading/trailing silence)?
    #[serde(default)]
    pub trim_silence: bool,
    /// Auto-stop manual recordings after N minutes. Valid 0..=1440, 0 = off.
    #[serde(default)]
    pub manual_max_minutes: i32,
    /// Pre-roll buffer in seconds. Valid 0..=60, 0 = off.
    #[serde(default)]
    pub pre_roll_seconds: i32,
    /// Reminder notification N minutes before a scheduled recording.
    /// Valid 0..=60, 0 = off.
    #[serde(default)]
    pub reminder_minutes: i32,

    // ── System behaviour ─────────────────────────────────────────────────────
    /// Launch the app at OS login?
    #[serde(default)]
    pub launch_at_login: bool,
    /// Show the window on startup (vs starting in the tray)?
    #[serde(default)]
    pub show_on_startup: bool,
    /// Minimise to the system tray instead of quitting? Default true.
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    /// Wake the machine from sleep for scheduled recordings? Default true.
    #[serde(default = "default_true")]
    pub wake_from_sleep: bool,
    /// Require confirmation before stopping an in-progress recording? Default true.
    #[serde(default = "default_true")]
    pub protect_recording: bool,

    // ── Schedule (Fase 5) ─────────────────────────────────────────────────────
    /// Weekly recurring recording windows. Empty by default. The scheduler
    /// engine turns these into start/stop/reminder/preflight timers; see
    /// [`crate::schedule`] for the decision logic.
    #[serde(default)]
    pub slots: Vec<ScheduleSlot>,
    /// One-off dated recordings (concerts, special services). Empty by default.
    /// Auto-pruned 7 days after they end ([`crate::schedule::prune_specials`]).
    #[serde(default)]
    pub special_recordings: Vec<SpecialRecording>,

    // ── Misc ─────────────────────────────────────────────────────────────────
    /// Download and install updates automatically? Default true.
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Prompt to open the editor after a recording finishes? Default true.
    #[serde(default = "default_true")]
    pub ask_open_editor: bool,
}

// ── Per-field default helpers (so `#[serde(default = "...")]` and the `Default`
//    impl share one source of truth) ──────────────────────────────────────────

fn default_language() -> Option<String> {
    None
}
fn default_channels() -> ChannelMode {
    ChannelMode::Stereo
}
fn default_sample_rate() -> i32 {
    48_000
}
fn default_input_volume() -> i32 {
    100
}
fn default_comp_threshold() -> f64 {
    -24.0
}
fn default_comp_ratio() -> f64 {
    4.0
}
fn default_comp_attack() -> f64 {
    10.0
}
fn default_comp_release() -> f64 {
    200.0
}
fn default_limiter_ceiling() -> f64 {
    -1.0
}
fn default_format() -> FileFormat {
    FileFormat::Mp3
}
fn default_bitrate() -> String {
    "192".to_string()
}
fn default_filename_pattern() -> FilenamePattern {
    FilenamePattern::Date
}
fn default_silence_threshold() -> i32 {
    -50
}
fn default_silence_timeout_minutes() -> i32 {
    5
}
fn default_true() -> bool {
    true
}

impl Default for Settings {
    /// The Electron `defaults` object (`store.ts` lines 6+), field-for-field.
    fn default() -> Self {
        Self {
            language: default_language(),
            has_launched: false,
            onboarding_done: false,

            device_id: None,
            device_name: None,

            video_enabled: false,
            video_device_name: None,
            video_device_index: None,

            channels: default_channels(),
            sample_rate: default_sample_rate(),
            input_volume: default_input_volume(),
            eq_bass: 0,
            eq_mid: 0,
            eq_treble: 0,
            comp_enabled: false,
            comp_threshold: default_comp_threshold(),
            comp_ratio: default_comp_ratio(),
            comp_attack: default_comp_attack(),
            comp_release: default_comp_release(),
            limiter_enabled: true,
            limiter_ceiling: default_limiter_ceiling(),

            format: default_format(),
            bitrate: default_bitrate(),
            filename_pattern: default_filename_pattern(),
            save_folder: None,
            auto_delete_days: 0,

            stop_on_silence: false,
            silence_threshold: default_silence_threshold(),
            silence_timeout_minutes: default_silence_timeout_minutes(),
            split_minutes: 0,
            trim_silence: false,
            manual_max_minutes: 0,
            pre_roll_seconds: 0,
            reminder_minutes: 0,

            launch_at_login: false,
            show_on_startup: false,
            minimize_to_tray: true,
            wake_from_sleep: true,
            protect_recording: true,

            slots: Vec::new(),
            special_recordings: Vec::new(),

            auto_update: true,
            ask_open_editor: true,
        }
    }
}

/// Clamp a float to `[min, max]`, substituting `def` when it is not finite
/// (NaN / ±∞). Direct port of the Electron `clampNum` (`store.ts:261`):
/// `isNaN(n) || !isFinite(n) ? def : Math.max(min, Math.min(max, n))`.
fn clamp_f64(v: f64, min: f64, max: f64, def: f64) -> f64 {
    if v.is_finite() {
        v.clamp(min, max)
    } else {
        def
    }
}

/// Clamp an integer to `[min, max]`. Integers are always finite, so there is no
/// default-fallback branch — the Electron `clampNum` only fell back for the
/// float fields where NaN was reachable.
fn clamp_i32(v: i32, min: i32, max: i32) -> i32 {
    v.clamp(min, max)
}

impl Settings {
    /// Clamp every numeric field to its valid range, mirroring the Electron
    /// `importProfile` clamping (`store.ts:299+`). Non-numeric/enum/bool fields
    /// are already constrained by their types, so they pass through untouched.
    ///
    /// This is idempotent: validating an already-valid `Settings` is a no-op.
    pub fn validate(&mut self) {
        // Audio processing
        self.sample_rate = clamp_i32(self.sample_rate, 8_000, 192_000);
        self.input_volume = clamp_i32(self.input_volume, 0, 200);
        self.eq_bass = clamp_i32(self.eq_bass, -24, 24);
        self.eq_mid = clamp_i32(self.eq_mid, -24, 24);
        self.eq_treble = clamp_i32(self.eq_treble, -24, 24);
        self.comp_threshold = clamp_f64(self.comp_threshold, -60.0, 0.0, -24.0);
        self.comp_ratio = clamp_f64(self.comp_ratio, 1.0, 100.0, 4.0);
        self.comp_attack = clamp_f64(self.comp_attack, 0.1, 2000.0, 10.0);
        self.comp_release = clamp_f64(self.comp_release, 1.0, 9000.0, 200.0);
        self.limiter_ceiling = clamp_f64(self.limiter_ceiling, -10.0, 0.0, -1.0);

        // Output
        self.auto_delete_days = clamp_i32(self.auto_delete_days, 0, 3650);

        // Recording behaviour
        self.silence_threshold = clamp_i32(self.silence_threshold, -90, 0);
        self.silence_timeout_minutes = clamp_i32(self.silence_timeout_minutes, 1, 120);
        self.split_minutes = clamp_i32(self.split_minutes, 0, 480);
        self.manual_max_minutes = clamp_i32(self.manual_max_minutes, 0, 1440);
        self.pre_roll_seconds = clamp_i32(self.pre_roll_seconds, 0, 60);
        self.reminder_minutes = clamp_i32(self.reminder_minutes, 0, 60);
    }

    /// Validated copy — convenience for callers that prefer a value.
    pub fn validated(mut self) -> Self {
        self.validate();
        self
    }

    /// Parse a (possibly partial or older) settings JSON blob, MERGING it over
    /// the defaults: any missing or unknown field falls back to its default,
    /// matching the Electron `store.get(key, default)` semantics. A malformed
    /// blob (not a JSON object) falls back to the full defaults rather than
    /// erroring, so a corrupt store never bricks the app.
    ///
    /// The returned value is NOT yet validated — call [`Settings::validate`]
    /// (the persistence layer does this).
    pub fn from_json_merged(value: &str) -> Settings {
        serde_json::from_str::<Settings>(value).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_electron() {
        let s = Settings::default();
        // System
        assert_eq!(s.language, None);
        assert!(!s.has_launched);
        assert!(!s.onboarding_done);
        // Audio device
        assert_eq!(s.device_id, None);
        assert_eq!(s.device_name, None);
        // Video device
        assert!(!s.video_enabled);
        assert_eq!(s.video_device_name, None);
        assert_eq!(s.video_device_index, None);
        // Audio processing
        assert_eq!(s.channels, ChannelMode::Stereo);
        assert_eq!(s.sample_rate, 48_000);
        assert_eq!(s.input_volume, 100);
        assert_eq!(s.eq_bass, 0);
        assert_eq!(s.eq_mid, 0);
        assert_eq!(s.eq_treble, 0);
        assert!(!s.comp_enabled);
        assert_eq!(s.comp_threshold, -24.0);
        assert_eq!(s.comp_ratio, 4.0);
        assert_eq!(s.comp_attack, 10.0);
        assert_eq!(s.comp_release, 200.0);
        assert!(s.limiter_enabled);
        assert_eq!(s.limiter_ceiling, -1.0);
        // Output
        assert_eq!(s.format, FileFormat::Mp3);
        assert_eq!(s.bitrate, "192");
        assert_eq!(s.filename_pattern, FilenamePattern::Date);
        assert_eq!(s.save_folder, None);
        assert_eq!(s.auto_delete_days, 0);
        // Recording behaviour
        assert!(!s.stop_on_silence);
        assert_eq!(s.silence_threshold, -50);
        assert_eq!(s.silence_timeout_minutes, 5);
        assert_eq!(s.split_minutes, 0);
        assert!(!s.trim_silence);
        assert_eq!(s.manual_max_minutes, 0);
        assert_eq!(s.pre_roll_seconds, 0);
        assert_eq!(s.reminder_minutes, 0);
        // System behaviour
        assert!(!s.launch_at_login);
        assert!(!s.show_on_startup);
        assert!(s.minimize_to_tray);
        assert!(s.wake_from_sleep);
        assert!(s.protect_recording);
        // Schedule (Fase 5)
        assert!(s.slots.is_empty());
        assert!(s.special_recordings.is_empty());
        // Misc
        assert!(s.auto_update);
        assert!(s.ask_open_editor);
    }

    #[test]
    fn validate_clamps_sample_rate() {
        let mut over = Settings {
            sample_rate: 999_999,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.sample_rate, 192_000);

        let mut under = Settings {
            sample_rate: 1,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.sample_rate, 8_000);
    }

    #[test]
    fn validate_clamps_input_volume() {
        let mut over = Settings {
            input_volume: 5_000,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.input_volume, 200);

        let mut under = Settings {
            input_volume: -10,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.input_volume, 0);
    }

    #[test]
    fn validate_clamps_eq_bands() {
        let mut s = Settings {
            eq_bass: 100,
            eq_mid: -100,
            eq_treble: 50,
            ..Default::default()
        };
        s.validate();
        assert_eq!(s.eq_bass, 24);
        assert_eq!(s.eq_mid, -24);
        assert_eq!(s.eq_treble, 24);
    }

    #[test]
    fn validate_clamps_compressor_fields_and_nan_falls_back() {
        let mut s = Settings {
            comp_threshold: -200.0,
            comp_ratio: 0.0,
            comp_attack: 9_999.0,
            comp_release: 0.0,
            ..Default::default()
        };
        s.validate();
        assert_eq!(s.comp_threshold, -60.0);
        assert_eq!(s.comp_ratio, 1.0);
        assert_eq!(s.comp_attack, 2000.0);
        assert_eq!(s.comp_release, 1.0);

        // NaN → per-field default (mirrors clampNum's isNaN branch).
        let mut nan = Settings {
            comp_threshold: f64::NAN,
            comp_ratio: f64::INFINITY,
            comp_attack: f64::NEG_INFINITY,
            comp_release: f64::NAN,
            limiter_ceiling: f64::NAN,
            ..Default::default()
        };
        nan.validate();
        assert_eq!(nan.comp_threshold, -24.0);
        assert_eq!(nan.comp_ratio, 4.0);
        assert_eq!(nan.comp_attack, 10.0);
        assert_eq!(nan.comp_release, 200.0);
        assert_eq!(nan.limiter_ceiling, -1.0);
    }

    #[test]
    fn validate_clamps_limiter_ceiling() {
        let mut over = Settings {
            limiter_ceiling: 5.0,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.limiter_ceiling, 0.0);

        let mut under = Settings {
            limiter_ceiling: -50.0,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.limiter_ceiling, -10.0);
    }

    #[test]
    fn validate_clamps_silence_threshold_and_timeout() {
        let mut s = Settings {
            silence_threshold: 50,
            silence_timeout_minutes: 999,
            ..Default::default()
        };
        s.validate();
        assert_eq!(s.silence_threshold, 0);
        assert_eq!(s.silence_timeout_minutes, 120);

        let mut lo = Settings {
            silence_threshold: -200,
            silence_timeout_minutes: 0,
            ..Default::default()
        };
        lo.validate();
        assert_eq!(lo.silence_threshold, -90);
        assert_eq!(lo.silence_timeout_minutes, 1);
    }

    #[test]
    fn validate_clamps_split_manual_preroll_reminder() {
        let mut s = Settings {
            split_minutes: 9_999,
            manual_max_minutes: 99_999,
            pre_roll_seconds: 600,
            reminder_minutes: 600,
            ..Default::default()
        };
        s.validate();
        assert_eq!(s.split_minutes, 480);
        assert_eq!(s.manual_max_minutes, 1440);
        assert_eq!(s.pre_roll_seconds, 60);
        assert_eq!(s.reminder_minutes, 60);
    }

    #[test]
    fn validate_clamps_auto_delete_days() {
        let mut over = Settings {
            auto_delete_days: 100_000,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.auto_delete_days, 3650);

        let mut under = Settings {
            auto_delete_days: -5,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.auto_delete_days, 0);
    }

    #[test]
    fn validate_is_idempotent_on_defaults() {
        let mut s = Settings::default();
        let before = s.clone();
        s.validate();
        assert_eq!(s, before);
    }

    #[test]
    fn channel_mode_serde_matches_electron_strings() {
        // camelCase tags, NOT snake_case — must match types/index.ts:1.
        assert_eq!(
            serde_json::to_string(&ChannelMode::Stereo).unwrap(),
            "\"stereo\""
        );
        assert_eq!(
            serde_json::to_string(&ChannelMode::MonoL).unwrap(),
            "\"monoL\""
        );
        assert_eq!(
            serde_json::to_string(&ChannelMode::MonoR).unwrap(),
            "\"monoR\""
        );
        assert_eq!(
            serde_json::to_string(&ChannelMode::MonoMix).unwrap(),
            "\"monoMix\""
        );
        // round-trip
        let back: ChannelMode = serde_json::from_str("\"monoMix\"").unwrap();
        assert_eq!(back, ChannelMode::MonoMix);
    }

    #[test]
    fn file_format_and_pattern_serde_match_electron_strings() {
        assert_eq!(serde_json::to_string(&FileFormat::Mp3).unwrap(), "\"mp3\"");
        assert_eq!(serde_json::to_string(&FileFormat::Wav).unwrap(), "\"wav\"");
        assert_eq!(
            serde_json::to_string(&FileFormat::Flac).unwrap(),
            "\"flac\""
        );
        assert_eq!(serde_json::to_string(&FileFormat::Aac).unwrap(), "\"aac\"");

        assert_eq!(
            serde_json::to_string(&FilenamePattern::Date).unwrap(),
            "\"date\""
        );
        assert_eq!(
            serde_json::to_string(&FilenamePattern::Church).unwrap(),
            "\"church\""
        );
        assert_eq!(
            serde_json::to_string(&FilenamePattern::Plain).unwrap(),
            "\"plain\""
        );
        assert_eq!(
            serde_json::to_string(&FilenamePattern::Datetime).unwrap(),
            "\"datetime\""
        );
    }

    #[test]
    fn settings_field_keys_serialise_as_camel_case() {
        // The JSON keys must match the Electron `Settings` interface (camelCase),
        // so an exported profile interoperates with the old build.
        let json = serde_json::to_value(Settings::default()).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("hasLaunched"));
        assert!(obj.contains_key("deviceName"));
        assert!(obj.contains_key("videoEnabled"));
        assert!(obj.contains_key("videoDeviceName"));
        assert!(obj.contains_key("videoDeviceIndex"));
        assert!(obj.contains_key("sampleRate"));
        assert!(obj.contains_key("inputVolume"));
        assert!(obj.contains_key("filenamePattern"));
        assert!(obj.contains_key("stopOnSilence"));
        assert!(obj.contains_key("silenceTimeoutMinutes"));
        assert!(obj.contains_key("autoUpdate"));
        assert!(obj.contains_key("askOpenEditor"));
        // Schedule keys must match the Electron `Settings` interface.
        assert!(obj.contains_key("slots"));
        assert!(obj.contains_key("specialRecordings"));
    }

    #[test]
    fn slots_and_specials_round_trip_through_json() {
        use crate::schedule::{ScheduleSlot, SpecialRecording};
        let original = Settings {
            slots: vec![ScheduleSlot {
                days: vec![6],
                start: "11:00".to_string(),
                stop: "12:30".to_string(),
                max: Some(120),
            }],
            special_recordings: vec![SpecialRecording {
                id: Some("s1".to_string()),
                date: "2026-12-24".to_string(),
                name: "Julaften".to_string(),
                start: "16:00".to_string(),
                stop: "17:00".to_string(),
                device_id: None,
            }],
            ..Default::default()
        };
        let json = serde_json::to_string(&original).unwrap();
        let back = Settings::from_json_merged(&json);
        assert_eq!(back.slots, original.slots);
        assert_eq!(back.special_recordings, original.special_recordings);
        // An older blob without the schedule keys defaults them to empty.
        let legacy = Settings::from_json_merged(r#"{ "sampleRate": 44100 }"#);
        assert!(legacy.slots.is_empty());
        assert!(legacy.special_recordings.is_empty());
    }

    #[test]
    fn from_json_merged_fills_defaults_for_empty_object() {
        let s = Settings::from_json_merged("{}");
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn from_json_merged_falls_back_on_garbage() {
        // Not an object → full defaults rather than a panic.
        assert_eq!(Settings::from_json_merged("not json"), Settings::default());
        assert_eq!(Settings::from_json_merged("42"), Settings::default());
        assert_eq!(Settings::from_json_merged("[]"), Settings::default());
    }

    #[test]
    fn from_json_merged_overlays_partial_over_defaults() {
        // Only two fields present + one unknown field — the rest must default,
        // the unknown must be ignored.
        let s = Settings::from_json_merged(
            r#"{ "sampleRate": 44100, "format": "wav", "someFutureField": true }"#,
        );
        assert_eq!(s.sample_rate, 44_100);
        assert_eq!(s.format, FileFormat::Wav);
        // Untouched fields kept their defaults.
        assert_eq!(s.input_volume, 100);
        assert_eq!(s.channels, ChannelMode::Stereo);
        assert!(s.minimize_to_tray);
    }

    #[test]
    fn round_trip_through_json_is_identical_after_validate() {
        let original = Settings {
            language: Some("en".to_string()),
            device_name: Some("Soundcraft USB".to_string()),
            channels: ChannelMode::MonoMix,
            sample_rate: 44_100,
            input_volume: 150,
            format: FileFormat::Flac,
            filename_pattern: FilenamePattern::Datetime,
            stop_on_silence: true,
            silence_timeout_minutes: 10,
            ..Default::default()
        }
        .validated();

        let json = serde_json::to_string(&original).unwrap();
        let mut back = Settings::from_json_merged(&json);
        back.validate();
        assert_eq!(back, original);
    }
}
