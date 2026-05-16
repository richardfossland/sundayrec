import { t, tArr } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, escHtml } from '../helpers'
import type { ScheduleSlot } from '../../types'

let editingSlotIndex = -1

export function setupSchedulePage(): void {
  document.getElementById('btn-add-slot')?.addEventListener('click', () => openSlotEditor(-1))
  document.getElementById('btn-slot-save')?.addEventListener('click', saveSlot)
  document.getElementById('btn-slot-cancel')?.addEventListener('click', () => {
    const editor = document.getElementById('slot-editor')
    if (editor) editor.style.display = 'none'
  })
  document.getElementById('btn-schedule-save')?.addEventListener('click', saveScheduleSettings)
  document.getElementById('opt-wake')?.addEventListener('change', function (this: HTMLInputElement) {
    const wakeRow     = document.getElementById('wake-status-row')
    const hibernateEl = document.getElementById('wake-hibernate-info')
    if (wakeRow)     wakeRow.style.display     = this.checked ? 'flex'  : 'none'
    if (hibernateEl) hibernateEl.style.display = this.checked ? 'block' : 'none'
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
  document.getElementById('wake-hibernate-toggle')?.addEventListener('click', () => {
    const body    = document.getElementById('wake-hibernate-body')
    const chevron = document.getElementById('wake-hibernate-chevron')
    const isOpen  = body && body.style.display !== 'none'
    if (body)    body.style.display    = isOpen ? 'none' : 'block'
    if (chevron) chevron.classList.toggle('open', !isOpen)
    const isMac = navigator.platform.toLowerCase().includes('mac')
    const macEl = document.getElementById('wake-instructions-mac')
    const winEl = document.getElementById('wake-instructions-win')
    if (macEl) macEl.style.display = isMac ? 'block' : 'none'
    if (winEl) winEl.style.display = isMac ? 'none'  : 'block'
  })

  const cleanup = window.api.on('wake-schedule-result', wakeResultToStatus)
  window.addEventListener('beforeunload', () => cleanup?.())
}

export function applyScheduleSettingsToUI(): void {
  const wakeEl    = document.getElementById('opt-wake')    as HTMLInputElement | null
  const protectEl = document.getElementById('opt-protect') as HTMLInputElement | null
  const silenceEl = document.getElementById('opt-silence') as HTMLInputElement | null
  const splitMinSel = document.getElementById('opt-split-minutes') as HTMLSelectElement | null
  if (wakeEl) {
    wakeEl.checked = !!settings.wakeFromSleep
    const wakeRow     = document.getElementById('wake-status-row')
    const hibernateEl = document.getElementById('wake-hibernate-info')
    if (wakeRow)     wakeRow.style.display     = settings.wakeFromSleep ? 'flex'  : 'none'
    if (hibernateEl) hibernateEl.style.display = settings.wakeFromSleep ? 'block' : 'none'
  }
  if (protectEl)   protectEl.checked   = settings.protectRecording !== false
  if (silenceEl)   silenceEl.checked   = !!settings.stopOnSilence
  if (splitMinSel) splitMinSel.value   = String(settings.splitMinutes ?? 0)
  renderSlotsList()
}

async function saveScheduleSettings(): Promise<void> {
  const wakeEl      = document.getElementById('opt-wake')          as HTMLInputElement  | null
  const protectEl   = document.getElementById('opt-protect')       as HTMLInputElement  | null
  const silenceEl   = document.getElementById('opt-silence')       as HTMLInputElement  | null
  const splitMinSel = document.getElementById('opt-split-minutes') as HTMLSelectElement | null
  patchSettings({
    wakeFromSleep:    wakeEl?.checked ?? false,
    protectRecording: protectEl?.checked ?? true,
    stopOnSilence:    silenceEl?.checked ?? false,
    splitMinutes:     parseInt(splitMinSel?.value ?? '0') || 0
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
    return
  }
  list.innerHTML = slots.map((s, i) => {
    const dayNames = (s.days ?? []).map(d => escHtml(days[d] ?? '?')).join(', ')
    return `<div class="slot-row">
      <div class="slot-days">${dayNames || '—'}</div>
      <div class="slot-time">${escHtml(s.start)} – ${escHtml(s.stop)}</div>
      <a href="#" class="slot-edit" data-index="${i}">${escHtml(t('schedule.edit','Rediger'))}</a>
      <span class="slot-del" data-index="${i}" title="Slett">×</span>
    </div>`
  }).join('')
  list.querySelectorAll('.slot-edit').forEach(a =>
    a.addEventListener('click', e => { e.preventDefault(); openSlotEditor(+(a as HTMLElement).dataset.index!) })
  )
  list.querySelectorAll('.slot-del').forEach(s =>
    s.addEventListener('click', async () => {
      settings.slots!.splice(+(s as HTMLElement).dataset.index!, 1)
      await window.api.saveSettings(settings)
      renderSlotsList()
    })
  )
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
}

async function saveSlot(): Promise<void> {
  const days  = [...document.querySelectorAll<HTMLElement>('#day-picker .day-btn.selected')].map(b => +b.dataset.day!)
  const start = (document.getElementById('slot-start') as HTMLInputElement | null)?.value ?? ''
  const stop  = (document.getElementById('slot-stop')  as HTMLInputElement | null)?.value ?? ''
  const maxEl = document.getElementById('slot-max') as HTMLInputElement | null
  const maxV  = maxEl ? (+maxEl.value || null) : null
  if (!days.length) { alert(t('schedule.errNoDays')); return }
  if (!start || !stop || start >= stop) { alert(t('schedule.errTimes')); return }
  const slot: ScheduleSlot = { days, start, stop, ...(maxV ? { max: maxV } : {}) }
  if (!settings.slots) settings.slots = []
  if (editingSlotIndex >= 0) settings.slots[editingSlotIndex] = slot
  else settings.slots.push(slot)
  const editor = document.getElementById('slot-editor')
  if (editor) editor.style.display = 'none'
  await window.api.saveSettings(settings)
  renderSlotsList()
}

function setWakeStatus(cls: string, key: string, fallback: string, count?: number): void {
  const dot  = document.getElementById('wake-status-dot')
  const txt  = document.getElementById('wake-status-text')
  const row  = document.getElementById('wake-status-row')
  if (!dot || !txt || !row) return
  dot.className = `wake-status-dot ${cls}`
  let text = t(key) || fallback
  if (count != null) text = text.replace('{n}', String(count))
  txt.textContent = text
  row.style.display = 'flex'
}

function wakeResultToStatus(result: unknown): void {
  const r = result as { ok: boolean; count?: number; reason?: string } | null
  if (!r) return
  if (r.ok && (r.count ?? 0) > 0)  setWakeStatus('ok',    'schedule.wakeStatusOk',          `${r.count} oppvåkning planlagt`, r.count)
  else if (r.ok)                    setWakeStatus('ok',    'schedule.wakeStatusNone',         'Ingen kommende opptak')
  else if (r.reason === 'disabled') setWakeStatus('off',   'schedule.wakeStatusOff',          'Oppvåkning er slått av')
  else if (r.reason === 'cancelled')setWakeStatus('error', 'schedule.wakeStatusCancelled',    'Avvist — prøv igjen og godkjenn')
  else if (r.reason === 'permission')setWakeStatus('error','schedule.wakeStatusPermission',   'Mangler tillatelse — klikk Planlegg og godkjenn')
  else if (r.reason === 'unsupported')setWakeStatus('off', 'schedule.wakeStatusUnsupported',  'Ikke støttet på denne plattformen')
  else                               setWakeStatus('error', 'schedule.wakeStatusError',       'Feil ved planlegging')
}
