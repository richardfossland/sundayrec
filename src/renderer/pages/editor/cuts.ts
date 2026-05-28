import { E } from './state'

// Cut-region model. (Mutations + rendering land here in a later phase; for now
// just the read-only predicates the waveform renderer needs.)

export function isInCut(sec: number): boolean {
  return E.cuts.some(c => sec >= c.start && sec <= c.end)
}

export function isInDrag(sec: number): boolean {
  if (!E.isDragging) return false
  const s = Math.min(E.dragStartSec, E.dragEndSec)
  const e = Math.max(E.dragStartSec, E.dragEndSec)
  return sec >= s && sec <= e
}
