/**
 * Tests for src/main/updater.ts.
 *
 * Verifies the wiring between electron-updater events and the renderer IPC
 * channels (`update-checking`, `update-available`, `update-downloaded`, etc.),
 * the macOS-specific autoDownload=false override, and the doInstall/check
 * helpers.
 *
 * Strategy:
 *   - Mock electron-updater with an EventEmitter-style autoUpdater so tests
 *     can `.emit('update-available')` and observe forwarded payloads.
 *   - Mock electron (ipcMain.handle, BrowserWindow).
 *   - Mock store so we can flip autoUpdate to test the gating.
 */

import { EventEmitter } from 'events'

// ── Mocks (declared BEFORE importing the SUT) ───────────────────────────────

// electron-updater autoUpdater: EventEmitter + fake methods.
class FakeAutoUpdater extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  checkForUpdates = jest.fn(async () => undefined)
  quitAndInstall = jest.fn()
}

const fakeAutoUpdater = new FakeAutoUpdater()

jest.mock('electron-updater', () => ({
  autoUpdater: fakeAutoUpdater,
}))

jest.mock('electron', () => ({
  ipcMain: {
    handle: jest.fn(),
    on: jest.fn(),
  },
  BrowserWindow: jest.fn(),
}))

// Store mock — flip autoUpdate setting per test.
const storeData: Record<string, unknown> = {}
jest.mock('../src/main/store', () => ({
  get: jest.fn((key: string) => storeData[key]),
}))

// ── Import the SUT (after all mocks) ────────────────────────────────────────

import * as updater from '../src/main/updater'
import { ipcMain } from 'electron'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FakeWindow {
  isDestroyed: jest.Mock
  webContents: {
    isDestroyed: jest.Mock
    send: jest.Mock
  }
}

function makeWindow(): FakeWindow {
  return {
    isDestroyed: jest.fn(() => false),
    webContents: {
      isDestroyed: jest.fn(() => false),
      send: jest.fn(),
    },
  }
}

const origPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

beforeEach(() => {
  // Reset event subscriptions between tests so we don't leak listeners.
  fakeAutoUpdater.removeAllListeners()
  fakeAutoUpdater.autoDownload = true
  fakeAutoUpdater.autoInstallOnAppQuit = true
  ;(fakeAutoUpdater.checkForUpdates as jest.Mock).mockReset().mockResolvedValue(undefined)
  ;(fakeAutoUpdater.quitAndInstall  as jest.Mock).mockReset()
  ;(ipcMain.handle as jest.Mock).mockReset()
  for (const k of Object.keys(storeData)) delete storeData[k]
})

afterAll(() => {
  setPlatform(origPlatform)
})

// ════════════════════════════════════════════════════════════════════════════
// 1. init() — platform-specific autoDownload behavior
// ════════════════════════════════════════════════════════════════════════════

describe('updater.init — autoDownload gating', () => {
  it('disables autoDownload + autoInstallOnAppQuit on macOS (unsigned ZIP fails silently)', () => {
    setPlatform('darwin')
    storeData['autoUpdate'] = true  // user wants auto, but mac override wins
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    expect(fakeAutoUpdater.autoDownload).toBe(false)
    expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('respects user autoUpdate setting on non-macOS platforms (win32)', () => {
    setPlatform('win32')
    storeData['autoUpdate'] = true
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    expect(fakeAutoUpdater.autoDownload).toBe(true)
    expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(true)
  })

  it('disables autoDownload on Windows when user opts out via store.autoUpdate=false', () => {
    setPlatform('win32')
    storeData['autoUpdate'] = false
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    expect(fakeAutoUpdater.autoDownload).toBe(false)
    expect(fakeAutoUpdater.autoInstallOnAppQuit).toBe(false)
  })

  it('defaults autoUpdate to ENABLED on win32 when store has no value', () => {
    setPlatform('win32')
    // Don't set storeData.autoUpdate — should still default to true
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    expect(fakeAutoUpdater.autoDownload).toBe(true)
  })

  it('registers a check-for-updates IPC handler', () => {
    setPlatform('win32')
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    const calls = (ipcMain.handle as jest.Mock).mock.calls
    const checkHandler = calls.find(c => c[0] === 'check-for-updates')
    expect(checkHandler).toBeDefined()
    expect(typeof checkHandler![1]).toBe('function')
  })

  it('check-for-updates IPC handler invokes autoUpdater.checkForUpdates', async () => {
    setPlatform('win32')
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    const handler = (ipcMain.handle as jest.Mock).mock.calls.find(c => c[0] === 'check-for-updates')![1]
    await handler({})
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('check-for-updates IPC handler swallows checkForUpdates errors', async () => {
    setPlatform('win32')
    ;(fakeAutoUpdater.checkForUpdates as jest.Mock).mockRejectedValueOnce(new Error('network down'))
    const win = makeWindow() as unknown as Electron.BrowserWindow
    updater.init(win)
    const handler = (ipcMain.handle as jest.Mock).mock.calls.find(c => c[0] === 'check-for-updates')![1]
    await expect(handler({})).resolves.toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Event forwarding from autoUpdater → renderer IPC
// ════════════════════════════════════════════════════════════════════════════

describe('updater.init — event forwarding to renderer', () => {
  let win: FakeWindow
  let consoleErrorSpy: jest.SpyInstance

  beforeEach(() => {
    setPlatform('win32')
    win = makeWindow()
    updater.init(win as unknown as Electron.BrowserWindow)
    // Silence the deliberate error-path console.error noise
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleErrorSpy?.mockRestore()
  })

  it('forwards "checking-for-update" → "update-checking" (no payload)', () => {
    fakeAutoUpdater.emit('checking-for-update')
    expect(win.webContents.send).toHaveBeenCalledWith('update-checking', undefined)
  })

  it('forwards "update-available" with version info payload', () => {
    const info = { version: '4.27.0', releaseDate: '2026-06-01' }
    fakeAutoUpdater.emit('update-available', info)
    expect(win.webContents.send).toHaveBeenCalledWith('update-available', info)
  })

  it('forwards "update-not-available" (silent — no payload)', () => {
    fakeAutoUpdater.emit('update-not-available')
    expect(win.webContents.send).toHaveBeenCalledWith('update-not-available', undefined)
  })

  it('forwards "download-progress" with progress payload', () => {
    const prog = { percent: 42.5, transferred: 5_000_000, total: 12_000_000, bytesPerSecond: 250_000 }
    fakeAutoUpdater.emit('download-progress', prog)
    expect(win.webContents.send).toHaveBeenCalledWith('update-download-progress', prog)
  })

  it('forwards "update-downloaded" → "update-downloaded" with info payload', () => {
    const info = { version: '4.27.0' }
    fakeAutoUpdater.emit('update-downloaded', info)
    expect(win.webContents.send).toHaveBeenCalledWith('update-downloaded', info)
  })

  it('forwards "error" → "update-error" with the error message (not the Error object)', () => {
    fakeAutoUpdater.emit('error', new Error('Signature verification failed'))
    expect(win.webContents.send).toHaveBeenCalledWith('update-error', 'Signature verification failed')
  })

  it('does not crash when an error event fires and the window is destroyed', () => {
    win.isDestroyed.mockReturnValue(true)
    expect(() => fakeAutoUpdater.emit('error', new Error('boom'))).not.toThrow()
    // send should not have been invoked when window is destroyed
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('does not crash when webContents is destroyed', () => {
    win.webContents.isDestroyed.mockReturnValue(true)
    expect(() => fakeAutoUpdater.emit('update-available', { version: 'x' })).not.toThrow()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('silently swallows exceptions thrown by webContents.send (renderer gone)', () => {
    win.webContents.send.mockImplementation(() => { throw new Error('object destroyed') })
    expect(() => fakeAutoUpdater.emit('update-available', { version: 'x' })).not.toThrow()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. doInstall() — wrapper for quitAndInstall
// ════════════════════════════════════════════════════════════════════════════

describe('updater.doInstall', () => {
  it('calls autoUpdater.quitAndInstall(isSilent=false, isForceRunAfter=true)', () => {
    updater.doInstall()
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1)
    expect(fakeAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. check() — periodic re-check helper
// ════════════════════════════════════════════════════════════════════════════

describe('updater.check', () => {
  const origEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = origEnv
  })

  it('calls autoUpdater.checkForUpdates in production', () => {
    process.env.NODE_ENV = 'production'
    updater.check()
    expect(fakeAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('skips check in development (avoids noisy updater calls during dev)', () => {
    process.env.NODE_ENV = 'development'
    updater.check()
    expect(fakeAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
  })

  it('swallows checkForUpdates exceptions (does not propagate)', () => {
    process.env.NODE_ENV = 'production'
    ;(fakeAutoUpdater.checkForUpdates as jest.Mock).mockImplementationOnce(() => {
      throw new Error('synchronous throw')
    })
    expect(() => updater.check()).not.toThrow()
  })
})
