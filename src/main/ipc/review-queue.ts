/**
 * Review queue IPC (prep-and-review v5.0) — list/get/update/discard/publish
 * recordings that are queued for human review before going live in the
 * podcast feed.
 *
 * The publish handler enforces idempotency via an in-flight Set so a
 * double-click on the Publish button results in a single upload.
 */

import { ipcMain } from 'electron'
import * as store from '../store'
import type { IpcContext } from './types'

export interface ReviewQueueIpcContext extends IpcContext {
  /** Sync the tray badge count after the queue changes. Cross-module
   *  helper that lives in index.ts (it touches tray.ts + reviewQueue). */
  syncTrayReviewQueueCount: () => Promise<void>
}

export function registerReviewQueueIpc(ctx: ReviewQueueIpcContext): void {
  ipcMain.handle('review-queue-list', async () => {
    const rq = await import('../review-queue')
    return rq.getQueue()
  })

  ipcMain.handle('review-queue-get', async (_, id: string) => {
    if (typeof id !== 'string') return null
    const rq = await import('../review-queue')
    return rq.getQueueEntry(id)
  })

  ipcMain.handle('review-queue-update-trim', async (_, id: string, trim: { startSec: number; endSec: number }) => {
    if (typeof id !== 'string') return false
    if (!trim || typeof trim.startSec !== 'number' || typeof trim.endSec !== 'number') return false
    if (trim.endSec <= trim.startSec) return false
    const rq = await import('../review-queue')
    const ok = rq.updateEntry(id, { suggestedTrim: trim })
    if (ok) try { ctx.mainWindow?.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-update-master-preset', async (_, id: string, presetId: string) => {
    if (typeof id !== 'string' || typeof presetId !== 'string') return false
    const rq = await import('../review-queue')
    const ok = rq.updateEntry(id, { masterPreset: presetId })
    if (ok) try { ctx.mainWindow?.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-update-jingles', async (
    _, id: string, jingles: { introPath?: string | null; outroPath?: string | null },
  ) => {
    if (typeof id !== 'string' || !jingles || typeof jingles !== 'object') return false
    const rq = await import('../review-queue')
    const patch: { introPath?: string; outroPath?: string } = {}
    if ('introPath' in jingles) patch.introPath = jingles.introPath ?? undefined
    if ('outroPath' in jingles) patch.outroPath = jingles.outroPath ?? undefined
    const ok = rq.updateEntry(id, patch)
    if (ok) try { ctx.mainWindow?.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-discard', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const rq = await import('../review-queue')
    rq.markDiscarded(id)
    const removed = rq.removeFromQueue(id)
    if (removed) {
      try { ctx.mainWindow?.webContents.send('review-queue-update', { reason: 'discarded', id }) } catch {}
      void ctx.syncTrayReviewQueueCount()
    }
    return removed
  })

  // Tracks in-flight publishes to enforce idempotency — clicking the button
  // twice within the same prep id MUST result in a single publish.
  const publishInFlight = new Set<string>()

  ipcMain.handle('review-queue-publish', async (_, id: string) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid_id' }
    const rq = await import('../review-queue')
    const entry = rq.getQueueEntry(id)
    if (!entry) return { ok: false, error: 'not_found' }
    if (entry.prep.status === 'published' || entry.prep.publishedAt) {
      return { ok: false, error: 'already_published' }
    }
    if (publishInFlight.has(id)) return { ok: false, error: 'in_progress' }
    publishInFlight.add(id)
    try {
      // Step 1 — mark as published so a re-entrant call is rejected even
      // before the upload finishes. publishedAt is set immediately.
      rq.markPublished(id)

      // Step 2 — for v1 we treat the existing recording file as the publish
      // target. Cloud auto-upload has already run; we just kick the RSS
      // regenerate which inserts this episode into the public feed.
      const podcast = store.get('podcast')
      if (podcast?.enabled) {
        const cloud = await import('../cloud')
        await cloud.regeneratePodcastFeedManual(podcast.service)
      }

      // Step 3 — emit renderer update so the queue card refreshes
      try { ctx.mainWindow?.webContents.send('review-queue-update', { reason: 'published', id }) } catch {}

      // Step 4 — remove from queue (v1 keeps publication history via the
      // recording-history entries; the queue is for pending items only).
      rq.removeFromQueue(id)
      void ctx.syncTrayReviewQueueCount()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      publishInFlight.delete(id)
    }
  })
}
