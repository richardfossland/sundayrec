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
