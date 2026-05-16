import schedule from 'node-schedule'
import type { BrowserWindow } from 'electron'
import * as store from './store'
import type { ScheduleSlot, SpecialRecording, RecordingOpts } from '../types'

const jobs = new Map<string, schedule.Job>()
let mainWindow: BrowserWindow | null = null

export function uiDayToJsDay(uiDay: number): number {
  return (uiDay + 1) % 7  // UI: 0=Mon…6=Sun → node-schedule: 0=Sun…6=Sat
}

export function slotActiveNow(
  start: string, stop: string, days: number[], now: Date, windowMs = 5 * 60000
): boolean {
  const [sh, sm] = (start || '11:00').split(':').map(Number)
  const [eh, em] = (stop  || '12:00').split(':').map(Number)
  for (const uiDay of days) {
    if (now.getDay() !== uiDayToJsDay(uiDay)) continue
    const startT = new Date(now); startT.setHours(sh, sm, 0, 0)
    const stopT  = new Date(now); stopT.setHours(eh, em, 0, 0)
    const late   = now.getTime() - startT.getTime()
    if (late >= 0 && late <= windowMs && now < stopT) return true
  }
  return false
}

export function specialActiveNow(
  date: string, start: string, stop: string, now: Date, windowMs = 5 * 60000
): boolean {
  const startDate = new Date(`${date}T${start || '11:00'}`)
  const stopDate  = new Date(`${date}T${stop  || '12:00'}`)
  const late = now.getTime() - startDate.getTime()
  return late >= 0 && late <= windowMs && now < stopDate
}

export function init(win: BrowserWindow): void {
  mainWindow = win
  reschedule()
}

export function reschedule(): void {
  jobs.forEach(job => job.cancel())
  jobs.clear()

  const slots    = store.get('slots')             ?? []
  const specials = store.get('specialRecordings') ?? []

  slots.forEach((slot, idx) => {
    const [sh, sm] = (slot.start || '11:00').split(':').map(Number)
    const [eh, em] = (slot.stop  || '12:00').split(':').map(Number)

    ;(slot.days ?? []).forEach(uiDay => {
      const jsDay = uiDayToJsDay(uiDay)

      const startRule = new schedule.RecurrenceRule()
      startRule.dayOfWeek = jsDay; startRule.hour = sh; startRule.minute = sm
      jobs.set(`slot-${idx}-${uiDay}-start`, schedule.scheduleJob(startRule, () => triggerStart(slot)))

      const stopRule = new schedule.RecurrenceRule()
      stopRule.dayOfWeek = jsDay; stopRule.hour = eh; stopRule.minute = em
      jobs.set(`slot-${idx}-${uiDay}-stop`, schedule.scheduleJob(stopRule, () => triggerStop()))
    })
  })

  specials.forEach((special, idx) => {
    const startDate = new Date(`${special.date}T${special.start || '11:00'}`)
    const stopDate  = new Date(`${special.date}T${special.stop  || '12:00'}`)
    if (stopDate < new Date()) return

    jobs.set(`special-${idx}-stop`, schedule.scheduleJob(stopDate, () => triggerStop()))
    if (startDate >= new Date()) {
      jobs.set(`special-${idx}-start`, schedule.scheduleJob(startDate, () => triggerStart(special, special.name)))
    }
  })
}

function triggerStart(slot: ScheduleSlot | SpecialRecording, overrideName?: string): void {
  if (!mainWindow) return
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()

  const s = store.getAll()
  const deviceId = (slot as SpecialRecording).deviceId || s.deviceId
  const stopStr  = (slot as ScheduleSlot).stop || (slot as SpecialRecording).stop || '12:00'
  const [eh, em] = stopStr.split(':').map(Number)

  let scheduledStopTime: Date
  if ((slot as SpecialRecording).date) {
    scheduledStopTime = new Date(`${(slot as SpecialRecording).date}T${stopStr}`)
  } else {
    scheduledStopTime = new Date()
    scheduledStopTime.setHours(eh, em, 0, 0)
    if (scheduledStopTime < new Date()) scheduledStopTime.setDate(scheduledStopTime.getDate() + 1)
  }

  // Look up per-device channel override
  const devChannels = deviceId ? (s.deviceChannels?.[deviceId] ?? null) : null
  const channelL    = devChannels?.channelL ?? 0
  const channelR    = devChannels?.channelR ?? 1

  const opts: RecordingOpts = {
    deviceId,
    format:           s.format,
    bitrate:          s.bitrate,
    channels:         s.channels,
    sampleRate:       s.sampleRate,
    saveFolder:       s.saveFolder,
    filenamePattern:  s.filenamePattern,
    inputVolume:      s.inputVolume,
    eqBass:           s.eqBass,
    eqMid:            s.eqMid,
    eqTreble:         s.eqTreble,
    compEnabled:      s.compEnabled,
    compThreshold:    s.compThreshold,
    compRatio:        s.compRatio,
    compAttack:       s.compAttack,
    compRelease:      s.compRelease,
    limiterEnabled:   s.limiterEnabled,
    limiterCeiling:   s.limiterCeiling,
    channelL,
    channelR,
    stopOnSilence:    s.stopOnSilence,
    splitMinutes:     s.splitMinutes,
    maxMinutes:       (slot as ScheduleSlot).max,
    overrideName:     overrideName ?? null,
    scheduledStopTime: scheduledStopTime.toISOString()
  }

  mainWindow?.webContents.send('schedule-start-recording', opts)
}

function triggerStop(): void {
  mainWindow?.webContents.send('schedule-stop-recording', {})
}

export function getNextRecording(): { key: string; date: Date } | null {
  let next: { key: string; date: Date } | null = null
  let nextMs = Infinity
  jobs.forEach((job, key) => {
    if (!key.includes('-start')) return
    const inv = job.nextInvocation?.()
    if (inv && inv.getTime() < nextMs) {
      nextMs = inv.getTime()
      next = { key, date: inv }
    }
  })
  return next
}

export function getUpcomingDates(days = 14): Date[] {
  const cutoff = Date.now() + days * 86400000
  const dates: Date[] = []
  jobs.forEach((job, key) => {
    if (!key.includes('-start')) return
    const inv = job.nextInvocation?.()
    if (inv) {
      const ms = inv.getTime()
      if (ms > Date.now() && ms < cutoff) dates.push(new Date(ms))
    }
  })
  return dates.sort((a, b) => a.getTime() - b.getTime())
}

export function checkMissedRecordings(): void {
  if (!mainWindow) return
  const slots    = store.get('slots')             ?? []
  const specials = store.get('specialRecordings') ?? []
  const now      = new Date()

  slots.forEach(slot => {
    if (slotActiveNow(slot.start, slot.stop, slot.days ?? [], now)) triggerStart(slot)
  })

  specials.forEach(special => {
    if (specialActiveNow(special.date, special.start, special.stop, now)) triggerStart(special, special.name)
  })
}
