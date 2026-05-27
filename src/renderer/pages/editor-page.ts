import { t } from '../i18n'
import { settings, patchSettings } from '../state'
import { escHtml as escapeHtml } from '../helpers'
import type { RecordingMetadata } from '../../types'
import { setupTranscriptPanel, loadTranscriptForFile, clearTranscript, setCurrentTranscriptTime } from './editor-transcript'
import { setupThumbPanel, refresh as refreshThumbPanel, panelElementsByPrefix } from './thumbnail-panel'

interface Cut { start: number; end: number }
interface Suggestion { start: number; end: number; duration: number; label: string; type: string }

// ── State ─────────────────────────────────────────────────────────────────
let filePath  = ''
let duration  = 0
let peaks: Float32Array | null = null
let cuts: Cut[] = []
let cutHistory: Cut[][] = []   // undo/redo stack
let cutHistoryIdx = -1         // pointer into cutHistory (-1 = no history yet)
let suggestions: Suggestion[] = []

// Intro/Outro
let introBuffer: AudioBuffer | null = null
let outroBuffer: AudioBuffer | null = null
let introDuration = 0
let outroDuration = 0
let includeIntroOutro = false
// Cached peak arrays for intro/outro (rendered as dimmed waveform on timeline)
let introPeaks: Float32Array | null = null
let outroPeaks: Float32Array | null = null

// Analyze panel display toggles
let showSpeechSegments  = true
let showMusicSegments   = true
let showSilenceSegments = false
let lastAnalyzedAt = 0  // epoch ms; 0 = never analyzed for current file

// Dirty state — tracks whether the editor has unsaved changes (cuts,
// normalize, intro/outro swap, mastering preset, metadata edits, …).
// Cleared on file load and on export complete. Surfaced in the header
// as a small bullet next to the filename.
let editorDirty = false
function markDirty(): void {
  if (editorDirty) return
  editorDirty = true
  updateHeaderSummary()
}
function clearDirty(): void {
  editorDirty = false
  updateHeaderSummary()
}

// Formats always routed to the video editor path (HTML video element + ffmpeg peaks)
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.wmv', '.ts', '.mts', '.m2ts', '.flv', '.3gp', '.asf', '.f4v'])
// Ambiguous containers (can be video or audio) — probe to decide
const PROBE_EXTS = new Set(['.mkv', '.webm', '.mka'])
// Audio formats the browser (Web Audio API) can decode natively
const WEB_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.m4b', '.m4r', '.ogg', '.oga', '.opus', '.webm'])
let isVideoFile      = false
let videoEl: HTMLVideoElement | null = null
let videoIntroPath   = ''
let videoOutroPath   = ''

// Metadata + chapters
let meta: RecordingMetadata = { title: '', speaker: '', description: '', chapters: [] }
let metaDirty = false

// Viewport (seconds visible in main canvas)
let vpStart = 0
let vpEnd   = 0

// Playback
let audioCtx: AudioContext | null = null
let sourceNodes: AudioBufferSourceNode[] = []
let audioBuffer: AudioBuffer | null = null
let playStartCtxTime = 0
let playStartSec     = 0
let isPlaying        = false
let isPreview        = false
let rafId            = 0
let loadSeq          = 0

// Interaction state
let dragStartSec     = -1
let dragEndSec       = -1
let isDragging       = false
let hoverSec         = -99999    // ghost cursor position (extended timeline coords; -99999 = no hover)
let minimapDragging  = false

// Export state
let exportOutputFolder = ''
let publishAfterExport = false  // set by "Eksporter og publiser" button — runs publishing after export completes

// Clipping detection
let clipTimes: number[] = []

// Peak normalization gain (applied to playback + waveform render + export).
// 0 = no normalization. Positive values amplify, negative attenuate.
// Lives in memory only — not persisted across editor sessions (the cuts
// draft sidecar tracks cuts; this gain is recomputed on demand).
let audioGainDb = 0

// Loop playback
let isLooping    = false
let loopStartSec = 0

// Cut handle dragging
interface HandleDrag { cutIdx: number; side: 'start' | 'end' }
let handleDrag: HandleDrag | null = null

// Playhead dragging (drag the playhead triangle)
let playheadDragging = false

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)
let canvas:    HTMLCanvasElement
let minimap:   HTMLCanvasElement
let minimapVp: HTMLElement

// ── Colours (read from CSS variables once) ───────────────────────────────
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// ── Setup ─────────────────────────────────────────────────────────────────
export function setupEditorPage(): void {
  canvas    = $('editor-canvas')  as HTMLCanvasElement
  minimap   = $('editor-minimap') as HTMLCanvasElement
  minimapVp = $('editor-minimap-vp') as HTMLElement
  videoEl   = $('editor-video') as HTMLVideoElement | null

  $('btn-editor-open')?.addEventListener('click',    () => pickAndLoad())
  $('btn-editor-change')?.addEventListener('click',  () => {
    if (!confirmDiscardIfDirty('open')) return
    pickAndLoad()
  })
  $('btn-editor-close')?.addEventListener('click', () => {
    if (!confirmDiscardIfDirty('close')) return
    closeCurrentFile()
  })

  // Empty-state click anywhere on the dropzone opens picker
  $('editor-empty-dropzone')?.addEventListener('click', (e) => {
    // Don't double-fire when the inner button is clicked
    if ((e.target as HTMLElement).closest('button')) return
    pickAndLoad()
  })

  // Empty-state review queue link
  $('editor-empty-review-link')?.addEventListener('click', (e) => {
    e.preventDefault()
    window.showPage('home')
  })

  // Intro/Outro panel header collapses on click of chevron
  $('editor-io-chevron')?.addEventListener('click', () => {
    document.getElementById('editor-io-panel')?.classList.toggle('editor-io-panel--collapsed')
  })
  $('btn-editor-play')?.addEventListener('click',    () => togglePlay(false))
  $('btn-editor-preview')?.addEventListener('click', () => togglePlay(true))
  $('btn-zoom-in')?.addEventListener('click',   () => zoomBy(0.5))
  $('btn-zoom-out')?.addEventListener('click',  () => zoomBy(2))
  $('btn-zoom-fit')?.addEventListener('click',  () => fitAll())
  $('btn-editor-undo-all')?.addEventListener('click', () => {
    if (cuts.length === 0) return
    cuts = []
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
  })

  $('btn-editor-save')?.addEventListener('click',    () => openExportModal())
  $('btn-export-cancel')?.addEventListener('click',  () => closeExportModal())
  $('btn-export-confirm')?.addEventListener('click', () => { publishAfterExport = false; runExport() })
  $('btn-export-and-publish')?.addEventListener('click', () => { publishAfterExport = true; runExport() })
  $('export-publish-configure')?.addEventListener('click', (e) => {
    e.preventDefault()
    closeExportModal()
    // Publish is a tab inside Settings ("settings-publish") — navigate to
    // Settings and let the tab handler land on the right inner page.
    window.showPage('settings')
    document.querySelector<HTMLElement>('.inner-tab[data-tab="settings-publish"]')?.click()
  })

  // Format picker pills
  document.querySelectorAll<HTMLElement>('.export-fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.export-fmt-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      updateExportFormatUI(btn.dataset.fmt ?? 'mp3')
    })
  })

  // Destination picker
  document.querySelectorAll<HTMLElement>('.export-dest-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.export-dest-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      if (btn.dataset.dest === 'folder') {
        const folder = await window.api.editorPickOutputFolder()
        if (folder) {
          ($('export-folder-path') as HTMLElement).textContent = folder
          exportOutputFolder = folder
        } else {
          // Revert to same if cancelled
          document.querySelectorAll('.export-dest-btn').forEach(b => b.classList.remove('active'))
          document.querySelector<HTMLElement>('.export-dest-btn[data-dest="same"]')?.classList.add('active')
        }
      }
    })
  })

  // Peak normalization (Premiere-style "Normalize Max Peaks"): scans the
  // already-decoded peaks array, computes the gain needed to bring max peak
  // to -1 dBFS (1 dB safety headroom), and scales the waveform render +
  // export pipeline accordingly. Idempotent — clicking when already
  // normalized is a no-op.
  $('btn-normalize-peak')?.addEventListener('click', () => {
    if (!peaks || peaks.length === 0) return
    if (audioGainDb !== 0) return     // already normalized — idempotent
    const gain = computePeakGain(peaks)
    if (!isFinite(gain) || Math.abs(gain) < 0.05) {
      // Already at (or above) target — show that explicitly
      setNormalizeUI(0, /*alreadyAtTarget*/ true)
      return
    }
    audioGainDb = gain
    setNormalizeUI(gain, false)
    markDirty()
    updateHeaderSummary()
    drawWaveform()
    drawMinimap()
  })

  $('btn-normalize-reset')?.addEventListener('click', () => {
    if (audioGainDb === 0) return
    audioGainDb = 0
    setNormalizeUI(0, false)
    markDirty()
    updateHeaderSummary()
    drawWaveform()
    drawMinimap()
  })

  $('btn-editor-prompt-open')?.addEventListener('click', () => {
    const fp = ($('editor-prompt-toast') as HTMLElement).dataset.path ?? ''
    dismissEditorPrompt()
    if (fp) openEditorWithFile(fp)
  })
  $('btn-editor-prompt-dismiss')?.addEventListener('click', dismissEditorPrompt)

  // Intro/Outro controls
  const ioChk = $('editor-include-io') as HTMLInputElement | null
  if (ioChk) {
    ioChk.addEventListener('change', () => {
      includeIntroOutro = ioChk.checked
      markDirty()
      drawWaveform()
    })
  }

  $('btn-editor-pick-intro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (!fp) return
    patchSettings({ editorIntroPath: fp })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
    markDirty()
  })
  $('btn-editor-clear-intro')?.addEventListener('click', async () => {
    patchSettings({ editorIntroPath: undefined })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
    markDirty()
  })
  $('btn-editor-pick-outro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (!fp) return
    patchSettings({ editorOutroPath: fp })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
    markDirty()
  })
  $('btn-editor-clear-outro')?.addEventListener('click', async () => {
    patchSettings({ editorOutroPath: undefined })
    await window.api.saveSettings(settings)
    await reloadIntroOutro()
    markDirty()
  })

  // Video intro/outro buttons
  $('btn-editor-pick-video-intro')?.addEventListener('click', async () => {
    const fp = await window.api.editorPickVideoFile()
    if (!fp) return
    videoIntroPath = fp
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-clear-video-intro')?.addEventListener('click', () => {
    videoIntroPath = ''
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-pick-video-outro')?.addEventListener('click', async () => {
    const fp = await window.api.editorPickVideoFile()
    if (!fp) return
    videoOutroPath = fp
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-clear-video-outro')?.addEventListener('click', () => {
    videoOutroPath = ''
    updateVideoIntroOutroDisplay()
  })

  // Metadata panel toggle
  $('btn-meta-toggle')?.addEventListener('click', () => {
    const body = $('editor-meta-body')
    if (!body) return
    const open = body.style.display === 'none'
    body.style.display = open ? '' : 'none'
    $('editor-meta-chevron')?.classList.toggle('open', open)
  })

  // Metadata autosave on change
  const metaFields: [string, keyof RecordingMetadata][] = [
    ['meta-title', 'title'], ['meta-speaker', 'speaker'], ['meta-description', 'description']
  ]
  for (const [id, field] of metaFields) {
    $(id)?.addEventListener('input', () => {
      const el = $(id) as HTMLInputElement | HTMLTextAreaElement | null
      if (el) (meta as unknown as Record<string, unknown>)[field] = el.value
      metaDirty = true
      markDirty()
    })
  }

  // Analyse panel: run detection
  $('btn-detect-segments')?.addEventListener('click', () => runDetection())

  // Analyse panel: segment-type toggles
  $('editor-show-speech')?.addEventListener('change', () => {
    showSpeechSegments = ($('editor-show-speech') as HTMLInputElement).checked
    drawWaveform()
  })
  $('editor-show-music')?.addEventListener('change', () => {
    showMusicSegments = ($('editor-show-music') as HTMLInputElement).checked
    drawWaveform()
  })
  $('editor-show-silence')?.addEventListener('change', () => {
    showSilenceSegments = ($('editor-show-silence') as HTMLInputElement).checked
    drawWaveform()
  })

  // Analyse panel: "Marker preken automatisk"
  $('btn-apply-auto-trim')?.addEventListener('click', () => applySermonTrim())
  $('btn-suggestion-apply')?.addEventListener('click', () => {
    applySermonTrim()
    hideSuggestionBanner()
  })
  $('btn-suggestion-dismiss')?.addEventListener('click', () => hideSuggestionBanner())
  $('editor-sermon-picker')?.addEventListener('change', (e) => {
    const idx = parseInt((e.target as HTMLSelectElement).value, 10)
    if (!isNaN(idx)) setSermonSegment(idx)
  })

  // Meta save button
  $('btn-meta-save')?.addEventListener('click', saveMetadata)

  // Loop toggle
  $('btn-editor-loop')?.addEventListener('click', () => {
    isLooping = !isLooping
    $('btn-editor-loop')?.classList.toggle('active', isLooping)
  })

  // Clip badge — jump to first clip
  $('editor-clip-badge')?.addEventListener('click', () => {
    if (clipTimes.length === 0) return
    playStartSec = Math.max(0, clipTimes[0] - 1)
    updateTimecode(playStartSec)
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, playStartSec - half * 0.3)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
    drawWaveform()
  })

  // Export progress listener
  window.api.on('editor-export-progress', (data: unknown) => {
    const { percent } = data as { percent: number }
    const bar   = $('editor-export-progress-bar')
    const label = $('editor-export-progress-label')
    if (bar)   bar.style.width   = Math.min(99, percent) + '%'
    if (label) label.textContent = `Eksporterer… ${Math.round(percent)}%`
  })

  // Mastering wiring
  setupMasteringPanel()

  // Canvas interactions
  canvas?.addEventListener('mousedown',   onCanvasDown)
  canvas?.addEventListener('mousemove',   onCanvasMove)
  canvas?.addEventListener('mouseup',     onCanvasUp)
  canvas?.addEventListener('mouseleave',  onCanvasLeave)
  canvas?.addEventListener('contextmenu', onCanvasContextMenu)
  canvas?.addEventListener('wheel',       onCanvasWheel, { passive: false })
  // Double-click on the sermon segment → trim around the sermon. Forces a
  // deliberate double-tap so single-click stays as non-destructive tap-to-seek.
  canvas?.addEventListener('dblclick', (e: MouseEvent) => {
    if (!peaks) return
    const rect = canvas.getBoundingClientRect()
    const sec = xToSec(e.clientX - rect.left, rect.width)
    const sermon = suggestions.find(s => s.type === 'sermon' && sec >= s.start && sec <= s.end)
    if (sermon) applySermonTrim()
  })

  setupMinimapInteraction()
  setupKeyboardShortcuts()
  const seekToSec = (sec: number): void => {
    playStartSec = clampPlayable(snapOutOfCut(sec))
    updateTimecode(playStartSec)
    if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
    drawWaveform()
  }
  setupTranscriptPanel(seekToSec)
  setupDragDrop()
  setupReviewBanner()

  if (canvas && canvas.parentElement) {
    // Track the observer so repeated setupEditorPage() calls (after a renderer
    // reload, for example) don't leak observers. Single observer for app life.
    if (resizeObserver) resizeObserver.disconnect()
    resizeObserver = new ResizeObserver(() => { syncCanvasSize(); drawWaveform() })
    resizeObserver.observe(canvas.parentElement)
  }

  showState('empty')
  updateEditorIntroOutroDisplay()

  // Wire the per-episode thumbnail panel. Hidden until a file is loaded
  // (see loadFile completion). Reads window state via getRecordingPath().
  const thumbEls = panelElementsByPrefix('editor')
  if (thumbEls) {
    setupThumbPanel(thumbEls, { kind: 'episode', getRecordingPath: () => filePath })
  }
}

let resizeObserver: ResizeObserver | null = null

export function openEditorWithFile(fp: string, seekToSec?: number): void {
  reviewPrepId = null
  loadAndUpdateReviewBanner()
  window.showPage('editor')
  pendingSeekSec = typeof seekToSec === 'number' ? seekToSec : null
  loadFile(fp)
}

// Set by openEditorWithFile when the caller wants the editor to jump to a
// specific timestamp once the file finishes loading. Consumed at the tail of
// loadFile(). The CustomEvent path was racy because loadFile zeroes
// playStartSec mid-flight; this gives us a deterministic "apply once decoded".
let pendingSeekSec: number | null = null

// ── Review mode state (prep-and-review v5.0) ──────────────────────────────
// When non-null, the editor is in "review mode" — it pre-applies suggested
// cuts/preset/jingles from the queue entry and shows the green publish banner.
let reviewPrepId: string | null = null
let reviewPrep: import('../../types').EpisodePrep | null = null

/**
 * Entry point from the home-page review queue. Opens the editor, loads the
 * recording, pre-applies the suggested sermon trim as cuts (cut before
 * suggestedTrim.startSec + cut after suggestedTrim.endSec), pre-selects the
 * mastering preset, and surfaces a "Klargjort for publisering" banner with
 * the three big action buttons.
 */
export async function openEditorReviewMode(prepId: string, filePath: string): Promise<void> {
  reviewPrepId = prepId
  try {
    const entry = await window.api.reviewQueueGet(prepId)
    reviewPrep = entry?.prep ?? null
  } catch {
    reviewPrep = null
  }
  loadAndUpdateReviewBanner()
  window.showPage('editor')
  await loadFile(filePath)
  // After loadFile sets `duration`, apply the suggested trim as cuts. We have
  // to wait one tick for showState('workspace') and the canvas to settle.
  requestAnimationFrame(() => applyReviewModeDefaults())
}

function applyReviewModeDefaults(): void {
  if (!reviewPrep || !duration) return
  const trim = reviewPrep.suggestedTrim
  // Pre-apply the suggested trim as cuts (everything before + after).
  if (trim && trim.endSec > trim.startSec) {
    cuts = []
    if (trim.startSec > 0.5) {
      cuts.push({ start: 0, end: Math.min(trim.startSec, duration) })
    }
    if (trim.endSec < duration - 0.5) {
      cuts.push({ start: Math.max(0, trim.endSec), end: duration })
    }
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
  }
  // Pre-select master preset
  const presetSel = $('editor-master-preset') as HTMLSelectElement | null
  if (presetSel && reviewPrep.masterPreset) {
    presetSel.value = reviewPrep.masterPreset
    presetSel.dispatchEvent(new Event('change'))
  }
}

function loadAndUpdateReviewBanner(): void {
  const banner = $('editor-review-banner')
  if (!banner) return
  banner.style.display = reviewPrepId ? '' : 'none'

  if (!reviewPrep || !reviewPrepId) return

  // Attention reasons block
  const attention = $('editor-review-attention')
  if (attention) {
    const reasons = reviewPrep.attentionReasons ?? []
    if (reasons.length > 0) {
      attention.innerHTML = '<strong>⚠ Trenger oppmerksomhet:</strong><ul style="margin:4px 0 0 18px;padding:0">' +
        reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('') + '</ul>'
      attention.style.display = ''
    } else {
      attention.style.display = 'none'
    }
  }

  // Banner detail
  const detail = $('editor-review-banner-detail')
  if (detail) {
    if (reviewPrep.suggestedTrim) {
      const lenMin = Math.round((reviewPrep.suggestedTrim.endSec - reviewPrep.suggestedTrim.startSec) / 60)
      detail.textContent = t('review.detectedSermon', 'Vi har detektert {min} min preken og foreslått trim. Gå over og trykk publiser.').replace('{min}', String(lenMin))
    } else {
      detail.textContent = t('review.noSermonFound', 'Vi fant ingen klar preken-blokk. Sjekk filen før publisering.')
    }
  }

  // Jingle dropdowns reflect current prep state
  const introSel = $('editor-review-intro-select') as HTMLSelectElement | null
  const outroSel = $('editor-review-outro-select') as HTMLSelectElement | null
  const introLbl = $('editor-review-intro-label')
  const outroLbl = $('editor-review-outro-label')
  if (introSel) {
    const ip = reviewPrep.introPath
    introSel.value = ip == null ? 'none' : (ip === settings.editorIntroPath ? 'default' : 'custom')
    if (introLbl) introLbl.textContent = ip ? ip.split(/[/\\]/).pop() ?? '' : ''
  }
  if (outroSel) {
    const op = reviewPrep.outroPath
    outroSel.value = op == null ? 'none' : (op === settings.editorOutroPath ? 'default' : 'custom')
    if (outroLbl) outroLbl.textContent = op ? op.split(/[/\\]/).pop() ?? '' : ''
  }
}

function setupReviewBanner(): void {
  $('btn-review-publish')?.addEventListener('click', async () => {
    if (!reviewPrepId) return
    const btn = $('btn-review-publish') as HTMLButtonElement | null
    if (!btn) return
    // Idempotency: disable immediately on first click
    if (btn.disabled) return
    btn.disabled = true
    const orig = btn.textContent
    btn.textContent = 'Publiserer…'
    try {
      const r = await window.api.reviewQueuePublish(reviewPrepId)
      if (r.ok) {
        btn.textContent = '✓ Publisert!'
        setTimeout(() => {
          reviewPrepId = null
          reviewPrep = null
          loadAndUpdateReviewBanner()
          window.showPage('home')
        }, 1500)
      } else {
        btn.disabled = false
        btn.textContent = orig
        alert(`Kunne ikke publisere: ${r.error ?? 'ukjent feil'}`)
      }
    } catch (err) {
      btn.disabled = false
      btn.textContent = orig
      alert(`Kunne ikke publisere: ${(err as Error).message}`)
    }
  })

  $('btn-review-edit')?.addEventListener('click', () => {
    // Drop the review banner so the user gets the normal editor — the file
    // and cuts stay loaded, they just lose the publish-button shortcut.
    reviewPrepId = null
    loadAndUpdateReviewBanner()
  })

  $('btn-review-discard')?.addEventListener('click', async () => {
    if (!reviewPrepId) return
    if (!confirm('Forkast denne episoden? Selve opptaket beholdes, men det vil ikke publiseres.')) return
    await window.api.reviewQueueDiscard(reviewPrepId)
    reviewPrepId = null
    reviewPrep = null
    loadAndUpdateReviewBanner()
    window.showPage('home')
  })

  // Jingle selectors
  $('editor-review-intro-select')?.addEventListener('change', async () => {
    if (!reviewPrepId) return
    const sel = $('editor-review-intro-select') as HTMLSelectElement
    let introPath: string | null | undefined
    if (sel.value === 'default') introPath = settings.editorIntroPath ?? null
    else if (sel.value === 'none') introPath = null
    else {
      const fp = await window.api.pickAudioFile()
      if (!fp) { sel.value = reviewPrep?.introPath ? 'custom' : 'default'; return }
      introPath = fp
    }
    await window.api.reviewQueueUpdateJingles(reviewPrepId, { introPath })
    if (reviewPrep) reviewPrep.introPath = introPath ?? undefined
    loadAndUpdateReviewBanner()
  })

  $('editor-review-outro-select')?.addEventListener('change', async () => {
    if (!reviewPrepId) return
    const sel = $('editor-review-outro-select') as HTMLSelectElement
    let outroPath: string | null | undefined
    if (sel.value === 'default') outroPath = settings.editorOutroPath ?? null
    else if (sel.value === 'none') outroPath = null
    else {
      const fp = await window.api.pickAudioFile()
      if (!fp) { sel.value = reviewPrep?.outroPath ? 'custom' : 'default'; return }
      outroPath = fp
    }
    await window.api.reviewQueueUpdateJingles(reviewPrepId, { outroPath })
    if (reviewPrep) reviewPrep.outroPath = outroPath ?? undefined
    loadAndUpdateReviewBanner()
  })
}

/** Called when the user navigates BACK to the editor tab. Repaints the
 *  waveform if a file is still loaded — the canvas might have been resized
 *  or had its backing store cleared while away. Cheap no-op if no file. */
export function reactivateEditor(): void {
  if (!peaks) return
  // Re-sync canvas size first (could've changed if window resized while away)
  requestAnimationFrame(() => {
    syncCanvasSize()
    drawWaveform()
    drawMinimap()
    updateMinimapViewport()
  })
}

/** Called when the user navigates away from the editor tab.
 *
 *  IMPORTANT: We only PAUSE/STOP work that runs in the background — playback
 *  and video. We do NOT release peaks, audioBuffer, audioCtx, cuts, meta, or
 *  any of the editing state. Otherwise, returning to the editor with the same
 *  file open shows an empty waveform — the user has to close and re-open the
 *  file to see anything. (Reported bug, May 2026.)
 *
 *  Actual cleanup happens in closeCurrentFile() (explicit close-button or
 *  Cmd+W) and at loadFile() entry (replacing one file with another). */
export function deactivateEditor(): void {
  stopPlay()
  // Pause video element to release decode/GPU resources, but keep the src
  // so the frame is still there when the user returns.
  if (videoEl && !videoEl.paused) {
    videoEl.pause()
  }
  // Note: deliberately NOT touching peaks / audioBuffer / audioCtx / cuts /
  // cutHistory / suggestions / clipTimes / meta / isVideoFile / audioGainDb /
  // reviewPrepId. Those are owned by the open-file lifecycle, not the
  // tab-visibility lifecycle.
  reviewPrep = null
  loadAndUpdateReviewBanner()
}

// ── File loading ──────────────────────────────────────────────────────────
async function pickAndLoad(): Promise<void> {
  const fp = await window.api.editorPickFile()
  if (fp) loadFile(fp)
}

/**
 * Fallback loader for huge audio files that would crash decodeAudioData.
 * Uses the ffmpeg-extract path (8 kHz mono WAV) — phone-call quality, but
 * sufficient for waveform display and cut selection. Sets audioBuffer,
 * peaks, duration. Returns false if the load failed.
 */
async function loadViaFfmpegExtract(fp: string, seq: number): Promise<boolean> {
  const result = await window.api.editorExtractAudioPeaks(fp) as { data: Uint8Array | ArrayBuffer; duration: number } | null
  if (seq !== loadSeq) return false
  if (!result) { showState('empty'); return false }

  const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

  let localCtx: AudioContext | null = null
  try {
    localCtx = new AudioContext()
    const buf = await localCtx.decodeAudioData(ab)
    if (seq !== loadSeq) { localCtx.close().catch(() => {}); return false }
    audioCtx    = localCtx
    audioBuffer = buf
    duration    = result.duration > 0 ? result.duration : buf.duration
    peaks       = computePeaks(audioBuffer)
    return true
  } catch {
    localCtx?.close().catch(() => {})
    showState('empty')
    return false
  }
}

async function loadFile(fp: string): Promise<void> {
  const seq = ++loadSeq
  stopPlay()
  const prevCtx = audioCtx
  audioCtx = null
  // Await the close — fire-and-forget could leave an old context partially
  // alive while a new one is created. The seq-guard further down still
  // catches cases where two loadFile calls overlap, but awaiting close()
  // here means we never have two contexts processing audio at once.
  if (prevCtx) {
    try { await prevCtx.close() } catch {}
    // Bail out if a newer load started while we were closing the old context.
    if (seq !== loadSeq) return
  }

  cuts = []
  cutHistory = []
  cutHistoryIdx = -1
  suggestions = []
  filePath = fp
  peaks = null
  audioBuffer = null
  playStartSec = 0
  meta = { title: '', speaker: '', description: '', chapters: [] }
  metaDirty = false
  // Fresh file → drop any previous peak-normalize gain and reset the UI.
  audioGainDb = 0
  setNormalizeUI(0, false)
  lastAnalyzedAt = 0
  renderAnalyzePanel()
  // Fresh file → not dirty
  clearDirty()

  showState('loading')

  // Determine if this is a video file
  const ext = ('.' + (fp.split('.').pop()?.toLowerCase() ?? '')).toLowerCase()
  if (PROBE_EXTS.has(ext)) {
    // Ambiguous container: probe for a video stream
    const streams = await window.api.editorProbeStreams(fp)
    isVideoFile = !streams || streams.hasVideo
  } else {
    isVideoFile = VIDEO_EXTS.has(ext)
  }

  // Show/hide video panel and video intro/outro section
  const vPanel = $('editor-video-panel')
  if (vPanel) vPanel.style.display = isVideoFile ? '' : 'none'

  const audioIoSection = $('editor-audio-io-section')
  const videoIoSection = $('editor-video-io-section')
  if (audioIoSection) audioIoSection.style.display = isVideoFile ? 'none' : ''
  if (videoIoSection) videoIoSection.style.display = isVideoFile ? '' : 'none'

  if (isVideoFile) {
    // Set video source via custom protocol (registered with registerSchemesAsPrivileged)
    await window.api.editorSetVideoPath(fp)
    if (videoEl) {
      videoEl.src = 'media://current?t=' + Date.now()
      videoEl.load()
    }

    // Extract audio at low sample rate for waveform display
    const result = await window.api.editorExtractAudioPeaks(fp) as { data: Uint8Array | ArrayBuffer; duration: number } | null

    if (seq !== loadSeq) return

    if (result) {
      const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

      let localCtx: AudioContext | null = null
      try {
        localCtx = new AudioContext()
        const buf = await localCtx.decodeAudioData(ab)
        if (seq !== loadSeq) { localCtx.close().catch(() => {}); return }
        audioCtx    = localCtx
        audioBuffer = buf
        duration    = result.duration > 0 ? result.duration : buf.duration
        peaks       = computePeaks(audioBuffer)
      } catch (err) {
        console.warn('[editor] audio decode failed for video file, trying video-only mode', err)
        localCtx?.close().catch(() => {})
        // Fall through to video-only mode below
      }
    }

    // Video-only mode: no audio track (or decode failed) — get duration from video element
    if (!audioBuffer) {
      try {
        duration = await new Promise<number>((resolve, reject) => {
          if (!videoEl) { reject(new Error('no video element')); return }
          if (videoEl.readyState >= 1 && isFinite(videoEl.duration)) {
            resolve(videoEl.duration); return
          }
          const onMeta  = () => { videoEl?.removeEventListener('error', onErr); resolve(videoEl?.duration ?? 0) }
          const onErr   = () => { videoEl?.removeEventListener('loadedmetadata', onMeta); reject(new Error('video error')) }
          videoEl.addEventListener('loadedmetadata', onMeta, { once: true })
          videoEl.addEventListener('error', onErr, { once: true })
          setTimeout(() => {
            videoEl?.removeEventListener('loadedmetadata', onMeta)
            videoEl?.removeEventListener('error', onErr)
            reject(new Error('timeout waiting for video metadata'))
          }, 15000)
        })
        if (seq !== loadSeq) return
        // Flat/empty peaks — waveform shows as a thin line
        peaks = new Float32Array(Math.ceil(duration * 100))
        console.log('[editor] video-only mode, duration:', duration.toFixed(1) + 's')
      } catch (err) {
        console.error('[editor] could not determine video duration:', err)
        showEditorError('Kunne ikke laste videofil — filen er kanskje korrupt')
        showState('empty')
        return
      }
    }
  } else if (WEB_AUDIO_EXTS.has(ext)) {
    // Browser-decodable audio: read raw bytes → Web Audio API.
    // Files above EDITOR_INLINE_LIMIT (400 MB) come back as { tooLarge: true }
    // and we fall through to the ffmpeg-extract path so we don't OOM the
    // renderer (Web Audio decodes to 32-bit float — a 1 GB FLAC = 5+ GB PCM).
    const raw = await window.api.editorReadFile(fp) as unknown
    if (!raw) { showState('empty'); return }

    if (typeof raw === 'object' && raw !== null && 'tooLarge' in raw && (raw as { tooLarge: boolean }).tooLarge) {
      console.log('[editor] file too large for Web Audio, using ffmpeg-extract path')
      const ok = await loadViaFfmpegExtract(fp, seq)
      if (!ok) return
    } else {
      const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      const ab  = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

      let localCtx: AudioContext | null = null
      try {
        localCtx = new AudioContext()
        const buf = await localCtx.decodeAudioData(ab)
        if (seq !== loadSeq) { localCtx.close().catch(() => {}); return }
        audioCtx    = localCtx
        audioBuffer = buf
        duration    = audioBuffer.duration
        peaks       = computePeaks(audioBuffer)
      } catch {
        localCtx?.close().catch(() => {})
        showState('empty')
        return
      }
    }
  } else {
    // Exotic audio (wma, ape, flac-in-mka, ac3, amr, etc.):
    // Browser cannot decode these — extract via ffmpeg at 8 kHz mono.
    // The resulting WAV is decodable by Web Audio API and serves as both
    // waveform source and playback buffer (phone-call quality, adequate for cut-finding).
    const result = await window.api.editorExtractAudioPeaks(fp) as { data: Uint8Array | ArrayBuffer; duration: number } | null
    if (seq !== loadSeq) return
    if (!result) { showState('empty'); return }

    const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

    let localCtx: AudioContext | null = null
    try {
      localCtx = new AudioContext()
      const buf = await localCtx.decodeAudioData(ab)
      if (seq !== loadSeq) { localCtx.close().catch(() => {}); return }
      audioCtx    = localCtx
      audioBuffer = buf
      duration    = result.duration > 0 ? result.duration : buf.duration
      peaks       = computePeaks(audioBuffer)
    } catch {
      localCtx?.close().catch(() => {})
      showState('empty')
      return
    }
  }

  fitAll()
  const fname = fp.split(/[/\\]/).pop() ?? fp
  const el = $('editor-filename')
  if (el) el.textContent = fname
  // Refresh header summary now that duration/cut state is known
  updateHeaderSummary()

  // Load intro/outro buffers from settings (non-blocking, audio only)
  if (!isVideoFile) loadIntroOutroBuffers(seq)

  // Load metadata sidecar
  loadMetadataSidecar(fp, fname)
  void loadTranscriptForFile(fp)

  // Restore unsaved cuts from a previous editing session that ended abruptly.
  // The sidecar is written every 2 s during editing and cleared on successful
  // export — finding one here means we crashed or were closed mid-edit.
  try {
    const draft = await window.api.editorReadCutsDraft(fp) as { cuts?: Array<{ start: number; end: number }>; ts?: number } | null
    if (draft && Array.isArray(draft.cuts) && draft.cuts.length > 0 && seq === loadSeq) {
      // Only restore if draft is fresher than 7 days (avoid surprising the user
      // with months-old leftover edits).
      const ageMs = draft.ts ? Date.now() - draft.ts : 0
      if (!draft.ts || ageMs < 7 * 86400_000) {
        cuts = draft.cuts.filter(c => typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)
        cutHistory = [JSON.parse(JSON.stringify(cuts))]
        cutHistoryIdx = 0
        console.log('[editor] restored', cuts.length, 'unsaved cut(s) from draft')
      }
    }
  } catch {}

  renderCutList()
  updateRemainingDisplay()
  updateTimecode(0)
  updateTotalTime()

  // Default `Inkluder ved eksport` to ON when the user has at least one
  // intro/outro path configured — they almost always want their jingles
  // included, and showing the dimmed waveform on the timeline is the
  // whole point of the new layout.
  if (settings.editorIntroPath || settings.editorOutroPath) {
    includeIntroOutro = true
    const chk = $('editor-include-io') as HTMLInputElement | null
    if (chk) chk.checked = true
  }

  // Clipping badge (shown after computePeaks)
  const clipBadge = $('editor-clip-badge')
  if (clipBadge) {
    clipBadge.style.display = clipTimes.length > 0 ? '' : 'none'
    if (clipTimes.length > 0) clipBadge.textContent = `⚠ ${clipTimes.length} klipp`
  }

  showState('workspace')
  requestAnimationFrame(() => {
    syncCanvasSize()
    drawWaveform()
    drawMinimap()
    updateMinimapViewport()
  })

  if (pendingSeekSec != null) {
    const target = pendingSeekSec
    pendingSeekSec = null
    playStartSec = clampPlayable(snapOutOfCut(target))
    updateTimecode(playStartSec)
    if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
    drawWaveform()
  }

  // Mastering section is only meaningful for audio files (the entire ffmpeg
  // pipeline + LUFS measurement is audio-only; mastering a video would not
  // touch the video stream and would just re-encode the audio track).
  const masterSection = $('editor-master-section')
  if (masterSection) masterSection.style.display = isVideoFile ? 'none' : ''

  // Thumbnail panel — show for audio files; embedding only works for MP3 but
  // the panel still lets the user attach a sidecar image for RSS-feed hosts.
  const thumbSection = $('editor-thumb-section')
  if (thumbSection) thumbSection.style.display = isVideoFile ? 'none' : ''
  if (!isVideoFile) {
    const els = panelElementsByPrefix('editor')
    if (els) void refreshThumbPanel(els, { kind: 'episode', getRecordingPath: () => filePath })
  }

  // Auto-run segment analysis. Runs in the background so the editor is
  // immediately interactive — when analysis completes we surface the
  // auto-trim suggestion banner so the user can one-click prep a podcast
  // episode. Skipped if cuts were restored from a draft (they're already
  // editing) or if the user is in review-mode (handled separately).
  if (!isVideoFile && cuts.length === 0 && !reviewPrepId) {
    // Defer slightly so the workspace UI paints first.
    setTimeout(() => { void runDetection(true) }, 200)
  }
}

async function reloadIntroOutro(): Promise<void> {
  await loadIntroOutroBuffers(loadSeq)
}

async function loadIntroOutroBuffers(seq: number): Promise<void> {
  const introPath = settings.editorIntroPath
  const outroPath = settings.editorOutroPath
  introBuffer = null; introDuration = 0; introPeaks = null
  outroBuffer = null; outroDuration = 0; outroPeaks = null

  updateEditorIntroOutroDisplay()

  async function decodeAudio(path: string): Promise<AudioBuffer | null> {
    try {
      const raw = await window.api.editorReadFile(path)
      if (!raw) return null
      const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      const tmpCtx = new AudioContext()
      const buf = await tmpCtx.decodeAudioData(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer)
      tmpCtx.close().catch(() => {})
      return buf
    } catch { return null }
  }

  if (introPath) {
    const buf = await decodeAudio(introPath)
    if (seq === loadSeq && buf) {
      introBuffer = buf
      introDuration = buf.duration
      // Compute peaks via the same routine used for the main file — gives
      // a dimmed waveform on the left slot of the timeline.
      introPeaks = computeJinglePeaks(buf)
    }
  }
  if (outroPath) {
    const buf = await decodeAudio(outroPath)
    if (seq === loadSeq && buf) {
      outroBuffer = buf
      outroDuration = buf.duration
      outroPeaks = computeJinglePeaks(buf)
    }
  }
  if (seq === loadSeq) drawWaveform()
}

/**
 * Compute peaks for an intro/outro AudioBuffer at 100 Hz (matching the
 * main-file peak rate). We can't reuse computePeaks() directly because
 * that also resets the clip-time array — which we want to keep tied to
 * the main recording only. So this is a slimmed copy: same algorithm,
 * no clip tracking, no side effects.
 */
function computeJinglePeaks(buf: AudioBuffer): Float32Array {
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.max(1, Math.floor(buf.sampleRate / RATE))
  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
  }
  return out
}

function updateVideoIntroOutroDisplay(): void {
  const introEl  = $('editor-video-intro-display')
  const outroEl  = $('editor-video-outro-display')
  const clrIntro = $('btn-editor-clear-video-intro') as HTMLElement | null
  const clrOutro = $('btn-editor-clear-video-outro') as HTMLElement | null
  if (introEl) {
    const name = videoIntroPath.split(/[/\\]/).pop() ?? ''
    introEl.textContent = name || 'Ingen fil valgt'
    introEl.style.color = name ? '' : 'var(--text3)'
    if (clrIntro) clrIntro.style.display = name ? '' : 'none'
  }
  if (outroEl) {
    const name = videoOutroPath.split(/[/\\]/).pop() ?? ''
    outroEl.textContent = name || 'Ingen fil valgt'
    outroEl.style.color = name ? '' : 'var(--text3)'
    if (clrOutro) clrOutro.style.display = name ? '' : 'none'
  }
}

function updateEditorIntroOutroDisplay(): void {
  const introEl  = $('editor-intro-display')
  const outroEl  = $('editor-outro-display')
  const clrIntro = $('btn-editor-clear-intro') as HTMLElement | null
  const clrOutro = $('btn-editor-clear-outro') as HTMLElement | null
  const introPath = settings.editorIntroPath
  const outroPath = settings.editorOutroPath
  if (introEl) {
    const name = introPath?.split(/[/\\]/).pop() ?? ''
    introEl.textContent = name || 'Ingen fil valgt'
    introEl.style.color = name ? '' : 'var(--text3)'
    if (clrIntro) clrIntro.style.display = name ? '' : 'none'
  }
  if (outroEl) {
    const name = outroPath?.split(/[/\\]/).pop() ?? ''
    outroEl.textContent = name || 'Ingen fil valgt'
    outroEl.style.color = name ? '' : 'var(--text3)'
    if (clrOutro) clrOutro.style.display = name ? '' : 'none'
  }
}

async function loadMetadataSidecar(fp: string, fname: string): Promise<void> {
  const raw = await window.api.editorReadMeta(fp)
  if (raw && typeof raw === 'object') {
    meta = raw as RecordingMetadata
  } else {
    // Auto-fill title from filename (strip extension)
    meta = {
      title: fname.replace(/\.[^.]+$/, '').replace(/_redigert(_\d+)?$/, '').replace(/_/g, ' '),
      speaker: '',
      description: '',
      chapters: [],
    }
  }
  renderMetaPanel()
  renderChapterList()
}

async function saveMetadata(): Promise<void> {
  if (!filePath) return
  await window.api.editorSaveMeta(filePath, meta)
  metaDirty = false
  const btn = $('btn-meta-save')
  if (btn) { btn.textContent = '✓ Lagret'; setTimeout(() => { btn.textContent = 'Lagre metadata' }, 1500) }
}

function renderMetaPanel(): void {
  const titleEl = $('meta-title') as HTMLInputElement | null
  const spkEl   = $('meta-speaker') as HTMLInputElement | null
  const descEl  = $('meta-description') as HTMLTextAreaElement | null
  if (titleEl) titleEl.value = meta.title
  if (spkEl)   spkEl.value   = meta.speaker
  if (descEl)  descEl.value  = meta.description
}

function renderChapterList(): void {
  const list = $('chapter-list')
  if (!list) return
  list.innerHTML = ''
  const countEl = $('editor-chapter-count')
  if (countEl) {
    countEl.textContent = String(meta.chapters.length)
    countEl.style.display = meta.chapters.length ? '' : 'none'
  }
  if (meta.chapters.length === 0) {
    list.innerHTML = `<div class="editor-chapters-empty">${t('editor.chaptersEmpty', 'Ingen kapitler ennå. Klikk «+ Legg til ved playhead» for å starte.')}</div>`
    return
  }
  for (let i = 0; i < meta.chapters.length; i++) {
    const ch = meta.chapters[i]
    const row = document.createElement('div')
    row.className = 'editor-chapter-row'

    const timeLbl = document.createElement('span')
    timeLbl.className = 'editor-chapter-time'
    timeLbl.textContent = formatTime(ch.time)
    timeLbl.title = t('editor.chapterClickSeek', 'Klikk for å søke')
    timeLbl.addEventListener('click', () => { playStartSec = ch.time; updateTimecode(ch.time); drawWaveform() })

    const nameInput = document.createElement('input')
    nameInput.className = 'editor-chapter-name'
    nameInput.value = ch.title
    nameInput.addEventListener('input', () => {
      meta.chapters[i].title = nameInput.value
      metaDirty = true
      drawWaveform()
    })

    const delBtn = document.createElement('button')
    delBtn.className = 'editor-chapter-del'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => {
      meta.chapters.splice(i, 1)
      metaDirty = true
      renderChapterList()
      drawWaveform()
    })

    row.appendChild(timeLbl)
    row.appendChild(nameInput)
    row.appendChild(delBtn)
    list.appendChild(row)
  }
}

// ── Segment detection ─────────────────────────────────────────────────────

/** Per-type visibility filter for segments. Sermon (the highlighted
 *  suggested-keep range) is always visible — it's the most actionable
 *  outcome of analysis. Speech / music / silence honour the user's toggles. */
function shouldShowSegment(type: string): boolean {
  if (type === 'sermon') return true
  if (type === 'speech') return showSpeechSegments
  if (type === 'music')  return showMusicSegments
  if (type === 'silence') return showSilenceSegments
  // mixed / unknown → render only if speech is on (closest match)
  return showSpeechSegments
}

/** Runs segment detection. `auto` = true skips the button-disabled UI dance
 *  (used for auto-run after file load — we don't want to spook the user with
 *  a disabled button they didn't click). */
async function runDetection(auto = false): Promise<void> {
  if (!filePath) return
  const btn       = $('btn-detect-segments') as HTMLButtonElement | null
  const analyzing = $('editor-segments-analyzing')
  if (!auto && btn) { btn.disabled = true; btn.textContent = t('editor.analyzing', 'Analyserer…') }
  if (analyzing)   analyzing.style.display = ''

  suggestions = []
  renderAnalyzePanel()
  hideSuggestionBanner()

  const fpAtStart = filePath
  let raw: Suggestion[] = []
  try {
    raw = (await window.api.editorDetectSegments(filePath)) as Suggestion[]
  } catch {
    raw = []
  }
  // Guard against the user closing/swapping the file mid-analysis: drop the
  // result if we're no longer on the same recording.
  if (fpAtStart !== filePath) return

  suggestions = raw
  lastAnalyzedAt = Date.now()

  if (!auto && btn) { btn.disabled = false; btn.textContent = t('editor.analyzeRun', '▶ Analyser opptak') }
  if (analyzing)   analyzing.style.display = 'none'
  renderAnalyzePanel()
  drawWaveform()

  // Show the auto-trim suggestion banner whenever we have a meaningful trim
  // (silence/music head or tail bigger than 0.5 s). Don't show if the user
  // already has cuts — they're clearly editing manually.
  if (cuts.length === 0) showSuggestionBanner()
}

/**
 * Render the merged "Analyser opptak" panel — replaces the old
 * separate Kapittelmarkører + Analyser opptak sections. Shows a summary
 * line ("Sist analysert: 31.5 14:23 · 3 tale-segmenter funnet"), the
 * three on-timeline toggles (speech/music/silence), and the
 * "Marker preken automatisk" button.
 *
 * Backwards-compat note: `meta.chapters` is still maintained as the
 * underlying data model but no longer surfaced as its own card — chapter
 * dots still render on the canvas if present, and any history sidecar
 * with existing chapter metadata is preserved on save.
 */
function renderAnalyzePanel(): void {
  const summary  = $('editor-analyze-summary')
  const controls = $('editor-analyze-controls')
  const markBtn  = $('btn-apply-auto-trim')
  const markHint = $('editor-auto-trim-hint')

  // Render summary line if we've ever analyzed this file.
  if (summary) {
    if (lastAnalyzedAt > 0) {
      const speechCount = suggestions.filter(s => s.type === 'speech' || s.type === 'sermon').length
      const d = new Date(lastAnalyzedAt)
      const date = `${d.getDate()}.${d.getMonth() + 1}`
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      summary.textContent = `${t('editor.analyzedAt', 'Sist analysert')}: ${date} ${time} · ${speechCount} ${t('editor.speechSegments', 'tale-segmenter funnet')}`
      summary.style.display = ''
    } else {
      summary.style.display = 'none'
    }
  }

  if (controls) controls.style.display = lastAnalyzedAt > 0 ? '' : 'none'

  // Show "Bruk forslag" / sermon-picker only when we have a sermon detected.
  const hasSermon = suggestions.some(s => s.type === 'sermon')
  if (markBtn)  (markBtn as HTMLElement).style.display  = hasSermon ? '' : 'none'
  if (markHint) (markHint as HTMLElement).style.display = hasSermon ? '' : 'none'
  renderSermonPicker()
}

/** Apply trim cuts around the currently-marked sermon segment: drop every-
 *  thing before sermon.start and after sermon.end. */
function applySermonTrim(): void {
  const sermon = suggestions.find(s => s.type === 'sermon')
  if (!sermon || !duration) return
  cuts = []
  if (sermon.start > 0.5) {
    cuts.push({ start: 0, end: Math.min(sermon.start, duration) })
  }
  if (sermon.end < duration - 0.5) {
    cuts.push({ start: Math.max(0, sermon.end), end: duration })
  }
  pushCutHistory()
  markDirty()
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

/** Promote a specific speech segment to be the "sermon" (overrides the
 *  auto-detected pick). Demotes the previous sermon back to plain 'speech'. */
function setSermonSegment(speechIdx: number): void {
  // Reset any current sermon → speech
  for (const s of suggestions) {
    if (s.type === 'sermon') { s.type = 'speech'; s.label = t('editor.speechLabel', 'Tale') }
  }
  // Promote the chosen speech segment
  const speeches = suggestions.filter(s => s.type === 'speech' || s.type === 'sermon')
  const target = speeches[speechIdx]
  if (!target) return
  target.type = 'sermon'
  target.label = 'Preken'
  renderAnalyzePanel()
  drawWaveform()
}

/** Render the sermon-picker dropdown so the user can override the auto-pick.
 *  Shows when there's more than one speech segment that could plausibly be
 *  the sermon (≥ 1 min). Hidden otherwise — single-segment recordings have
 *  no alternative to offer. */
function renderSermonPicker(): void {
  const picker = $('editor-sermon-picker') as HTMLSelectElement | null
  const wrap   = $('editor-sermon-picker-wrap')
  if (!picker || !wrap) return

  // Build list of all speech-like segments (speech + sermon), in time order.
  const speeches = suggestions
    .filter(s => s.type === 'speech' || s.type === 'sermon')
    .filter(s => s.duration >= 60)   // 1-min floor — too-short blocks aren't useful as sermon
    .slice()
    .sort((a, b) => a.start - b.start)

  if (speeches.length < 2) {
    wrap.style.display = 'none'
    return
  }

  wrap.style.display = ''
  picker.innerHTML = ''
  for (let i = 0; i < speeches.length; i++) {
    const s = speeches[i]
    const opt = document.createElement('option')
    opt.value = String(i)
    const startLbl = formatTime(s.start)
    const durLbl   = formatDuration(s.duration)
    const marker   = s.type === 'sermon' ? '★ ' : ''
    opt.textContent = `${marker}${t('editor.speechBlock', 'Tale-blokk')} ${i + 1} — ${startLbl} (${durLbl})`
    if (s.type === 'sermon') opt.selected = true
    picker.appendChild(opt)
  }
}

function showSuggestionBanner(): void {
  const banner = $('editor-suggestion-banner')
  const detail = $('editor-suggestion-detail')
  const sermon = suggestions.find(s => s.type === 'sermon')
  if (!banner || !detail || !sermon || !duration) return
  const headDur = sermon.start
  const tailDur = duration - sermon.end
  if (headDur < 0.5 && tailDur < 0.5) { banner.style.display = 'none'; return }
  const parts: string[] = []
  if (headDur > 0.5) parts.push(`${formatDuration(headDur)} ${t('editor.beforeSermon', 'før prekenen')}`)
  if (tailDur > 0.5) parts.push(`${formatDuration(tailDur)} ${t('editor.afterSermon', 'etter prekenen')}`)
  const keep = formatDuration(sermon.end - sermon.start)
  detail.textContent = `${parts.join(' + ')} ${t('editor.willBeTrimmed', 'fjernes')} · ${keep} ${t('editor.willRemain', 'preken igjen')}`
  banner.style.display = ''
}

function hideSuggestionBanner(): void {
  const banner = $('editor-suggestion-banner')
  if (banner) banner.style.display = 'none'
}

function computePeaks(buf: AudioBuffer): Float32Array {
  // Synchronous peak computation — used for short files where the cost is
  // negligible. Long files come in pre-downsampled via the ffmpeg-extract
  // path (8 kHz mono), so even a 4 h preacher recording is only ~115 M
  // samples here. For typical sermon lengths (1-3 h) this completes in well
  // under a second on a modern CPU. If you hit a file that lags the UI,
  // route it through `computePeaksAsync` instead.
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.floor(buf.sampleRate / RATE)
  clipTimes   = []

  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
    if (pk >= 0.99) clipTimes.push(i / RATE)
  }
  return out
}

/**
 * Async peak computation. Yields back to the event loop every CHUNK frames
 * so the UI thread stays responsive while crunching a multi-gigabyte
 * AudioBuffer. Currently unused (the sync path is fast enough for the
 * downsampled inputs we feed it), but kept here so the routing can switch
 * over without a code rewrite if profiling shows otherwise.
 */
// Underscore prefix marks this as intentionally unused (TS no-unused convention).
async function _computePeaksAsync(buf: AudioBuffer): Promise<Float32Array> {
  const RATE = 100
  const total = Math.ceil(buf.duration * RATE)
  const out   = new Float32Array(total)
  const ch0   = buf.getChannelData(0)
  const ch1   = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0
  const spp   = Math.floor(buf.sampleRate / RATE)
  clipTimes   = []

  const CHUNK = 2000  // yield every ~20 s of output (at 100 samples/s)
  for (let i = 0; i < total; i++) {
    const s = i * spp
    const e = Math.min(s + spp, ch0.length)
    let pk = 0
    for (let j = s; j < e; j++) {
      const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]))
      if (v > pk) pk = v
    }
    out[i] = pk
    if (pk >= 0.99) clipTimes.push(i / RATE)
    if ((i & (CHUNK - 1)) === 0 && i > 0) {
      // Yield: drains the microtask queue and lets paint events run.
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  return out
}

// ── Peak normalization helpers ────────────────────────────────────────────
//
// We work off the in-memory `peaks` array (downsampled at 100 Hz) rather
// than calling ffmpeg's `volumedetect`. The peaks data is downsampled from
// the actual audio samples, so its maximum is a tight upper bound on the
// true peak — accurate enough for a normalize button. The actual export
// uses ffmpeg's `volume={N}dB` filter applied to the original (un-downsampled)
// samples, so the rendered file is sample-accurate regardless.

/**
 * Compute the gain (in dB) needed to bring the maximum absolute peak in
 * `pks` to -1 dBFS (1 dB of safety headroom — prevents clipping after
 * encoding/codec processing). Returns 0 if the input is silent or already
 * at/above the target.
 *
 * Peaks here are floats in 0..1 (normalized magnitudes), produced by
 * `computePeaks()`. We never see uint8 input here, but the helper also
 * handles a normalized > 1 fallback just in case.
 */
function computePeakGain(pks: Float32Array): number {
  let max = 0
  for (let i = 0; i < pks.length; i++) {
    const v = Math.abs(pks[i])
    if (v > max) max = v
  }
  if (max <= 0) return 0
  // Defensive: if a future caller hands us uint8-style 0..255 data, rescale.
  const normalizedMax = max > 1.001 ? max / 128 : max
  const currentDb = 20 * Math.log10(normalizedMax)
  // Target -1 dBFS. If we're already at or above target, no gain.
  if (currentDb >= -1) return 0
  return -1 - currentDb
}

/** Linear gain factor for the current `audioGainDb` (1.0 = no change). */
function gainFactor(): number {
  return audioGainDb === 0 ? 1 : Math.pow(10, audioGainDb / 20)
}

/**
 * Build the audio-filter list passed to the main-process export pipeline.
 * Currently a single `volume={N}dB` filter when normalization has been
 * applied — composed with intro/outro concat and other filters in
 * `src/main/editor.ts` exactly as the previous proc-panel filter list was.
 */
function getExportFilters(): string[] {
  if (audioGainDb === 0) return []
  return [`volume=${audioGainDb.toFixed(2)}dB`]
}

/**
 * Update the normalize button + status line to reflect the current gain.
 * `gainDb === 0` and `alreadyAtTarget === true` means we ran the check but
 * the file's peak is already at/above -1 dBFS — show a friendly notice
 * instead of pretending nothing happened.
 */
function setNormalizeUI(gainDb: number, alreadyAtTarget: boolean): void {
  const btn    = $('btn-normalize-peak') as HTMLButtonElement | null
  const label  = $('btn-normalize-label')
  const status = $('editor-normalize-status')
  const reset  = $('btn-normalize-reset')
  if (!btn || !label || !status) return

  if (gainDb !== 0) {
    btn.classList.add('is-applied')
    status.classList.add('is-applied')
    const sign = gainDb >= 0 ? '+' : ''
    label.textContent = `✓ ${t('editor.normalizeApplied', 'Normalisert')} (${sign}${gainDb.toFixed(1)} dB)`
    status.textContent = t('editor.normalizeResult', 'Toppunkt nå -1 dBFS — trygg for eksport.')
    if (reset) reset.style.display = ''
  } else {
    btn.classList.remove('is-applied')
    status.classList.remove('is-applied')
    label.textContent = t('editor.normalizePeak', 'Normaliser lydnivå')
    if (alreadyAtTarget) {
      status.textContent = t('editor.normalizeAlready', 'Toppunktet er allerede ved -1 dBFS — ingen endring nødvendig.')
    } else {
      status.textContent = t('editor.normalizeHint', 'Justerer toppunktet til -1 dBFS for trygg sluttmiks.')
    }
    if (reset) reset.style.display = 'none'
  }
}

// ── Drawing ───────────────────────────────────────────────────────────────
function syncCanvasSize(): void {
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  const h   = 200
  canvas.style.height = h + 'px'
  // Read width from CSS (width: 100%) — never write canvas.style.width
  const w = canvas.clientWidth || canvas.parentElement?.getBoundingClientRect().width || 0
  if (!w) return
  canvas.width  = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
}

/** Schedule a draw on next rAF — coalesces multiple sync requests into a
 *  single paint per frame. Use this from hot paths like mousemove/handle-drag
 *  where caller would otherwise re-trigger drawWaveform 60+ times per second.
 *  Synchronous drawWaveform() still works for one-shot updates (load/seek/etc). */
let drawWaveformRaf = 0
function scheduleDrawWaveform(): void {
  if (drawWaveformRaf) return
  drawWaveformRaf = requestAnimationFrame(() => {
    drawWaveformRaf = 0
    drawWaveform()
  })
}

function drawWaveform(): void {
  if (!canvas || !peaks) return
  const dpr  = window.devicePixelRatio || 1
  const ctx  = canvas.getContext('2d')
  if (!ctx) return
  const W    = canvas.width  / dpr
  const H    = canvas.height / dpr
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
  const curSec = (isPlaying && isVideoFile && videoEl)
    ? videoEl.currentTime
    : (isPlaying && audioCtx)
    ? playStartSec + (audioCtx.currentTime - playStartCtxTime)
    : playStartSec

  // ── Layout: intro / main / outro regions ─────────────────────────
  const geom = getLayoutGeom(W)

  // ── Suggested segment backgrounds (only in main region) ───────────
  for (const seg of suggestions) {
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
  for (const c of cuts) {
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
  if (isDragging && dragStartSec >= 0) {
    const x1 = secToX(Math.min(dragStartSec, dragEndSec), W)
    const x2 = secToX(Math.max(dragStartSec, dragEndSec), W)
    ctx.fillStyle = 'rgba(251,146,60,0.18)'
    ctx.fillRect(x1, RULER, x2 - x1, H - RULER)
    ctx.strokeStyle = '#fb923c'
    ctx.lineWidth = 1.5
    ctx.strokeRect(x1 + 0.5, RULER + 0.5, x2 - x1 - 1, H - RULER - 1)
  }

  // ── Intro waveform (dimmed, in left slot) ─────────────────────────
  if (geom.introPx > 0 && introPeaks && introDuration > 0) {
    const introBarMax = maxBar
    ctx.fillStyle = '#7AAAFF'
    for (let px = 0; px < geom.introPx; px++) {
      const sec = (px / geom.introPx) * introDuration
      const pi  = Math.floor(sec * 100)
      if (pi < 0 || pi >= introPeaks.length) continue
      const barH = Math.min(introBarMax, introPeaks[pi] * introBarMax)
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
  if (geom.outroPx > 0 && outroPeaks && outroDuration > 0) {
    const outroBarMax = maxBar
    ctx.fillStyle = '#7AAAFF'
    for (let px = 0; px < geom.outroPx; px++) {
      const sec = (px / geom.outroPx) * outroDuration
      const pi  = Math.floor(sec * 100)
      if (pi < 0 || pi >= outroPeaks.length) continue
      const barH = Math.min(outroBarMax, outroPeaks[pi] * outroBarMax)
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
    const sec = vpStart + ((px - mainPxStart) / mainPxWidth) * (vpEnd - vpStart)
    const pi  = Math.floor(sec * 100)
    if (pi < 0 || pi >= peaks.length) continue

    const barH  = Math.min(maxBar, peaks[pi] * gFac * maxBar)
    const inCut = isInCut(sec) || (isDragging && isInDrag(sec))
    const isPast = sec < curSec && (isPlaying || playStartSec > 0)

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
  for (const c of cuts) {
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
  for (const c of cuts) {
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
  if (isDragging && dragStartSec >= 0 && Math.abs(dragEndSec - dragStartSec) > 0.05) {
    const sA = Math.min(dragStartSec, dragEndSec)
    const sB = Math.max(dragStartSec, dragEndSec)
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
  for (const ch of meta.chapters) {
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
      const lbl = `${t('editor.tlIntro', 'Intro')} · ${formatDuration(introDuration)}`
      ctx.fillText(lbl, geom.introPx / 2, RULER / 2)
    }
    if (geom.outroPx > 36) {
      ctx.fillStyle = '#7AAAFF'
      ctx.globalAlpha = 0.9
      const lbl = `${t('editor.tlOutro', 'Outro')} · ${formatDuration(outroDuration)}`
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
  const hoverX = secToX(hoverSec, W)
  if (peaks && !isDragging && hoverSec > -9999 && hoverX >= 0 && hoverX <= W) {
    ctx.setLineDash([3, 4])
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(hoverX, RULER); ctx.lineTo(hoverX, H); ctx.stroke()
    ctx.setLineDash([])

    // Timestamp tooltip at bottom. Shows region-aware label so the user
    // always knows what region they're hovering over.
    let label: string
    if (hoverSec < 0 && effIntroDur() > 0) {
      label = `Intro ${formatTime(hoverSec + effIntroDur())}`
    } else if (hoverSec > duration && effOutroDur() > 0) {
      label = `Outro ${formatTime(hoverSec - duration)}`
    } else {
      label = formatTime(hoverSec)
    }
    const hoveredSeg = suggestions.find(s => hoverSec >= s.start && hoverSec <= s.end && shouldShowSegment(s.type))
    if (hoveredSeg && hoverSec >= 0 && hoverSec <= duration) {
      const typeLbl = hoveredSeg.type === 'sermon' ? t('editor.tooltipSermon', 'Antatt preken')
        : hoveredSeg.type === 'speech' ? t('editor.tooltipSpeech', 'Tale')
        : hoveredSeg.type === 'music'  ? t('editor.tooltipMusic',  'Musikk')
        : hoveredSeg.type === 'silence'? t('editor.tooltipSilence','Stillhet')
        : t('editor.tooltipMixed', 'Blandet')
      label = `${typeLbl} · ${formatDuration(hoveredSeg.duration)}  (${formatTime(hoverSec)})`
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
  if (clipTimes.length > 0) {
    ctx.fillStyle = '#ef4444'
    ctx.globalAlpha = 0.8
    for (const t of clipTimes) {
      const x = secToX(t, W)
      if (x < 0 || x > W) continue
      ctx.fillRect(x - 0.5, RULER, 1, 5)
    }
    ctx.globalAlpha = 1
  }

  // ── Cut handle hover highlights ────────────────────────────────
  if (hoverSec >= vpStart && hoverSec <= vpEnd && !isDragging && !handleDrag) {
    const threshold = (vpEnd - vpStart) / W * 10
    for (const c of cuts) {
      for (const side of ['start', 'end'] as const) {
        const t = c[side]
        if (Math.abs(hoverSec - t) < threshold) {
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

function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `${r},${g},${b}`
}

function drawRuler(ctx: CanvasRenderingContext2D, W: number, H: number, RULER: number): void {
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
  const rawInterval  = (vpEnd - vpStart) * 80 / mainW
  // Note: tick interval ≥ 1 sec so formatTime (which rounds to whole seconds)
  // never produces duplicate labels (would render "0:05 0:05 0:06 0:06" for
  // 0.5-sec ticks on short clips).
  const intervals    = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const tickInterval = intervals.find(v => v >= rawInterval) ?? 600
  const firstTick    = Math.ceil(vpStart / tickInterval) * tickInterval

  ctx.font        = '500 9px system-ui, -apple-system, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillStyle   = 'rgba(255,255,255,0.32)'

  for (let s = firstTick; s <= vpEnd; s += tickInterval) {
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

function drawMinimap(): void {
  if (!minimap || !peaks) return
  const dpr  = window.devicePixelRatio || 1
  const W    = minimap.parentElement?.clientWidth ?? 0
  if (!W) return
  const H    = 44
  minimap.style.width  = W + 'px'
  minimap.style.height = H + 'px'
  minimap.width  = W * dpr
  minimap.height = H * dpr

  const ctx  = minimap.getContext('2d')
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
    const sec  = (px / W) * duration
    const pi   = Math.floor(sec * 100)
    if (pi < 0 || pi >= peaks.length) continue
    const barH = Math.min(maxBar, peaks[pi] * gFac * maxBar)
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

function updateMinimapViewport(): void {
  if (!minimapVp || !duration) return
  const W  = minimap.parentElement?.clientWidth ?? 0
  const x1 = (vpStart / duration) * W
  const x2 = (vpEnd   / duration) * W
  minimapVp.style.left  = x1 + 'px'
  minimapVp.style.width = (x2 - x1) + 'px'
}

// ── Minimap click / drag ──────────────────────────────────────────────────

// Module-scoped listener refs so repeated setupEditorPage() calls (renderer
// reload, page-switch) don't keep adding new window-level listeners. Each
// re-invocation removes the previous pair before attaching new ones.
let minimapWindowMoveHandler: ((e: MouseEvent) => void) | null = null
let minimapWindowUpHandler:   (() => void) | null = null

function setupMinimapInteraction(): void {
  minimap?.addEventListener('mousedown', (e: MouseEvent) => {
    minimapDragging = true
    jumpViewportToMouse(e)
  })
  if (minimapWindowMoveHandler) window.removeEventListener('mousemove', minimapWindowMoveHandler)
  if (minimapWindowUpHandler)   window.removeEventListener('mouseup',   minimapWindowUpHandler)
  minimapWindowMoveHandler = (e: MouseEvent) => {
    if (minimapDragging) jumpViewportToMouse(e)
  }
  minimapWindowUpHandler = () => { minimapDragging = false }
  window.addEventListener('mousemove', minimapWindowMoveHandler)
  window.addEventListener('mouseup',   minimapWindowUpHandler)
}

function jumpViewportToMouse(e: MouseEvent): void {
  if (!duration || !minimap) return
  const rect   = minimap.getBoundingClientRect()
  const frac   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const center = frac * duration
  const half   = (vpEnd - vpStart) / 2
  vpStart = Math.max(0, Math.min(duration - half * 2, center - half))
  vpEnd   = vpStart + half * 2
  drawWaveform()
  updateMinimapViewport()
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────
//
// Shortcuts are only active while the editor tab is the visible page and
// the user isn't typing in an input/textarea. The mod key is Cmd on Mac
// and Ctrl elsewhere — we treat the two interchangeably (metaKey || ctrlKey).
function setupKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!document.getElementById('page-editor')?.classList.contains('active')) return
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    const mod = e.metaKey || e.ctrlKey

    // App-level shortcuts: Cmd+O / Cmd+W / Cmd+S / Cmd+E — these work even
    // when no file is open (e.g. Cmd+O on empty state). Also intentionally
    // skip the `peaks` guard so Cmd+O still works.
    if (mod && e.code === 'KeyO') {
      e.preventDefault()
      if (!confirmDiscardIfDirty('open')) return
      pickAndLoad()
      return
    }
    if (mod && e.code === 'KeyW') {
      e.preventDefault()
      if (!filePath) return
      if (!confirmDiscardIfDirty('close')) return
      closeCurrentFile()
      return
    }
    if (mod && (e.code === 'KeyS' || e.code === 'KeyE')) {
      e.preventDefault()
      if (filePath) openExportModal()
      return
    }

    // Per-file shortcuts (need an open file)
    if (!peaks) return
    if (e.target instanceof HTMLButtonElement) return

    switch (e.code) {
      case 'Space':
        e.preventDefault()
        togglePlay(isPlaying ? isPreview : false)
        break
      case 'ArrowLeft':
        e.preventDefault()
        seekBy(e.shiftKey ? -1 : -5)
        break
      case 'ArrowRight':
        e.preventDefault()
        seekBy(e.shiftKey ? 1 : 5)
        break
      case 'Equal':
      case 'NumpadAdd':
        if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); zoomBy(0.55) }
        break
      case 'Minus':
      case 'NumpadSubtract':
        e.preventDefault()
        zoomBy(1.7)
        break
      case 'KeyZ':
        if ((e.metaKey || e.ctrlKey) && e.shiftKey) { e.preventDefault(); redoCut() }
        else if (e.metaKey || e.ctrlKey) { e.preventDefault(); undoCut() }
        break
      case 'KeyY':
        if (e.metaKey || e.ctrlKey) { e.preventDefault(); redoCut() }
        break
      case 'Escape':
        if (isPlaying) stopPlay()
        break
      case 'KeyF':
        e.preventDefault()
        fitAll()
        drawWaveform()
        updateMinimapViewport()
        break
      case 'KeyL':
        e.preventDefault()
        isLooping = !isLooping
        $('btn-editor-loop')?.classList.toggle('active', isLooping)
        break
      case 'Delete':
      case 'Backspace': {
        // Delete the cut under the playhead — the closest cut whose range
        // contains playStartSec, falling back to the most recently added.
        if (cuts.length === 0) break
        e.preventDefault()
        const idx = cuts.findIndex(c => playStartSec >= c.start && playStartSec <= c.end)
        if (idx >= 0) deleteCut(idx)
        else deleteCut(cuts.length - 1)
        break
      }
      case 'Home':
        // Jump to start of extended timeline (intro start if present, else 0)
        e.preventDefault()
        seekTo(minPlayableSec())
        break
      case 'End':
        // Jump to end of extended timeline (outro end if present, else duration)
        e.preventDefault()
        seekTo(maxPlayableSec())
        break
      case 'Tab':
        // Jump to next/previous cut boundary (works in main coords)
        e.preventDefault()
        jumpToCutBoundary(e.shiftKey ? -1 : 1)
        break
      case 'KeyP': {
        // Jump to the detected sermon start
        const sermon = suggestions.find(s => s.type === 'sermon')
        if (sermon) { e.preventDefault(); seekTo(sermon.start) }
        break
      }
    }
  })
}

/** Move playhead to an absolute extended-timeline second, stopping any active
 *  playback. Centralises the seek-and-redraw logic used by keyboard shortcuts.
 *  Snaps out of cuts so keyboard navigation always lands on playable audio. */
function seekTo(sec: number): void {
  stopPlay()
  playStartSec = snapOutOfCut(clampPlayable(sec))
  updateTimecode(playStartSec)
  if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
  const mainPlayhead = clampMain(playStartSec)
  if (mainPlayhead < vpStart || mainPlayhead > vpEnd) {
    const span = vpEnd - vpStart
    vpStart = Math.max(0, mainPlayhead - span * 0.3)
    vpEnd   = Math.min(duration, vpStart + span)
    updateMinimapViewport()
  }
  drawWaveform()
}

/** Jump playhead to the next/previous cut boundary. Direction = +1 forward,
 *  -1 backward. Considers both cut start and end so each cut counts as two
 *  navigation stops. */
function jumpToCutBoundary(dir: 1 | -1): void {
  if (cuts.length === 0) return
  const ph = clampMain(playStartSec)
  const points: number[] = []
  for (const c of cuts) { points.push(c.start, c.end) }
  points.sort((a, b) => a - b)
  let target: number | null = null
  if (dir > 0) {
    target = points.find(p => p > ph + 0.05) ?? null
  } else {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i] < ph - 0.05) { target = points[i]; break }
    }
  }
  if (target == null) return
  seekTo(target)
}

// ── Drag and drop ─────────────────────────────────────────────────────────
//
// Two drop targets:
//   1. The whole editor page (when no file is open, OR when a video/audio
//      media file is dragged anywhere outside the timeline canvas) → loads
//      as main file.
//   2. The timeline canvas: drops on the LEFT third route to INTRO,
//      drops on the RIGHT third route to OUTRO. Middle third is ignored
//      (reserved for future cut/note drops).
const AUDIO_EXTS = new Set([
  'mp3', 'mp1', 'mp2', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'm4r',
  'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'mka',
  'ac3', 'eac3', 'dts', 'amr', '3ga', 'caf', 'ape', 'wv', 'tta',
  'mpc', 'au', 'snd', 'ra', 'ram', 'spx', 'gsm',
])
const VIDEO_DROP_EXTS = new Set([
  'mp4', 'mov', 'mkv', 'm4v', 'avi', 'wmv', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'asf', 'f4v',
])

function setupDragDrop(): void {
  const page    = $('page-editor')
  const overlay = $('editor-drop-overlay')
  const canvasWrap = $('editor-canvas-wrap')
  if (!page) return

  // Page-wide drag (sets the main-file load overlay). Skip when the drag
  // hovers the canvas (which has its own zoned drop targets).
  page.addEventListener('dragover', (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (!canvasWrap?.contains(e.target as Node)) overlay?.classList.add('active')
  })

  page.addEventListener('dragleave', (e: DragEvent) => {
    if (!page.contains(e.relatedTarget as Node)) {
      overlay?.classList.remove('active')
    }
  })

  page.addEventListener('drop', async (e: DragEvent) => {
    // The canvas handler below claims its own drops via stopPropagation.
    e.preventDefault()
    overlay?.classList.remove('active')
    const file = e.dataTransfer?.files[0]
    if (!file) return
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!AUDIO_EXTS.has(ext) && !VIDEO_DROP_EXTS.has(ext)) return
    const fp = (file as File & { path?: string }).path
    if (!fp) return
    if (!confirmDiscardIfDirty('open')) return
    // Drag-and-drop is an explicit user action — trust the folder for this
    // session so path-defense doesn't silently refuse legitimate picks from
    // external drives or non-standard locations.
    try { await window.api.registerTrustedPath(fp) } catch {}
    loadFile(fp)
  })

  // Canvas-specific drop zones for intro/outro. The dragover handler
  // highlights the left or right third using CSS pseudo-elements; the
  // drop handler routes the file to the right intro/outro slot.
  if (canvasWrap) {
    canvasWrap.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      const rect = canvasWrap.getBoundingClientRect()
      const x = e.clientX - rect.left
      const region = getRegionAtX(x, rect.width)
      canvasWrap.classList.toggle('is-dropzone-intro', region === 'intro')
      canvasWrap.classList.toggle('is-dropzone-outro', region === 'outro')
      // When we're highlighting an intro/outro zone, take precedence over
      // the page-wide overlay (which would otherwise show "load main file").
      if (region !== 'main') {
        overlay?.classList.remove('active')
        e.stopPropagation()
      }
    })

    canvasWrap.addEventListener('dragleave', () => {
      canvasWrap.classList.remove('is-dropzone-intro', 'is-dropzone-outro')
    })

    canvasWrap.addEventListener('drop', async (e: DragEvent) => {
      canvasWrap.classList.remove('is-dropzone-intro', 'is-dropzone-outro')
      const file = e.dataTransfer?.files[0]
      if (!file) return
      const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
      if (!AUDIO_EXTS.has(ext)) return  // intro/outro must be audio (no video jingles yet)
      const fp = (file as File & { path?: string }).path
      if (!fp) return
      const rect = canvasWrap.getBoundingClientRect()
      const region = getRegionAtX(e.clientX - rect.left, rect.width)
      if (region === 'main') return  // ignore — reserved for cuts/notes
      // Claim this drop so the page-wide handler doesn't reload the main file
      e.preventDefault()
      e.stopPropagation()
      if (region === 'intro') {
        patchSettings({ editorIntroPath: fp })
      } else {
        patchSettings({ editorOutroPath: fp })
      }
      await window.api.saveSettings(settings)
      // Also turn on includeIntroOutro so the user immediately sees the result.
      if (!includeIntroOutro) {
        includeIntroOutro = true
        const chk = $('editor-include-io') as HTMLInputElement | null
        if (chk) chk.checked = true
      }
      await reloadIntroOutro()
      markDirty()
    })
  }
}

// ── Viewport helpers ──────────────────────────────────────────────────────
//
// Coordinate model
// ----------------
// `vpStart` / `vpEnd` are in MAIN-FILE seconds — the same coordinate system
// that `cuts`, `chapters`, `peaks`, and playback seek use.
//
// When `includeIntroOutro` is enabled and the viewport reaches the file edges
// (vpStart=0 or vpEnd=duration), the canvas is split into three regions:
//
//   ┌──────────┬────────────────────────────────┬──────────┐
//   │  INTRO   │         HOVEDOPPTAK            │   OUTRO  │
//   │ (dim)    │   (main waveform — full color) │  (dim)   │
//   └──────────┴────────────────────────────────┴──────────┘
//
// Pixel widths are proportional to durations so transitions look natural.
// Intro/Outro slots disappear when the user zooms into the middle (vpStart>0
// or vpEnd<duration) — they're only meaningful at the edges of the file.
//
// `secToX(mainFileSec, W)` maps main-file seconds to a pixel x. Cuts/playhead/
// handles all go through this so they stay properly aligned even when the
// pixel-to-second ratio changes due to intro/outro insertion.

interface LayoutGeom {
  introPx: number   // width of intro region in pixels
  outroPx: number   // width of outro region in pixels
  mainPxStart: number  // x where main waveform begins
  mainPxEnd: number    // x where main waveform ends
  effIntroDur: number  // intro duration in seconds, or 0 if not displayed
  effOutroDur: number  // outro duration in seconds, or 0 if not displayed
}

function getLayoutGeom(W: number): LayoutGeom {
  // Only show intro/outro slots when the corresponding edge of the file is
  // visible. If the user has zoomed past the start, hide the intro slot.
  const showIntro = includeIntroOutro && !!introBuffer && vpStart <= 0.001
  const showOutro = includeIntroOutro && !!outroBuffer && vpEnd >= duration - 0.001
  const effIntroDur = showIntro ? introDuration : 0
  const effOutroDur = showOutro ? outroDuration : 0
  const mainVpDur = Math.max(0.001, vpEnd - vpStart)
  const total = effIntroDur + mainVpDur + effOutroDur
  const introPx = (effIntroDur / total) * W
  const outroPx = (effOutroDur / total) * W
  return {
    introPx,
    outroPx,
    mainPxStart: introPx,
    mainPxEnd: W - outroPx,
    effIntroDur,
    effOutroDur,
  }
}

// Extended-timeline helpers: `playStartSec` runs on an extended timeline so the
// playhead can be moved (and audio played) inside intro/outro slots:
//   • sec < 0                 → inside intro, offset into intro = sec + effIntroDur
//   • 0 ≤ sec ≤ duration       → inside main recording
//   • duration < sec ≤ end     → inside outro, offset into outro = sec - duration
// Cuts always stay in main coords ([0, duration]); video.currentTime is
// clamped to main with clampMain().
function effIntroDur(): number {
  return (includeIntroOutro && introBuffer) ? introDuration : 0
}
function effOutroDur(): number {
  return (includeIntroOutro && outroBuffer) ? outroDuration : 0
}
function minPlayableSec(): number {
  return -effIntroDur()
}
function maxPlayableSec(): number {
  return duration + effOutroDur()
}
function clampPlayable(sec: number): number {
  return Math.max(minPlayableSec(), Math.min(maxPlayableSec(), sec))
}
function clampMain(sec: number): number {
  return Math.max(0, Math.min(duration, sec))
}

function secToX(sec: number, W: number): number {
  const g = getLayoutGeom(W)
  // Intro slot — negative seconds map into [0, introPx]
  if (sec < 0 && g.introPx > 0 && g.effIntroDur > 0) {
    const frac = (sec + g.effIntroDur) / g.effIntroDur
    return Math.max(0, Math.min(1, frac)) * g.introPx
  }
  // Outro slot — seconds > duration map into [mainPxEnd, W]
  if (sec > duration && g.outroPx > 0 && g.effOutroDur > 0) {
    const frac = (sec - duration) / g.effOutroDur
    return g.mainPxEnd + Math.max(0, Math.min(1, frac)) * g.outroPx
  }
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return g.mainPxStart
  return g.mainPxStart + ((sec - vpStart) / (vpEnd - vpStart)) * mainW
}

function xToSec(x: number, W: number): number {
  const g = getLayoutGeom(W)
  // Intro slot: returns negative seconds in [-effIntroDur, 0]
  if (g.introPx > 0 && g.effIntroDur > 0 && x < g.mainPxStart) {
    const frac = Math.max(0, Math.min(1, x / g.introPx))
    return -g.effIntroDur + frac * g.effIntroDur
  }
  // Outro slot: returns seconds in (duration, duration + effOutroDur]
  if (g.outroPx > 0 && g.effOutroDur > 0 && x > g.mainPxEnd) {
    const frac = Math.max(0, Math.min(1, (x - g.mainPxEnd) / g.outroPx))
    return duration + frac * g.effOutroDur
  }
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return vpStart
  if (x <= g.mainPxStart) return vpStart
  if (x >= g.mainPxEnd)   return vpEnd
  return vpStart + ((x - g.mainPxStart) / mainW) * (vpEnd - vpStart)
}

/** Returns x in main-coords only — used by cut handling which must never
 *  read intro/outro coords. */
function xToMainSec(x: number, W: number): number {
  const g = getLayoutGeom(W)
  const mainW = g.mainPxEnd - g.mainPxStart
  if (mainW <= 0) return vpStart
  if (x <= g.mainPxStart) return vpStart
  if (x >= g.mainPxEnd)   return vpEnd
  return vpStart + ((x - g.mainPxStart) / mainW) * (vpEnd - vpStart)
}

/** Returns 'intro' | 'main' | 'outro' for a given pixel x. Used by drag-and-drop
 *  to route a dropped file to the right intro/outro slot. */
function getRegionAtX(x: number, W: number): 'intro' | 'main' | 'outro' {
  const g = getLayoutGeom(W)
  // The user's UX expectation is: drop on LEFT third = intro, RIGHT third = outro.
  // We honour that geometrically even when the actual intro slot is narrow
  // (or absent), so users can SET an intro by dragging onto the left third
  // even before any intro file is configured.
  if (x < W / 3)    return 'intro'
  if (x > W * 2/3)  return 'outro'
  return 'main'
}

function fitAll(): void {
  vpStart = 0
  vpEnd   = duration || 1
}

function zoomBy(factor: number): void {
  const center = (vpStart + vpEnd) / 2
  const half   = ((vpEnd - vpStart) * factor) / 2
  vpStart = Math.max(0, center - half)
  vpEnd   = Math.min(duration, center + half)
  const minSpan = 0.5
  if (vpEnd - vpStart < minSpan) {
    const mid = (vpStart + vpEnd) / 2
    vpStart = Math.max(0, mid - minSpan / 2)
    vpEnd   = Math.min(duration, vpStart + minSpan)
  }
  drawWaveform()
  updateMinimapViewport()
}

function panBy(deltaSecs: number): void {
  const span = vpEnd - vpStart
  vpStart = Math.max(0, Math.min(duration - span, vpStart + deltaSecs))
  vpEnd   = vpStart + span
  drawWaveform()
  updateMinimapViewport()
}

function seekBy(secs: number): void {
  stopPlay()
  playStartSec = clampPlayable(playStartSec + secs)
  updateTimecode(playStartSec)
  if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
  // Pan viewport when playhead drops out of view. Viewport itself stays in
  // main coords — intro/outro live in their own slots and always remain
  // visible when at the recording edge.
  const mainPlayhead = clampMain(playStartSec)
  if (mainPlayhead < vpStart || mainPlayhead > vpEnd) {
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, mainPlayhead - half)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
  }
  drawWaveform()
}

function autoScrollToPlayhead(curSec: number): void {
  // Auto-scroll only operates inside the main recording. Intro/outro slots
  // are fixed and always visible at their respective edges.
  if (curSec < 0 || curSec > duration) return
  const span = vpEnd - vpStart
  if (curSec > vpEnd - span * 0.1) {
    vpStart = curSec - span * 0.05
    vpEnd   = vpStart + span
    if (vpEnd > duration) { vpEnd = duration; vpStart = Math.max(0, duration - span) }
    updateMinimapViewport()
  }
}

// ── Cut helpers ───────────────────────────────────────────────────────────
function isInCut(sec: number): boolean {
  return cuts.some(c => sec >= c.start && sec <= c.end)
}

function isInDrag(sec: number): boolean {
  if (!isDragging) return false
  const s = Math.min(dragStartSec, dragEndSec)
  const e = Math.max(dragStartSec, dragEndSec)
  return sec >= s && sec <= e
}

// Undo/redo: history stores snapshots; cutHistoryIdx points to the current
// live state. Index -1 means "no history yet" (initial empty state).
// pushCutHistory() is called AFTER a mutation to record the new state.
function pushCutHistory(): void {
  // Discard any redo states ahead of the current pointer
  cutHistory = cutHistory.slice(0, cutHistoryIdx + 1)
  cutHistory.push(JSON.parse(JSON.stringify(cuts)))
  if (cutHistory.length > 50) cutHistory.shift()
  cutHistoryIdx = cutHistory.length - 1
  // Persist cuts to a draft sidecar so a crash mid-edit doesn't lose the work
  scheduleDraftSave()
}

let draftSaveTimer: ReturnType<typeof setTimeout> | null = null
function scheduleDraftSave(): void {
  if (!filePath) return
  if (draftSaveTimer) clearTimeout(draftSaveTimer)
  // Debounce 2 s — avoid IPC spam during rapid drag operations
  draftSaveTimer = setTimeout(() => {
    draftSaveTimer = null
    const fp = filePath
    if (!fp) return
    window.api.editorSaveCutsDraft(fp, cuts).catch(() => {})
  }, 2000)
}

/** Called after a successful save/export to remove the draft. */
export function clearEditorDraft(): void {
  if (draftSaveTimer) { clearTimeout(draftSaveTimer); draftSaveTimer = null }
  if (filePath) window.api.editorDeleteCutsDraft(filePath).catch(() => {})
}

function addCut(s: number, e: number): void {
  if (e < s) [s, e] = [e, s]
  // Cuts must always live in main coords — clamp in case the drag started or
  // ended in an intro/outro slot (caller may have passed extended-timeline
  // values).
  s = clampMain(s); e = clampMain(e)
  if (e - s < 0.1) return

  cuts.push({ start: s, end: e })
  cuts.sort((a, b) => a.start - b.start)

  // Merge overlapping
  const merged: Cut[] = []
  for (const c of cuts) {
    const prev = merged[merged.length - 1]
    if (prev && c.start <= prev.end + 0.01) { prev.end = Math.max(prev.end, c.end) }
    else merged.push({ ...c })
  }
  cuts = merged
  pushCutHistory()
  markDirty()
  updateRemainingDisplay()
}

function deleteCut(i: number): void {
  cuts.splice(i, 1)
  pushCutHistory()
  markDirty()
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

function undoCut(): void {
  if (cutHistoryIdx <= 0) {
    // Undo back to empty state
    if (cutHistoryIdx === 0 && cuts.length > 0) {
      cuts = []
      cutHistoryIdx = -1
      renderCutList(); updateRemainingDisplay(); drawWaveform(); drawMinimap()
    }
    return
  }
  cutHistoryIdx--
  cuts = JSON.parse(JSON.stringify(cutHistory[cutHistoryIdx]))
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

function redoCut(): void {
  if (cutHistoryIdx >= cutHistory.length - 1) return
  cutHistoryIdx++
  cuts = JSON.parse(JSON.stringify(cutHistory[cutHistoryIdx]))
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

function getKeepSegs(): { start: number; end: number }[] {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })
  return keeps
}

function getRemainingDuration(): number {
  return getKeepSegs().reduce((sum, s) => sum + (s.end - s.start), 0)
}

function updateRemainingDisplay(): void {
  const el  = $('editor-remaining')
  const dur = $('editor-remaining-dur')
  // Update header summary regardless — duration / normalize state may have
  // changed even if no cuts exist yet.
  updateHeaderSummary()
  if (!el || !duration) return

  if (cuts.length === 0) {
    el.style.display = 'none'
    return
  }

  const rem = getRemainingDuration()
  const cut = duration - rem
  el.style.display = 'flex'
  el.classList.toggle('has-cuts', cuts.length > 0)
  if (dur) dur.textContent = `${formatDuration(rem)} (fjerner ${formatDuration(cut)})`
}

function renderCutList(): void {
  const panel = $('editor-cuts-panel')
  const list  = $('editor-cuts-list')
  const undo  = $('btn-editor-undo-all')
  if (!panel || !list || !undo) return

  if (cuts.length === 0) {
    panel.style.display = 'none'
    undo.style.display  = 'none'
    return
  }

  panel.style.display = ''
  undo.style.display  = ''

  list.innerHTML = ''

  cuts.forEach((c, i) => {
    const dur = c.end - c.start
    const row = document.createElement('div')
    row.className = 'editor-cut-row'
    row.style.animationDelay = `${i * 0.05}s`

    // Thumbnail
    const thumb = document.createElement('div')
    thumb.className = 'editor-cut-thumb'
    if (peaks) {
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

function makeCutThumbnailSvg(cut: Cut): string {
  if (!peaks) return ''
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
    if (pi >= peaks.length) break
    const h = Math.min(maxH, peaks[pi] * gFac * maxH)
    rects.push(`<rect x="${px}" y="${(midY - h).toFixed(1)}" width="1" height="${(h * 2).toFixed(1)}"/>`)
  }
  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">${rects.join('')}</svg>`
}

function previewCut(cut: Cut): void {
  stopPlay()
  const PRE_ROLL = 3
  playStartSec = Math.max(0, cut.start - PRE_ROLL)
  updateTimecode(playStartSec)
  if (playStartSec < vpStart || playStartSec > vpEnd) {
    const half = (vpEnd - vpStart) / 2
    vpStart = Math.max(0, playStartSec - half * 0.3)
    vpEnd   = Math.min(duration, vpStart + half * 2)
    updateMinimapViewport()
  }
  startPlay(false)
}

// ── Canvas mouse events ───────────────────────────────────────────────────
function onCanvasDown(e: MouseEvent): void {
  if (!peaks || e.button !== 0) return
  const rect = canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Check if clicking near a cut boundary → start handle drag. Cut handles
  // only live in main coords, so this uses mainSec.
  const threshold = (vpEnd - vpStart) / rect.width * 10
  for (let i = 0; i < cuts.length; i++) {
    if (Math.abs(mainSec - cuts[i].start) < threshold) {
      handleDrag = { cutIdx: i, side: 'start' }
      return
    }
    if (Math.abs(mainSec - cuts[i].end) < threshold) {
      handleDrag = { cutIdx: i, side: 'end' }
      return
    }
  }

  // Check if clicking near playhead in the ruler area → playhead drag
  const yInCanvas = e.clientY - rect.top
  const playX = secToX(playStartSec, rect.width)
  if (Math.abs(e.clientX - rect.left - playX) < 12 && yInCanvas < 28) {
    playheadDragging = true
    stopPlay()
    return
  }

  // Normal drag to create cut — drag coords are clamped to main, since cuts
  // can only exist inside the recording.
  dragStartSec = clampMain(extSec)
  dragEndSec   = dragStartSec
  isDragging   = true
}

function onCanvasMove(e: MouseEvent): void {
  if (!peaks) return
  const rect = canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Handle drag: resize cut boundary. Snap to nearby segment boundaries when
  // shift is NOT held — gives precise lock-in to detected speech/music edges.
  // Repaints are rAF-coalesced so 60+ mousemoves/sec only redraw ~60 times.
  if (handleDrag) {
    const c = cuts[handleDrag.cutIdx]
    const snapped = e.shiftKey ? mainSec : snapToSegmentBoundary(mainSec, rect.width)
    if (handleDrag.side === 'start') {
      c.start = Math.max(0, Math.min(c.end - 0.1, snapped))
    } else {
      c.end   = Math.min(duration, Math.max(c.start + 0.1, snapped))
    }
    updateRemainingDisplay()
    scheduleDrawWaveform()
    return
  }

  // Playhead drag — covers full extended timeline (intro/main/outro)
  if (playheadDragging) {
    playStartSec = clampPlayable(extSec)
    updateTimecode(playStartSec)
    if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
    scheduleDrawWaveform()
    return
  }

  hoverSec = extSec

  // Cursor feedback
  const threshold = (vpEnd - vpStart) / rect.width * 10
  const nearBoundary = cuts.some(c =>
    Math.abs(mainSec - c.start) < threshold || Math.abs(mainSec - c.end) < threshold
  )
  const overCut = cuts.some(c => mainSec >= c.start && mainSec <= c.end)
  const nearPlayhead = Math.abs(e.clientX - rect.left - secToX(playStartSec, rect.width)) < 12
    && (e.clientY - rect.top) < 28

  canvas.style.cursor = nearBoundary ? 'ew-resize'
    : nearPlayhead    ? 'col-resize'
    : overCut         ? 'pointer'
    : 'crosshair'

  if (isDragging) dragEndSec = clampMain(extSec)

  scheduleDrawWaveform()
}

function onCanvasUp(e: MouseEvent): void {
  if (!peaks) return
  const rect  = canvas.getBoundingClientRect()
  const extSec = xToSec(e.clientX - rect.left, rect.width)
  const upMainSec = xToMainSec(e.clientX - rect.left, rect.width)

  if (handleDrag) {
    handleDrag = null
    cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
    return
  }

  if (playheadDragging) {
    playheadDragging = false
    // Snap playhead out of any cut region the user dragged into — cuts are
    // "skip me" zones, so resting the playhead inside one is meaningless.
    playStartSec = snapOutOfCut(playStartSec)
    updateTimecode(playStartSec)
    if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
    drawWaveform()
    return
  }

  if (!isDragging) return
  isDragging = false

  // Cut-creation drag: hold shift to disable snap, otherwise snap both edges
  // to nearby detected segment boundaries.
  if (Math.abs(upMainSec - dragStartSec) > 0.1) {
    const s = e.shiftKey ? dragStartSec : snapToSegmentBoundary(dragStartSec, rect.width)
    const eSec = e.shiftKey ? upMainSec : snapToSegmentBoundary(upMainSec, rect.width)
    addCut(s, eSec)
    renderCutList()
  } else {
    // Tap to seek — covers full extended timeline so users can click into
    // intro/outro slots. If the click lands inside a cut, snap to the cut's
    // end (the nearest keep-region start) so playback always begins at a
    // position that will actually produce audio.
    stopPlay()
    playStartSec = snapOutOfCut(clampPlayable(extSec))
    updateTimecode(playStartSec)
    if (isVideoFile && videoEl) videoEl.currentTime = clampMain(playStartSec)
  }

  dragStartSec = -1
  dragEndSec   = -1
  drawWaveform()
  drawMinimap()
}

function onCanvasLeave(): void {
  hoverSec = -99999

  if (handleDrag) {
    handleDrag = null
    cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform(); drawMinimap()
    return
  }

  if (playheadDragging) {
    playheadDragging = false
    drawWaveform()
    return
  }

  if (isDragging) {
    isDragging = false
    if (Math.abs(dragEndSec - dragStartSec) > 0.1) {
      addCut(dragStartSec, dragEndSec)
      renderCutList()
    }
    dragStartSec = -1; dragEndSec = -1
    drawWaveform(); drawMinimap()
  } else {
    drawWaveform()
  }
}

function onCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (!peaks) return
  const rect = canvas.getBoundingClientRect()
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)
  const idx  = cuts.findIndex(c => mainSec >= c.start && mainSec <= c.end)
  if (idx >= 0) deleteCut(idx)
}

function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on mouse position (main coords only — intro/outro slots
    // have their own fixed scale).
    const rect = canvas.getBoundingClientRect()
    const mouseSec = xToMainSec(e.clientX - rect.left, rect.width)
    const factor   = e.deltaY > 0 ? 1.25 : 0.75
    const span     = (vpEnd - vpStart) * factor
    const frac     = (mouseSec - vpStart) / (vpEnd - vpStart)
    vpStart = Math.max(0, mouseSec - frac * span)
    vpEnd   = Math.min(duration, vpStart + span)
    if (vpEnd - vpStart < 0.5) { vpEnd = vpStart + 0.5 }
    drawWaveform()
    updateMinimapViewport()
  } else {
    panBy(e.deltaY * (vpEnd - vpStart) / 800)
  }
}

/** If `sec` falls inside a cut region, return the cut's end (the nearest
 *  keep-region start). Cuts are skip-zones — the playhead resting inside
 *  one is meaningless because no audio plays there. Out-of-range or
 *  already-outside-cut input is returned unchanged. */
function snapOutOfCut(sec: number): number {
  for (const c of cuts) {
    if (sec >= c.start && sec < c.end) {
      // Snap to the cut's end, clamped to the playable range so we never
      // overshoot duration when a trailing cut runs to the file end.
      return Math.min(maxPlayableSec(), c.end)
    }
  }
  return sec
}

/** Snaps a main-coords second to the nearest detected segment boundary within
 *  threshold (default ~0.4 sec). Falls through to input unchanged when no
 *  suggestions are loaded or no boundary is close enough. */
function snapToSegmentBoundary(sec: number, W: number): number {
  if (!suggestions.length) return sec
  // Threshold scales with zoom level (~8 px) — tight at high zoom, lenient
  // when zoomed out so coarse drags still find the boundary.
  const threshold = Math.max(0.15, ((vpEnd - vpStart) / Math.max(1, W)) * 8)
  let closest = sec
  let minDist = threshold
  for (const seg of suggestions) {
    if (!shouldShowSegment(seg.type)) continue
    for (const t of [seg.start, seg.end]) {
      const d = Math.abs(sec - t)
      if (d < minDist) { minDist = d; closest = t }
    }
  }
  return closest
}

// ── Playback ──────────────────────────────────────────────────────────────
function togglePlay(preview: boolean): void {
  if (isPlaying && isPreview === preview) { stopPlay(); return }
  stopPlay()
  startPlay(preview)
}

// Track the current onEnded listener so we can remove it on manual stopPlay.
// Without removal, repeated start/stop accumulates dead listeners on videoEl
// (the once:true flag fires-and-removes, but only when the event actually
// fires — manual stop never fires it).
let videoEndedHandler: (() => void) | null = null

function attachVideoEndedHandler(onEnded: () => void): void {
  if (!videoEl) return
  if (videoEndedHandler) videoEl.removeEventListener('ended', videoEndedHandler)
  videoEndedHandler = onEnded
  videoEl.addEventListener('ended', onEnded, { once: true })
}

function detachVideoEndedHandler(): void {
  if (videoEl && videoEndedHandler) {
    videoEl.removeEventListener('ended', videoEndedHandler)
    videoEndedHandler = null
  }
}

function startPlay(preview: boolean): void {
  // Video-only mode: no audio buffer, but video element can still play
  if (isVideoFile && videoEl && !audioBuffer) {
    isPreview    = preview
    loopStartSec = playStartSec
    isPlaying    = true
    videoEl.currentTime = clampMain(playStartSec)
    videoEl.play().catch(() => {})
    attachVideoEndedHandler(() => {
      videoEndedHandler = null
      if (!isPlaying) return
      if (isLooping) { stopPlay(); playStartSec = loopStartSec; startPlay(isPreview) }
      else { isPlaying = false; cancelAnimationFrame(rafId); updatePlayIcon(); drawWaveform() }
    })
    updatePlayIcon()
    animate()
    return
  }

  if (!audioBuffer || !audioCtx) return

  // Video playback: drive the video element, use Web Audio only for gain meter
  if (isVideoFile && videoEl) {
    isPreview    = preview
    loopStartSec = playStartSec
    isPlaying    = true
    videoEl.currentTime = clampMain(playStartSec)
    videoEl.play().catch(() => {})

    // On natural end, handle loop / stop
    attachVideoEndedHandler(() => {
      videoEndedHandler = null
      if (!isPlaying) return
      if (isLooping) {
        stopPlay()
        playStartSec = loopStartSec
        startPlay(isPreview)
      } else {
        isPlaying = false
        cancelAnimationFrame(rafId)
        updatePlayIcon()
        drawWaveform()
      }
    })

    updatePlayIcon()
    animate()
    return
  }

  // If the playhead has somehow ended up inside a cut (e.g. arrow-key seek
  // landed there), snap it to the cut's end before scheduling so audio and
  // playhead stay in sync from the very first frame.
  playStartSec = snapOutOfCut(playStartSec)

  isPreview = preview
  loopStartSec = playStartSec

  // Extended-timeline playback: playStartSec can be inside intro (< 0),
  // main ([0, duration]), or outro (> duration). We schedule each region's
  // buffer at the right offset so audio always matches the playhead.
  const introOn = includeIntroOutro && !!introBuffer
  const outroOn = includeIntroOutro && !!outroBuffer
  const inIntro = playStartSec < 0 && introOn
  const inOutro = playStartSec > duration && outroOn
  const mainStartSec = inIntro ? 0 : (inOutro ? duration : Math.max(0, playStartSec))

  isPlaying        = true
  playStartCtxTime = audioCtx.currentTime

  let when = audioCtx.currentTime
  const nodes: AudioBufferSourceNode[] = []

  const mixGain = audioCtx.createGain()
  // Apply the user-set peak-normalization gain to playback. This mirrors
  // the ffmpeg `volume={gainDb}dB` filter we add at export time so what
  // they hear during preview matches what they'll get in the exported file.
  mixGain.gain.value = gainFactor()
  mixGain.connect(audioCtx.destination)

  // Schedule intro from the right offset whenever playhead is at-or-before
  // main start. When playhead is inside intro (negative sec) we start the
  // intro from `effIntroDur + playStartSec` so audio matches the playhead.
  if (introOn && playStartSec < duration) {
    const iDur = introBuffer!.duration
    const introOffset = inIntro ? Math.max(0, effIntroDur() + playStartSec) : 0
    const playDur = iDur - introOffset
    if (playDur > 0.01) {
      const introNode = audioCtx.createBufferSource()
      introNode.buffer = introBuffer
      introNode.connect(mixGain)
      introNode.start(when, introOffset, playDur)
      when += playDur
      nodes.push(introNode)
    }
  }

  if (!inOutro) {
    const allSegs  = preview ? getKeepSegs() : [{ start: 0, end: duration }]
    const segments = allSegs.filter(s => s.end > mainStartSec)

    let firstMainSec = -1
    for (let i = 0; i < segments.length; i++) {
      const seg    = segments[i]
      const offset = i === 0 ? Math.max(0, mainStartSec - seg.start) : 0
      const dur    = seg.end - seg.start - offset
      if (dur <= 0.01) continue

      if (firstMainSec < 0) firstMainSec = seg.start + offset

      const node = audioCtx.createBufferSource()
      node.buffer = audioBuffer
      node.connect(mixGain)
      node.start(when, seg.start + offset, dur)
      when += dur
      nodes.push(node)
    }
    // Preview-skip: if playback skipped over a cut and started later, advance
    // playStartSec so the playhead matches where audio actually starts. Only
    // applies when not playing through intro (we keep negative playStartSec
    // while inside intro so the timecode shows "Intro …").
    if (!inIntro && firstMainSec >= 0 && firstMainSec > mainStartSec + 0.01) {
      playStartSec = firstMainSec
    }
  }

  sourceNodes = nodes

  // Schedule outro after main content (or partway through if playhead is
  // already inside outro).
  if (outroOn) {
    const outroOffset = inOutro ? Math.max(0, playStartSec - duration) : 0
    const oDur = outroBuffer!.duration - outroOffset
    if (oDur > 0.01) {
      const outroNode = audioCtx.createBufferSource()
      outroNode.buffer = outroBuffer
      outroNode.connect(mixGain)
      outroNode.start(when, outroOffset, oDur)
      nodes.push(outroNode)
    }
  }

  if (nodes.length === 0) { isPlaying = false; return }

  nodes[nodes.length - 1]?.addEventListener('ended', () => {
    if (!isPlaying) return
    if (isLooping) {
      stopPlay()
      playStartSec = loopStartSec
      startPlay(isPreview)
    } else {
      isPlaying = false
      cancelAnimationFrame(rafId)
      updatePlayIcon()
      drawWaveform()
    }
  })

  updatePlayIcon()
  animate()
}

function stopPlay(): void {
  detachVideoEndedHandler()
  if (isVideoFile && videoEl) {
    if (isPlaying) {
      playStartSec = videoEl.currentTime
    }
    videoEl.pause()
    isPlaying = false
    cancelAnimationFrame(rafId)
    updatePlayIcon()
    drawWaveform()
    return
  }

  for (const n of sourceNodes) { try { n.stop() } catch { /* already stopped */ } }
  sourceNodes = []
  if (isPlaying && audioCtx) {
    playStartSec = clampPlayable(playStartSec + (audioCtx.currentTime - playStartCtxTime))
  }
  isPlaying = false
  cancelAnimationFrame(rafId)
  updatePlayIcon()
  drawWaveform()
}

function animate(): void {
  if (!isPlaying) return

  if (isVideoFile && videoEl) {
    const curSec = videoEl.currentTime

    // Preview mode: skip over cut regions
    if (isPreview) {
      const nextCut = cuts.find(c => curSec >= c.start && curSec < c.end)
      if (nextCut) {
        videoEl.currentTime = nextCut.end
        playStartSec = nextCut.end
      }
    }

    updateTimecode(curSec)
    autoScrollToPlayhead(curSec)
    setCurrentTranscriptTime(curSec)
    drawWaveform()
    rafId = requestAnimationFrame(animate)
    return
  }

  if (!audioCtx) return
  const curSec = playStartSec + (audioCtx.currentTime - playStartCtxTime)
  updateTimecode(curSec)
  autoScrollToPlayhead(curSec)
  setCurrentTranscriptTime(curSec)
  drawWaveform()
  rafId = requestAnimationFrame(animate)
}

function updatePlayIcon(): void {
  const icon       = $('editor-play-icon')
  const previewBtn = $('btn-editor-preview')
  const canvasWrap = $('editor-canvas-wrap')
  if (!icon) return
  if (isPlaying && !isPreview) {
    icon.innerHTML = '<rect x="5" y="4" width="4" height="12" rx="1"/><rect x="11" y="4" width="4" height="12" rx="1"/>'
    previewBtn?.classList.remove('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else if (isPlaying && isPreview) {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    previewBtn?.classList.add('is-playing')
    canvasWrap?.classList.add('is-playing')
  } else {
    icon.innerHTML = '<path d="M6.3 4.6a1 1 0 011.4 0l6 5a1 1 0 010 1.6l-6 5A1 1 0 016 15.4V4.6z"/>'
    canvasWrap?.classList.remove('is-playing')
    previewBtn?.classList.remove('is-playing')
  }
}

// ── Export flow ────────────────────────────────────────────────────────────
function openExportModal(): void {
  if (!filePath) return

  // Show/hide format section vs video notice
  const fmtSection   = $('export-fmt-section')
  const videoNotice  = $('export-video-notice')
  if (fmtSection)  fmtSection.style.display  = isVideoFile ? 'none' : ''
  if (videoNotice) videoNotice.style.display = isVideoFile ? '' : 'none'

  // Update gain summary — only shown when peak normalize has been applied.
  const procRow  = $('export-proc-row')
  const summary  = $('export-proc-summary')
  if (procRow && summary) {
    if (audioGainDb !== 0) {
      const sign = audioGainDb >= 0 ? '+' : ''
      summary.textContent = `${t('editor.normalizeApplied', 'Normalisert')} (${sign}${audioGainDb.toFixed(1)} dB → -1 dBFS)`
      procRow.style.display = ''
    } else {
      procRow.style.display = 'none'
    }
  }
  const ioRow     = $('export-io-row')
  const ioSummary = $('export-io-summary')
  if (ioRow && ioSummary) {
    const parts = []
    if (!isVideoFile) {
      if (includeIntroOutro && settings.editorIntroPath) {
        parts.push('Intro: ' + (settings.editorIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (includeIntroOutro && settings.editorOutroPath) {
        parts.push('Outro: ' + (settings.editorOutroPath.split(/[/\\]/).pop() ?? ''))
      }
    } else {
      if (includeIntroOutro && videoIntroPath) {
        parts.push('Video-intro: ' + (videoIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (includeIntroOutro && videoOutroPath) {
        parts.push('Video-outro: ' + (videoOutroPath.split(/[/\\]/).pop() ?? ''))
      }
    }
    ioSummary.textContent = parts.length ? parts.join(' · ') : ''
    ioRow.style.display   = parts.length ? '' : 'none'
  }
  // Render publishing section
  void renderPublishOptions()

  const exportModal = $('editor-export-modal')
  if (exportModal) exportModal.style.display = 'flex'
}

// Publishing options state (mirrored from DOM into module on toggle)
interface PublishState {
  gdrive:   boolean
  dropbox:  boolean
  onedrive: boolean
  podcast:  boolean
  youtube:  boolean
}
const publishSelections: PublishState = { gdrive: false, dropbox: false, onedrive: false, podcast: false, youtube: false }
let configuredCache: { gdrive: boolean; dropbox: boolean; onedrive: boolean; youtubeConnected: boolean } =
  { gdrive: false, dropbox: false, onedrive: false, youtubeConnected: false }

/**
 * Build the publishing checkbox list in the export modal. Each service is
 * shown ONLY if `cloudIsConfigured(...)` returns true (user has connected it).
 * Podcast appears when settings.podcast.enabled is true. If nothing is
 * configured, we show a single "Konfigurer publisering →" link to the
 * publish settings page.
 *
 * For video files we also append disabled placeholder rows for YouTube +
 * Vimeo so the user can see the roadmap.
 */
async function renderPublishOptions(): Promise<void> {
  const wrap     = $('export-publish-options')
  const configL  = $('export-publish-configure')
  const andBtn   = $('btn-export-and-publish')
  const progress = $('export-publish-progress')
  if (!wrap || !configL || !andBtn) return

  wrap.innerHTML = ''
  if (progress) { progress.style.display = 'none'; progress.textContent = '' }

  // Refresh service configuration (cheap IPC) — these aren't expected to
  // change mid-session but the user could have configured one in another
  // window so we read fresh each open.
  try {
    configuredCache.gdrive   = await window.api.cloudIsConfigured('google-drive') as boolean
    configuredCache.dropbox  = await window.api.cloudIsConfigured('dropbox') as boolean
    configuredCache.onedrive = await window.api.cloudIsConfigured('onedrive') as boolean
    const yt = await window.api.youtubeStatus()
    configuredCache.youtubeConnected = !!yt?.connected
  } catch { /* leave defaults — falsy */ }

  const podcastEnabled = settings.podcast?.enabled === true

  const haveAny = configuredCache.gdrive || configuredCache.dropbox || configuredCache.onedrive || podcastEnabled || (isVideoFile && configuredCache.youtubeConnected)
  configL.style.display = haveAny ? 'none' : ''
  // The "Eksporter og publiser" button is only meaningful if at least one
  // service is configured.
  ;(andBtn as HTMLElement).style.display = haveAny ? '' : 'none'

  function addRow(key: keyof PublishState, label: string, enabled: boolean, disabled = false, tooltip = ''): void {
    const row = document.createElement('label')
    row.className = 'export-publish-option' + (disabled ? ' is-disabled' : '')
    if (tooltip) row.title = tooltip
    const chk = document.createElement('input')
    chk.type = 'checkbox'
    chk.disabled = disabled || !enabled
    chk.checked = false
    chk.addEventListener('change', () => { publishSelections[key] = chk.checked })
    const span = document.createElement('span')
    span.textContent = label
    row.appendChild(chk)
    row.appendChild(span)
    wrap!.appendChild(row)
  }

  // Reset selections each time we open
  publishSelections.gdrive   = false
  publishSelections.dropbox  = false
  publishSelections.onedrive = false
  publishSelections.podcast  = false
  publishSelections.youtube  = false

  if (configuredCache.gdrive)   addRow('gdrive',   t('editor.exportPublishGdrive',   'Last opp til Google Drive'), true)
  if (configuredCache.dropbox)  addRow('dropbox',  t('editor.exportPublishDropbox',  'Last opp til Dropbox'),       true)
  if (configuredCache.onedrive) addRow('onedrive', t('editor.exportPublishOnedrive', 'Last opp til OneDrive'),      true)
  if (podcastEnabled)           addRow('podcast',  t('editor.exportPublishPodcast',  'Oppdater podcast RSS-feed'),  true)

  // Video files: surface YouTube as an actionable row. If user is connected,
  // checkbox enables upload; otherwise we render a "Koble til YouTube"-link
  // so they can opt-in inline without leaving the modal.
  if (isVideoFile) {
    if (configuredCache.youtubeConnected) {
      addRow('youtube', t('editor.exportPublishYoutube', 'Last opp video til YouTube (privat)'), true)
    } else {
      const row = document.createElement('div')
      row.className = 'export-publish-option export-publish-connect-row'
      const span = document.createElement('span')
      span.textContent = t('editor.exportPublishYoutube', 'Last opp video til YouTube')
      const link = document.createElement('a')
      link.href = '#'
      link.className = 'export-publish-connect-link'
      link.textContent = t('editor.exportPublishYoutubeConnect', '→ Koble til YouTube')
      link.addEventListener('click', async (e) => {
        e.preventDefault()
        link.textContent = t('editor.exportPublishYoutubeConnecting', 'Åpner Google-pålogging…')
        const res = await window.api.youtubeConnect()
        if (res?.ok) {
          configuredCache.youtubeConnected = true
          await renderPublishOptions()
        } else {
          link.textContent = `${t('editor.exportPublishYoutubeFailed', 'Tilkobling feilet')}: ${res?.error ?? ''}`.slice(0, 80)
        }
      })
      row.appendChild(span)
      row.appendChild(link)
      wrap.appendChild(row)
    }

    // Vimeo placeholder remains for later phase — it has a fundamentally
    // different OAuth+API model so it's a separate workstream.
    const vmLabel = t('editor.exportPublishVimeo', 'Last opp video til Vimeo')
    const phase2  = t('editor.exportPublishPhase2', 'Kommer i en senere versjon — krever separat OAuth-oppsett')
    addRow('gdrive', vmLabel, false, /*disabled*/ true, phase2)
  }
}

/**
 * Run the selected publishing actions for a freshly-exported file. Surfaces
 * progress in the export modal (which is still up — we don't close it
 * until publishing completes). Idempotent on its own — the underlying
 * cloud queue dedupes by file path + service.
 */
async function runPublishingForExport(outputPath: string): Promise<void> {
  const progress = $('export-publish-progress')
  if (progress) { progress.style.display = ''; progress.classList.remove('is-error', 'is-success'); progress.textContent = '' }

  const tasks: { label: string; run: () => Promise<{ ok: boolean; error?: string; url?: string }> }[] = []
  if (publishSelections.gdrive) {
    tasks.push({ label: 'Google Drive', run: () => window.api.cloudUploadFile('google-drive', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.dropbox) {
    tasks.push({ label: 'Dropbox', run: () => window.api.cloudUploadFile('dropbox', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.onedrive) {
    tasks.push({ label: 'OneDrive', run: () => window.api.cloudUploadFile('onedrive', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.youtube) {
    // Build metadata from the file name + chapter metadata.
    const title = (meta.title?.trim() || (outputPath.split(/[/\\]/).pop() ?? 'SundayRec opptak')).replace(/\.[^.]+$/, '')
    const description = (meta.description ?? '').slice(0, 5000)
    tasks.push({
      label: 'YouTube',
      run: async () => {
        // Subscribe to progress events for this upload so the user sees a
        // live percentage instead of a frozen "Laster opp…" string. The
        // unsubscribe call is fired when the upload-promise settles.
        const unsub = window.api.on?.('youtube-upload-progress', (payload: unknown) => {
          if (progress && payload && typeof payload === 'object') {
            const { uploadedBytes, totalBytes } = payload as { uploadedBytes: number; totalBytes: number }
            if (totalBytes > 0) {
              const pct = Math.floor((uploadedBytes / totalBytes) * 100)
              progress.textContent = `${t('editor.publishUploading', 'Laster opp til')} YouTube… ${pct}%`
            }
          }
        })
        try {
          const r = await window.api.youtubeUpload(outputPath, {
            title,
            description,
            privacyStatus: 'private',  // safe default — user changes from YouTube Studio if they want public
          })
          return { ok: !!r?.ok, error: r?.error, url: r?.url }
        } finally {
          unsub?.()
        }
      },
    })
  }

  let allOk = true
  const messages: string[] = []
  for (const task of tasks) {
    if (progress) progress.textContent = `${t('editor.publishUploading', 'Laster opp til')} ${task.label}…`
    try {
      const r = await task.run()
      if (r && r.ok === false) {
        allOk = false
        messages.push(`${task.label}: ${r.error ?? 'feil'}`)
      } else if (r && r.url) {
        messages.push(`${task.label}: ✓ (${r.url})`)
      } else {
        messages.push(`${task.label}: ✓`)
      }
    } catch (err) {
      allOk = false
      messages.push(`${task.label}: ${(err as Error).message}`)
    }
  }

  // Podcast RSS regen runs last (after any uploads complete, since RSS may
  // reference the just-uploaded cloud URLs).
  if (publishSelections.podcast) {
    if (progress) progress.textContent = t('editor.publishRssUpdating', 'Oppdaterer RSS-feed…')
    const service = settings.podcast?.service ?? 'google-drive'
    try {
      const r = await window.api.podcastRegenerate(service) as { ok: boolean; error?: string }
      if (r && r.ok === false) {
        allOk = false
        messages.push(`RSS: ${r.error ?? 'feil'}`)
      } else {
        messages.push(`RSS: ✓`)
      }
    } catch (err) {
      allOk = false
      messages.push(`RSS: ${(err as Error).message}`)
    }
  }

  if (progress) {
    progress.classList.toggle('is-success', allOk)
    progress.classList.toggle('is-error', !allOk)
    progress.textContent = (allOk ? `${t('editor.publishDone', '✓ Publisering ferdig')} — ` : `${t('editor.publishFailed', '✕ Publisering feilet')} — `) + messages.join(' · ')
  }
}

function closeExportModal(): void {
  const exportModal = $('editor-export-modal')
  if (exportModal) exportModal.style.display = 'none'
}

async function runExport(): Promise<void> {
  closeExportModal()
  const btn      = $('btn-editor-save') as HTMLButtonElement
  const progRow  = $('editor-export-progress-row')
  const progBar  = $('editor-export-progress-bar')
  const progLbl  = $('editor-export-progress-label')
  const resultRow = $('editor-result-row')

  if (btn)     { btn.disabled = true; btn.textContent = t('editor.exportExporting') || 'Eksporterer…' }
  if (progRow) progRow.style.display = ''
  if (progBar) progBar.style.width   = '0%'
  if (resultRow) { resultRow.style.display = 'none' }

  const fmt = (document.querySelector<HTMLElement>('.export-fmt-btn.active')?.dataset.fmt ?? 'mp3') as 'mp3'|'wav'|'flac'|'aac'
  const dest = document.querySelector<HTMLElement>('.export-dest-btn.active')?.dataset.dest ?? 'same'
  const bitrate   = parseInt((($('export-bitrate')    as HTMLSelectElement)?.value  ?? '192'))
  const bitDepth  = parseInt((($('export-bitdepth')   as HTMLSelectElement)?.value  ?? '16')) as 16|24

  const mode: 'new' | 'replace' | 'folder' =
    dest === 'replace' ? 'replace' :
    dest === 'folder'  ? 'folder'  : 'new'

  // Auto-save metadata before export
  if (metaDirty) await saveMetadata()

  let result: { ok: boolean; outputPath?: string; error?: string }

  if (isVideoFile) {
    result = await window.api.editorExportVideo({
      inputPath:    filePath,
      cutRegions:   cuts,
      duration,
      mode,
      outputFolder: exportOutputFolder || undefined,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (includeIntroOutro && videoIntroPath) ? videoIntroPath : undefined,
      outroPath:  (includeIntroOutro && videoOutroPath) ? videoOutroPath : undefined,
      metadata:   meta,
    })
  } else {
    result = await window.api.editorExportFile({
      inputPath:    filePath,
      cutRegions:   cuts,
      duration,
      mode,
      outputFolder: exportOutputFolder || undefined,
      outputFormat: fmt,
      outputBitrate:  bitrate,
      outputBitDepth: bitDepth,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (includeIntroOutro && settings.editorIntroPath) ? settings.editorIntroPath : undefined,
      outroPath:  (includeIntroOutro && settings.editorOutroPath) ? settings.editorOutroPath : undefined,
      metadata:   meta,
    })
  }

  if (progRow) progRow.style.display = 'none'
  if (progBar) progBar.style.width   = '0%'
  if (btn) { btn.disabled = false; btn.textContent = t('editor.save') || 'Eksporter' }

  const row  = $('editor-result-row')
  const text = $('editor-result-text')
  if (row) row.style.display = ''

  if (result.ok) {
    const fname = (result.outputPath ?? '').split(/[/\\]/).pop() ?? ''
    if (text) text.textContent = (t('editor.saveOk') || '✓ Eksportert') + (fname ? ' — ' + fname : '')
    if (row) row.setAttribute('data-ok', 'true')
    clearEditorDraft()  // export succeeded — drop the autosave sidecar
    clearDirty()
    // Run publishing if user picked "Eksporter og publiser"
    if (publishAfterExport && result.outputPath) {
      await runPublishingForExport(result.outputPath)
    }
    publishAfterExport = false
  } else {
    if (text) text.textContent = describeExportError(result.error)
    if (row) row.removeAttribute('data-ok')
  }
}

/**
 * Map an export error code from the main process to a user-friendly Norwegian
 * sentence. Falls back to the raw code so an unfamiliar error still surfaces
 * something the user can search for.
 */
function describeExportError(err: string | undefined): string {
  switch (err) {
    case 'force_wav_replace_unsafe':
      return '✕ ' + t('editor.errReplaceUnsafe', 'Kan ikke overskrive originalfilen i dette formatet. Bruk "Lagre som ny fil" i stedet.')
    case 'no_audio_remaining':
      return '✕ ' + t('editor.errNoAudioRemaining', 'Ingen lyd igjen — kuttene dekker hele opptaket. Fjern minst ett kutt før du eksporterer.')
    case 'cancelled':
      return '✕ ' + t('editor.errCancelled', 'Eksport avbrutt.')
    case 'timeout':
      return '✕ ' + t('editor.errTimeout', 'Eksporten tok for lang tid og ble stoppet. Prøv igjen, eller del filen i flere mindre opptak.')
    case 'invalid_path':
    case 'file_not_found':
      return '✕ ' + t('editor.errFileNotFound', 'Originalfilen er ikke tilgjengelig — er disken frakoblet?')
    case 'invalid_duration':
    case 'invalid_cut_regions':
      return '✕ ' + t('editor.errCutData', 'Intern feil i kuttdataene. Prøv å laste filen på nytt.')
    default:
      return (t('editor.saveError') || '✕ Feil') + (err ? ': ' + err : '')
  }
}

function updateExportFormatUI(fmt: string): void {
  const mp3  = $('export-mp3-opts')
  const wav  = $('export-wav-opts')
  const aac  = $('export-aac-opts')
  if (mp3) mp3.style.display = fmt === 'mp3' ? '' : 'none'
  if (wav) wav.style.display = fmt === 'wav' ? '' : 'none'
  if (aac) aac.style.display = fmt === 'aac' ? '' : 'none'
}

// ── Editor prompt toast ───────────────────────────────────────────────────
export function showEditorPrompt(fp: string): void {
  const toast = $('editor-prompt-toast')
  if (!toast) return
  toast.dataset.path    = fp
  toast.style.display   = 'flex'
  // Auto-dismiss after 12s
  setTimeout(() => { if (toast.style.display !== 'none') dismissEditorPrompt() }, 12000)
}

export function dismissEditorPrompt(): void {
  const toast = $('editor-prompt-toast')
  if (!toast) return
  toast.classList.add('toast-dismissing')
  setTimeout(() => {
    toast.style.display = 'none'
    toast.classList.remove('toast-dismissing')
    delete toast.dataset.path
  }, 250)
}

// ── Page state ────────────────────────────────────────────────────────────
function showState(state: 'empty' | 'loading' | 'workspace'): void {
  const emptyEl     = $('editor-empty')
  const loadingEl   = $('editor-loading')
  const workspaceEl = $('editor-workspace')
  if (emptyEl)     emptyEl.style.display     = state === 'empty'     ? '' : 'none'
  if (loadingEl)   loadingEl.style.display   = state === 'loading'   ? '' : 'none'
  if (workspaceEl) workspaceEl.style.display = state === 'workspace' ? '' : 'none'
  if (state === 'empty') renderRecentFiles()
}

/**
 * Render the "Nylig brukte filer" list in the empty state. Pulls the last
 * 5 entries from settings.recordingHistory that have a valid `path`, and
 * makes each item clickable to load via openEditorWithFile.
 *
 * Also shows the "Gjennomgangs-kø" link when there are pending review-queue
 * entries. The link navigates to home (where the prep queue lives).
 */
function renderRecentFiles(): void {
  const wrap = $('editor-empty-recents')
  const list = $('editor-empty-recents-list')
  if (!wrap || !list) return
  const hist = settings.recordingHistory ?? []
  const recent = hist
    .filter(e => e.path && e.status === 'ok')
    .slice(0, 5)
  if (recent.length === 0) { wrap.style.display = 'none'; return }
  wrap.style.display = ''
  list.innerHTML = ''
  for (const e of recent) {
    const item = document.createElement('div')
    item.className = 'editor-recent-item'
    const fname = (e.filename || (e.path?.split(/[/\\]/).pop() ?? '')).replace(/_redigert(_\d+)?/, '')
    item.innerHTML = `
      <svg viewBox="0 0 20 20" width="14" height="14" fill="currentColor"><path d="M4 4a2 2 0 012-2h4l2 2h4a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2z"/></svg>
      <span class="editor-recent-name">${escapeHtml(fname)}</span>
      <span class="editor-recent-meta">${escapeHtml(e.date || '')} · ${escapeHtml(e.duration || '')}</span>
    `
    item.addEventListener('click', () => {
      if (e.path) openEditorWithFile(e.path)
    })
    list.appendChild(item)
  }

  // Review-queue link: best-effort — we just always offer it if there's
  // a non-empty history. The review queue itself lives on home page.
  const reviewWrap = $('editor-empty-review')
  if (reviewWrap) reviewWrap.style.display = ''
}

/**
 * Build a compact one-line summary for the header: duration · cut count ·
 * normalize state. Lives in the sticky editor header right next to the
 * filename so the user always knows what state the file is in without
 * scrolling. Updates lazily — only when something changes (dirty marker
 * flip, cut add/remove, normalize toggle).
 */
function updateHeaderSummary(): void {
  const summaryEl = $('editor-header-summary')
  const dirtyEl   = $('editor-dirty-dot')
  if (dirtyEl) dirtyEl.style.display = editorDirty ? '' : 'none'
  if (!summaryEl) return
  if (!filePath || !duration) { summaryEl.textContent = ''; return }
  const remaining = getRemainingDuration()
  const parts = [formatDuration(remaining)]
  if (cuts.length > 0) parts.push(`${cuts.length} kutt`)
  if (audioGainDb !== 0) {
    const sign = audioGainDb >= 0 ? '+' : ''
    parts.push(`normalisert (${sign}${audioGainDb.toFixed(1)} dB)`)
  }
  summaryEl.textContent = parts.join(' · ')
}

/**
 * Prompt the user before discarding unsaved edits. Returns true if the
 * user wants to proceed (no dirty state, or they confirmed); false if
 * they cancelled.
 *
 * Uses native confirm() — same idiom as the existing review-discard
 * button on line ~487. A custom modal would be nicer but lower priority.
 */
function confirmDiscardIfDirty(intent: 'open' | 'close'): boolean {
  if (!editorDirty) return true
  const msg = intent === 'close'
    ? t('editor.confirmClose', 'Du har ulagrede endringer. Lukk likevel?')
    : t('editor.confirmOpenOther', 'Du har ulagrede endringer. Åpne ny fil likevel?')
  return confirm(msg)
}

/**
 * Tear down the current file and return to the empty state. Releases all
 * audio data, peaks, cuts, and metadata. The user confirmed any dirty-state
 * warning already (caller's responsibility).
 */
function closeCurrentFile(): void {
  stopPlay()
  clearTranscript()
  audioCtx?.close().catch(() => {})
  audioCtx = null
  audioBuffer = null
  introBuffer = null
  outroBuffer = null
  introPeaks = null
  outroPeaks = null
  peaks = null
  cuts = []
  cutHistory = []
  cutHistoryIdx = -1
  suggestions = []
  clipTimes = []
  lastAnalyzedAt = 0
  meta = { title: '', speaker: '', description: '', chapters: [] }
  clearDirty()
  if (videoEl) {
    videoEl.pause()
    videoEl.src = ''
    videoEl.load()
  }
  isVideoFile = false
  audioGainDb = 0
  setNormalizeUI(0, false)
  reviewPrepId = null
  reviewPrep = null
  loadAndUpdateReviewBanner()
  filePath = ''
  duration = 0
  showState('empty')
}

function showEditorError(msg: string): void {
  const loadingEl   = $('editor-loading')
  const errorEl     = $('editor-loading-error') ?? (() => {
    const el = document.createElement('div')
    el.id        = 'editor-loading-error'
    el.className = 'editor-error-toast'
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:9999'
    document.body.appendChild(el)
    return el
  })()
  errorEl.textContent = msg
  errorEl.style.display = ''
  if (loadingEl) loadingEl.style.display = 'none'
  setTimeout(() => { errorEl.style.display = 'none' }, 6000)
}

// ── Time formatting ───────────────────────────────────────────────────────
function formatTime(s: number): string {
  const h   = Math.floor(s / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`
}

function formatDuration(s: number): string {
  if (s < 1)   return `${(s * 1000).toFixed(0)}ms`
  if (s < 60)  return `${s.toFixed(1)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
  return `${Math.floor(s / 3600)}t ${Math.floor((s % 3600) / 60)}m`
}

function updateTimecode(sec: number): void {
  const el = $('editor-time-cur')
  if (!el) return
  // Show "Intro 0:12" / "Outro 0:05" prefix when playhead is in those slots
  // so the user can see at a glance where they are on the extended timeline.
  if (sec < 0 && effIntroDur() > 0) {
    el.textContent = `Intro ${formatTime(sec + effIntroDur())}`
  } else if (sec > duration && effOutroDur() > 0) {
    el.textContent = `Outro ${formatTime(sec - duration)}`
  } else {
    el.textContent = formatTime(Math.max(0, Math.min(sec, duration)))
  }
}

function updateTotalTime(): void {
  const el = $('editor-time-tot')
  if (el) el.textContent = formatTime(duration)
}

// ── Mastering panel ───────────────────────────────────────────────────────

interface MasterPresetView {
  id: string; label: string; description: string
  targetLufs: number; targetLra: number; truePeakDb: number; filters: string
}

let masterPresets: MasterPresetView[] = []
let masterJobId   = ''
let masterPreviewPath = ''
let masterOriginalPreviewPath = ''
let masterProgressUnsubscribe: (() => void) | null = null

async function setupMasteringPanel(): Promise<void> {
  const select       = $('master-preset-select') as HTMLSelectElement | null
  const btnPreview   = $('btn-master-preview') as HTMLButtonElement | null
  const btnListenO   = $('btn-master-listen-orig') as HTMLButtonElement | null
  const btnApply     = $('btn-master-apply') as HTMLButtonElement | null
  const btnCancel    = $('btn-master-cancel') as HTMLButtonElement | null
  const btnOpenFold  = $('btn-master-open-folder') as HTMLButtonElement | null
  const btnListenDn  = $('btn-master-listen-done') as HTMLButtonElement | null

  if (!select || !btnPreview || !btnApply) return

  // Fetch presets once. Network roundtrip is local IPC — fast.
  try { masterPresets = await window.api.masterPresets() } catch { masterPresets = [] }

  // Populate selector. Pre-select the recommended preset (speech-clear).
  select.innerHTML = ''
  for (const p of masterPresets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    select.appendChild(opt)
  }
  const recommended = masterPresets.find(p => p.id === 'speech-clear') ?? masterPresets[0]
  if (recommended) select.value = recommended.id
  updateMasterDesc()

  select.addEventListener('change', updateMasterDesc)

  btnPreview.addEventListener('click', () => runMasterPreview())
  btnListenO?.addEventListener('click', () => toggleListenOriginal())
  btnApply.addEventListener('click', () => runMasterApply())
  btnCancel?.addEventListener('click', () => runMasterCancel())
  btnOpenFold?.addEventListener('click', () => {
    const out = btnOpenFold.dataset.path
    if (out) window.api.revealFile(out).catch(() => {})
  })
  btnListenDn?.addEventListener('click', () => {
    const out = btnListenDn.dataset.path
    if (!out) return
    const audio = $('master-preview-audio') as HTMLAudioElement | null
    if (!audio) return
    audio.src = 'file://' + out
    audio.style.display = ''
    audio.play().catch(() => {})
  })

  // Progress channel listener (set up once; outlives panel rebuilds)
  if (masterProgressUnsubscribe) { try { masterProgressUnsubscribe() } catch {} ; masterProgressUnsubscribe = null }
  const unsub = window.api.on('master-progress', (data: unknown) => {
    const { currentSec, totalSec } = data as { currentSec: number; totalSec: number }
    const bar   = $('master-progress-bar')
    const label = $('master-status-label')
    const pct = totalSec > 0 ? Math.min(99, Math.round((currentSec / totalSec) * 100)) : 0
    if (bar)   bar.style.width = pct + '%'
    if (label) label.textContent = `${t('master.applying', 'Mastrer…')} ${pct}%`
  })
  if (typeof unsub === 'function') masterProgressUnsubscribe = unsub
}

function updateMasterDesc(): void {
  const select = $('master-preset-select') as HTMLSelectElement | null
  const descEl = $('master-preset-desc')
  if (!select || !descEl) return
  const p = masterPresets.find(x => x.id === select.value)
  descEl.textContent = p ? p.description : ''
}

function getSelectedPreset(): MasterPresetView | null {
  const select = $('master-preset-select') as HTMLSelectElement | null
  if (!select) return null
  return masterPresets.find(p => p.id === select.value) ?? null
}

async function runMasterPreview(): Promise<void> {
  if (!filePath) return
  const preset = getSelectedPreset()
  if (!preset) return
  const btn   = $('btn-master-preview') as HTMLButtonElement | null
  const audio = $('master-preview-audio') as HTMLAudioElement | null
  const btnListenO = $('btn-master-listen-orig') as HTMLButtonElement | null
  const label = $('master-status-label')
  const row   = $('master-status-row')
  const bar   = $('master-progress-bar')

  if (btn) { btn.disabled = true; btn.textContent = t('master.applying', 'Lager forhåndsvisning…') }
  if (row) row.style.display = ''
  if (bar) bar.style.width = '20%'
  if (label) label.textContent = t('master.applying', 'Lager forhåndsvisning…')

  const start = Math.max(0, Math.min(duration > 15 ? duration - 15 : 0, clampMain(playStartSec)))
  try {
    const res = await window.api.masterPreview(filePath, preset.id, start, 15)
    if (!res.ok || !res.previewPath) {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${res.error ?? 'unknown'}`
      return
    }
    masterPreviewPath = res.previewPath
    if (audio) {
      audio.src = 'file://' + res.previewPath
      audio.style.display = ''
      audio.play().catch(() => {})
    }
    if (btnListenO) btnListenO.style.display = ''
    if (label) label.textContent = t('master.done', '✓ Forhåndsvisning klar')
    if (bar)   bar.style.width   = '100%'
  } catch (err) {
    if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${(err as Error).message}`
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('master.preview', 'Lytt på forhåndsvisning') }
  }
}

function toggleListenOriginal(): void {
  const audio = $('master-preview-audio') as HTMLAudioElement | null
  const btn   = $('btn-master-listen-orig') as HTMLButtonElement | null
  if (!audio || !btn) return
  if (!masterOriginalPreviewPath || audio.dataset.mode !== 'orig') {
    // Play original snippet — file:// directly (browser decodes locally).
    audio.src = 'file://' + filePath
    audio.currentTime = clampMain(playStartSec)
    audio.dataset.mode = 'orig'
    btn.textContent = t('master.previewListenMastered', 'Lytt mastret')
    audio.style.display = ''
    audio.play().catch(() => {})
  } else if (masterPreviewPath) {
    audio.src = 'file://' + masterPreviewPath
    audio.dataset.mode = 'mast'
    btn.textContent = t('master.previewListenOrig', 'Lytt original')
    audio.play().catch(() => {})
  }
}

function deriveMasteredPath(input: string): string {
  // <dir>/<stem>_mastert.<ext>  — keep the source extension/codec format
  const lastSep   = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  const dir       = lastSep >= 0 ? input.slice(0, lastSep + 1) : ''
  const file      = lastSep >= 0 ? input.slice(lastSep + 1)    : input
  const lastDot   = file.lastIndexOf('.')
  const stem      = lastDot > 0 ? file.slice(0, lastDot) : file
  const ext       = lastDot > 0 ? file.slice(lastDot + 1).toLowerCase() : 'mp3'
  return dir + stem + '_mastert.' + ext
}

async function runMasterApply(): Promise<void> {
  if (!filePath) return
  const preset = getSelectedPreset()
  if (!preset) return
  const btnApply = $('btn-master-apply')  as HTMLButtonElement | null
  const btnPrv   = $('btn-master-preview') as HTMLButtonElement | null
  const btnCancel = $('btn-master-cancel') as HTMLButtonElement | null
  const row    = $('master-status-row')
  const bar    = $('master-progress-bar')
  const label  = $('master-status-label')
  const resRow = $('master-result-row')

  if (btnApply)  { btnApply.disabled  = true }
  if (btnPrv)    { btnPrv.disabled    = true }
  if (btnCancel) { btnCancel.style.display = '' }
  if (row)       { row.style.display = '' }
  if (bar)       { bar.style.width   = '5%' }
  if (label)     { label.textContent = t('master.applying', 'Mastrer…') + ' (måler lydstyrke…)' }
  if (resRow)    { resRow.style.display = 'none' }

  masterJobId = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const outPath = deriveMasteredPath(filePath)

  try {
    // Pass 1: measure
    const measureRes = await window.api.masterMeasure(filePath, preset.id)
    if (!measureRes.ok || !measureRes.measurement) {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${measureRes.error ?? 'measure_failed'}`
      return
    }
    const beforeLufs = measureRes.measurement.inputI
    if (label) label.textContent = `${t('master.applying', 'Mastrer…')} (${t('master.lufsBefore', 'Original')}: ${beforeLufs.toFixed(1)} LUFS → ${preset.targetLufs} LUFS)`
    if (bar) bar.style.width = '15%'

    // Pass 2: apply
    const applyRes = await window.api.masterApply({
      inputPath:   filePath,
      outputPath:  outPath,
      presetId:    preset.id,
      measurement: measureRes.measurement,
      jobId:       masterJobId,
    })

    if (applyRes.ok && applyRes.outputPath) {
      if (bar)   bar.style.width   = '100%'
      if (label) label.textContent = t('master.done', '✓ Mastret') +
        ` — ${t('master.lufsBefore', 'Original')}: ${beforeLufs.toFixed(1)} LUFS → ` +
        `${t('master.lufsAfter', 'Etter')}: ${preset.targetLufs} LUFS`
      const resText = $('master-result-text')
      const fname = applyRes.outputPath.split(/[/\\]/).pop() ?? ''
      if (resText) resText.textContent = (t('master.done', '✓ Mastret')) + (fname ? ' — ' + fname : '')
      if (resRow)  resRow.style.display = ''
      const btnOpenFold = $('btn-master-open-folder') as HTMLButtonElement | null
      const btnListenDn = $('btn-master-listen-done') as HTMLButtonElement | null
      if (btnOpenFold) { btnOpenFold.style.display = ''; btnOpenFold.dataset.path = applyRes.outputPath }
      if (btnListenDn) { btnListenDn.style.display = ''; btnListenDn.dataset.path = applyRes.outputPath }
    } else {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${applyRes.error ?? 'apply_failed'}`
    }
  } catch (err) {
    if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${(err as Error).message}`
  } finally {
    if (btnApply)  btnApply.disabled  = false
    if (btnPrv)    btnPrv.disabled    = false
    if (btnCancel) btnCancel.style.display = 'none'
    masterJobId = ''
  }
}

async function runMasterCancel(): Promise<void> {
  if (!masterJobId) return
  try { await window.api.masterCancel(masterJobId) } catch {}
  const label = $('master-status-label')
  if (label) label.textContent = t('master.cancel', 'Avbrutt')
}
