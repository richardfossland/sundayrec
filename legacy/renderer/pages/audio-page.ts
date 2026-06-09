import { t } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, setVal, setRadio, setupDirtyBar } from '../helpers'
import { getAudioDevices, detectDeviceChannels, buildInputRouter } from '../audio/capture'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'
import { refreshHomeDiskSpace, loadHomeInfoStrip } from './home'
import type { ChannelMode } from '../../types'

let monitorStream: MediaStream   | null = null
let monitorCtx:    AudioContext  | null = null
let monitorSrc:    MediaStreamAudioSourceNode | null = null
let isMonitoring   = false
let testVu = makeVuState()

let _markAudioClean = () => {}
let _markAudioDirty = () => {}

function updateVolGradient(): void {
  const el = document.getElementById('input-volume') as HTMLInputElement | null
  if (!el) return
  const pct = +el.value
  el.style.setProperty('--vol-pct', pct + '%')
}

export function setupAudioPage(): void {
  const bar = setupDirtyBar('settings-audio')
  _markAudioClean = bar.clean
  _markAudioDirty = bar.dirty

  // AUTO-SAVE: persist on change so a setting takes effect immediately (the old
  // flow required clicking «Lagre»; a change the user made and navigated away
  // from was silently lost → recorder kept using defaults). saveAudioSettings
  // also pushes the recording-critical subset to the backend.
  const autoSave = () => { void saveAudioSettings() }

  // Sample-rate mode cards (auto / r44100 / r48000) → save.
  document.querySelectorAll<HTMLInputElement>('input[name="sampleRate"]').forEach(r => {
    r.addEventListener('change', autoSave)
  })

  // Channel-mode cards (stereo / mono / monoL / monoR).
  document.querySelectorAll<HTMLInputElement>('input[name="channels"]').forEach(r => {
    r.addEventListener('change', autoSave)
  })
  // Multi-channel L/R mapping selects (persist the device's channel choice).
  document.getElementById('channel-select-l')?.addEventListener('change', autoSave)
  document.getElementById('channel-select-r')?.addEventListener('change', autoSave)

  // Show the actual rate «Automatisk» resolves to (the hardware's native rate).
  void showAutoSampleRate()

  // Windows-only "classic DirectShow" escape hatch: reveal the card on Windows and
  // persist the toggle. On macOS the card stays hidden (no DirectShow there).
  if (/win/i.test(navigator.userAgent)) {
    const card = document.getElementById('classic-audio-card')
    if (card) card.style.display = ''
    document.getElementById('opt-classic-dshow')?.addEventListener('change', autoSave)
  }
  // NB: compressor/limiter/EQ/input-volume controls are hidden inert inputs
  // (record-raw philosophy — see saveAudioSettings); no listeners needed.

  document.getElementById('btn-test-audio')?.addEventListener('click', async () => {
    if (isMonitoring) { stopMonitoring(); return }
    await startMonitoring()
  })

  document.getElementById('btn-audio-diagnose')?.addEventListener('click', runAudioDiagnosis)
  document.getElementById('btn-audio-diagnose-close')?.addEventListener('click', () => {
    const modal = document.getElementById('audio-diagnose-modal')
    if (modal) modal.style.display = 'none'
  })

  document.getElementById('btn-audio-save')?.addEventListener('click', saveAudioSettings)
  document.getElementById('btn-audio-cancel')?.addEventListener('click', () => applyAudioSettingsToUI())
}

/** Fill the «Automatisk» card with the actual sample rate it will use — the
 *  audio hardware's native rate (what ffmpeg captures at with no `-ar`). Detected
 *  via a throwaway AudioContext, whose `sampleRate` is the system audio rate (on
 *  the Mac built-in mic this matches the capture rate, e.g. 48 000 Hz). */
async function showAutoSampleRate(): Promise<void> {
  const el = document.getElementById('sr-auto-actual')
  if (!el) return
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const hz = ctx.sampleRate
    void ctx.close()
    el.textContent = hz ? ` · ${hz.toLocaleString('nb-NO')} Hz` : ''
  } catch {
    el.textContent = ''
  }
}

/** A 1-channel input device (the Mac built-in mic, most USB lavaliers) can't
 *  produce stereo — recording it as stereo gives a dead right channel. So when a
 *  mono device is active, switch the recording to MonoL (full-level mono from the
 *  live channel; a clean mono file plays on both speakers). Only ever auto-set
 *  mono — never auto-revert a 2-channel device, so a real stereo interface keeps
 *  the user's choice. */
function autoMonoForDevice(count: number): void {
  if (count === 1 && settings.channels !== "monoL") {
    setRadio("channels", "monoL")
    void saveAudioSettings()
  }
}

export function applyAudioSettingsToUI(): void {
  _markAudioClean()
  setVal('input-volume', settings.inputVolume ?? 100)
  updateVolumeLabel()
  setRadio('channels', settings.channels ?? 'stereo')
  // Sample-rate mode cards — default Auto (native capture).
  const srMode = settings.sampleRateMode ?? 'auto'
  document.querySelectorAll<HTMLInputElement>('input[name="sampleRate"]').forEach(r => {
    r.checked = r.value === srMode
  })
  updateVolGradient()
  const classicEl = document.getElementById('opt-classic-dshow') as HTMLInputElement | null
  if (classicEl) classicEl.checked = !!settings.classicDirectshow
  const compEl = document.getElementById('opt-compressor') as HTMLInputElement | null
  if (compEl) {
    compEl.checked = !!settings.compEnabled
    const cs = document.getElementById('comp-settings')
    if (cs) cs.style.display = settings.compEnabled ? 'block' : 'none'
  }
  setVal('comp-threshold', settings.compThreshold ?? -24)
  setVal('comp-ratio',     settings.compRatio     ?? 4)
  setVal('comp-attack',    settings.compAttack    ?? 10)
  setVal('comp-release',   settings.compRelease   ?? 200)
}

function updateVolumeLabel(): void {
  const el  = document.getElementById('input-volume') as HTMLInputElement | null
  const lbl = document.getElementById('volume-value')
  if (el && lbl) lbl.textContent = el.value + '%'
}

async function saveAudioSettings(): Promise<void> {
  const selectedCard = document.querySelector('.device-card.selected') as HTMLElement | null
  const deviceId   = selectedCard?.dataset.deviceId   ?? settings.deviceId   ?? null
  const deviceName = selectedCard?.dataset.deviceLabel ?? settings.deviceName ?? null
  const chL      = +((document.getElementById('channel-select-l') as HTMLInputElement | null)?.value ?? 0)
  const chR      = +((document.getElementById('channel-select-r') as HTMLInputElement | null)?.value ?? 1)

  // Persist per-device channel selection
  const deviceChannels = { ...(settings.deviceChannels ?? {}) }
  if (deviceId) deviceChannels[deviceId] = { channelL: chL, channelR: chR }

  const srMode = ((document.querySelector('input[name="sampleRate"]:checked') as HTMLInputElement | null)
    ?.value ?? 'auto') as 'auto' | 'r44100' | 'r48000'
  const classicDirectshow = !!(document.getElementById('opt-classic-dshow') as HTMLInputElement | null)?.checked

  // NB: the compressor/limiter/EQ/input-volume fields are NOT saved here. They are
  // hidden, inert inputs (record-raw philosophy since v4.31 — dynamics/EQ live in
  // the editor, not the capture pipeline), so they keep their DEFAULT_SETTINGS
  // values. The audio-page only persists what it actually controls.
  const patch = {
    deviceId,
    deviceName,
    deviceChannels,
    channels:       ((document.querySelector('input[name="channels"]:checked') as HTMLInputElement | null)?.value ?? 'stereo') as ChannelMode,
    sampleRateMode: srMode,
    classicDirectshow,
    // Keep the numeric sampleRate in sync for client-side use (VU monitor + disk
    // estimate). Auto → 48 kHz as a reasonable estimate; the recorder itself uses
    // sampleRateMode (auto = native, no -ar).
    sampleRate:     srMode === 'r44100' ? 44100 : 48000,
  }

  patchSettings(patch)
  await window.api.saveSettings(settings)
  _markAudioClean()
  flashSaved(document.getElementById('btn-audio-save'))
  // Refresh Home live: disk estimate (channels/samplerate) + the device/format
  // info-strip cards so the change shows without navigating away and back.
  void refreshHomeDiskSpace()
  void loadHomeInfoStrip()
}

export async function renderDeviceList(containerId: string): Promise<void> {
  const container = document.getElementById(containerId)
  if (!container) return

  const [devices, asioDrivers] = await Promise.all([
    getAudioDevices(),
    window.api.listAsioDrivers().catch(() => [] as string[])
  ])

  container.innerHTML = ''
  if (!devices.length && !asioDrivers.length) {
    container.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">${t('audio.noDevices')}</div>`
    return
  }

  // ── ASIO devices (Windows pro audio) ───────────────────────────────────────
  // An ASIO interface shows up as ONE device exposing all its channels (the
  // dshow path splits it into stereo pairs). These come first — the preferred,
  // low-latency, multichannel path. The backend addresses the device by its raw
  // name (`deviceName`); the `asio::`-prefixed `deviceId` is the UI/key handle.
  asioDrivers.forEach(name => {
    const devId    = `asio::${name}`
    const selected = settings.deviceId === devId
    const card     = document.createElement('div')
    card.className           = 'device-card' + (selected ? ' selected' : '')
    card.dataset.deviceId    = devId
    card.dataset.deviceLabel = name
    card.innerHTML = `
      <div class="device-icon">🎛</div>
      <div>
        <div class="device-name">${escHtml(name)}</div>
        <div class="device-sub" data-sub-base="ASIO">ASIO</div>
      </div>
      <span class="device-badge ok">ASIO</span>`
    card.addEventListener('click', async () => {
      container.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'))
      card.classList.add('selected')
      patchSettings({ deviceId: devId, deviceName: name })
      _markAudioDirty()
      const count = await window.api.listAsioInputChannels(name).catch(() => 0)
      const chan  = count > 0 ? count : 16
      const subEl = card.querySelector('.device-sub') as HTMLElement | null
      if (subEl) subEl.textContent = `ASIO · ${chan} ${t('audio.channelCount', 'kanaler')}`
      const stored = settings.deviceChannels?.[devId]
      updateChannelSelector(chan, stored?.channelL ?? 0, stored?.channelR ?? 1)
      void saveAudioSettings()
    })
    container.appendChild(card)
  })

  // ── Standard Web Audio devices ─────────────────────────────────────────────
  devices.forEach(d => {
    const builtIn  = /built-in|innebygd|default/i.test(d.label)
    const selected = d.deviceId === (settings.deviceId ?? 'default')
    const card     = document.createElement('div')
    card.className            = 'device-card' + (selected ? ' selected' : '')
    card.dataset.deviceId     = d.deviceId
    card.dataset.deviceLabel  = d.label
    const subBase = builtIn ? t('audio.internal','Innebygd') : 'USB / Ekstern'
    card.innerHTML = `
      <div class="device-icon">${builtIn ? '🎙' : '🎛'}</div>
      <div>
        <div class="device-name">${escHtml(d.label || 'Ukjent enhet')}</div>
        <div class="device-sub" data-sub-base="${escHtml(subBase)}">${escHtml(subBase)}</div>
      </div>
      <span class="device-badge ${builtIn ? 'warn' : 'ok'}">${builtIn ? t('audio.notRecommended') : t('audio.connected','Tilkoblet ✓')}</span>`
    card.addEventListener('click', async () => {
      container.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'))
      card.classList.add('selected')
      patchSettings({ deviceId: d.deviceId, deviceName: d.label })
      _markAudioDirty()
      const count = await detectDeviceChannels(d.deviceId)
      autoMonoForDevice(count)
      const subEl = card.querySelector('.device-sub') as HTMLElement | null
      if (subEl) subEl.textContent = `${subBase} · ${count} ${t('audio.channelCount', 'kanaler')}`
      const stored = settings.deviceChannels?.[d.deviceId]
      updateChannelSelector(count, stored?.channelL ?? 0, stored?.channelR ?? 1)
      // Persist the device choice immediately (no «Lagre» click needed) so the
      // recorder + Home card pick it up.
      void saveAudioSettings()
    })
    container.appendChild(card)
  })

  // After rendering device cards, check ffmpeg device availability
  window.api.listFfmpegAudioDevices?.().then((ffmpegDevices) => {
    const stored = settings.deviceName
    if (!stored || !ffmpegDevices) return
    const found = ffmpegDevices.some(d =>
      d.name.toLowerCase().includes(stored.toLowerCase().slice(0, 8)) ||
      stored.toLowerCase().includes(d.name.toLowerCase().slice(0, 8))
    )
    const warn = document.getElementById('device-ffmpeg-warn')
    if (warn) warn.style.display = found ? 'none' : ''
  }).catch(() => {})

  // Probe current (non-ASIO) device for channel count
  const devId = settings.deviceId ?? (devices[0]?.deviceId ?? null)
  if (devId && !devId.startsWith('asio::')) {
    detectDeviceChannels(devId).then(count => {
      autoMonoForDevice(count)
      const stored = settings.deviceChannels?.[devId]
      updateChannelSelector(count, stored?.channelL ?? 0, stored?.channelR ?? 1)
      const selCard = container.querySelector('.device-card.selected') as HTMLElement | null
      const subEl   = selCard?.querySelector('.device-sub') as HTMLElement | null
      if (subEl) {
        const base = subEl.dataset.subBase ?? ''
        subEl.textContent = `${base} · ${count} ${t('audio.channelCount', 'kanaler')}`
      }
    })
  } else if (devId?.startsWith('asio::')) {
    const name   = devId.slice('asio::'.length)
    const stored = settings.deviceChannels?.[devId]
    window.api.listAsioInputChannels(name).then(count => {
      const chan = count > 0 ? count : 16
      updateChannelSelector(chan, stored?.channelL ?? 0, stored?.channelR ?? 1)
      const selCard = container.querySelector('.device-card.selected') as HTMLElement | null
      const subEl   = selCard?.querySelector('.device-sub') as HTMLElement | null
      if (subEl) subEl.textContent = `ASIO · ${chan} ${t('audio.channelCount', 'kanaler')}`
    }).catch(() => updateChannelSelector(16, stored?.channelL ?? 0, stored?.channelR ?? 1))
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
  // OPPGAVE 3: stop any existing stream before opening a new one to prevent double GUM streams
  if (monitorStream) {
    monitorStream.getTracks().forEach(t => t.stop())
    monitorStream = null
    monitorSrc?.disconnect(); monitorSrc = null
    monitorCtx?.close(); monitorCtx = null
    // Small pause to let the driver release the device
    await new Promise<void>(r => setTimeout(r, 100))
  }

  try {
    // ASIO device IDs (asio::DriverName) are not valid getUserMedia IDs — use default input for monitoring
    const rawId  = settings.deviceId
    const devId  = rawId && rawId !== 'default' && !rawId.startsWith('asio::') ? rawId : null
    const stored = settings.deviceId ? (settings.deviceChannels?.[settings.deviceId] ?? null) : null
    const chL    = stored?.channelL ?? 0
    const chR    = stored?.channelR ?? 1
    const need   = Math.max(2, chL + 1, chR + 1)

    monitorStream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(devId ? { deviceId: { ideal: devId } } : {}),
        channelCount: { ideal: need }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    })
    monitorCtx = new AudioContext({ sampleRate: settings.sampleRate ?? 48000 })
    monitorSrc = monitorCtx.createMediaStreamSource(monitorStream)

    const inputNode = buildInputRouter(monitorCtx, monitorSrc, monitorStream, chL, chR)
    const gain = monitorCtx.createGain()
    gain.gain.value = (settings.inputVolume ?? 80) / 100
    inputNode.connect(gain).connect(monitorCtx.destination)

    // VU meters for audio test
    const monAnalyser = monitorCtx.createAnalyser()
    monAnalyser.fftSize = 2048
    inputNode.connect(monAnalyser)
    testVu = makeVuState()
    Object.assign(testVu, { analyserL: monAnalyser, analyserR: monAnalyser })
    tickVU(testVu,
      document.getElementById('test-vu-l'), null, null,
      document.getElementById('test-vu-r'), null, null
    )
    const vuSect = document.getElementById('test-vu-section')
    if (vuSect) vuSect.style.display = 'block'

    isMonitoring = true
    const btn  = document.getElementById('btn-test-audio')
    if (btn) btn.innerHTML = `⏹ <span>${t('audio.monitorStop', 'Stopp test')}</span>`
    const warn = document.getElementById('test-audio-warn')
    if (warn) warn.style.display = 'block'
  } catch (err) {
    monitorStream?.getTracks().forEach(tk => tk.stop()); monitorStream = null
    monitorCtx?.close(); monitorCtx = null
    alert(t('audio.monitorError', 'Kunne ikke starte lydtest: ') + (err as Error).message)
  }
}

export function stopMonitoring(): void {
  stopVuState(testVu); testVu = makeVuState()
  const vuSect = document.getElementById('test-vu-section')
  if (vuSect) vuSect.style.display = 'none'
  monitorSrc?.disconnect(); monitorSrc = null
  monitorCtx?.close();      monitorCtx = null
  monitorStream?.getTracks().forEach(t => t.stop()); monitorStream = null
  isMonitoring = false
  const btn  = document.getElementById('btn-test-audio')
  if (btn) btn.innerHTML = `🎧 <span data-i18n="audio.testBtn">${t('audio.testBtn', 'Test lyd')}</span>`
  const warn = document.getElementById('test-audio-warn')
  if (warn) warn.style.display = 'none'
}

// Comprehensive diagnose: calls the unified backend `run_diagnostics`, which
// gathers system/devices/ffmpeg/disk/permissions/audio-engine/last-error and
// returns coded findings (SR-*) + a full markdown report. The modal shows the
// colour-coded findings on top and the raw report below, with a copy button so
// the user can paste it to support — the "fishing" the diagnose tool is for.
async function runAudioDiagnosis(): Promise<void> {
  const btn = document.getElementById('btn-audio-diagnose') as HTMLButtonElement | null
  if (btn) { btn.disabled = true; btn.textContent = t('audio.diagnoseRunning', 'Analyserer…') }

  try {
    const report = await window.api.runDiagnostics()

    const modal = document.getElementById('audio-diagnose-modal')
    const body  = document.getElementById('audio-diagnose-body')
    if (!modal || !body) return

    const badge = (sev: string): string =>
      sev === 'critical' ? '🔴' : sev === 'warning' ? '⚠️' : sev === 'info' ? 'ℹ️' : '✅'

    const findingsHtml = (report.findings ?? [])
      .map(f => `
        <div class="diag-finding diag-${escHtml(f.severity)}">
          <div class="diag-finding-head">${badge(f.severity)} <code>${escHtml(f.code)}</code> — <strong>${escHtml(f.title)}</strong></div>
          ${f.detail ? `<div class="diag-finding-detail">${escHtml(f.detail)}</div>` : ''}
          ${f.hint ? `<div class="diag-finding-hint">👉 ${escHtml(f.hint)}</div>` : ''}
        </div>`)
      .join('')

    const savedLine = report.savedTo
      ? `<div class="diag-saved">${t('audio.diagnoseSaved', 'Lagret til')}: <code>${escHtml(report.savedTo)}</code></div>`
      : ''

    body.innerHTML = `
      <div class="diag-findings">${findingsHtml}</div>
      <button type="button" class="btn-secondary" id="btn-diagnose-copy" style="margin:8px 0">${t('audio.diagnoseCopy', '📋 Kopier full rapport')}</button>
      ${savedLine}
      <details style="margin-top:8px"><summary>${t('audio.diagnoseFull', 'Full rapport')}</summary><pre class="diag-report">${escHtml(report.markdown)}</pre></details>`

    document.getElementById('btn-diagnose-copy')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(report.markdown)
        const b = document.getElementById('btn-diagnose-copy')
        if (b) b.textContent = t('audio.diagnoseCopied', '✓ Kopiert')
      } catch { /* clipboard blocked — the report is still visible to copy by hand */ }
    })

    modal.style.display = 'flex'
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('audio.diagnose', 'Diagnose') }
  }
}

function escHtml(str: unknown): string {
  return String(str ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m))
}
