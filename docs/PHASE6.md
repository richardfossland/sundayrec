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

## F6.3 — network layer (wired; NETWORK/HARDWARE-UNVERIFIED)

Built and compiling, every decision delegated to the tested core. Verified only
to the seam — the actual wire behaviour needs a real device + Google account +
a configured client id, so these run but are unverified end-to-end.

- `cloud/config.rs` — `GoogleOAuthConfig::resolve()` from env / build-time
  `option_env!` (`SUNDAYREC_GOOGLE_CLIENT_ID` / `_SECRET`; installed-app secrets
  aren't confidential). `normalize` unit-tested.
- `cloud/oauth_flow.rs` — `cloud_connect(service)` command: loopback
  `TcpListener`, `build_auth_url` (random PKCE verifier + `pkce_challenge`),
  browser via `tauri-plugin-opener`, redirect validated by `decode_query_pairs`
  - `parse_loopback_callback` + `StateReplayGuard`, code exchanged over `reqwest`
    → `parse_token_response`, refresh token stored via `secrets::set`.
- `cloud/worker.rs` — `process_once` + a `spawn`ed background loop that drains
  the queue: `select_next` → `mark_uploading` → token refresh
  (`build_refresh_body` + `classify_refresh_error`, `invalid_grant` →
  `reauth-required`) → resumable Drive upload (`chunk_plan` /
  `content_range_header` / `chunk_status_outcome` / `parse_resume_offset` over
  `reqwest` + `tokio::fs`) → `on_success`/`on_failure`, persisting each
  transition; re-schedules off `next_wakeup_delay_ms`, idles when unconfigured.
- Wired: `reqwest` (rustls) added; `cloud_connect` + `cloud_process_queue_now`
  commands registered; worker spawned in `lib.rs` setup.

### Smoke-test on a real rig (Richard)

1. Set `SUNDAYREC_GOOGLE_CLIENT_ID` (+ `_SECRET`) to a Desktop OAuth client.
2. `npm run tauri dev`, open Sky-backup → Koble til → consent in browser →
   expect the service to show **Tilkoblet**.
3. Record something, confirm it enqueues, and watch the worker upload it to
   Drive (or use the manual `cloud_process_queue_now`).
