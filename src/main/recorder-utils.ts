import { churchCalendarName } from '../shared/church-calendar'
import type { RecordingOpts } from '../types'

const WIN_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

export function sanitizeFilename(name: string): string {
  let safe = name.replace(/[/\\:*?"<>|]/g, '_').trim()
  // Strip trailing dots/spaces (Windows disallows them)
  safe = safe.replace(/[. ]+$/, '')
  // Replace Windows reserved device names
  if (WIN_RESERVED.test(safe)) safe = `_${safe}`
  return safe || 'opptak'
}

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildFilename(settings: RecordingOpts, startMs?: number): string {
  const now  = startMs ? new Date(startMs) : new Date()
  const date = localDateStr(now)
  const ext  = settings.format ?? 'mp3'
  const ts   = settings.splitTimestamp ? `_${settings.splitTimestamp}` : ''

  if (settings.customName?.trim()) {
    const safe = sanitizeFilename(settings.customName.trim())
    return `${safe}${ts}_${date}.${ext}`
  }

  switch (settings.filenamePattern) {
    case 'church': {
      const name = churchCalendarName(now)
      return `${name}${ts}_${date}.${ext}`
    }
    case 'plain':
      return `gudstjeneste${ts}_${date}.${ext}`
    case 'datetime': {
      const time = now.toTimeString().slice(0, 5).replace(':', '')
      return `${date}_${time}.${ext}`
    }
    default:
      return `${date}${ts}.${ext}`
  }
}

export function codecFor(format: string): string {
  switch (format) {
    case 'mp3':  return 'libmp3lame'
    case 'flac': return 'flac'
    case 'aac':  return 'aac'
    case 'wav':  return 'pcm_s16le'
    default:     return 'libmp3lame'
  }
}

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return h ? `${h}t ${m}m` : `${m}m`
}

// ─── Centralised ffmpeg stderr classification ──────────────────────────────
//
// Single source of truth used by native-recorder (audio-only), video-recorder
// (camera-only), and unified-recorder (audio+video in one process). Earlier
// each had its own classifier with overlapping but slightly different
// patterns — audio-disconnect errors slipped through video-classifier as
// generic `device_error` (mis-classified, caused 20-attempt reconnect loops
// on what should have been a fail-stop).
//
// The classifier covers BOTH audio and video failure modes so a unified
// process can use it directly. Audio-only and video-only callers also
// benefit from the larger pattern set — better to over-detect than to
// miss a known failure mode.

/** Stable error codes used by recorder.ts watchdog + UI localisation.
 *  Adding a new code requires matching entries in NL_ERRORS in recorder.ts. */
export type RecordingErrorCode =
  | 'device_not_found'
  | 'device_permission_denied'
  | 'device_busy'
  | 'device_disconnected'
  | 'disk_full'
  | 'device_error'

const PATTERN_GROUPS: Array<{ code: RecordingErrorCode; patterns: string[] }> = [
  {
    code: 'device_not_found',
    patterns: [
      'device not found',
      'no such audio device', 'no such audio input',
      'no such file or directory',
      'no devices found',
      'no audio endpoint', 'no audio endpoint device',
      'no audio device', 'audio device not found',
      'no video device', 'no such video', 'video device not found',
      'could not find audio', 'cannot find audio', 'failed to find audio',
      'could not find video', 'failed to find video',
      'no capture device', 'avfoundation: device',
      'the handle is invalid', 'the system cannot find the file specified',
      'audclnt_e_device_not_active',
      'mmdevapi',
      'failed to create audio client',
    ],
  },
  {
    code: 'device_permission_denied',
    patterns: [
      'access is denied', 'access denied',
      'permission', 'not permitted',
      'avfoundation: video not enabled',
      'authorization',
      'microphone access', 'camera access',
      'privacy', 'tcm_access', 'e_accessdenied',
    ],
  },
  {
    code: 'device_busy',
    patterns: [
      'already in use', 'device busy', 'being used by another',
      'resource busy', 'device or resource busy',
      'audclnt_e_device_in_use',
      'audclnt_e_exclusive_mode_not_allowed',
      'audclnt_e_already_initialized',
      'audclnt_e_wrong_endpoint_type',
    ],
  },
  {
    code: 'disk_full',
    patterns: ['no space left', 'disk full', 'enospc'],
  },
  {
    code: 'device_disconnected',
    patterns: [
      'broken pipe', 'i/o error', 'input/output',
      'unplugged',
      'audclnt_e_device_invalidated',
      'connection reset', 'eof',
    ],
  },
]

/**
 * Map an ffmpeg stderr blob to a stable error code.
 *
 * Order matters: more specific patterns (permission, busy, disk_full) are
 * checked before the catch-all 'device_disconnected' so they take priority
 * when stderr contains overlapping signals (e.g. a permission-denied error
 * also containing "i/o error" further down).
 *
 * Returns 'device_error' when no pattern matches — the recorder watchdog
 * treats that as transient and retries.
 */
export function classifyRecordingError(stderr: string): RecordingErrorCode {
  const s = stderr.toLowerCase()
  for (const group of PATTERN_GROUPS) {
    if (group.patterns.some(p => s.includes(p))) return group.code
  }
  return 'device_error'
}

// ─── Centralised timeouts ──────────────────────────────────────────────────
//
// Recording-pipeline timeouts that used to be magic constants scattered
// across native-recorder.ts, video-recorder.ts, unified-recorder.ts,
// recorder.ts and preroll.ts. Collected here so tuning happens in one
// place — and any future cross-platform difference is explicit.

export const RECORDER_TIMEOUTS = {
  /** How long to wait for the first ffmpeg progress line before treating
   *  startup as failed. Mac is consistently fast; Windows dshow can take
   *  several seconds to enumerate devices on first launch. */
  startupMs: process.platform === 'win32' ? 10_000 : 5_000,

  /** Stuck-encoder check: if bytes haven't advanced in this long the
   *  watchdog fires. Generous because typical 90-min sermons can briefly
   *  pause writes during keyframe processing on slow disks. */
  stuckProgressMs: 60_000,

  /** Stuck-encoder polling interval. 15 s strikes a balance between
   *  catching hangs quickly and not burning CPU on a 90-min recording. */
  stuckPollMs: 15_000,

  /** Maximum delay between reconnect attempts. With 20 attempts and the
   *  default reconnectDelay() formula we hit this cap around attempt 7. */
  reconnectMaxDelayMs: 10_000,

  /** Throttle progress IPC from main → renderer. ffmpeg emits a progress
   *  line every second; 5 s is the lowest fidelity the renderer cares
   *  about (status bar resolution) without flooding the channel. */
  progressThrottleMs: 5_000,

  /** Per-receiver timeout for NDI shutdown — prevents libndi deadlock
   *  from blocking stream-stop forever. */
  ndiStopTimeoutMs: 2_000,
} as const
