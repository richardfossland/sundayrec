import type { Settings } from '../types'

export let settings: Settings = {} as Settings

export function updateSettings(next: Settings): void {
  settings = next
}

export function patchSettings(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch }
}

/**
 * Debounced save — collapses rapid setting changes into a single IPC
 * round-trip + disk write. Pages with sliders / fast-changing inputs
 * (audio EQ, video bitrate, overlays) call this on every change without
 * worrying about flooding the main process with `save-settings` IPC,
 * which would otherwise spam scheduler.reschedule(), wake.reschedule()
 * and OS login-item updates per keystroke.
 *
 * The trailing edge (default 400 ms) is short enough to feel
 * instantaneous in the UI yet long enough to coalesce a typical
 * drag-the-slider gesture into one write. Returns a promise that
 * resolves when the final save actually completes (so callers can
 * `await` knowing the persisted state is fresh).
 */
let _saveTimer: ReturnType<typeof setTimeout> | null = null
let _savePending: Promise<boolean> | null = null
let _saveResolve: ((ok: boolean) => void) | null = null

export function saveSettingsDebounced(delayMs = 400): Promise<boolean> {
  if (!_savePending) {
    _savePending = new Promise<boolean>(resolve => { _saveResolve = resolve })
  }
  if (_saveTimer) clearTimeout(_saveTimer)
  _saveTimer = setTimeout(() => {
    _saveTimer = null
    const resolve = _saveResolve
    _saveResolve = null
    _savePending = null
    window.api.saveSettings(settings).then(
      ok => resolve?.(!!ok),
      () => resolve?.(false),
    )
  }, delayMs)
  return _savePending
}

/** Flush any pending debounced save immediately. Use this before app shutdown
 *  or right before navigating to a page that depends on persisted state. */
export async function flushSavePending(): Promise<void> {
  if (!_saveTimer) return
  clearTimeout(_saveTimer)
  _saveTimer = null
  const resolve = _saveResolve
  _saveResolve = null
  _savePending = null
  const ok = await window.api.saveSettings(settings).catch(() => false)
  resolve?.(!!ok)
}
