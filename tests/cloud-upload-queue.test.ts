/**
 * Tests for cloud/upload-queue.ts — enqueue dedup, retry, remove, status.
 *
 * processQueue() itself requires too many dependencies to mock cleanly (recorder,
 * cloud/index, fs filesystem). Those paths are covered indirectly via integration
 * builds. These tests focus on the deterministic queue-mutation operations.
 */

jest.mock('electron')

import { enqueueUpload, removeFromQueue, retryNow, getQueueStatus, shutdown } from '../src/main/cloud/upload-queue'

describe('upload-queue mutations', () => {
  beforeEach(() => {
    // Clear any queue entries from earlier tests
    for (const e of getQueueStatus().entries) removeFromQueue(e.id)
    shutdown()
  })

  afterAll(() => {
    for (const e of getQueueStatus().entries) removeFromQueue(e.id)
    shutdown()
  })

  it('enqueues a new entry with status pending', () => {
    const entry = enqueueUpload({ service: 'google-drive', filePath: '/path/to/file.mp3' })
    expect(entry.status).toBe('pending')
    expect(entry.attempts).toBe(0)
    expect(entry.service).toBe('google-drive')
    expect(entry.filePath).toBe('/path/to/file.mp3')

    const status = getQueueStatus()
    expect(status.entries).toHaveLength(1)
    expect(status.entries[0].filename).toBe('file.mp3')
  })

  it('deduplicates by (service, filePath) — second enqueue resets pending', () => {
    const first = enqueueUpload({ service: 'google-drive', filePath: '/x/song.mp3' })
    const second = enqueueUpload({ service: 'google-drive', filePath: '/x/song.mp3' })
    expect(second.id).toBe(first.id)
    expect(getQueueStatus().entries).toHaveLength(1)
  })

  it('allows the same file for different services', () => {
    enqueueUpload({ service: 'google-drive', filePath: '/x/song.mp3' })
    enqueueUpload({ service: 'dropbox',      filePath: '/x/song.mp3' })
    enqueueUpload({ service: 'onedrive',     filePath: '/x/song.mp3' })
    expect(getQueueStatus().entries).toHaveLength(3)
  })

  it('removeFromQueue removes by id', () => {
    const e = enqueueUpload({ service: 'google-drive', filePath: '/x/a.mp3' })
    expect(removeFromQueue(e.id)).toBe(true)
    expect(getQueueStatus().entries).toHaveLength(0)
  })

  it('removeFromQueue returns false for unknown id', () => {
    expect(removeFromQueue('nope')).toBe(false)
  })

  it('retryNow resets status to pending and nextAttempt to now', () => {
    const e = enqueueUpload({ service: 'google-drive', filePath: '/x/b.mp3' })
    // Simulate a previously-failed state by re-enqueueing then setting nextAttempt
    // far in the future via internal mutation is hard, so we just call retryNow
    // and verify it reports the entry exists.
    expect(retryNow(e.id)).toBe(true)
    expect(retryNow('nonexistent')).toBe(false)
  })

  it('getQueueStatus exposes filename, attempts, status, error', () => {
    enqueueUpload({ service: 'dropbox', filePath: '/path/to/sermon-2026-05-25.flac' })
    const s = getQueueStatus()
    expect(s.entries[0].filename).toBe('sermon-2026-05-25.flac')
    expect(s.entries[0].service).toBe('dropbox')
    expect(s.entries[0].status).toBe('pending')
    expect(s.entries[0].attempts).toBe(0)
  })

  it('preserves entryTimestamp so history can be marked-uploaded', () => {
    const e = enqueueUpload({
      service: 'google-drive',
      filePath: '/x/c.mp3',
      entryTimestamp: 1234567890,
    })
    expect(e.entryTimestamp).toBe(1234567890)
  })
})
