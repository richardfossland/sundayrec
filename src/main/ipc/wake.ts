/**
 * Wake/schedule IPC — OS wake-timer scheduling for unattended recording
 * starts, plus verification helpers that check whether the timers we
 * scheduled are actually present in pmset (macOS) or schtasks (Windows).
 *
 * Wake-verification ran into enough edge cases (laptops on battery,
 * standby disabled, AC-adapter-only mode) that we expose checkPower /
 * checkStandby so settings can warn the user before recording night
 * arrives.
 */

import { ipcMain } from 'electron'
import * as store from '../store'
import * as scheduler from '../scheduler'
import * as wake from '../wake'
import type { IpcContext } from './types'

export function registerWakeIpc(ctx: IpcContext): void {
  ipcMain.handle('schedule-os-wakes',       () => wake.reschedule(scheduler.getUpcomingDates(), ctx.mainWindow, false))
  ipcMain.handle('schedule-os-wakes-admin', () => wake.reschedule(scheduler.getUpcomingDates(), ctx.mainWindow, true))
  ipcMain.handle('get-sleep-config',        () => wake.getSleepConfig())
  ipcMain.handle('fix-mac-sleep',           () => wake.fixMacSleep())
  ipcMain.handle('fix-win-wake-timers',     () => wake.fixWinWakeTimers())

  // ── Wake verification & test-wake ──────────────────────────────────────
  ipcMain.handle('wake-detect-capabilities', async () => {
    const wv = await import('../wake-verification')
    return wv.detectCapabilities()
  })

  ipcMain.handle('wake-verify-scheduled', async () => {
    const wv = await import('../wake-verification')
    // Mirror what scheduleOsWakes scheduled: lead-time-shifted upcoming dates.
    const LEAD_MIN = 10
    const expected = scheduler.getUpcomingDates().map(d => new Date(d.getTime() - LEAD_MIN * 60_000))
    const status = await wv.verifyScheduledWakes(expected)
    // Serialise Date instances for the renderer
    return {
      ...status,
      expectedWakes: status.expectedWakes.map(d => d.toISOString()),
      observedWakes: status.observedWakes.map(o => ({
        scheduledAt: o.scheduledAt.toISOString(),
        ownerLabel:  o.ownerLabel,
      })),
    }
  })

  ipcMain.handle('wake-check-power', async () => {
    const wv = await import('../wake-verification')
    return wv.checkPowerSource()
  })

  ipcMain.handle('wake-check-standby', async () => {
    const wv = await import('../wake-verification')
    return wv.checkStandbyEnabled()
  })

  ipcMain.handle('wake-test', async (_, secondsAhead?: number) => {
    const sec = typeof secondsAhead === 'number' && secondsAhead > 0 ? secondsAhead : 60
    return wake.testWake(sec, ctx.mainWindow)
  })

  ipcMain.handle('wake-cancel-test', () => wake.cancelTestWake())
  ipcMain.handle('wake-failure-history', () => store.getWakeFailureHistory())
  ipcMain.handle('wake-clear-failure-history', () => { store.clearWakeFailureHistory(); return true })
}
