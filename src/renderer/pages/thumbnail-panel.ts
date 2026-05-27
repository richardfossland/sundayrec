/**
 * thumbnail-panel — shared UI plumbing for the cover-art panels in the editor
 * (per-episode) and publish settings (default). Both have the same DOM shape;
 * this module wires file picker, drag-drop, validation warnings, preview
 * rendering, and clear/reset buttons against the appropriate IPC endpoints.
 */

import { t } from '../i18n'
import type { ThumbnailInfo, ThumbnailResolved, ThumbnailResult } from '../main'

const APPLE_MIN_PX = 1400
const ASPECT_TOLERANCE = 0.05
const WARN_BYTES = 5 * 1024 * 1024

export interface ThumbPanelEls {
  preview:    HTMLElement
  using:      HTMLElement
  info:       HTMLElement
  warning:    HTMLElement
  pickBtn:    HTMLButtonElement
  clearBtn:   HTMLButtonElement
  resetBtn?:  HTMLButtonElement   // only on editor (per-episode) panel
  /** Hidden <input type="file"> retained in the DOM as a future fallback path
   *  (e.g. tests, non-Electron contexts) — pickers go through IPC for now. */
  fileInput?: HTMLInputElement
}

export type ThumbPanelMode =
  | { kind: 'default' }                                 // publish-page card
  | { kind: 'episode'; getRecordingPath: () => string } // editor panel

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function fmtInfo(info: ThumbnailInfo): string {
  // Template: "{w}×{h} px · {size}" — kept simple, applies in every locale.
  const tmpl = t('thumbnail.info.size', '{w}×{h} px · {size}')
  return tmpl
    .replace('{w}', String(info.width))
    .replace('{h}', String(info.height))
    .replace('{size}', fmtBytes(info.byteSize))
}

function buildWarnings(info: ThumbnailInfo): string[] {
  const warnings: string[] = []
  if (info.width > 0 && info.height > 0) {
    if (info.width < APPLE_MIN_PX || info.height < APPLE_MIN_PX) {
      warnings.push(t('thumbnail.warning.tooSmall', 'Anbefalt størrelse er minst 1400×1400 piksler'))
    }
    const aspect = info.width / info.height
    if (Math.abs(aspect - 1) > ASPECT_TOLERANCE) {
      warnings.push(t('thumbnail.warning.notSquare', 'Cover art bør være kvadratisk (1:1)'))
    }
  }
  if (info.byteSize > WARN_BYTES) {
    warnings.push(t('thumbnail.warning.tooLarge', 'Filstørrelse over 5 MB kan gjøre opptak/last opp tregt'))
  }
  return warnings
}

function errorLabel(code: string): string {
  if (code === 'unsupported_format') return t('thumbnail.error.unsupported', 'Ikke-støttet bildeformat. Bruk JPG, PNG eller WebP.')
  if (code === 'too_large')          return t('thumbnail.error.tooLarge',    'Filen er for stor (over 20 MB)')
  if (code === 'empty_file')         return t('thumbnail.error.unsupported', 'Ikke-støttet bildeformat. Bruk JPG, PNG eller WebP.')
  return code
}

function renderResolved(els: ThumbPanelEls, mode: ThumbPanelMode, res: ThumbnailResolved | null): void {
  els.preview.innerHTML = ''
  if (!res) {
    const ph = document.createElement('span')
    ph.className = 'thumb-placeholder'
    ph.textContent = t('thumbnail.dropHint', 'Slipp et bilde her, eller klikk for å velge')
    els.preview.appendChild(ph)
    els.using.textContent = t('thumbnail.using.none', 'Ingen cover art valgt')
    els.info.textContent = ''
    els.warning.style.display = 'none'
    els.warning.textContent = ''
    els.clearBtn.style.display = 'none'
    if (els.resetBtn) els.resetBtn.style.display = 'none'
    els.pickBtn.textContent = t('thumbnail.pick', 'Velg bilde')
    return
  }
  const img = document.createElement('img')
  img.src = res.dataUrl
  img.alt = ''
  els.preview.appendChild(img)

  if (mode.kind === 'episode' && res.kind === 'episode') {
    els.using.textContent = t('thumbnail.using.override', 'Egendefinert for denne episoden')
    if (els.resetBtn) els.resetBtn.style.display = ''
    els.clearBtn.style.display = 'none'
  } else if (mode.kind === 'episode' && res.kind === 'default') {
    els.using.textContent = t('thumbnail.using.default', 'Bruker standardbilde')
    if (els.resetBtn) els.resetBtn.style.display = 'none'
    els.clearBtn.style.display = 'none'
  } else {
    // default panel — kind is omitted by getDefaultInfo
    els.using.textContent = t('thumbnail.using.default', 'Bruker standardbilde')
    els.clearBtn.style.display = ''
    if (els.resetBtn) els.resetBtn.style.display = 'none'
  }

  els.info.textContent = fmtInfo(res.info)
  const warns = buildWarnings(res.info)
  if (warns.length) {
    els.warning.textContent = warns.join('  •  ')
    els.warning.style.display = ''
  } else {
    els.warning.style.display = 'none'
    els.warning.textContent = ''
  }
  els.pickBtn.textContent = t('thumbnail.replace', 'Bytt bilde')
}

function showError(els: ThumbPanelEls, msg: string): void {
  els.warning.textContent = msg
  els.warning.style.display = ''
}

async function applyResult(els: ThumbPanelEls, mode: ThumbPanelMode, result: ThumbnailResult | null): Promise<void> {
  if (!result) {
    // user cancelled the picker — keep existing state, refresh anyway in case
    return
  }
  if ('error' in result) {
    showError(els, errorLabel(result.error))
    return
  }
  // For both modes a successful set means re-resolve and re-render.
  await refresh(els, mode)
}

export async function refresh(els: ThumbPanelEls, mode: ThumbPanelMode): Promise<void> {
  if (mode.kind === 'default') {
    const r = await window.api.thumbnailGetDefaultInfo()
    renderResolved(els, mode, r)
    return
  }
  const recordingPath = mode.getRecordingPath()
  if (!recordingPath) {
    renderResolved(els, mode, null)
    return
  }
  const r = await window.api.thumbnailResolve(recordingPath)
  renderResolved(els, mode, r)
}

export function setupThumbPanel(els: ThumbPanelEls, mode: ThumbPanelMode): void {
  // Click preview opens the picker via the OS dialog (lets us validate
  // path + size before allowing the renderer to upload the bytes).
  els.preview.addEventListener('click', () => { els.pickBtn.click() })

  els.pickBtn.addEventListener('click', async () => {
    if (mode.kind === 'default') {
      const r = await window.api.thumbnailSetDefault()
      await applyResult(els, mode, r as ThumbnailResult | null)
    } else {
      const rp = mode.getRecordingPath()
      if (!rp) return
      const r = await window.api.thumbnailSetEpisode(rp)
      await applyResult(els, mode, r as ThumbnailResult | null)
    }
  })

  els.clearBtn.addEventListener('click', async () => {
    if (mode.kind === 'default') {
      await window.api.thumbnailClearDefault()
    } else {
      const rp = mode.getRecordingPath()
      if (rp) await window.api.thumbnailClearEpisode(rp)
    }
    await refresh(els, mode)
  })

  if (els.resetBtn) {
    els.resetBtn.addEventListener('click', async () => {
      if (mode.kind !== 'episode') return
      const rp = mode.getRecordingPath()
      if (rp) await window.api.thumbnailClearEpisode(rp)
      await refresh(els, mode)
    })
  }

  // Drag-and-drop onto the preview — accept the first dropped image file.
  els.preview.addEventListener('dragover', (e) => {
    e.preventDefault()
    els.preview.classList.add('drop-target')
  })
  els.preview.addEventListener('dragleave', () => {
    els.preview.classList.remove('drop-target')
  })
  els.preview.addEventListener('drop', async (e) => {
    e.preventDefault()
    els.preview.classList.remove('drop-target')
    const file = e.dataTransfer?.files?.[0]
    if (!file) return
    // Electron exposes a non-standard `path` on File for native drops.
    const filePath = (file as File & { path?: string }).path
    if (!filePath) return
    if (mode.kind === 'default') {
      const r = await window.api.thumbnailSetDefault(filePath)
      await applyResult(els, mode, r as ThumbnailResult | null)
    } else {
      const rp = mode.getRecordingPath()
      if (!rp) return
      const r = await window.api.thumbnailSetEpisode(rp, filePath)
      await applyResult(els, mode, r as ThumbnailResult | null)
    }
  })
}

/** Look up DOM nodes for one of the panel locations. Returns null when the
 *  page wrapper isn't in the DOM yet (test or partial render). */
export function panelElementsByPrefix(prefix: 'editor' | 'publish'): ThumbPanelEls | null {
  const preview = document.getElementById(`${prefix}-thumb-preview`)
  const using = document.getElementById(`${prefix}-thumb-using`)
  const info = document.getElementById(`${prefix}-thumb-info`)
  const warning = document.getElementById(`${prefix}-thumb-warning`)
  const pickBtn = document.getElementById(`btn-${prefix}-thumb-pick`) as HTMLButtonElement | null
  const clearBtn = document.getElementById(`btn-${prefix}-thumb-clear`) as HTMLButtonElement | null
  const fileInput = document.getElementById(`${prefix}-thumb-file-input`) as HTMLInputElement | null
  const resetBtn = document.getElementById(`btn-${prefix}-thumb-reset`) as HTMLButtonElement | null
  if (!preview || !using || !info || !warning || !pickBtn || !clearBtn) return null
  return {
    preview, using, info, warning, pickBtn, clearBtn,
    fileInput: fileInput ?? undefined,
    resetBtn:  resetBtn  ?? undefined,
  }
}
