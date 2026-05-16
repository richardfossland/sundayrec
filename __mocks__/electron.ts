export const safeStorage = {
  isEncryptionAvailable: jest.fn(() => false),
  encryptString:  jest.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString:  jest.fn((b: Buffer) => b.toString().replace(/^enc:/, ''))
}

export const app = {
  getPath:    jest.fn(() => '/tmp/sundayrec-test'),
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
