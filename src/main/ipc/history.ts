/**
 * History IPC — recording history list/delete/clear/prune and per-entry
 * free-form notes. History entries are tiny metadata records — the
 * actual audio/video files live on disk; deleting a history entry does
 * not touch the recording file.
 */

import { ipcMain } from 'electron'
import * as store from '../store'
import type { IpcContext } from './types'

export function registerHistoryIpc(_ctx: IpcContext): void {
  ipcMain.handle('get-history', () => store.getHistory())
  ipcMain.handle('delete-history-entry', (_, ts: number) => store.deleteHistoryEntry(ts))
  ipcMain.handle('clear-history', () => store.clearHistory())
  ipcMain.handle('prune-history', () => store.pruneHistory())

  ipcMain.handle('update-history-note', (_, ts: number, note: string) => {
    if (typeof ts !== 'number' || typeof note !== 'string') return
    // Cap note length — without this a compromised renderer could write
    // arbitrarily large strings into the settings file and bloat startup time.
    // 4 KB is plenty for a free-form human note.
    if (note.length > 4096) note = note.slice(0, 4096)
    store.updateHistoryNote(ts, note)
  })
}
