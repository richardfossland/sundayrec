# Editor port — Electron → Tauri (faithful frontend port)

## Why

The Tauri editor ("Rediger") is visibly broken: it shows **"No waveform yet"** even
with an audio file loaded, the trim UI is text-field-only, and there is no real
playback / cut / interaction. The old Electron app (v4.54.5) had a rich, robust
waveform editor. Richard's directive: **port the Electron editor frontend wholesale,
make it as good or better, take bold choices, fix backend later.**

## Root cause of the broken waveform

The Electron editor and the Tauri editor get their waveform from fundamentally
different places:

|            | Electron (works)                                                                                       | Tauri (broken)                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Peak data  | Computed **in the renderer** — `decodeAudioData()` → pure-JS 100 Hz peak loop (`editor/peaks.ts`)      | Backend `editor_peaks` ffmpeg command returns `[]`/`null` → empty state |
| Playback   | Web Audio `AudioBufferSourceNode` from the same in-memory buffer, schedules keep-segments to skip cuts | HTML `<audio>` element, no cut-skip                                     |
| Dependency | **None** — self-sufficient once bytes are read                                                         | Hard dependency on an ffmpeg sidecar that fails silently                |

The Tauri app's `assetProtocol.scope` is `["**"]`, so `convertFileSrc(path)` + `fetch()`

- `decodeAudioData()` reproduces the Electron approach exactly — **no backend needed
  for the waveform or playback.** Export stays on the existing Rust `editor_export` seam.

## Architecture (the tough call)

Replace the React-Query/SVG-bar `EditScreen.tsx` with a **faithful port of the
Electron canvas editor**, structured as a framework-agnostic engine + a thin React shell:

```
src/features/editor/engine/
  types.ts        EditorState (mirrors Electron `E`), Cut, Suggestion
  format.ts       formatTime / formatDuration         (verbatim from Electron)
  peaks.ts        computePeaks / computePeakGain / gainFactor (verbatim)
  geometry.ts     getLayoutGeom / secToX / xToSec …    (verbatim, state-param)
  cuts.ts         addCut / getKeepSegs / undo / redo   (verbatim, state-param)
  render.ts       drawWaveform / drawMinimap / ruler   (verbatim Canvas2D)
  EditorEngine.ts the class: owns state + canvas + Web Audio + input + playback
src/design/screens/EditScreen.tsx   React shell (canvas ref + chrome + export)
```

The engine ports the Electron `editor/` modules near-verbatim (the only changes:
`$('id')` DOM lookups → engine state + `onChange` events; `window.api.*` IPC →
`convertFileSrc`/`invoke`). Canvas drawing code is copied line-for-line — same colours,
geometry, intro/outro slots, ruler, playhead, cut overlays.

## Progress (branch `feat/editor-port`)

- ✅ **Phase 1** `45c9446` — engine + waveform + playback + cuts + normalize + export
- ✅ **Phase 2 (part)** `fc0d8ae` metadata `.meta` sidecar · `e7fa1b4` cut-draft crash recovery
- ✅ **Phase 3 (part)** `2aae94f` segment detection + auto-trim-to-sermon · `48bbdab` mastering presets + LUFS analysis
- ⏳ **Remaining**: intro/outro (display+playback done in engine; **export support pending backend** — deferred); video variant (needs `<video>` + frame scrub); i18n (thread `t()` + 7 locales + parity test); remove orphaned `editor.helpers.ts`/`editorGeometry.ts`.

## Phases

- **Phase 1 — Waveform + playback + cuts (the core).** Engine class, client-side peaks
  via Web Audio, canvas render, zoom/pan/minimap, click-to-seek, drag-to-cut, cut
  handles, cut list, undo/redo, Web Audio playback with preview (skip cuts), keyboard
  (Space/Tab/P/⌘Z), normalize (peak-gain) UI. **Fixes the visible bug.** Export wired
  to `editor_export` with the real cut plan.
- **Phase 2 — Intro/Outro + metadata + draft persistence.** Intro/outro buffers +
  dimmed timeline slots + extended-timeline playback; metadata form (title/speaker/
  description) on `.meta` sidecar; cut-draft autosave/restore on `.cuts-draft`.
- **Phase 3 — Segment detection + mastering.** Auto-detect speech/music/silence/sermon
  (wire `editor_segments`), snap-to-boundary, auto-trim banner; mastering presets +
  LUFS analyze + preview + apply (wire `editor_mastering_analyze`/`_master_*`).
- **Phase 4 — Video variant + chapters + transcript.** Video element + frame scrub
  (`media://`/asset), chapter markers, transcript panel + Whisper.
- **Phase 5 — Polish & parity sweep.** i18n keys across all 7 locales (+ parity test),
  thumbnail panel, Stage chapters, full keyboard map, vitest for pure modules.

## Verification per phase

`npm run check` green (format/lint/tsc/vitest/clippy/rust-test) after each phase.
Manual rig smoke-test by Richard: open a real recording in Rediger → waveform renders
→ play/scrub → drag a cut → preview skips it → export produces a trimmed file.
