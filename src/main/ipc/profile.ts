/**
 * Profile IPC — export / import / reset of the full settings profile.
 * Each handler reschedules pending recordings after mutation so the
 * scheduler doesn't keep running on stale state.
 *
 * reset-settings preserves a sensible default saveFolder
 * (~/Music/SundayRec → ~/Documents/SundayRec fallback) so the next
 * recording has somewhere to go without the user having to pick again.
 */

import { app, ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as store from '../store'
import * as scheduler from '../scheduler'
import type { IpcContext } from './types'

export function registerProfileIpc(_ctx: IpcContext): void {
  ipcMain.handle('export-profile', () => store.exportProfile())

  ipcMain.handle('import-profile', (_, json: string) => {
    const ok = store.importProfile(json)
    if (ok) scheduler.reschedule()
    return ok
  })

  ipcMain.handle('reset-settings', () => {
    store.reset()
    const musicPath = app.getPath('music')
    const defaultFolder = fs.existsSync(musicPath)
      ? path.join(musicPath, 'SundayRec')
      : path.join(app.getPath('documents'), 'SundayRec')
    store.set('saveFolder', defaultFolder)
    scheduler.reschedule()
    return true
  })
}
