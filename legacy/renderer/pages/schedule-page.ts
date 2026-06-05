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
  // How-it-works dismissible card — once dismissed, hidden for this session
  document.getElementById('btn-schedule-howto-dismiss')?.addEventListener('click', e => {
    e.preventDefault()
    const card = document.getElementById('schedule-howto-card')
    if (card) card.style.display = 'none'
    try { localStorage.setItem('sundayrec.scheduleHowtoDismissed', '1') } catch { /* ignore */ }
  })
  try {
    if (localStorage.getItem('sundayrec.scheduleHowtoDismissed') === '1') {
      const card = document.getElementById('schedule-howto-card')
      if (card) card.style.display = 'none'
    }
  } catch { /* ignore */ }

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

  // Avanserte innstillinger — collapsible toggle. Had no click handler at all,
  // which is why the section was empty and unresponsive when clicked.
  document.getElementById('btn-adv-toggle')?.addEventListener('click', () => {
    const btn     = document.getElementById('btn-adv-toggle')
    const section = document.getElementById('adv-section')
    const chevron = document.getElementById('adv-chevron')
    if (!section) return
    const isOpen = section.style.display !== 'none'
    section.style.display = isOpen ? 'none' : 'block'
    if (btn)     btn.setAttribute('aria-expanded', String(!isOpen))
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)'
  })

  document.getElementById('opt-wake')?.addEventListener('change', function (this: HTMLInputElement) {
    setWakeDetailsVisible(this.checked)
    if (this.checked) {
      void loadSleepConfig()
      void refreshWakeReliability()
    } else {
      const card = document.getElementById('wake-reliability-card')
      if (card) card.style.display = 'none'
    }
    // Auto-lagre toggelen umiddelbart (samme mønster som lyd/fil/video-sidene):
    // brukeren skulle ikke måtte klikke «Lagre» for at valget tar effekt.
    void saveScheduleSettings()
  })
  // wake-hibernate-* collapsible was removed when the Avanserte-section was
  // restructured into "Vekk maskin fra dvale" in v4.31. Handler dropped.
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

  // ── Wake-reliability card wiring ──────────────────────────────────────────
  document.getElementById('btn-wake-verify-refresh')?.addEventListener('click', () => {
    void refreshWakeReliability()
  })
  document.getElementById('btn-wake-standby-fix')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-wake-standby-fix') as HTMLButtonElement | null
    if (btn) { btn.disabled = true; btn.textContent = t('schedule.sleepFixing', 'Fikser…') }
    try {
      const result = await window.api.fixMacSleep()
      if (result.ok) {
        await refreshWakeReliability()
      }
    } catch { /* ignore */ }
    finally {
      if (btn) { btn.disabled = false; btn.textContent = t('wake.standby.fix', 'Slå av dyp dvale') }
    }
  })
  document.getElementById('btn-test-wake')?.addEventListener('click', () => { void onTestWakeClick() })
  document.getElementById('btn-cancel-test-wake')?.addEventListener('click', async () => {
    await window.api.wakeCancelTest()
  })

  const cleanupProgress = window.api.on('test-wake-progress', (...args: unknown[]) => {
    const data = args[0] as { phase?: string; message?: string }
    const progEl = document.getElementById('wake-test-progress')
    if (!progEl) return
    progEl.style.display = 'block'
    progEl.textContent = data.message ?? data.phase ?? ''
  })
  window.addEventListener('beforeunload', () => cleanupProgress?.())
}

// ── Wake-reliability helpers ────────────────────────────────────────────────

function platformLabel(key: string): string {
  // Use t() so labels follow current language. Fallbacks preserve Norwegian
  // wording for the legacy build where translations haven't loaded yet.
  switch (key) {
    case 'mac-arm':   return t('schedule.platformMacArm',   'Apple Silicon-Mac (M-serie) — kan vekkes fra dvale, ikke fra avslått')
    case 'mac-intel': return t('schedule.platformMacIntel', 'Intel Mac — kan vekkes fra dvale og avslått (krever manuell aktivering for sistnevnte)')
    case 'win':       return t('schedule.platformWin',      'Windows — kan vekkes fra dvale; oppstart fra fullstendig avslått krever BIOS-konfig')
    case 'linux':     return t('schedule.platformLinux',    'Linux — automatisk wake støttes ikke')
    default:          return t('schedule.platformOther',    'Plattform støttes ikke for automatisk wake')
  }
}

async function onTestWakeClick(): Promise<void> {
  const sure = confirm(
    t('wake.test.confirm',
      'Maskinen vil sove i opptil 60 sekunder og deretter prøve å våkne av seg selv.\n\n' +
      'Lukk uferdig arbeid først. Fortsette?')
  )
  if (!sure) return
  const testBtn   = document.getElementById('btn-test-wake')         as HTMLButtonElement | null
  const cancelBtn = document.getElementById('btn-cancel-test-wake')  as HTMLButtonElement | null
  if (testBtn)   testBtn.disabled = true
  if (cancelBtn) cancelBtn.style.display = ''
  try {
    const result = await window.api.wakeTest(60)
    const progEl = document.getElementById('wake-test-progress')
    if (progEl) {
      if (result.ok) {
        progEl.textContent = `${t('wake.test.success', '✓ Vekket')} — ${t('wake.test.delay', 'forsinkelse')} ${result.deltaSec}s`
      } else if (result.reason === 'cancelled') {
        progEl.textContent = t('wake.test.cancelled', 'Avbrutt.')
      } else {
        progEl.textContent = `${t('wake.test.failure', '✕ Test feilet')}: ${result.reason ?? 'ukjent'}`
      }
    }
    await refreshWakeReliability()
  } finally {
    if (testBtn)   testBtn.disabled = false
    if (cancelBtn) cancelBtn.style.display = 'none'
  }
}

async function refreshWakeReliability(): Promise<void> {
  const card = document.getElementById('wake-reliability-card')
  if (!card) return
  try {
    const caps = await window.api.wakeDetectCapabilities()
    const status = await window.api.wakeVerifyScheduled()

    // Capability summary
    const capText = document.getElementById('wake-capability-text')
    if (capText) capText.textContent = platformLabel(caps.platform) || caps.platform
    const issuesEl = document.getElementById('wake-capability-issues')
    if (issuesEl) {
      if (caps.knownIssues.length > 0) {
        issuesEl.innerHTML = caps.knownIssues.map(i => `<li>${escHtml(i)}</li>`).join('')
        issuesEl.style.display = 'block'
      } else {
        issuesEl.style.display = 'none'
      }
    }

    // Power source
    const powerDot  = document.getElementById('wake-power-dot')
    const powerText = document.getElementById('wake-power-text')
    if (powerDot && powerText) {
      if (status.onBattery === true) {
        powerDot.className  = 'wake-status-dot error'
        powerText.textContent = t('wake.power.onBattery', 'På batteri — wake vil sannsynligvis ikke fungere.')
      } else if (status.onBattery === false) {
        powerDot.className  = 'wake-status-dot ok'
        powerText.textContent = t('wake.power.onAc', 'Tilkoblet strøm — OK.')
      } else {
        powerDot.className  = 'wake-status-dot off'
        powerText.textContent = t('wake.power.unknown', 'Kunne ikke avgjøre strømkilde.')
      }
    }

    // Standby (macOS-only)
    const standbyRow  = document.getElementById('wake-standby-row')
    const standbyDot  = document.getElementById('wake-standby-dot')
    const standbyText = document.getElementById('wake-standby-text')
    const standbyBtn  = document.getElementById('btn-wake-standby-fix')
    if (standbyRow && standbyDot && standbyText && standbyBtn) {
      if (status.standbyEnabled === true) {
        standbyRow.style.display = ''
        standbyDot.className = 'wake-status-dot error'
        standbyText.textContent = t('wake.standby.warning', 'Standby (dyp dvale) er aktivert — kan sabotere wake på Apple Silicon.')
        standbyBtn.style.display = ''
      } else if (status.standbyEnabled === false) {
        standbyRow.style.display = ''
        standbyDot.className = 'wake-status-dot ok'
        standbyText.textContent = t('wake.standby.ok', 'Standby er deaktivert — OK.')
        standbyBtn.style.display = 'none'
      } else {
        standbyRow.style.display = 'none'
      }
    }

    // Observed vs expected wakes
    const verifyDot  = document.getElementById('wake-verify-dot')
    const verifyText = document.getElementById('wake-verify-text')
    if (verifyDot && verifyText) {
      const exp = status.expectedWakes.length
      const obs = status.observedWakes.length
      if (exp === 0) {
        verifyDot.className = 'wake-status-dot off'
        verifyText.textContent = t('wake.verify.none', 'Ingen wake-jobber forventet — du har ingen kommende opptak.')
      } else if (!status.hasMismatch) {
        verifyDot.className = 'wake-status-dot ok'
        verifyText.textContent = `${obs}/${exp} ${t('wake.verify.confirmed', 'bekreftet i OS')}.`
      } else {
        verifyDot.className = 'wake-status-dot error'
        verifyText.textContent = `${obs}/${exp} ${t('wake.verify.mismatch', 'bekreftet i OS — noen mangler. Klikk «Planlegg oppvåkning» for å sette dem på nytt.')}`
      }
    }

    // Platform-specific note
    const noteEl = document.getElementById('wake-platform-note')
    if (noteEl) {
      const note = caps.recommendations.join(' ')
      if (note) {
        noteEl.textContent = note
        noteEl.style.display = ''
      } else {
        noteEl.style.display = 'none'
      }
    }

    // Last test-wake
    const history = await window.api.wakeFailureHistory()
    const lastTest = history.find(e => e.kind === 'test_ok' || e.kind === 'test_fail')
    const lastDot  = document.getElementById('wake-last-test-dot')
    const lastText = document.getElementById('wake-last-test-text')
    if (lastDot && lastText) {
      if (lastTest) {
        const when = new Date(lastTest.timestamp).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
        if (lastTest.kind === 'test_ok') {
          lastDot.className = 'wake-status-dot ok'
          lastText.textContent = `${t('wake.lastTest.ok', 'Siste test OK')} (${when}, ${t('wake.test.delay', 'forsinkelse')} ${lastTest.deltaSec}s)`
        } else {
          lastDot.className = 'wake-status-dot error'
          lastText.textContent = `${t('wake.lastTest.fail', 'Siste test feilet')} (${when}, ${lastTest.reason ?? '?'})`
        }
      } else {
        lastDot.className = 'wake-status-dot off'
        lastText.textContent = t('wake.lastTest.none', 'Ikke testet ennå.')
      }
    }

    card.style.display = ''
  } catch (err) {
    console.error('[wake-reliability] refresh failed:', err)
  }
}

export function applyScheduleSettingsToUI(): void {
  // OPPGAVE 5 preview is updated inside renderSlotsList which is called at the end
  const wakeEl = document.getElementById('opt-wake') as HTMLInputElement | null
  if (wakeEl) {
    wakeEl.checked = !!settings.wakeFromSleep
    setWakeDetailsVisible(!!settings.wakeFromSleep)
    if (settings.wakeFromSleep) {
      void loadSleepConfig()
      void refreshWakeReliability()
    }
  }
  renderSlotsList()
}

async function saveScheduleSettings(): Promise<void> {
  const wakeEl = document.getElementById('opt-wake') as HTMLInputElement | null
  patchSettings({
    wakeFromSleep: wakeEl?.checked ?? false,
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
    const emptyTitle = t('schedule.noSlotsTitle', 'Ingen ukentlige opptak satt opp ennå')
    const emptyHint  = t('schedule.noSlotsHint',  'Klikk «Legg til tidspunkt» nedenfor for å starte et fast ukentlig opptak — f.eks. søndag kl. 11.')
    list.innerHTML = `<div style="color:var(--text3);font-size:13px;padding:10px 0;line-height:1.5">
      <div style="font-weight:600;color:var(--text2);margin-bottom:3px">📅 ${escHtml(emptyTitle)}</div>
      <div>${escHtml(emptyHint)}</div>
    </div>`
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
