import { powerSaveBlocker, powerMonitor } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)
import * as store from './store'
import type { WakeResult } from '../types'

const LEAD_MINUTES = 10   // wake machine this many minutes before recording

let blocker: number | null = null

function padN(n: number): string {
  return String(n).padStart(2, '0')
}

function formatPmsetDate(d: Date): string {
  const yy = String(d.getFullYear()).slice(-2)
  return `${padN(d.getMonth() + 1)}/${padN(d.getDate())}/${yy} ${padN(d.getHours())}:${padN(d.getMinutes())}:00`
}

function formatWinDateTime(d: Date): string {
  return `${d.getFullYear()}-${padN(d.getMonth() + 1)}-${padN(d.getDate())}T${padN(d.getHours())}:${padN(d.getMinutes())}:00`
}

function updateBlocker(upcomingDates: Date[]): void {
  const soonMs = 30 * 60 * 1000
  const now    = Date.now()
  const hasSoon = upcomingDates.some(d => {
    const t = d.getTime()
    return t > now && t - now < soonMs
  })
  if (hasSoon && (blocker === null || !powerSaveBlocker.isStarted(blocker))) {
    blocker = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!hasSoon && blocker !== null && powerSaveBlocker.isStarted(blocker)) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}

async function scheduleMac(wakePoints: Date[], allowAdmin: boolean): Promise<WakeResult> {
  try {
    await execFileAsync('pmset', ['schedule', 'cancelall', 'SundayRec'], { timeout: 3000 })
  } catch {}

  if (!wakePoints.length) return { ok: true, count: 0, nextWake: null }

  let scheduled = 0
  for (const d of wakePoints) {
    try {
      await execFileAsync('pmset', ['schedule', 'wake', formatPmsetDate(d), 'SundayRec'], { timeout: 5000 })
      scheduled++
    } catch {}
  }
  if (scheduled === wakePoints.length) return { ok: true, count: scheduled, nextWake: wakePoints[0].toISOString() }

  if (!allowAdmin) return { ok: false, reason: 'permission' }

  try {
    const cmds = wakePoints
      .map(d => `pmset schedule wake \\"${formatPmsetDate(d)}\\" SundayRec`)
      .join(' && ')
    await execFileAsync('osascript', ['-e', `do shell script "${cmds}" with administrator privileges`], {
      timeout: 30000
    })
    return { ok: true, count: wakePoints.length, nextWake: wakePoints[0].toISOString() }
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('User canceled')) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'permission', message: msg }
  }
}

function buildWinTaskDefs(wakePoints: Date[], elevated: boolean): string {
  return wakePoints.map((d, i) => {
    const dt = formatWinDateTime(d)
    const runLevel = elevated ? '-RunLevel Highest ' : ''
    return [
      `$t${i} = New-ScheduledTaskTrigger -Once -At '${dt}'`,
      `$s${i} = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1)`,
      `$a${i} = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'`,
      `Register-ScheduledTask -TaskName 'SundayRec-Wake-${i + 1}' -TaskPath '\\SundayRec' ` +
        `-Action $a${i} -Trigger $t${i} -Settings $s${i} ${runLevel}-Force | Out-Null`
    ].join('; ')
  }).join('; ')
}

function classifyWinError(msg: string): WakeResult['reason'] {
  if (/access.?denied|unauthorized|privilege/i.test(msg)) return 'permission'
  return 'error'
}

async function scheduleWindows(wakePoints: Date[]): Promise<WakeResult> {
  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Get-ScheduledTask -TaskPath '\\SundayRec\\*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`
    ], { timeout: 10000 })
  } catch {}

  if (!wakePoints.length) return { ok: true, count: 0, nextWake: null }

  // Try with elevated privileges first; fall back to standard user on permission error
  for (const elevated of [true, false]) {
    try {
      await execFileAsync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command', buildWinTaskDefs(wakePoints, elevated)
      ], { timeout: 20000 })
      return { ok: true, count: wakePoints.length, nextWake: wakePoints[0].toISOString() }
    } catch (e) {
      const msg = (e as Error & { stderr?: string }).stderr ?? (e as Error).message ?? ''
      const reason = classifyWinError(msg)
      if (reason === 'permission' && elevated) continue  // retry without elevation
      return { ok: false, reason, message: msg }
    }
  }
  return { ok: false, reason: 'permission' }
}

async function scheduleOsWakes(upcomingDates: Date[], allowAdmin: boolean): Promise<WakeResult> {
  if (!store.get('wakeFromSleep')) return { ok: false, reason: 'disabled' }

  const now = new Date()
  const wakePoints = upcomingDates
    .map(d => new Date(d.getTime() - LEAD_MINUTES * 60 * 1000))
    .filter(d => d > now)

  if (process.platform === 'darwin') return await scheduleMac(wakePoints, allowAdmin)
  if (process.platform === 'win32')  return scheduleWindows(wakePoints)
  return { ok: false, reason: 'unsupported' }
}

// Serialize reschedule() calls — multiple callers (startup, settings save,
// powerMonitor.resume, 6 h interval) can fire at the same time. Without a mutex
// two concurrent runs each call cancelall and then schedule, racing each other
// — the loser's wake points get wiped before they're registered.
let inflight: Promise<WakeResult> | null = null
// Track which dates were last successfully scheduled (per platform — testing
// flips process.platform between cases and we don't want stale entries). If
// the next caller wants the same list, skip the work entirely.
const lastScheduledByPlatform = new Map<string, string>()

function keyOf(dates: Date[]): string {
  return dates.map(d => d.getTime()).join('|')
}

/** Test-only: reset the dedup cache. */
export function _resetSchedulingCache(): void {
  lastScheduledByPlatform.clear()
  inflight = null
}

export async function reschedule(upcomingDates: Date[], win?: BrowserWindow | null, allowAdmin = false): Promise<WakeResult> {
  updateBlocker(upcomingDates)

  // De-dupe: if the same set of dates is already scheduled, return early.
  // Admin-elevated calls always run (user expects fresh scheduling). We also
  // skip the cache when there are zero dates — the test suite asserts that
  // empty calls still return { count: 0 } and don't bypass platform checks.
  const platform = process.platform
  const key = keyOf(upcomingDates)
  if (!allowAdmin && upcomingDates.length > 0 && lastScheduledByPlatform.get(platform) === key) {
    return { ok: true, count: upcomingDates.length, nextWake: upcomingDates[0].toISOString() }
  }

  // Chain new callers onto an inflight reschedule rather than racing it.
  if (inflight) {
    await inflight.catch(() => {})
  }

  inflight = (async () => {
    try {
      const result = await scheduleOsWakes(upcomingDates, allowAdmin)
      if (result.ok && upcomingDates.length > 0) lastScheduledByPlatform.set(platform, key)
      win?.webContents.send('wake-schedule-result', result)
      return result
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export interface SleepConfig {
  platform: 'darwin' | 'win32' | 'other'
  // Mac
  autopoweroff?: boolean
  autopoweroffDelay?: number   // seconds
  standby?: boolean
  standbyDelay?: number        // seconds
  hibernateMode?: number       // 0=no disk, 3=safe sleep, 25=hibernate
  // Windows
  wakeTimersEnabled?: boolean  // null = could not determine
  // Common
  error?: string
}

export async function getSleepConfig(): Promise<SleepConfig> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('pmset', ['-g'], { timeout: 5000 })
      const parse = (key: string): string | null => {
        const m = stdout.match(new RegExp(`\\b${key}\\s+(\\d+)`))
        return m?.[1] ?? null
      }
      return {
        platform: 'darwin',
        autopoweroff:      parse('autopoweroff') === '1',
        autopoweroffDelay: parseInt(parse('autopoweroffdelay') ?? '0'),
        standby:           parse('standby') === '1',
        standbyDelay:      parseInt(parse('standbydelay') ?? '0'),
        hibernateMode:     parseInt(parse('hibernatemode') ?? '3'),
      }
    } catch (e) {
      return { platform: 'darwin', error: (e as Error).message }
    }
  }

  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile', '-Command',
        // Query "Allow wake timers" (AC) in the active power scheme
        `$s = (powercfg /getactivescheme) -replace '.*GUID: ([\\w-]+).*','$1'; ` +
        `powercfg /query $s 238C9FA8-0AAD-41ED-83F4-97BE242C8F20 BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D`
      ], { timeout: 10000 })
      // AC Power Setting Index 0x00000000 = disabled, 0x00000001 or 0x00000002 = enabled
      const m = stdout.match(/Current AC Power Setting Index:\s+(0x[0-9a-f]+)/i)
      const val = m ? parseInt(m[1], 16) : null
      return { platform: 'win32', wakeTimersEnabled: val !== null ? val > 0 : undefined }
    } catch (e) {
      return { platform: 'win32', error: (e as Error).message }
    }
  }

  return { platform: 'other' }
}

export async function fixMacSleep(): Promise<{ ok: boolean; message?: string }> {
  // Disable autopoweroff and increase standby delay so Mac stays in sleep (not powered off)
  const cmd = 'pmset -a autopoweroff 0; pmset -a standbydelay 86400'
  try {
    await execFileAsync('osascript', ['-e', `do shell script "${cmd}" with administrator privileges`], {
      timeout: 30000
    })
    return { ok: true }
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('User canceled')) return { ok: false, message: 'cancelled' }
    return { ok: false, message: msg }
  }
}

export async function fixWinWakeTimers(): Promise<{ ok: boolean; message?: string }> {
  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      // Enable wake timers for both AC and DC in the active power scheme
      `$s = (powercfg /getactivescheme) -replace '.*GUID: ([\\w-]+).*','$1'; ` +
      `powercfg /setacvalueindex $s 238C9FA8-0AAD-41ED-83F4-97BE242C8F20 BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D 1; ` +
      `powercfg /setdcvalueindex $s 238C9FA8-0AAD-41ED-83F4-97BE242C8F20 BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D 1; ` +
      `powercfg /setactive $s`
    ], { timeout: 15000 })
    return { ok: true }
  } catch (e) {
    const msg = ((e as Error & { stderr?: string }).stderr ?? (e as Error).message ?? '').toLowerCase()
    if (/access.?denied|unauthorized|privilege|administrator/i.test(msg)) {
      return { ok: false, message: 'admin_required' }
    }
    return { ok: false, message: (e as Error).message }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//   testWake — schedule a near-future wake, sleep the system, measure resume
// ─────────────────────────────────────────────────────────────────────────────

export type TestWakeReason =
  | 'no_sleep'      // system never actually went to sleep
  | 'no_resume'     // slept but didn't wake within the window
  | 'too_late'      // woke, but more than 30s past the scheduled wake time
  | 'cancelled'     // user / API cancelled before completion
  | 'unsupported'   // platform doesn't support sleep
  | 'error'         // other failure

export interface TestWakeResult {
  ok:           boolean
  reason?:      TestWakeReason
  message?:     string
  scheduledFor?:string   // ISO time we asked the OS to wake at
  actualAt?:    string   // ISO time the resume event fired
  /** Positive when actual is later than scheduled; can be negative if it woke early. */
  deltaSec?:    number
}

export type TestWakePhase = 'scheduling' | 'sleeping' | 'waiting' | 'resumed' | 'cancelled' | 'failed'

interface TestWakeState {
  cancelled:   boolean
  resumed:     boolean
  expectedMs:  number
  resolveFn:   ((r: TestWakeResult) => void) | null
  timer:       NodeJS.Timeout | null
  resumeHandler: (() => void) | null
}

let activeTestWake: TestWakeState | null = null

function sendProgress(win: BrowserWindow | null | undefined, phase: TestWakePhase, message: string): void {
  try { win?.webContents.send('test-wake-progress', { phase, message }) } catch { /* ignore */ }
}

/**
 * Schedule a wake N seconds from now, programmatically put the system to sleep,
 * then wait for powerMonitor.resume. Returns success if the system slept and
 * resumed within (secondsAhead + 30s) and the actual wake was within 30s of
 * the scheduled time.
 *
 * CAUTION: This will sleep the user's machine. The renderer MUST show a
 * confirmation dialog before calling this.
 */
export async function testWake(secondsAhead: number, win?: BrowserWindow | null): Promise<TestWakeResult> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported', message: 'platform' }
  }

  // Cancel any in-flight test before starting a new one.
  if (activeTestWake) cancelTestWake()

  // Clamp secondsAhead defensively: too short risks pmset rounding it down,
  // too long is just annoying.
  const sec = Math.max(20, Math.min(secondsAhead, 600))
  const scheduledFor = new Date(Date.now() + sec * 1000)

  sendProgress(win, 'scheduling', `Planlegger test-wake om ${sec} sekunder…`)

  // 1. Schedule the wake via the existing reschedule machinery.
  //    LEAD_MINUTES (10) is subtracted inside scheduleOsWakes, so we pass
  //    (scheduledFor + LEAD_MINUTES) as the "upcoming recording" date.
  const lead = LEAD_MINUTES * 60 * 1000
  const fakeRecordingDate = new Date(scheduledFor.getTime() + lead)

  let scheduleResult: WakeResult
  try {
    scheduleResult = await reschedule([fakeRecordingDate], win, false)
  } catch (e) {
    sendProgress(win, 'failed', `Kunne ikke planlegge wake: ${(e as Error).message}`)
    return { ok: false, reason: 'error', message: (e as Error).message }
  }
  if (!scheduleResult.ok) {
    sendProgress(win, 'failed', `Kunne ikke planlegge wake: ${scheduleResult.reason ?? 'ukjent'}`)
    return {
      ok:      false,
      reason:  scheduleResult.reason === 'cancelled' ? 'cancelled' : 'error',
      message: scheduleResult.message ?? scheduleResult.reason,
    }
  }

  // 2. Set up the resume listener and a max-wait timer.
  // Slack of 90s = 30s "too_late" window + 60s extra grace for a resume that
  // finally fires after the OS slow-pathed the wake. If we hit max-wait we
  // declare no_resume.
  const expectedMs = scheduledFor.getTime()
  const maxWaitMs  = sec * 1000 + 90_000

  return new Promise<TestWakeResult>(resolve => {
    const state: TestWakeState = {
      cancelled:    false,
      resumed:      false,
      expectedMs,
      resolveFn:    resolve,
      timer:        null,
      resumeHandler:null,
    }
    activeTestWake = state

    const cleanup = (): void => {
      if (state.timer) { clearTimeout(state.timer); state.timer = null }
      if (state.resumeHandler) {
        try { powerMonitor.off('resume', state.resumeHandler) } catch { /* ignore */ }
        state.resumeHandler = null
      }
      if (activeTestWake === state) activeTestWake = null
    }

    const finish = (r: TestWakeResult): void => {
      cleanup()
      // Record to wake-failure history so the UI can show "last test"
      try {
        if (r.ok) {
          store.addWakeFailureEntry({
            timestamp:   Date.now(),
            scheduledAt: scheduledFor.toISOString(),
            kind:        'test_ok',
            label:       'Test-wake',
            deltaSec:    r.deltaSec,
          })
        } else {
          store.addWakeFailureEntry({
            timestamp:   Date.now(),
            scheduledAt: scheduledFor.toISOString(),
            kind:        'test_fail',
            label:       'Test-wake',
            reason:      r.reason,
            deltaSec:    r.deltaSec,
          })
        }
      } catch { /* store may be unavailable in tests */ }
      resolve(r)
    }

    state.resumeHandler = (): void => {
      if (state.cancelled) return
      const now = Date.now()
      const deltaSec = Math.round((now - expectedMs) / 1000)
      state.resumed = true
      sendProgress(win, 'resumed', `Vekket — forsinkelse ${deltaSec}s`)
      // > 30s late = "too_late". Early or up to +30s is OK.
      if (deltaSec > 30) {
        finish({
          ok: false, reason: 'too_late', deltaSec,
          scheduledFor: scheduledFor.toISOString(),
          actualAt:     new Date(now).toISOString(),
        })
      } else {
        finish({
          ok: true, deltaSec,
          scheduledFor: scheduledFor.toISOString(),
          actualAt:     new Date(now).toISOString(),
        })
      }
    }
    try { powerMonitor.on('resume', state.resumeHandler) } catch { /* ignore */ }

    state.timer = setTimeout(() => {
      if (state.cancelled || state.resumed) return
      sendProgress(win, 'failed', 'Maskinen våknet ikke i tide.')
      finish({
        ok:           false,
        reason:       'no_resume',
        scheduledFor: scheduledFor.toISOString(),
      })
    }, maxWaitMs)

    // 3. Trigger system sleep — short delay so the renderer can show "Sover om 3…"
    sendProgress(win, 'sleeping', 'Sover nå…')
    setTimeout(() => {
      if (state.cancelled) return
      sendProgress(win, 'waiting', 'Venter på oppvåkning…')
      void triggerSystemSleep().catch(err => {
        if (state.cancelled || state.resumed) return
        sendProgress(win, 'failed', `Kunne ikke sovne: ${(err as Error).message}`)
        finish({ ok: false, reason: 'no_sleep', message: (err as Error).message })
      })
    }, 3000)
  })
}

/** Cancels an in-flight testWake. Resolves the pending promise with { reason: 'cancelled' }. */
export function cancelTestWake(): boolean {
  const state = activeTestWake
  if (!state) return false
  state.cancelled = true
  if (state.timer) { clearTimeout(state.timer); state.timer = null }
  if (state.resumeHandler) {
    try { powerMonitor.off('resume', state.resumeHandler) } catch { /* ignore */ }
    state.resumeHandler = null
  }
  if (state.resolveFn) {
    state.resolveFn({ ok: false, reason: 'cancelled' })
    state.resolveFn = null
  }
  activeTestWake = null
  return true
}

/** True if a testWake is currently waiting. Exported for unit tests + IPC guard. */
export function isTestWakeActive(): boolean {
  return activeTestWake !== null
}

async function triggerSystemSleep(): Promise<void> {
  if (process.platform === 'darwin') {
    await execFileAsync('pmset', ['sleepnow'], { timeout: 5000 })
    return
  }
  if (process.platform === 'win32') {
    // rundll32 powrprof,SetSuspendState 0,1,0 — sleep (not hibernate), force, no wake-events disabled
    await execFileAsync('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0'], { timeout: 5000 })
    return
  }
  throw new Error('unsupported platform')
}
