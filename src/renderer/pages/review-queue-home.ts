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
import { t, tArr } from '../i18n'

function fmtDate(timestamp: number): string {
  const d = new Date(timestamp)
  // Day names: schedule.days is Mon=0..Sun=6; JS Date is Sun=0..Sat=6 (full names).
  const days = tArr('review.dayNames', ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'])
  const months = tArr('review.monthNames', ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'])
  return `${days[d.getDay()]} ${d.getDate()}. ${months[d.getMonth()]}`
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
  if (!trim) return t('review.sermonNotFound', 'Preken ikke detektert')
  const lenMin = Math.round((trim.endSec - trim.startSec) / 60)
  return t('review.sermonGuess', 'Preken antatt: {min} min').replace('{min}', String(lenMin))
}

function attentionBadge(entry: ReviewQueueEntry): HTMLElement | null {
  if (entry.prep.status !== 'needs-attention') return null
  const badge = document.createElement('span')
  badge.className = 'review-attention-badge'
  badge.textContent = '⚠ ' + t('review.needsAttention', 'Trenger oppmerksomhet')
  return badge
}

function ageLabel(ageInDays: number): string {
  if (ageInDays < 1 / 24) return t('review.ageNow', 'Akkurat nå')
  if (ageInDays < 1) return t('review.ageHours', '{n}t siden').replace('{n}', String(Math.floor(ageInDays * 24)))
  if (ageInDays < 2) return t('review.ageDayOne', '1 dag siden')
  if (ageInDays < 14) return t('review.ageDays', '{n} dager siden').replace('{n}', String(Math.floor(ageInDays)))
  return t('review.ageOldest', 'Over 14 dager siden')
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
    count.textContent = pending.length === 1
      ? t('review.queueCountOne', '1 episode')
      : t('review.queueCount', '{n} episoder').replace('{n}', String(pending.length))
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

  // Thumbnail (optional) — appended lazily so we don't block layout on IPC.
  const thumbSlot = document.createElement('div')
  thumbSlot.className = 'review-queue-item-thumb-slot'
  item.appendChild(thumbSlot)
  void window.api.thumbnailResolve(entry.prep.recordingPath).then(t => {
    if (!t) return
    const img = document.createElement('img')
    img.className = 'thumb-card-icon thumb-card-icon-home'
    img.src = t.dataUrl
    img.alt = ''
    thumbSlot.appendChild(img)
  }).catch(() => { /* never block UI for cover-art lookups */ })

  // Left: metadata
  const meta = document.createElement('div')
  meta.className = 'review-queue-item-meta'

  const dateRow = document.createElement('div')
  dateRow.className = 'review-queue-item-date-row'
  const dateEl = document.createElement('strong')
  dateEl.textContent = fmtDate(entry.prep.timestamp)
  dateEl.className = 'review-queue-item-date'
  dateRow.appendChild(dateEl)

  const ageEl = document.createElement('span')
  ageEl.textContent = ageLabel(entry.ageInDays)
  ageEl.className = 'review-queue-item-age'
  dateRow.appendChild(ageEl)

  const badge = attentionBadge(entry)
  if (badge) dateRow.appendChild(badge)
  meta.appendChild(dateRow)

  const infoRow = document.createElement('div')
  infoRow.className = 'review-queue-item-info-row'
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
    confEl.textContent = `${pct}% ${t('review.confident', 'sikker')}`
    confEl.className = entry.prep.sermonConfidence < 0.6
      ? 'review-queue-item-conf review-queue-item-conf-low'
      : 'review-queue-item-conf'
    infoRow.appendChild(confEl)
  }
  meta.appendChild(infoRow)

  // Optional: first attention reason as a hint line
  const firstReason = entry.prep.attentionReasons?.[0]
  if (firstReason) {
    const reasonEl = document.createElement('div')
    reasonEl.textContent = firstReason
    reasonEl.className = 'review-queue-item-reason'
    meta.appendChild(reasonEl)
  }

  item.appendChild(meta)

  // Right: action button
  const actions = document.createElement('div')
  actions.className = 'review-queue-item-actions'

  const reviewBtn = document.createElement('button')
  reviewBtn.className = 'review-queue-review-btn'
  reviewBtn.textContent = t('review.openReview', 'Gjennomgå →')
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
