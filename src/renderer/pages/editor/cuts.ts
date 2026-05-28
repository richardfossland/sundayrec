import { t } from '../../i18n'
import { E, $, markDirty, type Cut } from './state'
import { clampMain } from './geometry'
import { gainFactor } from './peaks'
import { formatTime, formatDuration } from './format'
import { drawWaveform, drawMinimap, updateMinimapViewport } from './waveform'
import { startPlay, stopPlay, updateTimecode } from './playback'
import { updateHeaderSummary } from '../editor-page'

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

// ── Cut helpers ───────────────────────────────────────────────────────────
// Undo/redo: history stores snapshots; cutHistoryIdx points to the current
// live state. Index -1 means "no history yet" (initial empty state).
// pushCutHistory() is called AFTER a mutation to record the new state.
export function pushCutHistory(): void {
  // Discard any redo states ahead of the current pointer
  E.cutHistory = E.cutHistory.slice(0, E.cutHistoryIdx + 1)
  E.cutHistory.push(JSON.parse(JSON.stringify(E.cuts)))
  if (E.cutHistory.length > 50) E.cutHistory.shift()
  E.cutHistoryIdx = E.cutHistory.length - 1
  // Persist cuts to a draft sidecar so a crash mid-edit doesn't lose the work
  scheduleDraftSave()
}

let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleDraftSave(): void {
  if (!E.filePath) return
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  // Debounce 2 s — avoid IPC spam during rapid drag operations
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    const fp = E.filePath
    if (!fp) return
    window.api.editorSaveCutsDraft(fp, E.cuts).catch(() => {})
  }, 2000)
}

/** Called after a successful save/export to remove the draft. */
export function clearEditorDraft(): void {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  if (E.filePath) window.api.editorDeleteCutsDraft(E.filePath).catch(() => {})
}

export function addCut(s: number, e: number): void {
  if (e < s) [s, e] = [e, s]
  // Cuts must always live in main coords — clamp in case the drag started or
  // ended in an intro/outro slot (caller may have passed extended-timeline
  // values).
  s = clampMain(s); e = clampMain(e)
  if (e - s < 0.1) return

  E.cuts.push({ start: s, end: e })
  E.cuts.sort((a, b) => a.start - b.start)

  // Merge overlapping
  const merged: Cut[] = []
  for (const c of E.cuts) {
    const prev = merged[merged.length - 1]
    if (prev && c.start <= prev.end + 0.01) { prev.end = Math.max(prev.end, c.end) }
    else merged.push({ ...c })
  }
  E.cuts = merged
  pushCutHistory()
  markDirty()
  updateRemainingDisplay()
}

export function deleteCut(i: number): void {
  E.cuts.splice(i, 1)
  pushCutHistory()
  markDirty()
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

export function undoCut(): void {
  if (E.cutHistoryIdx <= 0) {
    // Undo back to empty state
    if (E.cutHistoryIdx === 0 && E.cuts.length > 0) {
      E.cuts = []
      E.cutHistoryIdx = -1
      renderCutList(); updateRemainingDisplay(); drawWaveform(); drawMinimap()
    }
    return
  }
  E.cutHistoryIdx--
  E.cuts = JSON.parse(JSON.stringify(E.cutHistory[E.cutHistoryIdx]))
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

export function redoCut(): void {
  if (E.cutHistoryIdx >= E.cutHistory.length - 1) return
  E.cutHistoryIdx++
  E.cuts = JSON.parse(JSON.stringify(E.cutHistory[E.cutHistoryIdx]))
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

export function getKeepSegs(): { start: number; end: number }[] {
  const sorted = [...E.cuts].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < E.duration - 0.05) keeps.push({ start: cursor, end: E.duration })
  return keeps
}

export function getRemainingDuration(): number {
  return getKeepSegs().reduce((sum, s) => sum + (s.end - s.start), 0)
}

export function updateRemainingDisplay(): void {
  const el  = $('editor-remaining')
  const dur = $('editor-remaining-dur')
  // Update header summary regardless — duration / normalize state may have
  // changed even if no cuts exist yet.
  updateHeaderSummary()
  if (!el || !E.duration) return

  if (E.cuts.length === 0) {
    el.style.display = 'none'
    return
  }

  const rem = getRemainingDuration()
  const cut = E.duration - rem
  el.style.display = 'flex'
  el.classList.toggle('has-cuts', E.cuts.length > 0)
  if (dur) dur.textContent = `${formatDuration(rem)} (fjerner ${formatDuration(cut)})`
}

export function renderCutList(): void {
  const panel = $('editor-cuts-panel')
  const list  = $('editor-cuts-list')
  const undo  = $('btn-editor-undo-all')
  if (!panel || !list || !undo) return

  if (E.cuts.length === 0) {
    panel.style.display = 'none'
    undo.style.display  = 'none'
    return
  }

  panel.style.display = ''
  undo.style.display  = ''

  list.innerHTML = ''

  E.cuts.forEach((c, i) => {
    const dur = c.end - c.start
    const row = document.createElement('div')
    row.className = 'editor-cut-row'
    row.style.animationDelay = `${i * 0.05}s`

    // Thumbnail
    const thumb = document.createElement('div')
    thumb.className = 'editor-cut-thumb'
    if (E.peaks) {
      thumb.innerHTML = makeCutThumbnailSvg(c)
    }

    // Info
    const info = document.createElement('div')
    info.className = 'editor-cut-info'
    info.innerHTML = `<div class="editor-cut-range">${formatTime(c.start)} – ${formatTime(c.end)}</div>
      <div class="editor-cut-dur">${formatDuration(dur)}</div>`

    // Preview button (pre/post-roll)
    const prevBtn = document.createElement('button')
    prevBtn.className = 'editor-cut-prev'
    prevBtn.title = 'Spill 3s rundt kuttet'
    prevBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/></svg>'
    prevBtn.addEventListener('click', () => previewCut(c))

    // Delete button
    const delBtn = document.createElement('button')
    delBtn.className = 'editor-cut-del'
    delBtn.title = t('editor.deleteCut') || 'Fjern kutt'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => deleteCut(i))

    row.appendChild(thumb)
    row.appendChild(info)
    row.appendChild(prevBtn)
    row.appendChild(delBtn)
    list.appendChild(row)
  })
}

export function makeCutThumbnailSvg(cut: Cut): string {
  if (!E.peaks) return ''
  const W = 72, H = 24
  const startIdx = Math.floor(cut.start * 100)
  const endIdx   = Math.ceil(cut.end * 100)
  const count    = Math.max(1, endIdx - startIdx)
  const midY     = H / 2
  const maxH     = midY - 2
  const gFac     = gainFactor()
  const rects: string[] = []
  for (let px = 0; px < W; px++) {
    const pi = startIdx + Math.floor(px / W * count)
    if (pi >= E.peaks.length) break
    const h = Math.min(maxH, E.peaks[pi] * gFac * maxH)
    rects.push(`<rect x="${px}" y="${(midY - h).toFixed(1)}" width="1" height="${(h * 2).toFixed(1)}"/>`)
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">${rects.join('')}</svg>`
}

export function previewCut(cut: Cut): void {
  stopPlay()
  const PRE_ROLL = 3
  E.playStartSec = Math.max(0, cut.start - PRE_ROLL)
  updateTimecode(E.playStartSec)
  if (E.playStartSec < E.vpStart || E.playStartSec > E.vpEnd) {
    const half = (E.vpEnd - E.vpStart) / 2
    E.vpStart = Math.max(0, E.playStartSec - half * 0.3)
    E.vpEnd   = Math.min(E.duration, E.vpStart + half * 2)
    updateMinimapViewport()
  }
  startPlay(false)
}
