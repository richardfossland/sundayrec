//! Tauri command handlers.
//!
//! Commands are the thin IPC layer the renderer calls via `invoke()`. They
//! delegate to `sundayrec-core` (and, later, the `services` modules) and return
//! `Result<T, AppError>`. Naming convention: `entity_verb` (e.g. `app_info`).

pub mod app;
pub mod audio;
pub mod db;
pub mod media;
pub mod recorder;
pub mod settings;
