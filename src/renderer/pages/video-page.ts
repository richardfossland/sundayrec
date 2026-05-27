import { settings, patchSettings } from '../state'
import { flashMsg } from '../helpers'
import type { Settings } from '../../types'

import { t } from '../i18n'

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
  const toggle = document.getElementById('opt-video-enable') as HTMLInputElement | null
  toggle?.addEventListener('change', () => {
    const enabled = toggle.checked
    const panel = document.getElementById('video-settings-panel')
    if (panel) panel.style.display = enabled ? '' : 'none'
  })

  document.getElementById('btn-video-refresh-devices')?.addEventListener('click', async () => {
    await refreshVideoDevices()
  })

  // video-mode radio buttons — update keep-audio visibility
  document.querySelectorAll<HTMLInputElement>('input[name="video-mode"]').forEach(el => {
    el.addEventListener('change', updateKeepAudioVisibility)
  })

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

  // Output mode
  const separate   = settings.videoSeparate ?? false
  const modeEl     = document.querySelector<HTMLInputElement>(`input[name="video-mode"][value="${separate ? 'separate' : 'combined'}"]`)
  if (modeEl) modeEl.checked = true

  // Keep audio toggle — only visible when NOT separate
  const keepAudioEl = document.getElementById('opt-video-keep-audio') as HTMLInputElement | null
  if (keepAudioEl) keepAudioEl.checked = settings.videoKeepAudio !== false
  updateKeepAudioVisibility()

  // Unified-recorder toggle (experimental A/V-sync fix)
  const unifiedEl = document.getElementById('opt-use-unified-recorder') as HTMLInputElement | null
  if (unifiedEl) unifiedEl.checked = !!settings.useUnifiedRecorder

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

  const res = (document.querySelector<HTMLInputElement>('input[name="video-resolution"]:checked')?.value ?? '720p') as '1080p' | '720p' | '480p'
  const fps = fpsEl ? parseInt(fpsEl.value) : 30

  const autoMode = document.getElementById('opt-video-bitrate-auto') as HTMLInputElement | null
  const bitrate  = (autoMode?.checked) ? 0 : parseInt(bitrateInput?.value ?? '0') || 0

  const modeSel   = document.querySelector<HTMLInputElement>('input[name="video-mode"]:checked')
  const separate  = modeSel?.value === 'separate'

  const keepAudioEl = document.getElementById('opt-video-keep-audio') as HTMLInputElement | null
  const keepAudio   = keepAudioEl ? keepAudioEl.checked : true

  const unifiedEl = document.getElementById('opt-use-unified-recorder') as HTMLInputElement | null
  const useUnifiedRecorder = !!unifiedEl?.checked

  const updated = {
    ...settings,
    videoEnabled:      enabled,
    videoDeviceIndex:  deviceIdx,
    videoDeviceName:   deviceName,
    videoResolution:   res,
    videoFramerate:    fps,
    videoBitrate:      bitrate,
    videoSeparate:     separate,
    videoKeepAudio:    keepAudio,
    useUnifiedRecorder,
  }

  patchSettings(updated)
  await window.api.saveSettings(updated as Settings)
  // Mirror to Hjem-skjermens "Separat lydfil"-badge så den reflekterer
  // toggle-en uten at brukeren må navigere bort og tilbake.
  try {
    const { updateAudioSeparateButton } = await import('./home')
    updateAudioSeparateButton()
  } catch { /* home not ready — fine, will refresh on next visit */ }
}
