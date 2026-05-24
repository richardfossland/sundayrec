/**
 * Structured logger for SundayRec — main process only.
 *
 * Design:
 *   - In-memory ring buffer: last 1000 entries, oldest evicted automatically.
 *   - File logging: one JSON line per entry, flushed synchronously so crashes
 *     don't lose the tail. Rotated at 5 MB (old .1 overwritten).
 *   - Pre-app-ready buffering: log() is safe to call before app emits 'ready'.
 *     Entries accumulate in the ring buffer and are flushed to the log file
 *     once the path becomes available.
 *   - Console mirroring: colored output in development only (NODE_ENV !== 'production').
 *   - Never throws — any I/O failure falls back silently to in-memory only.
 */

import fs   from 'fs'
import path from 'path'
import { app } from 'electron'

// ── Types ────────────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  ts:     number    // Unix ms
  level:  LogLevel
  module: string    // 'recorder' | 'cloud' | 'scheduler' | 'preroll' | 'wake' | …
  msg:    string    // human-readable message
  data?:  unknown   // serializable structured context
}

// ── Ring buffer ──────────────────────────────────────────────────────────────

const RING_SIZE = 1000
const ring: LogEntry[] = []
let ringHead = 0   // next write position (wraps around)
let ringFull = false

function ringPush(entry: LogEntry): void {
  ring[ringHead] = entry
  ringHead = (ringHead + 1) % RING_SIZE
  if (ringHead === 0) ringFull = true
}

// Returns up to n entries ordered oldest-first.
function ringRead(n: number): LogEntry[] {
  const total = ringFull ? RING_SIZE : ringHead
  const count = Math.min(n, total)
  const result: LogEntry[] = []
  // oldest entry lives at ringHead when full, else at index 0
  const start = ringFull ? ringHead : 0
  for (let i = total - count; i < total; i++) {
    result.push(ring[(start + i) % RING_SIZE])
  }
  return result
}

// ── File state ───────────────────────────────────────────────────────────────

const LOG_FILENAME     = 'sundayrec.log'
const LOG_FILENAME_OLD = 'sundayrec.log.1'
const MAX_LOG_BYTES    = 5 * 1024 * 1024  // 5 MB

let logFilePath: string | null = null
let logFd: number | null = null   // open file descriptor for the active log
let preReady  = true              // true until app.ready fires + flush completes

// ── Console colors (dev only) ─────────────────────────────────────────────────

const isDev = process.env.NODE_ENV !== 'production'

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',   // bright black (grey)
  info:  '\x1b[36m',   // cyan
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
}
const RESET = '\x1b[0m'

function consoleWrite(entry: LogEntry): void {
  const ts    = new Date(entry.ts).toISOString().slice(11, 23)  // HH:MM:SS.mmm
  const color = LEVEL_COLOR[entry.level]
  const label = entry.level.toUpperCase().padEnd(5)
  const base  = `${color}${ts} [${label}] [${entry.module}] ${entry.msg}${RESET}`
  if (entry.data !== undefined) {
    // eslint-disable-next-line no-console
    console.log(base, entry.data)
  } else {
    // eslint-disable-next-line no-console
    console.log(base)
  }
}

// ── File helpers ─────────────────────────────────────────────────────────────

function openLogFile(filePath: string): number | null {
  try {
    return fs.openSync(filePath, 'a')
  } catch {
    return null
  }
}

function rotateIfNeeded(): void {
  if (logFilePath === null || logFd === null) return
  try {
    const stat = fs.fstatSync(logFd)
    if (stat.size < MAX_LOG_BYTES) return
    // Close current, rename → .1, open fresh
    fs.closeSync(logFd)
    logFd = null
    const oldPath = path.join(path.dirname(logFilePath), LOG_FILENAME_OLD)
    try { fs.renameSync(logFilePath, oldPath) } catch { /* ignore if rename fails */ }
    logFd = openLogFile(logFilePath)
  } catch {
    // Rotation failed — keep writing to existing fd (or in-memory if fd is gone)
  }
}

function writeToFile(entry: LogEntry): void {
  if (logFd === null) return
  try {
    rotateIfNeeded()
    if (logFd === null) return
    const line = JSON.stringify(entry) + '\n'
    fs.writeSync(logFd, line)
  } catch {
    // I/O failure — silently continue with in-memory only
    logFd = null
  }
}

// ── Pre-ready flush ───────────────────────────────────────────────────────────

function initFileLogging(): void {
  try {
    const logsDir = app.getPath('logs')
    logFilePath   = path.join(logsDir, LOG_FILENAME)
    // Ensure the directory exists (it usually does, but be safe)
    fs.mkdirSync(logsDir, { recursive: true })
    logFd = openLogFile(logFilePath)
  } catch {
    logFilePath = null
    logFd       = null
    return
  }

  // Flush entries that arrived before app.ready (they are already in the ring buffer)
  const total = ringFull ? RING_SIZE : ringHead
  if (total > 0 && logFd !== null) {
    const start = ringFull ? ringHead : 0
    try {
      for (let i = 0; i < total; i++) {
        const entry = ring[(start + i) % RING_SIZE]
        const line  = JSON.stringify(entry) + '\n'
        fs.writeSync(logFd, line)
      }
    } catch {
      logFd = null
    }
  }
  preReady = false
}

// Wire to app.ready (safe even if called before app module is fully loaded)
try {
  app.whenReady().then(initFileLogging).catch(() => { /* silently ignore */ })
} catch {
  // During unit tests app.whenReady may not exist — ignore
}

// ── Core log function ────────────────────────────────────────────────────────

export function log(level: LogLevel, module: string, msg: string, data?: unknown): void {
  const entry: LogEntry = {
    ts:    Date.now(),
    level,
    module,
    msg,
    ...(data !== undefined ? { data } : {}),
  }

  // 1. Ring buffer — always
  ringPush(entry)

  // 2. File — only after app is ready and logFd is open
  if (!preReady) {
    writeToFile(entry)
  }

  // 3. Console — development only
  if (isDev) {
    consoleWrite(entry)
  }
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export function debug(module: string, msg: string, data?: unknown): void {
  log('debug', module, msg, data)
}

export function info(module: string, msg: string, data?: unknown): void {
  log('info', module, msg, data)
}

export function warn(module: string, msg: string, data?: unknown): void {
  log('warn', module, msg, data)
}

export function error(module: string, msg: string, data?: unknown): void {
  log('error', module, msg, data)
}

// ── Query API ─────────────────────────────────────────────────────────────────

/**
 * Return up to n recent log entries (default: 200), ordered oldest-first.
 */
export function getRecentLogs(n = 200): LogEntry[] {
  return ringRead(n)
}

/**
 * Return the log file path, or null if app.ready has not yet fired.
 */
export function getLogFilePath(): string | null {
  return logFilePath
}

// ── IPC wiring needed in index.ts ────────────────────────────────────────────
//
// ipcMain.handle('get-logs',         () => getRecentLogs(200))
// ipcMain.handle('get-log-file-path', () => getLogFilePath())
