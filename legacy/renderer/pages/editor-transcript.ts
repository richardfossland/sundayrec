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
import type { TranscriptData, TranscriptSegment, RecordingMetadata } from '../../types'
import { E } from './editor/state'
import { renderChapterList } from './editor/metadata'
import { drawWaveform } from './editor/waveform'

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

// Extensions that route to the SundayEdit hand-off (video only — SundayEdit is a
// video-captioning tool). Mirrors the editor's video set, kept local so this
// panel has no dependency on editor-page internals.
const SUNDAYEDIT_VIDEO_EXTS = new Set([
  '.mp4', '.mov', '.m4v', '.avi', '.wmv', '.mkv', '.webm', '.flv', '.ts', '.mts', '.m2ts', '.3gp',
])
function isVideoPath(p: string): boolean {
  const ext = ('.' + (p.split('.').pop()?.toLowerCase() ?? ''))
  return SUNDAYEDIT_VIDEO_EXTS.has(ext)
}

export function setupTranscriptPanel(onSeek: (sec: number) => void): void {
  onSeekCallback = onSeek
  $('btn-transcribe')?.addEventListener('click', openModal)
  $('btn-transcribe-cancel')?.addEventListener('click', closeModal)
  $('btn-transcribe-start')?.addEventListener('click', startTranscription)
  $('btn-transcribe-progress-cancel')?.addEventListener('click', cancelActiveJob)
  $('btn-transcript-export')?.addEventListener('click', exportSrt)
  $('btn-transcript-export-vtt')?.addEventListener('click', exportVtt)
  $('btn-transcript-delete')?.addEventListener('click', deleteTranscript)
  $('btn-transcript-sundayedit')?.addEventListener('click', sendToSundayEdit)

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

// ── SundayEdit hand-off (Sunday-suite integration) ───────────────────────────
// Shows the "→ SundayEdit" button only when the integration is enabled AND the
// open file is a video. Reads the opt-in settings each load so toggling them
// in Settings reflects on the next file open.
async function updateSundayEditButton(): Promise<void> {
  const btn = $('btn-transcript-sundayedit') as HTMLElement | null
  if (!btn) return
  let show = false
  try {
    if (currentFilePath && isVideoPath(currentFilePath)) {
      const s = await window.api.getIntegrationSettings()
      show = !!s.enabled && !!s.sundayedit?.enabled
    }
  } catch { show = false }
  btn.style.display = show ? '' : 'none'
}

// Sends the open video to SundayEdit, primed with sermon context + the speaker
// name as a glossary term (improves recognition of the name). Fire-and-forget
// from the user's perspective; SundayEdit returns captions out-of-band.
async function sendToSundayEdit(): Promise<void> {
  if (!currentFilePath) return
  let context = 'Preken'
  const glossary: string[] = []
  try {
    const meta = await window.api.editorReadMeta?.(currentFilePath) as RecordingMetadata | null
    if (meta?.speaker) { context = `Preken. Taler: ${meta.speaker}`; glossary.push(meta.speaker) }
  } catch { /* no metadata — generic context */ }

  const btn = $('btn-transcript-sundayedit') as HTMLButtonElement | null
  try {
    const res = await window.api.sundayEditSend({ videoPath: currentFilePath, context, glossary })
    if (!res.ok && btn) {
      btn.textContent = res.error === 'sundayedit_not_installed'
        ? t('integrations.sundayEditMissing', 'SundayEdit ikke funnet')
        : t('integrations.sundayEditFailed', 'Kunne ikke åpne')
      setTimeout(() => { btn.textContent = '→ SundayEdit' }, 2500)
    }
  } catch {
    if (btn) { btn.textContent = t('integrations.sundayEditFailed', 'Kunne ikke åpne'); setTimeout(() => { btn.textContent = '→ SundayEdit' }, 2500) }
  }
}

/** Called by editor when a file loads — clears state and loads existing sidecar if any. */
export async function loadTranscriptForFile(filePath: string): Promise<void> {
  currentFilePath = filePath
  currentTranscript = null
  renderPanel()
  void updateSundayEditButton()
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
  const exportBtn    = $('btn-transcript-export')     as HTMLElement | null
  const exportVttBtn = $('btn-transcript-export-vtt') as HTMLElement | null
  const deleteBtn    = $('btn-transcript-delete')     as HTMLElement | null

  if (!currentTranscript || currentTranscript.segments.length === 0) {
    body.innerHTML = `<div class="editor-transcript-empty">${t('transcript.empty', 'Ingen transkripsjon ennå. Klikk «Transkriber» for å lage søkbar tekst av talen.')}</div>`
    if (exportBtn)    exportBtn.style.display    = 'none'
    if (exportVttBtn) exportVttBtn.style.display = 'none'
    if (deleteBtn)    deleteBtn.style.display    = 'none'
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
    <div class="editor-transcript-meta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <button class="btn-ghost btn-sm" id="btn-detect-chapters">${t('transcript.detectChapters', '✦ Generer kapitler fra tema')}</button>
      <span id="detect-chapters-hint" style="opacity:.75"></span>
    </div>
    <div class="editor-transcript-segments" id="editor-transcript-segments"></div>
  `

  const detectBtn = $('btn-detect-chapters') as HTMLButtonElement | null
  if (detectBtn) detectBtn.addEventListener('click', generateChaptersFromTranscript)

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

  if (exportBtn)    exportBtn.style.display    = ''
  if (exportVttBtn) exportVttBtn.style.display = ''
  if (deleteBtn)    deleteBtn.style.display    = ''
}

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`
}

/**
 * Generate topic chapters from the transcript. The Rust detector scans each
 * line for Bible references ("Johannes 3:16") and enumeration points ("for det
 * første", "punkt 2") and returns { time, title } markers on the recording's
 * timeline. We MERGE into E.meta.chapters — keeping any manual chapters and
 * skipping detected ones that duplicate an existing marker — then re-render the
 * chapter list + waveform dots. The export embeds these as ID3 CHAP/CTOC.
 */
async function generateChaptersFromTranscript(): Promise<void> {
  if (!currentTranscript || currentTranscript.segments.length === 0) return
  const btn  = $('btn-detect-chapters') as HTMLButtonElement | null
  const hint = $('detect-chapters-hint')
  if (btn) { btn.disabled = true; btn.textContent = t('transcript.detecting', 'Analyserer tema…') }

  const lines = currentTranscript.segments.map(s => ({ start: s.start, text: s.text }))
  // Use the transcript's detected language so English sermons get English
  // Bible-name + point detection (Norwegian otherwise).
  const lang = currentTranscript.language || 'no'
  let detected: Array<{ time: number; title: string }> = []
  try {
    detected = (await window.api.editorDetectChapters(lines, lang)) as Array<{ time: number; title: string }>
  } catch {
    detected = []
  }

  // Merge into the existing chapters, de-duping against markers already present
  // (same title within 2 s, or any chapter within 1 s — manual or re-detected).
  const existing = E.meta.chapters
  let added = 0
  for (const ch of detected) {
    const dup = existing.some(
      e => (e.title === ch.title && Math.abs(e.time - ch.time) < 2) || Math.abs(e.time - ch.time) < 1,
    )
    if (!dup) { existing.push({ time: ch.time, title: ch.title }); added++ }
  }
  existing.sort((a, b) => a.time - b.time)
  E.metaDirty = true
  renderChapterList()
  drawWaveform()

  if (btn) { btn.disabled = false; btn.textContent = t('transcript.detectChapters', '✦ Generer kapitler fra tema') }
  if (hint) {
    hint.textContent =
      added > 0
        ? `${added} ${t('transcript.chaptersAdded', 'kapitler lagt til')}`
        : detected.length > 0
          ? t('transcript.chaptersAllPresent', 'Alle funne kapitler finnes allerede')
          : t('transcript.chaptersNoneFound', 'Fant ingen tema-kapitler i talen')
  }
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
  // Whisper emits no transcription progress to the frontend (only model download
  // does) → show an indeterminate stripe for the transcription phase instead of a
  // bar frozen at 0%. updateProgressUI() switches back to a real bar if a % arrives.
  setProgressIndeterminate()
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
  // Cancel calls are fire-and-forget (IPC return values aren't actionable
  // for us — main process does the actual abort). But the IPC bridge can
  // throw if main is mid-restart (e.g. renderer crashed and reloaded
  // before main re-registered handlers), so wrap both .catch'es to keep
  // the modal close path running even when cancel IPC fails.
  if (activeJobId) {
    void window.api.whisperCancelTranscribe(activeJobId).catch((err: unknown) => {
      console.warn('[transcript] whisperCancelTranscribe failed:', err)
    })
  }
  if (selectedModelId) {
    void window.api.whisperCancelDownload(selectedModelId).catch((err: unknown) => {
      console.warn('[transcript] whisperCancelDownload failed:', err)
    })
  }
  // Always close the modal — even if both cancel calls threw, the user
  // expects the dialog to disappear. A 1.5 s safety timer hard-closes
  // the modal in case some future change introduces a path where
  // closeProgressModal itself blocks (today it's synchronous DOM removal).
  closeProgressModal()
  setTimeout(closeProgressModal, 1500)
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
  // A concrete % arrived (model download, or a future transcribe emitter) →
  // switch from the indeterminate stripe to a real bar.
  if (bar) { bar.classList.remove('progress-indeterminate'); bar.style.width = `${Math.max(0, Math.min(100, percent))}%` }
  if (text) text.textContent = `${Math.round(percent)}%`
}

/** Show an animated indeterminate stripe for a phase whose real % the backend
 *  doesn't report (whisper transcription). Cleared by updateProgressUI when a
 *  concrete % arrives. */
function setProgressIndeterminate(): void {
  const bar = $('transcribe-progress-bar')
  const text = $('transcribe-progress-text')
  if (bar) { bar.style.width = ''; bar.classList.add('progress-indeterminate') }
  if (text) text.textContent = ''
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
  exportSubtitleFile('srt')
}

function exportVtt(): void {
  exportSubtitleFile('vtt')
}

/** Single entry-point for both SRT and VTT export. They share the timing
 *  format up to a single character (`,` vs `.` for milliseconds) and VTT
 *  needs a header line. */
function exportSubtitleFile(fmt: 'srt' | 'vtt'): void {
  if (!currentTranscript || !currentFilePath) return
  const body = fmt === 'srt'
    ? transcriptToSrt(currentTranscript.segments)
    : transcriptToVtt(currentTranscript.segments)
  const baseName = currentFilePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? 'transcript'
  const mime = fmt === 'vtt' ? 'text/vtt' : 'text/plain'
  const blob = new Blob([body], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${baseName}.${fmt}`
  a.click()
  URL.revokeObjectURL(url)
}

function srtTimestamp(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`
}

function vttTimestamp(sec: number): string {
  return srtTimestamp(sec).replace(',', '.')
}

function transcriptToSrt(segs: TranscriptSegment[]): string {
  return segs.map((s, i) => `${i + 1}\n${srtTimestamp(s.start)} --> ${srtTimestamp(s.end)}\n${s.text}\n`).join('\n')
}

function transcriptToVtt(segs: TranscriptSegment[]): string {
  // WebVTT format — supported by HTML5 <track>, YouTube, Vimeo, native iOS/macOS players.
  const cues = segs.map((s, i) => `${i + 1}\n${vttTimestamp(s.start)} --> ${vttTimestamp(s.end)}\n${s.text}\n`).join('\n')
  return `WEBVTT\n\n${cues}`
}
