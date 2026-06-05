import { settings } from '../state'
import { buildInputRouter, getAudioDevices, rVuChannel } from '../audio/capture'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'
import type { VuState } from '../audio/vu'
import { t } from '../i18n'

const vu = makeVuState()
let vuRetries = 0
const MAX_VU_RETRIES = 5

export function stopVU(): void {
  stopVuState(vu)
  const fills = ['vu-l', 'vu-r'].map(id => document.getElementById(id))
  const peaks = ['vu-peak-l', 'vu-peak-r'].map(id => document.getElementById(id))
  const dbs   = ['vu-db-l', 'vu-db-r'].map(id => document.getElementById(id))
  fills.forEach(el => { if (el) el.style.width = '100%' })
  peaks.forEach(el => { if (el) el.style.opacity = '0' })
  dbs.forEach(el   => { if (el) el.textContent = '—' })
  resetSignalStatus()
}

export function startVU(): void {
  stopVU()
  vuRetries = 0
  tryStartVU()
}

function tryStartVU(): void {
  if (!document.getElementById('vu-l')) return

  const devId = settings.deviceId && settings.deviceId !== 'default' ? settings.deviceId : null
  const devChannels = settings.deviceId ? (settings.deviceChannels?.[settings.deviceId] ?? null) : null
  const chL  = devChannels?.channelL ?? 0
  const chR  = devChannels?.channelR ?? 1
  const need = Math.max(2, chL + 1, chR + 1)

  navigator.mediaDevices.getUserMedia({
    audio: {
      ...(devId ? { deviceId: { ideal: devId } } : {}),
      channelCount:     { ideal: need },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl:  false
    },
    video: false
  })
    .then(stream => {
      vuRetries = 0
      vu.stream = stream
      vu.ctx    = new AudioContext()
      const src    = vu.ctx.createMediaStreamSource(stream)
      const routed = buildInputRouter(vu.ctx, src, stream, chL, chR)
      const split  = vu.ctx.createChannelSplitter(2)
      vu.analyserL = vu.ctx.createAnalyser(); vu.analyserL.fftSize = 1024
      vu.analyserR = vu.ctx.createAnalyser(); vu.analyserR.fftSize = 1024
      routed.connect(split)
      split.connect(vu.analyserL, 0)
      // Mirror mono → R so the R meter isn't dead on a mono mic (see rVuChannel).
      split.connect(vu.analyserR, rVuChannel(stream))

      const fillL = document.getElementById('vu-l')
      const pkL   = document.getElementById('vu-peak-l')
      const dbL   = document.getElementById('vu-db-l')
      const fillR = document.getElementById('vu-r')
      const pkR   = document.getElementById('vu-peak-r')
      const dbR   = document.getElementById('vu-db-r')
      const clipL = document.getElementById('vu-clip-l')
      const clipR = document.getElementById('vu-clip-r')

      tickVU(vu, fillL, pkL, dbL, fillR, pkR, dbR, (dbL, dbR, state) => {
        updateSignalStatus(dbL, dbR, state)
        if (clipL && state.smL > -0.5) clipL.classList.add('clip')
        if (clipR && state.smR > -0.5) clipR.classList.add('clip')
      })
    })
    .catch(() => {
      vuRetries++
      if (vuRetries < MAX_VU_RETRIES) {
        setTimeout(() => { if (!vu.stream && document.getElementById('vu-l')) tryStartVU() }, 5000)
      }
    })
}

function resetSignalStatus(): void {
  const dot  = document.getElementById('signal-dot')
  const text = document.getElementById('signal-text')
  const peak = document.getElementById('signal-peak')
  if (dot)  dot.className = 'signal-dot'
  if (text) { text.className = 'signal-text'; text.textContent = '—' }
  if (peak) peak.textContent = ''
}

function updateSignalStatus(dbL: number, dbR: number, state: VuState): void {
  const db   = Math.max(dbL, dbR)
  const dot  = document.getElementById('signal-dot')
  const text = document.getElementById('signal-text')
  const peak = document.getElementById('signal-peak')
  if (!dot || !text) return

  let cls = '', label = '—'
  if      (db >= -3)  { cls = 'klipping'; label = t('home.signalClipping', 'Klipper!') }
  else if (db >= -12) { cls = 'hoyt';     label = t('home.signalLoud',     'Høyt')     }
  else if (db >= -40) { cls = 'god';      label = t('home.signalGood',     'Bra')      }
  else if (db > -55)  { cls = 'svak';     label = t('home.signalWeak',     'Svakt')    }
  dot.className  = 'signal-dot'  + (cls ? ' ' + cls : '')
  text.className = 'signal-text' + (cls ? ' ' + cls : '')
  text.textContent = label

  const pkMax = Math.max(state.peakL, state.peakR)
  if (peak) peak.textContent = pkMax > -59 ? `Maks: ${pkMax.toFixed(1)} dBFS` : ''
}

// Click clip indicators to reset
export function setupClipReset(): void {
  ;['vu-clip-l', 'vu-clip-r', 'rec-vu-clip-l', 'rec-vu-clip-r', 'live-vu-clip-l', 'live-vu-clip-r'].forEach(id =>
    document.getElementById(id)?.addEventListener('click', () =>
      document.getElementById(id)?.classList.remove('clip'))
  )
}
