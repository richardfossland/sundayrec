import { t, tArr } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, escHtml } from '../helpers'
import type { ScheduleSlot } from '../../types'

let editingSlotIndex = -1

function updateNextRecordingPreview(): void {
  const previewEl = document.getElementById('schedule-next-preview')
  if (!previewEl) return

  const slots = settings.slots ?? []
  if (!slots.length) { previewEl.textContent = ''; return }

  const now      = new Date()
  // JS Date: Sunday=0 … Saturday=6; schedule.days is Mon=0..Sun=6
  // Build a Sun-Sat array: Sun is index 6 in schedule.days, Mon..Sat are 0..5
  const _sched = tArr('schedule.days', ['Man','Tir','Ons','Tor','Fre','Lør','Søn'])
  const dayNames = [_sched[6], _sched[0], _sched[1], _sched[2], _sched[3], _sched[4], _sched[5]]

  let nextMs   = Infinity
  let nextLabel = ''

  for (const slot of slots) {
    for (const day of (slot.days ?? [])) {
      const target  = new Date(now)
      // 0=Sun in JS Date, but schedule days are Mon=0..Sun=6
      // Convert slot day (Mon=0..Sun=6) to JS day (Sun=0..Sat=6)
      const jsDayOfSlot = (day + 1) % 7

      const [h, m] = (slot.start || '09:00').split(':').map(Number)
      const diffDays = (jsDayOfSlot - now.getDay() + 7) % 7
      const slotTodayMinutes = h * 60 + m
      const nowMinutes       = now.getHours() * 60 + now.getMinutes()

      // If the slot is today but already past (or now), push to next week
      const daysToAdd = diffDays === 0 && nowMinutes >= slotTodayMinutes ? 7 : diffDays

      target.setDate(target.getDate() + daysToAdd)
      target.setHours(h, m, 0, 0)

      if (target.getTime() < nextMs) {
        nextMs    = target.getTime()
        nextLabel = `${dayNames[target.getDay()]} ${target.getDate()}. ${t('schedule.atTime', 'kl.')} ${slot.start}`
      }
    }
  }

  previewEl.textContent = nextLabel ? `${t('schedule.nextPreviewPrefix', 'Neste opptak')}: ${nextLabel}` : ''
}

export function setupSchedulePage(): void {
  document.getElementById('btn-add-slot')?.addEventListener('click', () => openSlotEditor(-1))
  document.getElementById('btn-slot-save')?.addEventListener('click', saveSlot)
  document.getElementById('slot-start')?.addEventListener('change', () => {
    if (editingSlotIndex < 0) autoSetStopTime()
    else updateSlotDurationDisplay()
  })
  document.getElementById('slot-stop')?.addEventListener('change', updateSlotDurationDisplay)
  document.getElementById('btn-slot-cancel')?.addEventListener('click', () => {
    const editor = document.getElementById('slot-editor')
    if (editor) editor.style.display = 'none'
  })
  document.getElementById('btn-schedule-save')?.addEventListener('click', saveScheduleSettings)
  document.getElementById('opt-silence')?.addEventListener('change', function (this: HTMLInputElement) {
    const silCfg = document.getElementById('silence-config')
    if (silCfg) silCfg.style.display = this.checked ? 'block' : 'none'
  })
  document.getElementById('opt-wake')?.addEventListener('change', function (this: HTMLInputElement) {
    setWakeDetailsVisible(this.checked)
    if (this.checked) void loadSleepConfig()
  })
  document.getElementById('wake-hibernate-toggle')?.addEventListener('click', () => {
    const body    = document.getElementById('wake-hibernate-body')
    const chevron = document.getElementById('wake-hibernate-chevron')
    const open    = body?.style.display !== 'none'
    if (body)    body.style.display      = open ? 'none' : 'block'
    if (chevron) chevron.style.transform = open ? '' : 'rotate(90deg)'
  })
  document.getElementById('btn-schedule-wake')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-schedule-wake') as HTMLButtonElement | null
    if (btn) btn.disabled = true
    try {
      const result = await window.api.scheduleOsWakesAdmin()
      wakeResultToStatus(result)
    } catch (e) {
      setWakeStatus('error', 'schedule.wakeStatusError', 'Feil: ' + (e as Error).message)
    } finally {
      if (btn) btn.disabled = false
    }
  })
  document.getElementById('btn-fix-sleep')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-fix-sleep') as HTMLButtonElement | null
    if (btn) { btn.disabled = true; btn.textContent = t('schedule.sleepFixing') || 'Fikser…' }
    try {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const result = isMac
        ? await window.api.fixMacSleep()
        : await window.api.fixWinWakeTimers()
      if (result.ok) {
        setSleepConfigStatus('ok', 'schedule.sleepFixOk', 'Fikset — oppvåkning bør nå fungere')
      } else {
        const msg = result.message?.includes('cancelled')
          ? (t('schedule.sleepFixCancelled') || 'Avbrutt — godkjenn tillatelsen for å fikse')
          : result.message?.includes('admin_required')
            ? (t('schedule.sleepFixNoAdmin') || 'Krever administratorrettigheter — kjør SundayRec som administrator')
            : (t('schedule.sleepFixFail') || 'Automatisk fiks mislyktes')
        setSleepConfigStatus('error', '', msg)
      }
    } catch {
      setSleepConfigStatus('error', 'schedule.sleepFixFail', 'Automatisk fiks mislyktes')
    } finally {
      if (btn) btn.disabled = false
    }
  })

  const cleanup = window.api.on('wake-schedule-result', wakeResultToStatus)
  window.addEventListener('beforeunload', () => cleanup?.())
}

export function applyScheduleSettingsToUI(): void {
  // OPPGAVE 5 preview is updated inside renderSlotsList which is called at the end
  const wakeEl       = document.getElementById('opt-wake')             as HTMLInputElement  | null
  const protectEl    = document.getElementById('opt-protect')          as HTMLInputElement  | null
  const silenceEl    = document.getElementById('opt-silence')          as HTMLInputElement  | null
  const splitMinSel  = document.getElementById('opt-split-minutes')    as HTMLSelectElement | null
  const reminderSel  = document.getElementById('opt-reminder-minutes') as HTMLSelectElement | null
  const manualMaxSel  = document.getElementById('opt-manual-max')        as HTMLSelectElement | null
  const prerollSel    = document.getElementById('opt-preroll-seconds')   as HTMLSelectElement | null
  if (wakeEl) {
    wakeEl.checked = !!settings.wakeFromSleep
    setWakeDetailsVisible(!!settings.wakeFromSleep)
    if (settings.wakeFromSleep) void loadSleepConfig()
  }
  if (protectEl)    protectEl.checked   = settings.protectRecording !== false
  if (silenceEl) {
    silenceEl.checked = !!settings.stopOnSilence
    const silCfg = document.getElementById('silence-config')
    if (silCfg) silCfg.style.display = settings.stopOnSilence ? 'block' : 'none'
  }
  const silThreshSel = document.getElementById('opt-silence-threshold') as HTMLSelectElement | null
  const silTimeoutSel = document.getElementById('opt-silence-timeout') as HTMLSelectElement | null
  if (silThreshSel)  silThreshSel.value  = String(settings.silenceThreshold   ?? -50)
  if (silTimeoutSel) silTimeoutSel.value = String(settings.silenceTimeoutMinutes ?? 5)
  if (splitMinSel)  splitMinSel.value   = String(settings.splitMinutes   ?? 0)
  if (reminderSel)  reminderSel.value   = String(settings.reminderMinutes  ?? 0)
  if (manualMaxSel) manualMaxSel.value  = String(settings.manualMaxMinutes ?? 0)
  if (prerollSel)   prerollSel.value    = String(settings.preRollSeconds   ?? 0)
  renderSlotsList()
}

async function saveScheduleSettings(): Promise<void> {
  const wakeEl        = document.getElementById('opt-wake')              as HTMLInputElement  | null
  const protectEl     = document.getElementById('opt-protect')           as HTMLInputElement  | null
  const silenceEl     = document.getElementById('opt-silence')           as HTMLInputElement  | null
  const silThreshSel  = document.getElementById('opt-silence-threshold') as HTMLSelectElement | null
  const silTimeoutSel = document.getElementById('opt-silence-timeout')   as HTMLSelectElement | null
  const splitMinSel   = document.getElementById('opt-split-minutes')     as HTMLSelectElement | null
  const reminderSel   = document.getElementById('opt-reminder-minutes')  as HTMLSelectElement | null
  const manualMaxSel  = document.getElementById('opt-manual-max')        as HTMLSelectElement | null
  const prerollSel    = document.getElementById('opt-preroll-seconds')   as HTMLSelectElement | null
  patchSettings({
    wakeFromSleep:           wakeEl?.checked ?? false,
    protectRecording:        protectEl?.checked ?? true,
    stopOnSilence:           silenceEl?.checked ?? false,
    silenceThreshold:        parseInt(silThreshSel?.value  ?? '-50') || -50,
    silenceTimeoutMinutes:   parseInt(silTimeoutSel?.value ?? '5')   || 5,
    splitMinutes:            parseInt(splitMinSel?.value   ?? '0')   || 0,
    reminderMinutes:         parseInt(reminderSel?.value   ?? '0')   || 0,
    manualMaxMinutes:        parseInt(manualMaxSel?.value  ?? '0')   || 0,
    preRollSeconds:          parseInt(prerollSel?.value    ?? '0')   || 0,
  })
  await window.api.saveSettings(settings)
  flashSaved(document.getElementById('btn-schedule-save'))
}

export function renderDayPickers(): void {
  const days = tArr('schedule.days', ['Man','Tir','Ons','Tor','Fre','Lør','Søn'])
  const dp = document.getElementById('day-picker')
  if (!dp) return
  const sel = [...dp.querySelectorAll<HTMLElement>('.day-btn.selected')].map(b => +b.dataset.day!)
  dp.innerHTML = days.map((d, i) =>
    `<button class="day-btn${sel.includes(i) ? ' selected' : ''}" data-day="${i}">${escHtml(d)}</button>`
  ).join('')
  dp.querySelectorAll('.day-btn').forEach(btn =>
    btn.addEventListener('click', () => btn.classList.toggle('selected'))
  )
}

export function renderSlotsList(): void {
  const list = document.getElementById('slots-list')
  if (!list) return
  const slots = settings.slots ?? []
  const days  = tArr('schedule.days', ['Man','Tir','Ons','Tor','Fre','Lør','Søn'])
  if (!slots.length) {
    list.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:8px 0">${t('schedule.noSlots')}</div>`
    updateNextRecordingPreview()
    return
  }
  list.innerHTML = slots.map((s, i) => {
    const dayNames = (s.days ?? []).map(d => escHtml(days[d] ?? '?')).join(', ')
    const maxStr   = s.max ? ` · max ${s.max} min` : ''
    return `<div class="slot-row">
      <div class="slot-days">${dayNames || '—'}</div>
      <div class="slot-time">${escHtml(s.start)} – ${escHtml(s.stop)}${maxStr}</div>
      <a href="#" class="slot-edit" data-index="${i}">${escHtml(t('schedule.edit','Rediger'))}</a>
      <span class="slot-del" data-index="${i}" title="${escHtml(t('schedule.deleteSlotTitle','Slett'))}">×</span>
    </div>`
  }).join('')
  list.querySelectorAll('.slot-edit').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); openSlotEditor(+(a as HTMLElement).dataset.index!) })
  )
  list.querySelectorAll('.slot-del').forEach(s =>
    s.addEventListener('click', async () => {
      if (!confirm(t('schedule.confirmDeleteSlot', 'Slett dette tidspunktet?'))) return
      settings.slots!.splice(+(s as HTMLElement).dataset.index!, 1)
      await window.api.saveSettings(settings).catch(err => console.error('[schedule] saveSettings failed:', err))
      renderSlotsList()
    })
  )
  updateNextRecordingPreview()
}

function openSlotEditor(index: number): void {
  editingSlotIndex = index
  const slot: ScheduleSlot = index >= 0 && settings.slots?.[index]
    ? settings.slots[index]
    : { days: [6], start: '11:00', stop: '12:00' }
  const startEl = document.getElementById('slot-start') as HTMLInputElement | null
  const stopEl  = document.getElementById('slot-stop')  as HTMLInputElement | null
  const maxEl   = document.getElementById('slot-max')   as HTMLInputElement | null
  if (startEl) startEl.value = slot.start
  if (stopEl)  stopEl.value  = slot.stop
  if (maxEl)   maxEl.value   = slot.max ? String(slot.max) : ''
  const dp = document.getElementById('day-picker')
  if (dp) dp.querySelectorAll<HTMLElement>('.day-btn').forEach(btn =>
    btn.classList.toggle('selected', (slot.days ?? []).includes(+btn.dataset.day!))
  )
  const editor = document.getElementById('slot-editor')
  if (editor) editor.style.display = 'block'
  updateSlotDurationDisplay()
}

async function saveSlot(): Promise<void> {
  const days  = [...document.querySelectorAll<HTMLElement>('#day-picker .day-btn.selected')].map(b => +b.dataset.day!)
  const start = (document.getElementById('slot-start') as HTMLInputElement | null)?.value ?? ''
  const stop  = (document.getElementById('slot-stop')  as HTMLInputElement | null)?.value ?? ''
  const maxEl = document.getElementById('slot-max') as HTMLInputElement | null
  const maxV  = maxEl ? (+maxEl.value || null) : null
  if (!days.length) { alert(t('schedule.errNoDays')); return }
  // Strict HH:MM validation — a keyboard-injection or unusual locale could
  // produce something like "9.30" that scheduler.ts later defaults to 11:00.
  const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/
  if (!start || !stop || !HHMM.test(start) || !HHMM.test(stop)) {
    alert(t('schedule.errTimes')); return
  }
  if (start === stop) { alert(t('schedule.errTimes')); return }
  const slot: ScheduleSlot = { days, start, stop, ...(maxV ? { max: maxV } : {}) }
  if (!settings.slots) settings.slots = []
  if (editingSlotIndex >= 0) settings.slots[editingSlotIndex] = slot
  else settings.slots.push(slot)
  const editor = document.getElementById('slot-editor')
  if (editor) editor.style.display = 'none'
  await window.api.saveSettings(settings)
  renderSlotsList()
  updateNextRecordingPreview()
}

function autoSetStopTime(): void {
  const startEl = document.getElementById('slot-start') as HTMLInputElement | null
  const stopEl  = document.getElementById('slot-stop')  as HTMLInputElement | null
  if (!startEl || !stopEl || !startEl.value) return
  const [sh, sm] = startEl.value.split(':').map(Number)
  const total = sh * 60 + sm + 60
  const h = Math.floor(total / 60) % 24
  const m = total % 60
  stopEl.value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  updateSlotDurationDisplay()
}

function updateSlotDurationDisplay(): void {
  const startEl = document.getElementById('slot-start') as HTMLInputElement | null
  const stopEl  = document.getElementById('slot-stop')  as HTMLInputElement | null
  const durEl   = document.getElementById('slot-duration-display')
  if (!startEl || !stopEl || !durEl || !startEl.value || !stopEl.value) {
    if (durEl) durEl.style.display = 'none'
    return
  }
  const [sh, sm] = startEl.value.split(':').map(Number)
  const [eh, em] = stopEl.value.split(':').map(Number)
  const startMin = sh * 60 + sm
  const stopMin  = eh * 60 + em
  const minutes  = stopMin > startMin ? stopMin - startMin : 1440 - startMin + stopMin
  const crossesMidnight = stopMin <= startMin
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const hAbbr = t('schedule.hourAbbr', 't')
  const dur = h > 0 && m > 0 ? `${h} ${hAbbr} ${m} min` : h > 0 ? `${h} ${hAbbr}` : `${m} min`
  const warn = minutes > 240 || crossesMidnight
  const checkSuffix = ` — ${t('schedule.checkTimes', 'sjekk tidspunktene')}`
  durEl.textContent = crossesMidnight
    ? `${t('schedule.crossesMidnight', 'Krysser midnatt')} — ${dur}${checkSuffix}`
    : `${t('schedule.durationPrefix', 'Varighet')}: ${dur}${warn ? checkSuffix : ''}`
  durEl.style.display = 'block'
  durEl.style.color = warn ? 'var(--red, #f87171)' : 'var(--text3)'
}

function setWakeDetailsVisible(visible: boolean): void {
  const details = document.getElementById('wake-details')
  if (details) details.style.display = visible ? 'block' : 'none'
}

function setWakeStatus(cls: string, key: string, fallback: string, count?: number, nextWake?: string | null): void {
  const dot = document.getElementById('wake-status-dot')
  const txt = document.getElementById('wake-status-text')
  if (!dot || !txt) return
  dot.className = `wake-status-dot ${cls}`
  let text = t(key) || fallback
  if (count != null) text = text.replace('{n}', String(count))
  if (nextWake) {
    const d = new Date(nextWake)
    const dateStr = d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    text += ` — ${dateStr}`
  }
  txt.textContent = text
}

function wakeResultToStatus(result: unknown): void {
  const r = result as { ok: boolean; count?: number; reason?: string; nextWake?: string | null } | null
  if (!r) return
  if (r.ok && (r.count ?? 0) > 0)    setWakeStatus('ok',    'schedule.wakeStatusOk',          `${r.count} oppvåkning planlagt`, r.count, r.nextWake)
  else if (r.ok)                      setWakeStatus('ok',    'schedule.wakeStatusNone',         'Ingen kommende opptak')
  else if (r.reason === 'disabled')   setWakeStatus('off',   'schedule.wakeStatusOff',          'Oppvåkning er slått av')
  else if (r.reason === 'cancelled')  setWakeStatus('error', 'schedule.wakeStatusCancelled',    'Avvist — prøv igjen og godkjenn')
  else if (r.reason === 'permission') setWakeStatus('error', 'schedule.wakeStatusPermission',   'Mangler tillatelse — klikk Planlegg og godkjenn')
  else if (r.reason === 'unsupported')setWakeStatus('off',   'schedule.wakeStatusUnsupported',  'Ikke støttet på denne plattformen')
  else                                setWakeStatus('error', 'schedule.wakeStatusError',         'Feil ved planlegging')
}

function setSleepConfigStatus(cls: string, key: string, fallback: string, showFix = false): void {
  const loading = document.getElementById('sleep-config-loading')
  const result  = document.getElementById('sleep-config-result')
  const dot     = document.getElementById('sleep-config-dot')
  const txt     = document.getElementById('sleep-config-text')
  const fixBtn  = document.getElementById('btn-fix-sleep')
  if (loading) loading.style.display = 'none'
  if (result)  result.style.display  = 'block'
  if (dot)     dot.className = `wake-status-dot ${cls}`
  if (txt)     txt.textContent = t(key) || fallback
  if (fixBtn)  fixBtn.style.display = showFix ? '' : 'none'
}

async function loadSleepConfig(): Promise<void> {
  const loading = document.getElementById('sleep-config-loading')
  const result  = document.getElementById('sleep-config-result')
  if (loading) loading.style.display = 'block'
  if (result)  result.style.display  = 'none'

  try {
    const cfg = await window.api.getSleepConfig() as {
      platform: string
      autopoweroff?: boolean
      autopoweroffDelay?: number
      standby?: boolean
      standbyDelay?: number
      hibernateMode?: number
      wakeTimersEnabled?: boolean
      error?: string
    }

    if (cfg.platform === 'darwin') {
      if (cfg.error) {
        setSleepConfigStatus('error', 'schedule.sleepStatusUnknown', 'Kunne ikke lese dvaleinnstillinger')
        return
      }
      const isRisky = cfg.autopoweroff === true || (cfg.standby === true && (cfg.standbyDelay ?? 86400) < 3600)
      if (isRisky) {
        setSleepConfigStatus('error', 'schedule.sleepStatusMacWarn', 'Autopoweroff kan hindre oppvåkning — klikk Fiks', true)
      } else {
        setSleepConfigStatus('ok', 'schedule.sleepStatusOk', 'Dvaleinnstillinger er OK — oppvåkning fungerer')
      }
    } else if (cfg.platform === 'win32') {
      if (cfg.error) {
        setSleepConfigStatus('error', 'schedule.sleepStatusUnknown', 'Kunne ikke lese dvaleinnstillinger')
        return
      }
      if (cfg.wakeTimersEnabled === false) {
        setSleepConfigStatus('error', 'schedule.sleepStatusWinWarn', 'Vekketimer er ikke aktivert — klikk Fiks', true)
      } else if (cfg.wakeTimersEnabled === true) {
        setSleepConfigStatus('ok', 'schedule.sleepStatusOk', 'Dvaleinnstillinger er OK — oppvåkning fungerer')
      } else {
        setSleepConfigStatus('off', 'schedule.sleepStatusUnknown', 'Kunne ikke lese dvaleinnstillinger')
      }
    } else {
      setSleepConfigStatus('off', 'schedule.sleepStatusUnsupported', 'Ikke støttet på denne plattformen')
    }
  } catch {
    setSleepConfigStatus('error', 'schedule.sleepStatusUnknown', 'Kunne ikke lese dvaleinnstillinger')
  }
}
