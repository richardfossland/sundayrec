import { t } from '../i18n'
import { settings, patchSettings } from '../state'
import { escHtml as escapeHtml } from '../helpers'
import type { RecordingMetadata } from '../../types'
import { setupTranscriptPanel, loadTranscriptForFile, clearTranscript, setCurrentTranscriptTime } from './editor-transcript'
import { setupThumbPanel, refresh as refreshThumbPanel, panelElementsByPrefix } from './thumbnail-panel'
import { E, $, VIDEO_EXTS, PROBE_EXTS, WEB_AUDIO_EXTS, markDirty, clearDirty, setOnDirtyChange, type Cut, type Suggestion, type HandleDrag } from './editor/state'
import { formatTime, formatDuration } from './editor/format'
import { computePeaks, computeJinglePeaks, computePeakGain, gainFactor, getExportFilters, setNormalizeUI } from './editor/peaks'
import { getLayoutGeom, effIntroDur, effOutroDur, minPlayableSec, maxPlayableSec, clampPlayable, clampMain, secToX, xToSec, xToMainSec, getRegionAtX } from './editor/geometry'
import { isInCut, isInDrag, addCut, deleteCut, undoCut, redoCut, getKeepSegs, getRemainingDuration, updateRemainingDisplay, renderCutList, pushCutHistory, clearEditorDraft } from './editor/cuts'
import { shouldShowSegment } from './editor/detection'
import { syncCanvasSize, scheduleDrawWaveform, drawWaveform, drawMinimap, updateMinimapViewport } from './editor/waveform'
import { togglePlay, stopPlay, seekTo, seekBy, jumpToCutBoundary, updateTimecode, updateTotalTime } from './editor/playback'
import { fitAll, zoomBy, panBy } from './editor/viewport'

// ── Setup ─────────────────────────────────────────────────────────────────
export function setupEditorPage(): void {
  setOnDirtyChange(updateHeaderSummary)
  E.canvas    = $('editor-canvas')  as HTMLCanvasElement
  E.minimap   = $('editor-minimap') as HTMLCanvasElement
  E.minimapVp = $('editor-minimap-vp') as HTMLElement
  E.videoEl   = $('editor-video') as HTMLVideoElement | null

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
    if (E.cuts.length === 0) return
    E.cuts = []
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
  })

  $('btn-editor-save')?.addEventListener('click',    () => openExportModal())
  $('btn-export-cancel')?.addEventListener('click',  () => closeExportModal())
  $('btn-export-confirm')?.addEventListener('click', () => { E.publishAfterExport = false; runExport() })
  $('btn-export-and-publish')?.addEventListener('click', () => { E.publishAfterExport = true; runExport() })
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
          E.exportOutputFolder = folder
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
    if (!E.peaks || E.peaks.length === 0) return
    if (E.audioGainDb !== 0) return     // already normalized — idempotent
    const gain = computePeakGain(E.peaks)
    if (!isFinite(gain) || Math.abs(gain) < 0.05) {
      // Already at (or above) target — show that explicitly
      setNormalizeUI(0, /*alreadyAtTarget*/ true)
      return
    }
    E.audioGainDb = gain
    setNormalizeUI(gain, false)
    markDirty()
    updateHeaderSummary()
    drawWaveform()
    drawMinimap()
  })

  $('btn-normalize-reset')?.addEventListener('click', () => {
    if (E.audioGainDb === 0) return
    E.audioGainDb = 0
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
      E.includeIntroOutro = ioChk.checked
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
    E.videoIntroPath = fp
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-clear-video-intro')?.addEventListener('click', () => {
    E.videoIntroPath = ''
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-pick-video-outro')?.addEventListener('click', async () => {
    const fp = await window.api.editorPickVideoFile()
    if (!fp) return
    E.videoOutroPath = fp
    updateVideoIntroOutroDisplay()
  })
  $('btn-editor-clear-video-outro')?.addEventListener('click', () => {
    E.videoOutroPath = ''
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
      if (el) (E.meta as unknown as Record<string, unknown>)[field] = el.value
      E.metaDirty = true
      markDirty()
    })
  }

  // Analyse panel: run detection
  $('btn-detect-segments')?.addEventListener('click', () => runDetection())

  // Analyse panel: segment-type toggles
  $('editor-show-speech')?.addEventListener('change', () => {
    E.showSpeechSegments = ($('editor-show-speech') as HTMLInputElement).checked
    drawWaveform()
  })
  $('editor-show-music')?.addEventListener('change', () => {
    E.showMusicSegments = ($('editor-show-music') as HTMLInputElement).checked
    drawWaveform()
  })
  $('editor-show-silence')?.addEventListener('change', () => {
    E.showSilenceSegments = ($('editor-show-silence') as HTMLInputElement).checked
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
    E.isLooping = !E.isLooping
    $('btn-editor-loop')?.classList.toggle('active', E.isLooping)
  })

  // Clip badge — jump to first clip
  $('editor-clip-badge')?.addEventListener('click', () => {
    if (E.clipTimes.length === 0) return
    E.playStartSec = Math.max(0, E.clipTimes[0] - 1)
    updateTimecode(E.playStartSec)
    const half = (E.vpEnd - E.vpStart) / 2
    E.vpStart = Math.max(0, E.playStartSec - half * 0.3)
    E.vpEnd   = Math.min(E.duration, E.vpStart + half * 2)
    updateMinimapViewport()
    drawWaveform()
  })

  // Export progress listener — drop any previous registration first so
  // setupEditorPage() called twice (renderer reload, tab swap, dev HMR)
  // doesn't stack listeners that each fire a DOM write per progress event.
  if (E.exportProgressUnsub) { try { E.exportProgressUnsub() } catch {} }
  E.exportProgressUnsub = window.api.on('editor-export-progress', (data: unknown) => {
    const { percent } = data as { percent: number }
    const bar   = $('editor-export-progress-bar')
    const label = $('editor-export-progress-label')
    if (bar)   bar.style.width   = Math.min(99, percent) + '%'
    if (label) label.textContent = `Eksporterer… ${Math.round(percent)}%`
  })

  // Mastering wiring
  setupMasteringPanel()

  // Canvas interactions
  E.canvas?.addEventListener('mousedown',   onCanvasDown)
  E.canvas?.addEventListener('mousemove',   onCanvasMove)
  E.canvas?.addEventListener('mouseup',     onCanvasUp)
  E.canvas?.addEventListener('mouseleave',  onCanvasLeave)
  E.canvas?.addEventListener('contextmenu', onCanvasContextMenu)
  E.canvas?.addEventListener('wheel',       onCanvasWheel, { passive: false })
  // Double-click on the sermon segment → trim around the sermon. Forces a
  // deliberate double-tap so single-click stays as non-destructive tap-to-seek.
  E.canvas?.addEventListener('dblclick', (e: MouseEvent) => {
    if (!E.peaks) return
    const rect = E.canvas.getBoundingClientRect()
    const sec = xToSec(e.clientX - rect.left, rect.width)
    const sermon = E.suggestions.find(s => s.type === 'sermon' && sec >= s.start && sec <= s.end)
    if (sermon) applySermonTrim()
  })

  setupMinimapInteraction()
  setupKeyboardShortcuts()
  const seekToSec = (sec: number): void => {
    E.playStartSec = clampPlayable(snapOutOfCut(sec))
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    drawWaveform()
  }
  setupTranscriptPanel(seekToSec)
  setupDragDrop()
  setupReviewBanner()

  if (E.canvas && E.canvas.parentElement) {
    // Track the observer so repeated setupEditorPage() calls (after a renderer
    // reload, for example) don't leak observers. Single observer for app life.
    if (resizeObserver) resizeObserver.disconnect()
    resizeObserver = new ResizeObserver(() => { syncCanvasSize(); drawWaveform() })
    resizeObserver.observe(E.canvas.parentElement)
  }

  showState('empty')
  updateEditorIntroOutroDisplay()

  // Wire the per-episode thumbnail panel. Hidden until a file is loaded
  // (see loadFile completion). Reads window state via getRecordingPath().
  const thumbEls = panelElementsByPrefix('editor')
  if (thumbEls) {
    setupThumbPanel(thumbEls, { kind: 'episode', getRecordingPath: () => E.filePath })
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
  if (!reviewPrep || !E.duration) return
  const trim = reviewPrep.suggestedTrim
  // Pre-apply the suggested trim as cuts (everything before + after).
  if (trim && trim.endSec > trim.startSec) {
    E.cuts = []
    if (trim.startSec > 0.5) {
      E.cuts.push({ start: 0, end: Math.min(trim.startSec, E.duration) })
    }
    if (trim.endSec < E.duration - 0.5) {
      E.cuts.push({ start: Math.max(0, trim.endSec), end: E.duration })
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
  if (!E.peaks) return
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
  if (E.videoEl && !E.videoEl.paused) {
    E.videoEl.pause()
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
  if (seq !== E.loadSeq) return false
  if (!result) { showState('empty'); return false }

  const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

  let localCtx: AudioContext | null = null
  try {
    localCtx = new AudioContext()
    const buf = await localCtx.decodeAudioData(ab)
    if (seq !== E.loadSeq) { localCtx.close().catch(() => {}); return false }
    E.audioCtx    = localCtx
    E.audioBuffer = buf
    E.duration    = result.duration > 0 ? result.duration : buf.duration
    E.peaks       = computePeaks(E.audioBuffer)
    return true
  } catch {
    localCtx?.close().catch(() => {})
    showState('empty')
    return false
  }
}

async function loadFile(fp: string): Promise<void> {
  const seq = ++E.loadSeq
  stopPlay()
  const prevCtx = E.audioCtx
  E.audioCtx = null
  // Await the close — fire-and-forget could leave an old context partially
  // alive while a new one is created. The seq-guard further down still
  // catches cases where two loadFile calls overlap, but awaiting close()
  // here means we never have two contexts processing audio at once.
  if (prevCtx) {
    try { await prevCtx.close() } catch {}
    // Bail out if a newer load started while we were closing the old context.
    if (seq !== E.loadSeq) return
  }

  E.cuts = []
  E.cutHistory = []
  E.cutHistoryIdx = -1
  E.suggestions = []
  E.filePath = fp
  E.peaks = null
  E.audioBuffer = null
  E.playStartSec = 0
  E.meta = { title: '', speaker: '', description: '', chapters: [] }
  E.metaDirty = false
  // Fresh file → drop any previous peak-normalize gain and reset the UI.
  E.audioGainDb = 0
  setNormalizeUI(0, false)
  E.lastAnalyzedAt = 0
  renderAnalyzePanel()
  // Fresh file → not dirty
  clearDirty()

  showState('loading')

  // Determine if this is a video file
  const ext = ('.' + (fp.split('.').pop()?.toLowerCase() ?? '')).toLowerCase()
  if (PROBE_EXTS.has(ext)) {
    // Ambiguous container: probe for a video stream
    const streams = await window.api.editorProbeStreams(fp)
    E.isVideoFile = !streams || streams.hasVideo
  } else {
    E.isVideoFile = VIDEO_EXTS.has(ext)
  }

  // Show/hide video panel and video intro/outro section
  const vPanel = $('editor-video-panel')
  if (vPanel) vPanel.style.display = E.isVideoFile ? '' : 'none'

  const audioIoSection = $('editor-audio-io-section')
  const videoIoSection = $('editor-video-io-section')
  if (audioIoSection) audioIoSection.style.display = E.isVideoFile ? 'none' : ''
  if (videoIoSection) videoIoSection.style.display = E.isVideoFile ? '' : 'none'

  if (E.isVideoFile) {
    // Set video source via custom protocol (registered with registerSchemesAsPrivileged)
    await window.api.editorSetVideoPath(fp)
    if (E.videoEl) {
      E.videoEl.src = 'media://current?t=' + Date.now()
      E.videoEl.load()
    }

    // Extract audio at low sample rate for waveform display
    const result = await window.api.editorExtractAudioPeaks(fp) as { data: Uint8Array | ArrayBuffer; duration: number } | null

    if (seq !== E.loadSeq) return

    if (result) {
      const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
      const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

      let localCtx: AudioContext | null = null
      try {
        localCtx = new AudioContext()
        const buf = await localCtx.decodeAudioData(ab)
        if (seq !== E.loadSeq) { localCtx.close().catch(() => {}); return }
        E.audioCtx    = localCtx
        E.audioBuffer = buf
        E.duration    = result.duration > 0 ? result.duration : buf.duration
        E.peaks       = computePeaks(E.audioBuffer)
      } catch (err) {
        console.warn('[editor] audio decode failed for video file, trying video-only mode', err)
        localCtx?.close().catch(() => {})
        // Fall through to video-only mode below
      }
    }

    // Video-only mode: no audio track (or decode failed) — get duration from video element
    if (!E.audioBuffer) {
      try {
        E.duration = await new Promise<number>((resolve, reject) => {
          if (!E.videoEl) { reject(new Error('no video element')); return }
          if (E.videoEl.readyState >= 1 && isFinite(E.videoEl.duration)) {
            resolve(E.videoEl.duration); return
          }
          const onMeta  = () => { E.videoEl?.removeEventListener('error', onErr); resolve(E.videoEl?.duration ?? 0) }
          const onErr   = () => { E.videoEl?.removeEventListener('loadedmetadata', onMeta); reject(new Error('video error')) }
          E.videoEl.addEventListener('loadedmetadata', onMeta, { once: true })
          E.videoEl.addEventListener('error', onErr, { once: true })
          setTimeout(() => {
            E.videoEl?.removeEventListener('loadedmetadata', onMeta)
            E.videoEl?.removeEventListener('error', onErr)
            reject(new Error('timeout waiting for video metadata'))
          }, 15000)
        })
        if (seq !== E.loadSeq) return
        // Flat/empty peaks — waveform shows as a thin line
        E.peaks = new Float32Array(Math.ceil(E.duration * 100))
        console.log('[editor] video-only mode, duration:', E.duration.toFixed(1) + 's')
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
        if (seq !== E.loadSeq) { localCtx.close().catch(() => {}); return }
        E.audioCtx    = localCtx
        E.audioBuffer = buf
        E.duration    = E.audioBuffer.duration
        E.peaks       = computePeaks(E.audioBuffer)
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
    if (seq !== E.loadSeq) return
    if (!result) { showState('empty'); return }

    const u8 = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data as ArrayBuffer)
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

    let localCtx: AudioContext | null = null
    try {
      localCtx = new AudioContext()
      const buf = await localCtx.decodeAudioData(ab)
      if (seq !== E.loadSeq) { localCtx.close().catch(() => {}); return }
      E.audioCtx    = localCtx
      E.audioBuffer = buf
      E.duration    = result.duration > 0 ? result.duration : buf.duration
      E.peaks       = computePeaks(E.audioBuffer)
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
  if (!E.isVideoFile) loadIntroOutroBuffers(seq)

  // Load metadata sidecar
  loadMetadataSidecar(fp, fname)
  void loadTranscriptForFile(fp)

  // Restore unsaved cuts from a previous editing session that ended abruptly.
  // The sidecar is written every 2 s during editing and cleared on successful
  // export — finding one here means we crashed or were closed mid-edit.
  try {
    const draft = await window.api.editorReadCutsDraft(fp) as { cuts?: Array<{ start: number; end: number }>; ts?: number } | null
    if (draft && Array.isArray(draft.cuts) && draft.cuts.length > 0 && seq === E.loadSeq) {
      // Only restore if draft is fresher than 7 days (avoid surprising the user
      // with months-old leftover edits).
      const ageMs = draft.ts ? Date.now() - draft.ts : 0
      if (!draft.ts || ageMs < 7 * 86400_000) {
        E.cuts = draft.cuts.filter(c => typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start)
        E.cutHistory = [JSON.parse(JSON.stringify(E.cuts))]
        E.cutHistoryIdx = 0
        console.log('[editor] restored', E.cuts.length, 'unsaved cut(s) from draft')
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
    E.includeIntroOutro = true
    const chk = $('editor-include-io') as HTMLInputElement | null
    if (chk) chk.checked = true
  }

  // Clipping badge (shown after computePeaks)
  const clipBadge = $('editor-clip-badge')
  if (clipBadge) {
    clipBadge.style.display = E.clipTimes.length > 0 ? '' : 'none'
    if (E.clipTimes.length > 0) clipBadge.textContent = `⚠ ${E.clipTimes.length} klipp`
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
    E.playStartSec = clampPlayable(snapOutOfCut(target))
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    drawWaveform()
  }

  // Mastering section is only meaningful for audio files (the entire ffmpeg
  // pipeline + LUFS measurement is audio-only; mastering a video would not
  // touch the video stream and would just re-encode the audio track).
  const masterSection = $('editor-master-section')
  if (masterSection) masterSection.style.display = E.isVideoFile ? 'none' : ''

  // Thumbnail panel — show for audio files; embedding only works for MP3 but
  // the panel still lets the user attach a sidecar image for RSS-feed hosts.
  const thumbSection = $('editor-thumb-section')
  if (thumbSection) thumbSection.style.display = E.isVideoFile ? 'none' : ''
  if (!E.isVideoFile) {
    const els = panelElementsByPrefix('editor')
    if (els) void refreshThumbPanel(els, { kind: 'episode', getRecordingPath: () => E.filePath })
  }

  // Auto-run segment analysis. Runs in the background so the editor is
  // immediately interactive — when analysis completes we surface the
  // auto-trim suggestion banner so the user can one-click prep a podcast
  // episode. Skipped if cuts were restored from a draft (they're already
  // editing) or if the user is in review-mode (handled separately).
  if (!E.isVideoFile && E.cuts.length === 0 && !reviewPrepId) {
    // Defer slightly so the workspace UI paints first.
    setTimeout(() => { void runDetection(true) }, 200)
  }
}

async function reloadIntroOutro(): Promise<void> {
  await loadIntroOutroBuffers(E.loadSeq)
}

async function loadIntroOutroBuffers(seq: number): Promise<void> {
  const introPath = settings.editorIntroPath
  const outroPath = settings.editorOutroPath
  E.introBuffer = null; E.introDuration = 0; E.introPeaks = null
  E.outroBuffer = null; E.outroDuration = 0; E.outroPeaks = null

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
    if (seq === E.loadSeq && buf) {
      E.introBuffer = buf
      E.introDuration = buf.duration
      // Compute peaks via the same routine used for the main file — gives
      // a dimmed waveform on the left slot of the timeline.
      E.introPeaks = computeJinglePeaks(buf)
    }
  }
  if (outroPath) {
    const buf = await decodeAudio(outroPath)
    if (seq === E.loadSeq && buf) {
      E.outroBuffer = buf
      E.outroDuration = buf.duration
      E.outroPeaks = computeJinglePeaks(buf)
    }
  }
  if (seq === E.loadSeq) drawWaveform()
}

function updateVideoIntroOutroDisplay(): void {
  const introEl  = $('editor-video-intro-display')
  const outroEl  = $('editor-video-outro-display')
  const clrIntro = $('btn-editor-clear-video-intro') as HTMLElement | null
  const clrOutro = $('btn-editor-clear-video-outro') as HTMLElement | null
  if (introEl) {
    const name = E.videoIntroPath.split(/[/\\]/).pop() ?? ''
    introEl.textContent = name || 'Ingen fil valgt'
    introEl.style.color = name ? '' : 'var(--text3)'
    if (clrIntro) clrIntro.style.display = name ? '' : 'none'
  }
  if (outroEl) {
    const name = E.videoOutroPath.split(/[/\\]/).pop() ?? ''
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
    E.meta = raw as RecordingMetadata
  } else {
    // Auto-fill title from filename (strip extension)
    E.meta = {
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
  if (!E.filePath) return
  await window.api.editorSaveMeta(E.filePath, E.meta)
  E.metaDirty = false
  const btn = $('btn-meta-save')
  if (btn) { btn.textContent = '✓ Lagret'; setTimeout(() => { btn.textContent = 'Lagre metadata' }, 1500) }
}

function renderMetaPanel(): void {
  const titleEl = $('meta-title') as HTMLInputElement | null
  const spkEl   = $('meta-speaker') as HTMLInputElement | null
  const descEl  = $('meta-description') as HTMLTextAreaElement | null
  if (titleEl) titleEl.value = E.meta.title
  if (spkEl)   spkEl.value   = E.meta.speaker
  if (descEl)  descEl.value  = E.meta.description
}

function renderChapterList(): void {
  const list = $('chapter-list')
  if (!list) return
  list.innerHTML = ''
  const countEl = $('editor-chapter-count')
  if (countEl) {
    countEl.textContent = String(E.meta.chapters.length)
    countEl.style.display = E.meta.chapters.length ? '' : 'none'
  }
  if (E.meta.chapters.length === 0) {
    list.innerHTML = `<div class="editor-chapters-empty">${t('editor.chaptersEmpty', 'Ingen kapitler ennå. Klikk «+ Legg til ved playhead» for å starte.')}</div>`
    return
  }
  for (let i = 0; i < E.meta.chapters.length; i++) {
    const ch = E.meta.chapters[i]
    const row = document.createElement('div')
    row.className = 'editor-chapter-row'

    const timeLbl = document.createElement('span')
    timeLbl.className = 'editor-chapter-time'
    timeLbl.textContent = formatTime(ch.time)
    timeLbl.title = t('editor.chapterClickSeek', 'Klikk for å søke')
    timeLbl.addEventListener('click', () => { E.playStartSec = ch.time; updateTimecode(ch.time); drawWaveform() })

    const nameInput = document.createElement('input')
    nameInput.className = 'editor-chapter-name'
    nameInput.value = ch.title
    nameInput.addEventListener('input', () => {
      E.meta.chapters[i].title = nameInput.value
      E.metaDirty = true
      drawWaveform()
    })

    const delBtn = document.createElement('button')
    delBtn.className = 'editor-chapter-del'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => {
      E.meta.chapters.splice(i, 1)
      E.metaDirty = true
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
/** Runs segment detection. `auto` = true skips the button-disabled UI dance
 *  (used for auto-run after file load — we don't want to spook the user with
 *  a disabled button they didn't click). */
async function runDetection(auto = false): Promise<void> {
  if (!E.filePath) return
  const btn       = $('btn-detect-segments') as HTMLButtonElement | null
  const analyzing = $('editor-segments-analyzing')
  if (!auto && btn) { btn.disabled = true; btn.textContent = t('editor.analyzing', 'Analyserer…') }
  if (analyzing)   analyzing.style.display = ''

  E.suggestions = []
  renderAnalyzePanel()
  hideSuggestionBanner()

  const fpAtStart = E.filePath
  let raw: Suggestion[] = []
  try {
    raw = (await window.api.editorDetectSegments(E.filePath)) as Suggestion[]
  } catch {
    raw = []
  }
  // Guard against the user closing/swapping the file mid-analysis: drop the
  // result if we're no longer on the same recording.
  if (fpAtStart !== E.filePath) return

  E.suggestions = raw
  E.lastAnalyzedAt = Date.now()

  if (!auto && btn) { btn.disabled = false; btn.textContent = t('editor.analyzeRun', '▶ Analyser opptak') }
  if (analyzing)   analyzing.style.display = 'none'
  renderAnalyzePanel()
  drawWaveform()

  // Show the auto-trim suggestion banner whenever we have a meaningful trim
  // (silence/music head or tail bigger than 0.5 s). Don't show if the user
  // already has cuts — they're clearly editing manually.
  if (E.cuts.length === 0) showSuggestionBanner()
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
    if (E.lastAnalyzedAt > 0) {
      const speechCount = E.suggestions.filter(s => s.type === 'speech' || s.type === 'sermon').length
      const d = new Date(E.lastAnalyzedAt)
      const date = `${d.getDate()}.${d.getMonth() + 1}`
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      summary.textContent = `${t('editor.analyzedAt', 'Sist analysert')}: ${date} ${time} · ${speechCount} ${t('editor.speechSegments', 'tale-segmenter funnet')}`
      summary.style.display = ''
    } else {
      summary.style.display = 'none'
    }
  }

  if (controls) controls.style.display = E.lastAnalyzedAt > 0 ? '' : 'none'

  // Show "Bruk forslag" / sermon-picker only when we have a sermon detected.
  const hasSermon = E.suggestions.some(s => s.type === 'sermon')
  if (markBtn)  (markBtn as HTMLElement).style.display  = hasSermon ? '' : 'none'
  if (markHint) (markHint as HTMLElement).style.display = hasSermon ? '' : 'none'
  renderSermonPicker()
}

/** Apply trim cuts around the currently-marked sermon segment: drop every-
 *  thing before sermon.start and after sermon.end. */
function applySermonTrim(): void {
  const sermon = E.suggestions.find(s => s.type === 'sermon')
  if (!sermon || !E.duration) return
  E.cuts = []
  if (sermon.start > 0.5) {
    E.cuts.push({ start: 0, end: Math.min(sermon.start, E.duration) })
  }
  if (sermon.end < E.duration - 0.5) {
    E.cuts.push({ start: Math.max(0, sermon.end), end: E.duration })
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
  for (const s of E.suggestions) {
    if (s.type === 'sermon') { s.type = 'speech'; s.label = t('editor.speechLabel', 'Tale') }
  }
  // Promote the chosen speech segment
  const speeches = E.suggestions.filter(s => s.type === 'speech' || s.type === 'sermon')
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
  const speeches = E.suggestions
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
  const sermon = E.suggestions.find(s => s.type === 'sermon')
  if (!banner || !detail || !sermon || !E.duration) return
  const headDur = sermon.start
  const tailDur = E.duration - sermon.end
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

// ── Minimap click / drag ──────────────────────────────────────────────────

// Module-scoped listener refs so repeated setupEditorPage() calls (renderer
// reload, page-switch) don't keep adding new window-level listeners. Each
// re-invocation removes the previous pair before attaching new ones.
let minimapWindowMoveHandler: ((e: MouseEvent) => void) | null = null
let minimapWindowUpHandler:   (() => void) | null = null

function setupMinimapInteraction(): void {
  E.minimap?.addEventListener('mousedown', (e: MouseEvent) => {
    E.minimapDragging = true
    jumpViewportToMouse(e)
  })
  if (minimapWindowMoveHandler) window.removeEventListener('mousemove', minimapWindowMoveHandler)
  if (minimapWindowUpHandler)   window.removeEventListener('mouseup',   minimapWindowUpHandler)
  minimapWindowMoveHandler = (e: MouseEvent) => {
    if (E.minimapDragging) jumpViewportToMouse(e)
  }
  minimapWindowUpHandler = () => { E.minimapDragging = false }
  window.addEventListener('mousemove', minimapWindowMoveHandler)
  window.addEventListener('mouseup',   minimapWindowUpHandler)
}

function jumpViewportToMouse(e: MouseEvent): void {
  if (!E.duration || !E.minimap) return
  const rect   = E.minimap.getBoundingClientRect()
  const frac   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  const center = frac * E.duration
  const half   = (E.vpEnd - E.vpStart) / 2
  E.vpStart = Math.max(0, Math.min(E.duration - half * 2, center - half))
  E.vpEnd   = E.vpStart + half * 2
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
      if (!E.filePath) return
      if (!confirmDiscardIfDirty('close')) return
      closeCurrentFile()
      return
    }
    if (mod && (e.code === 'KeyS' || e.code === 'KeyE')) {
      e.preventDefault()
      if (E.filePath) openExportModal()
      return
    }

    // Per-file shortcuts (need an open file)
    if (!E.peaks) return
    if (e.target instanceof HTMLButtonElement) return

    switch (e.code) {
      case 'Space':
        e.preventDefault()
        togglePlay(E.isPlaying ? E.isPreview : false)
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
        if (E.isPlaying) stopPlay()
        break
      case 'KeyF':
        e.preventDefault()
        fitAll()
        drawWaveform()
        updateMinimapViewport()
        break
      case 'KeyL':
        e.preventDefault()
        E.isLooping = !E.isLooping
        $('btn-editor-loop')?.classList.toggle('active', E.isLooping)
        break
      case 'Delete':
      case 'Backspace': {
        // Delete the cut under the playhead — the closest cut whose range
        // contains playStartSec, falling back to the most recently added.
        if (E.cuts.length === 0) break
        e.preventDefault()
        const idx = E.cuts.findIndex(c => E.playStartSec >= c.start && E.playStartSec <= c.end)
        if (idx >= 0) deleteCut(idx)
        else deleteCut(E.cuts.length - 1)
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
        const sermon = E.suggestions.find(s => s.type === 'sermon')
        if (sermon) { e.preventDefault(); seekTo(sermon.start) }
        break
      }
    }
  })
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
      if (!E.includeIntroOutro) {
        E.includeIntroOutro = true
        const chk = $('editor-include-io') as HTMLInputElement | null
        if (chk) chk.checked = true
      }
      await reloadIntroOutro()
      markDirty()
    })
  }
}

// ── Canvas mouse events ───────────────────────────────────────────────────
function onCanvasDown(e: MouseEvent): void {
  if (!E.peaks || e.button !== 0) return
  const rect = E.canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Check if clicking near a cut boundary → start handle drag. Cut handles
  // only live in main coords, so this uses mainSec.
  const threshold = (E.vpEnd - E.vpStart) / rect.width * 10
  for (let i = 0; i < E.cuts.length; i++) {
    if (Math.abs(mainSec - E.cuts[i].start) < threshold) {
      E.handleDrag = { cutIdx: i, side: 'start' }
      return
    }
    if (Math.abs(mainSec - E.cuts[i].end) < threshold) {
      E.handleDrag = { cutIdx: i, side: 'end' }
      return
    }
  }

  // Check if clicking near playhead in the ruler area → playhead drag
  const yInCanvas = e.clientY - rect.top
  const playX = secToX(E.playStartSec, rect.width)
  if (Math.abs(e.clientX - rect.left - playX) < 12 && yInCanvas < 28) {
    E.playheadDragging = true
    stopPlay()
    return
  }

  // Normal drag to create cut — drag coords are clamped to main, since cuts
  // can only exist inside the recording.
  E.dragStartSec = clampMain(extSec)
  E.dragEndSec   = E.dragStartSec
  E.isDragging   = true
}

function onCanvasMove(e: MouseEvent): void {
  if (!E.peaks) return
  const rect = E.canvas.getBoundingClientRect()
  const extSec  = xToSec(e.clientX - rect.left, rect.width)
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)

  // Handle drag: resize cut boundary. Snap to nearby segment boundaries when
  // shift is NOT held — gives precise lock-in to detected speech/music edges.
  // Repaints are rAF-coalesced so 60+ mousemoves/sec only redraw ~60 times.
  if (E.handleDrag) {
    const c = E.cuts[E.handleDrag.cutIdx]
    const snapped = e.shiftKey ? mainSec : snapToSegmentBoundary(mainSec, rect.width)
    if (E.handleDrag.side === 'start') {
      c.start = Math.max(0, Math.min(c.end - 0.1, snapped))
    } else {
      c.end   = Math.min(E.duration, Math.max(c.start + 0.1, snapped))
    }
    updateRemainingDisplay()
    scheduleDrawWaveform()
    return
  }

  // Playhead drag — covers full extended timeline (intro/main/outro)
  if (E.playheadDragging) {
    E.playStartSec = clampPlayable(extSec)
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    scheduleDrawWaveform()
    return
  }

  E.hoverSec = extSec

  // Cursor feedback
  const threshold = (E.vpEnd - E.vpStart) / rect.width * 10
  const nearBoundary = E.cuts.some(c =>
    Math.abs(mainSec - c.start) < threshold || Math.abs(mainSec - c.end) < threshold
  )
  const overCut = E.cuts.some(c => mainSec >= c.start && mainSec <= c.end)
  const nearPlayhead = Math.abs(e.clientX - rect.left - secToX(E.playStartSec, rect.width)) < 12
    && (e.clientY - rect.top) < 28

  E.canvas.style.cursor = nearBoundary ? 'ew-resize'
    : nearPlayhead    ? 'col-resize'
    : overCut         ? 'pointer'
    : 'crosshair'

  if (E.isDragging) E.dragEndSec = clampMain(extSec)

  scheduleDrawWaveform()
}

function onCanvasUp(e: MouseEvent): void {
  if (!E.peaks) return
  const rect  = E.canvas.getBoundingClientRect()
  const extSec = xToSec(e.clientX - rect.left, rect.width)
  const upMainSec = xToMainSec(e.clientX - rect.left, rect.width)

  if (E.handleDrag) {
    E.handleDrag = null
    E.cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform()
    drawMinimap()
    return
  }

  if (E.playheadDragging) {
    E.playheadDragging = false
    // Snap playhead out of any cut region the user dragged into — cuts are
    // "skip me" zones, so resting the playhead inside one is meaningless.
    E.playStartSec = snapOutOfCut(E.playStartSec)
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
    drawWaveform()
    return
  }

  if (!E.isDragging) return
  E.isDragging = false

  // Cut-creation drag: hold shift to disable snap, otherwise snap both edges
  // to nearby detected segment boundaries.
  if (Math.abs(upMainSec - E.dragStartSec) > 0.1) {
    const s = e.shiftKey ? E.dragStartSec : snapToSegmentBoundary(E.dragStartSec, rect.width)
    const eSec = e.shiftKey ? upMainSec : snapToSegmentBoundary(upMainSec, rect.width)
    addCut(s, eSec)
    renderCutList()
  } else {
    // Tap to seek — covers full extended timeline so users can click into
    // intro/outro slots. If the click lands inside a cut, snap to the cut's
    // end (the nearest keep-region start) so playback always begins at a
    // position that will actually produce audio.
    stopPlay()
    E.playStartSec = snapOutOfCut(clampPlayable(extSec))
    updateTimecode(E.playStartSec)
    if (E.isVideoFile && E.videoEl) E.videoEl.currentTime = clampMain(E.playStartSec)
  }

  E.dragStartSec = -1
  E.dragEndSec   = -1
  drawWaveform()
  drawMinimap()
}

function onCanvasLeave(): void {
  E.hoverSec = -99999

  if (E.handleDrag) {
    E.handleDrag = null
    E.cuts.sort((a, b) => a.start - b.start)
    pushCutHistory()
    renderCutList()
    updateRemainingDisplay()
    drawWaveform(); drawMinimap()
    return
  }

  if (E.playheadDragging) {
    E.playheadDragging = false
    drawWaveform()
    return
  }

  if (E.isDragging) {
    E.isDragging = false
    if (Math.abs(E.dragEndSec - E.dragStartSec) > 0.1) {
      addCut(E.dragStartSec, E.dragEndSec)
      renderCutList()
    }
    E.dragStartSec = -1; E.dragEndSec = -1
    drawWaveform(); drawMinimap()
  } else {
    drawWaveform()
  }
}

function onCanvasContextMenu(e: MouseEvent): void {
  e.preventDefault()
  if (!E.peaks) return
  const rect = E.canvas.getBoundingClientRect()
  const mainSec = xToMainSec(e.clientX - rect.left, rect.width)
  const idx  = E.cuts.findIndex(c => mainSec >= c.start && mainSec <= c.end)
  if (idx >= 0) deleteCut(idx)
}

function onCanvasWheel(e: WheelEvent): void {
  e.preventDefault()
  if (e.ctrlKey || e.metaKey) {
    // Zoom centered on mouse position (main coords only — intro/outro slots
    // have their own fixed scale).
    const rect = E.canvas.getBoundingClientRect()
    const mouseSec = xToMainSec(e.clientX - rect.left, rect.width)
    const factor   = e.deltaY > 0 ? 1.25 : 0.75
    const span     = (E.vpEnd - E.vpStart) * factor
    const frac     = (mouseSec - E.vpStart) / (E.vpEnd - E.vpStart)
    E.vpStart = Math.max(0, mouseSec - frac * span)
    E.vpEnd   = Math.min(E.duration, E.vpStart + span)
    if (E.vpEnd - E.vpStart < 0.5) { E.vpEnd = E.vpStart + 0.5 }
    drawWaveform()
    updateMinimapViewport()
  } else {
    panBy(e.deltaY * (E.vpEnd - E.vpStart) / 800)
  }
}

/** If `sec` falls inside a cut region, return the cut's end (the nearest
 *  keep-region start). Cuts are skip-zones — the playhead resting inside
 *  one is meaningless because no audio plays there. Out-of-range or
 *  already-outside-cut input is returned unchanged. */
export function snapOutOfCut(sec: number): number {
  for (const c of E.cuts) {
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
  if (!E.suggestions.length) return sec
  // Threshold scales with zoom level (~8 px) — tight at high zoom, lenient
  // when zoomed out so coarse drags still find the boundary.
  const threshold = Math.max(0.15, ((E.vpEnd - E.vpStart) / Math.max(1, W)) * 8)
  let closest = sec
  let minDist = threshold
  for (const seg of E.suggestions) {
    if (!shouldShowSegment(seg.type)) continue
    for (const t of [seg.start, seg.end]) {
      const d = Math.abs(sec - t)
      if (d < minDist) { minDist = d; closest = t }
    }
  }
  return closest
}

// ── Export flow ────────────────────────────────────────────────────────────
function openExportModal(): void {
  if (!E.filePath) return

  // Show/hide format section vs video notice
  const fmtSection   = $('export-fmt-section')
  const videoNotice  = $('export-video-notice')
  if (fmtSection)  fmtSection.style.display  = E.isVideoFile ? 'none' : ''
  if (videoNotice) videoNotice.style.display = E.isVideoFile ? '' : 'none'

  // Update gain summary — only shown when peak normalize has been applied.
  const procRow  = $('export-proc-row')
  const summary  = $('export-proc-summary')
  if (procRow && summary) {
    if (E.audioGainDb !== 0) {
      const sign = E.audioGainDb >= 0 ? '+' : ''
      summary.textContent = `${t('editor.normalizeApplied', 'Normalisert')} (${sign}${E.audioGainDb.toFixed(1)} dB → -1 dBFS)`
      procRow.style.display = ''
    } else {
      procRow.style.display = 'none'
    }
  }
  const ioRow     = $('export-io-row')
  const ioSummary = $('export-io-summary')
  if (ioRow && ioSummary) {
    const parts = []
    if (!E.isVideoFile) {
      if (E.includeIntroOutro && settings.editorIntroPath) {
        parts.push('Intro: ' + (settings.editorIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (E.includeIntroOutro && settings.editorOutroPath) {
        parts.push('Outro: ' + (settings.editorOutroPath.split(/[/\\]/).pop() ?? ''))
      }
    } else {
      if (E.includeIntroOutro && E.videoIntroPath) {
        parts.push('Video-intro: ' + (E.videoIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (E.includeIntroOutro && E.videoOutroPath) {
        parts.push('Video-outro: ' + (E.videoOutroPath.split(/[/\\]/).pop() ?? ''))
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

  const haveAny = configuredCache.gdrive || configuredCache.dropbox || configuredCache.onedrive || podcastEnabled || (E.isVideoFile && configuredCache.youtubeConnected)
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
  if (E.isVideoFile) {
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
    const title = (E.meta.title?.trim() || (outputPath.split(/[/\\]/).pop() ?? 'SundayRec opptak')).replace(/\.[^.]+$/, '')
    const description = (E.meta.description ?? '').slice(0, 5000)
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
  if (E.metaDirty) await saveMetadata()

  let result: { ok: boolean; outputPath?: string; error?: string }

  if (E.isVideoFile) {
    result = await window.api.editorExportVideo({
      inputPath:    E.filePath,
      cutRegions:   E.cuts,
      duration:     E.duration,
      mode,
      outputFolder: E.exportOutputFolder || undefined,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (E.includeIntroOutro && E.videoIntroPath) ? E.videoIntroPath : undefined,
      outroPath:  (E.includeIntroOutro && E.videoOutroPath) ? E.videoOutroPath : undefined,
      metadata:   E.meta,
    })
  } else {
    result = await window.api.editorExportFile({
      inputPath:    E.filePath,
      cutRegions:   E.cuts,
      duration:     E.duration,
      mode,
      outputFolder: E.exportOutputFolder || undefined,
      outputFormat: fmt,
      outputBitrate:  bitrate,
      outputBitDepth: bitDepth,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (E.includeIntroOutro && settings.editorIntroPath) ? settings.editorIntroPath : undefined,
      outroPath:  (E.includeIntroOutro && settings.editorOutroPath) ? settings.editorOutroPath : undefined,
      metadata:   E.meta,
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
    if (E.publishAfterExport && result.outputPath) {
      await runPublishingForExport(result.outputPath)
    }
    E.publishAfterExport = false
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
export function updateHeaderSummary(): void {
  const summaryEl = $('editor-header-summary')
  const dirtyEl   = $('editor-dirty-dot')
  if (dirtyEl) dirtyEl.style.display = E.editorDirty ? '' : 'none'
  if (!summaryEl) return
  if (!E.filePath || !E.duration) { summaryEl.textContent = ''; return }
  const remaining = getRemainingDuration()
  const parts = [formatDuration(remaining)]
  if (E.cuts.length > 0) parts.push(`${E.cuts.length} kutt`)
  if (E.audioGainDb !== 0) {
    const sign = E.audioGainDb >= 0 ? '+' : ''
    parts.push(`normalisert (${sign}${E.audioGainDb.toFixed(1)} dB)`)
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
  if (!E.editorDirty) return true
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
  E.audioCtx?.close().catch(() => {})
  E.audioCtx = null
  E.audioBuffer = null
  E.introBuffer = null
  E.outroBuffer = null
  E.introPeaks = null
  E.outroPeaks = null
  E.peaks = null
  E.cuts = []
  E.cutHistory = []
  E.cutHistoryIdx = -1
  E.suggestions = []
  E.clipTimes = []
  E.lastAnalyzedAt = 0
  E.meta = { title: '', speaker: '', description: '', chapters: [] }
  clearDirty()
  if (E.videoEl) {
    E.videoEl.pause()
    E.videoEl.src = ''
    E.videoEl.load()
  }
  E.isVideoFile = false
  E.audioGainDb = 0
  setNormalizeUI(0, false)
  reviewPrepId = null
  reviewPrep = null
  loadAndUpdateReviewBanner()
  E.filePath = ''
  E.duration = 0
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
  if (!E.filePath) return
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

  const start = Math.max(0, Math.min(E.duration > 15 ? E.duration - 15 : 0, clampMain(E.playStartSec)))
  try {
    const res = await window.api.masterPreview(E.filePath, preset.id, start, 15)
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
    audio.src = 'file://' + E.filePath
    audio.currentTime = clampMain(E.playStartSec)
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
  if (!E.filePath) return
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
  const outPath = deriveMasteredPath(E.filePath)

  try {
    // Pass 1: measure
    const measureRes = await window.api.masterMeasure(E.filePath, preset.id)
    if (!measureRes.ok || !measureRes.measurement) {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${measureRes.error ?? 'measure_failed'}`
      return
    }
    const beforeLufs = measureRes.measurement.inputI
    if (label) label.textContent = `${t('master.applying', 'Mastrer…')} (${t('master.lufsBefore', 'Original')}: ${beforeLufs.toFixed(1)} LUFS → ${preset.targetLufs} LUFS)`
    if (bar) bar.style.width = '15%'

    // Pass 2: apply
    const applyRes = await window.api.masterApply({
      inputPath:   E.filePath,
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
