//! Local SQLite store — the app's settings bag and recording history.
//!
//! `store` holds the pure, pool-taking query functions (unit-tested against a
//! temp database). This module exposes the [`Db`] handle that the Tauri runtime
//! manages and the commands borrow.

pub mod store;

use sqlx::SqlitePool;

/// Tauri-managed handle to the single app-database connection pool, opened once
/// in `lib.rs` `setup` and shared by every command.
pub struct Db {
    pub pool: SqlitePool,
}

impl Db {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}
