/**
 * Settings IPC — save-settings is the workhorse that the entire
 * settings page calls (debounced) whenever the user changes a slider
 * or toggle. It triggers a cascade of side effects: scheduler reload,
 * Windows/macOS launch-at-login, OS wake-timer reschedule, tray-icon
 * countdown update, and pre-roll buffer restart.
 *
 * The orchestration lives here because all the deps are already in
 * scope; index.ts just has to supply `storeNextExpected` (small helper
 * that touches `nextExpectedRecordingISO` for missed-recording
 * detection) and `sendBackendWarning` (already in the base context).
 */

import { app, ipcMain } from 'electron'
import * as store from '../store'
import * as scheduler from '../scheduler'
import * as recorder from '../recorder'
import * as wake from '../wake'
import * as preroll from '../preroll'
import * as tray from '../tray'
import type { IpcContext } from './types'

export interface SettingsIpcContext extends IpcContext {
  storeNextExpected: (upcomingDates: Date[]) => void
}

export function registerSettingsIpc(ctx: SettingsIpcContext): void {
  ipcMain.handle('save-settings', (_, settings) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
    store.setAll(settings)
    scheduler.reschedule()
    if (process.platform === 'win32') {
      app.setLoginItemSettings({
        openAtLogin: !!settings.launchAtLogin,
        path: process.execPath,
        args: settings.launchAtLogin ? ['--hidden'] : [],
      })
    } else {
      app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, openAsHidden: true })
    }
    const upcomingAfterSave = scheduler.getUpcomingDates()
    ctx.storeNextExpected(upcomingAfterSave)
    wake.reschedule(upcomingAfterSave, ctx.mainWindow).catch(err => {
      console.error('[wake] reschedule error:', err)
      ctx.sendBackendWarning(`Wake rescheduling failed after settings save: ${(err as Error).message}`, 'warn', 'wake')
    })
    tray.setNextRecording(upcomingAfterSave[0] ?? null)
    // Sync pre-roll state with new settings (stop must complete before start)
    if (!recorder.isActive()) {
      const newPreRollSec = (settings as { preRollSeconds?: number }).preRollSeconds ?? 0
      preroll.stop().then(() => {
        if (newPreRollSec > 0) return preroll.start(store.getAll())
      }).catch(err => {
        console.error('[preroll] settings-change restart error:', err)
        ctx.sendBackendWarning(`Pre-roll failed to restart after settings change: ${(err as Error).message}`, 'warn', 'preroll')
      })
    }
    return true
  })
}
