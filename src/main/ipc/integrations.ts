/**
 * Sunday-suite integration IPC.
 *
 * Phase 0 scaffold: lets the renderer read/patch the opt-in integration
 * settings and read a recording's service-link sidecar. Per-app flows
 * (Verbatim handoff, Stage chapters, Song usage, Plan sync) register their
 * own handlers in later phases. Everything here is inert until the user
 * enables the "Sunday-suite" section — nothing touches the recording core.
 */

import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as store from '../store'
import { readServiceLink } from '../integrations/service-link'
import { launchVerbatim, importVerbatimCaptions, type VerbatimImportOptions } from '../integrations/verbatim'
import { applyStageManifest, parseStageManifest } from '../integrations/stage'
import type { IpcContext } from './types'
import type { IntegrationSettings } from '../../types'

const DISABLED: IntegrationSettings = { enabled: false }

export function registerIntegrationsIpc(_ctx: IpcContext): void {
  ipcMain.handle('integrations-get-settings', () => {
    return store.get('integrations') ?? DISABLED
  })

  // Shallow-merge a patch into the stored integration settings. Keeping it a
  // patch (rather than full replace) means a renderer toggling one flag can't
  // clobber connection details it didn't send.
  ipcMain.handle('integrations-set-settings', (_evt, patch: Partial<IntegrationSettings>) => {
    const current = store.get('integrations') ?? DISABLED
    const next: IntegrationSettings = { ...current, ...(patch ?? {}) }
    store.set('integrations', next)
    return next
  })

  // Returns the external service context for a recording, or null. Read-only;
  // the per-app modules write these sidecars in later phases.
  ipcMain.handle('integrations-get-service-link', (_evt, recordingPath: string) => {
    if (typeof recordingPath !== 'string' || !recordingPath) return null
    return readServiceLink(recordingPath)
  })

  // ── Verbatim hand-off (Fase 1) ────────────────────────────────────────────
  // Launch Verbatim with a recording, primed with sermon context + glossary.
  // Returns { ok } where ok=false means the verbatim:// scheme has no handler
  // (Verbatim not installed) — the renderer then shows a download hint.
  ipcMain.handle('integrations-verbatim-send', async (_evt, opts: VerbatimImportOptions) => {
    if (!opts || typeof opts.videoPath !== 'string' || !opts.videoPath) {
      return { ok: false, error: 'invalid_path' }
    }
    const launched = await launchVerbatim(opts)
    return { ok: launched, error: launched ? undefined : 'verbatim_not_installed' }
  })

  // Import a Verbatim-exported subtitle file (SRT/VTT) → the recording's
  // .transcript.json sidecar, so it shows up in transcript search + editor.
  ipcMain.handle('integrations-verbatim-import', (_evt, recordingPath: string, subtitlePath: string, language?: string) => {
    if (typeof recordingPath !== 'string' || typeof subtitlePath !== 'string' || !recordingPath || !subtitlePath) {
      return { ok: false, error: 'invalid_path' }
    }
    try {
      const transcriptPath = importVerbatimCaptions(recordingPath, subtitlePath, language)
      return { ok: true, transcriptPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ── SundayStage auto-chapters (Fase 2) ────────────────────────────────────
  // Apply a Stage service-manifest to a recording → chapters in .meta.json +
  // setlist in .service.json. The recording's start (for time alignment) comes
  // from its history entry; falls back to the manifest's startedAtMs.
  ipcMain.handle('integrations-stage-import', (_evt, recordingPath: string, manifestPath: string, wasStreamed?: boolean) => {
    if (typeof recordingPath !== 'string' || typeof manifestPath !== 'string' || !recordingPath || !manifestPath) {
      return { ok: false, error: 'invalid_path' }
    }
    try {
      const entry = store.findHistoryByPath(recordingPath)
      let startMs = entry?.date && entry?.startTime ? Date.parse(`${entry.date}T${entry.startTime}:00`) : NaN
      const durationSec = entry?.durationSec
      if (Number.isNaN(startMs)) {
        const m = parseStageManifest(fs.readFileSync(manifestPath, 'utf8'))
        if (!m) return { ok: false, error: 'invalid_manifest' }
        startMs = m.startedAtMs
      }
      const result = applyStageManifest(recordingPath, manifestPath, startMs, {
        durationSec,
        wasStreamed,
        serviceDate: entry?.date,
      })
      return { ok: true, ...result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
