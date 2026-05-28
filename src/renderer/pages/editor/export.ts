import { t } from '../../i18n'
import { settings } from '../../state'
import { E, $, clearDirty } from './state'
import { getExportFilters } from './peaks'
import { clearEditorDraft } from './cuts'
import { saveMetadata } from './metadata'

// ── Export + publish flow ───────────────────────────────────────────────────

export function openExportModal(): void {
  if (!E.filePath) return

  // Show/hide format section vs video notice
  const fmtSection   = $('export-fmt-section')
  const videoNotice  = $('export-video-notice')
  if (fmtSection)  fmtSection.style.display  = E.isVideoFile ? 'none' : ''
  if (videoNotice) videoNotice.style.display = E.isVideoFile ? '' : 'none'

  // Update gain summary — only shown when peak normalize has been applied.
  const procRow  = $('export-proc-row')
  const summary  = $('export-proc-summary')
  if (procRow && summary) {
    if (E.audioGainDb !== 0) {
      const sign = E.audioGainDb >= 0 ? '+' : ''
      summary.textContent = `${t('editor.normalizeApplied', 'Normalisert')} (${sign}${E.audioGainDb.toFixed(1)} dB → -1 dBFS)`
      procRow.style.display = ''
    } else {
      procRow.style.display = 'none'
    }
  }
  const ioRow     = $('export-io-row')
  const ioSummary = $('export-io-summary')
  if (ioRow && ioSummary) {
    const parts = []
    if (!E.isVideoFile) {
      if (E.includeIntroOutro && settings.editorIntroPath) {
        parts.push('Intro: ' + (settings.editorIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (E.includeIntroOutro && settings.editorOutroPath) {
        parts.push('Outro: ' + (settings.editorOutroPath.split(/[/\\]/).pop() ?? ''))
      }
    } else {
      if (E.includeIntroOutro && E.videoIntroPath) {
        parts.push('Video-intro: ' + (E.videoIntroPath.split(/[/\\]/).pop() ?? ''))
      }
      if (E.includeIntroOutro && E.videoOutroPath) {
        parts.push('Video-outro: ' + (E.videoOutroPath.split(/[/\\]/).pop() ?? ''))
      }
    }
    ioSummary.textContent = parts.length ? parts.join(' · ') : ''
    ioRow.style.display   = parts.length ? '' : 'none'
  }
  // Render publishing section
  void renderPublishOptions()

  const exportModal = $('editor-export-modal')
  if (exportModal) exportModal.style.display = 'flex'
}

// Publishing options state (mirrored from DOM into module on toggle)
export interface PublishState {
  gdrive:   boolean
  dropbox:  boolean
  onedrive: boolean
  podcast:  boolean
  youtube:  boolean
}
const publishSelections: PublishState = { gdrive: false, dropbox: false, onedrive: false, podcast: false, youtube: false }
let configuredCache: { gdrive: boolean; dropbox: boolean; onedrive: boolean; youtubeConnected: boolean } =
  { gdrive: false, dropbox: false, onedrive: false, youtubeConnected: false }

/**
 * Build the publishing checkbox list in the export modal. Each service is
 * shown ONLY if `cloudIsConfigured(...)` returns true (user has connected it).
 * Podcast appears when settings.podcast.enabled is true. If nothing is
 * configured, we show a single "Konfigurer publisering →" link to the
 * publish settings page.
 *
 * For video files we also append disabled placeholder rows for YouTube +
 * Vimeo so the user can see the roadmap.
 */
export async function renderPublishOptions(): Promise<void> {
  const wrap     = $('export-publish-options')
  const configL  = $('export-publish-configure')
  const andBtn   = $('btn-export-and-publish')
  const progress = $('export-publish-progress')
  if (!wrap || !configL || !andBtn) return

  wrap.innerHTML = ''
  if (progress) { progress.style.display = 'none'; progress.textContent = '' }

  // Refresh service configuration (cheap IPC) — these aren't expected to
  // change mid-session but the user could have configured one in another
  // window so we read fresh each open.
  try {
    configuredCache.gdrive   = await window.api.cloudIsConfigured('google-drive') as boolean
    configuredCache.dropbox  = await window.api.cloudIsConfigured('dropbox') as boolean
    configuredCache.onedrive = await window.api.cloudIsConfigured('onedrive') as boolean
    const yt = await window.api.youtubeStatus()
    configuredCache.youtubeConnected = !!yt?.connected
  } catch { /* leave defaults — falsy */ }

  const podcastEnabled = settings.podcast?.enabled === true

  const haveAny = configuredCache.gdrive || configuredCache.dropbox || configuredCache.onedrive || podcastEnabled || (E.isVideoFile && configuredCache.youtubeConnected)
  configL.style.display = haveAny ? 'none' : ''
  // The "Eksporter og publiser" button is only meaningful if at least one
  // service is configured.
  ;(andBtn as HTMLElement).style.display = haveAny ? '' : 'none'

  function addRow(key: keyof PublishState, label: string, enabled: boolean, disabled = false, tooltip = ''): void {
    const row = document.createElement('label')
    row.className = 'export-publish-option' + (disabled ? ' is-disabled' : '')
    if (tooltip) row.title = tooltip
    const chk = document.createElement('input')
    chk.type = 'checkbox'
    chk.disabled = disabled || !enabled
    chk.checked = false
    chk.addEventListener('change', () => { publishSelections[key] = chk.checked })
    const span = document.createElement('span')
    span.textContent = label
    row.appendChild(chk)
    row.appendChild(span)
    wrap!.appendChild(row)
  }

  // Reset selections each time we open
  publishSelections.gdrive   = false
  publishSelections.dropbox  = false
  publishSelections.onedrive = false
  publishSelections.podcast  = false
  publishSelections.youtube  = false

  if (configuredCache.gdrive)   addRow('gdrive',   t('editor.exportPublishGdrive',   'Last opp til Google Drive'), true)
  if (configuredCache.dropbox)  addRow('dropbox',  t('editor.exportPublishDropbox',  'Last opp til Dropbox'),       true)
  if (configuredCache.onedrive) addRow('onedrive', t('editor.exportPublishOnedrive', 'Last opp til OneDrive'),      true)
  if (podcastEnabled)           addRow('podcast',  t('editor.exportPublishPodcast',  'Oppdater podcast RSS-feed'),  true)

  // Video files: surface YouTube as an actionable row. If user is connected,
  // checkbox enables upload; otherwise we render a "Koble til YouTube"-link
  // so they can opt-in inline without leaving the modal.
  if (E.isVideoFile) {
    if (configuredCache.youtubeConnected) {
      addRow('youtube', t('editor.exportPublishYoutube', 'Last opp video til YouTube (privat)'), true)
    } else {
      const row = document.createElement('div')
      row.className = 'export-publish-option export-publish-connect-row'
      const span = document.createElement('span')
      span.textContent = t('editor.exportPublishYoutube', 'Last opp video til YouTube')
      const link = document.createElement('a')
      link.href = '#'
      link.className = 'export-publish-connect-link'
      link.textContent = t('editor.exportPublishYoutubeConnect', '→ Koble til YouTube')
      link.addEventListener('click', async (e) => {
        e.preventDefault()
        link.textContent = t('editor.exportPublishYoutubeConnecting', 'Åpner Google-pålogging…')
        const res = await window.api.youtubeConnect()
        if (res?.ok) {
          configuredCache.youtubeConnected = true
          await renderPublishOptions()
        } else {
          link.textContent = `${t('editor.exportPublishYoutubeFailed', 'Tilkobling feilet')}: ${res?.error ?? ''}`.slice(0, 80)
        }
      })
      row.appendChild(span)
      row.appendChild(link)
      wrap.appendChild(row)
    }

    // Vimeo placeholder remains for later phase — it has a fundamentally
    // different OAuth+API model so it's a separate workstream.
    const vmLabel = t('editor.exportPublishVimeo', 'Last opp video til Vimeo')
    const phase2  = t('editor.exportPublishPhase2', 'Kommer i en senere versjon — krever separat OAuth-oppsett')
    addRow('gdrive', vmLabel, false, /*disabled*/ true, phase2)
  }
}

/**
 * Run the selected publishing actions for a freshly-exported file. Surfaces
 * progress in the export modal (which is still up — we don't close it
 * until publishing completes). Idempotent on its own — the underlying
 * cloud queue dedupes by file path + service.
 */
export async function runPublishingForExport(outputPath: string): Promise<void> {
  const progress = $('export-publish-progress')
  if (progress) { progress.style.display = ''; progress.classList.remove('is-error', 'is-success'); progress.textContent = '' }

  const tasks: { label: string; run: () => Promise<{ ok: boolean; error?: string; url?: string }> }[] = []
  if (publishSelections.gdrive) {
    tasks.push({ label: 'Google Drive', run: () => window.api.cloudUploadFile('google-drive', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.dropbox) {
    tasks.push({ label: 'Dropbox', run: () => window.api.cloudUploadFile('dropbox', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.onedrive) {
    tasks.push({ label: 'OneDrive', run: () => window.api.cloudUploadFile('onedrive', outputPath) as Promise<{ ok: boolean; error?: string }> })
  }
  if (publishSelections.youtube) {
    // Build metadata from the file name + chapter metadata.
    const title = (E.meta.title?.trim() || (outputPath.split(/[/\\]/).pop() ?? 'SundayRec opptak')).replace(/\.[^.]+$/, '')
    const description = (E.meta.description ?? '').slice(0, 5000)
    tasks.push({
      label: 'YouTube',
      run: async () => {
        // Subscribe to progress events for this upload so the user sees a
        // live percentage instead of a frozen "Laster opp…" string. The
        // unsubscribe call is fired when the upload-promise settles.
        const unsub = window.api.on?.('youtube-upload-progress', (payload: unknown) => {
          if (progress && payload && typeof payload === 'object') {
            const { uploadedBytes, totalBytes } = payload as { uploadedBytes: number; totalBytes: number }
            if (totalBytes > 0) {
              const pct = Math.floor((uploadedBytes / totalBytes) * 100)
              progress.textContent = `${t('editor.publishUploading', 'Laster opp til')} YouTube… ${pct}%`
            }
          }
        })
        try {
          const r = await window.api.youtubeUpload(outputPath, {
            title,
            description,
            privacyStatus: 'private',  // safe default — user changes from YouTube Studio if they want public
          })
          return { ok: !!r?.ok, error: r?.error, url: r?.url }
        } finally {
          unsub?.()
        }
      },
    })
  }

  let allOk = true
  const messages: string[] = []
  for (const task of tasks) {
    if (progress) progress.textContent = `${t('editor.publishUploading', 'Laster opp til')} ${task.label}…`
    try {
      const r = await task.run()
      if (r && r.ok === false) {
        allOk = false
        messages.push(`${task.label}: ${r.error ?? 'feil'}`)
      } else if (r && r.url) {
        messages.push(`${task.label}: ✓ (${r.url})`)
      } else {
        messages.push(`${task.label}: ✓`)
      }
    } catch (err) {
      allOk = false
      messages.push(`${task.label}: ${(err as Error).message}`)
    }
  }

  // Podcast RSS regen runs last (after any uploads complete, since RSS may
  // reference the just-uploaded cloud URLs).
  if (publishSelections.podcast) {
    if (progress) progress.textContent = t('editor.publishRssUpdating', 'Oppdaterer RSS-feed…')
    const service = settings.podcast?.service ?? 'google-drive'
    try {
      const r = await window.api.podcastRegenerate(service) as { ok: boolean; error?: string }
      if (r && r.ok === false) {
        allOk = false
        messages.push(`RSS: ${r.error ?? 'feil'}`)
      } else {
        messages.push(`RSS: ✓`)
      }
    } catch (err) {
      allOk = false
      messages.push(`RSS: ${(err as Error).message}`)
    }
  }

  if (progress) {
    progress.classList.toggle('is-success', allOk)
    progress.classList.toggle('is-error', !allOk)
    progress.textContent = (allOk ? `${t('editor.publishDone', '✓ Publisering ferdig')} — ` : `${t('editor.publishFailed', '✕ Publisering feilet')} — `) + messages.join(' · ')
  }
}

export function closeExportModal(): void {
  const exportModal = $('editor-export-modal')
  if (exportModal) exportModal.style.display = 'none'
}

export async function runExport(): Promise<void> {
  closeExportModal()
  const btn      = $('btn-editor-save') as HTMLButtonElement
  const progRow  = $('editor-export-progress-row')
  const progBar  = $('editor-export-progress-bar')
  const progLbl  = $('editor-export-progress-label')
  const resultRow = $('editor-result-row')

  if (btn)     { btn.disabled = true; btn.textContent = t('editor.exportExporting') || 'Eksporterer…' }
  if (progRow) progRow.style.display = ''
  if (progBar) progBar.style.width   = '0%'
  if (resultRow) { resultRow.style.display = 'none' }

  const fmt = (document.querySelector<HTMLElement>('.export-fmt-btn.active')?.dataset.fmt ?? 'mp3') as 'mp3'|'wav'|'flac'|'aac'
  const dest = document.querySelector<HTMLElement>('.export-dest-btn.active')?.dataset.dest ?? 'same'
  const bitrate   = parseInt((($('export-bitrate')    as HTMLSelectElement)?.value  ?? '192'))
  const bitDepth  = parseInt((($('export-bitdepth')   as HTMLSelectElement)?.value  ?? '16')) as 16|24

  const mode: 'new' | 'replace' | 'folder' =
    dest === 'replace' ? 'replace' :
    dest === 'folder'  ? 'folder'  : 'new'

  // Auto-save metadata before export
  if (E.metaDirty) await saveMetadata()

  let result: { ok: boolean; outputPath?: string; error?: string }

  if (E.isVideoFile) {
    result = await window.api.editorExportVideo({
      inputPath:    E.filePath,
      cutRegions:   E.cuts,
      duration:     E.duration,
      mode,
      outputFolder: E.exportOutputFolder || undefined,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (E.includeIntroOutro && E.videoIntroPath) ? E.videoIntroPath : undefined,
      outroPath:  (E.includeIntroOutro && E.videoOutroPath) ? E.videoOutroPath : undefined,
      metadata:   E.meta,
    })
  } else {
    result = await window.api.editorExportFile({
      inputPath:    E.filePath,
      cutRegions:   E.cuts,
      duration:     E.duration,
      mode,
      outputFolder: E.exportOutputFolder || undefined,
      outputFormat: fmt,
      outputBitrate:  bitrate,
      outputBitDepth: bitDepth,
      processing: { ffmpegFilters: getExportFilters() },
      introPath:  (E.includeIntroOutro && settings.editorIntroPath) ? settings.editorIntroPath : undefined,
      outroPath:  (E.includeIntroOutro && settings.editorOutroPath) ? settings.editorOutroPath : undefined,
      metadata:   E.meta,
    })
  }

  if (progRow) progRow.style.display = 'none'
  if (progBar) progBar.style.width   = '0%'
  if (btn) { btn.disabled = false; btn.textContent = t('editor.save') || 'Eksporter' }

  const row  = $('editor-result-row')
  const text = $('editor-result-text')
  if (row) row.style.display = ''

  if (result.ok) {
    const fname = (result.outputPath ?? '').split(/[/\\]/).pop() ?? ''
    if (text) text.textContent = (t('editor.saveOk') || '✓ Eksportert') + (fname ? ' — ' + fname : '')
    if (row) row.setAttribute('data-ok', 'true')
    clearEditorDraft()  // export succeeded — drop the autosave sidecar
    clearDirty()
    // Run publishing if user picked "Eksporter og publiser"
    if (E.publishAfterExport && result.outputPath) {
      await runPublishingForExport(result.outputPath)
    }
    E.publishAfterExport = false
  } else {
    if (text) text.textContent = describeExportError(result.error)
    if (row) row.removeAttribute('data-ok')
  }
}

/**
 * Map an export error code from the main process to a user-friendly Norwegian
 * sentence. Falls back to the raw code so an unfamiliar error still surfaces
 * something the user can search for.
 */
export function describeExportError(err: string | undefined): string {
  switch (err) {
    case 'force_wav_replace_unsafe':
      return '✕ ' + t('editor.errReplaceUnsafe', 'Kan ikke overskrive originalfilen i dette formatet. Bruk "Lagre som ny fil" i stedet.')
    case 'no_audio_remaining':
      return '✕ ' + t('editor.errNoAudioRemaining', 'Ingen lyd igjen — kuttene dekker hele opptaket. Fjern minst ett kutt før du eksporterer.')
    case 'cancelled':
      return '✕ ' + t('editor.errCancelled', 'Eksport avbrutt.')
    case 'timeout':
      return '✕ ' + t('editor.errTimeout', 'Eksporten tok for lang tid og ble stoppet. Prøv igjen, eller del filen i flere mindre opptak.')
    case 'invalid_path':
    case 'file_not_found':
      return '✕ ' + t('editor.errFileNotFound', 'Originalfilen er ikke tilgjengelig — er disken frakoblet?')
    case 'invalid_duration':
    case 'invalid_cut_regions':
      return '✕ ' + t('editor.errCutData', 'Intern feil i kuttdataene. Prøv å laste filen på nytt.')
    default:
      return (t('editor.saveError') || '✕ Feil') + (err ? ': ' + err : '')
  }
}

export function updateExportFormatUI(fmt: string): void {
  const mp3  = $('export-mp3-opts')
  const wav  = $('export-wav-opts')
  const aac  = $('export-aac-opts')
  if (mp3) mp3.style.display = fmt === 'mp3' ? '' : 'none'
  if (wav) wav.style.display = fmt === 'wav' ? '' : 'none'
  if (aac) aac.style.display = fmt === 'aac' ? '' : 'none'
}
