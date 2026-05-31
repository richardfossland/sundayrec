//! Tauri command handlers.
//!
//! Commands are the thin IPC layer the renderer calls via `invoke()`. They
//! delegate to `sundayrec-core` (and, later, the `services` modules) and return
//! `Result<T, AppError>`. Naming convention: `entity_verb` (e.g. `app_info`).

pub mod app;
pub mod audio;
pub mod bridge;
pub mod bridge_live;
pub mod cloud;
pub mod db;
pub mod diagnostics;
pub mod editor;
pub mod email;
pub mod media;
pub mod ndi;
pub mod recorder;
pub mod review;
pub mod scheduler;
pub mod settings;
pub mod streaming;
pub mod wake;
pub mod whisper;
