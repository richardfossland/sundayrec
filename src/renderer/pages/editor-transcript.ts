/**
 * Editor transcription panel.
 *
 * Flow:
 *   1. User clicks "▶ Transkriber".
 *   2. We open the model+language modal.
 *   3. If the chosen model isn't downloaded, we download it (progress UI).
 *   4. Then we kick off whisperTranscribe and show the progress modal.
 *   5. On success we render the segments below the timeline and save a
 *      <recording>.transcript.json sidecar.
 *
 *   Future: clicking a segment seeks the playhead. The current-segment
 *   highlight updates from the editor's animation loop via setCurrentTranscriptTime().
 */

import { t } from '../i18n'
import type { TranscriptData, TranscriptSegment } from '../../types'

interface ModelStatus {
  id:             string
  label:          string
  description:    string
  sizeBytes:      number
  quality:        string
  realtimeFactor: number
  installed:      boolean
  sizeOk:         boolean
}

let currentFilePath: string | null = null
let currentTranscript: TranscriptData | null = null
let selectedModelId: string = 'ggml-large-v3-turbo-q5_0'
let activeJobId: string | null = null
let modelStatuses: ModelStatus[] = []
let onSeekCallback: ((sec: number) => void) | null = null

const $ = (id: string) => document.getElementById(id)

export function setupTranscriptPanel(onSeek: (sec: number) => void): void {
  onSeekCallback = onSeek
  $('btn-transcribe')?.addEventListener('click', openModal)
  $('btn-transcribe-cancel')?.addEventListener('click', closeModal)
  $('btn-transcribe-start')?.addEventListener('click', startTranscription)
  $('btn-transcribe-progress-cancel')?.addEventListener('click', cancelActiveJob)
  $('btn-transcript-export')?.addEventListener('click', exportSrt)
  $('btn-transcript-delete')?.addEventListener('click', deleteTranscript)

  // Probe availability once at startup so the button can be disabled with
  // an inline explanation if the binary didn't ship (CI build issue,
  // unsupported platform, missing dependency on Linux build).
  void checkBinaryAvailabilityOnce()

  // Listen for progress events from main process
  window.api.on?.('whisper-progress', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const p = payload as { jobId: string; percent: number }
    if (p.jobId !== activeJobId) return
    updateProgressUI(p.percent)
  })

  window.api.on?.('whisper-model-progress', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return
    const p = payload as { id: string; bytesDownloaded: number; bytesTotal: number; fraction: number | null }
    updateDownloadUI(p)
  })
}

async function checkBinaryAvailabilityOnce(): Promise<void> {
  try {
    const status = await window.api.whisperStatus()
    const btn = $('btn-transcribe') as HTMLButtonElement | null
    if (!btn) return
    if (!status.binaryAvailable) {
      btn.disabled = true
      btn.title = t('transcript.unavailableHint',
        'Transkribering er ikke tilgjengelig i denne bygging. Sjekk Innstillinger → System for plattform-informasjon.')
      btn.textContent = t('transcript.unavailable', '✕ Ikke tilgjengelig')
    }
  } catch {
    // If status check itself fails, leave the button enabled — user can
    // click and see the actual error then.
  }
}

/** Called by editor when a file loads — clears state and loads existing sidecar if any. */
export async function loadTranscriptForFile(filePath: string): Promise<void> {
  currentFilePath = filePath
  currentTranscript = null
  renderPanel()
  // Try to load sidecar
  try {
    const sidecar = await window.api.editorReadTranscript?.(filePath) as TranscriptData | null
    if (sidecar && sidecar.version === 1) {
      currentTranscript = sidecar
      renderPanel()
    }
  } catch {}
}

export function clearTranscript(): void {
  currentFilePath = null
  currentTranscript = null
  renderPanel()
}

/** Called from editor animate-loop on each frame so we can highlight which
 *  segment is currently playing. Cheap binary-search on segments. */
export function setCurrentTranscriptTime(sec: number): void {
  if (!currentTranscript) return
  const segs = currentTranscript.segments
  // Find segment containing sec
  let idx = -1
  for (let i = 0; i < segs.length; i++) {
    if (sec >= segs[i].start && sec < segs[i].end) { idx = i; break }
  }
  highlightSegment(idx)
}

let lastHighlightedIdx = -1
function highlightSegment(idx: number): void {
  if (idx === lastHighlightedIdx) return
  lastHighlightedIdx = idx
  const container = $('editor-transcript-segments')
  if (!container) return
  container.querySelectorAll('.editor-transcript-segment').forEach((el, i) => {
    el.classList.toggle('is-current', i === idx)
  })
  // Scroll into view if not visible
  if (idx >= 0) {
    const el = container.children[idx] as HTMLElement | undefined
    if (el) {
      const rect = el.getBoundingClientRect()
      const cRect = container.getBoundingClientRect()
      if (rect.top < cRect.top || rect.bottom > cRect.bottom) {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function renderPanel(): void {
  const body = $('editor-transcript-body')
  if (!body) return
  const exportBtn = $('btn-transcript-export') as HTMLElement | null
  const deleteBtn = $('btn-transcript-delete') as HTMLElement | null

  if (!currentTranscript || currentTranscript.segments.length === 0) {
    body.innerHTML = `<div class="editor-transcript-empty">${t('transcript.empty', 'Ingen transkripsjon ennå. Klikk «Transkriber» for å lage søkbar tekst av talen.')}</div>`
    if (exportBtn) exportBtn.style.display = 'none'
    if (deleteBtn) deleteBtn.style.display = 'none'
    return
  }

  const meta = currentTranscript
  const d = new Date(meta.createdAt)
  const dateStr = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`
  const langLabel = meta.language === 'auto' ? t('transcript.langAuto', 'Auto') : meta.language.toUpperCase()
  const segCount = meta.segments.length

  body.innerHTML = `
    <div class="editor-transcript-meta">
      ${dateStr} · ${meta.model} · ${langLabel} · ${segCount} ${t('transcript.segments', 'segmenter')}
    </div>
    <div class="editor-transcript-segments" id="editor-transcript-segments"></div>
  `

  const container = $('editor-transcript-segments')!
  for (const seg of meta.segments) {
    const row = document.createElement('div')
    row.className = 'editor-transcript-segment'
    const time = document.createElement('span')
    time.className = 'editor-transcript-segment-time'
    time.textContent = formatTime(seg.start)
    const text = document.createElement('span')
    text.className = 'editor-transcript-segment-text'
    text.textContent = seg.text
    row.append(time, text)
    row.addEventListener('click', () => onSeekCallback?.(seg.start))
    container.appendChild(row)
  }

  if (exportBtn) exportBtn.style.display = ''
  if (deleteBtn) deleteBtn.style.display = ''
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`
}

// ─── Modal: choose model + language ─────────────────────────────────────────

async function openModal(): Promise<void> {
  if (!currentFilePath) return
  const modal = $('transcribe-modal')
  if (!modal) return

  // Load fresh model statuses every time the modal opens — user may have
  // downloaded one in a different session and we want to show "Installed".
  try {
    const status = await window.api.whisperStatus()
    if (!status.binaryAvailable) {
      alert(t('transcript.errNoBinary', 'Whisper er ikke tilgjengelig på denne plattformen. Kontakt support.'))
      return
    }
    modelStatuses = status.models
    renderModelList()
  } catch (err) {
    alert(t('transcript.errStatusFailed', 'Kunne ikke sjekke Whisper-status') + ': ' + (err as Error).message)
    return
  }

  modal.style.display = 'flex'
}

function closeModal(): void {
  const modal = $('transcribe-modal')
  if (modal) modal.style.display = 'none'
}

function renderModelList(): void {
  const list = $('transcribe-model-list')
  if (!list) return
  list.innerHTML = ''

  // Default-select the "best"-quality model that's installed, otherwise the
  // best-quality one regardless of install status (user will be prompted to
  // download).
  const installed = modelStatuses.find(m => m.installed && m.sizeOk && m.quality === 'best')
  if (installed) selectedModelId = installed.id
  else {
    const best = modelStatuses.find(m => m.quality === 'best')
    if (best) selectedModelId = best.id
  }

  for (const m of modelStatuses) {
    const card = document.createElement('label')
    card.className = 'transcribe-model-card'
    if (m.id === selectedModelId) card.classList.add('is-selected')

    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'transcribe-model'
    radio.value = m.id
    radio.checked = m.id === selectedModelId
    radio.className = 'transcribe-model-card-radio'
    radio.addEventListener('change', () => {
      selectedModelId = m.id
      list.querySelectorAll('.transcribe-model-card').forEach(c => c.classList.remove('is-selected'))
      card.classList.add('is-selected')
    })

    const body = document.createElement('div')
    body.className = 'transcribe-model-card-body'

    const title = document.createElement('div')
    title.className = 'transcribe-model-card-title'
    const titleText = document.createElement('span')
    titleText.textContent = m.label
    title.appendChild(titleText)
    if (m.quality === 'best') {
      const badge = document.createElement('span')
      badge.className = 'transcribe-model-card-badge'
      badge.textContent = t('transcript.recommended', 'Anbefalt')
      title.appendChild(badge)
    }
    const statusEl = document.createElement('span')
    statusEl.className = m.installed
      ? 'transcribe-model-card-status transcribe-model-card-status-installed'
      : 'transcribe-model-card-status transcribe-model-card-status-missing'
    statusEl.textContent = m.installed
      ? t('transcript.modelInstalled', '✓ Lastet ned')
      : `${formatSize(m.sizeBytes)}`
    title.appendChild(statusEl)
    body.appendChild(title)

    const desc = document.createElement('div')
    desc.className = 'transcribe-model-card-desc'
    desc.textContent = m.description
    body.appendChild(desc)

    const meta = document.createElement('div')
    meta.className = 'transcribe-model-card-meta'
    meta.innerHTML = `
      <span>${t('transcript.speed', 'Hastighet')}: ~${m.realtimeFactor}x sanntid</span>
      <span>${t('transcript.size', 'Størrelse')}: ${formatSize(m.sizeBytes)}</span>
    `
    body.appendChild(meta)

    card.appendChild(radio)
    card.appendChild(body)
    list.appendChild(card)
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(0)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

// ─── Run transcription ──────────────────────────────────────────────────────

async function startTranscription(): Promise<void> {
  if (!currentFilePath) return
  closeModal()

  const language = ($('transcribe-language') as HTMLSelectElement | null)?.value ?? 'auto'
  const translate = ($('transcribe-translate') as HTMLInputElement | null)?.checked ?? false

  // Open the progress modal so the user has feedback while we work
  showProgressModal(t('transcript.progressTitle', 'Transkriberer…'), 0)

  // 1. If model not installed, download first
  const modelStatus = modelStatuses.find(m => m.id === selectedModelId)
  if (!modelStatus) {
    closeProgressModal()
    alert('Ukjent modell: ' + selectedModelId)
    return
  }
  if (!modelStatus.installed || !modelStatus.sizeOk) {
    setProgressTitle(t('transcript.downloadTitle', 'Laster ned modell…'))
    const dl = await window.api.whisperDownloadModel(selectedModelId)
    if (!dl.ok) {
      closeProgressModal()
      if (dl.error !== 'cancelled') {
        alert(t('transcript.errDownload', 'Modell-nedlasting feilet') + ': ' + dl.error)
      }
      return
    }
  }

  // 2. Transcribe
  setProgressTitle(t('transcript.progressTitle', 'Transkriberer…'))
  updateProgressUI(0)
  activeJobId = 'whisper-' + Date.now()
  try {
    const res = await window.api.whisperTranscribe({
      filePath:  currentFilePath,
      modelId:   selectedModelId,
      language,
      translate,
      jobId:     activeJobId,
    })
    closeProgressModal()
    if (!res.ok || !res.transcript) {
      if (res.error !== 'cancelled') {
        alert(t('transcript.errFailed', 'Transkribering feilet') + ': ' + (res.error ?? 'ukjent'))
      }
      return
    }
    currentTranscript = res.transcript
    renderPanel()
    // Save sidecar
    try {
      await window.api.editorWriteTranscript?.(currentFilePath, res.transcript)
    } catch (err) {
      console.warn('[transcript] sidecar save failed', err)
    }
  } finally {
    activeJobId = null
  }
}

function cancelActiveJob(): void {
  if (activeJobId) {
    void window.api.whisperCancelTranscribe(activeJobId)
  }
  // Also try to cancel any in-flight download (no-op if none active)
  if (selectedModelId) {
    void window.api.whisperCancelDownload(selectedModelId)
  }
  closeProgressModal()
}

function showProgressModal(title: string, percent: number): void {
  const modal = $('transcribe-progress-modal')
  setProgressTitle(title)
  updateProgressUI(percent)
  if (modal) modal.style.display = 'flex'
}

function setProgressTitle(title: string): void {
  const el = $('transcribe-progress-title')
  if (el) el.textContent = title
}

function updateProgressUI(percent: number): void {
  const bar = $('transcribe-progress-bar')
  const text = $('transcribe-progress-text')
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`
  if (text) text.textContent = `${Math.round(percent)}%`
}

function updateDownloadUI(p: { id: string; bytesDownloaded: number; bytesTotal: number; fraction: number | null }): void {
  const pct = p.fraction != null ? p.fraction * 100 : 0
  updateProgressUI(pct)
  const text = $('transcribe-progress-text')
  if (text) text.textContent = `${formatSize(p.bytesDownloaded)} / ${formatSize(p.bytesTotal)} (${Math.round(pct)}%)`
}

function closeProgressModal(): void {
  const modal = $('transcribe-progress-modal')
  if (modal) modal.style.display = 'none'
}

// ─── Sidecar helpers ────────────────────────────────────────────────────────

async function deleteTranscript(): Promise<void> {
  if (!currentFilePath || !currentTranscript) return
  if (!confirm(t('transcript.confirmDelete', 'Slett transkripsjonen?'))) return
  try {
    await window.api.editorDeleteTranscript?.(currentFilePath)
  } catch {}
  currentTranscript = null
  renderPanel()
}

function exportSrt(): void {
  if (!currentTranscript || !currentFilePath) return
  const srt = transcriptToSrt(currentTranscript.segments)
  const baseName = currentFilePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'transcript'
  const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = baseName + '.srt'
  a.click()
  URL.revokeObjectURL(url)
}

function transcriptToSrt(segs: TranscriptSegment[]): string {
  const fmt = (sec: number): string => {
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    const ms = Math.round((sec - Math.floor(sec)) * 1000)
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`
  }
  return segs.map((s, i) => `${i + 1}\n${fmt(s.start)} --> ${fmt(s.end)}\n${s.text}\n`).join('\n')
}
