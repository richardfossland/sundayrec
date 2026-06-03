/**
 * Stage-kapitler UI — «↧ Stage-kapitler»-knapp i analyse-panelet.
 *
 * Vises kun når Stage-integrasjon er skrudd på. Lar brukeren velge
 * Stage-manifestet (service-manifest.json) og kaller main-prosessen som
 * aligner timestamps → ChapterMarker[] → .meta.json. Tegner waveform om igjen
 * (kapitler vises som cyan streker på tidslinjen).
 */

import { E } from './state'
import { drawWaveform } from './waveform'

const $ = (id: string) => document.getElementById(id)

/** Kall én gang fra setupEditorPage — kobler knappen. */
export function setupStageUi(): void {
  $('btn-stage-import')?.addEventListener('click', runStageImport)
}

/** Oppdaterer synligheten basert på integrasjonsinnstillingene. Kalles ved
 *  fil-last (loadFile) og ved settings-endring. */
export async function updateStageButton(): Promise<void> {
  const btn = $('btn-stage-import') as HTMLElement | null
  if (!btn) return
  let show = false
  try {
    if (E.filePath) {
      const s = await window.api.getIntegrationSettings()
      show = !!s.enabled && !!s.stage?.enabled
    }
  } catch { show = false }
  btn.style.display = show ? '' : 'none'
}

async function runStageImport(): Promise<void> {
  if (!E.filePath) return
  const btn = $('btn-stage-import') as HTMLButtonElement | null

  // Åpne fil-velger for manifested (ingen native dialog-IPC er nødvendig —
  // vi bruker input[type=file] via en skjult input-element-trick).
  const manifestPath = await pickFile(['.json'])
  if (!manifestPath) return

  const wasStreamed = !!(window.api as unknown as Record<string, unknown>)  // henter fra stream-settings hvis tilgjengelig
  // Enkelt: sjekk om SundayRec faktisk streamet (settings.streamDestinations)
  const settings = await window.api.getSettings()
  const isStreaming = !!(settings as { streamDestinations?: unknown[] }).streamDestinations?.length

  if (btn) { btn.textContent = '…'; (btn as HTMLButtonElement).disabled = true }
  try {
    const res = await window.api.stageImport(E.filePath, manifestPath, isStreaming)
    if (res.ok) {
      // Refresh metadata in the editor — re-read the sidecar just written.
      const meta = await window.api.editorReadMeta?.(E.filePath) as { chapters?: unknown[] } | null
      if (meta?.chapters && Array.isArray(meta.chapters)) {
        E.meta.chapters = meta.chapters as typeof E.meta.chapters
        drawWaveform()
      }
      if (btn) btn.textContent = `✓ ${res.chapterCount} kapitler, ${res.songCount} sanger`
      setTimeout(() => { if (btn) { btn.textContent = '↧ Stage-kapitler'; (btn as HTMLButtonElement).disabled = false } }, 3000)
    } else {
      if (btn) btn.textContent = res.error === 'invalid_manifest' ? '✕ Ugyldig manifest' : '✕ Feil'
      setTimeout(() => { if (btn) { btn.textContent = '↧ Stage-kapitler'; (btn as HTMLButtonElement).disabled = false } }, 2500)
    }
  } catch {
    if (btn) { btn.textContent = '✕ Feil'; setTimeout(() => { if (btn) { btn.textContent = '↧ Stage-kapitler'; (btn as HTMLButtonElement).disabled = false } }, 2500) }
  }
}

/** Åpne en fil-velger for JSON-filer. Returnerer absolutt sti eller null. */
function pickFile(accept: string[]): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept.join(',')
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      document.body.removeChild(input)
      // Renderer can only read the file object; for the main-process path we
      // use window.api.editorPickFile-style approach — but a simpler path
      // here: re-use the file path via the webkitRelativePath or name. For
      // local Electron apps the file system path IS accessible.
      resolve(file ? (file as File & { path?: string }).path ?? file.name : null)
    })
    input.addEventListener('cancel', () => { document.body.removeChild(input); resolve(null) })
    input.click()
  })
}
