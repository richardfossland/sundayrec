/**
 * Gmail OAuth IPC — connect/disconnect/status for the e-mail-notification
 * path that replaces SMTP configuration. The OAuth scope (`gmail.send`)
 * is sensitive in Google's classification, so end-users still need a
 * verified OAuth app behind the bundled client credentials; see
 * docs/USER-TASKS.md.
 */

import { ipcMain } from 'electron'
import type { IpcContext } from './types'

export function registerGmailIpc(_ctx: IpcContext): void {
  // When connected, mailer.ts prefers sending via the Gmail API over SMTP —
  // a one-click alternative to app-passwords + smtp.gmail.com.
  ipcMain.handle('gmail-connect', async () => {
    const g = await import('../cloud/gmail-auth')
    return g.connectGmail()
  })
  ipcMain.handle('gmail-disconnect', async () => {
    const g = await import('../cloud/gmail-auth')
    g.disconnectGmail()
    return { ok: true }
  })
  ipcMain.handle('gmail-status', async () => {
    const g = await import('../cloud/gmail-auth')
    return g.getGmailStatus()
  })
}
