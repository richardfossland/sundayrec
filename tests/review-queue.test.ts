/**
 * review-queue tests — verify queue persistence, reminders, and the
 * lifecycle helpers (markPublished, markDiscarded, removeFromQueue).
 *
 * Uses the existing electron-store mock to keep state in-memory. The
 * mainWindow is mocked as a no-op so processReminders() can run without
 * a real BrowserWindow.
 */

import * as rq from '../src/main/review-queue'
import * as store from '../src/main/store'
import type { EpisodePrep } from '../src/types'

function mkPrep(overrides: Partial<EpisodePrep> = {}): EpisodePrep {
  const now = Date.now()
  return {
    id:           `prep-${Math.random().toString(36).slice(2)}`,
    recordingPath: '/tmp/test.mp3',
    timestamp:    now,
    status:       'ready',
    masterPreset: 'speech-clear',
    createdAt:    now,
    updatedAt:    now,
    ...overrides,
  }
}

function mockWindow() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload?: unknown) => sent.push({ channel, payload }),
    },
  } as unknown as import('electron').BrowserWindow
  return { win, sent }
}

beforeEach(() => {
  store.reset()
})

// ── Queue add / get / remove ──────────────────────────────────────────────

describe('addToQueue / getQueue', () => {
  it('starts empty', () => {
    expect(rq.getQueue()).toEqual([])
  })

  it('adds a prep and returns it via getQueue', () => {
    const prep = mkPrep()
    rq.addToQueue(prep)
    const list = rq.getQueue()
    expect(list).toHaveLength(1)
    expect(list[0].prep.id).toBe(prep.id)
  })

  it('stamps addedAt on insert', () => {
    const before = Date.now()
    rq.addToQueue(mkPrep())
    const after = Date.now()
    const entry = rq.getQueue()[0]
    expect(entry.addedAt).toBeGreaterThanOrEqual(before)
    expect(entry.addedAt).toBeLessThanOrEqual(after)
  })

  it('initialises reminded to 0', () => {
    rq.addToQueue(mkPrep())
    expect(rq.getQueue()[0].reminded).toBe(0)
  })

  it('deduplicates by id (no double-insert)', () => {
    const prep = mkPrep({ id: 'fixed-id' })
    rq.addToQueue(prep)
    rq.addToQueue(prep)
    expect(rq.getQueue()).toHaveLength(1)
  })

  it('returns entries sorted newest-first by addedAt', async () => {
    rq.addToQueue(mkPrep({ id: 'a' }))
    // Force enough time gap that the sort is deterministic
    await new Promise(r => setTimeout(r, 5))
    rq.addToQueue(mkPrep({ id: 'b' }))
    const list = rq.getQueue()
    expect(list[0].id).toBe('b')
    expect(list[1].id).toBe('a')
  })

  it('computes ageInDays at read time (not persisted)', () => {
    rq.addToQueue(mkPrep())
    const entry = rq.getQueue()[0]
    expect(typeof entry.ageInDays).toBe('number')
    expect(entry.ageInDays).toBeGreaterThanOrEqual(0)
    expect(entry.ageInDays).toBeLessThan(0.01)  // milliseconds old
  })
})

describe('getQueueEntry', () => {
  it('returns the matching entry', () => {
    const prep = mkPrep({ id: 'target' })
    rq.addToQueue(prep)
    rq.addToQueue(mkPrep({ id: 'other' }))
    expect(rq.getQueueEntry('target')?.prep.id).toBe('target')
  })

  it('returns null for unknown id', () => {
    expect(rq.getQueueEntry('nope')).toBeNull()
  })
})

describe('removeFromQueue', () => {
  it('removes an entry by id', () => {
    rq.addToQueue(mkPrep({ id: 'gone' }))
    rq.addToQueue(mkPrep({ id: 'keep' }))
    expect(rq.removeFromQueue('gone')).toBe(true)
    const list = rq.getQueue()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('keep')
  })

  it('returns false when id is unknown', () => {
    expect(rq.removeFromQueue('nope')).toBe(false)
  })
})

describe('updateEntry', () => {
  it('applies a patch to the prep', () => {
    rq.addToQueue(mkPrep({ id: 'x', masterPreset: 'speech-clear' }))
    const ok = rq.updateEntry('x', { masterPreset: 'speech-punchy' })
    expect(ok).toBe(true)
    expect(rq.getQueueEntry('x')?.prep.masterPreset).toBe('speech-punchy')
  })

  it('bumps updatedAt on patch', async () => {
    rq.addToQueue(mkPrep({ id: 'x' }))
    const before = rq.getQueueEntry('x')!.prep.updatedAt
    await new Promise(r => setTimeout(r, 5))
    rq.updateEntry('x', { masterPreset: 'speech-natural' })
    const after = rq.getQueueEntry('x')!.prep.updatedAt
    expect(after).toBeGreaterThan(before)
  })

  it('rejects mutation of immutable id field', () => {
    rq.addToQueue(mkPrep({ id: 'x' }))
    rq.updateEntry('x', { id: 'y' } as never)
    // id should still be 'x'
    expect(rq.getQueueEntry('x')).not.toBeNull()
    expect(rq.getQueueEntry('y')).toBeNull()
  })

  it('returns false for unknown id', () => {
    expect(rq.updateEntry('nope', { masterPreset: 'x' })).toBe(false)
  })

  it('preserves fields not in the patch', () => {
    rq.addToQueue(mkPrep({
      id: 'x',
      masterPreset: 'speech-clear',
      introPath:    '/intro.mp3',
    }))
    rq.updateEntry('x', { masterPreset: 'speech-punchy' })
    const e = rq.getQueueEntry('x')!
    expect(e.prep.introPath).toBe('/intro.mp3')
  })
})

// ── markPublished / markDiscarded ─────────────────────────────────────────

describe('markPublished', () => {
  it('updates status and sets publishedAt', () => {
    rq.addToQueue(mkPrep({ id: 'x' }))
    rq.markPublished('x')
    const e = rq.getQueueEntry('x')!
    expect(e.prep.status).toBe('published')
    expect(e.prep.publishedAt).toBeDefined()
  })

  it('is a no-op for unknown id', () => {
    expect(() => rq.markPublished('nope')).not.toThrow()
  })
})

describe('markDiscarded', () => {
  it('updates status', () => {
    rq.addToQueue(mkPrep({ id: 'x' }))
    rq.markDiscarded('x')
    expect(rq.getQueueEntry('x')?.prep.status).toBe('discarded')
  })
})

// ── processReminders ──────────────────────────────────────────────────────

describe('processReminders', () => {
  it('does nothing for fresh entries', () => {
    rq.addToQueue(mkPrep({ id: 'fresh' }))
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('fresh')?.reminded).toBe(0)
  })

  it('bumps reminded to 1 after 24 h', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    // Backdate addedAt by faking the stored entry
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - rq.REMIND_24H_MS - 60_000
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('aged')?.reminded).toBe(1)
  })

  it('bumps to 2 after 48 h (skips first reminder if already past)', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number; reminded: number }
    raw.addedAt = Date.now() - rq.REMIND_48H_MS - 60_000
    raw.reminded = 1  // first reminder already sent
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('aged')?.reminded).toBe(2)
  })

  it('bumps to 3 after 7 days', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number; reminded: number }
    raw.addedAt = Date.now() - rq.REMIND_7D_MS - 60_000
    raw.reminded = 2
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('aged')?.reminded).toBe(3)
  })

  it('auto-discards entries older than 14 days', () => {
    rq.addToQueue(mkPrep({ id: 'ancient' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - rq.AUTO_DISCARD_MS - 60_000
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('ancient')).toBeNull()
  })

  it('is idempotent — calling twice in same window does not double-bump', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - rq.REMIND_24H_MS - 60_000
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    rq.processReminders(win)
    expect(rq.getQueueEntry('aged')?.reminded).toBe(1)
  })

  it('sends a renderer event when changes occur', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - rq.REMIND_24H_MS - 60_000
    store.set('reviewQueue', [raw] as never)
    const { win, sent } = mockWindow()
    rq.processReminders(win)
    const event = sent.find(s => s.channel === 'review-queue-update')
    expect(event).toBeDefined()
  })

  it('cleans up published entries older than 24 h', () => {
    rq.addToQueue(mkPrep({ id: 'old-published' }))
    rq.markPublished('old-published')
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - 25 * 60 * 60 * 1000
    store.set('reviewQueue', [raw] as never)
    const { win } = mockWindow()
    rq.processReminders(win)
    expect(rq.getQueueEntry('old-published')).toBeNull()
  })

  it('handles empty queue without errors', () => {
    const { win } = mockWindow()
    expect(() => rq.processReminders(win)).not.toThrow()
  })
})

// ── ageInDays ─────────────────────────────────────────────────────────────

describe('ageInDays', () => {
  it('is 0 for a brand-new entry', () => {
    rq.addToQueue(mkPrep({ id: 'fresh' }))
    expect(rq.getQueueEntry('fresh')!.ageInDays).toBeLessThan(0.001)
  })

  it('grows to 1 after 24 h', () => {
    rq.addToQueue(mkPrep({ id: 'aged' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() - 24 * 60 * 60 * 1000
    store.set('reviewQueue', [raw] as never)
    const age = rq.getQueueEntry('aged')!.ageInDays
    expect(age).toBeGreaterThanOrEqual(0.99)
    expect(age).toBeLessThan(1.01)
  })

  it('is never negative', () => {
    rq.addToQueue(mkPrep({ id: 'future' }))
    const raw = (store.get('reviewQueue') as unknown[])[0] as { addedAt: number }
    raw.addedAt = Date.now() + 60_000  // future
    store.set('reviewQueue', [raw] as never)
    expect(rq.getQueueEntry('future')!.ageInDays).toBe(0)
  })
})

// ── Reminder thresholds (exported constants) ──────────────────────────────

describe('reminder thresholds', () => {
  it('exports 24 h reminder threshold in ms', () => {
    expect(rq.REMIND_24H_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('exports 48 h reminder threshold', () => {
    expect(rq.REMIND_48H_MS).toBe(48 * 60 * 60 * 1000)
  })

  it('exports 7-day reminder threshold', () => {
    expect(rq.REMIND_7D_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('exports 14-day auto-discard threshold', () => {
    expect(rq.AUTO_DISCARD_MS).toBe(14 * 24 * 60 * 60 * 1000)
  })
})
