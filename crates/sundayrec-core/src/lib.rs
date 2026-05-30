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
//!   - [`audio`]    — pure VU metering mat: block peak/RMS, dBFS, lock-free `PeakMeters`
//!   - [`ffmpeg`]   — pure ffmpeg filter-string builders (drift, silencedetect)
//!   - [`errors`]   — ffmpeg-stderr → stable error-code classification
//!   - [`mjpeg`]    — MJPEG stdout reassembly (SOI/EOI frame splitter + JPEG dims)
//!   - [`timeouts`] — recording-pipeline timeout constants (one source of truth)
//!   - [`silence`]  — the silence-watcher *decision* state machine (no real timers)

pub mod audio;
pub mod errors;
pub mod ffmpeg;
pub mod mjpeg;
pub mod silence;
pub mod timeouts;
