/**
 * wake-verification.ts — honest, OS-queryable wake-from-sleep diagnostics.
 *
 * The goal is to never lie to the user about whether their machine can actually
 * wake. Each function either reports the real OS state or returns null/false
 * with a clear reason; it never invents capabilities.
 *
 * Platform reality (the canonical truth this module enforces):
 *  - macOS Apple Silicon: pmset wake works, pmset poweron does NOT. Standby
 *    (deep sleep) can also sabotage wake unless disabled.
 *  - macOS Intel:         pmset wake works, pmset poweron exists but requires
 *    a manual toggle in System Settings — we cannot enable it from software.
 *  - Windows:             Task Scheduler WakeToRun works from S3/S4. S5 needs
 *    a BIOS toggle ("Wake on RTC from S5") that we cannot reach from userspace.
 *    Many laptops also disable wake timers on battery by default.
 *  - Linux/other:         No supported wake mechanism.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type WakePlatform = 'mac-arm' | 'mac-intel' | 'win' | 'linux' | 'other'

export interface WakeCapabilities {
  platform:        WakePlatform
  /** Wake from S3 sleep — usually true on supported platforms */
  canWakeFromSleep:boolean
  /** Wake from S5 (off) — usually false on Apple Silicon, depends on BIOS for Win */
  canWakeFromOff:  boolean
  /** True if scheduling wakes typically needs an admin/UAC prompt */
  needsAdmin:      boolean
  /** Human-readable Norwegian list of platform-specific gotchas */
  knownIssues:     string[]
  /** Human-readable Norwegian recommendations (e.g. "leave it on AC power") */
  recommendations: string[]
}

export interface VerifiedWake {
  /** Time from OS-level query (pmset -g sched / powercfg -waketimers) */
  scheduledAt: Date
  /** Source label (e.g. "SundayRec-Wake-1" on Windows, "SundayRec" on macOS) */
  ownerLabel:  string
}

export interface WakeStatus {
  capabilities:  WakeCapabilities
  /** What we ASKED the OS to schedule (from internal state) */
  expectedWakes: Date[]
  /** What we OBSERVE the OS has scheduled (via pmset -g sched / powercfg) */
  observedWakes: VerifiedWake[]
  /** True if any expected wake is NOT present in observedWakes (within tolerance) */
  hasMismatch:   boolean
  onBattery:     boolean | null  // null = unable to detect
  /** True if macOS standby is enabled (sabotages wake on Apple Silicon) */
  standbyEnabled:boolean | null
}

/** ±60s slack: pmset rounds to the minute, powercfg can lag by a few seconds. */
export const WAKE_MATCH_TOLERANCE_MS = 60_000

// ─────────────────────────────────────────────────────────────────────────────
//   Capabilities
// ─────────────────────────────────────────────────────────────────────────────

export async function detectCapabilities(): Promise<WakeCapabilities> {
  const known: string[] = []
  const recs:  string[] = []

  if (process.platform === 'darwin') {
    const isArm = process.arch === 'arm64'
    const platform: WakePlatform = isArm ? 'mac-arm' : 'mac-intel'
    if (isArm) {
      known.push('Apple Silicon kan ikke starte fra fullstendig avslått tilstand — kun fra dvale.')
      recs.push('La maskinen stå i dvale (ikke slå den av) etter forberedelsene.')
      recs.push('Slå av dyp dvale (standby) med «Fiks automatisk»-knappen nedenfor.')
    } else {
      known.push('Intel Mac kan starte fra avslått, men du må aktivere «Start opp eller vekk» manuelt i Systemvalg → Batteri.')
    }
    recs.push('Tilkoblet strøm må være på — Mac vekker ikke pålitelig på batteri.')
    return {
      platform,
      canWakeFromSleep: true,
      canWakeFromOff:   !isArm,
      needsAdmin:       true,
      knownIssues:      known,
      recommendations:  recs,
    }
  }

  if (process.platform === 'win32') {
    known.push('Wake fra fullstendig avslått (S5) krever at «Wake on RTC from S5» er aktivert i BIOS — kan ikke aktiveres fra programvare.')
    recs.push('Sett maskinen i dvale (Sleep/Hibernate), ikke skru den av.')
    recs.push('Tilkoblet strøm bør være på — mange bærbare deaktiverer vekketimere på batteri.')
    recs.push('Hvis test-wake feiler, sjekk BIOS for «Wake on RTC» og slå på «Tillat vekketimere» i strømalternativer.')
    return {
      platform:         'win',
      canWakeFromSleep: true,
      canWakeFromOff:   false,  // honest: cannot verify BIOS setting
      needsAdmin:       false,  // task scheduler usually works as standard user
      knownIssues:      known,
      recommendations:  recs,
    }
  }

  if (process.platform === 'linux') {
    known.push('Linux støttes ikke for automatisk oppvåkning fra SundayRec.')
    recs.push('Bruk Mac eller Windows for å aktivere automatisk wake.')
    return {
      platform:         'linux',
      canWakeFromSleep: false,
      canWakeFromOff:   false,
      needsAdmin:       false,
      knownIssues:      known,
      recommendations:  recs,
    }
  }

  return {
    platform:         'other',
    canWakeFromSleep: false,
    canWakeFromOff:   false,
    needsAdmin:       false,
    knownIssues:      ['Plattformen støttes ikke for automatisk oppvåkning.'],
    recommendations:  [],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//   pmset -g sched parsing  (macOS)
// ─────────────────────────────────────────────────────────────────────────────

const PMSET_MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]

/**
 * Parse `pmset -g sched` output.
 *
 * Output formats observed in the wild:
 *
 *   Scheduled power events:
 *     [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'
 *     [1]  wake at 06/07/2026 10:30:00 by 'SundayRec'
 *
 *   Repeating power events:
 *     wake at 11:30AM every weekday
 *
 *   (empty)   — no scheduled events
 *
 * We only capture absolute one-off wakes (the "Scheduled power events" section).
 * Repeating recurrences are skipped because we don't schedule them.
 */
export function parsePmsetSched(stdout: string, refYear?: number): VerifiedWake[] {
  const out: VerifiedWake[] = []
  const lines = stdout.split(/\r?\n/)
  let inOneOffSection = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^Scheduled power events:?/i.test(line)) { inOneOffSection = true; continue }
    if (/^Repeating power events:?/i.test(line)) { inOneOffSection = false; continue }
    if (!inOneOffSection) continue

    // Match: [0]  wake at 5/31/2026 10:30:00 by 'SundayRec'
    // (the index prefix is optional)
    const m = line.match(
      /\bwake\s+at\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+by\s+['"]?([^'"]+?)['"]?\s*$/i
    )
    if (!m) continue
    const month = parseInt(m[1], 10)
    const day   = parseInt(m[2], 10)
    let   year  = parseInt(m[3], 10)
    if (year < 100) year += 2000
    const hour  = parseInt(m[4], 10)
    const min   = parseInt(m[5], 10)
    const sec   = m[6] ? parseInt(m[6], 10) : 0
    if (refYear && Math.abs(year - refYear) > 5) continue  // sanity guard

    const date = new Date(year, month - 1, day, hour, min, sec, 0)
    if (isNaN(date.getTime())) continue
    out.push({ scheduledAt: date, ownerLabel: m[7].trim() })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
//   powercfg -waketimers parsing  (Windows)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse `powercfg -waketimers` output.
 *
 * Format (English Windows):
 *
 *   Timer set by [SYSTEM\TaskScheduler] expires at 5:30:00 PM on 5/31/2026.
 *     Reason: Windows will execute 'NT TASK\SundayRec\SundayRec-Wake-1' scheduled task
 *
 *   There are no active wake timers in the system.
 *
 * Localized Windows builds use translated headings but the date/time pattern
 * tends to remain in en-US format. We extract the task name from "Reason:".
 */
export function parsePowercfgWaketimers(stdout: string): VerifiedWake[] {
  const out: VerifiedWake[] = []
  // Split into per-timer blocks separated by blank lines
  const blocks = stdout.split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    // Pull "expires at HH:MM:SS [AM|PM] on M/D/YYYY"
    const expires = block.match(
      /expires\s+at\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i
    )
    if (!expires) continue
    let hour = parseInt(expires[1], 10)
    const min = parseInt(expires[2], 10)
    const sec = expires[3] ? parseInt(expires[3], 10) : 0
    const ampm = expires[4]?.toUpperCase()
    if (ampm === 'PM' && hour < 12) hour += 12
    if (ampm === 'AM' && hour === 12) hour = 0
    const month = parseInt(expires[5], 10)
    const day   = parseInt(expires[6], 10)
    let   year  = parseInt(expires[7], 10)
    if (year < 100) year += 2000
    const date = new Date(year, month - 1, day, hour, min, sec, 0)
    if (isNaN(date.getTime())) continue

    // Owner label: pull task name from the Reason line.
    let owner = 'unknown'
    const taskMatch = block.match(/['"]([^'"]*SundayRec[^'"]*)['"]/i)
    if (taskMatch) {
      const path = taskMatch[1]
      // Drop a leading "NT TASK\..\\" prefix and keep the final segment.
      const parts = path.split('\\')
      owner = parts[parts.length - 1] || path
    } else {
      const reason = block.match(/Reason:\s*(.+)/i)
      if (reason) owner = reason[1].trim().slice(0, 80)
    }
    out.push({ scheduledAt: date, ownerLabel: owner })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
//   Tolerance match
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true if every expected wake has a matching observed wake within tolerance. */
export function compareExpectedToObserved(
  expected: Date[],
  observed: VerifiedWake[],
  toleranceMs = WAKE_MATCH_TOLERANCE_MS,
): { hasMismatch: boolean; missing: Date[] } {
  const missing: Date[] = []
  for (const exp of expected) {
    const expMs = exp.getTime()
    const found = observed.some(o => Math.abs(o.scheduledAt.getTime() - expMs) <= toleranceMs)
    if (!found) missing.push(exp)
  }
  return { hasMismatch: missing.length > 0, missing }
}

// ─────────────────────────────────────────────────────────────────────────────
//   verifyScheduledWakes
// ─────────────────────────────────────────────────────────────────────────────

export async function verifyScheduledWakes(expected: Date[]): Promise<WakeStatus> {
  const [capabilities, observed, onBattery, standbyEnabled] = await Promise.all([
    detectCapabilities(),
    queryObservedWakes(),
    checkPowerSource(),
    checkStandbyEnabled(),
  ])
  const { hasMismatch } = compareExpectedToObserved(expected, observed)
  return {
    capabilities,
    expectedWakes: expected,
    observedWakes: observed,
    hasMismatch,
    onBattery,
    standbyEnabled,
  }
}

async function queryObservedWakes(): Promise<VerifiedWake[]> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('pmset', ['-g', 'sched'], { timeout: 5000 })
      return parsePmsetSched(stdout, new Date().getFullYear())
    } catch {
      return []
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('powercfg', ['-waketimers'], { timeout: 5000 })
      return parsePowercfgWaketimers(stdout)
    } catch {
      return []
    }
  }
  return []
}

// ─────────────────────────────────────────────────────────────────────────────
//   Power source
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if the machine is currently running on battery (no AC adapter),
 * false if on AC / no battery (desktop), null if we couldn't determine.
 */
export async function checkPowerSource(): Promise<boolean | null> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 5000 })
      return parsePmsetBatt(stdout)
    } catch {
      return null
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execFileAsync('wmic', ['path', 'Win32_Battery', 'get', 'BatteryStatus', '/value'], { timeout: 5000 })
      return parseWmicBatteryStatus(stdout)
    } catch {
      // Newer Windows (11+) sometimes ships without wmic — fall back to PowerShell
      try {
        const { stdout } = await execFileAsync('powershell', [
          '-NoProfile', '-NonInteractive', '-Command',
          '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -ExpandProperty BatteryStatus)'
        ], { timeout: 8000 })
        const status = parseInt(stdout.trim(), 10)
        if (isNaN(status)) return null
        // 1 = on battery (discharging), 2 = on AC (charging or full)
        return status === 1
      } catch {
        return null
      }
    }
  }
  return null
}

/** Exported for unit testing. */
export function parsePmsetBatt(stdout: string): boolean | null {
  if (/AC\s*Power/i.test(stdout))      return false
  if (/Battery\s*Power/i.test(stdout)) return true
  // Desktop Macs have no battery — pmset -g batt prints empty body
  if (!/InternalBattery/i.test(stdout) && !/Battery/i.test(stdout)) return false
  return null
}

/** Exported for unit testing. */
export function parseWmicBatteryStatus(stdout: string): boolean | null {
  // First try to find a numeric BatteryStatus row
  const num = stdout.match(/BatteryStatus\s*=\s*(\d+)/i)
  if (num) {
    const status = parseInt(num[1], 10)
    if (isNaN(status)) return null
    // 1 = Discharging (on battery), 2 = AC connected. 3..11 = plugged-in states.
    return status === 1
  }
  // BatteryStatus mentioned but the value is non-numeric → malformed
  if (/BatteryStatus\s*=/.test(stdout)) return null
  // No battery row at all → desktop → on AC
  return false
}

// ─────────────────────────────────────────────────────────────────────────────
//   Standby (macOS only)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True if macOS standby (deep sleep / hibernate) is enabled. Standby on Apple
 * Silicon can sabotage wake because it powers down most of the SoC. Returns
 * null on non-Mac platforms or if pmset failed.
 */
export async function checkStandbyEnabled(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null
  try {
    const { stdout } = await execFileAsync('pmset', ['-g'], { timeout: 5000 })
    return parsePmsetStandby(stdout)
  } catch {
    return null
  }
}

/** Exported for unit testing. */
export function parsePmsetStandby(stdout: string): boolean | null {
  const m = stdout.match(/\bstandby\s+(\d+)\b/)
  if (!m) return null
  return m[1] === '1'
}
