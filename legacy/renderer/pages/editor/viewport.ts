import { E } from './state'
import { drawWaveform, updateMinimapViewport } from './waveform'

// ── Viewport (zoom / pan / fit) ─────────────────────────────────────────────

export function fitAll(): void {
  E.vpStart = 0
  E.vpEnd   = E.duration || 1
}

export function zoomBy(factor: number): void {
  const center = (E.vpStart + E.vpEnd) / 2
  const half   = ((E.vpEnd - E.vpStart) * factor) / 2
  E.vpStart = Math.max(0, center - half)
  E.vpEnd   = Math.min(E.duration, center + half)
  const minSpan = 0.5
  if (E.vpEnd - E.vpStart < minSpan) {
    const mid = (E.vpStart + E.vpEnd) / 2
    E.vpStart = Math.max(0, mid - minSpan / 2)
    E.vpEnd   = Math.min(E.duration, E.vpStart + minSpan)
  }
  drawWaveform()
  updateMinimapViewport()
}

export function panBy(deltaSecs: number): void {
  const span = E.vpEnd - E.vpStart
  E.vpStart = Math.max(0, Math.min(E.duration - span, E.vpStart + deltaSecs))
  E.vpEnd   = E.vpStart + span
  drawWaveform()
  updateMinimapViewport()
}
