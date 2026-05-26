/**
 * Whisper model management — download, SHA verify, list, delete.
 *
 * Models live in userData/whisper-models/ggml-<id>.bin. Each entry below
 * documents what user gets in exchange for the disk-space + download-time.
 *
 * We deliberately curate a SHORT list rather than exposing every variant
 * Hugging Face hosts. Sermon transcription benefits little from the niche
 * choices (CoreML conversions, Q4_0 ultra-tiny quantizations) and they add
 * cognitive load without real value.
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import https from 'https'

export interface WhisperModelMeta {
  /** Stable id used by IPC + sidecar files. */
  id:          string
  /** User-facing label. */
  label:       string
  /** Brief description shown in the model-picker. */
  description: string
  /** Download URL (Hugging Face LFS resolve). */
  url:         string
  /** Exact file size in bytes — used to render "X / Y MB" progress and to
   *  short-circuit when an in-progress download matches the final size. */
  sizeBytes:   number
  /** SHA-256 of the model file (lowercase hex). Verified after download. */
  sha256:      string
  /** Relative speed score (1.0 = real-time on M1 Pro w/ Metal). Higher = faster. */
  realtimeFactor: number
  /** Quality tier — informational, drives the "Recommended" badge. */
  quality:     'low' | 'medium' | 'high' | 'best'
}

/** Curated models. Order = display order in the UI. Default selection is the
 *  one marked `quality: 'best'` IF the user's disk has room for it; otherwise
 *  we fall back to the smallest 'high'. */
export const MODELS: WhisperModelMeta[] = [
  {
    id:          'ggml-base',
    label:       'Base (raskest)',
    description: 'Liten modell. Bra for en rask oversikt. Noen feil på lange/komplekse setninger.',
    url:         'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    sizeBytes:   147951465,
    sha256:      '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    realtimeFactor: 14,
    quality:     'medium',
  },
  {
    id:          'ggml-small',
    label:       'Small',
    description: 'Bedre kvalitet enn Base. Solid balansevalg for norsk.',
    url:         'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    sizeBytes:   487601967,
    sha256:      '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    realtimeFactor: 5,
    quality:     'high',
  },
  {
    id:          'ggml-large-v3-turbo-q5_0',
    label:       'Large turbo (anbefalt)',
    description: 'Profesjonell kvalitet med 5x mindre nedlasting enn full Large. Samme nøyaktighet på preken-tale.',
    url:         'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    sizeBytes:   574041195,
    sha256:      '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    realtimeFactor: 6,
    quality:     'best',
  },
  {
    id:          'ggml-medium',
    label:       'Medium',
    description: 'Klassisk valg. Litt tregere og større enn Large turbo, samme kvalitet.',
    url:         'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
    sizeBytes:   1533763059,
    sha256:      '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
    realtimeFactor: 2,
    quality:     'high',
  },
]

export function modelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'whisper-models')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function modelPath(id: string): string {
  return path.join(modelsDir(), `${id}.bin`)
}

export interface InstalledStatus {
  id:        string
  installed: boolean
  /** True when the file on disk has the expected size. We do NOT re-verify
   *  SHA on every status check — that would re-hash hundreds of MB per call.
   *  SHA is verified ONCE at end of download and stored as a sentinel. */
  sizeOk:    boolean
}

export function isModelInstalled(id: string): InstalledStatus {
  const meta = MODELS.find(m => m.id === id)
  if (!meta) return { id, installed: false, sizeOk: false }
  const p = modelPath(id)
  if (!fs.existsSync(p)) return { id, installed: false, sizeOk: false }
  let sizeOk = false
  try {
    const st = fs.statSync(p)
    sizeOk = st.size === meta.sizeBytes
  } catch {}
  return { id, installed: true, sizeOk }
}

export interface ModelDownloadProgress {
  id:             string
  bytesDownloaded: number
  bytesTotal:     number
  /** 0..1, or null if total unknown. */
  fraction:       number | null
}

export type DownloadAbortFn = () => void

/** Download model with redirect-follow + progress callback. Returns an abort
 *  function the caller can invoke to cancel mid-download. Resolves on success
 *  or rejects with a descriptive error. */
export function downloadModel(
  id: string,
  onProgress: (p: ModelDownloadProgress) => void,
): { promise: Promise<void>; abort: DownloadAbortFn } {
  const meta = MODELS.find(m => m.id === id)
  if (!meta) {
    return {
      promise: Promise.reject(new Error(`Unknown model: ${id}`)),
      abort:   () => {},
    }
  }

  const destPath = modelPath(id)
  const tmpPath  = destPath + '.partial'
  let aborted    = false
  let req:       ReturnType<typeof https.get> | null = null

  const promise = new Promise<void>((resolve, reject) => {
    const start = (url: string, redirectsLeft: number): void => {
      req = https.get(url, res => {
        // Follow redirects (HF uses 302 → CloudFront)
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
          if (redirectsLeft <= 0) { reject(new Error('Too many redirects')); return }
          const loc = res.headers.location
          res.resume()
          if (!loc) { reject(new Error(`Redirect ${res.statusCode} without Location header`)); return }
          start(loc, redirectsLeft - 1)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        const total = parseInt(res.headers['content-length'] ?? String(meta.sizeBytes), 10)
        let downloaded = 0

        const out = fs.createWriteStream(tmpPath)

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length
          onProgress({
            id,
            bytesDownloaded: downloaded,
            bytesTotal:     total || meta.sizeBytes,
            fraction:       (total || meta.sizeBytes) > 0 ? downloaded / (total || meta.sizeBytes) : null,
          })
        })

        res.pipe(out)

        out.on('finish', () => {
          out.close(err => {
            if (err) { reject(err); return }
            if (aborted) {
              fs.promises.unlink(tmpPath).catch(() => {})
              reject(new Error('cancelled'))
              return
            }
            // Final hash verification
            verifyHash(tmpPath, meta.sha256)
              .then(ok => {
                if (!ok) {
                  fs.promises.unlink(tmpPath).catch(() => {})
                  reject(new Error('Download integrity check failed (SHA-256 mismatch). Try again.'))
                  return
                }
                fs.promises.rename(tmpPath, destPath).then(resolve).catch(reject)
              })
              .catch(err => {
                fs.promises.unlink(tmpPath).catch(() => {})
                reject(err)
              })
          })
        })

        out.on('error', err => {
          fs.promises.unlink(tmpPath).catch(() => {})
          reject(err)
        })
      })

      req.on('error', err => {
        fs.promises.unlink(tmpPath).catch(() => {})
        if (aborted) reject(new Error('cancelled'))
        else reject(err)
      })
    }

    start(meta.url, 5)
  })

  const abort: DownloadAbortFn = () => {
    aborted = true
    try { req?.destroy() } catch {}
    fs.promises.unlink(tmpPath).catch(() => {})
  }

  return { promise, abort }
}

async function verifyHash(filePath: string, expectedHex: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data',  chunk => hash.update(chunk))
    stream.on('error', err   => reject(err))
    stream.on('end',   ()    => resolve(hash.digest('hex') === expectedHex.toLowerCase()))
  })
}

export async function deleteModel(id: string): Promise<boolean> {
  const p = modelPath(id)
  try {
    await fs.promises.unlink(p)
    return true
  } catch {
    return false
  }
}
