import { settings, patchSettings } from '../state'
import { flashMsg } from '../helpers'
import type { Settings } from '../../types'

import { t } from '../i18n'
import { updateAudioSeparateButton, loadVideoInfoStrip, updateVideoToggleButton } from './home'

function updateKeepAudioVisibility(): void {
  const modeEl    = document.querySelector<HTMLInputElement>('input[name="video-mode"]:checked')
  const separate  = modeEl?.value === 'separate'
  const row       = document.getElementById('video-keep-audio-row')
  if (row) row.style.display = separate ? 'none' : ''
}

function showVideoWarning(msg: string): void {
  const bitrateInput = document.getElementById('video-bitrate-value') as HTMLInputElement | null
  if (!bitrateInput) return
  let warn = document.getElementById('video-bitrate-warn')
  if (!warn) {
    warn = document.createElement('div')
    warn.id = 'video-bitrate-warn'
    warn.style.cssText = 'font-size:12px;color:var(--orange);margin-top:4px'
    bitrateInput.parentElement?.after(warn)
  }
  warn.textContent = msg
  setTimeout(() => { if (warn) warn.textContent = '' }, 4000)
}

type VideoDevice = { name: string; index: number }
let loadedDevices: VideoDevice[] = []

export function setupVideoPage(): void {
  // AUTO-SAVE: every video control persists immediately on change (the old flow
  // required clicking «Lagre», so a resolution change the user made and then
  // navigated away from was silently lost — the recorder kept using defaults, and
  // the Home card never updated). saveVideoSettings also refreshes the Home strip
  // + pushes the recording-critical settings to the backend.
  const autoSave = () => { void saveVideoSettings() }

  const toggle = document.getElementById('opt-video-enable') as HTMLInputElement | null
  toggle?.addEventListener('change', () => {
    const enabled = toggle.checked
    const panel = document.getElementById('video-settings-panel')
    if (panel) panel.style.display = enabled ? '' : 'none'
    autoSave()
  })

  document.getElementById('btn-video-refresh-devices')?.addEventListener('click', async () => {
    await refreshVideoDevices()
  })

  // When the camera changes, gate resolution/fps to what it can actually do + save.
  document.getElementById('video-device-select')?.addEventListener('change', () => {
    void applyCameraCapabilities()
    autoSave()
  })

  // Persist resolution / fps / container / codec / encoder on change.
  document.querySelectorAll<HTMLInputElement>('input[name="video-resolution"]').forEach(el => {
    el.addEventListener('change', autoSave)
  })
  ;['video-fps-select', 'video-container-select', 'video-codec-select', 'video-encoder-select'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', autoSave)
  })

  // video-mode radio buttons — update keep-audio visibility + save
  document.querySelectorAll<HTMLInputElement>('input[name="video-mode"]').forEach(el => {
    el.addEventListener('change', () => { updateKeepAudioVisibility(); autoSave() })
  })
  document.getElementById('opt-video-keep-audio')?.addEventListener('change', autoSave)

  // Toggle custom bitrate row
  const toggleBitrateRow = () => {
    const autoCheck = document.getElementById('opt-video-bitrate-auto') as HTMLInputElement | null
    const row = document.getElementById('video-bitrate-custom-row')
    if (row) row.style.display = autoCheck?.checked ? 'none' : ''
  }
  document.getElementById('opt-video-bitrate-auto')?.addEventListener('change', toggleBitrateRow)
  document.getElementById('opt-video-bitrate-custom')?.addEventListener('change', toggleBitrateRow)

  // OPPGAVE 4: validate bitrate on blur/input
  const bitrateInput = document.getElementById('video-bitrate-value') as HTMLInputElement | null
  bitrateInput?.addEventListener('change', () => {
    const val = parseInt(bitrateInput.value)
    if (isNaN(val) || val < 500) {
      bitrateInput.value = '500'
      showVideoWarning(t('video.minBitrateWarn', 'Minimum bitrate er 500 kbps'))
    } else if (val > 50000) {
      bitrateInput.value = '50000'
      showVideoWarning(t('video.maxBitrateWarn', 'Maksimum bitrate er 50 000 kbps'))
    }
  })

  document.getElementById('btn-video-save')?.addEventListener('click', async () => {
    await saveVideoSettings()
    flashMsg(document.getElementById('btn-video-save'), '✓ Lagret', true)
  })

  document.getElementById('btn-video-cancel')?.addEventListener('click', () => {
    applyVideoSettingsToUI()
  })
}

export async function refreshVideoDevices(): Promise<void> {
  const selectEl = document.getElementById('video-device-select') as HTMLSelectElement | null
  if (!selectEl) return

  selectEl.disabled = true
  const oldVal = selectEl.value
  selectEl.innerHTML = '<option>Leter etter kameraer…</option>'

  try {
    const devices = (await window.api.listVideoDevices()) as VideoDevice[]
    loadedDevices = devices
    selectEl.innerHTML = ''

    if (!devices.length) {
      selectEl.innerHTML = '<option value="">Ingen kameraer funnet</option>'
      selectEl.disabled = true
      return
    }

    devices.forEach(d => {
      const opt = document.createElement('option')
      opt.value = String(d.index)
      opt.dataset.name = d.name
      opt.textContent = d.name
      selectEl.appendChild(opt)
    })

    // Restore previously selected device by name
    const currentName = settings.videoDeviceName ?? ''
    const match = devices.find(d => d.name === currentName) ?? devices[0]
    selectEl.value = String(match?.index ?? 0)
    selectEl.disabled = false
  } catch {
    selectEl.innerHTML = '<option value="">Feil ved lasting</option>'
    selectEl.disabled = true
  }
}

export function applyVideoSettingsToUI(): void {
  const toggle  = document.getElementById('opt-video-enable') as HTMLInputElement | null
  const panel   = document.getElementById('video-settings-panel')
  const enabled = settings.videoEnabled ?? false

  if (toggle)  toggle.checked = enabled
  if (panel)   panel.style.display = enabled ? '' : 'none'

  // Resolution
  const res = settings.videoResolution ?? '720p'
  const resEl = document.querySelector<HTMLInputElement>(`input[name="video-resolution"][value="${res}"]`)
  if (resEl) resEl.checked = true

  // Bitrate
  const bitrate     = settings.videoBitrate ?? 0
  const autoCheck   = document.getElementById('opt-video-bitrate-auto') as HTMLInputElement | null
  const customCheck = document.getElementById('opt-video-bitrate-custom') as HTMLInputElement | null
  const bitrateInput = document.getElementById('video-bitrate-value') as HTMLInputElement | null
  const bitrateRow  = document.getElementById('video-bitrate-custom-row')
  if (bitrate === 0) {
    if (autoCheck) autoCheck.checked = true
    if (bitrateRow) bitrateRow.style.display = 'none'
  } else {
    if (customCheck) customCheck.checked = true
    if (bitrateInput) bitrateInput.value = String(bitrate)
    if (bitrateRow) bitrateRow.style.display = ''
  }

  // Framerate
  const fps = settings.videoFramerate ?? 30
  const fpsEl = document.getElementById('video-fps-select') as HTMLSelectElement | null
  if (fpsEl) fpsEl.value = String(fps)

  // Container + codec
  const containerEl = document.getElementById('video-container-select') as HTMLSelectElement | null
  if (containerEl) containerEl.value = settings.videoContainer ?? 'mp4'
  const codecEl = document.getElementById('video-codec-select') as HTMLSelectElement | null
  if (codecEl) codecEl.value = settings.videoCodec ?? 'h264'
  const encoderEl = document.getElementById('video-encoder-select') as HTMLSelectElement | null
  if (encoderEl) encoderEl.value = settings.videoEncoder ?? 'software'

  // Output mode
  const separate   = settings.videoSeparate ?? false
  const modeEl     = document.querySelector<HTMLInputElement>(`input[name="video-mode"][value="${separate ? 'separate' : 'combined'}"]`)
  if (modeEl) modeEl.checked = true

  // Keep audio toggle — only visible when NOT separate
  const keepAudioEl = document.getElementById('opt-video-keep-audio') as HTMLInputElement | null
  if (keepAudioEl) keepAudioEl.checked = settings.videoKeepAudio !== false
  updateKeepAudioVisibility()

  // Unified-recorder toggle — default ON since v4.51. Treat `undefined`
  // Perfekt A/V-synk (unified recorder) er ALLTID på — valget er fjernet fra UI.

  // Populate device select (best-effort — may not have been loaded yet)
  if (loadedDevices.length) {
    const selectEl = document.getElementById('video-device-select') as HTMLSelectElement | null
    if (selectEl && selectEl.options.length > 0) {
      const match = loadedDevices.find(d => d.name === (settings.videoDeviceName ?? ''))
      if (match) selectEl.value = String(match.index)
    }
  }

  // Warn when split recording is active: combined MP4 is not available in that mode
  const hasSplit = (settings.splitMinutes ?? 0) > 0
  const splitWarning = document.getElementById('video-split-warning')
  const splitHint    = document.getElementById('video-split-hint')
  if (splitWarning) splitWarning.style.display = hasSplit ? '' : 'none'
  if (splitHint)    splitHint.style.display    = hasSplit ? 'none' : ''

  // Gate resolution/fps to the selected camera's advertised modes.
  void applyCameraCapabilities()
}

/**
 * Probe the selected camera and DISABLE the resolution cards / fps options it
 * can't deliver — a camera only records modes in its hardware descriptor, so
 * offering 4K/60 on a 720p webcam would just fail to open. On a failed probe
 * (or a platform that doesn't list modes) we leave everything enabled (let the
 * user try) rather than blocking. If the currently-selected resolution/fps is
 * not supported, we fall back to the best supported one and show a hint.
 */
export async function applyCameraCapabilities(): Promise<void> {
  const selectEl = document.getElementById('video-device-select') as HTMLSelectElement | null
  const warnEl = document.getElementById('video-res-warning')
  const token = selectEl?.value
  // Re-enable everything first (clean slate before re-gating).
  const resInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="video-resolution"]'))
  const fpsEl = document.getElementById('video-fps-select') as HTMLSelectElement | null
  resInputs.forEach(r => { (r.closest('.option-card') as HTMLElement | null)?.classList.remove('is-disabled'); r.disabled = false })
  if (fpsEl) Array.from(fpsEl.options).forEach(o => { o.disabled = false })
  if (warnEl) warnEl.style.display = 'none'
  if (!token) return

  let cap: { supportedResolutions: string[]; supportedFramerates: number[]; maxHeight: number; maxFps: number } | null = null
  try {
    cap = await window.api.getCameraCapabilities(token)
  } catch {
    cap = null
  }
  // Empty/failed probe → offer everything (don't block on a probe miss).
  if (!cap || cap.supportedResolutions.length === 0) return

  // The highest supported tag = the camera's native ceiling (list is ascending).
  const nativeTag = [...cap.supportedResolutions].pop()

  // Disable unsupported resolution cards + badge the native one.
  for (const r of resInputs) {
    const ok = cap.supportedResolutions.includes(r.value)
    r.disabled = !ok
    const card = r.closest('.option-card') as HTMLElement | null
    card?.classList.toggle('is-disabled', !ok)
    // Refresh the per-card capability badge.
    card?.querySelector('.option-card-cap-badge')?.remove()
    if (card) {
      const badge = document.createElement('div')
      badge.className = 'option-card-cap-badge'
      if (!ok) {
        badge.textContent = t('video.resNotSupported', 'ikke støttet')
        badge.classList.add('cap-unsupported')
        card.appendChild(badge)
      } else if (r.value === nativeTag) {
        badge.textContent = t('video.resNative', 'kameraets maks')
        badge.classList.add('cap-native')
        card.appendChild(badge)
      }
    }
  }
  // Disable unsupported fps options.
  if (fpsEl) {
    for (const o of Array.from(fpsEl.options)) {
      o.disabled = !cap.supportedFramerates.includes(parseInt(o.value))
    }
  }

  // If the current pick is now unsupported, fall back to the best supported.
  const checked = resInputs.find(r => r.checked)
  const fellBack = !!(checked && checked.disabled)
  if (fellBack) {
    const fallback = resInputs.find(r => r.value === nativeTag)
    if (fallback) fallback.checked = true
  }
  if (fpsEl && fpsEl.selectedOptions[0]?.disabled) {
    const bestFps = [...cap.supportedFramerates].pop()
    if (bestFps != null) fpsEl.value = String(bestFps)
  }

  // Always show the camera's native ceiling; prepend a warning when we had to
  // fall back from an unsupported pick.
  if (warnEl) {
    const info = `${t('video.cameraDelivers', 'Kameraet leverer maks')} ${cap.maxHeight}p · ${cap.maxFps} fps.`
    warnEl.textContent = fellBack
      ? `${t('video.resUnsupportedShort', 'Valgt oppløsning støttes ikke — satt til kameraets maks.')} ${info}`
      : info
    ;(warnEl as HTMLElement).style.color = fellBack ? 'var(--warning, #d08700)' : 'var(--text-3, #8899bb)'
    warnEl.style.display = ''
  }
}

async function saveVideoSettings(): Promise<void> {
  const toggle  = document.getElementById('opt-video-enable') as HTMLInputElement | null
  const selectEl = document.getElementById('video-device-select') as HTMLSelectElement | null
  const fpsEl   = document.getElementById('video-fps-select') as HTMLSelectElement | null
  const bitrateInput = document.getElementById('video-bitrate-value') as HTMLInputElement | null

  const enabled   = toggle?.checked ?? false
  const deviceIdx = selectEl ? parseInt(selectEl.value) : null
  const deviceName = selectEl
    ? (selectEl.selectedOptions[0]?.dataset.name ?? selectEl.selectedOptions[0]?.textContent ?? null)
    : null

  const res = (document.querySelector<HTMLInputElement>('input[name="video-resolution"]:checked')?.value ?? '720p') as '2160p' | '1080p' | '720p' | '480p'
  const fps = fpsEl ? parseInt(fpsEl.value) : 30
  const containerEl = document.getElementById('video-container-select') as HTMLSelectElement | null
  const codecEl = document.getElementById('video-codec-select') as HTMLSelectElement | null
  const videoContainer = (containerEl?.value ?? 'mp4') as 'mp4' | 'mov'
  const videoCodec = (codecEl?.value ?? 'h264') as 'h264' | 'h265'
  const encoderEl = document.getElementById('video-encoder-select') as HTMLSelectElement | null
  const videoEncoder = (encoderEl?.value ?? 'software') as 'software' | 'hardware'

  const autoMode = document.getElementById('opt-video-bitrate-auto') as HTMLInputElement | null
  const bitrate  = (autoMode?.checked) ? 0 : parseInt(bitrateInput?.value ?? '0') || 0

  const modeSel   = document.querySelector<HTMLInputElement>('input[name="video-mode"]:checked')
  const separate  = modeSel?.value === 'separate'

  const keepAudioEl = document.getElementById('opt-video-keep-audio') as HTMLInputElement | null
  const keepAudio   = keepAudioEl ? keepAudioEl.checked : true

  // Perfekt A/V-synk er alltid på (valget er fjernet).
  const useUnifiedRecorder = true

  const updated = {
    ...settings,
    videoEnabled:      enabled,
    videoDeviceIndex:  deviceIdx,
    videoDeviceName:   deviceName,
    videoResolution:   res,
    videoFramerate:    fps,
    videoContainer,
    videoCodec,
    videoEncoder,
    videoBitrate:      bitrate,
    videoSeparate:     separate,
    videoKeepAudio:    keepAudio,
    useUnifiedRecorder,
  }

  patchSettings(updated)
  await window.api.saveSettings(updated as Settings)
  // Mirror endringene til Hjem-skjermen live (uten navigasjon): «Separat lydfil»-
  // badge, «Video på»-toggelen OG videokvalitet-/kamera-info-kortene. Alle er
  // no-op hvis home-DOM ikke er montert (intern guard).
  updateAudioSeparateButton()
  updateVideoToggleButton()
  loadVideoInfoStrip()
}
