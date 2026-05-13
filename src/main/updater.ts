import { autoUpdater } from 'electron-updater'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import * as store from './store'

let win: BrowserWindow | null = null

function send(channel: string, payload?: unknown): void {
  win?.webContents.send(channel, payload)
}

export function init(mainWindow: BrowserWindow): void {
  win = mainWindow
  const shouldAuto = store.get('autoUpdate') !== false
  autoUpdater.autoDownload = shouldAuto
  autoUpdater.autoInstallOnAppQuit = shouldAuto

  autoUpdater.on('checking-for-update',  ()     => send('update-checking'))
  autoUpdater.on('update-available',     (info) => send('update-available', info))
  autoUpdater.on('update-not-available', ()     => send('update-not-available'))
  autoUpdater.on('download-progress',    (prog) => send('update-download-progress', prog))
  autoUpdater.on('update-downloaded',    (info) => send('update-downloaded', info))
  autoUpdater.on('error', (err) => {
    console.error('Updater error:', err.message)
    send('update-error', err.message)
  })

  ipcMain.handle('check-for-updates', async () => {
    try { await autoUpdater.checkForUpdates() } catch {}
  })

  // install-update is handled in index.ts so it has access to forceQuit
}

export function doInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}

export function check(): void {
  if (process.env.NODE_ENV === 'development') return
  try { autoUpdater.checkForUpdates() } catch {}
}
