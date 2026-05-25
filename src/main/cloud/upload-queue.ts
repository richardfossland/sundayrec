import crypto from 'crypto'
import path from 'path'
import fs from 'fs'
import type { BrowserWindow } from 'electron'
import Store from 'electron-store'
import * as logger from '../logger'
import { isOnline } from './http-util'
import type { CloudServiceId, CloudUploadQueueEntry, CloudQueueStatus } from '../../types'

const MAX_ATTEMPTS = 10
const BACKOFF_STEPS_MS = [
  60_000,         // 1 min
  5 * 60_000,     // 5 min
  10 * 60_000,    // 10 min
  30 * 60_000,    // 30 min
  60 * 60_000,    // 1 h
  2 * 60 * 60_000,// 2 h
  4 * 60 * 60_000,// 4 h
  8 * 60 * 60_000,// 8 h
  12 * 60 * 60_000,// 12 h
  24 * 60 * 60_000,// 24 h
]

interface QueueShape { entries: CloudUploadQueueEntry[] }
const store = new Store<QueueShape>({ name: 'sundayrec-cloud-queue', defaults: { entries: [] } })

function load(): CloudUploadQueueEntry[] {
  return store.get('entries') ?? []
}

function save(entries: CloudUploadQueueEntry[]): void {
  store.set('entries', entries)
}

function genId(): string {
  return crypto.randomBytes(8).toString('hex')
}

export interface EnqueueOpts {
  service: CloudServiceId
  filePath: string
  entryTimestamp?: number
}

/** Add a file to the upload queue. Deduplicates by (service, filePath). */
export function enqueueUpload(opts: EnqueueOpts): CloudUploadQueueEntry {
  const entries = load()
  const existing = entries.find(e => e.service === opts.service && e.filePath === opts.filePath)
  if (existing) {
    // Reset for immediate retry if it was previously failed
    existing.status = 'pending'
    existing.nextAttempt = Date.now()
    existing.lastError = undefined
    save(entries)
    return existing
  }
  const entry: CloudUploadQueueEntry = {
    id:             genId(),
    service:        opts.service,
    filePath:       opts.filePath,
    entryTimestamp: opts.entryTimestamp,
    attempts:       0,
    nextAttempt:    Date.now(),
    enqueuedAt:     Date.now(),
    status:         'pending',
  }
  entries.push(entry)
  save(entries)
  return entry
}

export function removeFromQueue(id: string): boolean {
  const entries = load()
  const filtered = entries.filter(e => e.id !== id)
  if (filtered.length === entries.length) return false
  save(filtered)
  return true
}

export function retryNow(id: string): boolean {
  const entries = load()
  const e = entries.find(x => x.id === id)
  if (!e) return false
  e.status = 'pending'
  e.nextAttempt = Date.now()
  e.lastError = undefined
  save(entries)
  return true
}

export function getQueueStatus(): CloudQueueStatus {
  const entries = load()
  return {
    entries: entries.map(e => ({
      id: e.id,
      service: e.service,
      filename: path.basename(e.filePath),
      attempts: e.attempts,
      nextAttempt: e.nextAttempt,
      lastError: e.lastError,
      status: e.status,
    })),
  }
}

let processing = false
let scheduledTimer: NodeJS.Timeout | null = null

/**
 * Walk the queue and try every entry whose nextAttempt has passed.
 * Pauses while a recording is active. Schedules the next wake-up automatically.
 */
export async function processQueue(win: BrowserWindow | null): Promise<void> {
  if (processing) return
  processing = true
  try {
    // Lazy import to avoid circular dependency (cloud/index.ts → upload-queue.ts → cloud/index.ts)
    const [{ uploadFile }, recorder] = await Promise.all([
      import('./index'),
      import('../recorder'),
    ])
    const tokenStore = await import('./token-store')

    while (true) {
      if (recorder.isActive()) {
        logger.debug('cloud-queue', 'paused_during_recording')
        break
      }

      const entries = load()
      const now = Date.now()
      const next = entries
        .filter(e => e.status === 'pending' && e.nextAttempt <= now)
        .sort((a, b) => a.nextAttempt - b.nextAttempt)[0]
      if (!next) break

      // Verify file still exists
      if (!fs.existsSync(next.filePath)) {
        next.status = 'failed'
        next.lastError = 'file_not_found'
        save(entries)
        logger.warn('cloud-queue', 'file_missing', { service: next.service, filePath: next.filePath })
        continue
      }

      // Skip if token revoked — wait for user to reconnect
      const tok = tokenStore.getToken(next.service)
      if (!tok) {
        next.status = 'failed'
        next.lastError = 'not_connected'
        save(entries)
        continue
      }
      if (tok.needsReauth) {
        next.status = 'reauth-required'
        next.lastError = 'needs_reauth'
        save(entries)
        notifyStatus(win)
        continue
      }

      // Check connectivity before pulling the file (saves the cost of a failed attempt)
      if (!await isOnline()) {
        // Reschedule entry for 1 minute later; keep status pending
        next.nextAttempt = now + 60_000
        save(entries)
        logger.debug('cloud-queue', 'offline_deferred', { service: next.service })
        break
      }

      // Mark uploading
      next.status = 'uploading'
      next.attempts += 1
      save(entries)
      notifyStatus(win)
      win?.webContents.send('cloud-upload-progress', { service: next.service, filename: path.basename(next.filePath) })

      try {
        await uploadFile(next.service, next.filePath, undefined, next.entryTimestamp)
        // Success — remove from queue
        const after = load().filter(e => e.id !== next.id)
        save(after)
        win?.webContents.send('cloud-upload-done', { service: next.service, ok: true })
        logger.info('cloud-queue', 'upload_ok', { service: next.service, filename: path.basename(next.filePath), attempts: next.attempts })
      } catch (err) {
        const msg = (err as Error).message
        const e = err as Error & { code?: string }
        const cur = load().find(x => x.id === next.id)
        if (cur) {
          cur.lastError = msg
          if (e.code === 'invalid_grant' || msg.includes('needs_reauth')) {
            cur.status = 'reauth-required'
          } else if (cur.attempts >= MAX_ATTEMPTS) {
            cur.status = 'failed'
          } else {
            cur.status = 'pending'
            const step = BACKOFF_STEPS_MS[Math.min(cur.attempts - 1, BACKOFF_STEPS_MS.length - 1)]
            cur.nextAttempt = Date.now() + step
          }
          save(load().map(x => x.id === cur.id ? cur : x))
        }
        win?.webContents.send('cloud-upload-done', { service: next.service, ok: false, error: msg })
        logger.warn('cloud-queue', 'upload_failed', { service: next.service, filename: path.basename(next.filePath), attempt: next.attempts, error: msg })
      }

      notifyStatus(win)
    }
  } finally {
    processing = false
    scheduleNextWakeup(win)
  }
}

function scheduleNextWakeup(win: BrowserWindow | null): void {
  if (scheduledTimer) clearTimeout(scheduledTimer)
  const entries = load()
  const pending = entries.filter(e => e.status === 'pending')
  if (pending.length === 0) return
  const soonest = Math.min(...pending.map(e => e.nextAttempt))
  const delay = Math.max(5_000, soonest - Date.now())
  // Cap the delay so we still re-check connectivity periodically
  const cappedDelay = Math.min(delay, 60 * 60_000)
  scheduledTimer = setTimeout(() => processQueue(win).catch(err => {
    logger.error('cloud-queue', 'scheduled_run_failed', { error: (err as Error).message })
  }), cappedDelay)
}

function notifyStatus(win: BrowserWindow | null): void {
  if (!win || win.isDestroyed()) return
  win.webContents.send('cloud-queue-update', getQueueStatus())
}

/** Cancel the scheduled wakeup — used during app shutdown. */
export function shutdown(): void {
  if (scheduledTimer) {
    clearTimeout(scheduledTimer)
    scheduledTimer = null
  }
}
