/**
 * thumbnail — podcast cover-art handling.
 *
 * Two-tier resolution:
 *   1. Per-episode override at `<recording-base>.thumb.{ext}` next to the
 *      recording file.
 *   2. Default at `userData/thumbnails/default.{ext}` referenced from
 *      Settings.defaultThumbnailPath.
 *
 * The file format is determined by magic bytes (not the source filename) so we
 * never trust an attacker-supplied .jpg extension that actually contains
 * something else — ffmpeg + the OS image preview path are both more permissive
 * than we want here.
 *
 * Width/height are read with tiny inline parsers (no new npm dependency):
 *   JPEG — scan APP/SOF markers for the first SOF0/SOF2.
 *   PNG  — IHDR chunk starts at byte 16.
 *   WebP — VP8 / VP8L / VP8X header at byte 30.
 */

import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import * as store from './store'

export type ThumbFormat = 'jpeg' | 'png' | 'webp'

export interface ThumbInfo {
  width:    number
  height:   number
  byteSize: number
  format:   ThumbFormat
}

/**
 * Read a thumbnail file and encode it as a base64 data URL the renderer can
 * drop into <img src="…">. CSP allows data: for img-src; file:// is blocked
 * under the app's sandboxed renderer, and registering a custom protocol for
 * the relatively small thumbnail files would be over-engineering.
 */
export async function readThumbnailAsDataUrl(filePath: string, format: ThumbFormat): Promise<string> {
  const data = await fs.promises.readFile(filePath)
  const mime = format === 'jpeg' ? 'image/jpeg' : format === 'png' ? 'image/png' : 'image/webp'
  return `data:${mime};base64,${data.toString('base64')}`
}

const MAX_BYTES_HARD = 20 * 1024 * 1024   // reject above this
const MAX_BYTES_SOFT =  5 * 1024 * 1024   // warn-only above this (UI side)

// ── Magic-byte detection ───────────────────────────────────────────────────

/**
 * Inspect the first ~12 bytes of `buf` to identify the image format. Returns
 * null for anything that isn't JPEG, PNG, or WebP — including SVG / GIF /
 * BMP / HEIC / AVIF, which are accepted nowhere in the podcast ecosystem.
 */
export function isValidImage(buf: Buffer): { format: ThumbFormat } | null {
  if (!buf || buf.length < 12) return null
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { format: 'jpeg' }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return { format: 'png' }
  // WebP: "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { format: 'webp' }
  return null
}

function extFor(format: ThumbFormat): string {
  return format === 'jpeg' ? 'jpg' : format
}

// ── Dimensions readers ─────────────────────────────────────────────────────

function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  // JPEG: SOI (FFD8) then a series of markers. Each non-SOI/EOI marker is
  // FF Mn LL LL [payload]. SOF markers (FFC0–FFCF, except FFC4/FFC8/FFCC)
  // begin with: precision(1) + height(2 BE) + width(2 BE) + …
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let off = 2
  while (off < buf.length) {
    if (buf[off] !== 0xff) return null
    // Skip fill bytes (0xFF padding before a marker)
    while (off < buf.length && buf[off] === 0xff) off++
    if (off >= buf.length) return null
    const marker = buf[off++]
    if (marker === 0xd8 || marker === 0xd9) continue        // SOI / EOI — no payload
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue  // standalone
    if (off + 2 > buf.length) return null
    const segLen = buf.readUInt16BE(off)
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      if (off + 7 > buf.length) return null
      const height = buf.readUInt16BE(off + 3)
      const width  = buf.readUInt16BE(off + 5)
      return { width, height }
    }
    off += segLen
  }
  return null
}

function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  // After the 8-byte signature: 4 bytes length, 4 bytes "IHDR", then 8 bytes
  // (width BE, height BE). So width is at byte 16, height at byte 20.
  if (buf.length < 24) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

function readWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  // RIFF (4) + size (4) + "WEBP" (4) + chunk-id (4) + chunk-size (4) = byte 20
  if (buf.length < 30) return null
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null
  const chunkId = buf.toString('ascii', 12, 16)

  if (chunkId === 'VP8 ') {
    // Lossy WebP. Header at byte 20: 3 bytes frame tag, then 3 bytes start
    // code (0x9D 0x01 0x2A), then width(14 LE) + height(14 LE).
    if (buf.length < 30) return null
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    const w = buf.readUInt16LE(26) & 0x3fff
    const h = buf.readUInt16LE(28) & 0x3fff
    return { width: w, height: h }
  }
  if (chunkId === 'VP8L') {
    // Lossless WebP. Header at byte 20: 1 byte signature (0x2F), then 4 bytes
    // packed: 14 bits width-1, 14 bits height-1, …
    if (buf.length < 25) return null
    if (buf[20] !== 0x2f) return null
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24]
    const width  = 1 + ((b0 | ((b1 & 0x3f) << 8)))
    const height = 1 + (((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)))
    return { width, height }
  }
  if (chunkId === 'VP8X') {
    // Extended WebP. Header at byte 20: 1 byte flags + 3 bytes reserved, then
    // 3 bytes width-1 (LE) + 3 bytes height-1 (LE).
    if (buf.length < 30) return null
    const w = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16)
    const h = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16)
    return { width: w, height: h }
  }
  return null
}

/**
 * Inspect `filePath` and return its dimensions + format + size. Throws if the
 * file is missing, unreadable, or not a supported image format.
 */
export async function getThumbInfo(filePath: string): Promise<ThumbInfo> {
  const stat = await fs.promises.stat(filePath)
  // Read only the head — 64 KB is well above what any of the three formats
  // needs for SOF detection. For tiny files this is the whole thing.
  const head = Buffer.alloc(Math.min(stat.size, 64 * 1024))
  const fh = await fs.promises.open(filePath, 'r')
  try {
    await fh.read(head, 0, head.length, 0)
  } finally {
    await fh.close()
  }
  const probe = isValidImage(head)
  if (!probe) throw new Error('unsupported_format')

  let dims: { width: number; height: number } | null = null
  if (probe.format === 'jpeg') dims = readJpegDimensions(head)
  if (probe.format === 'png')  dims = readPngDimensions(head)
  if (probe.format === 'webp') dims = readWebpDimensions(head)

  return {
    width:    dims?.width  ?? 0,
    height:   dims?.height ?? 0,
    byteSize: stat.size,
    format:   probe.format,
  }
}

// ── File-system layout ─────────────────────────────────────────────────────

function thumbnailsDir(): string {
  const d = path.join(app.getPath('userData'), 'thumbnails')
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
  return d
}

function episodeSidecarPath(recordingPath: string, ext: string): string {
  // sermon-2026-05-27.mp3 → sermon-2026-05-27.thumb.jpg
  const dir  = path.dirname(recordingPath)
  const base = path.basename(recordingPath, path.extname(recordingPath))
  return path.join(dir, `${base}.thumb.${ext}`)
}

/**
 * Find an existing per-episode thumbnail next to `recordingPath`. Looks for
 * .thumb.jpg/.jpeg/.png/.webp. Returns null when none exists.
 */
function findEpisodeThumb(recordingPath: string): string | null {
  const dir  = path.dirname(recordingPath)
  const base = path.basename(recordingPath, path.extname(recordingPath))
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    const candidate = path.join(dir, `${base}.thumb.${ext}`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

// ── Default thumbnail (settings-backed) ────────────────────────────────────

/**
 * Copy `sourcePath` into userData/thumbnails/default.{ext} (after format/size
 * validation), set Settings.defaultThumbnailPath, and return the new info.
 * Removes any previous default file with a different extension so the
 * directory never accumulates stale "default.png" + "default.jpg" pairs.
 */
export async function setDefaultThumbnail(sourcePath: string): Promise<{ path: string; info: ThumbInfo } | { error: string }> {
  try {
    const stat = await fs.promises.stat(sourcePath)
    if (stat.size > MAX_BYTES_HARD) return { error: 'too_large' }
    if (stat.size === 0)            return { error: 'empty_file' }
    const info = await getThumbInfo(sourcePath)   // throws on unsupported
    const ext  = extFor(info.format)

    const dir = thumbnailsDir()
    // Wipe any stale default.* from previous formats
    for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
      const p = path.join(dir, `default.${e}`)
      if (fs.existsSync(p)) {
        try { await fs.promises.unlink(p) } catch {}
      }
    }
    const dest = path.join(dir, `default.${ext}`)
    await fs.promises.copyFile(sourcePath, dest)
    store.set('defaultThumbnailPath', dest)
    return { path: dest, info: { ...info, byteSize: stat.size } }
  } catch (err) {
    const msg = (err as Error).message
    if (msg === 'unsupported_format') return { error: 'unsupported_format' }
    return { error: msg || 'set_failed' }
  }
}

export async function clearDefaultThumbnail(): Promise<void> {
  const existing = store.get('defaultThumbnailPath' as keyof import('../types').Settings) as string | null | undefined
  if (existing && fs.existsSync(existing)) {
    try { await fs.promises.unlink(existing) } catch {}
  }
  store.set('defaultThumbnailPath', null)
}

export async function getDefaultThumbnailInfo(): Promise<{ path: string; info: ThumbInfo } | null> {
  const p = store.get('defaultThumbnailPath' as keyof import('../types').Settings) as string | null | undefined
  if (!p || !fs.existsSync(p)) return null
  try {
    const info = await getThumbInfo(p)
    return { path: p, info }
  } catch {
    return null
  }
}

// ── Per-episode override ───────────────────────────────────────────────────

export async function setEpisodeThumbnail(recordingPath: string, sourcePath: string): Promise<{ path: string; info: ThumbInfo } | { error: string }> {
  try {
    const stat = await fs.promises.stat(sourcePath)
    if (stat.size > MAX_BYTES_HARD) return { error: 'too_large' }
    if (stat.size === 0)            return { error: 'empty_file' }
    const info = await getThumbInfo(sourcePath)
    const ext  = extFor(info.format)

    // Remove any existing thumb sidecar with a different extension so a switch
    // from PNG → JPG doesn't leave the renderer confused about which "wins".
    for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
      const p = episodeSidecarPath(recordingPath, e)
      if (fs.existsSync(p)) {
        try { await fs.promises.unlink(p) } catch {}
      }
    }
    const dest = episodeSidecarPath(recordingPath, ext)
    await fs.promises.copyFile(sourcePath, dest)
    return { path: dest, info: { ...info, byteSize: stat.size } }
  } catch (err) {
    const msg = (err as Error).message
    if (msg === 'unsupported_format') return { error: 'unsupported_format' }
    return { error: msg || 'set_failed' }
  }
}

export async function clearEpisodeThumbnail(recordingPath: string): Promise<void> {
  for (const e of ['jpg', 'jpeg', 'png', 'webp']) {
    const p = episodeSidecarPath(recordingPath, e)
    if (fs.existsSync(p)) {
      try { await fs.promises.unlink(p) } catch {}
    }
  }
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Returns the thumbnail that should be used for this recording — the per-
 * episode override if it exists, otherwise the default if it exists, else null.
 */
export async function resolveThumbnail(recordingPath: string): Promise<{ path: string; kind: 'episode' | 'default'; info: ThumbInfo } | null> {
  const episodePath = findEpisodeThumb(recordingPath)
  if (episodePath) {
    try {
      const info = await getThumbInfo(episodePath)
      return { path: episodePath, kind: 'episode', info }
    } catch { /* fall through to default */ }
  }
  const def = await getDefaultThumbnailInfo()
  if (def) return { path: def.path, kind: 'default', info: def.info }
  return null
}
