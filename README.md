# SundayRec

Recording for church services — the Tauri 2 rebuild of the Electron SundayRec,
on the same foundation as the rest of the Sunday suite (Tauri 2 + Rust +
React 19 + Tailwind v4 + ts-rs).

> **This is the official SundayRec.** It supersedes the original Electron app
> (versions ≤ 4.55.0). The legacy Electron source is preserved on the
> [`electron-legacy`](https://github.com/richardfossland/sundayrec/tree/electron-legacy)
> branch (tag `v4.55.0`) and is no longer maintained.
>
> **Upgrading from 4.x:** download the latest installer from
> [Releases](https://github.com/richardfossland/sundayrec/releases/latest). The
> new app replaces the old one. Your **recordings are safe** (they live in your
> chosen save folder); app **settings must be re-entered** (the new version
> stores them separately).

The legacy Electron app (now the `electron-legacy` branch) is the **behavioural
specification**, not a template. We reuse the _knowledge_ — hardened ffmpeg
arguments, device parsers, error classification, silence/watchdog logic — but
rebuild the _structure_ cleanly in Rust. See
[`docs/MIGRATION-TAURI2.md`](docs/MIGRATION-TAURI2.md) for the phase-by-phase plan.

## Status — Fase 0-fundament

Scaffolded and green:

- **Cargo workspace** with a clean split:
  - `crates/sundayrec-core` — pure, GUI-free, Tauri-free domain core. Unit-
    testable without a display or device. Ported from the Electron
    `recorder-utils.ts`:
    - `ffmpeg.rs` — A/V drift filter + `silencedetect` filter builders
    - `errors.rs` — ffmpeg-stderr → stable `RecordingErrorCode` classification
    - `timeouts.rs` — the one source of truth for recorder timeouts
    - `silence.rs` — the silence-watcher decision state machine
  - `src-tauri` — thin Tauri 2 command/event shell (`app_info` IPC roundtrip,
    `AppError`, tracing, opener/dialog/process plugins).
- **React 19 + Tailwind v4** frontend with TanStack Query; `App` calls
  `app_info` over IPC and shows "SundayRec — backend OK" + version/platform.
- **ts-rs** generates the TypeScript bindings into `src/lib/bindings/`.

Intentionally **not** in this foundation (later in Fase 0 / later phases):
Spike A (cpal metering + ffmpeg MJPEG preview), Spike B (recorder plumbing
prototype), the ffmpeg sidecar download wiring, SQLite/sqlx, keyring, and CI.
`scripts/fetch-ffmpeg.mjs` is copied from SundayEdit as a reference for the
sidecar wiring later.

## Build & test

```bash
# Rust
cargo check --workspace              # type-check everything
cargo test -p sundayrec-core         # domain-core unit tests (fast, no GUI)
cargo test --workspace               # all Rust tests
npm run bindings                     # regenerate ts-rs TypeScript bindings

# Frontend
npm install
npm run build                        # tsc + vite production build
npm run test                         # vitest (jsdom)
npm run check                        # full gate: lint + typecheck + vitest + clippy + cargo test
```

`npm run tauri dev` / `npm run tauri build` need a display and will fetch the
WebView toolchain — run those locally, not in the headless gate.
