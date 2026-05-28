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
import * as store from '../store'
import { readServiceLink } from '../integrations/service-link'
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
}
