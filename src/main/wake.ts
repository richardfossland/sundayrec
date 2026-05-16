import { powerSaveBlocker } from 'electron'
import { execFileSync, execFile } from 'child_process'
import { promisify } from 'util'
import type { BrowserWindow } from 'electron'

const execFileAsync = promisify(execFile)
import * as store from './store'
import type { WakeResult } from '../types'

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

function scheduleMac(wakePoints: Date[], allowAdmin: boolean): WakeResult {
  try {
    execFileSync('pmset', ['schedule', 'cancelall'], { stdio: 'pipe', timeout: 3000 })
  } catch {}

  if (!wakePoints.length) return { ok: true, count: 0 }

  let scheduled = 0
  for (const d of wakePoints) {
    try {
      execFileSync('pmset', ['schedule', 'wake', formatPmsetDate(d)], { stdio: 'pipe', timeout: 5000 })
      scheduled++
    } catch {}
  }
  if (scheduled === wakePoints.length) return { ok: true, count: scheduled }

  if (!allowAdmin) return { ok: false, reason: 'permission' }

  try {
    const cmds = wakePoints
      .map(d => `pmset schedule wake \\"${formatPmsetDate(d)}\\"`)
      .join(' && ')
    execFileSync('osascript', ['-e', `do shell script "${cmds}" with administrator privileges`], {
      stdio: 'pipe', timeout: 30000
    })
    return { ok: true, count: wakePoints.length }
  } catch (e) {
    const msg = (e as Error).message || ''
    if (msg.includes('User canceled')) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'permission', message: msg }
  }
}

async function scheduleWindows(wakePoints: Date[]): Promise<WakeResult> {
  try {
    await execFileAsync('powershell', [
      '-NoProfile', '-Command',
      `Get-ScheduledTask -TaskPath '\\SundayRec\\*' -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`
    ], { timeout: 10000 })
  } catch {}

  if (!wakePoints.length) return { ok: true, count: 0 }

  const taskDefs = wakePoints.map((d, i) => {
    const dt = formatWinDateTime(d)
    return [
      `$t${i} = New-ScheduledTaskTrigger -Once -At '${dt}'`,
      `$s${i} = New-ScheduledTaskSettingsSet -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 1)`,
      `$a${i} = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit'`,
      `Register-ScheduledTask -TaskName 'SundayRec-Wake-${i + 1}' -TaskPath '\\SundayRec' ` +
        `-Action $a${i} -Trigger $t${i} -Settings $s${i} -RunLevel Highest -Force | Out-Null`
    ].join('; ')
  }).join('; ')

  try {
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', taskDefs], {
      timeout: 20000
    })
    return { ok: true, count: wakePoints.length }
  } catch (e) {
    return { ok: false, reason: 'permission', message: (e as Error).message }
  }
}

async function scheduleOsWakes(upcomingDates: Date[], allowAdmin: boolean): Promise<WakeResult> {
  if (!store.get('wakeFromSleep')) return { ok: false, reason: 'disabled' }

  const now = new Date()
  const wakePoints = upcomingDates
    .map(d => new Date(d.getTime() - 8 * 60 * 1000))
    .filter(d => d > now)

  if (process.platform === 'darwin') return scheduleMac(wakePoints, allowAdmin)
  if (process.platform === 'win32')  return scheduleWindows(wakePoints)
  return { ok: false, reason: 'unsupported' }
}

export async function reschedule(upcomingDates: Date[], win?: BrowserWindow, allowAdmin = false): Promise<WakeResult> {
  updateBlocker(upcomingDates)
  const result = await scheduleOsWakes(upcomingDates, allowAdmin)
  win?.webContents.send('wake-schedule-result', result)
  return result
}
