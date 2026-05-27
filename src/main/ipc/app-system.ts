/**
 * App + system IPC — small read-only handlers that surface
 * platform/version/settings/logs to the renderer, plus run-diagnostics
 * which is the "Diagnostikk"-button on the Innstillinger page.
 *
 * These don't mutate global state, so they don't need any closure
 * helpers beyond the base IpcContext.
 */

import { app, ipcMain } from 'electron'
import * as logger from '../logger'
import * as store from '../store'
import type { IpcContext } from './types'

export function registerAppSystemIpc(ctx: IpcContext): void {
  ipcMain.handle('get-platform',      () => process.platform)
  ipcMain.handle('get-app-version',   () => app.getVersion())
  ipcMain.handle('get-settings',      () => store.getAll())
  ipcMain.handle('get-logs',          () => logger.getRecentLogs(200))
  ipcMain.handle('get-log-file-path', () => logger.getLogFilePath())

  ipcMain.handle('run-diagnostics', async () => {
    const settings = store.getAll()
    const { runDiagnostics } = await import('../diagnostics')
    return runDiagnostics(settings, ctx.mainWindow)
  })
}
