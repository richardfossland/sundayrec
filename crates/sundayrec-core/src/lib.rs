//! SundayRec domain core — pure, GUI-free, Tauri-free.
//!
//! This crate is the *behaviour* of the recorder distilled out of the Electron
//! main process (`src/main/recorder-utils.ts` and friends) into deterministic
//! Rust. The Electron code is the behavioural specification; the structure here
//! is rebuilt clean (see `docs/MIGRATION-TAURI2.md`, §2 "bygg det riktig").
//!
//! Everything here is unit-testable without a display, a device, or a process —
//! the `src-tauri` shell is a thin command/event layer on top.
//!
//! Modules:
//!   - [`audio`]        — pure VU metering mat: block peak/RMS, dBFS, lock-free `PeakMeters`
//!   - [`ffmpeg`]       — pure ffmpeg filter-string builders (drift, silencedetect)
//!   - [`capture`]      — unified ffmpeg capture-argument builder (Spike B)
//!   - [`errors`]       — ffmpeg-stderr → stable error-code classification
//!   - [`filename`]     — output-filename construction (sanitise + pattern) (Fase 5)
//!   - [`device_match`] — 5-strategy fuzzy device matching (the device-name moat)
//!   - [`device_enum`]  — pure ffmpeg `-list_devices` stderr parsers (audio + video)
//!   - [`email`]         — error/test alert templates (7-lang) + throttle/dedup gate + RFC 2822/base64url assembly (PU-1)
//!   - [`feed`]          — podcast RSS 2.0 + iTunes XML builder (PU-3)
//!   - [`tray`]          — tray menu-model (localized items/actions) + inbound deep-link dispatch sits in [`link`] (PU-2)
//!   - [`mjpeg`]        — MJPEG stdout reassembly (SOI/EOI frame splitter + JPEG dims)
//!   - [`preroll`]      — pre-roll rolling-capture / harvest-trim decision mat (Fase 3.2)
//!   - [`progress`]     — ffmpeg `size=`-progress parsing + one-shot startup resolution
//!   - [`reconnect`]    — watchdog (stuck-progress) + reconnect back-off decisions
//!   - [`recorder`]     — the recorder state machine + session recovery/split policy (Fase 3)
//!   - [`schedule`]     — scheduler recurrence/occurrence/missed-recording decisions (Fase 5)
//!   - [`wake`]         — wake-from-sleep capability/parse/schedule-command decisions (Fase 5)
//!   - [`timeouts`]     — recording-pipeline timeout constants (one source of truth)
//!   - [`two_process`]  — two-process audio+video fallback: per-process capture args + A/V mux/offset (Fase 3.3b)
//!   - [`silence`]      — the silence-watcher *decision* state machine (no real timers)
//!   - [`settings`]     — the typed/validated settings model + defaults (Fase 1)
//!   - [`preflight`]    — the "ready-to-record" finding decisions (Fase 2)
//!   - [`diagnostics`]  — the diagnostics markdown report builder (Fase 2)
//!   - [`cloud`]        — Google cloud-backup backbone: OAuth/PKCE, retry mat, upload-queue, Drive resumable bits (Fase 6)

pub mod audio;
pub mod capture;
pub mod cloud;
pub mod device_enum;
pub mod device_match;
pub mod diagnostics;
pub mod email;
pub mod errors;
pub mod feed;
pub mod ffmpeg;
pub mod filename;
pub mod link;
pub mod mjpeg;
pub mod preflight;
pub mod preroll;
pub mod progress;
pub mod reconnect;
pub mod recorder;
pub mod schedule;
pub mod settings;
pub mod silence;
pub mod timeouts;
pub mod tray;
pub mod two_process;
pub mod wake;
