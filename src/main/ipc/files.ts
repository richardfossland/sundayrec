/**
 * File-dialog IPC — pick-folder for the saveFolder setting, plus
 * cross-platform open-folder / reveal-file / pick-audio-file, plus
 * register-trusted-path which lets the editor trust an arbitrary
 * dropped folder for the rest of the session.
 *
 * "Trusted" means the path-traversal guard `isAllowedMediaPath`
 * accepts paths inside it. We only honour paths whose target file
 * actually exists on disk — a compromised renderer can't fabricate
 * /etc/passwd because Electron runs as the user, not root.
 */

import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import * as fs from 'fs'
import type { IpcContext } from './types'

export interface FilesIpcContext extends IpcContext {
  trustFolder: (filePath: string) => void
}

export function registerFilesIpc(ctx: FilesIpcContext): void {
  ipcMain.handle('pick-folder', async () => {
    const win = ctx.mainWindow
    if (!win) return null
    if (!win.isVisible()) win.show()
    win.focus()
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-folder', (_, p: string) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return
    return shell.openPath(p)
  })

  ipcMain.handle('reveal-file', (_, p: string) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return
    shell.showItemInFolder(p)
  })

  // Open an external https URL in the system browser. Restricted to https so a
  // compromised renderer can't launch arbitrary schemes/files. Used by the
  // deprecation banner to send users to the new SundayRec download page.
  ipcMain.handle('open-external', (_, url: string) => {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return
    return shell.openExternal(url)
  })

  ipcMain.handle('pick-audio-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? ctx.mainWindow
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a'] }],
    })
    if (r.canceled) return null
    ctx.trustFolder(r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('register-trusted-path', (_, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return false
    try {
      if (!fs.existsSync(filePath)) return false
      ctx.trustFolder(filePath)
      return true
    } catch { return false }
  })
}
