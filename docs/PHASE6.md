# Fase 6 — Cloud backup (status)

Google-only cloud backup (Drive backup, YouTube publish, Gmail notifications),
all sharing one OAuth client via the Desktop loopback flow. Ported from the
Electron build, split into a pure core and an impure shell.

## Done

**F6.1 — pure core** (`crates/sundayrec-core/src/cloud/*`): PKCE, auth-URL +
token-request builders, token-response parsing, loopback-callback validation,
state-replay guard, refresh-error classification (`oauth`); transient-error
classification + backoff (`retry`); the upload-queue state machine (`queue`);
Drive resumable-upload arithmetic (`drive`). All network-free + unit-tested.

**F6.2 — durable queue + command surface** (this pass): the impure shell's
testable half.

- `src-tauri/migrations/0003_upload_queue.sql` — durable `upload_queue` table
  (replaces Electron's electron-store array), unique on `(service, file_path)`.
- `src-tauri/src/cloud/store.rs` — sqlx persistence (`load_queue`, `upsert_entry`,
  `delete_entry`, `clear_failed`, `clear_service`), tested against a temp DB.
- `src-tauri/src/cloud/mod.rs` — the queue manager seam combining the pure core
  with the store (`enqueue_backup`, `queue_status`, `retry_entry`, `remove_entry`,
  `clear_failed`, `disconnect`) + `connection_statuses()` over the keychain.
- `src-tauri/src/commands/cloud.rs` — 7 Tauri commands (all network-free).
- `src/features/cloud/CloudBackupPanel.tsx` — connections + queue UI with
  disconnect / retry / remove / clear-failed.

Verified: `cargo test` (queue store + manager) + `vitest` (panel) green; clippy +
fmt + tsc + eslint clean. The DB is the single source of truth, so a queued
backup survives a restart.

## Not yet built (clearly-scoped next step)

Deferred because it cannot be exercised without a network, a Google OAuth client
id, and a real device — keeping unverifiable I/O glue out of the tree until it
can be run. Both pieces are thin, because the decisions already live in the
tested core:

1. **OAuth connect flow** — a `cloud_connect(service)` command that:
   opens a loopback `TcpListener`, builds the consent URL via
   `cloud::oauth::build_auth_url` (with a random PKCE verifier +
   `cloud::oauth::pkce_challenge`), opens the system browser, validates the
   redirect via `cloud::oauth::parse_loopback_callback` + the `StateReplayGuard`,
   exchanges the code (`build_token_exchange_body` → `reqwest` →
   `parse_token_response`), and stores the refresh token via
   `crate::secrets::set`.

2. **Upload worker** — a background task that drives
   `cloud::queue::{select_next, mark_uploading, on_success, on_failure}` and
   `cloud::drive::{chunk_plan, content_range_header, parse_resume_offset,
chunk_status_outcome}` over `reqwest` resumable uploads, refreshing the access
   token (`build_refresh_body` + `classify_refresh_error`) as needed, persisting
   each transition through `cloud::store`, and scheduling its next wake with
   `cloud::queue::next_wakeup_delay_ms`.

Both require `reqwest` (add to `src-tauri/Cargo.toml`) and a configured Google
OAuth client id. When wired, they will be HARDWARE/NETWORK-UNVERIFIED until run
on a real device with a real Google account.
