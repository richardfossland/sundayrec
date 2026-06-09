/**
 * «Søk & historikk» — the merged sermon-search + recording-history tab.
 *
 * One search box searches BOTH the recording metadata (filename / date / note)
 * and the transcript text of every sermon. Below it sits the full recording
 * history (the list relocated from the home page); when a text query matches a
 * sermon's transcript, the matching snippets render inline under that recording.
 * An empty query shows the whole history.
 *
 * The history list + its tools live in `history.ts`; this module owns the
 * transcript index and the unified query that drives the render.
 *
 * Why linear scan and not a search library: even a 200-sermon archive with
 * ~10 000 segments fits in a few MB; linear search is ~5 ms — a library would
 * add 50+ KB to the bundle for no user-visible benefit at this scale.
 */

import { t } from '../i18n'
import { escHtml } from '../helpers'
import {
  loadHistory,
  getFullHistory,
  renderHistoryRows,
  updateHistoryStats,
  setupHistoryTools,
  baseNoExt,
  type HistoryHit,
} from './history'
import type { TranscriptData } from '../../types'

interface IndexEntry {
  /** Source recording base path (without extension) — the join key against a
   *  recording's path. */
  basePath:     string
  /** Transcript metadata (segments + timing). */
  meta:         TranscriptData
}

let cachedIndex: IndexEntry[] | null = null
let indexLoading = false
let pendingQuery = ''

const $ = (id: string) => document.getElementById(id)

export function setupSearchPage(): void {
  const input = $('search-query') as HTMLInputElement | null
  input?.addEventListener('input', () => {
    pendingQuery = (input.value ?? '').trim()
    runSearch()
  })
  $('btn-search-reindex')?.addEventListener('click', () => {
    cachedIndex = null
    void loadTranscriptIndex().then(() => runSearch())
  })
  // History maintenance tools (clear / prune / delete-errors / "⋯") re-run the
  // current query so the list + stats refresh in place after a mutation.
  setupHistoryTools(runSearch)
}

/** Called from showPage('search'): refresh the history (cheap — picks up new
 *  recordings), build the transcript index on first visit, then render. */
export function activateSearchPage(): void {
  void (async () => {
    await loadHistory()
    if (!cachedIndex && !indexLoading) await loadTranscriptIndex()
    runSearch()
  })()
}

async function loadTranscriptIndex(): Promise<void> {
  if (indexLoading) return
  indexLoading = true
  try {
    const raw = await window.api.transcriptListAll()
    cachedIndex = raw
      .map(r => ({ basePath: r.filePath, meta: r.transcript }))
      .sort((a, b) => b.meta.createdAt - a.meta.createdAt)
  } catch (err) {
    setStatus(`✕ ${t('search.indexFailed', 'Klarte ikke laste indeks')}: ${(err as Error).message}`)
  } finally {
    indexLoading = false
  }
}

function indexStatusText(): string {
  if (!cachedIndex || cachedIndex.length === 0) return ''
  const totalSegments = cachedIndex.reduce((sum, e) => sum + (e.meta.segments?.length ?? 0), 0)
  return `${cachedIndex.length} ${t('search.transcriptsLoaded', 'transkripsjoner indeksert')} · ` +
    `${totalSegments} ${t('search.segments', 'segmenter')}`
}

function runSearch(): void {
  const tbody = $('history-tbody')
  if (!tbody) return

  const all = getFullHistory()
  showEmptyState(all.length === 0)
  if (all.length === 0) { setStatus(''); return }

  const q = pendingQuery
  if (q.length < 2) {
    renderHistoryRows(tbody, all, true)
    updateHistoryStats(all)
    setStatus(indexStatusText())
    return
  }

  const needle = q.toLowerCase()

  // Transcript hits per recording base path (capped to 3 snippets each).
  const hitsByBase = new Map<string, HistoryHit[]>()
  if (cachedIndex) {
    for (const entry of cachedIndex) {
      const segs = entry.meta.segments ?? []
      const acc: HistoryHit[] = []
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]
        if (seg.text.toLowerCase().includes(needle)) {
          acc.push({ start: seg.start, html: highlightMatch(seg.text, q) })
          if (acc.length >= 3) break
        }
      }
      if (acc.length) hitsByBase.set(entry.basePath, acc)
    }
  }

  // A recording matches if its metadata matches OR its transcript has a hit.
  const matches = all.filter(r =>
    (r.filename ?? '').toLowerCase().includes(needle) ||
    (r.date ?? '').includes(q) ||
    (r.note ?? '').toLowerCase().includes(needle) ||
    hitsByBase.has(baseNoExt(r.path)))

  renderHistoryRows(tbody, matches, true, hitsByBase)
  updateHistoryStats(matches)

  const hitCount = [...hitsByBase.values()].reduce((s, a) => s + a.length, 0)
  setStatus(
    matches.length === 0
      ? `${t('search.noHits', 'Ingen treff for')} «${escHtml(q)}»`
      : `${matches.length} ${t('search.recordings', 'opptak')}` +
        (hitCount ? ` · ${hitCount} ${t('search.matches', 'treff')}` : ''),
  )
}

function highlightMatch(text: string, query: string): string {
  if (!query) return escHtml(text)
  const needle = query.toLowerCase()
  const lower  = text.toLowerCase()
  const idx    = lower.indexOf(needle)
  if (idx === -1) return escHtml(text)
  // Trim long segments so we don't render 500-char rows — ~60 chars of context
  // around the match.
  const ctx = 60
  const start = Math.max(0, idx - ctx)
  const end   = Math.min(text.length, idx + query.length + ctx)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const before = escHtml(text.slice(start, idx))
  const match  = escHtml(text.slice(idx, idx + query.length))
  const after  = escHtml(text.slice(idx + query.length, end))
  return `${prefix}${before}<mark>${match}</mark>${after}${suffix}`
}

function setStatus(s: string): void {
  const el = $('search-index-status')
  if (!el) return
  el.textContent = s
  el.style.display = s ? '' : 'none'
}

function showEmptyState(show: boolean): void {
  const empty = $('search-empty')
  const tableWrap = $('search-history-wrap')
  if (empty) empty.style.display = show ? '' : 'none'
  if (tableWrap) tableWrap.style.display = show ? 'none' : ''
}
