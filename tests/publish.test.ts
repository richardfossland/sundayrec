/**
 * Tests for src/main/publish/index.ts — podcast publishing orchestration.
 *
 * Covers:
 *   - onCloudUploadComplete: early-return guards, happy path, error swallowing
 *   - regeneratePodcastFeed: history filtering, XML output, failure modes,
 *     feedUrl caching, empty-history case
 *
 * Mocks: store, google-drive, token-store, logger, fs.writeFileSync.
 * The mock getAccessToken is supplied per-test so the module's external
 * dependency boundary is exercised end-to-end.
 */

jest.mock('electron')

// ─── mock store ───────────────────────────────────────────────────────────────
const storeMock = {
  get:          jest.fn(),
  set:          jest.fn(),
  getHistory:   jest.fn(),
  setCloudUrl:  jest.fn(),
}
jest.mock('../src/main/store', () => storeMock)

// ─── mock cloud/google-drive ──────────────────────────────────────────────────
const gdriveMock = {
  createPublicShareUrl: jest.fn(),
  uploadFile:           jest.fn(),
}
jest.mock('../src/main/cloud/google-drive', () => gdriveMock)

// ─── mock cloud/token-store ───────────────────────────────────────────────────
const tokenStoreMock = {
  getToken: jest.fn(),
}
jest.mock('../src/main/cloud/token-store', () => tokenStoreMock)

// ─── mock logger ──────────────────────────────────────────────────────────────
const loggerMock = {
  debug: jest.fn(),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}
jest.mock('../src/main/logger', () => loggerMock)

// ─── mock fs.writeFileSync but keep the rest real ─────────────────────────────
const writeFileSyncMock = jest.fn()
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}))

import path from 'path'
import { onCloudUploadComplete, regeneratePodcastFeed } from '../src/main/publish'
import type { PodcastSettings, RecordingEntry, CloudServiceId } from '../src/types'

// ─── shared fixtures ──────────────────────────────────────────────────────────

const SAVE_FOLDER = '/tmp/sr-tests-save'

function makePodcast(overrides: Partial<PodcastSettings> = {}): PodcastSettings {
  return {
    enabled:     true,
    service:     'google-drive',
    title:       'Test Kirke',
    description: 'Testbeskrivelse',
    author:      'Test Forfatter',
    language:    'no',
    category:    'Religion & Spirituality',
    explicit:    false,
    email:       'kontakt@test.no',
    ...overrides,
  }
}

function makeEntry(overrides: Partial<RecordingEntry> = {}): RecordingEntry {
  return {
    date:          '2026-05-24',
    startTime:     '11:00',
    duration:      '00:45:00',
    filename:      'gudstjeneste-2026-05-24.mp3',
    status:        'ok',
    timestamp:     1716544800000,
    fileSizeBytes: 12_345_678,
    durationSec:   2700,
    note:          'Pinsedag',
    cloudUploaded: ['google-drive'],
    cloudUrls:     { 'google-drive': 'https://drive.google.com/uc?export=download&id=abc' },
    ...overrides,
  }
}

function getAccessToken(): Promise<string> {
  return Promise.resolve('fake-access-token')
}

// Configure store.get's default behaviour from a flat object — saves a lot of
// boilerplate per test. Anything not listed returns undefined.
function setStore(values: Partial<{ podcast: PodcastSettings; saveFolder: string | null }>): void {
  storeMock.get.mockImplementation((key: string) => {
    if (key in values) return (values as Record<string, unknown>)[key]
    return undefined
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  // Sensible default — most tests want an enabled podcast with a save folder.
  setStore({ podcast: makePodcast(), saveFolder: SAVE_FOLDER })
  storeMock.getHistory.mockReturnValue([])
  tokenStoreMock.getToken.mockReturnValue({ accessToken: 'tk', folderId: 'fld' })
  gdriveMock.createPublicShareUrl.mockResolvedValue('https://share.example/feed.xml')
  gdriveMock.uploadFile.mockResolvedValue('feed-file-id')
})

// ═════════════════════════════════════════════════════════════════════════════
// onCloudUploadComplete — early returns
// ═════════════════════════════════════════════════════════════════════════════

describe('onCloudUploadComplete — early returns', () => {
  it('returns without action when podcast.enabled is false', async () => {
    setStore({ podcast: makePodcast({ enabled: false }), saveFolder: SAVE_FOLDER })
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1, getAccessToken)
    expect(gdriveMock.createPublicShareUrl).not.toHaveBeenCalled()
    expect(storeMock.setCloudUrl).not.toHaveBeenCalled()
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns without action when podcast is undefined in store', async () => {
    setStore({ saveFolder: SAVE_FOLDER })
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1, getAccessToken)
    expect(gdriveMock.createPublicShareUrl).not.toHaveBeenCalled()
  })

  it('returns when uploaded service differs from configured podcast.service', async () => {
    setStore({ podcast: makePodcast({ service: 'google-drive' }), saveFolder: SAVE_FOLDER })
    await onCloudUploadComplete('dropbox', '/tmp/x.mp3', 'fid', 1, getAccessToken)
    expect(gdriveMock.createPublicShareUrl).not.toHaveBeenCalled()
    expect(storeMock.setCloudUrl).not.toHaveBeenCalled()
  })

  it('does not throw when share URL generation returns null', async () => {
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce(null)
    await expect(
      onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1, getAccessToken),
    ).resolves.toBeUndefined()
    expect(storeMock.setCloudUrl).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'publish',
      'share_url_failed',
      expect.objectContaining({ service: 'google-drive', fileId: 'fid' }),
    )
  })

  it('swallows and logs errors thrown by getAccessToken', async () => {
    const badGetAccessToken = jest.fn().mockRejectedValue(new Error('token-broken'))
    await expect(
      onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1, badGetAccessToken),
    ).resolves.toBeUndefined()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'publish',
      'on_upload_failed',
      expect.objectContaining({ error: 'token-broken' }),
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// onCloudUploadComplete — happy path
// ═════════════════════════════════════════════════════════════════════════════

describe('onCloudUploadComplete — happy path', () => {
  it('calls createPublicShareUrl with the access token and file id', async () => {
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce('https://share/file')
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'my-fid', 1, getAccessToken)
    expect(gdriveMock.createPublicShareUrl).toHaveBeenCalledWith('fake-access-token', 'my-fid')
  })

  it('writes the resulting URL into history via setCloudUrl', async () => {
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce('https://share/file')
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1_700_000_000_000, getAccessToken)
    expect(storeMock.setCloudUrl).toHaveBeenCalledWith(1_700_000_000_000, 'google-drive', 'https://share/file')
  })

  it('skips setCloudUrl when entryTimestamp is undefined', async () => {
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce('https://share/file')
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', undefined, getAccessToken)
    expect(storeMock.setCloudUrl).not.toHaveBeenCalled()
  })

  it('triggers regeneratePodcastFeed after share URL is stored (fs write happens)', async () => {
    storeMock.getHistory.mockReturnValue([makeEntry()])
    await onCloudUploadComplete('google-drive', '/tmp/x.mp3', 'fid', 1, getAccessToken)
    // The feed regeneration writes podcast.xml — proof we reached step 2.
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      path.join(SAVE_FOLDER, 'podcast.xml'),
      expect.stringContaining('<?xml'),
      'utf-8',
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// regeneratePodcastFeed — history filtering
// ═════════════════════════════════════════════════════════════════════════════

describe('regeneratePodcastFeed — filtering', () => {
  it('includes only entries with status === "ok"', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'good.mp3' }),
      makeEntry({ filename: 'failed.mp3', status: 'error', timestamp: 1716544800001 }),
    ])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.episodeCount).toBe(1)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).toContain('good')
    expect(xml).not.toContain('failed')
  })

  it('includes only entries where cloudUploaded contains the configured service', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'gd.mp3' }),
      makeEntry({
        filename:      'db.mp3',
        timestamp:     1716544800111,
        cloudUploaded: ['dropbox'],
        cloudUrls:     { 'dropbox': 'https://dropbox.com/file' },
      }),
    ])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.episodeCount).toBe(1)
  })

  it('includes only entries with a cloudUrls value for the service', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'has-url.mp3' }),
      makeEntry({
        filename:   'no-url.mp3',
        timestamp:  1716544800222,
        cloudUrls:  {},  // marked uploaded but URL never captured (race)
      }),
    ])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.episodeCount).toBe(1)
  })

  it('includes only entries with a non-null timestamp', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'has-ts.mp3' }),
      makeEntry({ filename: 'no-ts.mp3', timestamp: undefined }),
    ])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.episodeCount).toBe(1)
  })

  it('sorts episodes newest-first by timestamp', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'older.mp3', timestamp: 1_700_000_000_000 }),
      makeEntry({ filename: 'newest.mp3', timestamp: 1_900_000_000_000 }),
      makeEntry({ filename: 'middle.mp3', timestamp: 1_800_000_000_000 }),
    ])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    const newestPos = xml.indexOf('newest')
    const middlePos = xml.indexOf('middle')
    const olderPos  = xml.indexOf('older')
    expect(newestPos).toBeGreaterThan(-1)
    expect(middlePos).toBeGreaterThan(newestPos)
    expect(olderPos).toBeGreaterThan(middlePos)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// regeneratePodcastFeed — XML output
// ═════════════════════════════════════════════════════════════════════════════

describe('regeneratePodcastFeed — XML output', () => {
  it('writes podcast.xml to the configured saveFolder', async () => {
    storeMock.getHistory.mockReturnValue([makeEntry()])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
    expect(writeFileSyncMock.mock.calls[0][0]).toBe(path.join(SAVE_FOLDER, 'podcast.xml'))
    expect(writeFileSyncMock.mock.calls[0][2]).toBe('utf-8')
  })

  it('XML contains the configured podcast title / author / description / language / email', async () => {
    setStore({
      podcast: makePodcast({
        title:       'Min Kirke',
        author:      'Forfatteren',
        description: 'Den fineste beskrivelse',
        language:    'sv',
        email:       'admin@min.no',
        category:    'Religion & Spirituality',
      }),
      saveFolder: SAVE_FOLDER,
    })
    storeMock.getHistory.mockReturnValue([])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).toContain('<title>Min Kirke</title>')
    expect(xml).toContain('<itunes:author>Forfatteren</itunes:author>')
    expect(xml).toContain('<description>Den fineste beskrivelse</description>')
    expect(xml).toContain('<language>sv</language>')
    expect(xml).toContain('<itunes:email>admin@min.no</itunes:email>')
    expect(xml).toContain('<itunes:category text="Religion &amp; Spirituality"/>')
  })

  it('falls back to default channel fields when podcast settings are empty', async () => {
    setStore({
      podcast: makePodcast({ title: '', description: '', author: '', language: '', category: '' }),
      saveFolder: SAVE_FOLDER,
    })
    storeMock.getHistory.mockReturnValue([])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).toContain('<title>SundayRec</title>')
    expect(xml).toContain('<language>no</language>')
    expect(xml).toContain('<itunes:category text="Religion &amp; Spirituality"/>')
  })

  it('each episode includes the audioUrl, bytes and duration from the entry', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({
        filename:      'rec.mp3',
        fileSizeBytes: 7_654_321,
        durationSec:   1234,
        cloudUrls:     { 'google-drive': 'https://example.com/rec.mp3' },
      }),
    ])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).toContain('https://example.com/rec.mp3')
    expect(xml).toContain('length="7654321"')
    // duration may render as seconds or HH:MM:SS — either should embed 1234 somewhere
    expect(xml).toMatch(/1234|00:20:34/)
  })

  it('strips the file extension from episode titles', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ filename: 'søndag-17-mai.mp3' }),
    ])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).toContain('<title>søndag-17-mai</title>')
    expect(xml).not.toContain('søndag-17-mai.mp3<')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// regeneratePodcastFeed — failure modes
// ═════════════════════════════════════════════════════════════════════════════

describe('regeneratePodcastFeed — failure modes', () => {
  it('returns podcast_disabled when podcast.enabled is false', async () => {
    setStore({ podcast: makePodcast({ enabled: false }), saveFolder: SAVE_FOLDER })
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res).toEqual({ ok: false, episodeCount: 0, error: 'podcast_disabled' })
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns podcast_disabled when podcast is undefined', async () => {
    setStore({ saveFolder: SAVE_FOLDER })
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('podcast_disabled')
  })

  it('returns no_save_folder when saveFolder is null', async () => {
    setStore({ podcast: makePodcast(), saveFolder: null })
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('no_save_folder')
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it('returns write_failed when fs.writeFileSync throws', async () => {
    writeFileSyncMock.mockImplementationOnce(() => {
      throw new Error('EROFS: read-only filesystem')
    })
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('write_failed')
    expect(loggerMock.error).toHaveBeenCalledWith(
      'publish',
      'write_local_failed',
      expect.objectContaining({ error: expect.stringContaining('EROFS') }),
    )
  })

  it('returns not_connected when tokenStore.getToken returns null', async () => {
    tokenStoreMock.getToken.mockReturnValue(null)
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('not_connected')
    // We still wrote the local copy before attempting upload
    expect(writeFileSyncMock).toHaveBeenCalled()
  })

  it('returns upload_failed when uploadFile resolves null', async () => {
    gdriveMock.uploadFile.mockResolvedValueOnce(null)
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('upload_failed')
  })

  it('returns the thrown error message when uploadFile rejects', async () => {
    gdriveMock.uploadFile.mockRejectedValueOnce(new Error('drive-down'))
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('drive-down')
    expect(loggerMock.error).toHaveBeenCalledWith(
      'publish',
      'feed_upload_failed',
      expect.objectContaining({ error: 'drive-down' }),
    )
  })

  it('returns upload_failed-style result for non-google-drive service (no uploader wired)', async () => {
    setStore({ podcast: makePodcast({ service: 'dropbox' }), saveFolder: SAVE_FOLDER })
    const res = await regeneratePodcastFeed('dropbox' as CloudServiceId, getAccessToken)
    // dropbox/onedrive uploaders are stubs — return null → 'upload_failed'
    expect(res.ok).toBe(false)
    expect(res.error).toBe('upload_failed')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// regeneratePodcastFeed — feedUrl caching
// ═════════════════════════════════════════════════════════════════════════════

describe('regeneratePodcastFeed — feedUrl caching', () => {
  it('writes the new feedUrl back to podcast settings via store.set', async () => {
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce('https://share/feed-new')
    storeMock.getHistory.mockReturnValue([])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(true)
    expect(res.feedUrl).toBe('https://share/feed-new')
    expect(storeMock.set).toHaveBeenCalledWith('podcast', expect.objectContaining({
      feedUrl: 'https://share/feed-new',
    }))
  })

  it('does NOT call store.set when the resolved feedUrl equals the existing one', async () => {
    const existingUrl = 'https://share/feed-same'
    setStore({ podcast: makePodcast({ feedUrl: existingUrl }), saveFolder: SAVE_FOLDER })
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce(existingUrl)
    storeMock.getHistory.mockReturnValue([])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(true)
    expect(storeMock.set).not.toHaveBeenCalled()
  })

  it('still returns ok:true even when share-URL helper returns null', async () => {
    // upload succeeded but the share-link call failed → ok:true with no feedUrl
    gdriveMock.createPublicShareUrl.mockResolvedValueOnce(null)
    storeMock.getHistory.mockReturnValue([])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(true)
    expect(res.feedUrl).toBeUndefined()
    expect(storeMock.set).not.toHaveBeenCalled()
  })

  it('passes the configured folderId from tokenStore through to uploadFile', async () => {
    tokenStoreMock.getToken.mockReturnValue({ accessToken: 'tk', folderId: 'special-folder' })
    storeMock.getHistory.mockReturnValue([])
    await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(gdriveMock.uploadFile).toHaveBeenCalledWith(
      'fake-access-token',
      path.join(SAVE_FOLDER, 'podcast.xml'),
      'special-folder',
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Integration: empty history
// ═════════════════════════════════════════════════════════════════════════════

describe('regeneratePodcastFeed — empty history', () => {
  it('produces a valid XML feed with zero episodes', async () => {
    storeMock.getHistory.mockReturnValue([])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.ok).toBe(true)
    expect(res.episodeCount).toBe(0)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml.startsWith('<?xml')).toBe(true)
    expect(xml).toContain('<rss')
    expect(xml.trim().endsWith('</rss>')).toBe(true)
    expect(xml).not.toContain('<item>')
  })

  it('does not include episodes when every history entry is filtered out', async () => {
    storeMock.getHistory.mockReturnValue([
      makeEntry({ status: 'error' }),
      makeEntry({ timestamp: undefined }),
      makeEntry({ cloudUploaded: [] }),
    ])
    const res = await regeneratePodcastFeed('google-drive', getAccessToken)
    expect(res.episodeCount).toBe(0)
    const xml = writeFileSyncMock.mock.calls[0][1] as string
    expect(xml).not.toContain('<item>')
  })
})
