# Recording-start latency — analysis & fixes (2026-06-09)

> Why does starting a recording sometimes feel slow? Is pre-roll to blame? Does
> the 30-second pre-roll work well? This documents the end-to-end start path, what
> costs time, and the fixes applied / recommended.

## The start path, step by step

Pressing **Ta opp** runs: `startRecordingNow` → `plan_recording_opts` →
`start_recording` (Rust) → `RecorderEngine::start` → supervisor spawns ffmpeg →
the segment reader waits for ffmpeg's first progress line → `recording://started`.

| Step                         | Where                                                     | Cost        | Always on?                                  |
| ---------------------------- | --------------------------------------------------------- | ----------- | ------------------------------------------- |
| Release camera preview       | `commands/recorder.rs` `preview.stop_and_release().await` | 0.5–2 s     | only if the home camera preview was running |
| **Pre-roll harvest**         | `commands/recorder.rs` `preroll.harvest().await`          | ~0.1–1 s    | only if pre-roll is ON and active           |
| Permission check             | `recorder/engine.rs`                                      | ~1 ms       | yes                                         |
| **Device enumeration**       | `engine.rs` `enumerate_ffmpeg_devices()` (uncached)       | 50–500 ms   | yes                                         |
| Camera mode probe            | `engine.rs` `probe_camera_modes()`                        | 200–1500 ms | only video                                  |
| ffmpeg spawn + device open   | inside ffmpeg                                             | 100–300 ms  | yes                                         |
| Wait for first progress line | segment reader → `started`                                | 100–500 ms  | yes                                         |

**Audio-only, no pre-roll, no preview** (the common sermon case): ≈ **300 ms – 1.3 s**,
dominated by the (deliberately uncached) device enumeration + ffmpeg device open.
**Video and/or pre-roll and/or a live preview** stack the conditional costs on top —
that's when it "sometimes" feels slow.

## Is pre-roll to blame? — Yes, partly

Pre-roll runs a **separate, continuous ffmpeg WAV capture** in the background (a
rolling buffer). When you press record, `start_recording` **harvests** it
synchronously _before_ the main recorder starts:

1. graceful-stop the rolling ffmpeg (flush, ~10–100 ms) — this also **frees the mic**
   so the recorder can open it (one device owner on macOS), so it _must_ happen first;
2. **trim re-encode** the kept window to the recording's codec (~0.1–1 s, 30 s timeout).

So with pre-roll ON, start is delayed by roughly **0.1–1 s**. Crucially, the trimmed
clip isn't actually needed until _finalization_ (it's prepended at the concat step,
often minutes later) — so the **trim re-encode blocking the start is wasted wait**
(see recommendation R1). Pre-roll defaults to **OFF** (`pre_roll_seconds = 0`), so
users who never enabled it pay nothing.

## Does the 30 s pre-roll work well?

The trim math (`crates/sundayrec-core/src/preroll.rs`) is sound and well unit-tested,
but with caveats:

- **It's correct when the buffer has been running > ~300 ms.** A 300 ms safety margin
  is subtracted for unflushed buffers; below that, harvest yields nothing (graceful —
  recording still starts, just without prepend).
- **Cold start / segment-rotation gaps can shorten it.** The rolling capture rotates
  every 90 s with a 200 ms gap; if you press record right after launch or inside that
  gap, you get a short or empty pre-roll. Falls back gracefully.
- **It's `pre_roll_seconds` 0–60 (default 0).** "30 s" is whatever the user sets.
- ⚠️ **It is HARDWARE-UNVERIFIED** — the capture loop, graceful stop, and trim
  re-encode open a real mic and have never been smoke-tested on a rig. The logic is
  tested; the hardware path is not. **This is the honest answer: we don't yet _know_
  the 30 s works on real hardware — it needs a rig test.**

## Fixes applied (safe, gracefully-degrading)

- **R1 — Pre-roll _trim re-encode_ moved OFF the critical path.** `harvest` still
  does the fast stop+measure synchronously (which frees the mic, a hard requirement
  before the recorder opens it), but the slow trim re-encode now runs in a
  **background task**: it writes a `.part` file and atomically renames it to the
  final clip on success. `start_recording` returns immediately — the full ~0.1–1 s
  pre-roll penalty is gone from the felt start. The clip is consumed only at
  deliverable finalisation (minutes later), and `finalize_deliverable` already
  **guards on the clip existing + non-empty**, so if a recording is stopped before
  the trim finishes — or the re-encode fails — the prepend is simply skipped (the
  recording itself is untouched). The atomic rename means concat never sees a
  half-written clip. _No engine signature changes; contained to `preroll.rs`._
- **R2 — Parallelize preview-release ‖ pre-roll-harvest** (`tokio::join!`) — different
  devices (camera vs mic), no reason to serialize.
- **R3 — Cache the camera mode probe per device** (2-min TTL) — repeat video records
  skip the 200–1500 ms `ffmpeg -framerate 1000` re-probe; empty results aren't cached.
- **R4 — Reuse a freshly-warmed device enumeration on start.** The record modal warms
  the backend enumeration on open (`list_devices`); the recorder start now reuses it
  if it's younger than `RECORD_START_ENUM_MAX_AGE` (4 s) instead of re-spawning
  `ffmpeg -list_devices` (50–500 ms). Past the window it enumerates fresh, preserving
  the "don't decide on a stale list" intent — the staleness risk is bounded to a
  device plugged/unplugged in those few seconds, which the fuzzy device-match + the
  start-path timeout already tolerate.

All four are gated/graceful and keep the deliberate safety choices intact (the concat
existence-guard, the bounded freshness window). **Not yet rig-verified** — they touch
the recording-start path, which can only be confirmed on real hardware.

## Still open (needs a rig test — only you can)

- **R5 — Rig-verify pre-roll end to end** (the 30 s harvest/trim against a real mic) —
  the single biggest open question on pre-roll quality, and now also the place to
  confirm R1's background-trim + R4's warmed-enumeration behave on real hardware.
