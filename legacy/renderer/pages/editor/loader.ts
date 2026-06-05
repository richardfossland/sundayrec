import { t } from '../../i18n'
import { settings } from '../../state'
import type { RecordingMetadata } from '../../../types'
import { E, $, clearDirty, VIDEO_EXTS, PROBE_EXTS, WEB_AUDIO_EXTS } from './state'
import { computePeaks, computeJinglePeaks, setNormalizeUI } from './peaks'
import { fitAll } from './viewport'
import { clampPlayable, clampMain } from './geometry'
import { snapOutOfCut } from './canvas-input'
import { stopPlay, updateTimecode, updateTotalTime } from './playback'
import { renderAnalyzePanel, runDetection } from './detection'
import { renderMetaPanel, renderChapterList } from './metadata'
import { renderCutList, updateRemainingDisplay } from './cuts'
import { drawWaveform, drawMinimap, updateMinimapViewport, syncCanvasSize } from './waveform'
import { loadTranscriptForFile } from '../editor-transcript'
import { panelElementsByPrefix, refresh as refreshThumbPanel } from '../thumbnail-panel'
import { showState, showEditorError, updateHeaderSummary, reviewPrepId } from '../editor-page'
import { updateStageButton } from './stage-ui'

// ── File loading (pick, decode, intro/outro buffers, metadata sidecar) ──────

export async function pickAndLoad(): Promise<void> {
  const fp = await window.api.editorPickFile()
  if (fp) loadFile(fp)
}

/**
 * Fallback loader for huge audio files that would crash decodeAudioData.
 * Uses the ffmpeg-extract path (8 kHz mono WAV) — phone-call quality, but
 * sufficient for waveform display and cut selection. Sets audioBuffer,
 * peaks, duration. Returns false if the load failed.
 */
export async function loadViaFfmpegExtract(fp: string, seq: number): Promise<boolean> {
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

export async function loadFile(fp: string): Promise<void> {
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
    // Load the video via the Tauri asset:// protocol (the old Electron renderer
    // used a custom `media://current` scheme that doesn't exist in WKWebView, so
    // the video editor never showed a frame). convertFileSrc handles the path.
    await window.api.editorSetVideoPath(fp)
    if (E.videoEl) {
      E.videoEl.src = window.api.toAssetUrl(fp)
      E.videoEl.load()
    }

    // Waveform for video: the backend extracts the audio + down-samples to peaks
    // (100/s, the renderer's rate) — we CAN'T decode the raw video bytes
    // client-side (a 1080p service is multi-GB, over the inline limit), and video
    // PLAYBACK uses the <video> element (asset://) so no AudioBuffer is needed.
    // E.peaks drives the waveform; E.duration comes from the video element.
    const result = await window.api.editorExtractAudioPeaks(fp) as { peaks: number[]; sampleRate: number } | null

    if (seq !== E.loadSeq) return

    let haveBackendPeaks = false
    if (result && Array.isArray(result.peaks) && result.peaks.length) {
      E.peaks = Float32Array.from(result.peaks)
      haveBackendPeaks = true
    }

    // Duration always comes from the video element for video files.
    {
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
        // Only flat-fill when the backend gave NO peaks (else keep the real ones).
        if (!haveBackendPeaks) {
          E.peaks = new Float32Array(Math.ceil(E.duration * 100))
          console.log('[editor] video-only mode (flat waveform), duration:', E.duration.toFixed(1) + 's')
        }
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

  if (E.pendingSeekSec != null) {
    const target = E.pendingSeekSec
    E.pendingSeekSec = null
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

  // Update Stage-kapitler button visibility (opt-in, no-op when disabled).
  void updateStageButton()
}

export async function reloadIntroOutro(): Promise<void> {
  await loadIntroOutroBuffers(E.loadSeq)
}

export async function loadIntroOutroBuffers(seq: number): Promise<void> {
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

export function updateVideoIntroOutroDisplay(): void {
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

export function updateEditorIntroOutroDisplay(): void {
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

export async function loadMetadataSidecar(fp: string, fname: string): Promise<void> {
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
