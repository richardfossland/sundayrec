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
  document.querySelectorAll('input[name="pattern"]').forEach(r =>
    r.addEventListener('change', updateFilenamePreview)
  )
  document.querySelectorAll('input[name="format"]').forEach(r =>
    r.addEventListener('change', () => { toggleMp3Quality(); updateFilenamePreview() })
  )
  document.getElementById('opt-auto-delete')?.addEventListener('change', function (this: HTMLInputElement) {
    const row = document.getElementById('auto-delete-days-row')
    if (row) row.style.display = this.checked ? 'block' : 'none'
  })
  document.getElementById('btn-files-save')?.addEventListener('click', saveFilesSettings)
  document.getElementById('btn-files-cancel')?.addEventListener('click', () => applyFilesSettingsToUI())
}

export function applyFilesSettingsToUI(): void {
  setVal('save-folder', settings.saveFolder ?? '')
  setRadio('pattern', settings.filenamePattern ?? 'date')
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
  toggleMp3Quality()
  updateFilenamePreview()
}

export function toggleMp3Quality(): void {
  const fmt     = (document.querySelector('input[name="format"]:checked') as HTMLInputElement | null)?.value
  const mp3Sect = document.getElementById('mp3-quality-section')
  if (mp3Sect) mp3Sect.style.display = fmt === 'mp3' || fmt === 'aac' ? 'block' : 'none'
}

export function updateFilenamePreview(): void {
  const pattern = (document.querySelector('input[name="pattern"]:checked') as HTMLInputElement | null)?.value ?? 'date'
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
  const autoDelEl  = document.getElementById('opt-auto-delete') as HTMLInputElement | null
  const autoDelDays = document.getElementById('auto-delete-days') as HTMLInputElement | null
  patchSettings({
    saveFolder:      (document.getElementById('save-folder') as HTMLInputElement | null)?.value ?? '',
    filenamePattern: ((document.querySelector('input[name="pattern"]:checked') as HTMLInputElement | null)?.value ?? 'date') as FilenamePattern,
    format:          ((document.querySelector('input[name="format"]:checked')  as HTMLInputElement | null)?.value ?? 'mp3') as FileFormat,
    bitrate:         (document.querySelector('input[name="bitrate"]:checked') as HTMLInputElement | null)?.value ?? '192',
    autoDeleteDays:  autoDelEl?.checked ? (+(autoDelDays?.value ?? '') || 90) : 0
  })
  await window.api.saveSettings(settings)
  flashSaved(document.getElementById('btn-files-save'))
}
