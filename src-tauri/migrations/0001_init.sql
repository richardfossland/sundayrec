-- SundayRec local store (Phase 0 foundation).
--
-- Replaces the Electron build's `electron-store` JSON blob with SQLite. Two
-- concerns the app has from day one:
--   1. app_setting — the key/value settings bag (JSON-encoded values as text),
--      so the renderer keeps its one-call get/set ergonomics.
--   2. recording  — the recording history list shown on the home screen.
--
-- Conventions (shared with the rest of the Sunday suite): ids are TEXT (UUID
-- v7, time-ordered). Timestamps/durations are REAL milliseconds since the Unix
-- epoch. Sizes are INTEGER bytes. Foreign keys are enforced.

PRAGMA foreign_keys = ON;

CREATE TABLE app_setting (
    key   TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL              -- JSON-encoded value, opaque to the store
);

CREATE TABLE recording (
    id          TEXT PRIMARY KEY NOT NULL,
    file_path   TEXT NOT NULL,
    device_name TEXT,                -- NULL when unknown / not captured
    started_at  REAL NOT NULL,       -- epoch ms when capture began
    duration_ms REAL,                -- NULL until the recording is finalised
    byte_size   INTEGER,             -- final file size in bytes, NULL until known
    created_at  REAL NOT NULL        -- epoch ms when the row was written
);

-- History is shown newest-first; index the sort key.
CREATE INDEX idx_recording_created_at ON recording (created_at DESC);
