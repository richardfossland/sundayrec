/**
 * Podcast RSS-feed builder.
 *
 * Produces an RSS 2.0 feed with iTunes namespace extensions — the format
 * accepted by every major podcast directory (Spotify, Apple Podcasts,
 * Pocket Casts, Overcast, …). Submit the resulting feed URL once to each
 * platform and new recordings appear automatically.
 *
 * This module is pure: it takes data, returns an XML string. It does NOT
 * read settings, file system, or network — orchestration lives in
 * `src/main/publish/index.ts`.
 */

export interface PodcastChannel {
  /** Show title — appears in directory listings */
  title:       string
  /** One-line subtitle / longer description shown on directory pages */
  description: string
  /** Optional homepage URL */
  link?:       string
  /** Author shown alongside the show (usually the church name) */
  author:      string
  /** ISO 639-1 language code, e.g. 'no', 'en', 'de' */
  language:    string
  /** Cover image URL (square, 1400-3000px, jpg/png). Required by Apple. */
  imageUrl?:   string
  /** iTunes category — e.g. 'Religion & Spirituality' */
  category:    string
  /** Whether episodes may contain explicit content */
  explicit:    boolean
  /** Contact email shown to listeners (required by Apple) */
  email?:      string
  /** Self-referential feed URL (rel="self" atom link — improves discovery) */
  feedUrl?:    string
}

export interface PodcastEpisode {
  title:        string
  description?: string
  pubDate:      Date
  /** Stable identifier for this episode (typically a timestamp-based string) */
  guid:         string
  /** Direct, public URL of the audio file */
  audioUrl:     string
  /** Audio file size in bytes (required by enclosure spec) */
  audioBytes:   number
  /** Override the auto-detected MIME type if needed */
  mimeType?:    string
  /** Episode duration in seconds */
  durationSec?: number
}

function escXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function rfc2822Date(d: Date): string {
  // Node's toUTCString is RFC 2822 compatible (e.g. "Sun, 17 May 2026 11:00:00 GMT")
  return d.toUTCString()
}

function audioMimeTypeFromFilename(filename: string): string {
  const ext = filename.split(/[#?]/)[0].split('.').pop()?.toLowerCase()
  if (ext === 'mp3')                                     return 'audio/mpeg'
  if (ext === 'wav')                                     return 'audio/wav'
  if (ext === 'flac')                                    return 'audio/flac'
  if (ext === 'm4a' || ext === 'aac')                    return 'audio/aac'
  if (ext === 'ogg' || ext === 'opus' || ext === 'oga')  return 'audio/ogg'
  if (ext === 'mp4' || ext === 'm4v')                    return 'video/mp4'
  if (ext === 'mov')                                     return 'video/quicktime'
  return 'audio/mpeg'
}

function formatDuration(sec: number): string {
  // Apple accepts both "HH:MM:SS" and plain integer seconds. We emit HH:MM:SS
  // because it's the most widely-recognized format across directories.
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  return [h, m, s].map(n => String(n).padStart(2, '0')).join(':')
}

/**
 * Build a complete podcast RSS feed. Episodes are emitted in the order
 * received — callers should sort newest-first if they want the standard
 * podcast-app display order.
 */
export function buildPodcastXml(channel: PodcastChannel, episodes: PodcastEpisode[]): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push('<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/">')
  lines.push('  <channel>')
  lines.push(`    <title>${escXml(channel.title)}</title>`)
  if (channel.link) lines.push(`    <link>${escXml(channel.link)}</link>`)
  lines.push(`    <language>${escXml(channel.language)}</language>`)
  lines.push(`    <description>${escXml(channel.description)}</description>`)
  lines.push(`    <itunes:author>${escXml(channel.author)}</itunes:author>`)
  lines.push(`    <itunes:summary>${escXml(channel.description)}</itunes:summary>`)
  if (channel.imageUrl) lines.push(`    <itunes:image href="${escXml(channel.imageUrl)}"/>`)
  lines.push(`    <itunes:explicit>${channel.explicit ? 'true' : 'false'}</itunes:explicit>`)
  lines.push(`    <itunes:category text="${escXml(channel.category)}"/>`)
  if (channel.email) {
    lines.push('    <itunes:owner>')
    lines.push(`      <itunes:name>${escXml(channel.author)}</itunes:name>`)
    lines.push(`      <itunes:email>${escXml(channel.email)}</itunes:email>`)
    lines.push('    </itunes:owner>')
  }
  if (channel.feedUrl) {
    lines.push(`    <atom:link href="${escXml(channel.feedUrl)}" rel="self" type="application/rss+xml"/>`)
  }
  lines.push(`    <lastBuildDate>${rfc2822Date(new Date())}</lastBuildDate>`)
  lines.push('    <generator>SundayRec</generator>')

  for (const ep of episodes) {
    lines.push('    <item>')
    lines.push(`      <title>${escXml(ep.title)}</title>`)
    if (ep.description) lines.push(`      <description>${escXml(ep.description)}</description>`)
    lines.push(`      <pubDate>${rfc2822Date(ep.pubDate)}</pubDate>`)
    lines.push(`      <guid isPermaLink="false">${escXml(ep.guid)}</guid>`)
    const mime = ep.mimeType ?? audioMimeTypeFromFilename(ep.audioUrl)
    lines.push(`      <enclosure url="${escXml(ep.audioUrl)}" length="${Math.max(0, ep.audioBytes | 0)}" type="${escXml(mime)}"/>`)
    if (ep.durationSec != null && ep.durationSec > 0) {
      lines.push(`      <itunes:duration>${formatDuration(ep.durationSec)}</itunes:duration>`)
    }
    lines.push('    </item>')
  }

  lines.push('  </channel>')
  lines.push('</rss>')
  return lines.join('\n')
}
