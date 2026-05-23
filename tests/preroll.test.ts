jest.mock('electron')
jest.mock('electron-store')

jest.mock('child_process', () => ({
  spawn: jest.fn(() => ({
    stdin:    { write: jest.fn(), end: jest.fn() },
    stdout:   null,
    stderr:   null,
    exitCode: null,
    pid:      1234,
    kill:     jest.fn(),
    once:     jest.fn(),
    on:       jest.fn(),
  })),
  execFile: jest.fn(),
}))

jest.mock('fs', () => ({
  existsSync:  jest.fn(() => false),
  statSync:    jest.fn(() => ({ size: 0 })),
  promises:    { unlink: jest.fn(() => Promise.resolve()) },
}))

jest.mock('../src/main/store', () => ({
  get: jest.fn(() => null),
  set: jest.fn(),
}))

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin:          '/usr/bin/ffmpeg',
  resolveDeviceInput: jest.fn(async () => null),
}))

// ─── smoke test ──────────────────────────────────────────────────────────────

describe('preroll module', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('loads without throwing', () => {
    expect(() => require('../src/main/preroll')).not.toThrow()
  })

  it('exports isRunning as a function', () => {
    const preroll = require('../src/main/preroll')
    expect(typeof preroll.isRunning).toBe('function')
  })

  it('exports start as a function', () => {
    const preroll = require('../src/main/preroll')
    expect(typeof preroll.start).toBe('function')
  })

  it('exports harvest as a function', () => {
    const preroll = require('../src/main/preroll')
    expect(typeof preroll.harvest).toBe('function')
  })

  it('exports stop as a function', () => {
    const preroll = require('../src/main/preroll')
    expect(typeof preroll.stop).toBe('function')
  })
})

// ─── isRunning ────────────────────────────────────────────────────────────────

describe('preroll.isRunning', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('returns false before start is called', () => {
    const { isRunning } = require('../src/main/preroll')
    expect(isRunning()).toBe(false)
  })
})

// ─── harvest with no active preroll ──────────────────────────────────────────

describe('preroll.harvest', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('returns null when no preroll is active', async () => {
    const { harvest } = require('../src/main/preroll')
    const result = await harvest(30)
    expect(result).toBeNull()
  })

  it('returns null regardless of requested seconds when inactive', async () => {
    const { harvest } = require('../src/main/preroll')
    expect(await harvest(0)).toBeNull()
    expect(await harvest(90)).toBeNull()
  })
})

// ─── stop with no active preroll ─────────────────────────────────────────────

describe('preroll.stop', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('resolves without throwing when no preroll is running', async () => {
    const { stop } = require('../src/main/preroll')
    await expect(stop()).resolves.toBeUndefined()
  })
})

// ─── state after harvest ─────────────────────────────────────────────────────

describe('preroll state isolation', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('isRunning returns false after harvest when nothing was active', async () => {
    const { isRunning, harvest } = require('../src/main/preroll')
    await harvest(30)
    expect(isRunning()).toBe(false)
  })

  it('isRunning returns false after stop when nothing was active', async () => {
    const { isRunning, stop } = require('../src/main/preroll')
    await stop()
    expect(isRunning()).toBe(false)
  })
})
