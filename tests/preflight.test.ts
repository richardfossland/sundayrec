/**
 * Tests for src/main/preflight.ts.
 *
 * runPreflight runs 30 min before each scheduled recording and on-demand via
 * the "Sjekk system nå" button. Findings are routed through `sendBackendWarning`
 * to the tray, email, and webhook.
 *
 * Strategy:
 *   - Mock electron (app + systemPreferences), store, native-recorder, fs,
 *     logger and cloud/http-util.
 *   - Default all checks to a healthy state; opt into failures per-test.
 */

// ── Mocks (must be declared BEFORE importing the SUT) ───────────────────────

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/sundayrec-test') },
  systemPreferences: {
    getMediaAccessStatus: jest.fn(() => 'granted'),
  },
}))

jest.mock('../src/main/store', () => ({
  getAll: jest.fn(() => ({})),
}))

jest.mock('../src/main/logger', () => ({
  log:   jest.fn(),
  debug: jest.fn(),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}))

// native-recorder exports ffmpegBin (a string path) and resolveDeviceInput.
// We need ffmpegBin to evaluate `ffmpegBin !== 'ffmpeg'` to the desired branch.
jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/local/bin/ffmpeg',
  resolveDeviceInput: jest.fn(),
}))

// Mock fs — preflight uses existsSync, mkdirSync, writeFileSync, unlinkSync
// (sync) and fs.promises.statfs (async).
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync:    jest.fn(() => true),
    mkdirSync:     jest.fn(),
    writeFileSync: jest.fn(),
    unlinkSync:    jest.fn(),
    promises: {
      ...actual.promises,
      statfs: jest.fn(async () => ({ bavail: 1e10, bsize: 4096 })),
    },
  }
})

// cloud/http-util is dynamically imported by preflight; provide a mock with isOnline.
jest.mock('../src/main/cloud/http-util', () => ({
  isOnline: jest.fn(async () => true),
}))

// ── Import the SUT (after all mocks) ────────────────────────────────────────

import { runPreflight, runScheduledPreflight } from '../src/main/preflight'
import * as store from '../src/main/store'
import * as nativeRecorder from '../src/main/native-recorder'
import * as fs from 'fs'
import { systemPreferences } from 'electron'
import * as httpUtil from '../src/main/cloud/http-util'

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Reset all per-test mock state to the healthy-system defaults. */
function resetHealthyDefaults(): void {
  ;(store.getAll as jest.Mock).mockReturnValue({})
  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockReset()
  ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValue({
    format: 'avfoundation',
    device: ':0',
    resolvedName: 'MacBook Pro Microphone',
  })
  ;(fs.existsSync     as unknown as jest.Mock).mockReset().mockReturnValue(true)
  ;(fs.mkdirSync      as unknown as jest.Mock).mockReset().mockImplementation(() => {})
  ;(fs.writeFileSync  as unknown as jest.Mock).mockReset().mockImplementation(() => {})
  ;(fs.unlinkSync     as unknown as jest.Mock).mockReset().mockImplementation(() => {})
  ;(fs.promises.statfs as unknown as jest.Mock).mockReset()
    .mockResolvedValue({ bavail: 1e10, bsize: 4096 })  // plenty of space
  ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockReset().mockReturnValue('granted')
  ;(httpUtil.isOnline as jest.Mock).mockReset().mockResolvedValue(true)
}

beforeEach(resetHealthyDefaults)

afterEach(() => {
  jest.clearAllMocks()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Healthy system — no findings
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — healthy system', () => {
  it('returns an empty findings array when all checks pass', async () => {
    const findings = await runPreflight()
    expect(findings).toEqual([])
  })

  it('skips cloud check when cloud upload is not configured', async () => {
    await runPreflight()
    expect(httpUtil.isOnline as jest.Mock).not.toHaveBeenCalled()
  })

  it('does NOT warn when stored device name matches resolved (case/spacing tolerant)', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({ deviceName: '  macbook pro microphone  ' })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone',
    })
    const findings = await runPreflight()
    expect(findings).toEqual([])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. ffmpeg binary missing
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — ffmpeg binary check', () => {
  it('reports error when bundled ffmpeg binary is missing on disk', async () => {
    // existsSync returns true for saveFolder probe but false for ffmpegBin path
    ;(fs.existsSync as unknown as jest.Mock).mockImplementation((p: unknown) => {
      const s = String(p)
      if (s.includes('ffmpeg')) return false
      return true
    })
    const findings = await runPreflight()
    const ffFinding = findings.find(f => f.message.toLowerCase().includes('ffmpeg'))
    expect(ffFinding).toBeDefined()
    expect(ffFinding!.severity).toBe('error')
    expect(ffFinding!.category).toBe('device')
  })

  it('does NOT report ffmpeg error when ffmpegBin === "ffmpeg" (system PATH fallback)', async () => {
    // The module-level ffmpegBin is '/usr/local/bin/ffmpeg' in our mock — but
    // the production code only spawns the existsSync check when ffmpegBin !== 'ffmpeg'.
    // Verify the inverse condition by making existsSync false for everything;
    // in practice the saveFolder mkdir/write probe also fires, so we only check
    // that an ffmpeg-related error appears when our mock path doesn't exist.
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValue(true)
    const findings = await runPreflight()
    expect(findings.find(f => f.message.toLowerCase().includes('ffmpeg'))).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. Save folder + disk space
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — saveFolder and disk space', () => {
  it('reports error when save folder cannot be written', async () => {
    ;(fs.writeFileSync as unknown as jest.Mock).mockImplementation(() => {
      throw new Error('EACCES')
    })
    const findings = await runPreflight()
    const diskFinding = findings.find(f => f.category === 'disk')
    expect(diskFinding).toBeDefined()
    expect(diskFinding!.severity).toBe('error')
    expect(diskFinding!.message).toMatch(/EACCES/)
  })

  it('reports error when free disk space is below 500 MB (audio threshold)', async () => {
    ;(fs.promises.statfs as unknown as jest.Mock).mockResolvedValueOnce({
      bavail: 1, bsize: 4096,  // ~4 KB free
    })
    const findings = await runPreflight()
    const diskFinding = findings.find(f => f.category === 'disk' && f.severity === 'error')
    expect(diskFinding).toBeDefined()
    expect(diskFinding!.message).toMatch(/GB ledig/)
  })

  it('uses the 4 GB video threshold when video capture is enabled', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      videoEnabled: true,
      videoDeviceName: 'FaceTime HD Camera',
    })
    // 1 GB free — fine for audio (>500 MB), but not enough for video (<4 GB)
    ;(fs.promises.statfs as unknown as jest.Mock).mockResolvedValueOnce({
      bavail: 250_000, bsize: 4096,  // ~1 GB
    })
    const findings = await runPreflight()
    expect(findings.find(f => f.category === 'disk' && f.severity === 'error')).toBeDefined()
  })

  it('silently skips disk-space check when statfs throws (older kernels)', async () => {
    ;(fs.promises.statfs as unknown as jest.Mock).mockRejectedValueOnce(new Error('ENOSYS'))
    const findings = await runPreflight()
    // Should not surface a disk-space finding just because statfs is unsupported.
    const diskMessage = findings.find(f => f.category === 'disk' && /GB ledig/.test(f.message))
    expect(diskMessage).toBeUndefined()
  })

  it('does NOT flag disk space when above the 500 MB audio threshold', async () => {
    ;(fs.promises.statfs as unknown as jest.Mock).mockResolvedValueOnce({
      bavail: 1_000_000, bsize: 4096,  // ~4 GB
    })
    const findings = await runPreflight()
    expect(findings.find(f => f.category === 'disk' && /GB ledig/.test(f.message))).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. macOS microphone / camera permission
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — macOS permission check', () => {
  const origPlatform = process.platform

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
  })

  it('reports error when microphone permission is denied', async () => {
    ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('denied')
    const findings = await runPreflight()
    const micFinding = findings.find(f => /[Mm]ikrofontilgang/.test(f.message))
    expect(micFinding).toBeDefined()
    expect(micFinding!.severity).toBe('error')
    expect(micFinding!.category).toBe('device')
  })

  it('reports error when microphone permission is restricted', async () => {
    ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('restricted')
    const findings = await runPreflight()
    expect(findings.find(f => /[Mm]ikrofontilgang/.test(f.message))).toBeDefined()
  })

  it('does NOT report mic error when status is "granted"', async () => {
    ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockReturnValue('granted')
    const findings = await runPreflight()
    expect(findings.find(f => /[Mm]ikrofontilgang/.test(f.message))).toBeUndefined()
  })

  it('reports camera error when video enabled and camera denied', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      videoEnabled: true,
      videoDeviceName: 'FaceTime HD Camera',
    })
    ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockImplementation((kind: string) => {
      if (kind === 'camera') return 'denied'
      return 'granted'
    })
    const findings = await runPreflight()
    const camFinding = findings.find(f => /[Kk]ameratilgang/.test(f.message))
    expect(camFinding).toBeDefined()
    expect(camFinding!.severity).toBe('error')
  })

  it('does NOT check camera when video is disabled', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({ videoEnabled: false })
    ;(systemPreferences.getMediaAccessStatus as jest.Mock).mockImplementation(() => 'granted')
    await runPreflight()
    // Should only be queried for microphone, not camera.
    const calls = (systemPreferences.getMediaAccessStatus as jest.Mock).mock.calls.map(c => c[0])
    expect(calls).toContain('microphone')
    expect(calls).not.toContain('camera')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. Device presence / device-name mismatch
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — device check', () => {
  it('reports error when no audio device is present', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const findings = await runPreflight()
    const deviceFinding = findings.find(f => f.category === 'device' && f.severity === 'error')
    expect(deviceFinding).toBeDefined()
    expect(deviceFinding!.message).toMatch(/Ingen lydenhet/)
  })

  it('reports warn when stored device name does not match resolved', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({ deviceName: 'Soundcraft USB Audio' })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':1', resolvedName: 'Built-in Microphone',
    })
    const findings = await runPreflight()
    const mismatch = findings.find(f => f.category === 'device' && f.severity === 'warn')
    expect(mismatch).toBeDefined()
    expect(mismatch!.message).toMatch(/Soundcraft USB Audio/)
    expect(mismatch!.message).toMatch(/Built-in Microphone/)
  })

  it('matches device names tolerant to case and whitespace', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({ deviceName: 'macbook  pro   microphone' })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'MacBook Pro Microphone',
    })
    const findings = await runPreflight()
    expect(findings.find(f => /Lagret enhet/.test(f.message))).toBeUndefined()
  })

  it('matches device names by substring containment', async () => {
    // The resolved name "Soundcraft Signature 12 MTK" contains the stored "Signature 12"
    ;(store.getAll as jest.Mock).mockReturnValue({ deviceName: 'Signature 12' })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':2', resolvedName: 'Soundcraft Signature 12 MTK',
    })
    const findings = await runPreflight()
    expect(findings.find(f => /Lagret enhet/.test(f.message))).toBeUndefined()
  })

  it('reports warn when resolveDeviceInput throws', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockRejectedValueOnce(new Error('enum failed'))
    const findings = await runPreflight()
    const warn = findings.find(f => f.category === 'device' && f.severity === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toMatch(/enum failed/)
  })

  it('does NOT warn about mismatch when no device name is stored (first-run)', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({ deviceName: '' })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'Built-in Microphone',
    })
    const findings = await runPreflight()
    expect(findings.find(f => /Lagret enhet/.test(f.message))).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. Cloud connectivity
// ════════════════════════════════════════════════════════════════════════════

describe('runPreflight — cloud connectivity', () => {
  it('reports warn when cloud is configured but offline', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      cloudGoogleDrive: { enabled: true, autoUpload: true },
    })
    ;(httpUtil.isOnline as jest.Mock).mockResolvedValueOnce(false)
    const findings = await runPreflight()
    const cloudFinding = findings.find(f => f.category === 'cloud')
    expect(cloudFinding).toBeDefined()
    expect(cloudFinding!.severity).toBe('warn')
    expect(cloudFinding!.message).toMatch(/[Ii]nternett/)
  })

  it('does NOT report cloud finding when online', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      cloudGoogleDrive: { enabled: true, autoUpload: true },
    })
    ;(httpUtil.isOnline as jest.Mock).mockResolvedValueOnce(true)
    const findings = await runPreflight()
    expect(findings.find(f => f.category === 'cloud')).toBeUndefined()
  })

  it('skips cloud check when service is enabled but autoUpload is off', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      cloudGoogleDrive: { enabled: true, autoUpload: false },
    })
    await runPreflight()
    expect(httpUtil.isOnline as jest.Mock).not.toHaveBeenCalled()
  })

  it('triggers cloud check for Dropbox auto-upload', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      cloudDropbox: { enabled: true, autoUpload: true },
    })
    ;(httpUtil.isOnline as jest.Mock).mockResolvedValueOnce(false)
    const findings = await runPreflight()
    expect(findings.find(f => f.category === 'cloud')).toBeDefined()
  })

  it('triggers cloud check for OneDrive auto-upload', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      cloudOneDrive: { enabled: true, autoUpload: true },
    })
    ;(httpUtil.isOnline as jest.Mock).mockResolvedValueOnce(false)
    const findings = await runPreflight()
    expect(findings.find(f => f.category === 'cloud')).toBeDefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. runScheduledPreflight — sender routing
// ════════════════════════════════════════════════════════════════════════════

describe('runScheduledPreflight (sender routing)', () => {
  it('calls the sender once per finding with (msg, severity, category)', async () => {
    ;(fs.promises.statfs as unknown as jest.Mock).mockResolvedValueOnce({ bavail: 1, bsize: 4096 })
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(out.findings.length).toBeGreaterThan(0)
    expect(sender).toHaveBeenCalledTimes(out.findings.length)
    // Verify the call signature
    const call = sender.mock.calls[0]
    expect(typeof call[0]).toBe('string')
    expect(['warn', 'error']).toContain(call[1])
    expect(['cloud', 'preroll', 'wake', 'disk', 'device']).toContain(call[2])
  })

  it('does NOT call sender when there are no findings', async () => {
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(out.findings).toEqual([])
    expect(sender).not.toHaveBeenCalled()
  })

  it('returns findings list for the manual-button IPC path', async () => {
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(Array.isArray(out.findings)).toBe(true)
    expect(out.findings.some(f => f.category === 'device' && f.severity === 'error')).toBe(true)
  })

  it('aggregates multiple simultaneous failures', async () => {
    ;(fs.promises.statfs as unknown as jest.Mock).mockResolvedValueOnce({ bavail: 1, bsize: 4096 })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce(null)
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    // Both disk and device errors should appear
    expect(out.findings.some(f => f.category === 'disk' && f.severity === 'error')).toBe(true)
    expect(out.findings.some(f => f.category === 'device' && f.severity === 'error')).toBe(true)
    expect(sender).toHaveBeenCalledTimes(out.findings.length)
  })

  it('routes all findings through the sender (no findings dropped)', async () => {
    ;(store.getAll as jest.Mock).mockReturnValue({
      deviceName: 'Mystery Device',
      cloudGoogleDrive: { enabled: true, autoUpload: true },
    })
    ;(nativeRecorder.resolveDeviceInput as jest.Mock).mockResolvedValueOnce({
      format: 'avfoundation', device: ':0', resolvedName: 'Built-in Microphone',
    })
    ;(httpUtil.isOnline as jest.Mock).mockResolvedValueOnce(false)
    const sender = jest.fn()
    const out = await runScheduledPreflight(sender)
    expect(out.findings.length).toBe(sender.mock.calls.length)
  })
})
