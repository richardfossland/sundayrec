/**
 * Recording IPC — manual start/stop, disk-space check, preflight test
 * and one-shot test-recording. The "now" entry points are what the
 * Direktesending button, manual-record card, and tray menu call.
 *
 * start-recording-now is the workhorse: it sanitises max/split-minutes
 * to keep ffmpeg from blowing up, merges optional opts into the saved
 * settings, harvests the pre-roll buffer if one is running, and hands
 * everything to recorder.startSession.
 */

import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as store from '../store'
import * as scheduler from '../scheduler'
import * as recorder from '../recorder'
import * as preroll from '../preroll'
import type { IpcContext } from './types'

const execFileAsync = promisify(execFile)

export function registerRecordingIpc(ctx: IpcContext): void {
  ipcMain.handle('get-next-recording', () => {
    const next = scheduler.getNextRecording()
    return next ? { date: next.date.toISOString() } : null
  })

  ipcMain.handle('get-disk-space', async () => {
    try {
      let folder = store.get('saveFolder') ?? app.getPath('documents')
      if (!fs.existsSync(folder)) folder = app.getPath('documents')
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const { stdout } = await execFileAsync('df', ['-Pk', folder], { timeout: 5000 })
        const cols = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
        const free = cols ? parseInt(cols[3]) : NaN
        if (!isNaN(free)) return { freeBytes: free * 1024 }
      }
      if (process.platform === 'win32') {
        // Use WMI to get free bytes by path — works for drive letters and UNC paths
        const escapedFolder = folder.replace(/'/g, "''")
        const { stdout } = await execFileAsync('powershell', [
          '-NoProfile', '-Command',
          `(Get-Item -LiteralPath '${escapedFolder}' -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty PSDrive -ErrorAction SilentlyContinue).Free`,
        ], { timeout: 5000 })
        const free = parseInt(stdout.trim())
        if (!isNaN(free) && free >= 0) return { freeBytes: free }
        // Fallback: parse drive letter for local drives
        const m = folder.match(/^([A-Za-z]):/)
        if (m) {
          const { stdout: fb } = await execFileAsync('powershell', [
            '-NoProfile', '-Command', `(Get-PSDrive -Name '${m[1]}').Free`,
          ], { timeout: 5000 })
          const free2 = parseInt(fb.trim())
          if (!isNaN(free2) && free2 >= 0) return { freeBytes: free2 }
        }
      }
    } catch {}
    return { freeBytes: null }
  })

  ipcMain.handle('start-recording-now', async (_, opts) => {
    if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts))) {
      return { error: 'invalid_opts' }
    }
    // Sanitise numeric fields to prevent out-of-range values from crashing ffmpeg
    if (opts && typeof opts === 'object') {
      const o = opts as Record<string, unknown>
      if (o['maxMinutes'] !== undefined) {
        const v = Number(o['maxMinutes'])
        if (!Number.isFinite(v) || v < 1 || v > 1440) o['maxMinutes'] = undefined
      }
      if (o['splitMinutes'] !== undefined) {
        const v = Number(o['splitMinutes'])
        if (!Number.isFinite(v) || v < 1 || v > 480) o['splitMinutes'] = undefined
      }
    }
    const settings = { ...store.getAll(), ...(opts ?? {}) }
    // Map manualMaxMinutes → maxMinutes so the auto-stop timer actually fires
    if (!(settings as import('../../types').RecordingOpts).maxMinutes && settings.manualMaxMinutes) {
      (settings as import('../../types').RecordingOpts).maxMinutes = settings.manualMaxMinutes
    }
    const preRollSec = settings.preRollSeconds ?? 0

    // Harvest pre-roll buffer for manual recordings when enabled
    let prerollData: { rawPath: string; trimMs: number } | null = null
    if (preRollSec > 0 && preroll.isRunning()) {
      prerollData = await preroll.harvest(preRollSec)
      if (prerollData && process.platform === 'darwin') {
        await new Promise<void>(resolve => setTimeout(resolve, 300))
      }
    }

    return recorder.startSession(settings, ctx.mainWindow, prerollData)
  })

  ipcMain.handle('stop-recording-now', () => { recorder.stopSession(); return true })

  ipcMain.handle('run-test-recording', async () => {
    const { runTestRecording } = await import('../test-recorder')
    return runTestRecording(store.getAll())
  })

  ipcMain.handle('run-preflight', async () => {
    return scheduler.runManualPreflight()
  })
}
