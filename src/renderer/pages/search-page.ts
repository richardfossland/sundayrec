/**
 * Search page — full-text search across all transcript sidecars.
 *
 * On first activation we ask the main process for every `.transcript.json`
 * sidecar in known recording folders. The renderer builds an in-memory
 * index of (filePath, segmentIndex, text) tuples and serves search results
 * by linear scan with case-insensitive substring match plus a simple
 * highlight-context view.
 *
 * Why linear scan and not a fancy library: even a 200-sermon archive with
 * ~10 000 segments fits in a few MB of memory; linear search is ~5 ms.
 * Anything fancier (lunr, MiniSearch) adds 50+ KB to the bundle for zero
 * user-visible benefit at this scale.
 */

import { t } from '../i18n'
import { escHtml } from '../helpers'
import type { TranscriptData, TranscriptSegment } from '../../types'

interface IndexEntry {
  /** Source recording base path (without extension). Use transcriptResolveSource
   *  to find the actual file when opening. */
  basePath:     string
  /** Display label — base filename without extension. */
  displayName:  string
  /** Transcript metadata. */
  meta:         TranscriptData
}

interface SearchHit {
  entry:        IndexEntry
  segIndex:     number
  segment:      TranscriptSegment
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
    void loadIndex().then(() => runSearch())
  })
}

/** Called from showPage('search') — kicks off index load if first visit, or
 *  re-runs the current query against the cached index. */
export function activateSearchPage(): void {
  if (!cachedIndex && !indexLoading) {
    void loadIndex().then(() => runSearch())
  } else {
    runSearch()
  }
}

async function loadIndex(): Promise<void> {
  if (indexLoading) return
  indexLoading = true
  setStatus(t('search.indexing', 'Bygger indeks…'))
  try {
    const raw = await window.api.transcriptListAll()
    cachedIndex = raw.map(r => ({
      basePath:    r.filePath,
      displayName: r.filePath.split(/[/\\]/).pop() ?? '',
      meta:        r.transcript,
    })).sort((a, b) => b.meta.createdAt - a.meta.createdAt)

    if (cachedIndex.length === 0) {
      setStatus('')
      showEmptyState(true)
    } else {
      const totalSegments = cachedIndex.reduce((sum, e) => sum + (e.meta.segments?.length ?? 0), 0)
      setStatus(
        `${cachedIndex.length} ${t('search.transcriptsLoaded', 'transkripsjoner indeksert')} · ` +
        `${totalSegments} ${t('search.segments', 'segmenter')}`,
      )
      showEmptyState(false)
    }
  } catch (err) {
    setStatus(`✕ ${t('search.indexFailed', 'Klarte ikke laste indeks')}: ${(err as Error).message}`)
  } finally {
    indexLoading = false
  }
}

function runSearch(): void {
  const resultsEl = $('search-results')
  if (!resultsEl) return
  if (!cachedIndex) return

  const query = pendingQuery
  if (query.length < 2) {
    // Show recently transcribed list as default browse experience.
    renderRecentList(cachedIndex.slice(0, 20))
    return
  }

  const needle = query.toLowerCase()
  const hits: SearchHit[] = []
  for (const entry of cachedIndex) {
    for (let i = 0; i < (entry.meta.segments?.length ?? 0); i++) {
      const seg = entry.meta.segments[i]
      if (seg.text.toLowerCase().includes(needle)) {
        hits.push({ entry, segIndex: i, segment: seg })
        if (hits.length > 500) break  // cap to avoid pathological renders
      }
    }
    if (hits.length > 500) break
  }

  renderResults(hits, query)
}

function renderRecentList(entries: IndexEntry[]): void {
  const el = $('search-results')
  if (!el) return
  if (entries.length === 0) { el.innerHTML = ''; return }
  el.innerHTML = `<div class="search-section-label">${t('search.recent', 'Nylig transkribert')}</div>`
  for (const entry of entries) {
    const card = document.createElement('div')
    card.className = 'search-recent-card'
    card.innerHTML = `
      <div class="search-recent-name">${escHtml(entry.displayName)}</div>
      <div class="search-recent-meta">
        ${formatDate(entry.meta.createdAt)} · ${entry.meta.segments?.length ?? 0} ${t('search.segments', 'segmenter')} · ${entry.meta.language ?? '—'}
      </div>
    `
    card.addEventListener('click', () => openRecording(entry, 0))
    el.appendChild(card)
  }
}

function renderResults(hits: SearchHit[], query: string): void {
  const el = $('search-results')
  if (!el) return
  if (hits.length === 0) {
    el.innerHTML = `<div class="search-no-hits">${t('search.noHits', 'Ingen treff for')} «${escHtml(query)}»</div>`
    return
  }

  // Group hits by recording so a phrase that appears 5 times in one sermon
  // doesn't drown out other sermons.
  const byEntry = new Map<string, SearchHit[]>()
  for (const h of hits) {
    const key = h.entry.basePath
    if (!byEntry.has(key)) byEntry.set(key, [])
    byEntry.get(key)!.push(h)
  }

  el.innerHTML = `<div class="search-section-label">${hits.length} ${t('search.hitsIn', 'treff i')} ${byEntry.size} ${t('search.recordings', 'opptak')}</div>`

  for (const [, groupHits] of byEntry) {
    const entry = groupHits[0].entry
    const card = document.createElement('div')
    card.className = 'search-result-card'

    const header = document.createElement('div')
    header.className = 'search-result-header'
    header.innerHTML = `
      <div class="search-result-name">${escHtml(entry.displayName)}</div>
      <div class="search-result-meta">
        ${formatDate(entry.meta.createdAt)} · ${groupHits.length} ${t('search.matches', 'treff')}
      </div>
    `
    card.appendChild(header)

    // Show up to 3 hits per recording — user can open to see the rest.
    const shownHits = groupHits.slice(0, 3)
    for (const h of shownHits) {
      const row = document.createElement('div')
      row.className = 'search-hit-row'
      row.innerHTML = `
        <span class="search-hit-time">${formatTime(h.segment.start)}</span>
        <span class="search-hit-text">${highlightMatch(h.segment.text, query)}</span>
      `
      row.addEventListener('click', () => openRecording(entry, h.segment.start))
      card.appendChild(row)
    }
    if (groupHits.length > 3) {
      const more = document.createElement('div')
      more.className = 'search-hit-more'
      more.textContent = `+ ${groupHits.length - 3} ${t('search.moreHits', 'flere treff i samme opptak')}`
      more.addEventListener('click', () => openRecording(entry, shownHits[0].segment.start))
      card.appendChild(more)
    }

    el.appendChild(card)
  }
}

function highlightMatch(text: string, query: string): string {
  if (!query) return escHtml(text)
  const needle = query.toLowerCase()
  const lower  = text.toLowerCase()
  const idx    = lower.indexOf(needle)
  if (idx === -1) return escHtml(text)
  // Trim long segments so we don't render 500-char rows. Show ~60 chars
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

function formatDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`
}

async function openRecording(entry: IndexEntry, atSec: number): Promise<void> {
  // Resolve the actual file path (with extension) via main-process probe.
  const fp = await window.api.transcriptResolveSource(entry.basePath)
  if (!fp) {
    alert(t('search.fileNotFound', 'Originalfilen ble ikke funnet. Den kan ha blitt flyttet eller slettet.'))
    return
  }
  // Hand off to the editor with a "seek to time" intent. Editor reads
  // the transcript sidecar itself on load.
  window.openEditorWithFile?.(fp)
  // Wait a beat for the editor to load, then seek. The editor exposes a
  // simple "seek" via the transcript-segment click path; we trigger it
  // with a custom event so we don't have to wire a second IPC channel.
  setTimeout(() => {
    document.dispatchEvent(new CustomEvent('editor-seek-to', { detail: { sec: atSec } }))
  }, 350)
}

function setStatus(s: string): void {
  const el = $('search-index-status')
  if (!el) return
  el.textContent = s
  el.style.display = s ? '' : 'none'
}

function showEmptyState(show: boolean): void {
  const empty = $('search-empty')
  const res   = $('search-results')
  if (empty) empty.style.display = show ? '' : 'none'
  if (res)   res.style.display   = show ? 'none' : ''
}
