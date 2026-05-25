import { t, currentLang } from '../i18n'
import { settings, patchSettings } from '../state'
import { fmtCountdown, fmtStorageHours, fmtDate, escHtml, flashMsg } from '../helpers'
import { startVU, stopVU } from './home-vu'
import { getAudioDevices } from '../audio/capture'
import { normalizeFrameData } from '../../shared/normalize-frame-data'
import { refreshReviewQueue, setupReviewQueueListeners } from './review-queue-home'

let countdownTimer: ReturnType<typeof setInterval> | null = null

export function deactivateHome(): void {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null }
  // Bug 3: restore VU section to original DOM position when navigating away
  setVuOverlay(false)
}
let fullHistory: RecordingEntry[] = []

// ── Video preview state ──────────────────────────────────────────────────────

let previewActive         = false
let previewFrameUnsub:    (() => void) | undefined
let previewStopUnsub:     (() => void) | undefined
let previewVideoUnsub:    (() => void) | undefined
let previewMetaUnsub:     (() => void) | undefined
let previewNoFrameTimer:  ReturnType<typeof setTimeout> | null = null
let lastFrameTs           = 0
let lastFrameBlobUrl:     string | null = null

// ── VU overlay (inside video wrap when video-mode is on) ─────────────────────
let _vuOrigParent:      Element | null = null
let _vuOrigNextSibling: Node    | null = null

function setVuOverlay(enabled: boolean): void {
  const vu   = document.querySelector<HTMLElement>('#page-home .vu-section')
  const wrap = document.querySelector<HTMLElement>('.video-preview-wrap')
  if (!vu || !wrap) return
  if (enabled) {
    if (vu.parentElement !== wrap) {
      _vuOrigParent      = vu.parentElement
      _vuOrigNextSibling = vu.nextSibling
      wrap.appendChild(vu)
    }
  } else {
    if (vu.parentElement === wrap && _vuOrigParent) {
      _vuOrigParent.insertBefore(vu, _vuOrigNextSibling)
    }
  }
}

type HomeVideoDevice = { name: string; index: number }
let homeVideoDevices: HomeVideoDevice[] = []

function applyVideoFlipState(): void {
  const flipped = settings.videoFlip ?? false
  document.getElementById('video-preview-img')?.classList.toggle('video-flip', flipped)
  document.getElementById('btn-home-video-flip')?.classList.toggle('flip-active', flipped)
}

function updateVideoToggleButton(): void {
  const btn   = document.getElementById('btn-video-toggle')
  const label = document.getElementById('video-toggle-label')
  const on    = settings.videoEnabled ?? false
  if (!btn || !label) return
  label.textContent = on ? 'Video på' : 'Video av'
  btn.classList.toggle('video-toggle-on', on)
  updateAudioSeparateButton()
}

function updateAudioSeparateButton(): void {
  const btn   = document.getElementById('btn-audio-separate') as HTMLButtonElement | null
  const label = document.getElementById('audio-separate-label')
  const card  = document.getElementById('home-format-card')
  if (!btn || !label) return
  const videoOn   = settings.videoEnabled ?? false
  const keepAudio = settings.videoKeepAudio ?? true
  btn.style.display = videoOn ? 'inline-flex' : 'none'
  btn.classList.toggle('audio-separate-on', keepAudio)
  label.textContent = keepAudio ? 'Separat lydfil' : 'Ingen lydfil'
  // Grey out the whole FORMAT card when video is on but separate audio is off
  card?.classList.toggle('format-inactive', videoOn && !keepAudio)
}

export async function refreshHomeVideoDevices(): Promise<void> {
  const sel   = document.getElementById('home-video-device-select') as HTMLSelectElement | null
  if (!sel) return
  sel.disabled = true
  sel.innerHTML = '<option value="">Leter etter kameraer…</option>'
  const phTxt = document.getElementById('video-preview-placeholder-text')

  try {
    const devices = await window.api.listVideoDevices() as HomeVideoDevice[]
    homeVideoDevices = devices
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

export function stopVideoPreview(): void {
  previewActive = false
  if (previewNoFrameTimer) { clearTimeout(previewNoFrameTimer); previewNoFrameTimer = null }
  if (lastFrameBlobUrl) { URL.revokeObjectURL(lastFrameBlobUrl); lastFrameBlobUrl = null }
  previewFrameUnsub?.(); previewFrameUnsub = undefined
  previewStopUnsub?.();  previewStopUnsub  = undefined
  previewVideoUnsub?.(); previewVideoUnsub  = undefined
  previewMetaUnsub?.();  previewMetaUnsub  = undefined
  window.api.videoPreviewStop?.()
  const img   = document.getElementById('video-preview-img') as HTMLImageElement | null
  const phDiv = document.getElementById('video-preview-placeholder')
  if (img)   { img.src = ''; img.style.display = 'none' }
  if (phDiv) { phDiv.style.display = '' }
}

export function startVideoPreview(): void {
  const section = document.getElementById('video-preview-section')
  updateVideoToggleButton()

  if (!settings.videoEnabled) {
    if (section) section.style.display = 'none'
    return
  }

  // Show section regardless — even if no device yet (user can pick one inline)
  if (section) section.style.display = ''

  if (!settings.videoDeviceName) {
    const phDiv = document.getElementById('video-preview-placeholder')
    const phTxt = document.getElementById('video-preview-placeholder-text')
    if (phTxt) phTxt.textContent = 'Velg kamera og trykk oppdater'
    if (phDiv) phDiv.style.display = ''
    return
  }

  if (previewActive) return  // already running
  previewActive = true

  const img   = document.getElementById('video-preview-img') as HTMLImageElement | null
  const phDiv = document.getElementById('video-preview-placeholder')
  const phTxt = document.getElementById('video-preview-placeholder-text')
  if (phTxt) phTxt.textContent = 'Starter kamera…'

  // Renderer-side safety net: if no frame arrives within 75 s, show an error.
  // The main process tries up to 6 configs (10 s each = 60 s max) before giving up.
  // This timer fires only if all retries are exhausted and IPC is never received.
  if (previewNoFrameTimer) clearTimeout(previewNoFrameTimer)
  previewNoFrameTimer = setTimeout(() => {
    previewNoFrameTimer = null
    if (previewActive) {
      previewActive = false
      if (phTxt) phTxt.textContent = 'Kamera svarte ikke — prøv å oppdatere'
      if (phDiv) phDiv.style.display = ''
      if (img)   img.style.display   = 'none'
      window.api.videoPreviewStop?.()
    }
  }, 75000)

  // Bug 2: use ?. before .then/.catch so if videoPreviewStart is undefined we don't crash
  window.api.videoPreviewStart?.({
    videoDeviceName:  settings.videoDeviceName,
    videoDeviceIndex: settings.videoDeviceIndex,
    videoFramerate:   settings.videoFramerate,
  })?.then((ok: unknown) => {
    if (ok === false) {
      // Main process denied camera permission before even starting ffmpeg
      if (previewNoFrameTimer) { clearTimeout(previewNoFrameTimer); previewNoFrameTimer = null }
      previewActive = false
      if (phTxt) phTxt.textContent = 'Kameratilgang nektet — sjekk Systeminnstillinger'
      if (phDiv) phDiv.style.display = ''
    }
  })?.catch(() => { /* IPC errors are non-fatal */ })

  const frameIntervalMs = Math.floor(1000 / (settings.videoFramerate ?? 30)) - 2
  previewFrameUnsub = window.api.on('video-preview-frame', (data: unknown) => {
    if (previewNoFrameTimer) { clearTimeout(previewNoFrameTimer); previewNoFrameTimer = null }
    const now = Date.now()
    if (now - lastFrameTs < frameIntervalMs) return
    lastFrameTs = now
    // IPC payloads cross the contextBridge through structured clone. Depending on
    // Electron version and the original Node Buffer's backing store, `data` can
    // arrive as a Uint8Array, a Buffer-like object, an ArrayBuffer, or rarely a
    // plain object with numeric indices. Normalize to a Uint8Array before
    // building the Blob — without this, `new Blob([data])` produces a 0-byte
    // blob and the <img> goes blank with no error.
    const arr = normalizeFrameData(data)
    if (!img || !arr || arr.length < 4) return
    // Cast: TS 6 narrows Blob input to exclude SharedArrayBuffer-backed views,
    // but normalizeFrameData always returns a regular ArrayBuffer-backed view.
    const url = URL.createObjectURL(new Blob([arr as BlobPart], { type: 'image/jpeg' }))
    if (lastFrameBlobUrl) URL.revokeObjectURL(lastFrameBlobUrl)
    lastFrameBlobUrl = url
    img.src = url
    img.style.display = ''
    if (phDiv) phDiv.style.display = 'none'
  })

  previewStopUnsub = window.api.on('video-preview-stopped', () => {
    if (previewNoFrameTimer) { clearTimeout(previewNoFrameTimer); previewNoFrameTimer = null }
    previewActive = false
    if (phTxt) phTxt.textContent = 'Kamera utilgjengelig'
    if (phDiv) phDiv.style.display = ''
    if (img) img.style.display = 'none'
  })

  previewMetaUnsub = window.api.on('video-preview-meta', (_data: unknown) => {
    // Container uses fixed height (not aspect-ratio), so no inline resize needed.
    // Frame is displayed with object-fit: contain — aspect ratio preserved by CSS.
  })

  previewVideoUnsub = window.api.on('video-progress', (data: unknown) => {
    const d = data as { bytes: number }
    const el = document.getElementById('video-progress-bytes')
    if (el) el.textContent = `${(d.bytes / 1048576).toFixed(1)} MB`
    const row = document.getElementById('video-progress-row')
    if (row) row.style.display = ''
  })
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
    const tid = setTimeout(() => toast.remove(), 8000)
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

  // Bind to both old (legacy IDs on Home, if present) and new (-settings) IDs
  document.getElementById('btn-test-recording')?.addEventListener('click', () => runTestRecording('btn-test-recording', 'health-status'))
  document.getElementById('btn-run-preflight')?.addEventListener('click',  () => runPreflight('btn-run-preflight',  'health-status', 'preflight-findings'))
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

    const pageHome = document.getElementById('page-home')
    if (nowEnabled) {
      pageHome?.classList.add('video-mode')
      const section = document.getElementById('video-preview-section')
      if (section) section.style.display = ''
      setVuOverlay(true)
      await refreshHomeVideoDevices()
      if (settings.videoDeviceName && !window.__isRecording) startVideoPreview()
    } else {
      pageHome?.classList.remove('video-mode')
      setVuOverlay(false)
      stopVideoPreview()
      const section = document.getElementById('video-preview-section')
      if (section) section.style.display = 'none'
    }
  })

  // Separate audio toggle — keep high-quality audio file alongside combined MP4
  document.getElementById('btn-audio-separate')?.addEventListener('click', async () => {
    const nowKeep = !(settings.videoKeepAudio ?? true)
    patchSettings({ videoKeepAudio: nowKeep })
    await window.api.saveSettings({ ...settings })
    updateAudioSeparateButton()
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
  document.getElementById('btn-how-to-fix')?.addEventListener('click', () => {
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
  })
  document.getElementById('btn-how-to-fix-audio')?.addEventListener('click', e => {
    e.preventDefault()
    window.showPage('settings')
    document.querySelector<HTMLElement>('#settings-tabs .inner-tab[data-tab="settings-audio"]')?.click()
  })

  document.getElementById('btn-prune-history')?.addEventListener('click', async e => {
    e.preventDefault()
    const removed = await window.api.pruneHistory()
    await loadRecentHistory()
    if (removed === 0) flashMsg(document.getElementById('btn-prune-history'), t('history.pruneNone', 'Ingen å rydde'), true)
  })

  document.getElementById('btn-clear-history')?.addEventListener('click', async e => {
    e.preventDefault()
    if (!confirm(t('history.confirmClear', 'Slett hele historikken?'))) return
    await window.api.clearHistory()
    fullHistory = []
    renderHistoryRows(document.getElementById('history-tbody'), [], false)
    updateHistoryStats([])
  })

  document.getElementById('btn-delete-errors')?.addEventListener('click', async e => {
    e.preventDefault()
    const errors = fullHistory.filter(r => r.status === 'error')
    if (!errors.length) return
    if (!confirm(t('history.confirmDeleteErrors', `Slett ${errors.length} feiloppføringer?`).replace('{n}', String(errors.length)))) return
    for (const r of errors) {
      if (r.timestamp) await window.api.deleteHistoryEntry(r.timestamp)
    }
    await loadRecentHistory()
  })

  document.getElementById('history-search')?.addEventListener('input', e => {
    const q = (e.target as HTMLInputElement).value
    filterAndRenderHistory(q)
  })

  document.getElementById('btn-history-more')?.addEventListener('click', () => {
    const panel = document.getElementById('history-more-panel')
    const btn   = document.getElementById('btn-history-more')
    const open  = panel?.style.display !== 'none'
    if (panel) panel.style.display = open ? 'none' : 'flex'
    btn?.setAttribute('aria-expanded', String(!open))
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
}

export async function refreshHome(): Promise<void> {
  const next = await window.api.getNextRecording()
  await Promise.all([
    loadNextRecording(next),
    loadDiskSpace(),
    loadRecentHistory(),
    checkStatus(next),
    loadHomeInfoStrip(),
    refreshReviewQueue(),
  ])
  startVU()

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
    setVuOverlay(true)
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
    setVuOverlay(false)
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

export async function loadRecentHistory(): Promise<void> {
  fullHistory = ((await window.api.getHistory()) ?? []) as RecordingEntry[]
  const searchEl = document.getElementById('history-search') as HTMLInputElement | null
  filterAndRenderHistory(searchEl?.value ?? '')
}

function filterAndRenderHistory(query: string): void {
  const q = query.toLowerCase().trim()
  const rows = q
    ? fullHistory.filter(r =>
        (r.filename ?? '').toLowerCase().includes(q) ||
        (r.date ?? '').includes(q) ||
        (r.note  ?? '').toLowerCase().includes(q))
    : fullHistory
  renderHistoryRows(document.getElementById('history-tbody'), rows, true)
  updateHistoryStats(fullHistory)
}

function updateHistoryStats(history: RecordingEntry[]): void {
  const statsEl = document.getElementById('history-stats')
  if (!statsEl) return
  const ok = history.filter(r => r.status === 'ok')
  if (!ok.length) { statsEl.style.display = 'none'; return }
  statsEl.style.display = 'flex'
  const countEl    = document.getElementById('stat-count')
  const durationEl = document.getElementById('stat-duration')
  const lastEl     = document.getElementById('stat-last')
  if (countEl) countEl.textContent = `${ok.length} ${t('history.totalCount', 'opptak')}`
  let totalSec = 0
  for (const r of ok) {
    // formatDuration returns "Xt Ym" (e.g. "1t 30m" or "75m")
    const m = (r.duration || '').match(/^(?:(\d+)t\s*)?(\d+)m$/)
    if (!m) continue
    totalSec += (parseInt(m[1] ?? '0') || 0) * 3600 + parseInt(m[2]) * 60
  }
  const th = Math.floor(totalSec / 3600), tm = Math.round((totalSec % 3600) / 60)
  if (durationEl) durationEl.textContent = th > 0
    ? `${th} t ${tm} min ${t('history.totalDuration', 'totalt')}`
    : `${tm} min ${t('history.totalDuration', 'totalt')}`
  if (lastEl && ok[0]?.date)
    lastEl.textContent = `${t('history.lastRecording', 'sist')} ${fmtDate(ok[0].date)}`
}

export function renderHistoryRows(tbody: HTMLElement | null, rows: RecordingEntry[], showReveal: boolean): void {
  if (!tbody) return
  tbody.innerHTML = ''
  if (!rows.length) {
    const td = Object.assign(document.createElement('td'), {
      colSpan: 6,
      textContent: t('history.empty', 'Ingen opptak ennå')
    })
    td.style.cssText = 'color:var(--text3);text-align:center;padding:20px'
    const tr = document.createElement('tr')
    tr.appendChild(td); tbody.appendChild(tr)
    return
  }
  // Group audio+video pairs from the same session into a single row.
  // finishSessionAsync adds audio first, then video (note='Video'), so in the
  // newest-first history list the video entry appears just before the audio entry.
  const grouped: Array<{ r: RecordingEntry; videoEntry: RecordingEntry | null }> = []
  {
    let i = 0
    while (i < rows.length) {
      const curr = rows[i], next = rows[i + 1]
      const isPair = next && curr.date === next.date && curr.startTime === next.startTime &&
        ((curr.note === 'Video' && next.note !== 'Video') ||
         (next.note === 'Video' && curr.note !== 'Video'))
      if (isPair) {
        const [audio, video] = curr.note === 'Video' ? [next, curr] : [curr, next]
        grouped.push({ r: audio, videoEntry: video })
        i += 2
      } else {
        grouped.push({ r: curr, videoEntry: null })
        i++
      }
    }
  }
  grouped.forEach(({ r, videoEntry }, idx) => {
    const tr = document.createElement('tr')
    tr.className = 'hist-row'
    tr.style.animationDelay = `${idx * 0.04}s`
    const badgeCls = r.status === 'ok' || r.status === 'complete' ? 'ok' : r.status === 'error' ? 'error' : 'sched'
    tr.dataset.status = badgeCls
    const badge    = Object.assign(document.createElement('span'), { className: `badge badge-${badgeCls}`, textContent: t(`history.${r.status}`, r.status) })
    const tdStatus = document.createElement('td'); tdStatus.appendChild(badge)
    const tdActions = document.createElement('td'); tdActions.style.cssText = 'white-space:nowrap'

    if (showReveal && r.path) {
      const aReveal = document.createElement('a')
      aReveal.href = '#'; aReveal.className = 'hist-action'
      aReveal.title = 'Vis i Finder / Utforsker'
      aReveal.innerHTML = '<svg viewBox="0 0 20 20"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5zM5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>'
      aReveal.addEventListener('click', e => { e.preventDefault(); window.api.revealFile(r.path!) })
      tdActions.appendChild(aReveal)

      const aEdit = document.createElement('a')
      aEdit.href = '#'; aEdit.className = 'hist-action'
      aEdit.title = t('editor.title', 'Rediger lydfil')
      aEdit.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h14M3 6h3m11 0h-3M3 14h3m11 0h-3" stroke-linecap="round"/><circle cx="7.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="12.5" cy="14" r="1.5" fill="currentColor" stroke="none"/></svg>'
      aEdit.addEventListener('click', e => { e.preventDefault(); window.openEditorWithFile(r.path!) })
      tdActions.appendChild(aEdit)
    }
    if (showReveal && videoEntry?.path) {
      const aRevealVid = document.createElement('a')
      aRevealVid.href = '#'; aRevealVid.className = 'hist-action'
      aRevealVid.title = 'Vis videofil i Finder'
      aRevealVid.innerHTML = '<svg viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zm12.553-1.106A1 1 0 0115 5v10a1 1 0 01-1.553.832l-5-3.333a1 1 0 010-1.664l5-3.333a1 1 0 01.106-.072z"/></svg>'
      aRevealVid.addEventListener('click', e => { e.preventDefault(); window.api.revealFile(videoEntry.path!) })
      tdActions.appendChild(aRevealVid)
    }

    const aNote = document.createElement('a')
    aNote.href = '#'; aNote.className = 'hist-action'
    aNote.title = r.note ? t('history.editNote', 'Rediger notat') : t('history.addNote', 'Legg til notat')
    aNote.innerHTML = r.note
      ? '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>'
    aNote.addEventListener('click', e => {
      e.preventDefault()
      showNoteModal(r.note ?? '', async (newNote: string) => {
        r.note = newNote.trim() || undefined
        await window.api.updateHistoryNote(r.timestamp!, newNote.trim())
        const fileCell = tr.cells[2]
        const existing = fileCell.querySelector('.hist-note')
        if (existing) existing.remove()
        if (r.note) {
          const noteEl = Object.assign(document.createElement('div'), { className: 'hist-note', textContent: r.note })
          fileCell.appendChild(noteEl)
        }
        aNote.title = r.note ? t('history.editNote', 'Rediger notat') : t('history.addNote', 'Legg til notat')
        aNote.innerHTML = r.note
          ? '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>'
          : '<svg viewBox="0 0 20 20"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>'
      })
    })
    tdActions.appendChild(aNote)

    const aDel = document.createElement('a')
    aDel.href = '#'; aDel.className = 'hist-action hist-del'
    aDel.title = t('history.deleteEntry', 'Slett oppføring')
    aDel.innerHTML = '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"/></svg>'
    aDel.addEventListener('click', async e => {
      e.preventDefault()
      if (r.timestamp) await window.api.deleteHistoryEntry(r.timestamp)
      if (videoEntry?.timestamp) await window.api.deleteHistoryEntry(videoEntry.timestamp)
      const idx = fullHistory.findIndex(h => h.timestamp === r.timestamp)
      if (idx >= 0) fullHistory.splice(idx, 1)
      if (videoEntry?.timestamp) {
        const vidIdx = fullHistory.findIndex(h => h.timestamp === videoEntry.timestamp)
        if (vidIdx >= 0) fullHistory.splice(vidIdx, 1)
      }
      tr.remove()
      if (!tbody.querySelector('tr')) renderHistoryRows(tbody, [], false)
      updateHistoryStats(fullHistory)
    })
    tdActions.appendChild(aDel)
    tdActions.style.cssText = 'white-space:nowrap;display:flex;align-items:center;gap:3px'

    const timeStr  = r.startTime ? ` kl. ${r.startTime}` : ''
    const cells = [r.date ? `${fmtDate(r.date)}${timeStr}` : '—', r.duration ?? '—', r.filename ?? '—']
    cells.forEach((text, i) => {
      const td = document.createElement('td')
      td.textContent = text
      if (i === 2) {
        if (r.path) td.title = r.path
        if (r.note) {
          td.appendChild(Object.assign(document.createElement('div'), { className: 'hist-note', textContent: r.note }))
        }
        if (videoEntry?.filename) {
          const vidDiv = Object.assign(document.createElement('div'), { className: 'hist-note', textContent: `📹 ${videoEntry.filename}` })
          if (videoEntry.path) vidDiv.title = videoEntry.path
          td.appendChild(vidDiv)
        }
        // Cloud upload indicators
        const cloudNames: Record<string, string> = { 'google-drive': 'GD', 'dropbox': 'DB', 'onedrive': 'OD' }
        const cloudTitles: Record<string, string> = { 'google-drive': 'Google Drive', 'dropbox': 'Dropbox', 'onedrive': 'OneDrive' }
        const uploaded = r.cloudUploaded ?? []
        if (uploaded.length) {
          const cloudDiv = document.createElement('div')
          cloudDiv.className = 'hist-note'
          cloudDiv.style.cssText = 'color:var(--blue,#60a5fa);font-size:11px'
          cloudDiv.textContent = uploaded.map(s => `☁ ${cloudNames[s] ?? s}`).join(' ')
          cloudDiv.title = uploaded.map(s => cloudTitles[s] ?? s).join(', ')
          td.appendChild(cloudDiv)
        }
      }
      tr.appendChild(td)
    })
    tr.appendChild(tdStatus); tr.appendChild(tdActions)
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

async function loadHomeInfoStrip(): Promise<void> {
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
}

function showNoteModal(currentNote: string, onSave: (note: string) => void): void {
  const modal    = document.getElementById('modal-note') as HTMLDivElement | null
  const textarea = document.getElementById('note-textarea') as HTMLTextAreaElement | null
  if (!modal || !textarea) return
  textarea.value = currentNote
  modal.style.display = 'flex'
  setTimeout(() => textarea.focus(), 50)

  const saveBtn   = document.getElementById('btn-note-save')
  const cancelBtn = document.getElementById('btn-note-cancel')

  const close = () => {
    modal.style.display = 'none'
    saveBtn?.removeEventListener('click', handleSave)
    cancelBtn?.removeEventListener('click', handleCancel)
    modal.removeEventListener('click', handleBackdrop)
    document.removeEventListener('keydown', handleKey)
  }
  const handleSave    = () => { onSave(textarea.value); close() }
  const handleCancel  = () => close()
  const handleBackdrop = (e: MouseEvent) => { if (e.target === modal) close() }
  const handleKey     = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { onSave(textarea.value); close() }
  }
  saveBtn?.addEventListener('click', handleSave)
  cancelBtn?.addEventListener('click', handleCancel)
  modal.addEventListener('click', handleBackdrop)
  document.addEventListener('keydown', handleKey)
}

// Type helpers
interface RecordingEntry {
  date?: string
  startTime?: string
  duration?: string
  filename?: string
  path?: string
  status: string
  timestamp?: number
  note?: string
  fileSizeBytes?: number
  durationSec?: number
  cloudUploaded?: string[]
}
