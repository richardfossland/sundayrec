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
//!   - [`device_match`] — 5-strategy fuzzy device matching (the device-name moat)
//!   - [`device_enum`]  — pure ffmpeg `-list_devices` stderr parsers (audio + video)
//!   - [`mjpeg`]        — MJPEG stdout reassembly (SOI/EOI frame splitter + JPEG dims)
//!   - [`preroll`]      — pre-roll rolling-capture / harvest-trim decision mat (Fase 3.2)
//!   - [`progress`]     — ffmpeg `size=`-progress parsing + one-shot startup resolution
//!   - [`reconnect`]    — watchdog (stuck-progress) + reconnect back-off decisions
//!   - [`recorder`]     — the recorder state machine + session recovery/split policy (Fase 3)
//!   - [`timeouts`]     — recording-pipeline timeout constants (one source of truth)
//!   - [`silence`]      — the silence-watcher *decision* state machine (no real timers)
//!   - [`settings`]     — the typed/validated settings model + defaults (Fase 1)
//!   - [`preflight`]    — the "ready-to-record" finding decisions (Fase 2)
//!   - [`diagnostics`]  — the diagnostics markdown report builder (Fase 2)

pub mod audio;
pub mod capture;
pub mod device_enum;
pub mod device_match;
pub mod diagnostics;
pub mod errors;
pub mod ffmpeg;
pub mod mjpeg;
pub mod preflight;
pub mod preroll;
pub mod progress;
pub mod reconnect;
pub mod recorder;
pub mod settings;
pub mod silence;
pub mod timeouts;
