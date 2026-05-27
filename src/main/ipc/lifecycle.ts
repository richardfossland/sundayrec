/**
 * App lifecycle IPC — install-update is the "Last ned + start på nytt"
 * button on the update card. On macOS we can't auto-install (unsigned
 * app — the user must download from GitHub Releases manually), so we
 * just open the releases page. On Windows we call electron-updater's
 * quitAndInstall and fall back to a hard relaunch after 3 s if the
 * normal exit hangs.
 *
 * The forceQuit / quitting setters let the before-quit guard distinguish
 * "user pressed install, please don't show the imminent-recording
 * warning dialog" from "user clicked X". Both flags live in index.ts
 * because before-quit reads them too.
 */

import { app, ipcMain, shell } from 'electron'
import * as updater from '../updater'
import type { IpcContext } from './types'

export interface LifecycleIpcContext extends IpcContext {
  setForceQuit: () => void
  setQuitting: () => void
}

export function registerLifecycleIpc(ctx: LifecycleIpcContext): void {
  ipcMain.handle('install-update', () => {
    if (process.platform === 'darwin') {
      // macOS: unsigned app — open releases page instead of attempting in-place install
      shell.openExternal('https://github.com/richardfossland/sundayrec/releases/latest')
      return
    }
    ctx.setForceQuit()
    ctx.setQuitting()
    setImmediate(() => {
      updater.doInstall()
      // Fallback: if quitAndInstall hasn't exited in 3 s, force relaunch
      setTimeout(() => { app.relaunch(); app.exit(0) }, 3000)
    })
  })
}
