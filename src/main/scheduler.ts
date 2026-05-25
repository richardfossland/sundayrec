import schedule from 'node-schedule'
import { Notification } from 'electron'
import * as store from './store'
import * as recorder from './recorder'
import * as logger from './logger'
import type { BrowserWindow } from 'electron'
import type { ScheduleSlot, SpecialRecording, RecordingOpts } from '../types'

const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

const jobs = new Map<string, schedule.Job>()
let mainWindow: BrowserWindow | null = null

// Set by index.ts so we can route preflight findings through sendBackendWarning
// (email/webhook/tray). Imported here would cause a circular dependency.
type BackendWarningSender = (msg: string, severity: 'warn' | 'error', category: 'cloud' | 'preroll' | 'wake' | 'disk' | 'device') => void
let backendWarningSender: BackendWarningSender | null = null
export function setBackendWarningSender(fn: BackendWarningSender): void {
  backendWarningSender = fn
}

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
  logger.info('scheduler', 'reschedule', { slotCount: slots.length, specialCount: specials.length })

  const reminderMin = store.get('reminderMinutes') ?? 0

  slots.forEach((slot, idx) => {
    const [sh, sm] = (slot.start || '11:00').split(':').map(Number)
    const [eh, em] = (slot.stop  || '12:00').split(':').map(Number)

    // Reject degenerate slots (start === stop). The UI blocks this, but it can
    // slip in via direct settings-file edits or imported profiles. Without
    // this guard, the crossesMidnight branch turns the slot into a 24-hour
    // continuous recording — almost certainly not what the user wanted.
    if (sh === eh && sm === em) {
      logger.warn('scheduler', 'degenerate_slot_skipped', { start: slot.start, stop: slot.stop })
      backendWarningSender?.(
        `Opptaksplan "${slot.start}–${slot.stop}" har samme start- og stopptid — hoppes over.`,
        'warn',
        'wake',
      )
      return
    }

    // Detect midnight-crossing: if stop is < start in clock terms, the stop
    // belongs to the next day. Without this the stop rule fires on the same
    // weekday as start (i.e. before it has run), so the recording never stops
    // until the next occurrence — a full week of continuous recording.
    const crossesMidnight = (eh < sh) || (eh === sh && em < sm)

    ;(slot.days ?? []).forEach(uiDay => {
      const jsDay = uiDayToJsDay(uiDay)

      const startRule = new schedule.RecurrenceRule()
      startRule.dayOfWeek = jsDay; startRule.hour = sh; startRule.minute = sm; startRule.tz = LOCAL_TZ
      const startJob = schedule.scheduleJob(startRule, () => {
        triggerStart(slot).catch(err => console.error('[scheduler] start error:', err))
      })
      jobs.set(`slot-${idx}-${uiDay}-start`, startJob)

      // DST gap detection: a weekly slot's next invocation is at most 7 days
      // ahead. If node-schedule returns >7.5 days out, the local time likely
      // falls in the spring-forward gap (eg 02:30 Oslo on the DST Sunday —
      // that time doesn't exist, so node-schedule silently jumps to the
      // following week). Warn the user so they know one occurrence is lost.
      const nextInv = startJob?.nextInvocation?.() as Date | null
      if (nextInv) {
        const daysAhead = (nextInv.getTime() - Date.now()) / 86_400_000
        if (daysAhead > 7.5) {
          logger.warn('scheduler', 'dst_gap_skip', {
            start:     slot.start,
            stop:      slot.stop,
            daysAhead: Math.round(daysAhead),
          })
          backendWarningSender?.(
            `Opptak "${slot.start}–${slot.stop}" hopper over neste uke fordi tiden ikke eksisterer på grunn av sommertid-overgang.`,
            'warn',
            'wake',
          )
        }
      }

      const stopJsDay = crossesMidnight ? (jsDay + 1) % 7 : jsDay
      const stopRule = new schedule.RecurrenceRule()
      stopRule.dayOfWeek = stopJsDay; stopRule.hour = eh; stopRule.minute = em; stopRule.tz = LOCAL_TZ
      jobs.set(`slot-${idx}-${uiDay}-stop`, schedule.scheduleJob(stopRule, () => triggerStop()))

      if (reminderMin > 0) {
        const totalMin = sh * 60 + sm - reminderMin
        const normMin  = ((totalMin % 1440) + 1440) % 1440
        const remH = Math.floor(normMin / 60)
        const remM = normMin % 60
        const remJsDay = totalMin < 0 ? ((jsDay + 6) % 7) : jsDay
        const remRule = new schedule.RecurrenceRule()
        remRule.dayOfWeek = remJsDay; remRule.hour = remH; remRule.minute = remM; remRule.tz = LOCAL_TZ
        jobs.set(`slot-${idx}-${uiDay}-reminder`, schedule.scheduleJob(remRule, () => triggerReminder(reminderMin)))
      }

      // Preflight 30 min before scheduled start — runs the same health check
      // as before-manual-recording, but in the background so the user gets
      // an email/webhook/tray alert long enough in advance to do something
      // about it.
      const PREFLIGHT_LEAD_MIN = 30
      const pfTotalMin = sh * 60 + sm - PREFLIGHT_LEAD_MIN
      const pfNormMin  = ((pfTotalMin % 1440) + 1440) % 1440
      const pfH = Math.floor(pfNormMin / 60)
      const pfM = pfNormMin % 60
      const pfJsDay = pfTotalMin < 0 ? ((jsDay + 6) % 7) : jsDay
      const pfRule = new schedule.RecurrenceRule()
      pfRule.dayOfWeek = pfJsDay; pfRule.hour = pfH; pfRule.minute = pfM; pfRule.tz = LOCAL_TZ
      jobs.set(`slot-${idx}-${uiDay}-preflight`, schedule.scheduleJob(pfRule, () => triggerPreflight()))
    })
  })

  // Prune specials that ended more than 7 days ago so the list doesn't grow unbounded.
  const pruneThreshold = new Date(Date.now() - 7 * 86400000)
  const prunedSpecials = specials.filter(s => {
    const stopDate = new Date(`${s.date}T${s.stop || '12:00'}`)
    return stopDate >= pruneThreshold
  })
  if (prunedSpecials.length < specials.length) {
    store.set('specialRecordings', prunedSpecials)
    console.log(`[scheduler] pruned ${specials.length - prunedSpecials.length} expired special recording(s)`)
  }

  const PREFLIGHT_LEAD_MIN = 30

  specials.forEach((special, idx) => {
    const startDate = new Date(`${special.date}T${special.start || '11:00'}`)
    const stopDate  = new Date(`${special.date}T${special.stop  || '12:00'}`)
    if (stopDate < new Date()) return

    jobs.set(`special-${idx}-stop`, schedule.scheduleJob(stopDate, () => triggerStop()))
    if (startDate >= new Date()) {
      jobs.set(`special-${idx}-start`, schedule.scheduleJob(startDate, () => {
        triggerStart(special, special.name).catch(err => console.error('[scheduler] special start error:', err))
      }))
      if (reminderMin > 0) {
        const remDate = new Date(startDate.getTime() - reminderMin * 60000)
        if (remDate > new Date()) {
          jobs.set(`special-${idx}-reminder`, schedule.scheduleJob(remDate, () => triggerReminder(reminderMin)))
        }
      }
      // Preflight 30 min before — same as for weekly slots
      const pfDate = new Date(startDate.getTime() - PREFLIGHT_LEAD_MIN * 60000)
      if (pfDate > new Date()) {
        jobs.set(`special-${idx}-preflight`, schedule.scheduleJob(pfDate, () => triggerPreflight()))
      }
    }
  })
}

async function triggerStart(slot: ScheduleSlot | SpecialRecording, overrideName?: string): Promise<void> {
  if (!mainWindow) return

  const slotKey = (slot as SpecialRecording).date
    ? `special:${(slot as SpecialRecording).date}T${(slot as SpecialRecording).start}`
    : `slot:${(slot as ScheduleSlot).start}-${(slot as ScheduleSlot).stop}`
  logger.info('scheduler', 'trigger_start', { slotKey })

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

  const devChannels = deviceId ? (s.deviceChannels?.[deviceId] ?? null) : null
  const channelL    = devChannels?.channelL ?? 0
  const channelR    = devChannels?.channelR ?? 1

  const opts: RecordingOpts = {
    deviceId,
    deviceName:       s.deviceName,
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
    stopOnSilence:          s.stopOnSilence,
    silenceThreshold:       s.silenceThreshold,
    silenceTimeoutMinutes:  s.silenceTimeoutMinutes,
    trimSilence:            s.trimSilence,
    splitMinutes:           s.splitMinutes,
    maxMinutes:             (slot as ScheduleSlot).max,
    overrideName:           overrideName ?? null,
    scheduledStopTime:      scheduledStopTime.toISOString(),
    videoEnabled:           s.videoEnabled,
    videoDeviceName:        s.videoDeviceName,
    videoDeviceIndex:       s.videoDeviceIndex,
    videoResolution:        s.videoResolution,
    videoBitrate:           s.videoBitrate,
    videoFramerate:         s.videoFramerate,
    videoSeparate:          s.videoSeparate,
    videoKeepAudio:         s.videoKeepAudio,
    videoFlip:              s.videoFlip,
  }

  // Start recording directly in main — no longer routed through the renderer
  const result = await recorder.startSession(opts, mainWindow)
  if ('error' in result) {
    logger.error('scheduler', 'trigger_start_failed', { error: result.error, slotKey })
    const lang = store.get('language') ?? 'no'
    const nl   = recorder.NOTIFY_LABELS[lang] ?? recorder.NOTIFY_LABELS.no
    const msg  = recorder.localizeError(result.error)
    if (Notification.isSupported()) new Notification({ title: nl.err, body: msg }).show()

    // Log a history entry for the skipped scheduled slot so the user has a
    // record that the recording was supposed to run. Without this, an
    // overlapping slot (or a slot fired while a manual recording is active)
    // simply vanishes — there's nothing in history to show what was missed.
    const now = new Date()
    const slotName = overrideName
      ?? (slot as SpecialRecording).name
      ?? `${(slot as ScheduleSlot).start ?? ''}–${(slot as ScheduleSlot).stop ?? ''}`
    const skipNote = result.error === 'already_recording'
      ? 'Hoppet over — et annet opptak var i gang'
      : `Planlagt opptak startet ikke: ${msg}`
    try {
      store.addHistoryWithTimestamp({
        date:      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
        startTime: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        duration:  '—',
        filename:  slotName,
        status:    'error',
        error:     result.error,
        note:      skipNote,
        timestamp: now.getTime(),
      })
    } catch (err) {
      logger.warn('scheduler', 'skipped_slot_history_failed', { msg: (err as Error).message })
    }

    // Don't show an error banner when a manual recording is already active —
    // the UI correctly shows the in-progress recording; a banner would be confusing.
    if (result.error !== 'already_recording') {
      mainWindow.webContents.send('recording-error', { error: result.error, message: msg })
    }
    return
  }

  // Tell renderer to show overlay and open monitoring stream for VU meter
  mainWindow.webContents.send('recording-overlay-start', opts)
}

function triggerStop(): void {
  // Stop ffmpeg directly in main; tell renderer to close monitoring stream
  recorder.stopSession()
  mainWindow?.webContents.send('recording-overlay-stop', {})
}

const REMINDER_LABELS: Record<string, string> = {
  no: 'Opptak starter om {min} minutter',
  en: 'Recording starts in {min} minutes',
  de: 'Aufnahme beginnt in {min} Minuten',
  sv: 'Inspelning börjar om {min} minuter',
  da: 'Optagelse starter om {min} minutter',
  pl: 'Nagranie rozpocznie się za {min} minut',
  fr: 'Enregistrement dans {min} minutes',
}

function triggerReminder(minutesBefore: number): void {
  const lang = store.get('language') ?? 'no'
  const tpl  = REMINDER_LABELS[lang] ?? REMINDER_LABELS.no
  const body = tpl.replace('{min}', String(minutesBefore))
  if (Notification.isSupported()) new Notification({ title: 'SundayRec', body }).show()
}

function triggerPreflight(): void {
  // Lazy-import to avoid circular dependency (preflight loads recorder for
  // resolveDeviceInput; scheduler is loaded by recorder).
  import('./preflight').then(p => p.runScheduledPreflight((msg, severity, category) => {
    if (backendWarningSender) {
      // Use the main-process sender — this also fires email + webhook.
      backendWarningSender(msg, severity, category)
    } else {
      // Fallback when the sender isn't wired (eg unit tests).
      mainWindow?.webContents.send('backend-warning', { msg, severity, category })
    }
    if (Notification.isSupported() && severity === 'error') {
      new Notification({ title: 'SundayRec — preflight', body: msg }).show()
    }
  })).catch(err => logger.error('scheduler', 'preflight_failed', { msg: String(err) }))
}

/** Run preflight on demand from the UI (e.g. "Check now" button). */
export async function runManualPreflight(): Promise<unknown> {
  const p = await import('./preflight')
  return p.runScheduledPreflight((msg, severity, category) => {
    if (backendWarningSender) backendWarningSender(msg, severity, category)
  })
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

// Window for late-starting an in-progress slot. Extended from 25 → 60 min so
// a congregation that started 45 min late still gets the rest captured rather
// than no recording at all. The user only loses the early portion.
const MISSED_WINDOW_MS = 60 * 60000

// Look back 24 h for slots/specials we never got around to running. Anything
// outside that window is too stale to surface meaningfully.
const MISSED_LOG_WINDOW_MS = 24 * 60 * 60000

export function checkMissedRecordings(): void {
  if (!mainWindow) return
  if (recorder.isActive()) return
  const slots    = store.get('slots')             ?? []
  const specials = store.get('specialRecordings') ?? []
  const now      = new Date()

  let found = false
  const triggered = new Set<string>()

  slots.forEach(slot => {
    if (slotActiveNow(slot.start, slot.stop, slot.days ?? [], now, MISSED_WINDOW_MS)) {
      found = true
      triggered.add(slotKeyOf(slot, now))
      triggerStart(slot).catch(err => {
        logger.error('scheduler', 'trigger_start_failed', { error: (err as Error).message })
        console.error('[scheduler] missed slot start error:', err)
      })
    }
  })

  specials.forEach(special => {
    if (specialActiveNow(special.date, special.start, special.stop, now, MISSED_WINDOW_MS)) {
      found = true
      triggered.add(`special:${special.date}:${special.start}`)
      triggerStart(special, special.name).catch(err => {
        logger.error('scheduler', 'trigger_start_failed', { error: (err as Error).message })
        console.error('[scheduler] missed special start error:', err)
      })
    }
  })

  // Log any slots/specials whose start time was within the last 24 h, but is
  // older than MISSED_WINDOW_MS — too late to record but recent enough that
  // the user should see "this didn't happen" in their history.
  logMissedRecordings(slots, specials, now, triggered)

  logger.info('scheduler', 'missed_check', { found })
}

function slotKeyOf(slot: ScheduleSlot, now: Date): string {
  return `slot:${now.getDay()}:${slot.start}-${slot.stop}`
}

/**
 * Inspects scheduled slots and specials whose start time fell within the past
 * 24 h. If the start time is older than MISSED_WINDOW_MS (couldn't be late-
 * started any more) AND we don't already have a history entry that covers it,
 * write a `status:'missed'` row so the user can see in retrospect.
 */
function logMissedRecordings(
  slots: ScheduleSlot[],
  specials: SpecialRecording[],
  now: Date,
  triggered: Set<string>
): void {
  const history = store.getHistory()
  const startCutoff = now.getTime() - MISSED_LOG_WINDOW_MS

  // Walk slots: for each enabled (day, time), compute the most recent start
  // time before now. If it falls inside the log-window AND outside the
  // start-window, it's a candidate.
  for (const slot of slots) {
    const [sh, sm] = (slot.start || '11:00').split(':').map(Number)
    for (const uiDay of slot.days ?? []) {
      const jsDay = uiDayToJsDay(uiDay)
      // Most recent occurrence ≤ now
      const candidate = mostRecentOccurrence(jsDay, sh, sm, now)
      const ageMs = now.getTime() - candidate.getTime()
      if (ageMs <= MISSED_WINDOW_MS) continue          // still inside late-start window
      if (candidate.getTime() < startCutoff) continue   // older than 24 h
      if (triggered.has(slotKeyOf(slot, candidate))) continue
      if (historyCovers(history, candidate)) continue
      addMissedHistory(candidate, `Ukentlig opptak (${slot.start}–${slot.stop})`)
    }
  }

  // Walk specials: their date+start is absolute
  for (const sp of specials) {
    const startDate = new Date(`${sp.date}T${sp.start || '11:00'}`)
    const ageMs = now.getTime() - startDate.getTime()
    if (ageMs <= MISSED_WINDOW_MS) continue
    if (startDate.getTime() < startCutoff) continue
    if (triggered.has(`special:${sp.date}:${sp.start}`)) continue
    if (historyCovers(history, startDate)) continue
    addMissedHistory(startDate, sp.name || 'Spesialopptak')
  }
}

function mostRecentOccurrence(jsDay: number, hour: number, min: number, now: Date): Date {
  const today = now.getDay()
  // Compute days back: 0 if today matches AND time has already passed, else
  // days from the previous matching weekday.
  let daysBack = (today - jsDay + 7) % 7
  const todayAt = new Date(now); todayAt.setHours(hour, min, 0, 0)
  if (daysBack === 0 && todayAt > now) daysBack = 7
  const out = new Date(now)
  out.setDate(out.getDate() - daysBack)
  out.setHours(hour, min, 0, 0)
  return out
}

function historyCovers(history: ReturnType<typeof store.getHistory>, when: Date): boolean {
  const target = when.getTime()
  // Coverage = a history entry within ±30 min of the expected start time, or
  // an entry already marked 'missed' for the same time.
  return history.some(e => e.timestamp && Math.abs(e.timestamp - target) < 30 * 60000)
}

function addMissedHistory(when: Date, label: string): void {
  // Use addHistoryWithTimestamp — addHistory would clobber `timestamp` with
  // Date.now(), making historyCovers() unable to detect this entry on the next
  // checkMissedRecordings() pass (timestamp would be hours off from `when`).
  store.addHistoryWithTimestamp({
    date:      `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`,
    startTime: `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`,
    duration:  '—',
    filename:  label,
    status:    'error',
    error:     'missed_recording',
    note:      'Planlagt opptak ble ikke utført (maskinen var av eller appen ikke kjørte).',
    timestamp: when.getTime(),
  })
  logger.warn('scheduler', 'logged missed recording', { label, when: when.toISOString() })
}
