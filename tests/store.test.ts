import * as store from '../src/main/store'
import * as fs from 'fs'

// Allow jest.spyOn to mock existsSync
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn()
}))

beforeEach(() => {
  store.reset()
  jest.resetAllMocks()
})

// ─── addHistory ───────────────────────────────────────────────────────────────

describe('addHistory', () => {
  it('prepends a new entry', () => {
    store.addHistory({ filename: 'a.mp3', duration: 60, status: 'ok', path: '/a.mp3' } as any)
    store.addHistory({ filename: 'b.mp3', duration: 30, status: 'ok', path: '/b.mp3' } as any)
    const h = store.getHistory()
    expect(h[0].filename).toBe('b.mp3')
    expect(h[1].filename).toBe('a.mp3')
  })

  it('stamps a timestamp on each entry', () => {
    const before = Date.now()
    store.addHistory({ filename: 'x.mp3', duration: 0, status: 'ok' } as any)
    const after = Date.now()
    const ts = store.getHistory()[0].timestamp!
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('caps history at 200 entries', () => {
    for (let i = 0; i < 205; i++) {
      store.addHistory({ filename: `f${i}.mp3`, duration: i, status: 'ok' } as any)
    }
    expect(store.getHistory()).toHaveLength(200)
  })

  it('most-recent entry is at index 0 after 205 adds', () => {
    for (let i = 0; i < 205; i++) {
      store.addHistory({ filename: `f${i}.mp3`, duration: i, status: 'ok' } as any)
    }
    expect(store.getHistory()[0].filename).toBe('f204.mp3')
  })
})

// ─── addHistoryWithTimestamp ─────────────────────────────────────────────────

describe('addHistoryWithTimestamp', () => {
  it('preserves the supplied timestamp (does not stamp now)', () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000
    store.addHistoryWithTimestamp({
      date: '2026-05-24', startTime: '11:00', duration: '—',
      filename: 'missed.mp3', status: 'error', error: 'missed_recording',
      timestamp: yesterday,
    })
    const h = store.getHistory()
    expect(h[0].timestamp).toBe(yesterday)
  })

  it('inserts a back-dated entry in correct chronological position', () => {
    // Add a recent entry, then a back-dated one — back-dated should land at index 1
    store.addHistory({ filename: 'recent.mp3', duration: 10, status: 'ok' } as any)
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    store.addHistoryWithTimestamp({
      date: '2026-05-25', startTime: '10:00', duration: '—',
      filename: 'older.mp3', status: 'error', error: 'missed_recording',
      timestamp: oneHourAgo,
    })
    const h = store.getHistory()
    expect(h).toHaveLength(2)
    expect(h[0].filename).toBe('recent.mp3')
    expect(h[1].filename).toBe('older.mp3')
    expect(h[1].timestamp).toBe(oneHourAgo)
  })

  it('inserts a future-dated entry at the top', () => {
    store.addHistory({ filename: 'now.mp3', duration: 10, status: 'ok' } as any)
    const future = Date.now() + 60 * 60 * 1000
    store.addHistoryWithTimestamp({
      date: '2026-05-25', startTime: '20:00', duration: '—',
      filename: 'future.mp3', status: 'scheduled', timestamp: future,
    })
    expect(store.getHistory()[0].filename).toBe('future.mp3')
  })

  it('back-dated entry does not interfere with subsequent addHistory monotonic ordering', () => {
    // Back-dated missed entry (yesterday) should not push tomorrow's addHistory back.
    jest.useFakeTimers()
    jest.setSystemTime(1_000_000)
    const yesterday = 500_000
    store.addHistoryWithTimestamp({
      date: '2026-05-24', startTime: '11:00', duration: '—',
      filename: 'missed.mp3', status: 'error', error: 'missed_recording',
      timestamp: yesterday,
    })
    jest.setSystemTime(2_000_000)
    store.addHistory({ filename: 'next.mp3', duration: 10, status: 'ok' } as any)
    jest.useRealTimers()
    const nextEntry = store.getHistory().find(e => e.filename === 'next.mp3')!
    // addHistory sees yesterday as history[0]? — but it should still produce a time near 2_000_000
    expect(nextEntry.timestamp).toBeGreaterThanOrEqual(2_000_000)
    expect(nextEntry.timestamp).toBeLessThan(3_000_000)
  })
})

// ─── deleteHistoryEntry ───────────────────────────────────────────────────────

describe('deleteHistoryEntry', () => {
  it('removes the entry with the matching timestamp', () => {
    jest.useFakeTimers()
    jest.setSystemTime(1000)
    store.addHistory({ filename: 'a.mp3', duration: 10, status: 'ok' } as any)
    jest.setSystemTime(2000)
    store.addHistory({ filename: 'b.mp3', duration: 20, status: 'ok' } as any)
    jest.useRealTimers()
    const [b, a] = store.getHistory()
    expect(b.timestamp).not.toBe(a.timestamp)
    store.deleteHistoryEntry(b.timestamp!)
    const remaining = store.getHistory()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].filename).toBe('a.mp3')
  })

  it('is a no-op when timestamp does not exist', () => {
    store.addHistory({ filename: 'a.mp3', duration: 10, status: 'ok' } as any)
    store.deleteHistoryEntry(9999999)
    expect(store.getHistory()).toHaveLength(1)
  })
})

// ─── clearHistory ─────────────────────────────────────────────────────────────

describe('clearHistory', () => {
  it('empties all history entries', () => {
    store.addHistory({ filename: 'a.mp3', duration: 10, status: 'ok' } as any)
    store.addHistory({ filename: 'b.mp3', duration: 20, status: 'ok' } as any)
    store.clearHistory()
    expect(store.getHistory()).toHaveLength(0)
  })
})

// ─── pruneHistory ─────────────────────────────────────────────────────────────

describe('pruneHistory', () => {
  it('removes ok entries whose file no longer exists', () => {
    (fs.existsSync as jest.Mock).mockImplementation((p: unknown) => p === '/exists.mp3')
    store.addHistory({ filename: 'gone.mp3', duration: 10, status: 'ok', path: '/gone.mp3' } as any)
    store.addHistory({ filename: 'exists.mp3', duration: 20, status: 'ok', path: '/exists.mp3' } as any)
    const pruned = store.pruneHistory()
    expect(pruned).toBe(1)
    const h = store.getHistory()
    expect(h).toHaveLength(1)
    expect(h[0].filename).toBe('exists.mp3')
  })

  it('keeps error entries even when path is missing', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false)
    store.addHistory({ filename: 'err.mp3', duration: 0, status: 'error', path: '/err.mp3' } as any)
    const pruned = store.pruneHistory()
    expect(pruned).toBe(0)
    expect(store.getHistory()).toHaveLength(1)
  })

  it('keeps ok entries that have no path', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false)
    store.addHistory({ filename: 'nopath.mp3', duration: 10, status: 'ok' } as any)
    const pruned = store.pruneHistory()
    expect(pruned).toBe(0)
    expect(store.getHistory()).toHaveLength(1)
  })

  it('returns 0 and does not write when nothing is removed', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true)
    store.addHistory({ filename: 'ok.mp3', duration: 10, status: 'ok', path: '/ok.mp3' } as any)
    expect(store.pruneHistory()).toBe(0)
  })
})

// ─── importProfile ────────────────────────────────────────────────────────────

describe('importProfile', () => {
  it('returns true and applies valid JSON settings', () => {
    const ok = store.importProfile(JSON.stringify({ format: 'flac', bitrate: '320' }))
    expect(ok).toBe(true)
    expect(store.get('format')).toBe('flac')
  })

  it('returns false for invalid JSON', () => {
    expect(store.importProfile('not json {')).toBe(false)
    expect(store.importProfile('')).toBe(false)
  })

  it('rejects non-object JSON', () => {
    expect(store.importProfile(JSON.stringify([1, 2, 3]))).toBe(false)
    expect(store.importProfile(JSON.stringify(42))).toBe(false)
    expect(store.importProfile(JSON.stringify('string'))).toBe(false)
    expect(store.importProfile(JSON.stringify(null))).toBe(false)
  })

  it('rejects saveFolder of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ saveFolder: 123 }))).toBe(false)
    expect(store.importProfile(JSON.stringify({ saveFolder: true }))).toBe(false)
  })

  it('accepts null saveFolder (reset to default)', () => {
    expect(store.importProfile(JSON.stringify({ saveFolder: null }))).toBe(true)
  })

  it('rejects emailSmtp of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ emailSmtp: 587 }))).toBe(false)
  })

  it('rejects emailAddress of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ emailAddress: false }))).toBe(false)
  })

  it('rejects slots of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ slots: 'not-an-array' }))).toBe(false)
    expect(store.importProfile(JSON.stringify({ slots: {} }))).toBe(false)
  })

  it('rejects specialRecordings of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ specialRecordings: 'bad' }))).toBe(false)
  })

  it('rejects language of wrong type', () => {
    expect(store.importProfile(JSON.stringify({ language: 42 }))).toBe(false)
  })

  it('accepts null language', () => {
    expect(store.importProfile(JSON.stringify({ language: null }))).toBe(true)
  })

  it('strips recordingHistory from imported profile', () => {
    store.addHistory({ filename: 'existing.mp3', duration: 10, status: 'ok' } as any)
    store.importProfile(JSON.stringify({
      format: 'wav',
      recordingHistory: [{ filename: 'injected.mp3', duration: 0, status: 'ok' }]
    }))
    const h = store.getHistory()
    expect(h.some(e => e.filename === 'injected.mp3')).toBe(false)
  })

  it('strips activeRecovery from imported profile', () => {
    store.importProfile(JSON.stringify({ activeRecovery: { path: '/tmp/bad' } }))
    expect(store.get('activeRecovery')).toBeNull()
  })
})

// ─── setAll ───────────────────────────────────────────────────────────────────

describe('setAll', () => {
  it('applies safe settings', () => {
    store.setAll({ format: 'aac', bitrate: '128' })
    expect(store.get('format')).toBe('aac')
    expect(store.get('bitrate')).toBe('128')
  })

  it('does not overwrite recordingHistory', () => {
    store.addHistory({ filename: 'keep.mp3', duration: 5, status: 'ok' } as any)
    store.setAll({ recordingHistory: [] as any })
    expect(store.getHistory()).toHaveLength(1)
  })

  it('does not overwrite activeRecovery', () => {
    store.set('activeRecovery', { path: '/tmp/r.mp3' } as any)
    store.setAll({ activeRecovery: null as any })
    expect(store.get('activeRecovery')).toEqual({ path: '/tmp/r.mp3' })
  })
})

// ─── SMTP password helpers ────────────────────────────────────────────────────

describe('SMTP password helpers', () => {
  // The electron mock has isEncryptionAvailable returning false,
  // so passwords are stored as plaintext emailSmtpPass.

  it('hasSmtpPassword returns false when nothing is set', () => {
    expect(store.hasSmtpPassword()).toBe(false)
  })

  it('stores and retrieves a password', () => {
    store.setSmtpPassword('secret123')
    expect(store.getSmtpPassword()).toBe('secret123')
    expect(store.hasSmtpPassword()).toBe(true)
  })

  it('clearing with empty string removes the password', () => {
    store.setSmtpPassword('secret123')
    store.setSmtpPassword('')
    expect(store.hasSmtpPassword()).toBe(false)
    expect(store.getSmtpPassword()).toBe('')
  })

  it('getSmtpPassword returns empty string when nothing stored', () => {
    expect(store.getSmtpPassword()).toBe('')
  })
})
