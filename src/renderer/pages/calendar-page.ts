import { t, tArr, currentLang } from '../i18n'
import { settings, patchSettings } from '../state'
import { escHtml, isoDate, flashMsg } from '../helpers'
import { getChurchHolidays } from '../../shared/church-calendar'

let calYear       = new Date().getFullYear()
let calMonth      = new Date().getMonth()
let calSelectedIso: string | null = null
let lastStart     = '11:00'
let lastStop      = '12:00'
let editingIndex  = -1

export function setupCalendarPage(): void {
  document.getElementById('btn-today')?.addEventListener('click', () => {
    const now = new Date(); calYear = now.getFullYear(); calMonth = now.getMonth()
    calCloseDayPanel(); renderCalendar()
  })
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    calMonth--; if (calMonth < 0) { calMonth = 11; calYear-- }
    clearSelectionIfOutOfMonth(); renderCalendar()
  })
  document.getElementById('cal-next')?.addEventListener('click', () => {
    calMonth++; if (calMonth > 11) { calMonth = 0; calYear++ }
    clearSelectionIfOutOfMonth(); renderCalendar()
  })
  document.getElementById('btn-autofill')?.addEventListener('click', async () => {
    const h = getChurchHolidays(calYear)
    if (!settings.specialRecordings) settings.specialRecordings = []
    const existing = new Set(settings.specialRecordings.map(s => s.date))
    Object.entries(h).forEach(([date, name]) => {
      if (!existing.has(date)) settings.specialRecordings!.push({ date, name, start: '11:00', stop: '12:00' })
    })
    await window.api.saveSettings(settings)
    renderCalendar()
  })
  document.getElementById('btn-add-special')?.addEventListener('click', saveSpecial)
}

function clearSelectionIfOutOfMonth(): void {
  if (!calSelectedIso) return
  const selMonth = +calSelectedIso.slice(5, 7) - 1
  const selYear  = +calSelectedIso.slice(0, 4)
  if (selYear !== calYear || selMonth !== calMonth) calCloseDayPanel()
}

export function renderCalendar(): void {
  const months   = tArr('calendar.months', ['January','February','March','April','May','June','July','August','September','October','November','December'])
  const weekdays = tArr('calendar.weekdays', ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'])
  const lbl      = document.getElementById('cal-month-label')
  if (lbl) lbl.textContent = `${months[calMonth]} ${calYear}`
  const wd = document.getElementById('cal-weekdays')
  if (wd) wd.innerHTML = weekdays.map(d => `<span>${escHtml(d)}</span>`).join('')

  const grid = document.getElementById('cal-grid')
  if (!grid) return

  const first     = new Date(calYear, calMonth, 1)
  const startOff  = (first.getDay() + 6) % 7
  const daysInMon = new Date(calYear, calMonth + 1, 0).getDate()
  const todayIso  = isoDate(new Date())
  const holidays  = getChurchHolidays(calYear)
  const specials  = settings.specialRecordings ?? []
  const weeklySet = new Set((settings.slots ?? []).flatMap(s => s.days))

  let html = ''
  for (let i = 0; i < startOff; i++) html += '<div class="cal-day other-month"></div>'

  for (let d = 1; d <= daysInMon; d++) {
    const date       = new Date(calYear, calMonth, d)
    const iso        = isoDate(date)
    const dow        = (date.getDay() + 6) % 7
    const daySpec    = specials.filter(s => s.date === iso)
    const isHoliday  = !!holidays[iso]
    const isWeekly   = weeklySet.has(dow)
    const isToday    = iso === todayIso
    const isPast     = iso < todayIso
    const isSelected = iso === calSelectedIso

    let chips = ''
    if (isHoliday)  chips += `<div class="cal-chip chip-holiday">${escHtml(holidays[iso])}</div>`
    if (isWeekly && !daySpec.length) chips += `<div class="cal-chip chip-weekly">Ukentlig</div>`
    daySpec.forEach(s => chips += `<div class="cal-chip chip-special">${escHtml(s.name)}</div>`)

    const cls = ['cal-day', isToday?'today':'', isPast?'past':'', isSelected?'selected':'', isHoliday?'is-holiday':''].filter(Boolean).join(' ')
    html += `<div class="${cls}" data-iso="${iso}" data-holiday="${escHtml(holidays[iso]??'')}">
      <div class="cal-day-num">${d}</div>
      <div class="cal-chips">${chips}</div>
    </div>`
  }
  grid.innerHTML = html
  grid.querySelectorAll('.cal-day:not(.other-month)').forEach(cell => {
    cell.addEventListener('click', () => {
      calSelectedIso = (cell as HTMLElement).dataset.iso!
      grid.querySelectorAll('.cal-day.selected').forEach(c => c.classList.remove('selected'))
      cell.classList.add('selected')
      openDayDetail((cell as HTMLElement).dataset.iso!, (cell as HTMLElement).dataset.holiday ?? '')
    })
  })

  const yearSpan = document.getElementById('autofill-year')
  if (yearSpan) yearSpan.textContent = String(calYear)
  renderPlannedList()
}

function openDayDetail(iso: string, holiday: string): void {
  const detailCard = document.getElementById('cal-day-detail')
  const hintCard   = document.getElementById('cal-hint-card')
  const titleEl    = document.getElementById('cal-day-detail-title')
  const eventsEl   = document.getElementById('cal-day-events')
  const nameEl     = document.getElementById('special-name') as HTMLInputElement | null
  const dateEl     = document.getElementById('special-date') as HTMLInputElement | null
  const startEl    = document.getElementById('special-start') as HTMLInputElement | null
  const stopEl     = document.getElementById('special-stop')  as HTMLInputElement | null
  const addBtn     = document.getElementById('btn-add-special')

  if (detailCard) detailCard.style.display = 'block'
  if (hintCard)   hintCard.style.display   = 'none'

  const d = new Date(iso + 'T12:00:00')
  const locale = currentLang === 'no' ? 'nb-NO' : currentLang
  if (titleEl) titleEl.textContent = d.toLocaleDateString(locale, { weekday:'long', day:'numeric', month:'long' })
  if (dateEl)  dateEl.value = iso

  editingIndex = -1
  if (addBtn) addBtn.textContent = '+ ' + t('calendar.addRecording', 'Legg til opptak')
  if (nameEl) nameEl.value  = holiday || ''
  if (startEl) startEl.value = lastStart
  if (stopEl)  stopEl.value  = lastStop

  if (eventsEl) {
    const daySpec = (settings.specialRecordings ?? []).filter(s => s.date === iso)
    if (!daySpec.length) {
      eventsEl.innerHTML = '<div style="color:var(--text3);font-size:12px;margin-bottom:8px">Ingen opptak planlagt</div>'
    } else {
      eventsEl.innerHTML = daySpec.map(s => {
        const idx = (settings.specialRecordings ?? []).indexOf(s)
        return `<div class="cal-event-item">
          <span class="cal-event-name">${escHtml(s.name)}</span>
          <span class="cal-event-time">${escHtml(s.start)}–${escHtml(s.stop)}</span>
          <span class="cal-event-edit" data-index="${idx}">✎</span>
          <span class="cal-event-del"  data-index="${idx}">×</span>
        </div>`
      }).join('')
      eventsEl.querySelectorAll('.cal-event-edit').forEach(btn => {
        btn.addEventListener('click', () => {
          const s = settings.specialRecordings?.[+(btn as HTMLElement).dataset.index!]
          if (!s) return
          editingIndex = +(btn as HTMLElement).dataset.index!
          if (nameEl)  nameEl.value  = s.name
          if (startEl) startEl.value = s.start
          if (stopEl)  stopEl.value  = s.stop
          if (addBtn) addBtn.textContent = t('calendar.updateRecording', 'Oppdater opptak')
        })
      })
      eventsEl.querySelectorAll('.cal-event-del').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (editingIndex === +(btn as HTMLElement).dataset.index!) {
            editingIndex = -1
            if (addBtn) addBtn.textContent = '+ ' + t('calendar.addRecording', 'Legg til opptak')
          }
          settings.specialRecordings!.splice(+(btn as HTMLElement).dataset.index!, 1)
          await window.api.saveSettings(settings)
          renderCalendar(); openDayDetail(iso, holiday)
        })
      })
    }
  }
}

function calCloseDayPanel(): void {
  calSelectedIso = null; editingIndex = -1
  const dc = document.getElementById('cal-day-detail')
  const hc = document.getElementById('cal-hint-card')
  if (dc) dc.style.display = 'none'
  if (hc) hc.style.display = 'block'
}

async function saveSpecial(): Promise<void> {
  const dateEl  = document.getElementById('special-date')  as HTMLInputElement | null
  const nameEl  = document.getElementById('special-name')  as HTMLInputElement | null
  const startEl = document.getElementById('special-start') as HTMLInputElement | null
  const stopEl  = document.getElementById('special-stop')  as HTMLInputElement | null
  const date  = dateEl?.value
  const name  = nameEl?.value.trim() || 'Gudstjeneste'
  const start = startEl?.value || '11:00'
  const stop  = stopEl?.value  || '12:00'
  if (!date) { flashMsg(document.getElementById('btn-add-special'), '✕ ' + t('calendar.errNoDate', 'Velg en dato først'), false); return }
  if (!settings.specialRecordings) settings.specialRecordings = []
  lastStart = start; lastStop = stop

  if (editingIndex >= 0) {
    settings.specialRecordings[editingIndex] = { date, name, start, stop }
    editingIndex = -1
    const addBtn = document.getElementById('btn-add-special')
    if (addBtn) addBtn.textContent = '+ ' + t('calendar.addRecording', 'Legg til opptak')
  } else {
    const exists = settings.specialRecordings.some(s => s.date === date && s.name === name)
    if (!exists) settings.specialRecordings.push({ date, name, start, stop })
  }

  if (nameEl) nameEl.value = ''
  await window.api.saveSettings(settings)
  renderCalendar()
  const holiday = getChurchHolidays(new Date(date + 'T12:00:00').getFullYear())[date] ?? ''
  openDayDetail(date, holiday)
}

export function renderPlannedList(): void {
  const list = document.getElementById('planned-list')
  if (!list) return
  const today = isoDate(new Date())
  const sp    = (settings.specialRecordings ?? [])
    .filter(s => s.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!sp.length) {
    list.innerHTML = `<div style="color:var(--text3);font-size:13px">${t('calendar.noPlanned')}</div>`
    return
  }
  const locale = currentLang === 'no' ? 'nb-NO' : currentLang
  list.innerHTML = sp.map(s => {
    const gIdx    = (settings.specialRecordings ?? []).indexOf(s)
    const dateStr = new Date(s.date + 'T12:00:00').toLocaleDateString(locale, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    })
    return `<div class="planned-item">
      <div class="planned-body">
        <div class="planned-name">${escHtml(s.name)}</div>
        <div class="planned-date">${escHtml(dateStr)} · ${escHtml(s.start)}–${escHtml(s.stop)}</div>
      </div>
      <span class="planned-del" data-index="${gIdx}">×</span>
    </div>`
  }).join('')
  list.querySelectorAll('.planned-del').forEach(btn =>
    btn.addEventListener('click', async () => {
      settings.specialRecordings!.splice(+(btn as HTMLElement).dataset.index!, 1)
      await window.api.saveSettings(settings)
      renderCalendar()
    })
  )
}
