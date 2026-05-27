/**
 * Overlay compositor — turns OverlayConfig[] into ffmpeg input args + a
 * filter_complex chain that composes them on top of the camera video.
 *
 * Design constraints driven by `streamer.ts`:
 *   • Camera capture must stay in the same ffmpeg process (avfoundation locks
 *     the device, so we can't have two ffmpegs reading the same camera).
 *   • The base graph already needs `split=2` so a 0.5 fps preview JPG drops
 *     out alongside the main encode. Overlay composition has to happen on the
 *     stream branch BEFORE the split.
 *   • Each overlay becomes one additional `-i` input. We hand back the input
 *     args, the filter graph fragments (one chain per overlay + the final
 *     compose chain), and the input index assigned to each overlay so the
 *     caller can map streams correctly.
 *
 * The compose chain works like:
 *
 *   [0:v]                                                    → base
 *   [1:v] crop?, scale, chromakey?, format=rgba, alpha[ov1]  → first overlay
 *   [2:v] ...                                          [ov2] → second overlay
 *   [0:v][ov1] overlay=X1:Y1[c1]
 *   [c1][ov2]  overlay=X2:Y2[v_composed]
 *
 * The caller renames the last label to whatever it needs ("v_composed" here)
 * and feeds it into its existing split/preview pipeline.
 *
 * Why a separate module? `streamer.ts` is already 443 lines; this keeps the
 * filter-graph math testable in isolation. The exported `buildOverlayPipeline`
 * is a pure function: given (overlays, baseW, baseH) it returns deterministic
 * input args + filter chain. That makes unit-testing exhaustive without
 * needing to spawn ffmpeg.
 */

import path from 'path'
import fs from 'fs'
import type { OverlayConfig, OverlayPosition } from '../types'

// ─── Public types ────────────────────────────────────────────────────────────

export interface OverlayPipeline {
  /** ffmpeg `-i …` argument groups, one per enabled overlay. Caller appends
   *  these after the camera input args. */
  inputArgs: string[]
  /** Filter graph fragments separated by ';'. Empty when no overlays. */
  filterChain: string
  /** Output label name to be consumed by the caller's downstream chain.
   *  When no overlays are enabled, equals the original `baseLabel`. */
  outputLabel: string
  /** Number of additional inputs added to ffmpeg (= number of enabled
   *  overlays). Caller uses this to compute audio input mapping on Mac
   *  (`0:a?` is unchanged) and to know how many video inputs were consumed. */
  extraInputCount: number
}

export interface BuildOverlayOpts {
  /** Output video width — overlay positions are computed against this. */
  outputW: number
  outputH: number
  /** Label for the camera video stream coming in. Usually "0:v". */
  baseLabel: string
  /** Framerate the base stream runs at — used so static images and screen
   *  capture sources match cadence. */
  framerate: number
  /** Platform — affects screen capture input args. Defaults to process.platform. */
  platform?: NodeJS.Platform
}

// ─── Build pipeline ──────────────────────────────────────────────────────────

const POSITION_EXPR: Record<Exclude<OverlayPosition, 'custom'>, { x: string; y: string; scaleW?: string }> = {
  // x:y are ffmpeg overlay expressions. W/H are main video; w/h are overlay.
  // "(W-w)/2" centers horizontally, "H-h-MARGIN" pins to bottom etc.
  tl:         { x: 'MARGIN',        y: 'MARGIN' },
  tc:         { x: '(W-w)/2',       y: 'MARGIN' },
  tr:         { x: 'W-w-MARGIN',    y: 'MARGIN' },
  cl:         { x: 'MARGIN',        y: '(H-h)/2' },
  c:          { x: '(W-w)/2',       y: '(H-h)/2' },
  cr:         { x: 'W-w-MARGIN',    y: '(H-h)/2' },
  bl:         { x: 'MARGIN',        y: 'H-h-MARGIN' },
  bc:         { x: '(W-w)/2',       y: 'H-h-MARGIN' },
  br:         { x: 'W-w-MARGIN',    y: 'H-h-MARGIN' },
  fullscreen: { x: '0',             y: '0',         scaleW: 'W' },
}

/** Margin in pixels for non-fullscreen presets — kept proportional to output
 *  height so 1080p doesn't look too cramped at the corners. */
function marginPx(outputH: number): number {
  return Math.round(outputH * 0.03)  // ~32 px @ 1080p, ~22 @ 720p
}

/**
 * Build the overlay portion of the ffmpeg pipeline.
 *
 * Returns:
 *   • inputArgs   — additional `-f … -i …` flags to append after the camera
 *   • filterChain — filter_complex fragment (no leading ';')
 *   • outputLabel — name of the final composed stream label
 *   • extraInputCount — for input-index bookkeeping on the caller side
 *
 * Throws on invalid config (missing source path that should exist, etc.) so
 * the caller can surface a friendly error to the user before spawning ffmpeg.
 */
export function buildOverlayPipeline(
  overlays: OverlayConfig[],
  opts:     BuildOverlayOpts,
): OverlayPipeline {
  const enabled = (overlays ?? []).filter(o => o.enabled && isSupportedType(o.type))

  if (enabled.length === 0) {
    return {
      inputArgs:       [],
      filterChain:     '',
      outputLabel:     opts.baseLabel,
      extraInputCount: 0,
    }
  }

  const platform = opts.platform ?? process.platform
  const inputArgs:    string[] = []
  const formatChains: string[] = []
  const composeSteps: string[] = []

  let currentLabel = opts.baseLabel
  // ffmpeg input indices for overlays start at 1 because the camera is 0.
  // On Windows, dshow audio is also "1:a" — but we map audio explicitly in
  // streamer.ts via the device-name, so the new -i for overlays does not
  // clash with audio mapping. Streamer must use 0:a? on Mac, and the dshow
  // audio device (named, not indexed) on Windows.
  let inputIdx = 1

  for (let i = 0; i < enabled.length; i++) {
    const ov = enabled[i]
    const { args, fragment, outLabel } = buildOneOverlay(ov, inputIdx, opts, platform)
    inputArgs.push(...args)
    formatChains.push(fragment)

    const composedLabel = `vov${i}`
    const { xExpr, yExpr } = resolvePosition(ov, opts.outputH)
    // shortest=0 + eof_action=pass: overlay can be a finite stream (image
    // file) without truncating the camera. repeatlast=1 keeps last frame
    // visible if the overlay stream ends.
    composeSteps.push(
      `[${currentLabel}][${outLabel}]overlay=${xExpr}:${yExpr}:eof_action=pass:shortest=0:repeatlast=1[${composedLabel}]`
    )
    currentLabel = composedLabel
    inputIdx++
  }

  const filterChain = [...formatChains, ...composeSteps].join(';')

  return {
    inputArgs,
    filterChain,
    outputLabel:     currentLabel,
    extraInputCount: enabled.length,
  }
}

// ─── Per-overlay builder ─────────────────────────────────────────────────────

interface OneOverlayResult {
  args:     string[]
  fragment: string  // filter chain that produces [outLabel]
  outLabel: string
}

function buildOneOverlay(
  ov:       OverlayConfig,
  inputIdx: number,
  opts:     BuildOverlayOpts,
  platform: NodeJS.Platform,
): OneOverlayResult {
  const args = buildInputArgs(ov, opts, platform)
  const outLabel = `ov${inputIdx}`

  // Filter chain for this overlay: crop? → scale → chromakey? → opacity → format
  const steps: string[] = []
  const inLabel = `${inputIdx}:v`
  let cursor = inLabel

  if (ov.crop && validCrop(ov.crop)) {
    // crop=W:H:X:Y using in_w/in_h as multipliers (fractions of source)
    const { x, y, w, h } = ov.crop
    steps.push(`[${cursor}]crop=iw*${fmtNum(w)}:ih*${fmtNum(h)}:iw*${fmtNum(x)}:ih*${fmtNum(y)}[${cursor}c${inputIdx}]`)
    cursor = `${cursor}c${inputIdx}`
  }

  // Scale: fullscreen → match output dims. Otherwise → fraction of output width,
  // height auto-scaled preserving aspect (-1 in ffmpeg, must be even → -2).
  const scaleFrac = ov.position === 'fullscreen' ? 1.0 : clamp01(ov.scale ?? 0.3)
  const targetW   = Math.round(opts.outputW * scaleFrac)
  // -2 forces even number for libx264.
  const scaleH    = ov.position === 'fullscreen' ? String(opts.outputH) : '-2'
  steps.push(`[${cursor}]scale=${targetW}:${scaleH}[${cursor}s]`)
  cursor = `${cursor}s`

  // Chroma key. Apply BEFORE opacity blending so transparent keyed pixels
  // don't pick up the opacity-reduction multiplier on alpha=0 anyway.
  if (ov.chromaKey && ov.chromaKey.color) {
    const c = normalizeHex(ov.chromaKey.color)
    const sim = clamp01(ov.chromaKey.similarity ?? 0.1)
    const blend = clamp01(ov.chromaKey.blend ?? 0.1)
    steps.push(`[${cursor}]chromakey=${c}:${fmtNum(sim)}:${fmtNum(blend)}[${cursor}k]`)
    cursor = `${cursor}k`
  }

  // Opacity via format=rgba + colorchannelmixer aa.
  // Skip the no-op when opacity is fully opaque to keep the graph minimal.
  const op = clamp01(ov.opacity ?? 1.0)
  if (op < 0.999) {
    steps.push(`[${cursor}]format=rgba,colorchannelmixer=aa=${fmtNum(op)}[${cursor}a]`)
    cursor = `${cursor}a`
  } else {
    // Ensure final overlay carries an alpha plane so chroma transparency
    // survives the overlay filter — chromakey already added alpha, but
    // non-chroma overlays at full opacity still need format=rgba so the
    // overlay filter handles them uniformly.
    if (!ov.chromaKey) {
      steps.push(`[${cursor}]format=rgba[${cursor}f]`)
      cursor = `${cursor}f`
    }
  }

  // Rename final cursor to the requested out label.
  steps.push(`[${cursor}]null[${outLabel}]`)

  return { args, fragment: steps.join(';'), outLabel }
}

// ─── Input-args per source type ──────────────────────────────────────────────

function buildInputArgs(
  ov:       OverlayConfig,
  opts:     BuildOverlayOpts,
  platform: NodeJS.Platform,
): string[] {
  switch (ov.type) {
    case 'image':
      return buildImageInputArgs(ov, opts.framerate)
    case 'screen':
    case 'window':
      return buildScreenInputArgs(ov, opts, platform)
    case 'ndi':
      // NDI receiver is not in v1. The caller filters out 'ndi' overlays
      // before reaching here via isSupportedType(). Defensive throw so a
      // misuse is loud rather than silent.
      throw new Error(`overlay-ndi-not-implemented: ${ov.name}`)
  }
}

function buildImageInputArgs(ov: OverlayConfig, framerate: number): string[] {
  if (!ov.source || !fs.existsSync(ov.source)) {
    throw new Error(`overlay-image-not-found:${ov.id}:${ov.source ?? ''}`)
  }
  // -loop 1: keep producing frames from the still image so the overlay stays
  // visible for the whole stream.
  return [
    '-loop', '1',
    '-framerate', String(framerate),
    '-i', ov.source,
  ]
}

function buildScreenInputArgs(
  ov:       OverlayConfig,
  opts:     BuildOverlayOpts,
  platform: NodeJS.Platform,
): string[] {
  // The `source` field encodes the platform-specific capture target.
  // On Mac: avfoundation screen index, encoded as "screen:<idx>" or just
  // "<idx>" (we accept both). On Windows: "desktop" for the primary display
  // (gdigrab full-desktop capture); future enhancement could pass a specific
  // window title via "title=<NAME>".
  if (platform === 'darwin') {
    const idx = parseScreenIdx(ov.source)
    if (idx == null) throw new Error(`overlay-bad-screen-id:${ov.id}:${ov.source ?? ''}`)
    return [
      '-f', 'avfoundation',
      '-framerate', String(opts.framerate),
      '-capture_cursor', '0',
      '-i', `${idx}:none`,
    ]
  }
  if (platform === 'win32') {
    // gdigrab supports the full desktop or a specific window title.
    const target = (ov.source || 'desktop').trim()
    const isWindowTitle = target.toLowerCase().startsWith('title=')
    const inputSpec = isWindowTitle ? target : 'desktop'
    return [
      '-f', 'gdigrab',
      '-framerate', String(opts.framerate),
      '-draw_mouse', '0',
      '-i', inputSpec,
    ]
  }
  // Linux fallback (untested in the app today — kept for completeness).
  return [
    '-f', 'x11grab',
    '-framerate', String(opts.framerate),
    '-i', ov.source || ':0.0',
  ]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isSupportedType(t: OverlayConfig['type']): boolean {
  // NDI lands in a follow-up release; image/screen/window ship in v1.
  return t === 'image' || t === 'screen' || t === 'window'
}

function resolvePosition(ov: OverlayConfig, outputH: number): { xExpr: string; yExpr: string } {
  const MARGIN = marginPx(outputH)
  if (ov.position === 'custom') {
    const x = clamp01(ov.customX ?? 0)
    const y = clamp01(ov.customY ?? 0)
    return { xExpr: `W*${fmtNum(x)}`, yExpr: `H*${fmtNum(y)}` }
  }
  const preset = POSITION_EXPR[ov.position] ?? POSITION_EXPR['tl']
  return {
    xExpr: preset.x.replace(/MARGIN/g, String(MARGIN)),
    yExpr: preset.y.replace(/MARGIN/g, String(MARGIN)),
  }
}

function parseScreenIdx(s: string): number | null {
  if (!s) return null
  // Accept "0", "screen:0", "screen:0:0", "1" etc — first integer wins.
  const m = /(\d+)/.exec(s)
  return m ? parseInt(m[1], 10) : null
}

function normalizeHex(c: string): string {
  // ffmpeg chromakey accepts 0xRRGGBB or #RRGGBB. Normalise to 0xRRGGBB to
  // dodge shell-quoting issues across platforms.
  const s = c.trim().replace(/^#/, '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return '0x000000'
  return `0x${s.toUpperCase()}`
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** Format a number for ffmpeg expressions: avoid scientific notation, 4 dp. */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0'
  // Round to 4 dp then strip trailing zeros so "0.1000" → "0.1"
  const fixed = n.toFixed(4)
  return fixed.replace(/\.?0+$/, '') || '0'
}

function validCrop(c: { x: number; y: number; w: number; h: number }): boolean {
  return (
    Number.isFinite(c.x) && Number.isFinite(c.y) &&
    Number.isFinite(c.w) && Number.isFinite(c.h) &&
    c.w > 0 && c.h > 0 &&
    c.x >= 0 && c.y >= 0 &&
    c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001
  )
}

// Re-export the source-resolution helper for index.ts (used by the IPC handler
// that lists available screens / windows for the overlay UI).
export function isOverlayTypeImplemented(t: string): boolean {
  return t === 'image' || t === 'screen' || t === 'window'
}

// ─── Source discovery helpers (used by the IPC layer) ────────────────────────

/**
 * Best-effort guess of an overlay's source identifier validity. Used by the
 * UI so it can flag a stale config (e.g. a saved screen id that no longer
 * exists) without trying to spawn ffmpeg.
 */
export function overlaySourceLooksValid(ov: OverlayConfig): boolean {
  if (!ov.source) return false
  if (ov.type === 'image') return fs.existsSync(ov.source)
  if (ov.type === 'screen' || ov.type === 'window') return parseScreenIdx(ov.source) != null || ov.source === 'desktop' || ov.source.startsWith('title=')
  if (ov.type === 'ndi') return ov.source.length > 0
  return false
}

/** Resolves a relative overlay-image source to an absolute path under the
 *  given assets dir, mirroring how the thumbnail picker stores files under
 *  userData. Callers should normalise to absolute before persisting. */
export function resolveOverlayImagePath(source: string, assetsDir: string): string {
  if (!source) return ''
  if (path.isAbsolute(source)) return source
  return path.join(assetsDir, source)
}
