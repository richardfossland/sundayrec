-- SundayRec migration 0003 — cloud upload queue (Fase 6)
--
-- Durable backing store for the cloud-backup upload queue, replacing the Electron
-- build's electron-store JSON array. The pure state machine lives in
-- `sundayrec-core::cloud::queue`; this table only persists the `QueueEntry` rows
-- so a queued backup survives an app restart. Timestamps are unix ms (INTEGER),
-- matching the core's i64 fields. `service`/`status` store the same kebab-case
-- strings the core serialises (so persisted rows carry across unchanged).
create table if not exists upload_queue (
  id              TEXT PRIMARY KEY,
  service         TEXT NOT NULL,            -- 'google-drive' | 'youtube' | 'gmail'
  file_path       TEXT NOT NULL,
  entry_timestamp INTEGER,                  -- history-entry ts, marks uploaded on success
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt    INTEGER NOT NULL,         -- unix ms; earliest the worker may retry
  last_error      TEXT,
  enqueued_at     INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','uploading','failed','reauth-required'))
);

-- The core deduplicates by (service, file_path); enforce it in storage too.
create unique index if not exists idx_upload_queue_dedup
  on upload_queue (service, file_path);

-- The worker picks the earliest due pending entry.
create index if not exists idx_upload_queue_due
  on upload_queue (status, next_attempt);
