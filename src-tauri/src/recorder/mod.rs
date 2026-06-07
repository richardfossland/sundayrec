//! Recorder subsystem (Spike B) — the unified ffmpeg capture engine.
//!
//! This is the plumbing layer that turns the pure decision logic in
//! `sundayrec-core` (device matching, capture-argument building, progress
//! parsing, the silence watcher, the watchdog + reconnect schedule) into a real
//! recording: spawn ONE ffmpeg via the [`crate::media::ffmpeg::spawn_ffmpeg`]
//! primitive, read its stderr line-by-line in a tokio task, and emit Tauri events
//! the renderer renders.
//!
//! The split mirrors the rest of the codebase: every rule lives, tested, in the
//! core crate; this module only wires processes, tasks, and events. It is the
//! recorder analogue of `media/preview.rs`.
//!
//! ⚠️ HARDWARE-UNVERIFIED — the spawn/read/stop path opens a real camera + mic
//! and can only be proven on a rig. See [`engine`] for what is verified by tests
//! vs what the manual smoke-test must confirm.

pub mod concat;
pub mod cpal_capture;
pub mod engine;
pub mod preroll;
pub mod recovery;
pub mod two_process;
