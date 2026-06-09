import { t, currentLang } from '../i18n'
import { settings, patchSettings } from '../state'
import { fmtCountdown, fmtStorageHours, fmtDate } from '../helpers'
import { startVU } from './home-vu'
import { getAudioDevices } from '../audio/capture'
import { refreshReviewQueue, setupReviewQueueListeners } from './review-queue-home'
import type { RecordingEntry } from './history'

let countdownTimer: ReturnType<typeof setInterval> | null = null

export function deactivateHome(): void {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  // Bug 3: restore VU section + info-cards to original DOM positions when
  // navigating away from home (so the page stays clean if returned to).
  relocateVuForVideoMode(false)
}

// ── Video preview state ──────────────────────────────────────────────────────

let previewActive         = false
let previewStream:        MediaStream | null = null

// ── Video-mode layout: relocate VU, preview section and info cards ──────────
//
// In audio-only mode the page is a vertical stack: hero → quick-row →
// horizontal VU → info-strip (3 cards) → history. When video is toggled on
// we physically move those elements into a 3-column grid (#video-mode-layout):
// left = vertical VU, middle = video preview, right = info-card column. When
// video is toggled off we move every element back to its original position
// so audio-only mode remains pixel-identical to v4.40.0.
//
// Doing this by DOM-relocation (rather than duplicating elements) means every
// existing event handler / live-update / ID reference keeps working without
// modification. The function is idempotent — safe to call repeatedly.
interface MoveRecord { el: HTMLElement; parent: Element; next: Node | null }
let _videoLayoutMoves: MoveRecord[] = []
let _videoLayoutActive = false

function relocateVuForVideoMode(enabled: boolean): void {
  const layout = document.getElementById('video-mode-layout')
  if (!layout) return
  const previewSlot = layout.querySelector<HTMLElement>('.video-mode-preview-slot')
  const cardSlot    = layout.querySelector<HTMLElement>('.info-card-column')
  if (!previewSlot || !cardSlot) return

  if (enabled) {
    if (_videoLayoutActive) return
    _videoLayoutActive = true
    layout.style.display = 'grid'

    const move = (el: HTMLElement | null, target: HTMLElement): void => {
      if (!el || !el.parentElement) return
      _videoLayoutMoves.push({ el, parent: el.parentElement, next: el.nextSibling })
      target.appendChild(el)
    }

    // Video preview section first — so the VU can be appended into the same
    // card right after, giving the user the one-card "video + lyd-helhet"
    // look that the Direktesending page has.
    const preview = document.getElementById('video-preview-section') as HTMLElement | null
    move(preview, previewSlot)

    // VU goes INSIDE the .video-preview-card so preview and Lydnivå appear
    // as a single unified card (matching the Direktesending design). CSS
    // targets `.video-preview-card .vu-section` to re-skin it as a flat
    // bottom-strip like .live-vu-section.
    const vu = document.querySelector<HTMLElement>('#page-home > .vu-section')
    const previewCard = preview?.querySelector<HTMLElement>('.video-preview-card')
    if (vu && previewCard) move(vu, previewCard)

    // Place info-cards in the side column in a specific order so video-
    // mode reads top→bottom as: Lydkilde, Kamera, Videokvalitet, Lagring,
    // Format. The cards live in two physically separate strips on the
    // page (the audio strip + #video-info-strip), so we pick each by a
    // stable inner anchor and append individually — order in the source
    // markup doesn't matter.
    const audioStrip = document.querySelector<HTMLElement>('#page-home > .info-strip:not(.video-info-strip)')
    const videoStrip = document.getElementById('video-info-strip') as HTMLElement | null

    const findAudioCard = (innerId: string): HTMLElement | null =>
      audioStrip?.querySelector<HTMLElement>(`#${innerId}`)?.closest<HTMLElement>('.info-card') ?? null
    const findVideoCard = (innerId: string): HTMLElement | null =>
      videoStrip?.querySelector<HTMLElement>(`#${innerId}`)?.closest<HTMLElement>('.info-card') ?? null

    const ordered: Array<HTMLElement | null> = [
      findAudioCard('home-device-name'),     // LYDKILDE
      findVideoCard('home-video-device-name'), // KAMERA
      findVideoCard('home-video-quality'),     // VIDEOKVALITET
      findAudioCard('home-storage-value'),     // LAGRING
      document.getElementById('home-format-card'), // FORMAT
    ]
    for (const card of ordered) {
      if (card) move(card, cardSlot)
    }
  } else {
    if (!_videoLayoutActive) return
    _videoLayoutActive = false
    // Move everything back in reverse order so insertBefore(nextSibling)
    // targets are valid even when we re-insert into a now-empty parent.
    for (let i = _videoLayoutMoves.length - 1; i >= 0; i--) {
      const { el, parent, next } = _videoLayoutMoves[i]
      try { parent.insertBefore(el, next) } catch { parent.appendChild(el) }
    }
    _videoLayoutMoves = []
    layout.style.display = 'none'
  }
}

type HomeVideoDevice = { name: string; index: number }

function applyVideoFlipState(): void {
  const flipped = settings.videoFlip ?? false
  document.getElementById('video-preview-img')?.classList.toggle('video-flip', flipped)
  document.getElementById('video-preview-video')?.classList.toggle('video-flip', flipped)
  document.getElementById('btn-home-video-flip')?.classList.toggle('flip-active', flipped)
}

/** Apply a Home video-feed size preset: 'l' (large, default) | 'm' | 's'. Smaller
 *  presets shrink the video column and reflow the info cards into the freed width
 *  (CSS classes on #page-home), so there's no wasted space. Also reflects the
 *  active state on the segmented control. */
function applyHomeVideoSize(size: 's' | 'm' | 'l'): void {
  const page = document.getElementById('page-home')
  if (page) {
    page.classList.remove('vsize-s', 'vsize-m', 'vsize-l')
    page.classList.add(`vsize-${size}`)
  }
  document.querySelectorAll<HTMLElement>('.video-size-seg button').forEach(b =>
    b.classList.toggle('active', b.dataset.vsize === size))
}

export function updateVideoToggleButton(): void {
  const btn   = document.getElementById('btn-video-toggle')
  const label = document.getElementById('video-toggle-label')
  const on    = settings.videoEnabled ?? false
  if (!btn || !label) return
  label.textContent = on ? t('home.videoOn', 'Video på') : t('home.videoOff', 'Video av')
  btn.classList.toggle('video-toggle-on', on)
  updateAudioSeparateButton()
}

export function updateAudioSeparateButton(): void {
  const btn   = document.getElementById('btn-audio-separate') as HTMLElement | null
  const label = document.getElementById('audio-separate-label')
  const card  = document.getElementById('home-format-card')
  if (!btn || !label) return
  const videoOn   = settings.videoEnabled ?? false
  const keepAudio = settings.videoKeepAudio ?? true
  btn.style.display = videoOn ? 'inline-flex' : 'none'
  btn.classList.toggle('audio-separate-on', keepAudio)
  btn.setAttribute('aria-checked', keepAudio ? 'true' : 'false')
  label.textContent = keepAudio ? 'Separat lydfil' : 'Ingen lydfil'
  // Grey out the whole FORMAT card when video is on but separate audio is off
  card?.classList.toggle('format-inactive', videoOn && !keepAudio)
  // Whole card acts as the toggle in video mode (pointer affordance)
  card?.classList.toggle('format-toggleable', videoOn)
}

// ── Silent preflight (proactive issue surfacing) ─────────────────────────
//
// We run the same preflight check the user can trigger manually from the
// Lyd settings page, but silently in the background after home loads. Any
// findings — typically "disk almost full", "mic permission denied", "saved
// device not found" — are shown as a non-dismissable banner above the hero.
// Runs ONCE per app launch (not per home-tab visit) to avoid pestering the
// user with stale issues they've already seen.

let silentPreflightHasRun = false

async function runSilentPreflightOnce(): Promise<void> {
  if (silentPreflightHasRun) return
  silentPreflightHasRun = true
  try {
    const r = await window.api.runPreflight() as {
      findings: Array<{ severity: 'warn' | 'error'; category: string; message: string }>
    }
    renderSilentPreflightBanner(r.findings ?? [])
  } catch {
    // Preflight unavailable — silently ignore (not user-facing failure)
  }
}

function renderSilentPreflightBanner(findings: Array<{ severity: 'warn' | 'error'; category: string; message: string }>): void {
  // Remove any prior banner first so we don't stack.
  document.getElementById('silent-preflight-banner')?.remove()
  if (findings.length === 0) return

  const errors = findings.filter(f => f.severity === 'error')
  const warns  = findings.filter(f => f.severity === 'warn')

  const banner = document.createElement('div')
  banner.id = 'silent-preflight-banner'
  banner.className = errors.length > 0 ? 'home-banner home-banner-error' : 'home-banner home-banner-warn'

  const titleEl = document.createElement('div')
  titleEl.className = 'home-banner-title'
  titleEl.textContent = errors.length > 0
    ? `❌ ${errors.length} ${t('home.banner.errors', 'feil oppdaget')} — klikk for å fikse`
    : `⚠️ ${warns.length} ${t('home.banner.warns', 'advarsel')} — klikk for detaljer`
  banner.appendChild(titleEl)

  // Show first 2 messages inline; rest are visible in Lyd → Sjekk system
  const list = document.createElement('ul')
  list.className = 'home-banner-list'
  for (const f of [...errors, ...warns].slice(0, 2)) {
    const li = document.createElement('li')
    li.textContent = f.message
    list.appendChild(li)
  }
  if (findings.length > 2) {
    const li = document.createElement('li')
    li.textContent = `+ ${findings.length - 2} ${t('home.banner.more', 'flere — se Innstillinger → Lyd → Sjekk system')}`
    li.className = 'home-banner-list-more'
    list.appendChild(li)
  }
  banner.appendChild(list)

  banner.addEventListener('click', () => {
    window.showPage('settings')
    document.querySelector<HTMLElement>('.inner-tab[data-tab="settings-audio"]')?.click()
  })

  // Insert at the very top of page-home, above the hero
  const pageHome = document.getElementById('page-home')
  const reviewCard = document.getElementById('review-queue-card')
  if (pageHome) {
    if (reviewCard && reviewCard.parentNode === pageHome) {
      pageHome.insertBefore(banner, reviewCard)
    } else {
      pageHome.insertBefore(banner, pageHome.firstChild)
    }
  }
}

export async function refreshHomeVideoDevices(): Promise<void> {
  const sel   = document.getElementById('home-video-device-select') as HTMLSelectElement | null
  if (!sel) return
  sel.disabled = true
  sel.innerHTML = '<option value="">Leter etter kameraer…</option>'
  const phTxt = document.getElementById('video-preview-placeholder-text')

  try {
    const devices = await window.api.listVideoDevices() as HomeVideoDevice[]
    sel.innerHTML = ''

    const blank = document.createElement('option')
    blank.value = ''; blank.textContent = 'Velg kamera…'
    sel.appendChild(blank)

    devices.forEach(d => {
      const opt = document.createElement('option')
      opt.value = String(d.index)
      opt.dataset.name = d.name
      opt.textContent = d.name
      sel.appendChild(opt)
    })

    if (!devices.length) {
      if (phTxt) phTxt.textContent = 'Ingen kameraer funnet — sjekk tilkobling'
      sel.disabled = false
      return
    }

    const savedName = settings.videoDeviceName ?? ''
    const match = savedName ? devices.find(d => d.name === savedName) : null
    sel.value = match ? String(match.index) : ''
    sel.disabled = false

    // Bug 6: inform user when previously saved camera is no longer available
    if (savedName && !match && phTxt) {
      phTxt.textContent = `Kamera "${savedName}" ikke funnet — velg et annet`
    } else if (phTxt) {
      phTxt.textContent = sel.value ? 'Starter kamera…' : 'Velg kamera og trykk oppdater'
    }
  } catch (err) {
    console.warn('[home] device list failed:', err)
    sel.innerHTML = '<option value="">Feil ved lasting</option>'
    sel.disabled = false
    const phTxt2 = document.getElementById('video-preview-placeholder-text')
    if (phTxt2) phTxt2.textContent = 'Kunne ikke hente kameraliste — sjekk tillatelser'
    const phDiv2 = document.getElementById('video-preview-placeholder')
    if (phDiv2) phDiv2.style.display = ''
  }
}

async function applyHomeVideoDeviceSelection(): Promise<void> {
  const sel = document.getElementById('home-video-device-select') as HTMLSelectElement | null
  if (!sel) return
  const idx  = sel.value
  const opt  = sel.selectedOptions[0]
  const name = (opt?.dataset.name ?? opt?.textContent ?? '').trim() || null
  const idxN = idx ? parseInt(idx) : null

  stopVideoPreview()
  patchSettings({ videoDeviceName: name, videoDeviceIndex: idxN })
  await window.api.saveSettings({ ...settings })
  loadVideoInfoStrip()

  if (name) {
    startVideoPreview()
  } else {
    const phDiv = document.getElementById('video-preview-placeholder')
    const phTxt = document.getElementById('video-preview-placeholder-text')
    if (phTxt) phTxt.textContent = 'Velg kamera og trykk oppdater'
    if (phDiv) phDiv.style.display = ''
  }
}

/** Show the live feed's true resolution + fps as an overlay on the preview. */
function showFeedResolution(video: HTMLVideoElement, stream: MediaStream): void {
  const el = document.getElementById('video-preview-res')
  if (!el) return
  const s = stream.getVideoTracks()[0]?.getSettings()
  const w = video.videoWidth || s?.width || 0
  const h = video.videoHeight || s?.height || 0
  const fps = s?.frameRate ? Math.round(s.frameRate) : 0
  if (w && h) {
    el.textContent = fps ? `${w}×${h} · ${fps} fps` : `${w}×${h}`
    el.style.display = ''
  } else {
    el.style.display = 'none'
  }
}

export function stopVideoPreview(): void {
  previewActive = false
  // Release the camera (client-side getUserMedia preview) so the recorder can
  // open it when recording starts.
  if (previewStream) { previewStream.getTracks().forEach(t => t.stop()); previewStream = null }
  const video = document.getElementById('video-preview-video') as HTMLVideoElement | null
  const img   = document.getElementById('video-preview-img') as HTMLImageElement | null
  const phDiv = document.getElementById('video-preview-placeholder')
  const resEl = document.getElementById('video-preview-res')
  if (video) { video.srcObject = null; video.style.display = 'none'; video.onloadedmetadata = null }
  if (img)   { img.src = ''; img.style.display = 'none' }
  if (resEl) { resEl.style.display = 'none' }
  if (phDiv) { phDiv.style.display = '' }
}

// The live camera preview is a CLIENT-SIDE getUserMedia stream piped into a
// <video> element — it works in WKWebView with no backend, where the old
// Electron MJPEG-over-IPC preview did not (the Tauri backend writes a preview
// JPEG to a file, not IPC frames). The RECORDING still uses the backend ffmpeg
// device; this is preview only, and it's released (stopVideoPreview) the moment
// recording starts so the recorder can take the camera (macOS gives one client
// the capture device at a time).
export async function startVideoPreview(): Promise<void> {
  const section = document.getElementById('video-preview-section')
  updateVideoToggleButton()

  if (!settings.videoEnabled) {
    if (section) section.style.display = 'none'
    return
  }
  if (section) section.style.display = ''

  const phDiv  = document.getElementById('video-preview-placeholder')
  const phTxt  = document.getElementById('video-preview-placeholder-text')
  const video  = document.getElementById('video-preview-video') as HTMLVideoElement | null

  if (!settings.videoDeviceName) {
    if (phTxt) phTxt.textContent = 'Velg kamera og trykk oppdater'
    if (phDiv) phDiv.style.display = ''
    return
  }

  if (previewActive) return
  previewActive = true
  if (phTxt) phTxt.textContent = 'Starter kamera…'
  if (phDiv) phDiv.style.display = ''

  try {
    // Request the configured resolution in 16:9 so the preview matches the
    // recording (the default getUserMedia mode is 640×480 4:3 → letterboxed).
    const RES_DIMS: Record<string, [number, number]> = {
      '480p': [854, 480], '720p': [1280, 720], '1080p': [1920, 1080], '2160p': [3840, 2160],
    }
    const [rw] = RES_DIMS[settings.videoResolution ?? '720p'] ?? [1280, 720]
    // The preview is only a MONITOR — it never needs more than 1080p. Asking a
    // 1080p camera (e.g. FaceTime HD) for 4K made WKWebView collapse the
    // unsatisfiable width+height+aspectRatio ideals into a cropped 1920×1920
    // SQUARE (zoomed in). Cap the request at 1080p and specify width + aspectRatio
    // ONLY (no fighting height) so the browser always returns a clean 16:9 frame
    // at the camera's real max. The overlay still reports the true delivered size.
    const videoConstraint: MediaTrackConstraints = {
      width:       { ideal: Math.min(rw, 1920) },
      aspectRatio: { ideal: 16 / 9 },
    }
    // Map the chosen camera (an ffmpeg device NAME) to a browser deviceId by
    // label; fall back to the default camera. enumerateDevices only exposes
    // labels after a getUserMedia grant, so on first run we just use the default.
    try {
      const devs = await navigator.mediaDevices.enumerateDevices()
      const cam  = devs.find(d =>
        d.kind === 'videoinput' && !!settings.videoDeviceName &&
        d.label && d.label.includes(settings.videoDeviceName))
      if (cam?.deviceId) videoConstraint.deviceId = { ideal: cam.deviceId }
    } catch { /* enumerate needs permission first — fall back to default device */ }

    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
    if (!previewActive) { stream.getTracks().forEach(t => t.stop()); return } // stopped while awaiting
    previewStream = stream
    if (video) {
      video.srcObject = stream
      video.style.display = ''
      await video.play().catch(() => {})
      // Show the camera's ACTUAL delivered resolution/fps once metadata is in —
      // makes it obvious when the live feed differs from the recording setting
      // (e.g. a 1080p webcam with "4K" chosen). videoWidth/Height is the real
      // decoded frame size; the track's frameRate is the negotiated rate.
      showFeedResolution(video, stream)
      video.onloadedmetadata = () => showFeedResolution(video, stream)
    }
    if (phDiv) phDiv.style.display = 'none'
  } catch (err) {
    previewActive = false
    const name = (err as DOMException)?.name
    if (phTxt) phTxt.textContent = name === 'NotAllowedError'
      ? 'Kameratilgang nektet — sjekk Systeminnstillinger'
      : t('home.cameraNoResponse', 'Kamera svarte ikke — prøv å oppdatere')
    if (phDiv) phDiv.style.display = ''
    if (video) video.style.display = 'none'
  }
}

function highlightCard(card: HTMLElement | null): void {
  if (!card) return
  card.classList.remove('setting-highlight')
  void card.offsetWidth // restart animation if already active
  card.classList.add('setting-highlight')
  requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'center' }))
  setTimeout(() => card.classList.remove('setting-highlight'), 4400)
}

/** Exported so other pages can trigger a disk-space refresh after changing format/channels/samplerate */
export { loadDiskSpace as refreshHomeDiskSpace }

// ── Backend warning toast ────────────────────────────────────────────────────

let _backendWarningTimers: ReturnType<typeof setTimeout>[] = []

function showBackendWarning(msg: string, severity: 'warn' | 'error'): void {
  // Remove existing toasts of same severity so they don't pile up
  document.querySelectorAll<HTMLElement>(`.backend-warning-toast.severity-${severity}`).forEach(el => el.remove())

  const toast = document.createElement('div')
  toast.className = `backend-warning-toast severity-${severity}`
  toast.style.cssText = [
    'display:flex', 'align-items:flex-start', 'gap:10px',
    'padding:10px 14px', 'border-radius:8px', 'font-size:13px',
    'line-height:1.4', 'position:relative', 'box-shadow:0 2px 8px rgba(0,0,0,.25)',
    'margin:8px 0',
    'animation:toast-in .2s ease',
    severity === 'error'
      ? 'background:var(--red,#ef4444);color:#fff;border:1px solid rgba(255,255,255,.2)'
      : 'background:var(--yellow,#fbbf24);color:#1a1a1a;border:1px solid rgba(0,0,0,.15)',
  ].join(';')

  const icon = document.createElement('span')
  icon.textContent = severity === 'error' ? '✕' : '⚠'
  icon.style.cssText = 'flex-shrink:0;font-size:14px;margin-top:1px'

  const msgEl = document.createElement('span')
  msgEl.style.cssText = 'flex:1'
  msgEl.textContent = msg

  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText = [
    'background:none;border:none;cursor:pointer;padding:0;font-size:16px',
    'line-height:1;opacity:.7;flex-shrink:0;margin-left:4px',
    severity === 'error' ? 'color:#fff' : 'color:#1a1a1a',
  ].join(';')
  closeBtn.addEventListener('click', () => toast.remove())

  toast.appendChild(icon)
  toast.appendChild(msgEl)
  toast.appendChild(closeBtn)

  // Insert below the global error banner (or at top of main if banner not present)
  const main     = document.getElementById('main')
  const errorBanner = document.getElementById('global-error-banner')
  if (main && errorBanner?.nextSibling) {
    main.insertBefore(toast, errorBanner.nextSibling)
  } else if (main) {
    main.insertBefore(toast, main.firstChild)
  }

  if (severity === 'warn') {
    const tid = setTimeout(() => {
      toast.remove()
      // Remove fired timer from the bookkeeping array so it doesn't grow
      // unbounded as warnings accumulate over a long session.
      const idx = _backendWarningTimers.indexOf(tid)
      if (idx >= 0) _backendWarningTimers.splice(idx, 1)
    }, 8000)
    _backendWarningTimers.push(tid)
  }
  // 'error' stays until dismissed
}

// ── Post-recording summary helpers ──────────────────────────────────────────

function fmtDurationSec(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0 && m > 0) return `${h}t ${m}m`
  if (h > 0)           return `${h}t`
  if (m > 0 && s > 0)  return `${m}m ${s}s`
  if (m > 0)           return `${m}m`
  return `${s}s`
}

function fmtFileSizeBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.round(bytes / 1e3)} KB`
}

function showRecordingFinishedSummary(entry: RecordingEntry): void {
  const toast = document.getElementById('editor-prompt-toast')
  if (!toast) return

  const titleEl = toast.querySelector('.update-toast-title')
  if (!titleEl) return

  // Build summary line
  const parts: string[] = []
  if (entry.durationSec != null && entry.durationSec > 0)
    parts.push(fmtDurationSec(entry.durationSec))
  if (entry.fileSizeBytes != null && entry.fileSizeBytes > 0)
    parts.push(fmtFileSizeBytes(entry.fileSizeBytes))

  const cloudNames: Record<string, string> = { 'google-drive': 'GD', 'dropbox': 'DB', 'onedrive': 'OD' }
  const uploadedServices = (entry.cloudUploaded ?? []).map(s => cloudNames[s] ?? s)
  if (uploadedServices.length) parts.push('☁ ' + uploadedServices.join(' ☁ '))

  if (parts.length) {
    titleEl.textContent = t('history.complete', 'Fullført') + ' — ' + parts.join(' · ')
  } else {
    titleEl.textContent = t('history.complete', 'Fullført')
  }
}

export function setupHome(): void {
  // Wire up Test-recording and Preflight buttons. Both used to live on Home but
  // were moved to Settings → Lyd in the UX reorganization. The "btn-go-health"
  // anchor on Home jumps to that section. Buttons are bound by ID so both the
  // old IDs (if present anywhere) and the new "-settings" IDs are handled.
  const runTestRecording = async (btnId: string, statusId: string): Promise<void> => {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null
    const status = document.getElementById(statusId)
    if (!btn || !status) return
    if (window.__isRecording) {
      status.textContent = t('home.testBusy', 'Kan ikke kjøre test mens et opptak pågår.')
      status.style.color = 'var(--red)'
      return
    }
    btn.disabled = true
    const originalText = btn.textContent ?? ''
    let elapsed = 0
    const TOTAL = 30
    status.style.color = 'var(--text2)'
    const fmtProgress = (n: number): string =>
      t('home.testProgress', 'Tar opp test… {n}/{total} s')
        .replace('{n}', String(n)).replace('{total}', String(TOTAL))
    status.textContent = fmtProgress(0)
    const tick = setInterval(() => {
      elapsed++
      status.textContent = fmtProgress(elapsed)
      if (elapsed >= TOTAL) clearInterval(tick)
    }, 1000)
    try {
      const r = await window.api.runTestRecording() as {
        ok: boolean
        signal?: 'silent' | 'low' | 'normal'
        sizeBytes?: number
        error?: string
        detail?: string
      }
      clearInterval(tick)
      if (r.ok) {
        const sizeKb = r.sizeBytes ? Math.round(r.sizeBytes / 1024) : 0
        const signalLabel = r.signal === 'normal' ? t('home.testSignalOk',     '✅ Lyd OK')
                          : r.signal === 'low'    ? t('home.testSignalLow',    '⚠️ Svak lyd — sjekk gain på mikser')
                          :                         t('home.testSignalSilent', '⚠️ Stillhet — mikser av?')
        status.textContent = `${signalLabel} (${sizeKb} KB)`
        status.style.color = r.signal === 'normal' ? 'var(--green)' : 'var(--orange, #ffb46b)'
      } else {
        status.textContent = `❌ ${r.detail ?? r.error ?? t('home.testUnknownError', 'Ukjent feil')}`
        status.style.color = 'var(--red)'
      }
    } catch (err) {
      clearInterval(tick)
      status.textContent = `❌ ${(err as Error).message}`
      status.style.color = 'var(--red)'
    } finally {
      btn.disabled = false
      btn.textContent = originalText
    }
  }

  const runPreflight = async (btnId: string, statusId: string, listId: string): Promise<void> => {
    const btn = document.getElementById(btnId) as HTMLButtonElement | null
    const status = document.getElementById(statusId)
    const list = document.getElementById(listId) as HTMLUListElement | null
    if (!btn || !status || !list) return
    btn.disabled = true
    status.textContent = t('home.checking', 'Sjekker…')
    status.style.color = 'var(--text2)'
    list.style.display = 'none'
    list.innerHTML = ''
    try {
      const r = await window.api.runPreflight() as { findings: Array<{ severity: 'warn' | 'error'; category: string; message: string }> }
      if (!r.findings || r.findings.length === 0) {
        status.textContent = '✅ Alt ser bra ut — systemet er klart for opptak.'
        status.style.color = 'var(--green)'
      } else {
        const errors = r.findings.filter(f => f.severity === 'error').length
        const warns  = r.findings.filter(f => f.severity === 'warn').length
        const parts: string[] = []
        if (errors > 0) parts.push(`${errors} feil`)
        if (warns  > 0) parts.push(`${warns} advarsel`)
        status.textContent = `${errors > 0 ? '❌' : '⚠️'} ${parts.join(', ')}`
        status.style.color = errors > 0 ? 'var(--red)' : 'var(--orange, #ffb46b)'

        const sorted = [...r.findings].sort((a, b) => (a.severity === 'error' ? -1 : 1) - (b.severity === 'error' ? -1 : 1))
        for (const f of sorted) {
          const li = document.createElement('li')
          const isErr = f.severity === 'error'
          li.style.cssText = `padding:6px 10px;margin:4px 0;border-radius:6px;background:${isErr ? 'rgba(232,120,120,0.12)' : 'rgba(255,180,107,0.12)'};color:${isErr ? 'var(--red)' : 'var(--orange, #ffb46b)'};display:flex;gap:8px`
          const icon = document.createElement('span')
          icon.textContent = isErr ? '❌' : '⚠️'
          icon.style.flexShrink = '0'
          const text = document.createElement('span')
          text.textContent = f.message
          li.append(icon, text)
          list.appendChild(li)
        }
        list.style.display = 'block'
      }
    } catch (err) {
      status.textContent = `❌ ${(err as Error).message}`
      status.style.color = 'var(--red)'
    } finally {
      btn.disabled = false
    }
  }

  // Legacy IDs (btn-test-recording / btn-run-preflight) were removed from the
  // Home card in v4.31 — buttons now live exclusively on Innstillinger → Lyd.
  document.getElementById('btn-test-recording-settings')?.addEventListener('click', () => runTestRecording('btn-test-recording-settings', 'health-status-settings'))
  document.getElementById('btn-run-preflight-settings')?.addEventListener('click',  () => runPreflight('btn-run-preflight-settings',  'health-status-settings', 'preflight-findings-settings'))

  // Home → Settings → Lyd quick-jump (replaces the old inline test buttons)
  document.getElementById('btn-go-health')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
    requestAnimationFrame(() => {
      document.getElementById('btn-test-recording-settings')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  })

  // Video toggle button — always toggles, loads devices inline if turning on
  document.getElementById('btn-video-toggle')?.addEventListener('click', async () => {
    const nowEnabled = !(settings.videoEnabled ?? false)
    patchSettings({ videoEnabled: nowEnabled })
    await window.api.saveSettings({ ...settings })
    updateVideoToggleButton()
    loadVideoInfoStrip()
    // The Home "Video på" toggle and Innstillinger → Video are ONE setting —
    // keep the settings checkbox in sync live so they never disagree (mirrors the
    // audio-separate toggle's cross-sync).
    const settingsToggle = document.getElementById('opt-video-enable') as HTMLInputElement | null
    if (settingsToggle) {
      settingsToggle.checked = nowEnabled
      const panel = document.getElementById('video-settings-panel')
      if (panel) panel.style.display = nowEnabled ? '' : 'none'
    }

    const pageHome = document.getElementById('page-home')
    if (nowEnabled) {
      pageHome?.classList.add('video-mode')
      const section = document.getElementById('video-preview-section')
      if (section) section.style.display = ''
      relocateVuForVideoMode(true)
      await refreshHomeVideoDevices()
      if (settings.videoDeviceName && !window.__isRecording) startVideoPreview()
    } else {
      pageHome?.classList.remove('video-mode')
      relocateVuForVideoMode(false)
      stopVideoPreview()
      const section = document.getElementById('video-preview-section')
      if (section) section.style.display = 'none'
    }
  })

  // Separate audio toggle — keep high-quality audio file alongside combined MP4.
  // The whole FORMAT card is the toggle in video mode: click the switch OR
  // anywhere on the card. Mirrors Innstillinger → Video → "Behold separat lydfil".
  // When toggled here, propagate to the Video-tab toggle if it's already mounted
  // so both stay in sync without requiring a page navigation.
  const toggleSeparateAudio = async (): Promise<void> => {
    const nowKeep = !(settings.videoKeepAudio ?? true)
    patchSettings({ videoKeepAudio: nowKeep })
    await window.api.saveSettings({ ...settings })
    updateAudioSeparateButton()
    // Sync the Video-tab toggle (no-op if the tab hasn't been opened yet)
    const videoToggle = document.getElementById('opt-video-keep-audio') as HTMLInputElement | null
    if (videoToggle && videoToggle.checked !== nowKeep) videoToggle.checked = nowKeep
  }
  document.getElementById('home-format-card')?.addEventListener('click', e => {
    // Let the "Endre" link navigate to the format settings instead of toggling
    if ((e.target as HTMLElement)?.closest('#btn-go-audio-fmt')) return
    // Separate-audio only exists in video mode (audio-only has no combined file)
    if (!(settings.videoEnabled ?? false)) return
    void toggleSeparateAudio()
  })
  // Keyboard activation for the switch (role="switch", tabindex=0)
  document.getElementById('btn-audio-separate')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (settings.videoEnabled ?? false) void toggleSeparateAudio()
    }
  })

  // Inline camera refresh button
  document.getElementById('btn-home-video-refresh')?.addEventListener('click', async () => {
    stopVideoPreview()
    await refreshHomeVideoDevices()
    await applyHomeVideoDeviceSelection()
  })

  // Horizontal flip toggle — CSS-only for preview (instant, no restart), ffmpeg hflip for recording
  document.getElementById('btn-home-video-flip')?.addEventListener('click', async () => {
    const nowFlipped = !(settings.videoFlip ?? false)
    patchSettings({ videoFlip: nowFlipped })
    await window.api.saveSettings({ ...settings })
    applyVideoFlipState()
  })

  // Inline camera device selector — save + restart preview on change
  document.getElementById('home-video-device-select')?.addEventListener('change', async () => {
    await applyHomeVideoDeviceSelection()
  })

  // Video-feed size — small / medium / large. A smaller feed reflows the info
  // cards into the freed width (no wasted space), useful when the window fills the
  // screen. Persisted, so the choice sticks across sessions.
  const sizeSeg = document.querySelector<HTMLElement>('.video-size-seg')
  if (sizeSeg) {
    const saved = localStorage.getItem('sundayrec.homeVideoSize')
    const init: 's' | 'm' | 'l' = saved === 's' || saved === 'm' ? saved : 'l'
    applyHomeVideoSize(init)
    sizeSeg.querySelectorAll<HTMLElement>('button').forEach(b => {
      b.addEventListener('click', () => {
        const size = (b.dataset.vsize as 's' | 'm' | 'l') ?? 'l'
        applyHomeVideoSize(size)
        try { localStorage.setItem('sundayrec.homeVideoSize', size) } catch { /* ignore */ }
      })
    })
  }

  const goVideoSettings = (e: Event) => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-video"]')?.click()
  }
  document.getElementById('btn-go-video-source')?.addEventListener('click', goVideoSettings)
  document.getElementById('btn-go-video-quality')?.addEventListener('click', goVideoSettings)

  document.getElementById('btn-go-audio-page')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
    requestAnimationFrame(() =>
      highlightCard(document.querySelector('#settings-audio .card')))
  })
  document.getElementById('btn-go-audio-fmt')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-files"]')?.click()
    requestAnimationFrame(() =>
      highlightCard(document.getElementById('format-group')?.closest('.card') as HTMLElement ?? null))
  })
  document.getElementById('btn-go-general-page')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-files"]')?.click()
    requestAnimationFrame(() =>
      highlightCard(document.querySelector('#settings-files .card')))
  })

  // Publish-strip cards — all three currently route to the Publisering tab
  // (cloud + thumbnail UI lives there; Whisper has no dedicated settings
  // tab yet, so we land users on Publisering and they can browse from
  // there until we promote Whisper config out of the editor).
  const goPublish = (highlightSel?: string) => (e: Event) => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-publish"]')?.click()
    if (highlightSel) {
      requestAnimationFrame(() => highlightCard(document.querySelector(highlightSel)))
    }
  }
  document.getElementById('btn-go-cloud')?.addEventListener('click',   goPublish('#settings-publish .cloud-grid'))
  document.getElementById('btn-go-thumb')?.addEventListener('click',   goPublish('#publish-thumb-preview'))
  document.getElementById('btn-go-whisper')?.addEventListener('click', goPublish())
  document.getElementById('btn-how-to-fix')?.addEventListener('click', () => {
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
  })
  document.getElementById('btn-how-to-fix-audio')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
  })

  // "Se alle →" jumps to the merged «Søk & historikk» tab — the full history +
  // its tools (delete / note / prune / clear) and sermon search now live there.
  // Home only shows the 5 most recent recordings.
  document.getElementById('home-see-all')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('search')
  })

  const onDeviceChange = (): void => {
    // Skip during active recording — opening getUserMedia competes with ffmpeg's AVFoundation session
    if (!window.__isRecording) void checkStatus()
  }
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
  window.addEventListener('beforeunload', () =>
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange))

  // Backend warning toast — shown for cloud/preroll/wake/disk/device issues
  window.api.on('backend-warning', (data: unknown) => {
    const d = data as { msg: string; severity: 'warn' | 'error'; category: string }
    if (d?.msg) showBackendWarning(d.msg, d.severity ?? 'warn')
  })

  // Post-recording summary in existing editor prompt toast
  window.api.on('recording-finished', (entry: unknown) => {
    const rec = entry as RecordingEntry & { splitRestart?: boolean } | undefined
    if (rec && !rec.splitRestart) showRecordingFinishedSummary(rec)
  })

  // OPPGAVE 1 — Generic ESC key handler: closes all open modals/backdrops
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    document.querySelectorAll<HTMLElement>('.modal-backdrop, .ob-overlay').forEach(m => {
      if (m.style.display !== 'none' && m.offsetParent !== null) {
        // The note modal has its own close logic — dispatch custom event so it can clean up
        m.dispatchEvent(new CustomEvent('modal-close'))
        m.style.display = 'none'
      }
    })
  })

  // Wire up the review-queue card — listens to IPC events from main so the card
  // updates instantly when a new prep lands or the user publishes/discards.
  setupReviewQueueListeners()

  // Tray menu hooks: clicking "📬 N episoder klare" or "Sjekk system nå" in the
  // tray must surface the relevant UI. main.ts in main-process emits these
  // channels — see src/main/tray.ts.
  window.api.on('tray-open-review-queue', () => {
    window.showPage('home')
    refreshReviewQueue().then(() => {
      document.getElementById('review-queue-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }).catch(() => {})
  })
  window.api.on('tray-run-preflight', () => {
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
    requestAnimationFrame(() => {
      document.getElementById('btn-run-preflight-settings')?.click()
    })
  })
}

export async function refreshHome(): Promise<void> {
  const next = await window.api.getNextRecording()
  await Promise.all([
    loadNextRecording(next),
    loadDiskSpace(),
    renderRecentRecordings(),
    checkStatus(next),
    loadHomeInfoStrip(),
    refreshReviewQueue(),
  ])
  startVU()

  // Once-per-session silent preflight. Surfaces critical issues (disk full,
  // mic permission denied, device missing) on home as a banner *without*
  // requiring the user to click "Sjekk system". This is the "proactive
  // disk-space warning" requested by the external review.
  void runSilentPreflightOnce()

  // Hide video progress row (only shown during active recording)
  const progressRow = document.getElementById('video-progress-row')
  if (progressRow) progressRow.style.display = 'none'

  updateVideoToggleButton()
  applyVideoFlipState()
  loadVideoInfoStrip()

  const pageHome = document.getElementById('page-home')
  if (settings.videoEnabled) {
    pageHome?.classList.add('video-mode')
    const section = document.getElementById('video-preview-section')
    if (section) section.style.display = ''
    relocateVuForVideoMode(true)
    refreshHomeVideoDevices().then(() => {
      if (settings.videoDeviceName && !window.__isRecording) startVideoPreview()
    }).catch((err) => {
      console.warn('[home] device list failed:', err)
      const phTxt = document.getElementById('video-preview-placeholder-text')
      if (phTxt) phTxt.textContent = 'Kunne ikke hente kameraliste — sjekk tillatelser'
      const phDiv = document.getElementById('video-preview-placeholder')
      if (phDiv) phDiv.style.display = ''
    })
  } else {
    pageHome?.classList.remove('video-mode')
    relocateVuForVideoMode(false)
    stopVideoPreview()
    const section = document.getElementById('video-preview-section')
    if (section) section.style.display = 'none'
  }
}

async function loadNextRecording(prefetchedNext?: { date: string } | null): Promise<void> {
  if (countdownTimer) clearInterval(countdownTimer)
  const next    = prefetchedNext !== undefined ? prefetchedNext : await window.api.getNextRecording()
  const dateEl  = document.getElementById('next-date')
  const cntEl   = document.getElementById('next-countdown')
  const titleEl = document.getElementById('hero-ready-title')

  const heroNextEl = document.getElementById('hero-next-section')
  if (!next) {
    if (dateEl)    dateEl.textContent  = '—'
    if (cntEl)     cntEl.textContent   = ''
    // When no schedule is configured, nudge the user toward Tidsplan
    const slots = (settings.slots ?? []).length
    const specials = (settings.specialRecordings ?? []).length
    if (titleEl) {
      titleEl.textContent = (slots === 0 && specials === 0)
        ? t('home.readyNoSchedule', 'Klar — sett opp en tidsplan for å starte automatisk')
        : t('home.readyTitle', 'Alt er klart')
    }
    if (heroNextEl) heroNextEl.style.display = 'none'
    return
  }
  if (heroNextEl) heroNextEl.style.display = ''

  const d      = new Date(next.date)
  const locale = currentLang === 'no' ? 'nb-NO' : currentLang

  if (titleEl) {
    const dayName = d.toLocaleDateString(locale, { weekday: 'long' })
    const timeStr = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    const tpl     = t('home.readyTitleDay', 'Alt er klart til {day} {time}')
    titleEl.textContent = tpl.replace('{day}', dayName).replace('{time}', timeStr)
  }

  if (dateEl) {
    dateEl.textContent = d.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })
  }

  const tick = () => {
    if (!cntEl) return
    const diff   = d.getTime() - Date.now()
    const suffix = t('home.untilStart', 'til oppstart')
    cntEl.textContent = diff > 0 ? `${fmtCountdown(diff)} ${suffix}` : ''
  }
  tick()
  countdownTimer = setInterval(tick, 1000)

  const wakeBadge = document.getElementById('next-wake-badge')
  if (wakeBadge) {
    if (settings.wakeFromSleep) {
      const wakeTime = new Date(d.getTime() - 10 * 60 * 1000)
      const locale   = currentLang === 'no' ? 'nb-NO' : currentLang
      const wakeStr  = wakeTime.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      wakeBadge.textContent = t('home.wakesBefore', 'Maskinen vekkes automatisk kl. {time}').replace('{time}', wakeStr)
      wakeBadge.style.display = ''
    } else {
      wakeBadge.style.display = 'none'
    }
  }
}

async function loadDiskSpace(): Promise<void> {
  const disk       = await window.api.getDiskSpace()
  const storageVal = document.getElementById('home-storage-value')
  const storageSub = document.getElementById('home-storage-sub')

  const folder = settings.saveFolder ?? ''
  let folderShort = t('home.defaultFolder', 'Dokumenter/SundayRec')
  if (folder) {
    const parts = folder.replace(/\\/g, '/').split('/').filter(Boolean)
    folderShort = parts.length > 1 ? `…/${parts.at(-2)}/${parts.at(-1)}` : (parts[0] ?? folder)
  }

  if (!disk?.freeBytes) {
    if (storageVal) { storageVal.textContent = '—'; storageVal.style.color = '' }
    if (storageSub) storageSub.textContent = folderShort
    return
  }

  const gb  = disk.freeBytes / 1e9
  const fmt = (settings.format ?? 'mp3').toLowerCase()
  let kbps: number
  if (fmt === 'wav') {
    const sr = parseInt(String(settings.sampleRate ?? 48000))
    const ch = settings.channels === 'stereo' ? 2 : 1
    kbps = Math.round(sr * ch * 16 / 1000)
  } else if (fmt === 'flac') {
    kbps = settings.channels === 'stereo' ? 600 : 350
  } else {
    kbps = parseInt(String(settings.bitrate ?? 192))
  }
  const hours  = Math.floor(disk.freeBytes / (kbps * 125 * 3600))
  const recEst = fmtStorageHours(hours)
  if (storageVal) {
    storageVal.textContent = `${gb.toFixed(1)} GB ${t('home.storageFree', 'ledig')}`
    storageVal.style.color = gb < 1 ? 'var(--red)' : gb < 5 ? 'var(--yellow, #fbbf24)' : ''
  }
  if (storageSub) storageSub.textContent = `${folderShort} · ca. ${recEst}`

  const diskMetaEl = document.getElementById('rec-disk')
  if (diskMetaEl) diskMetaEl.textContent = `${gb.toFixed(0)} GB`
}

/**
 * Compact «Siste opptak» on home: the 5 most-recent recordings as a light,
 * read-only list (open-in-editor on row click + reveal/edit icons). The full
 * history with its tools (delete / note / prune / clear) and sermon search now
 * live in the «Søk & historikk» tab — reached via the "Se alle →" link.
 */
export async function renderRecentRecordings(): Promise<void> {
  const tbody = document.getElementById('home-recent')
  if (!tbody) return
  const history = ((await window.api.getHistory()) ?? []) as RecordingEntry[]
  const recent = history.slice(0, 5)
  tbody.innerHTML = ''
  if (!recent.length) {
    const td = Object.assign(document.createElement('td'), {
      colSpan: 4,
      textContent: t('history.empty', 'Ingen opptak ennå')
    })
    td.style.cssText = 'color:var(--text3);text-align:center;padding:16px'
    const tr = document.createElement('tr'); tr.appendChild(td); tbody.appendChild(tr)
    return
  }
  recent.forEach((r, idx) => {
    const tr = document.createElement('tr')
    tr.className = 'hist-row'
    tr.style.animationDelay = `${idx * 0.04}s`
    const badgeCls = r.status === 'ok' || r.status === 'complete' ? 'ok' : r.status === 'error' ? 'error' : 'sched'
    tr.dataset.status = badgeCls

    const timeStr = r.startTime ? ` kl. ${r.startTime}` : ''
    const cells = [r.date ? `${fmtDate(r.date)}${timeStr}` : '—', r.duration ?? '—', r.filename ?? '—']
    cells.forEach((text, i) => {
      const td = document.createElement('td')
      td.textContent = text
      if (i === 2 && r.path) td.title = r.path
      tr.appendChild(td)
    })

    // Read-only actions: reveal + open-in-editor (no delete/note on the home
    // overview — those live in the «Søk & historikk» tab).
    const tdActions = document.createElement('td')
    tdActions.style.cssText = 'white-space:nowrap;display:flex;align-items:center;gap:3px'
    if (r.path) {
      const aReveal = document.createElement('a')
      aReveal.href = '#'; aReveal.className = 'hist-action'
      aReveal.title = 'Vis i Finder / Utforsker'
      aReveal.innerHTML = '<svg viewBox="0 0 20 20"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5zM5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>'
      aReveal.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); window.api.revealFile(r.path!) })
      tdActions.appendChild(aReveal)

      const aEdit = document.createElement('a')
      aEdit.href = '#'; aEdit.className = 'hist-action'
      aEdit.title = t('editor.title', 'Rediger lydfil')
      aEdit.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h14M3 6h3m11 0h-3M3 14h3m11 0h-3" stroke-linecap="round"/><circle cx="7.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="14" r="1.5" fill="currentColor" stroke="none"/></svg>'
      aEdit.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); window.openEditorWithFile(r.path!) })
      tdActions.appendChild(aEdit)

      tr.style.cursor = 'pointer'
      tr.addEventListener('click', () => window.openEditorWithFile(r.path!))
    }
    tr.appendChild(tdActions)
    tbody.appendChild(tr)
  })
}

async function checkStatus(prefetchedNext?: { date: string } | null): Promise<void> {
  const devices = await getAudioDevices()
  let connected = !settings.deviceId || devices.some(d => d.deviceId === settings.deviceId)

  // Auto-heal: Windows often reassigns device IDs after reboot or driver update.
  // If the stored ID is gone but a device with the same label exists, silently update.
  if (!connected && settings.deviceId && settings.deviceName) {
    const byLabel = devices.find(d =>
      d.label && d.label.toLowerCase() === (settings.deviceName ?? '').toLowerCase()
    )
    if (byLabel) {
      patchSettings({ deviceId: byLabel.deviceId })
      await window.api.saveSettings({ ...settings })
      connected = true
    }
  }

  const isRec = window.__isRecording ?? false

  const heroOk   = document.getElementById('hero-ok')
  const heroWarn = document.getElementById('hero-warn')
  if (heroOk)   heroOk.style.display   = connected ? 'flex' : 'none'
  if (heroWarn) heroWarn.style.display = connected ? 'none' : 'flex'

  // Update hero-warn detail with device name so user knows what to reconnect
  if (!connected && settings.deviceName) {
    const warnDetail = document.getElementById('hero-warn-detail')
    if (warnDetail) {
      warnDetail.textContent = t('home.reconnectDevice', 'Koble til {name} via USB')
        .replace('{name}', settings.deviceName)
    }
  }

  const dot = document.getElementById('status-dot')
  const lbl = document.getElementById('status-label')
  if (dot) dot.className = 'status-dot' + (isRec ? ' recording' : connected ? '' : ' warn')
  if (lbl) {
    if (isRec) {
      lbl.textContent = t('status.recording', 'Tar opp nå')
    } else if (!connected) {
      const name = settings.deviceName ? `: ${settings.deviceName}` : ''
      lbl.textContent = t('status.warning', 'Lydkilde mangler') + name
    } else {
      const next = prefetchedNext !== undefined ? prefetchedNext : await window.api.getNextRecording()
      if (next) {
        const d = new Date(next.date)
        const locale = currentLang === 'no' ? 'nb-NO' : currentLang
        const dateStr = d.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
        lbl.textContent = dateStr
      } else {
        lbl.textContent = t('status.noSchedule', 'Ingen opptak planlagt')
      }
    }
  }
}

export function loadVideoInfoStrip(): void {
  const strip = document.getElementById('video-info-strip')
  if (!strip) return

  if (!settings.videoEnabled) {
    strip.style.display = 'none'
    return
  }
  strip.style.display = ''

  const nameEl    = document.getElementById('home-video-device-name')
  const statusEl  = document.getElementById('home-video-device-status')
  const qualityEl = document.getElementById('home-video-quality')
  const modeEl    = document.getElementById('home-video-mode')

  if (nameEl)   nameEl.textContent  = settings.videoDeviceName ?? '—'
  if (statusEl) {
    if (settings.videoDeviceName) {
      statusEl.textContent = 'Kilde konfigurert'
      statusEl.style.color = 'var(--green)'
    } else {
      statusEl.textContent = 'Ingen kamera valgt'
      statusEl.style.color = 'var(--text3)'
    }
  }

  const res     = settings.videoResolution ?? '720p'
  const fps     = settings.videoFramerate  ?? 30
  const bitrate = (settings.videoBitrate && settings.videoBitrate > 0)
    ? ` · ${settings.videoBitrate} kbps`
    : ''
  if (qualityEl) qualityEl.textContent = `${res} · ${fps} fps${bitrate}`
  if (modeEl)    modeEl.textContent    = settings.videoSeparate ? 'Separate filer (video + lyd)' : 'Kombinert MP4'
}

export async function loadHomeInfoStrip(): Promise<void> {
  const devices  = await getAudioDevices()
  const device   = settings.deviceId ? devices.find(d => d.deviceId === settings.deviceId) : devices[0]
  const nameEl   = document.getElementById('home-device-name')
  const statusEl = document.getElementById('home-device-status')
  if (nameEl)   nameEl.textContent   = device?.label ?? t('audio.builtIn', 'Standardenhet')
  if (statusEl) {
    const connected = !settings.deviceId || devices.some(d => d.deviceId === settings.deviceId)
    statusEl.textContent = t(connected ? 'home.deviceConnected' : 'home.deviceMissing')
    statusEl.style.color = connected ? 'var(--green)' : 'var(--red)'
  }

  const fmt     = (settings.format ?? 'mp3').toUpperCase()
  const hasBr   = settings.format !== 'flac' && settings.format !== 'wav'
  const br      = hasBr ? `${settings.bitrate ?? 192}k` : ''
  const ch      = settings.channels === 'stereo' ? t('audio.stereo', 'Stereo') : t('audio.monoL', 'Mono')
  const srHz    = parseInt(String(settings.sampleRate ?? 44100))
  const srLabel = `${(srHz / 1000).toFixed(srHz % 1000 === 0 ? 0 : 1)} kHz`
  const fmtEl   = document.getElementById('home-format-value')
  const fmtSub  = document.getElementById('home-format-sub')
  if (fmtEl) fmtEl.textContent = br ? `${fmt} · ${br}` : fmt
  if (fmtSub) fmtSub.textContent = `${ch} · ${srLabel}`

  // Refresh the publish/cloud/transcript strip — each card decides whether
  // to show itself based on settings + actual disk/network state. Smart
  // visibility: nothing is rendered when none of the three are configured,
  // keeping the home page short for fresh users.
  void loadPublishInfoStrip()
}

/**
 * Loads the bottom info-strip with: sky-backup status, episodebilde
 * (cover art) and transkripsjon (Whisper). Each card individually toggles
 * its own display — the parent strip is hidden when all three are off.
 */
async function loadPublishInfoStrip(): Promise<void> {
  const strip = document.getElementById('publish-info-strip')
  if (!strip) return

  const cloudShown   = renderCloudCard()
  const thumbShown   = renderThumbCard()
  // Whisper status is async (queries main for installed models) — we run
  // it without awaiting so the synchronous cards above don't block on it.
  const whisperShownPromise = renderWhisperCard()

  // Show the strip as soon as ONE card decided it has something to render.
  // Without this the strip would briefly flash on every load while we wait
  // on whisper-status.
  if (cloudShown || thumbShown) {
    strip.style.display = ''
  }
  const whisperShown = await whisperShownPromise
  strip.style.display = (cloudShown || thumbShown || whisperShown) ? '' : 'none'
}

/** @returns true when the cloud card was rendered visible. */
function renderCloudCard(): boolean {
  const card = document.getElementById('home-cloud-card')
  if (!card) return false
  const services: Array<{ key: 'cloudGoogleDrive' | 'cloudDropbox' | 'cloudOneDrive'; label: string }> = [
    { key: 'cloudGoogleDrive', label: 'Drive' },
    { key: 'cloudDropbox',     label: 'Dropbox' },
    { key: 'cloudOneDrive',    label: 'OneDrive' },
  ]
  const active = services.filter(s => settings[s.key]?.enabled)
  if (active.length === 0) {
    card.style.display = 'none'
    return false
  }
  card.style.display = ''
  const valEl = document.getElementById('home-cloud-services')
  const subEl = document.getElementById('home-cloud-status')
  if (valEl) valEl.textContent = active.map(a => a.label).join(' · ')

  // Show queue length if any cloud uploads are pending — this is the most
  // useful runtime info: "1 venter på opplasting" vs "Alle synkronisert".
  if (subEl) {
    subEl.textContent = 'Aktiv'
    subEl.style.color = ''
    void (async () => {
      try {
        const q = await window.api.cloudQueueStatus()
        const pending = q.entries?.filter(e => e.status === 'pending' || e.status === 'retrying').length ?? 0
        const failed  = q.entries?.filter(e => e.status === 'failed').length ?? 0
        if (failed > 0)       { subEl.textContent = `${failed} feilet`;   subEl.style.color = 'var(--red)' }
        else if (pending > 0) { subEl.textContent = `${pending} i kø`;    subEl.style.color = 'var(--text2)' }
        else                  { subEl.textContent = 'Alle synkronisert';   subEl.style.color = 'var(--green)' }
      } catch {
        // Queue status unavailable — leave the static "Aktiv" label.
      }
    })()
  }
  return true
}

/** @returns true when the thumbnail card was rendered visible. */
function renderThumbCard(): boolean {
  const card = document.getElementById('home-thumb-card')
  if (!card) return false
  const path = settings.defaultThumbnailPath
  if (!path) {
    card.style.display = 'none'
    return false
  }
  card.style.display = ''
  const nameEl = document.getElementById('home-thumb-name')
  const subEl  = document.getElementById('home-thumb-sub')
  const iconSlot = card.querySelector<HTMLElement>('.home-thumb-icon-slot')
  if (nameEl) {
    const base = path.split('/').pop() ?? path
    nameEl.textContent = base
  }
  if (subEl) {
    subEl.textContent = 'Brennes inn i podcast-MP3'
    subEl.style.color = 'var(--green)'
  }
  // Swap the placeholder SVG for an actual <img> preview via the asset://
  // protocol (WKWebView blocks file://). Falling back to the icon keeps the slot
  // from collapsing if the file disappeared (onerror).
  if (iconSlot) {
    const src = window.api.toAssetUrl(path)
    iconSlot.innerHTML = `<img class="thumb-card-icon thumb-card-icon-home" src="${src}" alt="" onerror="this.style.display='none'" />`
  }
  return true
}

/** @returns true when the transkripsjon card was rendered visible. */
async function renderWhisperCard(): Promise<boolean> {
  const card = document.getElementById('home-whisper-card')
  if (!card) return false
  let installedModel: { label: string; quality?: string } | null = null
  try {
    const status = await window.api.whisperStatus()
    const installed = status.models?.find(m => (m as { installed?: boolean }).installed) as
      | { id: string; label: string; quality?: string }
      | undefined
    if (status.binaryAvailable && installed) installedModel = installed
  } catch {
    // Whisper IPC unavailable — skip card.
  }
  if (!installedModel) {
    card.style.display = 'none'
    return false
  }
  card.style.display = ''
  const valEl = document.getElementById('home-whisper-model')
  const subEl = document.getElementById('home-whisper-status')
  if (valEl) valEl.textContent = installedModel.label
  if (subEl) {
    subEl.textContent = installedModel.quality ?? 'Klar'
    subEl.style.color = 'var(--green)'
  }
  return true
}
