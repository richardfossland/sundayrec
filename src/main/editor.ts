import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffmpeg from 'fluent-ffmpeg'
import { codecFor } from './recorder-utils'
import * as store from './store'

let ffmpegPath = ffmpegStatic as string
if (app.isPackaged) {
  ffmpegPath = ffmpegPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
}
ffmpeg.setFfmpegPath(ffmpegPath)

export interface CutRegion { start: number; end: number }

export interface EditorSaveParams {
  inputPath:  string
  cutRegions: CutRegion[]
  duration:   number
  mode:       'new' | 'replace'
}

export interface EditorSaveResult {
  ok:          boolean
  outputPath?: string
  error?:      string
}

export async function saveEdited(params: EditorSaveParams): Promise<EditorSaveResult> {
  const { inputPath, cutRegions, duration, mode } = params

  if (typeof inputPath !== 'string') return { ok: false, error: 'invalid_path' }
  if (!fs.existsSync(inputPath))     return { ok: false, error: 'file_not_found' }

  const rawExt = path.extname(inputPath).slice(1).toLowerCase()
  const ext    = ['mp3', 'wav', 'flac', 'aac'].includes(rawExt) ? rawExt : 'mp3'

  // Compute keep segments (inverse of cut regions)
  const sorted = [...cutRegions].sort((a, b) => a.start - b.start)
  const keeps: { start: number; end: number }[] = []
  let cursor = 0
  for (const c of sorted) {
    if (c.start > cursor + 0.05) keeps.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (cursor < duration - 0.05) keeps.push({ start: cursor, end: duration })

  if (!keeps.length) return { ok: false, error: 'no_audio_remaining' }

  // Output path
  let outPath: string
  let tempPath: string | null = null

  if (mode === 'replace') {
    tempPath = inputPath + '.__editor_tmp'
    outPath  = tempPath
  } else {
    const dir  = path.dirname(inputPath)
    const base = path.basename(inputPath, path.extname(inputPath))
    let cand   = path.join(dir, `${base}_redigert.${ext}`)
    for (let i = 2; fs.existsSync(cand); i++) {
      cand = path.join(dir, `${base}_redigert_${i}.${ext}`)
    }
    outPath = cand
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const s = store.getAll()

  return new Promise(resolve => {
    let cmd = ffmpeg(inputPath)

    if (keeps.length === 1) {
      const seg = keeps[0]
      cmd = cmd.audioFilters(
        `atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS`
      )
    } else {
      const parts = keeps.map((seg, i) =>
        `[0:a]atrim=start=${seg.start.toFixed(4)}:end=${seg.end.toFixed(4)},asetpts=PTS-STARTPTS[seg${i}]`
      )
      const inputs = keeps.map((_, i) => `[seg${i}]`).join('')
      parts.push(`${inputs}concat=n=${keeps.length}:v=0:a=1[out]`)
      cmd = cmd
        .complexFilter(parts.join(';'))
        .addOutputOption('-map', '[out]')
    }

    cmd.audioCodec(codecFor(ext))
    if (ext === 'mp3' || ext === 'aac') {
      cmd.audioBitrate(String(s.bitrate ?? '192') + 'k')
    }

    cmd
      .output(outPath)
      .on('end', async () => {
        if (mode === 'replace' && tempPath) {
          try {
            await fs.promises.unlink(inputPath)
            await fs.promises.rename(tempPath, inputPath)
            resolve({ ok: true, outputPath: inputPath })
          } catch (err) {
            resolve({ ok: false, error: (err as Error).message })
          }
        } else {
          resolve({ ok: true, outputPath: outPath })
        }
      })
      .on('error', (err: Error) => {
        if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
        resolve({ ok: false, error: err.message })
      })
      .run()
  })
}
