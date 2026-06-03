import { t } from '../../i18n'
import { E, $ } from './state'
import { clampMain } from './geometry'

// ── Mastering panel ─────────────────────────────────────────────────────────

interface MasterPresetView {
  id: string; label: string; description: string
  targetLufs: number; targetLra: number; truePeakDb: number; filters: string
}

let masterPresets: MasterPresetView[] = []
let masterJobId   = ''
let masterPreviewPath = ''
let masterOriginalPreviewPath = ''
let masterProgressUnsubscribe: (() => void) | null = null

export async function setupMasteringPanel(): Promise<void> {
  const select       = $('master-preset-select') as HTMLSelectElement | null
  const btnPreview   = $('btn-master-preview') as HTMLButtonElement | null
  const btnListenO   = $('btn-master-listen-orig') as HTMLButtonElement | null
  const btnApply     = $('btn-master-apply') as HTMLButtonElement | null
  const btnCancel    = $('btn-master-cancel') as HTMLButtonElement | null
  const btnOpenFold  = $('btn-master-open-folder') as HTMLButtonElement | null
  const btnListenDn  = $('btn-master-listen-done') as HTMLButtonElement | null

  if (!select || !btnPreview || !btnApply) return

  // Fetch presets once. Network roundtrip is local IPC — fast.
  try { masterPresets = await window.api.masterPresets() } catch { masterPresets = [] }

  // Populate selector. Pre-select the recommended preset (speech-clear).
  select.innerHTML = ''
  for (const p of masterPresets) {
    const opt = document.createElement('option')
    opt.value = p.id
    opt.textContent = p.label
    select.appendChild(opt)
  }
  const recommended = masterPresets.find(p => p.id === 'speech-clear') ?? masterPresets[0]
  if (recommended) select.value = recommended.id
  updateMasterDesc()

  select.addEventListener('change', updateMasterDesc)

  btnPreview.addEventListener('click', () => runMasterPreview())
  btnListenO?.addEventListener('click', () => toggleListenOriginal())
  btnApply.addEventListener('click', () => runMasterApply())
  btnCancel?.addEventListener('click', () => runMasterCancel())
  btnOpenFold?.addEventListener('click', () => {
    const out = btnOpenFold.dataset.path
    if (out) window.api.revealFile(out).catch(() => {})
  })
  btnListenDn?.addEventListener('click', () => {
    const out = btnListenDn.dataset.path
    if (!out) return
    const audio = $('master-preview-audio') as HTMLAudioElement | null
    if (!audio) return
    audio.src = 'file://' + out
    audio.style.display = ''
    audio.play().catch(() => {})
  })

  // Progress channel listener (set up once; outlives panel rebuilds)
  if (masterProgressUnsubscribe) { try { masterProgressUnsubscribe() } catch {} ; masterProgressUnsubscribe = null }
  const unsub = window.api.on('master-progress', (data: unknown) => {
    const { currentSec, totalSec } = data as { currentSec: number; totalSec: number }
    const bar   = $('master-progress-bar')
    const label = $('master-status-label')
    const pct = totalSec > 0 ? Math.min(99, Math.round((currentSec / totalSec) * 100)) : 0
    if (bar)   bar.style.width = pct + '%'
    if (label) label.textContent = `${t('master.applying', 'Mastrer…')} ${pct}%`
  })
  if (typeof unsub === 'function') masterProgressUnsubscribe = unsub
}

export function updateMasterDesc(): void {
  const select = $('master-preset-select') as HTMLSelectElement | null
  const descEl = $('master-preset-desc')
  if (!select || !descEl) return
  const p = masterPresets.find(x => x.id === select.value)
  descEl.textContent = p ? p.description : ''
}

export function getSelectedPreset(): MasterPresetView | null {
  const select = $('master-preset-select') as HTMLSelectElement | null
  if (!select) return null
  return masterPresets.find(p => p.id === select.value) ?? null
}

export async function runMasterPreview(): Promise<void> {
  if (!E.filePath) return
  const preset = getSelectedPreset()
  if (!preset) return
  const btn   = $('btn-master-preview') as HTMLButtonElement | null
  const audio = $('master-preview-audio') as HTMLAudioElement | null
  const btnListenO = $('btn-master-listen-orig') as HTMLButtonElement | null
  const label = $('master-status-label')
  const row   = $('master-status-row')
  const bar   = $('master-progress-bar')

  if (btn) { btn.disabled = true; btn.textContent = t('master.applying', 'Lager forhåndsvisning…') }
  if (row) row.style.display = ''
  if (bar) bar.style.width = '20%'
  if (label) label.textContent = t('master.applying', 'Lager forhåndsvisning…')

  const start = Math.max(0, Math.min(E.duration > 15 ? E.duration - 15 : 0, clampMain(E.playStartSec)))
  try {
    const res = await window.api.masterPreview(E.filePath, preset.id, start, 15)
    if (!res.ok || !res.previewPath) {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${res.error ?? 'unknown'}`
      return
    }
    masterPreviewPath = res.previewPath
    if (audio) {
      audio.src = 'file://' + res.previewPath
      audio.style.display = ''
      audio.play().catch(() => {})
    }
    if (btnListenO) btnListenO.style.display = ''
    if (label) label.textContent = t('master.done', '✓ Forhåndsvisning klar')
    if (bar)   bar.style.width   = '100%'
  } catch (err) {
    if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${(err as Error).message}`
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('master.preview', 'Lytt på forhåndsvisning') }
  }
}

export function toggleListenOriginal(): void {
  const audio = $('master-preview-audio') as HTMLAudioElement | null
  const btn   = $('btn-master-listen-orig') as HTMLButtonElement | null
  if (!audio || !btn) return
  if (!masterOriginalPreviewPath || audio.dataset.mode !== 'orig') {
    // Play original snippet — file:// directly (browser decodes locally).
    audio.src = 'file://' + E.filePath
    audio.currentTime = clampMain(E.playStartSec)
    audio.dataset.mode = 'orig'
    btn.textContent = t('master.previewListenMastered', 'Lytt mastret')
    audio.style.display = ''
    audio.play().catch(() => {})
  } else if (masterPreviewPath) {
    audio.src = 'file://' + masterPreviewPath
    audio.dataset.mode = 'mast'
    btn.textContent = t('master.previewListenOrig', 'Lytt original')
    audio.play().catch(() => {})
  }
}

export function deriveMasteredPath(input: string): string {
  // <dir>/<stem>_mastert.<ext>  — keep the source extension/codec format
  const lastSep   = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  const dir       = lastSep >= 0 ? input.slice(0, lastSep + 1) : ''
  const file      = lastSep >= 0 ? input.slice(lastSep + 1)    : input
  const lastDot   = file.lastIndexOf('.')
  const stem      = lastDot > 0 ? file.slice(0, lastDot) : file
  const ext       = lastDot > 0 ? file.slice(lastDot + 1).toLowerCase() : 'mp3'
  return dir + stem + '_mastert.' + ext
}

export async function runMasterApply(): Promise<void> {
  if (!E.filePath) return
  const preset = getSelectedPreset()
  if (!preset) return
  const btnApply = $('btn-master-apply')  as HTMLButtonElement | null
  const btnPrv   = $('btn-master-preview') as HTMLButtonElement | null
  const btnCancel = $('btn-master-cancel') as HTMLButtonElement | null
  const row    = $('master-status-row')
  const bar    = $('master-progress-bar')
  const label  = $('master-status-label')
  const resRow = $('master-result-row')

  if (btnApply)  { btnApply.disabled  = true }
  if (btnPrv)    { btnPrv.disabled    = true }
  if (btnCancel) { btnCancel.style.display = '' }
  if (row)       { row.style.display = '' }
  if (bar)       { bar.style.width   = '5%' }
  if (label)     { label.textContent = t('master.applying', 'Mastrer…') + ' (måler lydstyrke…)' }
  if (resRow)    { resRow.style.display = 'none' }

  masterJobId = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
  const outPath = deriveMasteredPath(E.filePath)

  try {
    // Pass 1: measure
    const measureRes = await window.api.masterMeasure(E.filePath, preset.id)
    if (!measureRes.ok || !measureRes.measurement) {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${measureRes.error ?? 'measure_failed'}`
      return
    }
    const beforeLufs = measureRes.measurement.inputI
    if (label) label.textContent = `${t('master.applying', 'Mastrer…')} (${t('master.lufsBefore', 'Original')}: ${beforeLufs.toFixed(1)} LUFS → ${preset.targetLufs} LUFS)`
    if (bar) bar.style.width = '15%'

    // Pass 2: apply
    const applyRes = await window.api.masterApply({
      inputPath:   E.filePath,
      outputPath:  outPath,
      presetId:    preset.id,
      measurement: measureRes.measurement,
      jobId:       masterJobId,
    })

    if (applyRes.ok && applyRes.outputPath) {
      if (bar)   bar.style.width   = '100%'
      if (label) label.textContent = t('master.done', '✓ Mastret') +
        ` — ${t('master.lufsBefore', 'Original')}: ${beforeLufs.toFixed(1)} LUFS → ` +
        `${t('master.lufsAfter', 'Etter')}: ${preset.targetLufs} LUFS`
      const resText = $('master-result-text')
      const fname = applyRes.outputPath.split(/[/\\]/).pop() ?? ''
      if (resText) resText.textContent = (t('master.done', '✓ Mastret')) + (fname ? ' — ' + fname : '')
      if (resRow)  resRow.style.display = ''
      const btnOpenFold = $('btn-master-open-folder') as HTMLButtonElement | null
      const btnListenDn = $('btn-master-listen-done') as HTMLButtonElement | null
      if (btnOpenFold) { btnOpenFold.style.display = ''; btnOpenFold.dataset.path = applyRes.outputPath }
      if (btnListenDn) { btnListenDn.style.display = ''; btnListenDn.dataset.path = applyRes.outputPath }
    } else {
      if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${applyRes.error ?? 'apply_failed'}`
    }
  } catch (err) {
    if (label) label.textContent = `${t('master.error', '✕ Feil')}: ${(err as Error).message}`
  } finally {
    if (btnApply)  btnApply.disabled  = false
    if (btnPrv)    btnPrv.disabled    = false
    if (btnCancel) btnCancel.style.display = 'none'
    masterJobId = ''
  }
}

export async function runMasterCancel(): Promise<void> {
  if (!masterJobId) return
  try { await window.api.masterCancel(masterJobId) } catch {}
  const label = $('master-status-label')
  if (label) label.textContent = t('master.cancel', 'Avbrutt')
}
