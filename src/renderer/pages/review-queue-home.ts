/**
 * review-queue-home — renders the "Klare for gjennomgang og publisering"
 * card on the home page. The card is hidden when the queue is empty.
 *
 * Each entry shows:
 *   - Day of week + date ("Søndag 31. mai")
 *   - Duration of the recording
 *   - Suggested sermon length and confidence
 *   - Attention badge if needs-attention
 *   - "Gjennomgå →" button that opens the editor in review mode
 */

import type { ReviewQueueEntry } from '../../types'

const DAYS_NO = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag']
const MONTHS_NO = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember']

function fmtDate(timestamp: number): string {
  const d = new Date(timestamp)
  return `${DAYS_NO[d.getDay()]} ${d.getDate()}. ${MONTHS_NO[d.getMonth()]}`
}

function fmtDurationSec(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return '—'
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec % 3600) / 60)
  if (h > 0) return `${h}t ${m}min`
  return `${m}min`
}

function deriveDurationFromPrep(entry: ReviewQueueEntry): number {
  const segs = entry.prep.analysisSegments ?? []
  if (segs.length === 0) return 0
  return segs[segs.length - 1].endSec
}

function fmtSermonInfo(entry: ReviewQueueEntry): string {
  const trim = entry.prep.suggestedTrim
  if (!trim) return 'Preken ikke detektert'
  const lenMin = Math.round((trim.endSec - trim.startSec) / 60)
  return `Preken antatt: ${lenMin} min`
}

function attentionBadge(entry: ReviewQueueEntry): HTMLElement | null {
  if (entry.prep.status !== 'needs-attention') return null
  const badge = document.createElement('span')
  badge.className = 'review-attention-badge'
  badge.textContent = '⚠ Trenger oppmerksomhet'
  badge.style.cssText = 'background:rgba(255,180,107,0.2);color:#ffb46b;padding:3px 10px;border-radius:12px;font-size:11px;font-weight:600;border:1px solid rgba(255,180,107,0.4)'
  return badge
}

function ageLabel(ageInDays: number): string {
  if (ageInDays < 1 / 24) return 'Akkurat nå'
  if (ageInDays < 1) return `${Math.floor(ageInDays * 24)}t siden`
  if (ageInDays < 2) return '1 dag siden'
  if (ageInDays < 14) return `${Math.floor(ageInDays)} dager siden`
  return 'Over 14 dager siden'
}

export async function refreshReviewQueue(): Promise<void> {
  const card = document.getElementById('review-queue-card')
  const list = document.getElementById('review-queue-list')
  const count = document.getElementById('review-queue-count')
  if (!card || !list) return

  let entries: ReviewQueueEntry[] = []
  try {
    entries = await window.api.reviewQueueList()
  } catch (err) {
    console.warn('[review-queue-home] list failed:', err)
    return
  }

  // Filter out published/discarded — those are kept briefly by the backend
  // but should not show up in the "pending review" UI.
  const pending = entries.filter(e => e.prep.status !== 'published' && e.prep.status !== 'discarded')

  if (pending.length === 0) {
    card.style.display = 'none'
    return
  }

  card.style.display = ''
  if (count) {
    count.textContent = pending.length === 1 ? '1 episode' : `${pending.length} episoder`
  }

  list.innerHTML = ''
  for (const entry of pending) {
    list.appendChild(renderEntry(entry))
  }
}

function renderEntry(entry: ReviewQueueEntry): HTMLElement {
  const item = document.createElement('div')
  item.className = 'review-queue-item'
  item.dataset.id = entry.id
  item.style.cssText = 'display:flex;align-items:center;gap:14px;padding:12px 14px;background:rgba(255,255,255,0.04);border-radius:8px;border:1px solid rgba(255,255,255,0.06)'

  // Left: metadata
  const meta = document.createElement('div')
  meta.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:4px;min-width:0'

  const dateRow = document.createElement('div')
  dateRow.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap'
  const dateEl = document.createElement('strong')
  dateEl.textContent = fmtDate(entry.prep.timestamp)
  dateEl.style.cssText = 'font-size:14px;color:var(--text)'
  dateRow.appendChild(dateEl)

  const ageEl = document.createElement('span')
  ageEl.textContent = ageLabel(entry.ageInDays)
  ageEl.style.cssText = 'font-size:11px;color:var(--text3)'
  dateRow.appendChild(ageEl)

  const badge = attentionBadge(entry)
  if (badge) dateRow.appendChild(badge)
  meta.appendChild(dateRow)

  const infoRow = document.createElement('div')
  infoRow.style.cssText = 'display:flex;align-items:center;gap:12px;font-size:12px;color:var(--text2);flex-wrap:wrap'
  const dur = deriveDurationFromPrep(entry)
  const durEl = document.createElement('span')
  durEl.textContent = `🕐 ${fmtDurationSec(dur)}`
  infoRow.appendChild(durEl)

  const sermonEl = document.createElement('span')
  sermonEl.textContent = `🎙 ${fmtSermonInfo(entry)}`
  infoRow.appendChild(sermonEl)

  if (entry.prep.sermonConfidence != null) {
    const confEl = document.createElement('span')
    const pct = Math.round(entry.prep.sermonConfidence * 100)
    confEl.textContent = `${pct}% sikker`
    confEl.style.color = entry.prep.sermonConfidence < 0.6 ? '#ffb46b' : 'var(--text3)'
    infoRow.appendChild(confEl)
  }
  meta.appendChild(infoRow)

  // Optional: first attention reason as a hint line
  const firstReason = entry.prep.attentionReasons?.[0]
  if (firstReason) {
    const reasonEl = document.createElement('div')
    reasonEl.textContent = firstReason
    reasonEl.style.cssText = 'font-size:11px;color:#ffb46b;font-style:italic;margin-top:2px'
    meta.appendChild(reasonEl)
  }

  item.appendChild(meta)

  // Right: action button
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;gap:6px;flex-shrink:0'

  const reviewBtn = document.createElement('button')
  reviewBtn.className = 'btn btn-primary'
  reviewBtn.textContent = 'Gjennomgå →'
  reviewBtn.style.cssText = 'background:#7fc488;color:#0d1a12;font-weight:600;border:none;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap'
  reviewBtn.addEventListener('click', () => {
    window.openEditorReviewMode?.(entry.id, entry.prep.recordingPath)
  })
  actions.appendChild(reviewBtn)

  item.appendChild(actions)
  return item
}

/** Hook into the global IPC channel so the card updates as items arrive/leave. */
export function setupReviewQueueListeners(): void {
  window.api.on('review-queue-update', () => {
    refreshReviewQueue().catch(err => console.warn('[review-queue-home] refresh failed:', err))
  })
}

declare global {
  interface Window {
    openEditorReviewMode?: (prepId: string, filePath: string) => void
  }
}
