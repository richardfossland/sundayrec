import { churchCalendarName } from '../shared/church-calendar'
import type { RecordingOpts } from '../types'

export function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function buildFilename(settings: RecordingOpts, startMs?: number): string {
  const now  = startMs ? new Date(startMs) : new Date()
  const date = localDateStr(now)
  const ext  = settings.format ?? 'mp3'
  const ts   = settings.splitTimestamp ? `_${settings.splitTimestamp}` : ''

  if (settings.customName?.trim()) {
    const safe = settings.customName.trim().replace(/[/\\:*?"<>|]/g, '_')
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
