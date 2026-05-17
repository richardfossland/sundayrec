import { t, currentLang } from '../i18n'
import { settings } from '../state'
import { fmtCountdown, fmtStorageHours, fmtDate, escHtml, flashMsg } from '../helpers'
import { startVU, stopVU } from './home-vu'
import { getAudioDevices } from '../audio/capture'

let countdownTimer: ReturnType<typeof setInterval> | null = null
let fullHistory: RecordingEntry[] = []

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

  const onDeviceChange = (): void => { void checkStatus() }
  navigator.mediaDevices.addEventListener('devicechange', onDeviceChange)
  window.addEventListener('beforeunload', () =>
    navigator.mediaDevices.removeEventListener('devicechange', onDeviceChange))
}

export async function refreshHome(): Promise<void> {
  const next = await window.api.getNextRecording()
  await Promise.all([loadNextRecording(next), loadDiskSpace(), loadRecentHistory(), checkStatus(next), loadHomeInfoStrip()])
  startVU()
}

async function loadNextRecording(prefetchedNext?: { date: string } | null): Promise<void> {
  if (countdownTimer) clearInterval(countdownTimer)
  const next    = prefetchedNext !== undefined ? prefetchedNext : await window.api.getNextRecording()
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
    const parts = (r.duration || '0').split(':').map(Number)
    if (parts.length === 3)      totalSec += parts[0] * 3600 + parts[1] * 60 + parts[2]
    else if (parts.length === 2) totalSec += parts[0] * 60 + parts[1]
    else                         totalSec += parts[0]
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
  rows.forEach((r, idx) => {
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

    const aNote = document.createElement('a')
    aNote.href = '#'; aNote.className = 'hist-action'
    aNote.title = r.note ? t('history.editNote', 'Rediger notat') : t('history.addNote', 'Legg til notat')
    aNote.innerHTML = r.note
      ? '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>'
      : '<svg viewBox="0 0 20 20"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>'
    aNote.addEventListener('click', async e => {
      e.preventDefault()
      const newNote = prompt(t('history.notePlaceholder', 'Skriv notat…'), r.note ?? '')
      if (newNote === null) return
      r.note = newNote.trim() || undefined
      await window.api.updateHistoryNote(r.timestamp!, newNote.trim())
      const fileCell = tr.cells[3]
      const existing = fileCell.querySelector('.hist-note')
      if (existing) existing.remove()
      if (r.note) {
        const noteEl = Object.assign(document.createElement('div'), { className: 'hist-note', textContent: r.note })
        noteEl.style.cssText = 'font-size:11px;color:var(--text3);white-space:normal;margin-top:2px'
        fileCell.appendChild(noteEl)
      }
      aNote.title = r.note ? t('history.editNote', 'Rediger notat') : t('history.addNote', 'Legg til notat')
      aNote.innerHTML = r.note
        ? '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>'
        : '<svg viewBox="0 0 20 20"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>'
    })
    tdActions.appendChild(aNote)

    const aDel = document.createElement('a')
    aDel.href = '#'; aDel.className = 'hist-action hist-del'
    aDel.title = 'Slett oppføring'
    aDel.innerHTML = '<svg viewBox="0 0 20 20"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"/></svg>'
    aDel.addEventListener('click', async e => {
      e.preventDefault()
      await window.api.deleteHistoryEntry(r.timestamp!)
      const idx = fullHistory.findIndex(h => h.timestamp === r.timestamp)
      if (idx >= 0) fullHistory.splice(idx, 1)
      tr.remove()
      if (!tbody.querySelector('tr')) renderHistoryRows(tbody, [], false)
      updateHistoryStats(fullHistory)
    })
    tdActions.appendChild(aDel)
    tdActions.style.cssText = 'white-space:nowrap;display:flex;align-items:center;gap:2px'

    const cells = [r.date ? fmtDate(r.date) : '—', r.startTime ?? '—', r.duration ?? '—', r.filename ?? '—']
    cells.forEach((text, i) => {
      const td = document.createElement('td')
      td.textContent = text
      if (i === 3) {
        if (r.path) td.title = r.path
        if (r.note) {
          const noteEl = Object.assign(document.createElement('div'), { className: 'hist-note', textContent: r.note })
          noteEl.style.cssText = 'font-size:11px;color:var(--text3);white-space:normal;margin-top:2px'
          td.appendChild(noteEl)
        }
      }
      tr.appendChild(td)
    })
    tr.appendChild(tdStatus); tr.appendChild(tdActions)
    tbody.appendChild(tr)
  })
}

async function checkStatus(prefetchedNext?: { date: string } | null): Promise<void> {
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
  if (lbl) {
    if (isRec) {
      lbl.textContent = t('status.recording', 'Tar opp nå')
    } else if (!connected) {
      lbl.textContent = t('status.warning', 'Lydkilde mangler')
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
