/**
 * RecordingWaveform — a calm, premium scrolling envelope for recording mode.
 *
 * DAW "tape" model: new audio is drawn at a FIXED playhead (~78% width) and the
 * whole history scrolls leftward, so the newest sample is always at the playhead.
 * The shape is a mirrored, filled envelope (not raw oscilloscope, not bars) with
 * two layers: a soft full-height PEAK halo and a brighter, denser RMS core.
 *
 * Data is an ENVELOPE, not PCM: per audio frame the caller pushes a (peak, rms)
 * pair (both linear 0..1). We reuse the existing VU pipeline as the single source
 * (see recording.ts → tickVU onSignal), tapped once — no second audio stream.
 *
 * Animation is decoupled from capture: a delta-time rAF loop scrolls at a
 * constant px/sec regardless of how fast buffers arrive, with sub-pixel motion,
 * an ease-out "grow in" for fresh points, Catmull-Rom smoothing, edge fades, a
 * cached bloom on loud moments, and an understated idle breath near silence.
 *
 * Zero per-frame allocation: fixed ring buffer + reused scratch arrays + cached
 * offscreen gradients/glow.
 */

interface EnvPoint {
  peak: number
  rms: number
  t: number // performance.now() ms
}

// Palette — matte amber-gold on a deep, slightly darker blue. Deliberately NO
// near-white anywhere (the core used to read as a glossy cream highlight, and the
// additive bloom blew out to white); the core tops out at a muted amber so loud
// moments stay warm and matte instead of shiny.
const BG_TOP = '#12305C'
const BG_BOTTOM = '#0B2142'
const RGB_PEAK = '198,148,58' // muted gold
const RGB_CORE_CENTER = '226,178,96' // amber (not cream-white)
const RGB_CORE_EDGE = '176,128,54' // darker gold edge
const RGB_PLAYHEAD = '224,184,108' // soft amber, not white
const RGB_GLOW = '224,176,92' // gold haze for the (now subtle) bloom

export class RecordingWaveform {
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D

  private dpr = 1
  private w = 0 // device px
  private h = 0 // device px

  // Tuning (CSS-px units where spatial; converted to device px via dpr).
  private readonly pxPerSecCss = 74
  private readonly playheadFrac = 0.78
  private readonly growMs = 100
  private readonly minStepCss = 0.9 // light decimation of the outline
  private readonly idleEnter = 0.07 // rms below this → idle breath fades in
  private readonly bloomThresh = 0.62 // core level above which the (subtle) bloom kicks in

  // Ring buffer of envelope points.
  private readonly cap = 4096
  private readonly ring: EnvPoint[]
  private head = 0
  private size = 0

  // Reused outline scratch (top edge L→R, then bottom edge R→L = closed loop).
  private readonly ox: Float32Array
  private readonly oy: Float32Array

  // Animation.
  private running = false
  private rafId = 0

  // Cached offscreen art (rebuilt on resize).
  private bg: HTMLCanvasElement | null = null
  private fadeL: HTMLCanvasElement | null = null
  private fadeR: HTMLCanvasElement | null = null
  private glow: HTMLCanvasElement | null = null
  private peakGrad: CanvasGradient | null = null
  private coreGrad: CanvasGradient | null = null

  private readonly ro: ResizeObserver

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) throw new Error('2D canvas context unavailable')
    this.ctx = ctx
    this.ring = new Array<EnvPoint>(this.cap)
    for (let i = 0; i < this.cap; i++) this.ring[i] = { peak: 0, rms: 0, t: 0 }
    this.ox = new Float32Array(this.cap * 2 + 4)
    this.oy = new Float32Array(this.cap * 2 + 4)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
    this.resize()
  }

  /** Push one envelope sample. peak/rms are linear 0..1; rms is clamped ≤ peak. */
  push(peak: number, rms: number): void {
    const p = this.ring[this.head]
    const pk = peak < 0 ? 0 : peak > 1 ? 1 : peak
    let rm = rms < 0 ? 0 : rms > 1 ? 1 : rms
    if (rm > pk) rm = pk
    p.peak = pk
    p.rms = rm
    p.t = performance.now()
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
  }

  start(): void {
    if (this.running) return
    this.running = true
    const loop = (): void => {
      if (!this.running) return
      this.draw(performance.now())
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  /** Freeze in place (recording stopped/paused) — keeps the last frame on screen. */
  stop(): void {
    this.running = false
    if (this.rafId) {
      cancelAnimationFrame(this.rafId)
      this.rafId = 0
    }
  }

  /** Tear down the rAF loop + observers. */
  destroy(): void {
    this.stop()
    this.ro.disconnect()
  }

  // ── Sizing + cached art ────────────────────────────────────────────────────

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect()
    const cssW = Math.max(1, Math.round(rect.width))
    const cssH = Math.max(1, Math.round(rect.height))
    this.dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    const w = Math.round(cssW * this.dpr)
    const h = Math.round(cssH * this.dpr)
    if (w === this.w && h === this.h) return
    this.w = w
    this.h = h
    this.canvas.width = w
    this.canvas.height = h
    this.buildCaches()
  }

  private buildCaches(): void {
    const { w, h } = this

    // Background — subtle vertical gradient.
    const bg = document.createElement('canvas')
    bg.width = w
    bg.height = h
    const bgx = bg.getContext('2d')
    if (bgx) {
      const g = bgx.createLinearGradient(0, 0, 0, h)
      g.addColorStop(0, BG_TOP)
      g.addColorStop(1, BG_BOTTOM)
      bgx.fillStyle = g
      bgx.fillRect(0, 0, w, h)
    }
    this.bg = bg

    // Peak halo gradient — soft, strongest at the centre line, fading to edges.
    const pg = this.ctx.createLinearGradient(0, 0, 0, h)
    pg.addColorStop(0, `rgba(${RGB_PEAK},0.03)`)
    pg.addColorStop(0.5, `rgba(${RGB_PEAK},0.24)`)
    pg.addColorStop(1, `rgba(${RGB_PEAK},0.03)`)
    this.peakGrad = pg

    // RMS core gradient — amber centre → darker gold edges. Lower opacity + no
    // white so it reads matte rather than as a glossy highlight.
    const cg = this.ctx.createLinearGradient(0, 0, 0, h)
    cg.addColorStop(0, `rgba(${RGB_CORE_EDGE},0.58)`)
    cg.addColorStop(0.42, `rgba(${RGB_CORE_CENTER},0.82)`)
    cg.addColorStop(0.5, `rgba(${RGB_CORE_CENTER},0.86)`)
    cg.addColorStop(0.58, `rgba(${RGB_CORE_CENTER},0.82)`)
    cg.addColorStop(1, `rgba(${RGB_CORE_EDGE},0.58)`)
    this.coreGrad = cg

    // Edge fades — cached strips of the bg with a horizontal alpha ramp, stamped
    // over the waveform so it dissolves smoothly instead of hard-cutting.
    const fadeW = Math.round(this.dpr * 64)
    this.fadeL = this.buildFade(fadeW, h, true)
    this.fadeR = this.buildFade(Math.round(this.dpr * 90), h, false)

    // Bloom sprite — a soft radial glow, stamped additively at loud moments and
    // along the playhead (avoids per-frame shadowBlur).
    const gr = Math.round(this.dpr * 60)
    const glow = document.createElement('canvas')
    glow.width = gr * 2
    glow.height = gr * 2
    const gx = glow.getContext('2d')
    if (gx) {
      const rg = gx.createRadialGradient(gr, gr, 0, gr, gr, gr)
      rg.addColorStop(0, `rgba(${RGB_GLOW},0.45)`)
      rg.addColorStop(0.4, `rgba(${RGB_GLOW},0.14)`)
      rg.addColorStop(1, `rgba(${RGB_GLOW},0)`)
      gx.fillStyle = rg
      gx.fillRect(0, 0, gr * 2, gr * 2)
    }
    this.glow = glow
  }

  private buildFade(fw: number, h: number, left: boolean): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = fw
    c.height = h
    const x = c.getContext('2d')
    if (x && this.bg) {
      // Copy the matching bg slice so the fade colour matches the background.
      x.drawImage(this.bg, left ? 0 : this.w - fw, 0, fw, h, 0, 0, fw, h)
      // Mask it with a horizontal alpha ramp: opaque at the outer edge → clear.
      const g = x.createLinearGradient(0, 0, fw, 0)
      if (left) {
        g.addColorStop(0, 'rgba(0,0,0,1)')
        g.addColorStop(1, 'rgba(0,0,0,0)')
      } else {
        g.addColorStop(0, 'rgba(0,0,0,0)')
        g.addColorStop(1, 'rgba(0,0,0,0.85)')
      }
      x.globalCompositeOperation = 'destination-in'
      x.fillStyle = g
      x.fillRect(0, 0, fw, h)
    }
    return c
  }

  // ── Frame ───────────────────────────────────────────────────────────────────

  private static easeOut(x: number): number {
    if (x <= 0) return 0
    if (x >= 1) return 1
    const inv = 1 - x
    return 1 - inv * inv * inv
  }

  private draw(now: number): void {
    const { ctx, w, h } = this
    if (w === 0 || h === 0) return
    const cy = h / 2
    const playheadX = Math.round(w * this.playheadFrac) + 0.5
    const pxPerMs = (this.pxPerSecCss * this.dpr) / 1000
    const maxAmp = h * 0.46 // leave a little breathing room top/bottom
    const minStep = this.minStepCss * this.dpr

    // Background.
    if (this.bg) ctx.drawImage(this.bg, 0, 0)
    else {
      ctx.clearRect(0, 0, w, h)
    }

    // Gather visible points newest→oldest, decimated to ~1 per minStep, keeping
    // the loudest peak within each step so transients survive.
    // We walk the ring backwards from the most recent sample.
    const count = this.size
    // Estimate overall loudness for the idle-breath blend.
    let loud = 0

    // Build top/bottom outline for peak (halo) and remember core amps per column.
    // We assemble columns left→right, so first collect into temp via the ring.
    // To avoid allocation we write directly into ox/oy in two passes.
    let cols = 0
    // temp parallel data for core (reuse oy beyond outline? simpler: store in
    // typed scratch via closures — but we keep zero-alloc by reusing ring math).
    // We store column x + peakAmp + coreAmp into the first part of ox/oy and a
    // parallel core array; to stay alloc-free we keep a persistent core buffer.
    if (!this.colX || this.colX.length < this.cap + 4) {
      this.colX = new Float32Array(this.cap + 4)
      this.colPeak = new Float32Array(this.cap + 4)
      this.colCore = new Float32Array(this.cap + 4)
    }
    const colX = this.colX as Float32Array
    const colPeak = this.colPeak as Float32Array
    const colCore = this.colCore as Float32Array

    let lastX = Infinity
    for (let i = 0; i < count; i++) {
      const idx = (this.head - 1 - i + this.cap * 2) % this.cap
      const p = this.ring[idx]
      const age = now - p.t
      const x = playheadX - age * pxPerMs
      if (x < -minStep) break // older than the visible window
      if (x > playheadX) continue
      const grow = RecordingWaveform.easeOut(age / this.growMs)
      const pk = p.peak * grow
      const rm = p.rms * grow
      // Decimate: only start a new column when we've moved left by minStep;
      // otherwise merge into the current column, keeping the louder values.
      if (lastX - x < minStep && cols > 0) {
        const c = cols - 1
        if (pk > colPeak[c]) colPeak[c] = pk
        if (rm > colCore[c]) colCore[c] = rm
        continue
      }
      colX[cols] = x
      colPeak[cols] = pk
      colCore[cols] = rm
      if (p.rms > loud) loud = p.rms
      lastX = x
      cols++
    }

    if (cols >= 2) {
      // Idle breath: when quiet, add an extremely subtle moving baseline so the
      // line never looks frozen. Fades out as soon as real signal arrives.
      const quiet = loud < this.idleEnter ? 1 - loud / this.idleEnter : 0
      if (quiet > 0) {
        const amp = 0.05 * quiet
        for (let c = 0; c < cols; c++) {
          const breath = 0.5 + 0.5 * Math.sin(now * 0.0016 + colX[c] * 0.012)
          const add = amp * breath
          colPeak[c] = Math.min(1, colPeak[c] + add)
          colCore[c] = Math.min(1, colCore[c] + add * 0.6)
        }
      }

      // Columns were collected newest→oldest (right→left); reverse to left→right.
      // Reverse in place.
      for (let a = 0, b = cols - 1; a < b; a++, b--) {
        const tx = colX[a]
        colX[a] = colX[b]
        colX[b] = tx
        const tp = colPeak[a]
        colPeak[a] = colPeak[b]
        colPeak[b] = tp
        const tc = colCore[a]
        colCore[a] = colCore[b]
        colCore[b] = tc
      }

      // PEAK halo.
      this.fillEnvelope(colX, colPeak, cols, cy, maxAmp, this.peakGrad)
      // RMS core.
      this.fillEnvelope(colX, colCore, cols, cy, maxAmp, this.coreGrad)

      // Bloom — stamp the cached glow at loud core columns (additive).
      if (this.glow) {
        const gw = this.glow.width
        ctx.globalCompositeOperation = 'lighter'
        for (let c = 0; c < cols; c++) {
          const v = colCore[c]
          if (v < this.bloomThresh) continue
          const intensity = (v - this.bloomThresh) / (1 - this.bloomThresh)
          // Much smaller + dimmer than before: a faint warm haze on loud moments,
          // not a white blow-out.
          const s = gw * (0.35 + intensity * 0.45)
          ctx.globalAlpha = 0.05 + intensity * 0.13
          ctx.drawImage(this.glow, colX[c] - s / 2, cy - s / 2, s, s)
        }
        ctx.globalAlpha = 1
        ctx.globalCompositeOperation = 'source-over'
      }
    }

    // Centre line.
    ctx.strokeStyle = 'rgba(214,172,98,0.22)'
    ctx.lineWidth = Math.max(1, this.dpr * 0.6)
    ctx.beginPath()
    ctx.moveTo(0, cy + 0.5)
    ctx.lineTo(w, cy + 0.5)
    ctx.stroke()

    // Edge fades (dissolve old waveform on the left, soften the future gap right).
    if (this.fadeL) ctx.drawImage(this.fadeL, 0, 0)
    if (this.fadeR) ctx.drawImage(this.fadeR, w - this.fadeR.width, 0)

    // Playhead — crisp line + soft glow.
    if (this.glow) {
      const gw = this.glow.width * 0.6
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.2
      ctx.drawImage(this.glow, playheadX - gw / 2, 0, gw, h)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.strokeStyle = `rgba(${RGB_PLAYHEAD},0.85)`
    ctx.lineWidth = Math.max(1.5, this.dpr * 1.1)
    ctx.beginPath()
    ctx.moveTo(playheadX, h * 0.06)
    ctx.lineTo(playheadX, h * 0.94)
    ctx.stroke()
  }

  // Fill a smooth, mirrored envelope around cy using Catmull-Rom interpolation.
  private fillEnvelope(
    xs: Float32Array,
    amps: Float32Array,
    n: number,
    cy: number,
    maxAmp: number,
    grad: CanvasGradient | null,
  ): void {
    if (n < 2 || !grad) return
    const ox = this.ox
    const oy = this.oy
    // Outline = top edge L→R then bottom edge R→L (closed).
    let m = 0
    for (let i = 0; i < n; i++) {
      ox[m] = xs[i]
      oy[m] = cy - amps[i] * maxAmp
      m++
    }
    for (let i = n - 1; i >= 0; i--) {
      ox[m] = xs[i]
      oy[m] = cy + amps[i] * maxAmp
      m++
    }
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(ox[0], oy[0])
    // Catmull-Rom through the closed outline → cubic beziers (gently flowing).
    for (let i = 0; i < m; i++) {
      const p0 = (i - 1 + m) % m
      const p1 = i
      const p2 = (i + 1) % m
      const p3 = (i + 2) % m
      const cp1x = ox[p1] + (ox[p2] - ox[p0]) / 6
      const cp1y = oy[p1] + (oy[p2] - oy[p0]) / 6
      const cp2x = ox[p2] - (ox[p3] - ox[p1]) / 6
      const cp2y = oy[p2] - (oy[p3] - oy[p1]) / 6
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ox[p2], oy[p2])
    }
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
  }

  // Persistent column scratch (lazily sized in draw()).
  private colX: Float32Array | null = null
  private colPeak: Float32Array | null = null
  private colCore: Float32Array | null = null
}
