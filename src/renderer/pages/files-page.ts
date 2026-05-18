import { settings, patchSettings } from '../state'
import type { FileFormat, FilenamePattern } from '../../types'
import { flashSaved, setVal, setRadio, isoDate } from '../helpers'
import { getChurchHolidays } from '../../shared/church-calendar'

export function setupFilesPage(): void {
  document.getElementById('btn-pick-folder')?.addEventListener('click', async () => {
    const folder = await window.api.pickFolder()
    if (folder) {
      setVal('save-folder', folder)
      patchSettings({ saveFolder: folder })
    }
  })

  document.getElementById('btn-pick-intro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (fp) {
      patchSettings({ editorIntroPath: fp })
      updateIntroOutroDisplay()
    }
  })
  document.getElementById('btn-clear-intro')?.addEventListener('click', () => {
    patchSettings({ editorIntroPath: undefined })
    updateIntroOutroDisplay()
  })
  document.getElementById('btn-pick-outro')?.addEventListener('click', async () => {
    const fp = await window.api.pickAudioFile()
    if (fp) {
      patchSettings({ editorOutroPath: fp })
      updateIntroOutroDisplay()
    }
  })
  document.getElementById('btn-clear-outro')?.addEventListener('click', () => {
    patchSettings({ editorOutroPath: undefined })
    updateIntroOutroDisplay()
  })
  document.getElementById('pattern-select')?.addEventListener('change', updateFilenamePreview)
  document.querySelectorAll('input[name="format"]').forEach(r =>
    r.addEventListener('change', () => { toggleMp3Quality(); updateFilenamePreview() })
  )
  document.getElementById('opt-auto-delete')?.addEventListener('change', function (this: HTMLInputElement) {
    const row = document.getElementById('auto-delete-days-row')
    if (row) row.style.display = this.checked ? 'block' : 'none'
  })
  document.getElementById('opt-trim-silence')?.addEventListener('change', () => {/* live preview not needed */})
  document.getElementById('btn-files-save')?.addEventListener('click', saveFilesSettings)
  document.getElementById('btn-files-cancel')?.addEventListener('click', () => applyFilesSettingsToUI())
}

export function applyFilesSettingsToUI(): void {
  setVal('save-folder', settings.saveFolder ?? '')
  const patternEl = document.getElementById('pattern-select') as HTMLSelectElement | null
  if (patternEl) patternEl.value = settings.filenamePattern ?? 'date'
  setRadio('format',  settings.format          ?? 'mp3')
  setRadio('bitrate', String(settings.bitrate  ?? '192'))
  const autoDelEl = document.getElementById('opt-auto-delete') as HTMLInputElement | null
  if (autoDelEl) {
    autoDelEl.checked = !!settings.autoDeleteDays
    const daysEl = document.getElementById('auto-delete-days') as HTMLInputElement | null
    const rowEl  = document.getElementById('auto-delete-days-row')
    if (daysEl) daysEl.value = String(settings.autoDeleteDays || 90)
    if (rowEl)  rowEl.style.display = settings.autoDeleteDays ? 'block' : 'none'
  }
  const trimEl = document.getElementById('opt-trim-silence') as HTMLInputElement | null
  if (trimEl) trimEl.checked = !!settings.trimSilence
  toggleMp3Quality()
  updateFilenamePreview()
  updateIntroOutroDisplay()
}

function updateIntroOutroDisplay(): void {
  const introEl = document.getElementById('intro-path-display')
  const outroEl = document.getElementById('outro-path-display')
  const clrIntro = document.getElementById('btn-clear-intro')
  const clrOutro = document.getElementById('btn-clear-outro')
  if (introEl) {
    const name = settings.editorIntroPath?.split(/[/\\]/).pop() ?? ''
    introEl.textContent = name || 'Ingen fil valgt'
    introEl.style.color = name ? '' : 'var(--text3)'
    if (clrIntro) clrIntro.style.display = name ? '' : 'none'
  }
  if (outroEl) {
    const name = settings.editorOutroPath?.split(/[/\\]/).pop() ?? ''
    outroEl.textContent = name || 'Ingen fil valgt'
    outroEl.style.color = name ? '' : 'var(--text3)'
    if (clrOutro) clrOutro.style.display = name ? '' : 'none'
  }
}

export function toggleMp3Quality(): void {
  const fmt     = (document.querySelector('input[name="format"]:checked') as HTMLInputElement | null)?.value
  const mp3Sect = document.getElementById('mp3-quality-section')
  if (mp3Sect) mp3Sect.style.display = fmt === 'mp3' || fmt === 'aac' ? 'block' : 'none'
}

export function updateFilenamePreview(): void {
  const pattern = (document.getElementById('pattern-select') as HTMLSelectElement | null)?.value ?? 'date'
  const format  = (document.querySelector('input[name="format"]:checked')  as HTMLInputElement | null)?.value ?? 'mp3'
  const today   = new Date()
  const ds      = isoDate(today)
  let name: string
  if (pattern === 'church') {
    const hname = getChurchHolidays(today.getFullYear())[ds]
    name = hname ? `${hname.replace(/\s/g, '_')}_${ds}` : `Gudstjeneste_${ds}`
  } else if (pattern === 'plain') {
    name = `Gudstjeneste_${ds}`
  } else if (pattern === 'datetime') {
    name = `${ds}_${today.toTimeString().slice(0, 5).replace(':', '-')}`
  } else {
    name = ds
  }
  const prev = document.getElementById('filename-preview')
  if (prev) prev.textContent = `${name}.${format}`
}

async function saveFilesSettings(): Promise<void> {
  const autoDelEl   = document.getElementById('opt-auto-delete') as HTMLInputElement | null
  const autoDelDays = document.getElementById('auto-delete-days') as HTMLInputElement | null
  patchSettings({
    saveFolder:      (document.getElementById('save-folder') as HTMLInputElement | null)?.value ?? '',
    filenamePattern: ((document.getElementById('pattern-select') as HTMLSelectElement | null)?.value ?? 'date') as FilenamePattern,
    format:          ((document.querySelector('input[name="format"]:checked')  as HTMLInputElement | null)?.value ?? 'mp3') as FileFormat,
    bitrate:         (document.querySelector('input[name="bitrate"]:checked') as HTMLInputElement | null)?.value ?? '192',
    autoDeleteDays:  autoDelEl?.checked ? (+(autoDelDays?.value ?? '') || 90) : 0,
    trimSilence:     !!(document.getElementById('opt-trim-silence') as HTMLInputElement | null)?.checked,
    // intro/outro paths are saved immediately on pick, no need to re-read here
  })
  await window.api.saveSettings(settings)
  flashSaved(document.getElementById('btn-files-save'))
}
