import { t } from '../../i18n'
import { E, cssVar } from './state'
import { getLayoutGeom, secToX, effIntroDur, effOutroDur } from './geometry'
import { gainFactor } from './peaks'
import { formatTime, formatDuration } from './format'
import { isInCut, isInDrag } from './cuts'
import { shouldShowSegment } from './detection'

// ── Waveform + minimap canvas rendering ─────────────────────────────────────

export function syncCanvasSize(): void {
  if (!E.canvas) return
  const dpr = window.devicePixelRatio || 1
  const h   = 200
  E.canvas.style.height = h + 'px'
  // Read width from CSS (width: 100%) — never write canvas.style.width
  const w = E.canvas.clientWidth || E.canvas.parentElement?.getBoundingClientRect().width || 0
  if (!w) return
  E.canvas.width  = Math.round(w * dpr)
  E.canvas.height = Math.round(h * dpr)
}

/** Schedule a draw on next rAF — coalesces multiple sync requests into a
 *  single paint per frame. Use this from hot paths like mousemove/handle-drag
 *  where caller would otherwise re-trigger drawWaveform 60+ times per second.
 *  Synchronous drawWaveform() still works for one-shot updates (load/seek/etc). */
let drawWaveformRaf = 0
export function scheduleDrawWaveform(): void {
  if (drawWaveformRaf) return
  drawWaveformRaf = requestAnimationFrame(() => {
    drawWaveformRaf = 0
    drawWaveform()
  })
}

export function drawWaveform(): void {
  if (!E.canvas || !E.peaks) return
  const dpr  = window.devicePixelRatio || 1
  const ctx  = E.canvas.getContext('2d')
  if (!ctx) return
  const W    = E.canvas.width  / dpr
  const H    = E.canvas.height / dpr
  ctx.save()
  ctx.scale(dpr, dpr)

  // Background
  const surfaceColor = cssVar('--surface') || '#13131c'
  ctx.fillStyle = surfaceColor
  ctx.fillRect(0, 0, W, H)

  const RULER  = 22
  const midY   = RULER + (H - RULER) / 2
  const maxBar = (H - RULER - 10) / 2
  const ACCENT = cssVar('--accent') || '#F0BB47'
  const RED    = '#ef4444'

  drawRuler(ctx, W, H, RULER)

  // Subtle centre line
  ctx.strokeStyle = 'rgba(255,255,255,0.05)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, midY); ctx.lineTo(W, midY); ctx.stroke()

  // Current playhead time (used for "past" shading)
  const curSec = (E.isPlaying && E.isVideoFile && E.videoEl)
    ? E.videoEl.currentTime
    : (E.isPlaying && E.audioCtx)
    ? E.playStartSec + (E.audioCtx.currentTime - E.playStartCtxTime)
    : E.playStartSec

  // ── Layout: intro / main / outro regions ─────────────────────────
  const geom = getLayoutGeom(W)

  // ── Suggested segment backgrounds (only in main region) ───────────
  for (const seg of E.suggestions) {
    if (!shouldShowSegment(seg.type)) continue
    const x1 = secToX(seg.start, W), x2 = secToX(seg.end, W)
    if (x2 < geom.mainPxStart || x1 > geom.mainPxEnd) continue
    const clampX1 = Math.max(geom.mainPxStart, x1), clampX2 = Math.min(x2, geom.mainPxEnd)
    // Color by segment type:
    //   sermon  → gold (suggested keep range)
    //   speech  → light green
    //   music   → blue
    //   silence → grey
    let fillCol = 'rgba(120,120,140,0.10)'
    let strokeCol = 'rgba(120,120,140,0.4)'
    if (seg.type === 'sermon')        { fillCol = 'rgba(240,187,71,0.22)'; strokeCol = '#f0bb47' }
    else if (seg.type === 'speech')   { fillCol = 'rgba(72,187,120,0.15)'; strokeCol = '#48bb78' }
    else if (seg.type === 'music')    { fillCol = 'rgba(99,179,237,0.15)'; strokeCol = '#63b3ed' }
    else if (seg.type === 'silence')  { fillCol = 'rgba(150,150,160,0.10)'; strokeCol = 'rgba(150,150,160,0.45)' }
    ctx.fillStyle = fillCol
    ctx.fillRect(clampX1, RULER, clampX2 - clampX1, H - RULER)
    // Boundary lines
    for (const bx of [x1, x2]) {
      if (bx < geom.mainPxStart - 2 || bx > geom.mainPxEnd + 2) continue
      ctx.strokeStyle = strokeCol
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.55
      ctx.setLineDash([5, 4])
      ctx.beginPath(); ctx.moveTo(bx, RULER); ctx.lineTo(bx, H); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
    // Label inside region — show "★ Antatt preken — Nmin" for sermon
    if (clampX2 - clampX1 > 40) {
      ctx.font = '600 9px system-ui, -apple-system, sans-serif'
      ctx.textBaseline = 'top'
      ctx.fillStyle = strokeCol
      ctx.globalAlpha = 0.95
      let lbl = seg.label
      if (seg.type === 'sermon') {
        const mins = Math.round((seg.end - seg.start) / 60)
        lbl = `★ ${t('editor.sermonLabel', 'Antatt preken')} — ${mins} min`
      } else if (lbl.length > 18) lbl = lbl.slice(0, 17) + '…'
      ctx.fillText(lbl, Math.max(clampX1 + 4, geom.mainPxStart + 2), RULER + 24)
      ctx.globalAlpha = 1
    }
  }

  // ── Cut region backgrounds (clipped to main region) ───────────────
  for (const c of E.cuts) {
    const x1 = secToX(c.start, W), x2 = secToX(c.end, W)
    if (x2 < geom.mainPxStart || x1 > geom.mainPxEnd) continue
    ctx.fillStyle = 'rgba(239,68,68,0.13)'
    ctx.fillRect(
      Math.max(geom.mainPxStart, x1),
      RULER,
      Math.min(x2, geom.mainPxEnd) - Math.max(geom.mainPxStart, x1),
      H - RULER,
    )
  }

  // ── Active drag region ─────────────────────────────────────────────
  if (E.isDragging && E.dragStartSec >= 0) {
    const x1 = secToX(Math.min(E.dragStartSec, E.dragEndSec), W)
    const x2 = secToX(Math.max(E.dragStartSec, E.dragEndSec), W)
    ctx.fillStyle = 'rgba(251,146,60,0.18)'
    ctx.fillRect(x1, RULER, x2 - x1, H - RULER)
    ctx.strokeStyle = '#fb923c'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x1 + 0.5, RULER + 0.5, x2 - x1 - 1, H - RULER - 1)
  }

  // ── Intro waveform (dimmed, in left slot) ─────────────────────────
  if (geom.introPx > 0 && E.introPeaks && E.introDuration > 0) {
    const introBarMax = maxBar
    ctx.fillStyle = '#7AAAFF'
    for (let px = 0; px < geom.introPx; px++) {
      const sec = (px / geom.introPx) * E.introDuration
      const pi  = Math.floor(sec * 100)
      if (pi < 0 || pi >= E.introPeaks.length) continue
      const barH = Math.min(introBarMax, E.introPeaks[pi] * introBarMax)
      ctx.globalAlpha = 0.55
      ctx.fillRect(px, midY - barH, 1, barH * 2)
    }
    ctx.globalAlpha = 1
    // Section separator
    ctx.strokeStyle = 'rgba(122,170,255,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(geom.introPx, RULER); ctx.lineTo(geom.introPx, H); ctx.stroke()
  }

  // ── Outro waveform (dimmed, in right slot) ────────────────────────
  if (geom.outroPx > 0 && E.outroPeaks && E.outroDuration > 0) {
    const outroBarMax = maxBar
    ctx.fillStyle = '#7AAAFF'
    for (let px = 0; px < geom.outroPx; px++) {
      const sec = (px / geom.outroPx) * E.outroDuration
      const pi  = Math.floor(sec * 100)
      if (pi < 0 || pi >= E.outroPeaks.length) continue
      const barH = Math.min(outroBarMax, E.outroPeaks[pi] * outroBarMax)
      ctx.globalAlpha = 0.55
      ctx.fillRect(geom.mainPxEnd + px, midY - barH, 1, barH * 2)
    }
    ctx.globalAlpha = 1
    // Section separator
    ctx.strokeStyle = 'rgba(122,170,255,0.55)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(geom.mainPxEnd, RULER); ctx.lineTo(geom.mainPxEnd, H); ctx.stroke()
  }

  // ── Waveform bars (symmetric, mirrored above + below centre) ──────
  // Bars are scaled by the current `audioGainDb` so any peak-normalization
  // is immediately visible — same gain factor we'll apply in ffmpeg at
  // export time. Clipped to the main region (introPx <= x < mainPxEnd).
  const gFac = gainFactor()
  const mainPxStart = Math.floor(geom.mainPxStart)
  const mainPxEnd   = Math.floor(geom.mainPxEnd)
  const mainPxWidth = Math.max(1, mainPxEnd - mainPxStart)
  for (let px = mainPxStart; px < mainPxEnd; px++) {
    const sec = E.vpStart + ((px - mainPxStart) / mainPxWidth) * (E.vpEnd - E.vpStart)
    const pi  = Math.floor(sec * 100)
    if (pi < 0 || pi >= E.peaks.length) continue

    const barH  = Math.min(maxBar, E.peaks[pi] * gFac * maxBar)
    const inCut = isInCut(sec) || (E.isDragging && isInDrag(sec))
    const isPast = sec < curSec && (E.isPlaying || E.playStartSec > 0)

    ctx.fillStyle   = inCut ? RED : ACCENT
    ctx.globalAlpha = inCut ? 0.60 : isPast ? 0.30 : 0.82
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  // ── Vignette — fades bars toward top and bottom of canvas ─────────
  // Extract RGB from surface colour for vignette
  const sRgb = surfaceColor.startsWith('#')
    ? hexToRgb(surfaceColor)
    : '19,19,28'
  const vignette = ctx.createLinearGradient(0, RULER, 0, H)
  vignette.addColorStop(0,    `rgba(${sRgb},0.70)`)
  vignette.addColorStop(0.22, `rgba(${sRgb},0.0)`)
  vignette.addColorStop(0.78, `rgba(${sRgb},0.0)`)
  vignette.addColorStop(1,    `rgba(${sRgb},0.70)`)
  ctx.fillStyle = vignette
  ctx.fillRect(0, RULER, W, H - RULER)

  // ── Cut boundary lines ─────────────────────────────────────────────
  for (const c of E.cuts) {
    for (const s of [c.start, c.end]) {
      const x = secToX(s, W)
      if (x < -2 || x > W + 2) continue
      ctx.strokeStyle = RED
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.75
      ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  // ── Cut duration labels inside cut regions ─────────────────────────
  ctx.font = '600 10px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  for (const c of E.cuts) {
    const x1 = secToX(c.start, W), x2 = secToX(c.end, W)
    if (x2 - x1 < 28) continue
    const label = formatDuration(c.end - c.start)
    const cx = Math.min(Math.max((x1 + x2) / 2, x1 + 4), x2 - 4)
    // Pill background
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(239,68,68,0.22)'
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(cx - tw / 2 - 5, midY - 9, tw + 10, 18, 4)
    else ctx.rect(cx - tw / 2 - 5, midY - 9, tw + 10, 18)
    ctx.fill()
    ctx.fillStyle = '#fca5a5'
    ctx.textAlign = 'center'
    ctx.fillText(label, cx, midY)
    ctx.textAlign = 'left'
  }

  // ── Drag time labels ───────────────────────────────────────────────
  if (E.isDragging && E.dragStartSec >= 0 && Math.abs(E.dragEndSec - E.dragStartSec) > 0.05) {
    const sA = Math.min(E.dragStartSec, E.dragEndSec)
    const sB = Math.max(E.dragStartSec, E.dragEndSec)
    ctx.font = '600 11px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'alphabetic'

    for (const [sec, anchor] of [[sA, 'start'], [sB, 'end']] as [number, string][]) {
      const x = secToX(sec, W)
      const label = formatTime(sec)
      const tw = ctx.measureText(label).width
      const isLeft = anchor === 'start'
      const tx = isLeft
        ? Math.max(x + 4, 4)
        : Math.min(x - tw - 4, W - tw - 4)
      ctx.fillStyle = 'rgba(30,30,46,0.88)'
      if (ctx.roundRect) ctx.roundRect(tx - 3, RULER + 4, tw + 6, 16, 3)
      else ctx.rect(tx - 3, RULER + 4, tw + 6, 16)
      ctx.fill()
      ctx.fillStyle = '#fb923c'
      ctx.fillText(label, tx, RULER + 15)
    }
  }

  // ── Chapter markers ───────────────────────────────────────────────
  const CHAPTER_COLOR = '#06b6d4'
  for (const ch of E.meta.chapters) {
    const x = secToX(ch.time, W)
    if (x < -2 || x > W + 2) continue
    ctx.strokeStyle = CHAPTER_COLOR
    ctx.lineWidth   = 1.5
    ctx.globalAlpha = 0.85
    ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Small triangle at top
    ctx.fillStyle = CHAPTER_COLOR
    ctx.beginPath()
    ctx.moveTo(x - 4, RULER)
    ctx.lineTo(x + 4, RULER)
    ctx.lineTo(x, RULER + 7)
    ctx.closePath()
    ctx.fill()

    // Label
    ctx.font = '600 9px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'top'
    const label = ch.title.length > 14 ? ch.title.slice(0, 13) + '…' : ch.title
    const tw    = ctx.measureText(label).width
    const tx    = Math.min(Math.max(x + 3, 2), W - tw - 4)
    ctx.fillStyle = 'rgba(6,182,212,0.15)'
    if (ctx.roundRect) ctx.roundRect(tx - 2, RULER + 8, tw + 4, 13, 2)
    else ctx.rect(tx - 2, RULER + 8, tw + 4, 13)
    ctx.fill()
    ctx.fillStyle = CHAPTER_COLOR
    ctx.fillText(label, tx, RULER + 9)
    ctx.textBaseline = 'middle'
  }

  // ── Section labels ("Intro" / "Hovedopptak" / "Outro") in the ruler ──
  if (geom.introPx > 0 || geom.outroPx > 0) {
    ctx.font = '600 10px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    if (geom.introPx > 36) {
      ctx.fillStyle = '#7AAAFF'
      ctx.globalAlpha = 0.9
      const lbl = `${t('editor.tlIntro', 'Intro')} · ${formatDuration(E.introDuration)}`
      ctx.fillText(lbl, geom.introPx / 2, RULER / 2)
    }
    if (geom.outroPx > 36) {
      ctx.fillStyle = '#7AAAFF'
      ctx.globalAlpha = 0.9
      const lbl = `${t('editor.tlOutro', 'Outro')} · ${formatDuration(E.outroDuration)}`
      ctx.fillText(lbl, geom.mainPxEnd + geom.outroPx / 2, RULER / 2)
    }
    if ((geom.introPx > 36 || geom.outroPx > 36) && geom.mainPxEnd - geom.mainPxStart > 80) {
      ctx.fillStyle = ACCENT
      ctx.globalAlpha = 0.85
      const lbl = t('editor.tlMain', 'Hovedopptak')
      ctx.fillText(lbl, (geom.mainPxStart + geom.mainPxEnd) / 2, RULER / 2)
    }
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'
  }

  // ── Ghost cursor ───────────────────────────────────────────────────
  // Ghost cursor shows wherever the mouse is on the extended timeline,
  // including intro/outro slots — useful for previewing where a click will
  // place the playhead.
  const hoverX = secToX(E.hoverSec, W)
  if (E.peaks && !E.isDragging && E.hoverSec > -9999 && hoverX >= 0 && hoverX <= W) {
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(hoverX, RULER); ctx.lineTo(hoverX, H); ctx.stroke()
    ctx.setLineDash([])

    // Timestamp tooltip at bottom. Shows region-aware label so the user
    // always knows what region they're hovering over.
    let label: string
    if (E.hoverSec < 0 && effIntroDur() > 0) {
      label = `Intro ${formatTime(E.hoverSec + effIntroDur())}`
    } else if (E.hoverSec > E.duration && effOutroDur() > 0) {
      label = `Outro ${formatTime(E.hoverSec - E.duration)}`
    } else {
      label = formatTime(E.hoverSec)
    }
    const hoveredSeg = E.suggestions.find(s => E.hoverSec >= s.start && E.hoverSec <= s.end && shouldShowSegment(s.type))
    if (hoveredSeg && E.hoverSec >= 0 && E.hoverSec <= E.duration) {
      const typeLbl = hoveredSeg.type === 'sermon' ? t('editor.tooltipSermon', 'Antatt preken')
        : hoveredSeg.type === 'speech' ? t('editor.tooltipSpeech', 'Tale')
        : hoveredSeg.type === 'music'  ? t('editor.tooltipMusic',  'Musikk')
        : hoveredSeg.type === 'silence'? t('editor.tooltipSilence','Stillhet')
        : t('editor.tooltipMixed', 'Blandet')
      label = `${typeLbl} · ${formatDuration(hoveredSeg.duration)}  (${formatTime(E.hoverSec)})`
    }
    const x = hoverX
    ctx.font = '600 10px system-ui, -apple-system, sans-serif'
    ctx.textBaseline = 'middle'
    const tw = ctx.measureText(label).width
    const tx = Math.min(Math.max(x - tw / 2 - 5, 2), W - tw - 12)
    ctx.fillStyle = 'rgba(20,20,36,0.9)'
    if (ctx.roundRect) ctx.roundRect(tx, H - 22, tw + 10, 16, 4)
    else ctx.rect(tx, H - 22, tw + 10, 16)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.textAlign = 'center'
    ctx.fillText(label, tx + tw / 2 + 5, H - 14)
    ctx.textAlign = 'left'
  }

  // ── Playhead ───────────────────────────────────────────────────────
  // Playhead is shown across the extended timeline (intro/main/outro). We
  // gate on pixel position rather than viewport seconds so the triangle is
  // visible when playing through intro/outro slots.
  {
    const x = secToX(curSec, W)
    if (x >= 0 && x <= W) {
      // Glow
      ctx.shadowColor = 'rgba(255,255,255,0.6)'
      ctx.shadowBlur  = 8
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth   = 1.5
      ctx.globalAlpha = 0.95
      ctx.beginPath(); ctx.moveTo(x, RULER + 10); ctx.lineTo(x, H); ctx.stroke()
      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1

      // Triangle pointer at top
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.moveTo(x - 5, RULER)
      ctx.lineTo(x + 5, RULER)
      ctx.lineTo(x,     RULER + 9)
      ctx.closePath()
      ctx.fill()
    }
  }

  // ── Clipping indicators ────────────────────────────────────────
  if (E.clipTimes.length > 0) {
    ctx.fillStyle = '#ef4444'
    ctx.globalAlpha = 0.8
    for (const t of E.clipTimes) {
      const x = secToX(t, W)
      if (x < 0 || x > W) continue
      ctx.fillRect(x - 0.5, RULER, 1, 5)
    }
    ctx.globalAlpha = 1
  }

  // ── Cut handle hover highlights ────────────────────────────────
  if (E.hoverSec >= E.vpStart && E.hoverSec <= E.vpEnd && !E.isDragging && !E.handleDrag) {
    const threshold = (E.vpEnd - E.vpStart) / W * 10
    for (const c of E.cuts) {
      for (const side of ['start', 'end'] as const) {
        const t = c[side]
        if (Math.abs(E.hoverSec - t) < threshold) {
          const x = secToX(t, W)
          ctx.strokeStyle = '#fbbf24'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(x, RULER); ctx.lineTo(x, H); ctx.stroke()
        }
      }
    }
  }

  ctx.restore()
}

export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r},${g},${b}`
}

export function drawRuler(ctx: CanvasRenderingContext2D, W: number, H: number, RULER: number): void {
  ctx.fillStyle = '#10101a'
  ctx.fillRect(0, 0, W, RULER)
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'
  ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(0, RULER); ctx.lineTo(W, RULER); ctx.stroke()

  const geom = getLayoutGeom(W)
  const mainW = Math.max(1, geom.mainPxEnd - geom.mainPxStart)
  // Use main viewport span for tick density (not the smaller pixel-per-second
  // we'd get if we used W, which would over-tick the main region when intro/outro
  // are eating display space).
  const rawInterval  = (E.vpEnd - E.vpStart) * 80 / mainW
  // Note: tick interval ≥ 1 sec so formatTime (which rounds to whole seconds)
  // never produces duplicate labels (would render "0:05 0:05 0:06 0:06" for
  // 0.5-sec ticks on short clips).
  const intervals    = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const tickInterval = intervals.find(v => v >= rawInterval) ?? 600
  const firstTick    = Math.ceil(E.vpStart / tickInterval) * tickInterval

  ctx.font        = '500 9px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillStyle   = 'rgba(255,255,255,0.32)'

  for (let s = firstTick; s <= E.vpEnd; s += tickInterval) {
    const x = secToX(s, W)
    // Skip ticks that land inside the intro/outro slots — they'd be misleading
    // there (the wall-clock time in those slots is local to the jingle file).
    if (x < geom.mainPxStart - 1 || x > geom.mainPxEnd + 1) continue
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(x, RULER - 5); ctx.lineTo(x, RULER); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,0.32)'
    // Account for intro: show GLOBAL timeline time when intro is present
    // (so a 10s intro means main t=0 is labelled "0:10" globally).
    const globalSec = s + (geom.effIntroDur > 0 ? geom.effIntroDur : 0)
    ctx.fillText(formatTime(globalSec), x + 3, RULER / 2)
  }
}

export function drawMinimap(): void {
  if (!E.minimap || !E.peaks) return
  const dpr  = window.devicePixelRatio || 1
  const W    = E.minimap.parentElement?.clientWidth ?? 0
  if (!W) return
  const H    = 44
  E.minimap.style.width  = W + 'px'
  E.minimap.style.height = H + 'px'
  E.minimap.width  = W * dpr
  E.minimap.height = H * dpr

  const ctx  = E.minimap.getContext('2d')
  if (!ctx) return
  ctx.save()
  ctx.scale(dpr, dpr)

  ctx.fillStyle = '#0d0d16'
  ctx.fillRect(0, 0, W, H)

  const ACCENT = cssVar('--accent') || '#F0BB47'
  const midY   = H / 2

  const gFac = gainFactor()
  const maxBar = (H - 6) / 2
  for (let px = 0; px < W; px++) {
    const sec  = (px / W) * E.duration
    const pi   = Math.floor(sec * 100)
    if (pi < 0 || pi >= E.peaks.length) continue
    const barH = Math.min(maxBar, E.peaks[pi] * gFac * maxBar)
    const inCut = isInCut(sec)
    ctx.fillStyle   = inCut ? '#ef4444' : ACCENT
    ctx.globalAlpha = inCut ? 0.55 : 0.55
    ctx.fillRect(px, midY - barH, 1, barH * 2)
  }
  ctx.globalAlpha = 1

  // Vignette
  const vg = ctx.createLinearGradient(0, 0, 0, H)
  vg.addColorStop(0,   'rgba(13,13,22,0.5)')
  vg.addColorStop(0.3, 'rgba(13,13,22,0)')
  vg.addColorStop(0.7, 'rgba(13,13,22,0)')
  vg.addColorStop(1,   'rgba(13,13,22,0.5)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, W, H)

  ctx.restore()
  updateMinimapViewport()
}

export function updateMinimapViewport(): void {
  if (!E.minimapVp || !E.duration) return
  const W  = E.minimap.parentElement?.clientWidth ?? 0
  const x1 = (E.vpStart / E.duration) * W
  const x2 = (E.vpEnd   / E.duration) * W
  E.minimapVp.style.left  = x1 + 'px'
  E.minimapVp.style.width = (x2 - x1) + 'px'
}
