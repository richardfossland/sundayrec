/**
 * Email + webhook notification IPC — the "Send test"-buttons in
 * settings that verify SMTP credentials and webhook URL before relying
 * on them during an actual recording failure.
 *
 * test-email races the actual send against a 15 s timeout so a hung
 * SMTP socket can't lock up the settings dialog. clear-smtp-password
 * wipes the password from the keychain when the user disables email
 * notifications.
 */

import { ipcMain } from 'electron'
import * as store from '../store'
import * as mailer from '../mailer'
import type { IpcContext } from './types'

export function registerEmailWebhookIpc(ctx: IpcContext): void {
  ipcMain.handle('test-webhook', async () => {
    const s = store.getAll()
    if (!s.webhookUrl) return { ok: false, error: 'no_url' }
    try {
      const { sendWebhook } = await import('../webhook')
      const ok = await sendWebhook(s.webhookUrl, {
        app:       'SundayRec',
        church:    s.churchName || 'untitled',
        severity:  'warn',
        category:  'device',
        message:   'Test fra SundayRec — webhook fungerer.',
        timestamp: new Date().toISOString(),
      })
      return { ok }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('clear-smtp-password', () => {
    store.setSmtpPassword('')
    return true
  })

  ipcMain.handle('test-email', async () => {
    const s = store.getAll()
    ctx.mainWindow?.webContents.send('email-test-status', { status: 'sending' })
    try {
      const result = await Promise.race([
        mailer.sendTest(s, store.getSmtpPassword()).then(() => ({ ok: true as const })),
        new Promise<{ ok: false; error: string }>(resolve =>
          setTimeout(() => resolve({ ok: false, error: 'Email test timed out after 15 seconds' }), 15000),
        ),
      ])
      ctx.mainWindow?.webContents.send('email-test-status', {
        status: result.ok ? 'ok' : 'error',
        message: result.ok ? undefined : result.error,
      })
      return result
    } catch (err) {
      const message = (err as Error).message
      ctx.mainWindow?.webContents.send('email-test-status', { status: 'error', message })
      return { ok: false, error: message }
    }
  })
}
