import { powerSaveBlocker } from 'electron'
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

export async function reschedule(upcomingDates: Date[], win?: BrowserWindow, allowAdmin = false): Promise<WakeResult> {
  updateBlocker(upcomingDates)
  const result = await scheduleOsWakes(upcomingDates, allowAdmin)
  win?.webContents.send('wake-schedule-result', result)
  return result
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
    return { ok: false, message: (e as Error).message }
  }
}
