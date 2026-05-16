import { t } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, setVal, setRadio, updateSliderLabel } from '../helpers'
import { getAudioDevices, detectDeviceChannels, buildInputRouter } from '../audio/capture'
import type { DeviceChannels, ChannelMode } from '../../types'

let monitorStream: MediaStream   | null = null
let monitorCtx:    AudioContext  | null = null
let monitorSrc:    MediaStreamAudioSourceNode | null = null
let isMonitoring   = false

let detectedChannelCount = 2

export function setupAudioPage(): void {
  document.getElementById('input-volume')?.addEventListener('input', updateVolumeLabel)

  document.getElementById('eq-bass')?.addEventListener('input',   () => updateSliderLabel('eq-bass',   'eq-bass-val',   ' dB'))
  document.getElementById('eq-mid')?.addEventListener('input',    () => updateSliderLabel('eq-mid',    'eq-mid-val',    ' dB'))
  document.getElementById('eq-treble')?.addEventListener('input', () => updateSliderLabel('eq-treble', 'eq-treble-val', ' dB'))
  document.getElementById('comp-threshold')?.addEventListener('input', () => updateSliderLabel('comp-threshold', 'comp-threshold-val', ' dB'))
  document.getElementById('comp-ratio')?.addEventListener('input', () => {
    const el = document.getElementById('comp-ratio') as HTMLInputElement | null
    const lbl = document.getElementById('comp-ratio-val')
    if (el && lbl) lbl.textContent = el.value + ':1'
  })
  document.getElementById('limiter-ceiling')?.addEventListener('input', () => updateSliderLabel('limiter-ceiling', 'limiter-ceiling-val', ' dB'))
  document.getElementById('opt-compressor')?.addEventListener('change', function (this: HTMLInputElement) {
    const cs = document.getElementById('comp-settings')
    if (cs) cs.style.display = this.checked ? 'block' : 'none'
  })

  document.getElementById('btn-test-audio')?.addEventListener('click', async () => {
    if (isMonitoring) { stopMonitoring(); return }
    await startMonitoring()
  })

  document.getElementById('compat-toggle')?.addEventListener('click', () => {
    const body    = document.getElementById('compat-body')
    const chevron = document.getElementById('compat-chevron')
    const open    = body?.style.display !== 'none'
    if (body)    body.style.display    = open ? 'none' : 'block'
    if (chevron) chevron.classList.toggle('open', !open)
  })

  document.getElementById('btn-audio-save')?.addEventListener('click', saveAudioSettings)
  document.getElementById('btn-audio-cancel')?.addEventListener('click', () => applyAudioSettingsToUI())
}

export function applyAudioSettingsToUI(): void {
  setVal('input-volume', settings.inputVolume ?? 80)
  updateVolumeLabel()
  setRadio('channels', settings.channels ?? 'stereo')
  setVal('sample-rate', settings.sampleRate ?? 48000)
  setVal('eq-bass',   settings.eqBass   ?? 0)
  setVal('eq-mid',    settings.eqMid    ?? 0)
  setVal('eq-treble', settings.eqTreble ?? 0)
  updateSliderLabel('eq-bass',   'eq-bass-val',   ' dB')
  updateSliderLabel('eq-mid',    'eq-mid-val',    ' dB')
  updateSliderLabel('eq-treble', 'eq-treble-val', ' dB')
  const compEl = document.getElementById('opt-compressor') as HTMLInputElement | null
  if (compEl) {
    compEl.checked = !!settings.compEnabled
    const cs = document.getElementById('comp-settings')
    if (cs) cs.style.display = settings.compEnabled ? 'block' : 'none'
  }
  setVal('comp-threshold', settings.compThreshold ?? -24)
  setVal('comp-ratio',     settings.compRatio     ?? 4)
  updateSliderLabel('comp-threshold', 'comp-threshold-val', ' dB')
  const crEl  = document.getElementById('comp-ratio') as HTMLInputElement | null
  const crLbl = document.getElementById('comp-ratio-val')
  if (crEl && crLbl) crLbl.textContent = crEl.value + ':1'
  const limEl = document.getElementById('opt-limiter') as HTMLInputElement | null
  if (limEl) limEl.checked = settings.limiterEnabled !== false
  setVal('limiter-ceiling', settings.limiterCeiling ?? -1)
  updateSliderLabel('limiter-ceiling', 'limiter-ceiling-val', ' dB')
}

function updateVolumeLabel(): void {
  const el  = document.getElementById('input-volume') as HTMLInputElement | null
  const lbl = document.getElementById('volume-value')
  if (el && lbl) lbl.textContent = el.value + '%'
}

async function saveAudioSettings(): Promise<void> {
  const deviceId = (document.querySelector('.device-card.selected') as HTMLElement | null)?.dataset.deviceId ?? settings.deviceId ?? null
  const chL      = +((document.getElementById('channel-select-l') as HTMLInputElement | null)?.value ?? 0)
  const chR      = +((document.getElementById('channel-select-r') as HTMLInputElement | null)?.value ?? 1)

  // Persist per-device channel selection
  const deviceChannels = { ...(settings.deviceChannels ?? {}) }
  if (deviceId) deviceChannels[deviceId] = { channelL: chL, channelR: chR }

  const patch = {
    deviceId,
    deviceChannels,
    inputVolume:    +((document.getElementById('input-volume')    as HTMLInputElement | null)?.value ?? 80),
    channels:       ((document.querySelector('input[name="channels"]:checked') as HTMLInputElement | null)?.value ?? 'stereo') as ChannelMode,
    sampleRate:     +((document.getElementById('sample-rate')    as HTMLInputElement | null)?.value ?? 48000),
    eqBass:         +((document.getElementById('eq-bass')         as HTMLInputElement | null)?.value ?? 0),
    eqMid:          +((document.getElementById('eq-mid')          as HTMLInputElement | null)?.value ?? 0),
    eqTreble:       +((document.getElementById('eq-treble')       as HTMLInputElement | null)?.value ?? 0),
    compEnabled:    !!(document.getElementById('opt-compressor') as HTMLInputElement | null)?.checked,
    compThreshold:  +((document.getElementById('comp-threshold')  as HTMLInputElement | null)?.value ?? -24),
    compRatio:      +((document.getElementById('comp-ratio')      as HTMLInputElement | null)?.value ?? 4),
    limiterEnabled: !!(document.getElementById('opt-limiter')    as HTMLInputElement | null)?.checked,
    limiterCeiling: +((document.getElementById('limiter-ceiling') as HTMLInputElement | null)?.value ?? -1)
  }

  patchSettings(patch)
  await window.api.saveSettings(settings)
  flashSaved(document.getElementById('btn-audio-save'))
}

export async function renderDeviceList(containerId: string): Promise<void> {
  const container = document.getElementById(containerId)
  if (!container) return
  const devices = await getAudioDevices()
  container.innerHTML = ''
  if (!devices.length) {
    container.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">${t('audio.noDevices')}</div>`
    return
  }
  devices.forEach(d => {
    const builtIn  = /built-in|innebygd|default/i.test(d.label)
    const selected = d.deviceId === (settings.deviceId ?? 'default')
    const card     = document.createElement('div')
    card.className          = 'device-card' + (selected ? ' selected' : '')
    card.dataset.deviceId   = d.deviceId
    card.innerHTML = `
      <div class="device-icon">${builtIn ? '🎙️' : '🎛️'}</div>
      <div>
        <div class="device-name">${escHtml(d.label || 'Ukjent enhet')}</div>
        <div class="device-sub">${builtIn ? t('audio.internal','Innebygd') : 'USB / Ekstern'}</div>
      </div>
      <span class="device-badge ${builtIn ? 'warn' : 'ok'}">${builtIn ? t('audio.notRecommended') : t('audio.connected','Tilkoblet ✓')}</span>`
    card.addEventListener('click', async () => {
      container.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'))
      card.classList.add('selected')
      patchSettings({ deviceId: d.deviceId })
      const count = await detectDeviceChannels(d.deviceId)
      detectedChannelCount = count
      // Reset to stored channel values for this device, or defaults
      const stored = settings.deviceChannels?.[d.deviceId]
      updateChannelSelector(count, stored?.channelL ?? 0, stored?.channelR ?? 1)
    })
    container.appendChild(card)
  })

  // Probe current device for channel count
  const devId = settings.deviceId ?? (devices[0]?.deviceId ?? null)
  if (devId) {
    detectDeviceChannels(devId).then(count => {
      detectedChannelCount = count
      const stored = settings.deviceChannels?.[devId]
      updateChannelSelector(count, stored?.channelL ?? 0, stored?.channelR ?? 1)
    })
  }
}

function updateChannelSelector(count: number, chL: number, chR: number): void {
  const card = document.getElementById('channel-select-card')
  if (!card) return
  if (count <= 2) { card.style.display = 'none'; return }
  card.style.display = 'block'
  const selL = document.getElementById('channel-select-l') as HTMLSelectElement | null
  const selR = document.getElementById('channel-select-r') as HTMLSelectElement | null
  if (!selL || !selR) return
  const makeOpts = (): HTMLOptionElement[] =>
    Array.from({ length: count }, (_, i) => {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = `Kanal ${i + 1}`
      return opt
    })
  selL.replaceChildren(...makeOpts())
  selR.replaceChildren(...makeOpts())
  selL.value = String(chL); selR.value = String(chR)
}

async function startMonitoring(): Promise<void> {
  try {
    const devId  = settings.deviceId && settings.deviceId !== 'default' ? settings.deviceId : null
    const stored = settings.deviceId ? (settings.deviceChannels?.[settings.deviceId] ?? null) : null
    const chL    = stored?.channelL ?? 0
    const chR    = stored?.channelR ?? 1
    const need   = Math.max(2, chL + 1, chR + 1)

    monitorStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(devId ? { deviceId: { ideal: devId } } : {}),
        channelCount: { ideal: need }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    })
    monitorCtx = new AudioContext()
    monitorSrc = monitorCtx.createMediaStreamSource(monitorStream)

    const inputNode = buildInputRouter(monitorCtx, monitorSrc, monitorStream, chL, chR)
    const gain = monitorCtx.createGain()
    gain.gain.value = (settings.inputVolume ?? 80) / 100
    inputNode.connect(gain).connect(monitorCtx.destination)

    isMonitoring = true
    const btn  = document.getElementById('btn-test-audio')
    if (btn) btn.innerHTML = `⏹ <span>${t('audio.monitorStop', 'Stopp test')}</span>`
    const warn = document.getElementById('test-audio-warn')
    if (warn) warn.style.display = 'block'
  } catch (err) {
    alert(t('audio.monitorError', 'Kunne ikke starte lydtest: ') + (err as Error).message)
  }
}

export function stopMonitoring(): void {
  monitorSrc?.disconnect(); monitorSrc = null
  monitorCtx?.close();      monitorCtx = null
  monitorStream?.getTracks().forEach(t => t.stop()); monitorStream = null
  isMonitoring = false
  const btn  = document.getElementById('btn-test-audio')
  if (btn) btn.innerHTML = `🎧 <span data-i18n="audio.testBtn">${t('audio.testBtn', 'Test lyd')}</span>`
  const warn = document.getElementById('test-audio-warn')
  if (warn) warn.style.display = 'none'
}

function escHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m))
}
