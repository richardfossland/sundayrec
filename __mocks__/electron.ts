export const safeStorage = {
  isEncryptionAvailable: jest.fn(() => false),
  encryptString:  jest.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString:  jest.fn((b: Buffer) => b.toString().replace(/^enc:/, ''))
}

export const app = {
  getPath:    jest.fn(() => '/tmp/sundayrec-test'),
  getVersion: jest.fn(() => '3.5.0'),
  isPackaged: false
}

export const ipcMain = {
  handle: jest.fn(),
  on:     jest.fn()
}

export const powerSaveBlocker = {
  start:     jest.fn(() => 1),
  stop:      jest.fn(),
  isStarted: jest.fn(() => false)
}

// powerMonitor — minimal mock supporting on/off for the resume event.
// IMPORTANT: we use plain functions (not jest.fn) for on/off so that
// jest.clearAllMocks() does NOT wipe the implementation — only the call
// history. Tests that need to trigger a resume can call __emitResume().
type ResumeListener = () => void
const __resumeListeners: ResumeListener[] = []
function powerMonitorOn(event: string, fn: ResumeListener): void {
  if (event === 'resume') __resumeListeners.push(fn)
}
function powerMonitorOff(event: string, fn: ResumeListener): void {
  if (event !== 'resume') return
  const i = __resumeListeners.indexOf(fn)
  if (i >= 0) __resumeListeners.splice(i, 1)
}
function __emitResumeImpl(): void {
  for (const fn of [...__resumeListeners]) fn()
}
function __resetListenersImpl(): void {
  __resumeListeners.length = 0
}
export const powerMonitor = {
  on:             powerMonitorOn,
  off:            powerMonitorOff,
  removeListener: powerMonitorOff,
  __emitResume:   __emitResumeImpl,
  __resetListeners: __resetListenersImpl,
}

export const Notification = {
  isSupported: jest.fn(() => false)
}

export const BrowserWindow = jest.fn()
export const dialog = { showMessageBox: jest.fn(), showOpenDialog: jest.fn() }
export const shell = { openPath: jest.fn(), showItemInFolder: jest.fn() }
export const systemPreferences = { askForMediaAccess: jest.fn(async () => true) }
export const Tray = jest.fn()
export const Menu = { buildFromTemplate: jest.fn(() => ({})) }
export const nativeImage = { createFromPath: jest.fn(() => ({ resize: jest.fn(() => ({})) })) }
export const autoUpdater = {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  on: jest.fn(),
  checkForUpdates: jest.fn(),
  quitAndInstall: jest.fn(),
}
