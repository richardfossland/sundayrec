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

/// Capture sample-rate policy. `Auto` (the default) captures at the device's
/// NATIVE rate — the recorder omits `-ar` entirely so ffmpeg never resamples
/// (forcing a 48 kHz `-ar` on a 44.1 kHz USB mixer dropped samples → choppy
/// audio). The explicit rates force that rate via `-ar`. Serialised camelCase
/// (`"auto" | "r44100" | "r48000" | "r96000"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/lib/bindings/SampleRate.ts")]
#[serde(rename_all = "camelCase")]
pub enum SampleRate {
    /// Capture at the device's native rate (omit `-ar`).
    Auto,
    /// Force 44.1 kHz.
    R44100,
    /// Force 48 kHz.
    R48000,
    /// Force 96 kHz.
    R96000,
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
    /// Capture resolution tag: `"480p"` | `"720p"` | `"1080p"` | `"2160p"` (4K).
    /// Default `"720p"`.
    #[serde(default = "default_video_resolution")]
    pub video_resolution: String,
    /// Capture frame rate (fps). Valid 1..=120, default 30.
    #[serde(default = "default_video_framerate")]
    pub video_framerate: i32,
    /// Recording video container: `"mp4"` (default) | `"mov"`. Both are
    /// QuickTime/ISO containers that take H.264/H.265 + AAC and `+faststart`.
    #[serde(default = "default_video_container")]
    pub video_container: String,
    /// Recording video codec: `"h264"` (default, universal) | `"h265"` (HEVC,
    /// ~half the size; for live 4K a hardware encoder is recommended).
    #[serde(default = "default_video_codec")]
    pub video_codec: String,
    /// Recording video encoder backend: `"software"` (default, libx264/5 — best
    /// quality) | `"hardware"` (VideoToolbox on macOS — realtime, needed for live
    /// 4K H.265). Ignored off macOS (falls back to software).
    #[serde(default = "default_video_encoder")]
    pub video_encoder: String,
    /// Mirror the camera horizontally (preview + recording). Default false.
    /// Electron `videoFlip` — handy for front-facing / mirrored stage cameras.
    #[serde(default)]
    pub video_flip: bool,
    /// Output muxing: `"combined"` (one A/V file) | `"separate"` (split files).
    /// Default `"combined"`.
    #[serde(default = "default_output_mode")]
    pub output_mode: String,
    /// Also keep the standalone high-quality audio file next to a combined MP4?
    #[serde(default)]
    pub keep_separate_audio: bool,
    /// Container/codec for the standalone audio file extracted alongside a video
    /// recording when `keep_separate_audio` is on. Default `Wav` (lossless, the
    /// safe choice for a "keep the clean audio" sidecar).
    #[serde(default = "default_separate_audio_format")]
    pub separate_audio_format: FileFormat,
    /// Use a single ffmpeg process for A/V to eliminate sync drift? Default true.
    #[serde(default = "default_true")]
    pub av_sync: bool,

    // ── Audio processing ───────────────────────────────────────────────────────
    /// Input channel layout.
    #[serde(default = "default_channels")]
    pub channels: ChannelMode,
    /// Explicit 0-based input channel to record into the LEFT output channel.
    /// `None` keeps the `channels`-mode default routing. Set for multi-channel
    /// mixers (e.g. an X32) where you want to record specific channels (17 & 18).
    /// Clamped 0..=31 in `validate()`. Only honoured for `ChannelMode::Stereo`.
    #[serde(default)]
    pub input_channel_l: Option<i32>,
    /// Explicit 0-based input channel to record into the RIGHT output channel.
    /// See [`Settings::input_channel_l`].
    #[serde(default)]
    pub input_channel_r: Option<i32>,
    /// Sample rate in Hz. Valid 8000..=192000, default 48000. KEPT for
    /// back-compat with exported/old profiles; the RECORDER no longer reads it —
    /// it uses [`Settings::resolved_sample_rate`] (driven by `sample_rate_mode`).
    #[serde(default = "default_sample_rate")]
    pub sample_rate: i32,
    /// How the capture sample rate is chosen. `Auto` (default) captures at the
    /// device's native rate (no resample → no choppiness); the explicit variants
    /// force a rate. This is what the recorder actually consults.
    #[serde(default = "default_sample_rate_mode")]
    pub sample_rate_mode: SampleRate,
    /// Input gain as a percentage. Valid 0..=200, default 100.
    #[serde(default = "default_input_volume")]
    pub input_volume: i32,
    /// Is the equalizer enabled?
    #[serde(default)]
    pub eq_enabled: bool,
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
    /// Show the live L/R level meters during recording? Default true. When off,
    /// the recorder drops the `astats` levels filter from its ffmpeg chain — the
    /// meter's per-frame stderr can starve capture on a loaded machine, so turning
    /// the meters off trades the display for maximum capture stability.
    #[serde(default = "default_true")]
    pub show_live_levels: bool,
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

    // ── Church profile (R7 — Electron `churchName`/`responsiblePerson`) ────────
    /// Congregation/church name. Drives the `church` filename pattern and the
    /// localized "church" labels. Empty string = unset (matches the Electron
    /// `''` default, not `null`). See `store.ts` `churchName: ''`.
    #[serde(default)]
    pub church_name: String,
    /// Person responsible for recordings (shown in diagnostics + email alerts).
    /// Empty string = unset (Electron `responsiblePerson: ''`).
    #[serde(default)]
    pub responsible_person: String,

    // ── Notifications (R7 — Electron `notifyStart`/`notifyStop`) ───────────────
    /// Fire a native notification when a scheduled recording starts? Default true.
    #[serde(default = "default_true")]
    pub notify_start: bool,
    /// Fire a native notification when a recording stops? Default true.
    #[serde(default = "default_true")]
    pub notify_stop: bool,
    /// Chat webhook URL (Slack/Discord/Teams). Empty = unset.
    #[serde(default)]
    pub webhook_url: String,
    /// Also POST the webhook on warnings (not just errors)? Default false.
    #[serde(default)]
    pub webhook_on_warning: bool,

    // ── Email alerts (R7 — Electron `email*`; the SMTP pass lives in the OS ────
    //    keychain, NEVER here — mirrors `store.ts` `setSmtpPassword`) ───────────
    /// Send an email when a recording fails / a scheduled one is missed?
    #[serde(default)]
    pub email_on_error: bool,
    /// Recipient address for alert emails. Empty = unset (Electron `''`).
    #[serde(default)]
    pub email_address: String,
    /// SMTP host (blank = use the Gmail transport instead). Electron `emailSmtp`.
    #[serde(default)]
    pub email_smtp: String,
    /// SMTP port. Valid 1..=65535, default 587. Electron `emailSmtpPort: 587`.
    #[serde(default = "default_smtp_port")]
    pub email_smtp_port: i32,
    /// SMTP username. Empty = unset (Electron `emailSmtpUser: ''`). The PASSWORD
    /// is intentionally absent — it is stored in the OS keychain by the `email`
    /// seam, never persisted to the settings bag.
    #[serde(default)]
    pub email_smtp_user: String,

    // ── Editor intro/outro (R7 — Electron `editorIntroPath`/`editorOutroPath`) ─
    /// Path to an intro clip prepended on export, or `None`. Electron used
    /// `undefined`; we keep it `Option` so an unset value stays absent.
    #[serde(default)]
    pub editor_intro_path: Option<String>,
    /// Path to an outro clip appended on export, or `None`.
    #[serde(default)]
    pub editor_outro_path: Option<String>,

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
fn default_sample_rate_mode() -> SampleRate {
    SampleRate::Auto
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
fn default_smtp_port() -> i32 {
    587
}
fn default_video_resolution() -> String {
    "720p".to_string()
}
fn default_video_framerate() -> i32 {
    30
}
fn default_video_container() -> String {
    "mp4".to_string()
}
fn default_video_codec() -> String {
    "h264".to_string()
}
fn default_video_encoder() -> String {
    "software".to_string()
}
fn default_output_mode() -> String {
    "combined".to_string()
}
fn default_separate_audio_format() -> FileFormat {
    FileFormat::Wav
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
            video_resolution: default_video_resolution(),
            video_framerate: default_video_framerate(),
            video_container: default_video_container(),
            video_codec: default_video_codec(),
            video_encoder: default_video_encoder(),
            video_flip: false,
            output_mode: default_output_mode(),
            keep_separate_audio: false,
            separate_audio_format: default_separate_audio_format(),
            av_sync: true,

            channels: default_channels(),
            input_channel_l: None,
            input_channel_r: None,
            sample_rate: default_sample_rate(),
            sample_rate_mode: default_sample_rate_mode(),
            input_volume: default_input_volume(),
            eq_enabled: false,
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
            show_live_levels: true,
            reminder_minutes: 0,

            launch_at_login: false,
            show_on_startup: false,
            minimize_to_tray: true,
            wake_from_sleep: true,
            protect_recording: true,

            slots: Vec::new(),
            special_recordings: Vec::new(),

            church_name: String::new(),
            responsible_person: String::new(),

            notify_start: true,
            notify_stop: true,
            webhook_url: String::new(),
            webhook_on_warning: false,

            email_on_error: false,
            email_address: String::new(),
            email_smtp: String::new(),
            email_smtp_port: default_smtp_port(),
            email_smtp_user: String::new(),

            editor_intro_path: None,
            editor_outro_path: None,

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
        self.input_channel_l = self.input_channel_l.map(|c| clamp_i32(c, 0, 31));
        self.input_channel_r = self.input_channel_r.map(|c| clamp_i32(c, 0, 31));
        self.comp_threshold = clamp_f64(self.comp_threshold, -60.0, 0.0, -24.0);
        self.comp_ratio = clamp_f64(self.comp_ratio, 1.0, 100.0, 4.0);
        self.comp_attack = clamp_f64(self.comp_attack, 0.1, 2000.0, 10.0);
        self.comp_release = clamp_f64(self.comp_release, 1.0, 9000.0, 200.0);
        self.limiter_ceiling = clamp_f64(self.limiter_ceiling, -10.0, 0.0, -1.0);

        // Output
        self.auto_delete_days = clamp_i32(self.auto_delete_days, 0, 3650);

        // Video capture
        self.video_framerate = clamp_i32(self.video_framerate, 1, 120);
        // Normalise resolution/container/codec tags to the known set; anything
        // else falls back to a safe default rather than producing bad ffmpeg args.
        if !matches!(
            self.video_resolution.as_str(),
            "480p" | "720p" | "1080p" | "2160p"
        ) {
            self.video_resolution = default_video_resolution();
        }
        if !matches!(self.video_container.as_str(), "mp4" | "mov") {
            self.video_container = default_video_container();
        }
        if !matches!(self.video_codec.as_str(), "h264" | "h265") {
            self.video_codec = default_video_codec();
        }
        if !matches!(self.video_encoder.as_str(), "software" | "hardware") {
            self.video_encoder = default_video_encoder();
        }

        // Recording behaviour
        self.silence_threshold = clamp_i32(self.silence_threshold, -90, 0);
        self.silence_timeout_minutes = clamp_i32(self.silence_timeout_minutes, 1, 120);
        self.split_minutes = clamp_i32(self.split_minutes, 0, 480);
        self.manual_max_minutes = clamp_i32(self.manual_max_minutes, 0, 1440);
        self.pre_roll_seconds = clamp_i32(self.pre_roll_seconds, 0, 60);
        self.reminder_minutes = clamp_i32(self.reminder_minutes, 0, 60);

        // Email (R7). The SMTP port is the only numeric email field; clamp it to
        // a valid TCP port (Electron left it un-clamped, but a 0/negative port
        // would be a hard ffmpeg/lettre error — clamp defensively).
        self.email_smtp_port = clamp_i32(self.email_smtp_port, 1, 65_535);
    }

    /// Validated copy — convenience for callers that prefer a value.
    pub fn validated(mut self) -> Self {
        self.validate();
        self
    }

    /// The lossy-codec bitrate in kbps, parsed from the Electron-heritage
    /// `bitrate` String and clamped to a sane CBR range. Any unparseable / empty /
    /// out-of-range value falls back to 192 kbps so the recorder never receives a
    /// nonsense `-b:a`. (PCM/FLAC ignore this entirely.)
    pub fn bitrate_kbps(&self) -> u32 {
        self.bitrate
            .trim()
            .trim_end_matches(['k', 'K'])
            .parse::<u32>()
            .ok()
            .map(|k| k.clamp(32, 320))
            .unwrap_or(192)
    }

    /// The capture sample rate the recorder should use, derived from
    /// [`Settings::sample_rate_mode`]. `Auto` → `None` (omit `-ar`, capture at the
    /// device's native rate → no resample → no choppiness); the explicit variants
    /// → `Some(hz)`. This is the recorder's source of truth, NOT the legacy
    /// `sample_rate: i32` field (kept only for back-compat).
    pub fn resolved_sample_rate(&self) -> Option<u32> {
        match self.sample_rate_mode {
            SampleRate::Auto => None,
            SampleRate::R44100 => Some(44_100),
            SampleRate::R48000 => Some(48_000),
            SampleRate::R96000 => Some(96_000),
        }
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
        assert_eq!(s.video_resolution, "720p");
        assert_eq!(s.video_framerate, 30);
        assert_eq!(s.output_mode, "combined");
        assert!(!s.keep_separate_audio);
        assert_eq!(s.separate_audio_format, FileFormat::Wav);
        assert!(s.av_sync);
        // Audio processing
        assert!(!s.eq_enabled);
        assert_eq!(s.channels, ChannelMode::Stereo);
        assert_eq!(s.sample_rate, 48_000);
        assert_eq!(s.sample_rate_mode, SampleRate::Auto);
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
        assert!(s.show_live_levels);
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
        // Church profile (R7) — Electron `''` not `null`.
        assert_eq!(s.church_name, "");
        assert_eq!(s.responsible_person, "");
        // Notifications (R7)
        assert!(s.notify_start);
        assert!(s.notify_stop);
        assert_eq!(s.webhook_url, "");
        assert!(!s.webhook_on_warning);
        // Email (R7)
        assert!(!s.email_on_error);
        assert_eq!(s.email_address, "");
        assert_eq!(s.email_smtp, "");
        assert_eq!(s.email_smtp_port, 587);
        assert_eq!(s.email_smtp_user, "");
        // Editor intro/outro (R7)
        assert_eq!(s.editor_intro_path, None);
        assert_eq!(s.editor_outro_path, None);
        // Misc
        assert!(s.auto_update);
        assert!(s.ask_open_editor);
    }

    #[test]
    fn validate_clamps_smtp_port() {
        let mut over = Settings {
            email_smtp_port: 999_999,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.email_smtp_port, 65_535);

        let mut under = Settings {
            email_smtp_port: 0,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.email_smtp_port, 1);
    }

    #[test]
    fn r7_fields_merge_from_partial_json() {
        // A partial blob carrying only the new R7 keys fills the rest from
        // defaults (Electron `store.get(key, default)` semantics).
        let s = Settings::from_json_merged(
            r#"{"churchName":"Domkirken","emailOnError":true,"emailAddress":"a@b.no"}"#,
        );
        assert_eq!(s.church_name, "Domkirken");
        assert!(s.email_on_error);
        assert_eq!(s.email_address, "a@b.no");
        // Untouched field keeps its default.
        assert_eq!(s.email_smtp_port, 587);
        assert!(s.notify_start);
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
    fn bitrate_kbps_parses_clamps_and_defaults() {
        let mk = |b: &str| Settings {
            bitrate: b.into(),
            ..Default::default()
        };
        assert_eq!(mk("192").bitrate_kbps(), 192);
        assert_eq!(mk("320").bitrate_kbps(), 320);
        assert_eq!(mk("256k").bitrate_kbps(), 256, "tolerates a trailing k");
        assert_eq!(mk("999").bitrate_kbps(), 320, "clamps above the ceiling");
        assert_eq!(mk("16").bitrate_kbps(), 32, "clamps below the floor");
        assert_eq!(mk("").bitrate_kbps(), 192, "empty → safe default");
        assert_eq!(mk("abc").bitrate_kbps(), 192, "garbage → safe default");
    }

    #[test]
    fn resolved_sample_rate_maps_modes() {
        let mk = |m: SampleRate| Settings {
            sample_rate_mode: m,
            ..Default::default()
        };
        assert_eq!(mk(SampleRate::Auto).resolved_sample_rate(), None);
        assert_eq!(mk(SampleRate::R44100).resolved_sample_rate(), Some(44_100));
        assert_eq!(mk(SampleRate::R48000).resolved_sample_rate(), Some(48_000));
        assert_eq!(mk(SampleRate::R96000).resolved_sample_rate(), Some(96_000));
        // Default settings = Auto = native (None).
        assert_eq!(Settings::default().resolved_sample_rate(), None);
    }

    #[test]
    fn sample_rate_mode_serde_matches_camel_case() {
        assert_eq!(
            serde_json::to_string(&SampleRate::Auto).unwrap(),
            "\"auto\""
        );
        assert_eq!(
            serde_json::to_string(&SampleRate::R44100).unwrap(),
            "\"r44100\""
        );
        assert_eq!(
            serde_json::to_string(&SampleRate::R48000).unwrap(),
            "\"r48000\""
        );
        assert_eq!(
            serde_json::to_string(&SampleRate::R96000).unwrap(),
            "\"r96000\""
        );
        let back: SampleRate = serde_json::from_str("\"r96000\"").unwrap();
        assert_eq!(back, SampleRate::R96000);
    }

    #[test]
    fn sample_rate_mode_merges_from_partial_json_and_defaults_to_auto() {
        let s = Settings::from_json_merged(r#"{"sampleRateMode":"r44100"}"#);
        assert_eq!(s.sample_rate_mode, SampleRate::R44100);
        assert_eq!(s.resolved_sample_rate(), Some(44_100));
        // An older blob without the key defaults to Auto (native).
        let legacy = Settings::from_json_merged(r#"{"sampleRate":44100}"#);
        assert_eq!(legacy.sample_rate_mode, SampleRate::Auto);
        assert_eq!(legacy.resolved_sample_rate(), None);
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
    fn validate_clamps_input_channels() {
        let mut s = Settings {
            input_channel_l: Some(99),
            input_channel_r: Some(-5),
            ..Default::default()
        };
        s.validate();
        assert_eq!(s.input_channel_l, Some(31));
        assert_eq!(s.input_channel_r, Some(0));

        // None stays None (mode-default routing).
        let mut none = Settings::default();
        none.validate();
        assert_eq!(none.input_channel_l, None);
        assert_eq!(none.input_channel_r, None);
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
    fn validate_clamps_video_framerate() {
        let mut over = Settings {
            video_framerate: 9_999,
            ..Default::default()
        };
        over.validate();
        assert_eq!(over.video_framerate, 120);

        let mut under = Settings {
            video_framerate: 0,
            ..Default::default()
        };
        under.validate();
        assert_eq!(under.video_framerate, 1);
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
        assert!(obj.contains_key("sampleRateMode"));
        assert!(obj.contains_key("showLiveLevels"));
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
