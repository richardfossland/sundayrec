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
//!   - [`update`]       — auto-update status model + dev-check guard + semver "is newer" (R7)
//!   - [`silence`]      — the silence-watcher *decision* state machine (no real timers)
//!   - [`settings`]     — the typed/validated settings model + defaults (Fase 1)
//!   - [`preflight`]    — the "ready-to-record" finding decisions (Fase 2)
//!   - [`diagnostics`]  — the diagnostics markdown report builder (Fase 2)
//!   - [`editor`]       — non-destructive cut/trim/region planning + export-arg math (PU-7 editor)
//!   - [`mastering`]    — EBU R128 loudness (integrated/range/true-peak) + normalise-gain decisions (PU-7)
//!   - [`audio_analysis`] — peaks/waveform, spectrum (FFT), segment classification (PU-7)
//!   - [`cloud`]        — Google cloud-backup backbone: OAuth/PKCE, retry mat, upload-queue, Drive resumable bits (Fase 6)
//!   - [`whisper`]      — whisper.cpp transcription decisions: model registry, argv/thread heuristic, progress/exit parse, JSON-sidecar normalise, chunk/merge, language map (PU-5)
//!   - [`prep`]         — episode-prep assembly: sermon detection + attention reasons + EpisodePrep build (PU-6)
//!   - [`review_queue`] — the human-review queue state machine + reminder timeline (PU-6)
//!   - [`integrations`] — Sunday-suite hand-offs: Stage manifest→chapters/setlist + the live cue-bridge consumer (PU-6 + Bridge #2)
//!   - [`streaming`]    — live RTMP multi-destination `tee` muxer arg-building + bitrate/keyframe options + stream-key validation (R3)
//!   - [`overlay`]      — ffmpeg `filter_complex` generation for lower-thirds: image + drawtext, position/opacity (R3)
//!   - [`ndi`]          — NDI source-discovery model + the pure loopback-TCP rawvideo input-arg builder (R3)

pub mod audio;
pub mod audio_analysis;
pub mod capture;
pub mod cloud;
pub mod device_enum;
pub mod device_match;
pub mod diagnostics;
pub mod editor;
pub mod email;
pub mod errors;
pub mod feed;
pub mod ffmpeg;
pub mod filename;
pub mod history;
pub mod integrations;
pub mod link;
pub mod mastering;
pub mod mjpeg;
pub mod ndi;
pub mod overlay;
pub mod preflight;
pub mod prep;
pub mod preroll;
pub mod progress;
pub mod reconnect;
pub mod recorder;
pub mod review_queue;
pub mod schedule;
pub mod settings;
pub mod silence;
pub mod streaming;
pub mod test_recording;
pub mod timeouts;
pub mod tray;
pub mod two_process;
pub mod update;
pub mod wake;
pub mod webhook;
pub mod whisper;
