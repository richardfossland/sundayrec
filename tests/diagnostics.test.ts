/**
 * Tests for the diagnostics report builder.
 *
 * We mock electron (app, clipboard) and native-recorder (heavy ffmpeg subprocess
 * calls) so the tests are fast and hermetic. The goal is to verify:
 *   - sanitizeSettings strips sensitive fields
 *   - Report sections are present when tests pass / fail
 *   - Desktop save path and clipboard copy are attempted
 *   - Video section shows "not enabled" when videoEnabled = false
 */

jest.mock('electron', () => ({
  app: {
    getVersion: () => '4.22.0-test',
    getPath: (name: string) => name === 'desktop' ? '/tmp/desktop-mock' : '/tmp',
  },
  clipboard: { writeText: jest.fn() },
}))

jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg')

// Mock fs so Desktop save succeeds without touching the real filesystem
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 8192 }),
  unlinkSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
}))

// Mock child_process.spawn so no real ffmpeg is started
const mockSpawn = jest.fn()
jest.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

import { EventEmitter } from 'events'

function makeFakeProc(stdoutData?: string, stderrData?: string, exitCode = 0) {
  const proc = new EventEmitter() as ReturnType<typeof mockSpawn>
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.exitCode = null
  proc.killed = false
  proc.kill = jest.fn()
  // Emit data and close asynchronously
  setImmediate(() => {
    if (stdoutData) proc.stdout.emit('data', Buffer.from(stdoutData))
    if (stderrData) proc.stderr.emit('data', Buffer.from(stderrData))
    proc.emit('close', exitCode)
  })
  return proc
}

// A minimal Settings object for tests
const BASE_SETTINGS = {
  language: 'no',
  deviceId: null,
  deviceName: 'Test Microphone',
  deviceChannels: {},
  channels: 'stereo' as const,
  sampleRate: 48000,
  inputVolume: 100,
  eqBass: 0, eqMid: 0, eqTreble: 0,
  compEnabled: false, compThreshold: -20, compRatio: 4, compAttack: 5, compRelease: 100,
  limiterEnabled: false, limiterCeiling: -1,
  format: 'mp3' as const,
  bitrate: '192k',
  filenamePattern: 'date' as const,
  saveFolder: null,
  autoDeleteDays: 0,
  slots: [],
  specialRecordings: [],
  stopOnSilence: false,
  splitMinutes: 0,
  reminderMinutes: 0,
  manualMaxMinutes: 0,
  preRollSeconds: 0,
  launchAtLogin: false,
  showOnStartup: true,
  minimizeToTray: false,
  wakeFromSleep: false,
  protectRecording: false,
  notifyStart: true,
  notifyStop: true,
  emailOnError: false,
  emailAddress: 'user@example.com',  // sensitive — should be excluded
  emailSmtp: 'smtp.example.com',     // sensitive — should be excluded
  emailSmtpPort: 587,
  emailSmtpUser: 'user',
  emailSmtpPass: 'secret123',        // sensitive — must NEVER appear in report
  churchName: 'TestKirke',
  responsiblePerson: 'Ola Nordmann',
  autoUpdate: true,
  videoEnabled: false,
}

// ── Mock resolveDeviceInput ────────────────────────────────────────────────────
//
// diagnostics.ts uses dynamic import('./native-recorder') so we mock the whole module.

const mockResolveDeviceInput = jest.fn().mockResolvedValue({
  format: 'avfoundation',
  device: ':0',
  resolvedName: 'Test Microphone',
})
const mockResolveVideoInput = jest.fn().mockResolvedValue({
  format: 'avfoundation',
  device: '0',
  resolvedName: 'FaceTime HD Camera',
})

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/bin/ffmpeg',
  listFfmpegDevices: jest.fn().mockResolvedValue([
    { name: 'Test Microphone', index: 0 },
    { name: 'USB Audio CODEC', index: 1 },
  ]),
  listWasapiDevices: jest.fn().mockResolvedValue([]),
  listVideoFfmpegDevices: jest.fn().mockResolvedValue([
    { name: 'FaceTime HD Camera', index: 0 },
  ]),
  probeWasapiAvailable: jest.fn().mockResolvedValue(false),
  resolveDeviceInput: (...args: unknown[]) => mockResolveDeviceInput(...args),
  resolveVideoInput:  (...args: unknown[]) => mockResolveVideoInput(...args),
}))

jest.mock('../src/main/video-preview', () => ({
  isPreviewRunning:    jest.fn().mockReturnValue(false),
  stopPreview:         jest.fn(),
  startPreview:        jest.fn().mockResolvedValue(true),
  getWorkingMacConfigIdx: jest.fn().mockReturnValue(0),
  buildMacInputArgs:   jest.fn().mockReturnValue(['-f', 'avfoundation', '-framerate', '5', '-i', '0']),
  MAC_CONFIGS: [{ label: '30fps', framerate: 30 }],
}))

import { runDiagnostics } from '../src/main/diagnostics'
import { clipboard } from 'electron'

afterAll(() => { jest.clearAllTimers() })

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeCaptureProc(fileSizeBytes = 8192) {
  // statSync is already mocked globally to return { size: 8192 }
  return makeFakeProc(undefined, 'frame=  10 fps= 10 size=8kB', 0)
}
function makeFailedCaptureProc() {
  return makeFakeProc(undefined, 'No such device or address', 1)
}
function makeVersionProc() {
  return makeFakeProc('ffmpeg version 6.0.1-static build')
}

// ─── Report structure ─────────────────────────────────────────────────────────

describe('runDiagnostics — report structure', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Default spawn: version query → ok; audio capture → ok
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeCaptureProc()
    })
  })

  it('includes the app version header', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('4.22.0-test')
  })

  it('includes the ffmpeg version', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('6.0.1-static')
  })

  it('includes OS and platform info', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('Platform')
    expect(result.markdown).toMatch(/OS:|darwin|linux|win32/i)
  })

  it('includes all settings section as JSON block', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('## Innstillinger')
    expect(result.markdown).toContain('```json')
    expect(result.markdown).toContain('"deviceName": "Test Microphone"')
    expect(result.markdown).toContain('"churchName": "TestKirke"')
  })

  it('NEVER includes email password in the report', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).not.toContain('secret123')
    expect(result.markdown).not.toContain('emailSmtpPass')
  })

  it('NEVER includes email address or SMTP fields in the report', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).not.toContain('user@example.com')
    expect(result.markdown).not.toContain('smtp.example.com')
  })

  it('includes audio device list', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('Test Microphone')
    expect(result.markdown).toContain('USB Audio CODEC')
  })

  it('includes video device list', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('FaceTime HD Camera')
  })
})

// ─── Audio capture test section ───────────────────────────────────────────────

describe('runDiagnostics — audio capture test result', () => {
  it('shows ✅ OK when audio capture succeeds', async () => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeCaptureProc()
    })
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toMatch(/Lydopptakstest.*\n[\s\S]*?✅ OK/)
    expect(result.captureOk).toBe(true)
  })

  it('shows ❌ Feil when audio capture fails (exit code 1)', async () => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeFailedCaptureProc()
    })
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toMatch(/Lydopptakstest[\s\S]*?❌ Feil/)
    expect(result.captureOk).toBe(false)
  })

  it('includes error snippet from ffmpeg stderr on failure', async () => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeFailedCaptureProc()
    })
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('No such device or address')
  })
})

// ─── Video capture test section ───────────────────────────────────────────────

describe('runDiagnostics — video capture test result', () => {
  it('shows "Video ikke aktivert" when videoEnabled = false', async () => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeCaptureProc()
    })
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.markdown).toContain('Video ikke aktivert')
  })

  it('shows ✅ OK when video capture succeeds (videoEnabled = true)', async () => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeCaptureProc()
    })
    const settings = { ...BASE_SETTINGS, videoEnabled: true, videoDeviceName: 'FaceTime HD Camera' }
    const result = await runDiagnostics(settings as never)
    expect(result.markdown).toMatch(/Videoopptakstest[\s\S]*?✅ OK/)
  })

  it('shows ❌ Feil when video capture fails', async () => {
    let captureCount = 0
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      captureCount++
      // First capture (audio) succeeds, second (video) fails
      return captureCount === 1 ? makeCaptureProc() : makeFailedCaptureProc()
    })
    const settings = { ...BASE_SETTINGS, videoEnabled: true, videoDeviceName: 'FaceTime HD Camera' }
    const result = await runDiagnostics(settings as never)
    expect(result.markdown).toMatch(/Videoopptakstest[\s\S]*?❌ Feil/)
  })
})

// ─── File save + clipboard ────────────────────────────────────────────────────

describe('runDiagnostics — save and clipboard', () => {
  beforeEach(() => {
    mockSpawn.mockImplementation((bin: string, args: string[]) => {
      if (args[0] === '-version') return makeVersionProc()
      return makeCaptureProc()
    })
  })

  it('saves a .md file to the Desktop path', async () => {
    const { writeFileSync } = require('fs')
    await runDiagnostics(BASE_SETTINGS as never)
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('SundayRec-diagnose-'),
      expect.stringContaining('# SundayRec Diagnostics'),
      'utf8'
    )
  })

  it('returns savedTo path pointing to desktop mock', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(result.savedTo).toMatch(/desktop-mock.*SundayRec-diagnose-.*\.md/)
  })

  it('copies the full report to the clipboard', async () => {
    const result = await runDiagnostics(BASE_SETTINGS as never)
    expect(clipboard.writeText).toHaveBeenCalledWith(result.markdown)
    expect(result.clipboardOk).toBe(true)
  })
})
