/**
 * review-queue — persistent queue of EpisodePreps awaiting human review.
 *
 * Stored in electron-store under the key `reviewQueue`. Each entry wraps an
 * EpisodePrep with bookkeeping fields (addedAt, reminded). The queue is
 * read every time the home page mounts and is the source of truth for the
 * "Klare for gjennomgang og publisering" card.
 *
 * Reminder timeline:
 *   24 h  → first nudge (tray + email)
 *   48 h  → second nudge (tray + email + webhook)
 *    7 d  → third nudge (tray + email + webhook + in-app warning)
 *   14 d  → auto-discard with a history note
 *
 * processReminders() is meant to be called once an hour from the scheduler.
 */

import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import * as store from './store'
import * as logger from './logger'
import * as mailer from './mailer'
import type { EpisodePrep, ReviewQueueEntry, Settings } from '../types'

// ── Reminder thresholds (in milliseconds) ─────────────────────────────────
const HOUR_MS    = 60 * 60 * 1000
const DAY_MS     = 24 * HOUR_MS

export const REMIND_24H_MS  = 24 * HOUR_MS
export const REMIND_48H_MS  = 48 * HOUR_MS
export const REMIND_7D_MS   = 7 * DAY_MS
export const AUTO_DISCARD_MS = 14 * DAY_MS

// ── Store access helpers ──────────────────────────────────────────────────

function readRaw(): ReviewQueueEntry[] {
  const raw = store.get('reviewQueue') as ReviewQueueEntry[] | undefined
  return Array.isArray(raw) ? raw : []
}

function writeRaw(entries: ReviewQueueEntry[]): void {
  // Strip ageInDays before persisting — it's a derived field.
  const sanitised = entries.map(e => ({ ...e, ageInDays: 0 }))
  store.set('reviewQueue', sanitised as never)
}

function ageInDays(addedAt: number): number {
  return Math.max(0, (Date.now() - addedAt) / DAY_MS)
}

// ── Public API ────────────────────────────────────────────────────────────

export function addToQueue(prep: EpisodePrep): void {
  const now = Date.now()
  const entry: ReviewQueueEntry = {
    id:        prep.id,
    prep,
    addedAt:   now,
    reminded:  0,
    ageInDays: 0,
  }
  const queue = readRaw()
  // Dedup by id — never insert the same prep twice (defensive: addToQueue
  // could in theory be called multiple times if the recorder is buggy).
  const filtered = queue.filter(e => e.id !== entry.id)
  filtered.push(entry)
  writeRaw(filtered)
  logger.info('review-queue', 'added', { id: prep.id, status: prep.status })
}

/**
 * Return all entries with derived ageInDays computed at read time. Queue is
 * sorted newest-first so the home card displays the most recent at the top.
 */
export function getQueue(): ReviewQueueEntry[] {
  const queue = readRaw()
  return queue
    .map(e => ({ ...e, ageInDays: ageInDays(e.addedAt) }))
    .sort((a, b) => b.addedAt - a.addedAt)
}

export function getQueueEntry(id: string): ReviewQueueEntry | null {
  const e = readRaw().find(x => x.id === id)
  if (!e) return null
  return { ...e, ageInDays: ageInDays(e.addedAt) }
}

export function removeFromQueue(id: string): boolean {
  const queue = readRaw()
  const before = queue.length
  const after = queue.filter(e => e.id !== id)
  if (after.length === before) return false
  writeRaw(after)
  return true
}

/**
 * Apply a partial patch to the EpisodePrep stored inside a queue entry.
 * Used by the renderer when the user changes the trim points, master preset,
 * or jingle paths from the editor review mode.
 */
export function updateEntry(id: string, patch: Partial<EpisodePrep>): boolean {
  const queue = readRaw()
  const idx = queue.findIndex(e => e.id === id)
  if (idx < 0) return false
  // Forbid changing immutable fields by stripping them from the patch
  const { id: _id, createdAt: _ca, ...safe } = patch as Partial<EpisodePrep> & { id?: string; createdAt?: number }
  queue[idx] = {
    ...queue[idx],
    prep: {
      ...queue[idx].prep,
      ...safe,
      updatedAt: Date.now(),
    },
  }
  writeRaw(queue)
  return true
}

export function markPublished(id: string): void {
  const queue = readRaw()
  const idx = queue.findIndex(e => e.id === id)
  if (idx < 0) return
  const now = Date.now()
  queue[idx] = {
    ...queue[idx],
    prep: {
      ...queue[idx].prep,
      status:      'published',
      publishedAt: now,
      updatedAt:   now,
    },
  }
  writeRaw(queue)
  // We KEEP published entries in the queue for a brief moment so the UI can
  // show the "published" toast. removeFromQueue() is called separately by the
  // IPC handler after the UI acknowledges.
  logger.info('review-queue', 'marked_published', { id })
}

export function markDiscarded(id: string): void {
  const queue = readRaw()
  const idx = queue.findIndex(e => e.id === id)
  if (idx < 0) return
  const now = Date.now()
  queue[idx] = {
    ...queue[idx],
    prep: {
      ...queue[idx].prep,
      status:    'discarded',
      updatedAt: now,
    },
  }
  writeRaw(queue)
  logger.info('review-queue', 'marked_discarded', { id })
}

// ── Reminders ─────────────────────────────────────────────────────────────

const REMINDER_LABELS: Record<string, { title: string; body24: string; body48: string; body7d: string; bodyDiscard: string }> = {
  no: {
    title:        'SundayRec — gjennomgang venter',
    body24:       'Søndagens opptak har ventet 24 timer på å bli sjekket og publisert',
    body48:       'Det er nå 2 dager siden opptaket — husk å gjennomgå og publisere',
    body7d:       'En hel uke siden opptaket — bør publiseres eller forkastes nå',
    bodyDiscard:  'Opptaket ble automatisk fjernet fra køen (14 dager uten gjennomgang). Filen er ikke slettet.',
  },
  en: {
    title:        'SundayRec — review waiting',
    body24:       "Sunday's recording has been waiting 24 hours for review and publishing",
    body48:       "It's been 2 days since the recording — please review and publish",
    body7d:       'A whole week since the recording — should be published or discarded now',
    bodyDiscard:  'The recording was automatically removed from the queue (14 days without review). The file is still there.',
  },
}

function labels(): typeof REMINDER_LABELS['no'] {
  const lang = (store.get('language') ?? 'no') as string
  return REMINDER_LABELS[lang] ?? REMINDER_LABELS.no
}

function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  } catch {}
}

function sendEmailIfEnabled(body: string): void {
  const s = store.getAll() as Settings
  if (!s.emailOnError || !s.emailAddress) return
  void mailer.sendError(s, store.getSmtpPassword(), body).catch(err =>
    logger.warn('review-queue', 'reminder_email_failed', { error: (err as Error).message }),
  )
}

function sendWebhookIfEnabled(body: string): void {
  const s = store.getAll() as Settings
  if (!s.webhookUrl) return
  void import('./webhook').then(w => w.sendWebhook(s.webhookUrl!, {
    app:       'SundayRec',
    church:    s.churchName || '',
    severity:  'warn',
    category:  'device',
    message:   body,
    timestamp: new Date().toISOString(),
  })).catch(err => logger.warn('review-queue', 'reminder_webhook_failed', { error: (err as Error).message }))
}

/**
 * Called by the scheduler periodically (every hour or so). For each queue
 * entry, bumps its reminded counter and fires appropriate notifications.
 * Auto-discards entries older than AUTO_DISCARD_MS.
 *
 * Idempotent — calling multiple times within the same hour does NOT send
 * duplicate notifications because the reminded counter only increments when
 * crossing a new threshold.
 */
export function processReminders(win: BrowserWindow): void {
  const queue = readRaw()
  if (queue.length === 0) return

  const now = Date.now()
  const lbls = labels()
  let changed = false
  const survivors: ReviewQueueEntry[] = []

  for (const entry of queue) {
    if (entry.prep.status === 'published' || entry.prep.status === 'discarded') {
      // Eligible for cleanup if older than 1 day; otherwise keep so the UI
      // can show "just published" briefly.
      if (now - entry.addedAt > DAY_MS) {
        changed = true
        continue
      }
      survivors.push(entry)
      continue
    }

    const age = now - entry.addedAt

    // Auto-discard at 14 days
    if (age > AUTO_DISCARD_MS) {
      notify(lbls.title, lbls.bodyDiscard)
      try {
        store.addHistoryWithTimestamp({
          date:      new Date(entry.addedAt).toISOString().slice(0, 10),
          startTime: '—',
          duration:  '—',
          filename:  entry.prep.recordingPath.split(/[/\\]/).pop() ?? '?',
          status:    'error',
          note:      'Episode-prep auto-forkastet etter 14 dager uten gjennomgang',
          timestamp: now,
        })
      } catch {}
      changed = true
      continue
    }

    let newReminded = entry.reminded
    if (newReminded < 1 && age >= REMIND_24H_MS) {
      newReminded = 1
      notify(lbls.title, lbls.body24)
      sendEmailIfEnabled(lbls.body24)
    } else if (newReminded < 2 && age >= REMIND_48H_MS) {
      newReminded = 2
      notify(lbls.title, lbls.body48)
      sendEmailIfEnabled(lbls.body48)
      sendWebhookIfEnabled(lbls.body48)
    } else if (newReminded < 3 && age >= REMIND_7D_MS) {
      newReminded = 3
      notify(lbls.title, lbls.body7d)
      sendEmailIfEnabled(lbls.body7d)
      sendWebhookIfEnabled(lbls.body7d)
      // Also bump backend-warning so the home toast shows up next render
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('backend-warning', {
            msg: lbls.body7d, severity: 'warn', category: 'device',
          })
        }
      } catch {}
    }

    if (newReminded !== entry.reminded) {
      changed = true
      survivors.push({ ...entry, reminded: newReminded })
    } else {
      survivors.push(entry)
    }
  }

  if (changed) {
    writeRaw(survivors)
    try {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('review-queue-update', { reason: 'reminders' })
      }
    } catch {}
  }
}
