import { t, currentLang } from '../i18n'
import { settings } from '../state'
import { fmtCountdown, fmtStorageHours, fmtDate, escHtml, flashMsg } from '../helpers'
import { startVU, stopVU } from './home-vu'
import { getAudioDevices } from '../audio/capture'

let countdownTimer: ReturnType<typeof setInterval> | null = null

export function setupHome(): void {
  document.getElementById('btn-go-audio-page')?.addEventListener('click', e => { e.preventDefault(); window.showPage('audio') })
  document.getElementById('btn-go-audio-fmt')?.addEventListener('click',  e => { e.preventDefault(); window.showPage('files') })
  document.getElementById('btn-go-general-page')?.addEventListener('click', e => { e.preventDefault(); window.showPage('general') })
  document.getElementById('btn-how-to-fix')?.addEventListener('click', () => window.showPage('audio'))

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
    renderHistoryRows(document.getElementById('history-tbody'), [], false)
  })
}

export async function refreshHome(): Promise<void> {
  await Promise.all([loadNextRecording(), loadDiskSpace(), loadRecentHistory(), checkStatus(), loadHomeInfoStrip()])
  startVU()
}

async function loadNextRecording(): Promise<void> {
  if (countdownTimer) clearInterval(countdownTimer)
  const next    = await window.api.getNextRecording()
  const dateEl  = document.getElementById('next-date')
  const cntEl   = document.getElementById('next-countdown')
  const titleEl = document.getElementById('hero-ready-title')

  if (!next) {
    if (dateEl)  dateEl.textContent  = '—'
    if (cntEl)   cntEl.textContent   = ''
    if (titleEl) titleEl.textContent = t('home.readyTitle', 'Alt er klart')
    return
  }

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
    if (storageVal) storageVal.textContent = '—'
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
  if (storageVal) storageVal.textContent = `${gb.toFixed(1)} GB ${t('home.storageFree', 'ledig')}`
  if (storageSub) storageSub.textContent = `${folderShort} · ca. ${recEst}`

  const diskMetaEl = document.getElementById('rec-disk')
  if (diskMetaEl) diskMetaEl.textContent = `${gb.toFixed(0)} GB`
}

export async function loadRecentHistory(): Promise<void> {
  const history = await window.api.getHistory()
  renderHistoryRows(document.getElementById('history-tbody'), (history ?? []) as RecordingEntry[], true)
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
  rows.forEach(r => {
    const tr = document.createElement('tr')
    const badgeCls = r.status === 'ok' || r.status === 'complete' ? 'ok' : r.status === 'error' ? 'error' : 'sched'
    const badge    = Object.assign(document.createElement('span'), { className: `badge badge-${badgeCls}`, textContent: t(`history.${r.status}`, r.status) })
    const tdStatus = document.createElement('td'); tdStatus.appendChild(badge)
    const tdActions = document.createElement('td'); tdActions.style.cssText = 'white-space:nowrap'

    if (showReveal && r.path) {
      const aReveal = Object.assign(document.createElement('a'), { href: '#', className: 'slot-edit', textContent: '↗' })
      aReveal.style.marginRight = '10px'
      aReveal.addEventListener('click', e => { e.preventDefault(); window.api.revealFile(r.path!) })
      tdActions.appendChild(aReveal)
    }

    const aDel = Object.assign(document.createElement('a'), { href: '#', className: 'slot-edit', textContent: '✕' })
    aDel.style.color = 'var(--text3)'
    aDel.addEventListener('click', async e => {
      e.preventDefault()
      await window.api.deleteHistoryEntry(r.timestamp!)
      tr.remove()
      if (!tbody.querySelector('tr')) renderHistoryRows(tbody, [], false)
    })
    tdActions.appendChild(aDel)

    const cells = [r.date ? fmtDate(r.date) : '—', r.startTime ?? '—', r.duration ?? '—', r.filename ?? '—']
    cells.forEach(text => {
      const td = document.createElement('td'); td.textContent = text; tr.appendChild(td)
    })
    tr.appendChild(tdStatus); tr.appendChild(tdActions)
    tbody.appendChild(tr)
  })
}

async function checkStatus(): Promise<void> {
  const devices   = await getAudioDevices()
  const connected = !settings.deviceId || devices.some(d => d.deviceId === settings.deviceId)
  const isRec     = window.__isRecording ?? false

  const heroOk   = document.getElementById('hero-ok')
  const heroWarn = document.getElementById('hero-warn')
  if (heroOk)   heroOk.style.display   = connected ? 'flex' : 'none'
  if (heroWarn) heroWarn.style.display = connected ? 'none' : 'flex'

  const dot = document.getElementById('status-dot')
  const lbl = document.getElementById('status-label')
  if (dot) dot.className = 'status-dot' + (isRec ? ' recording' : connected ? '' : ' warn')
  if (lbl) lbl.textContent = t(isRec ? 'status.recording' : connected ? 'status.ready' : 'status.warning')
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

// Type helpers
interface RecordingEntry { date?: string; startTime?: string; duration?: string; filename?: string; path?: string; status: string; timestamp?: number }
