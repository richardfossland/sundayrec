/**
 * Transcript archive IPC — used by the search page to find transcripts
 * across every recording folder we know about (saveFolder + every dir
 * referenced by recordingHistory). transcript-list-all fans out across
 * folders synchronously enough that we don't bother caching; the search
 * page calls it on mount and the user can re-trigger via reload.
 *
 * transcript-resolve-source maps a base-path (no extension) to the
 * actual recording file — needed when the user clicks a result and we
 * want to open the matching audio/video file in the editor.
 */

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import * as store from '../store'
import type { IpcContext } from './types'

export function registerTranscriptIpc(_ctx: IpcContext): void {
  // Scans all known recording folders for .transcript.json sidecars and
  // returns a flat list for the renderer to search through.
  ipcMain.handle('transcript-list-all', async () => {
    const settings = store.getAll()
    const folders = new Set<string>()
    if (settings.saveFolder) folders.add(settings.saveFolder)
    for (const entry of store.getHistory()) {
      if (entry.path) folders.add(path.dirname(entry.path))
    }

    const results: Array<{
      filePath:   string         // path to source recording (no extension match)
      transcript: unknown        // parsed TranscriptData
    }> = []

    for (const dir of folders) {
      try {
        if (!fs.existsSync(dir)) continue
        const entries = await fs.promises.readdir(dir)
        for (const name of entries) {
          if (!name.endsWith('.transcript.json')) continue
          try {
            const sidecarPath = path.join(dir, name)
            const raw = await fs.promises.readFile(sidecarPath, 'utf8')
            const transcript = JSON.parse(raw)
            // Source filename is sidecar name minus '.transcript.json'.
            // Exact extension is unknown — surface the basename and let
            // the renderer find the matching file when the user clicks.
            const baseName = name.slice(0, -'.transcript.json'.length)
            results.push({
              filePath: path.join(dir, baseName),  // renderer probes for ext
              transcript,
            })
          } catch {
            // Malformed sidecar — skip silently
          }
        }
      } catch {
        // Folder unreadable — skip
      }
    }

    return results
  })

  // Resolves the actual recording file (with extension) for a transcript
  // base-path. Used when the user clicks a search result to open the
  // recording in the editor.
  ipcMain.handle('transcript-resolve-source', async (_, basePath: string) => {
    if (typeof basePath !== 'string' || !basePath) return null
    const dir = path.dirname(basePath)
    const base = path.basename(basePath)
    try {
      if (!fs.existsSync(dir)) return null
      const entries = await fs.promises.readdir(dir)
      for (const name of entries) {
        if (name === base + '.transcript.json') continue
        const nameNoExt = name.replace(/\.[^.]+$/, '')
        if (nameNoExt === base) {
          return path.join(dir, name)
        }
      }
    } catch {}
    return null
  })
}
