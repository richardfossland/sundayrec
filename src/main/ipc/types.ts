/**
 * Shared context passed to every per-domain IPC registration function.
 *
 * Previously `index.ts` housed all ~95 `ipcMain.handle(…)` calls in a single
 * 1200-line setupIPC() function. The handlers referenced module-local state
 * (`mainWindow`, `sendBackendWarning`, etc.) via closure. As we split each
 * domain (cloud, editor, stream, …) into its own file, the same state needs
 * to be available — but as a parameter instead of a closure capture.
 *
 * The `mainWindow` field is intentionally a getter — index.ts reassigns its
 * `mainWindow` variable when crash-recovery recreates the BrowserWindow, and
 * any IPC handler that captured the OLD reference would write to a destroyed
 * window. A getter keeps the handlers pointing at whatever main currently
 * has, even after a recovery cycle.
 */

import type { BrowserWindow } from 'electron'

export interface IpcContext {
  /** Current main BrowserWindow — null only before createWindow() runs. */
  readonly mainWindow: BrowserWindow | null

  /** Surface a non-fatal warning to the renderer via the existing
   *  `backend-warning` channel (also drives tray icon + email banner). */
  sendBackendWarning: (msg: string, severity: 'warn' | 'error', category: string) => void
}
