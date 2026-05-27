import { settings, patchSettings } from '../state'
import { flashSaved, escHtml } from '../helpers'
import { t } from '../i18n'
import { notifyLivePageDestinationsChanged } from './live-page'
import { setupThumbPanel, refresh as refreshThumbPanel, panelElementsByPrefix } from './thumbnail-panel'
import type { CloudServiceId, CloudServiceSettings, CloudStatus, CloudQueueStatus, StreamDestinationStored } from '../../types'

type ServiceStatus = Record<CloudServiceId, CloudStatus>

let currentStatus: ServiceStatus = {
  'google-drive': { connected: false },
  'dropbox':      { connected: false },
  'onedrive':     { connected: false },
}

const SERVICE_NAMES: Record<CloudServiceId, string> = {
  'google-drive': 'Google Drive',
  'dropbox':      'Dropbox',
  'onedrive':     'OneDrive',
}

const configured: Record<CloudServiceId, boolean> = {
  'google-drive': true,
  'dropbox':      true,
  'onedrive':     true,
}

export function setupPublishPage(): void {
  refreshStatus()
  refreshConfigured()
  refreshQueue()
  setupStreamDestinations()

  // Default-thumbnail panel ("Standard episodebilde") — sits at the top of
  // the publish settings tab.
  const thumbEls = panelElementsByPrefix('publish')
  if (thumbEls) {
    setupThumbPanel(thumbEls, { kind: 'default' })
    void refreshThumbPanel(thumbEls, { kind: 'default' })
  }

  // Connect/disconnect buttons
  document.querySelectorAll<HTMLElement>('[data-cloud-connect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.cloudConnect as CloudServiceId
      if (!configured[service]) {
        showServiceError(service, `${SERVICE_NAMES[service]} ${t('publish.errNotConfigured', 'er ikke konfigurert i denne byggingen. Be utvikleren om en build med OAuth-nøkkel.')}`)
        return
      }
      btn.textContent = t('publish.connecting', 'Kobler til…')
      btn.setAttribute('disabled', '')

      // Allow the user to cancel a stuck OAuth flow
      const cancelBtn = ensureCancelButton(btn, service)
      cancelBtn.style.display = ''

      try {
        const result = await window.api.cloudConnect(service)
        if (result.ok) {
          refreshStatus()
        } else {
          showServiceError(service, result.error ?? 'Ukjent feil')
        }
      } finally {
        btn.removeAttribute('disabled')
        btn.textContent = 'Koble til'
        cancelBtn.style.display = 'none'
      }
    })
  })

  document.querySelectorAll<HTMLElement>('[data-cloud-disconnect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.cloudDisconnect as CloudServiceId
      await window.api.cloudDisconnect(service)
      refreshStatus()
    })
  })

  // Folder picker buttons
  document.querySelectorAll<HTMLElement>('[data-cloud-pick-folder]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.cloudPickFolder as CloudServiceId
      await openFolderPicker(service)
    })
  })

  // Auto-upload toggles
  document.querySelectorAll<HTMLInputElement>('[data-cloud-auto]').forEach(chk => {
    chk.addEventListener('change', () => {
      const service = chk.dataset.cloudAuto as CloudServiceId
      saveServiceSettings(service, { autoUpload: chk.checked })
    })
  })

  // Enabled toggles
  document.querySelectorAll<HTMLInputElement>('[data-cloud-enabled]').forEach(chk => {
    chk.addEventListener('change', () => {
      const service = chk.dataset.cloudEnabled as CloudServiceId
      saveServiceSettings(service, { enabled: chk.checked })
    })
  })

  // Manual upload buttons in history (delegated)
  document.addEventListener('cloud-manual-upload', async (e: Event) => {
    const detail = (e as CustomEvent).detail as { service: CloudServiceId; filePath: string }
    await window.api.cloudUploadFile(detail.service, detail.filePath)
    // Sky-backup is now on the Publisering tab; fall back to files-save if not present.
    flashSaved(document.getElementById('btn-publish-save') ?? document.getElementById('btn-files-save'))
  })

  // Listen for upload progress/done from main
  window.api.on('cloud-upload-progress', (data: unknown) => {
    const { service, filename } = data as { service: CloudServiceId; filename: string }
    showUploadStatus(service, `Laster opp ${filename}…`, false)
  })
  window.api.on('cloud-upload-done', (data: unknown) => {
    const { service, ok, error } = data as { service: CloudServiceId; ok: boolean; error?: string }
    showUploadStatus(service, ok ? '✓ Opplastet' : `✕ ${error ?? 'Feil'}`, !ok)
    refreshStatus()
  })
  window.api.on('cloud-queue-update', (data: unknown) => {
    renderQueue(data as CloudQueueStatus)
  })
}

async function refreshStatus(): Promise<void> {
  const status = await window.api.cloudStatus() as ServiceStatus
  currentStatus = status
  renderAllCards(status)
}

async function refreshConfigured(): Promise<void> {
  const services: CloudServiceId[] = ['google-drive', 'dropbox', 'onedrive']
  await Promise.all(services.map(async s => {
    try {
      configured[s] = await window.api.cloudIsConfigured(s) as boolean
    } catch { configured[s] = true }
  }))
  // Re-render so unconfigured cards show a notice
  renderAllCards(currentStatus)
}

async function refreshQueue(): Promise<void> {
  try {
    const q = await window.api.cloudQueueStatus() as CloudQueueStatus
    renderQueue(q)
  } catch (err) {
    console.error('[publish] refreshQueue failed:', err)
  }
}

function renderAllCards(status: ServiceStatus): void {
  const services: CloudServiceId[] = ['google-drive', 'dropbox', 'onedrive']
  for (const id of services) {
    renderCard(id, status[id])
  }
}

function renderCard(service: CloudServiceId, status: CloudStatus): void {
  const card = document.getElementById(`cloud-card-${service}`)
  if (!card) return

  const connectedSection   = card.querySelector<HTMLElement>('.cloud-connected')
  const disconnectedSection = card.querySelector<HTMLElement>('.cloud-disconnected')
  const accountNameEl      = card.querySelector<HTMLElement>('.cloud-account-name')
  const folderNameEl       = card.querySelector<HTMLElement>('.cloud-folder-name')
  const lastUploadEl       = card.querySelector<HTMLElement>('.cloud-last-upload')
  const autoChk            = card.querySelector<HTMLInputElement>('[data-cloud-auto]')
  const enabledChk         = card.querySelector<HTMLInputElement>('[data-cloud-enabled]')

  if (status.connected) {
    connectedSection?.style.setProperty('display', '')
    disconnectedSection?.style.setProperty('display', 'none')
    if (accountNameEl) accountNameEl.textContent = status.accountName ?? ''
    if (folderNameEl)  folderNameEl.textContent  = status.folderName ?? status.folderPath ?? 'Rotmappe'
    if (lastUploadEl) {
      lastUploadEl.textContent = status.lastUpload
        ? (status.lastUploadOk ? '✓ ' : '✕ ') + new Date(status.lastUpload).toLocaleString('no')
        : '—'
    }
    renderReauthBanner(card, service, status.needsReauth === true)
  } else {
    connectedSection?.style.setProperty('display', 'none')
    disconnectedSection?.style.setProperty('display', '')
    renderReauthBanner(card, service, false)
  }

  renderConfiguredNotice(card, service, configured[service])

  const settingsKey = service === 'google-drive' ? 'cloudGoogleDrive'
                    : service === 'dropbox'       ? 'cloudDropbox'
                    :                               'cloudOneDrive'
  const cfg = settings[settingsKey]
  if (autoChk)    autoChk.checked    = cfg?.autoUpload ?? false
  if (enabledChk) enabledChk.checked = cfg?.enabled    ?? false
}

/** Inject (or remove) a "reconnect needed" banner inside a service card. */
function renderReauthBanner(card: HTMLElement, service: CloudServiceId, needs: boolean): void {
  let banner = card.querySelector<HTMLElement>('.cloud-reauth-banner')
  if (!needs) { banner?.remove(); return }
  if (!banner) {
    banner = document.createElement('div')
    banner.className = 'cloud-reauth-banner'
    const text = document.createElement('div')
    text.textContent = `${SERVICE_NAMES[service]} ${t('publish.needsReauth', 'trenger pålogging på nytt. Klikk for å koble til.')}`
    const btn = document.createElement('button')
    const reauthLabel = t('publish.reauth', 'Koble til på nytt')
    btn.textContent = reauthLabel
    btn.className = 'cloud-reauth-btn'
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = t('publish.connecting', 'Kobler til…')
      try {
        const result = await window.api.cloudConnect(service)
        if (result.ok) refreshStatus()
        else { btn.disabled = false; btn.textContent = reauthLabel; showServiceError(service, result.error ?? t('publish.errUnknown', 'Ukjent feil')) }
      } catch {
        btn.disabled = false; btn.textContent = reauthLabel
      }
    })
    banner.append(text, btn)
    card.prepend(banner)
  }
}

function renderConfiguredNotice(card: HTMLElement, service: CloudServiceId, ok: boolean): void {
  let notice = card.querySelector<HTMLElement>('.cloud-not-configured')
  if (ok) { notice?.remove(); return }
  if (!notice) {
    notice = document.createElement('div')
    notice.className = 'cloud-not-configured cloud-not-configured-notice'
    notice.textContent = `${SERVICE_NAMES[service]}${t('publish.oauthKeyMissing', '-OAuth-nøkkel er ikke satt i denne byggingen.')}`
    card.prepend(notice)
  }
}

/**
 * Inject an inline "Avbryt" button next to the connect button so the user can
 * back out of a hung OAuth flow (browser closed, no callback fired).
 */
function ensureCancelButton(connectBtn: HTMLElement, service: CloudServiceId): HTMLElement {
  let cancel = connectBtn.parentElement?.querySelector<HTMLElement>(`[data-cloud-cancel="${service}"]`)
  if (cancel) return cancel
  cancel = document.createElement('button')
  cancel.dataset.cloudCancel = service
  cancel.className = 'btn'
  cancel.textContent = 'Avbryt'
  cancel.style.cssText = 'margin-left:6px;display:none'
  cancel.addEventListener('click', async () => {
    await window.api.cloudCancelConnect(service)
  })
  connectBtn.parentElement?.appendChild(cancel)
  return cancel
}

function renderQueue(q: CloudQueueStatus): void {
  let panel = document.getElementById('cloud-queue-panel')
  if (!panel) {
    panel = document.createElement('div')
    panel.id = 'cloud-queue-panel'
    panel.className = 'cloud-queue-panel'
    // Anchor lives inside Settings → Filer (sky-backup-kortet). Fallback til body.
    const cloudSection = document.querySelector('#cloud-queue-anchor') ?? document.body
    cloudSection.appendChild(panel)
  }

  if (q.entries.length === 0) {
    panel.innerHTML = `<div class="cloud-queue-empty">${t('publish.queueEmpty', 'Ingen ventende skyopplastinger.')}</div>`
    return
  }

  panel.innerHTML = `<h3 class="cloud-queue-title">${t('publish.queueTitle', 'Skyopplastinger i kø')}</h3>`
  const list = document.createElement('div')
  list.className = 'cloud-queue-list'

  for (const e of q.entries) {
    const row = document.createElement('div')
    row.className = 'cloud-queue-row'

    const statusBadge = document.createElement('span')
    statusBadge.className = `cloud-queue-badge cloud-queue-badge-${e.status}`
    statusBadge.textContent = labelForStatus(e.status)
    row.appendChild(statusBadge)

    const meta = document.createElement('div')
    meta.className = 'cloud-queue-meta'
    const line1 = document.createElement('div')
    line1.textContent = `${SERVICE_NAMES[e.service]} — ${e.filename}`
    line1.className = 'cloud-queue-line1'
    const line2 = document.createElement('div')
    line2.className = 'cloud-queue-line2'
    const nextStr = e.nextAttempt > Date.now()
      ? `${t('publish.queueNextAttempt', 'Neste forsøk')}: ${new Date(e.nextAttempt).toLocaleTimeString()}`
      : ''
    line2.textContent = [
      `${t('publish.queueAttempts', 'Forsøk')}: ${e.attempts}`,
      nextStr,
      e.lastError ? `${t('publish.queueError', 'Feil')}: ${e.lastError}` : '',
    ].filter(Boolean).join(' · ')
    meta.append(line1, line2)
    row.appendChild(meta)

    const retryBtn = document.createElement('button')
    retryBtn.textContent = t('publish.queueRetry', 'Prøv nå')
    retryBtn.className = 'btn-secondary btn-sm cloud-queue-retry'
    retryBtn.addEventListener('click', async () => {
      await window.api.cloudQueueRetry(e.id)
      refreshQueue()
    })
    row.appendChild(retryBtn)

    const removeBtn = document.createElement('button')
    removeBtn.textContent = t('publish.queueRemove', 'Fjern')
    removeBtn.className = 'btn-ghost btn-sm cloud-queue-remove'
    removeBtn.addEventListener('click', async () => {
      await window.api.cloudQueueRemove(e.id)
      refreshQueue()
    })
    row.appendChild(removeBtn)

    list.appendChild(row)
  }
  panel.appendChild(list)
}

function labelForStatus(s: CloudQueueStatus['entries'][number]['status']): string {
  switch (s) {
    case 'uploading':       return t('publish.queueStatusUploading', 'Laster opp')
    case 'failed':          return t('publish.queueStatusFailed',    'Mislyktes')
    case 'reauth-required': return t('publish.queueStatusReauth',    'Logg inn')
    default:                return t('publish.queueStatusPending',   'Venter')
  }
}

async function openFolderPicker(service: CloudServiceId): Promise<void> {
  const modal = document.getElementById('cloud-folder-modal')
  const list  = document.getElementById('cloud-folder-list')
  const title = document.getElementById('cloud-folder-modal-title')
  if (!modal || !list || !title) return

  title.textContent = `${t('publish.pickFolderTitle', 'Velg mappe')} — ${SERVICE_NAMES[service]}`
  list.innerHTML = `<div class="cloud-folder-loading">${t('publish.loading', 'Laster…')}</div>`
  modal.style.display = 'flex'

  try {
    const folders = await window.api.cloudListFolders(service)
    list.innerHTML = ''

    const rootItem = document.createElement('button')
    rootItem.className = 'cloud-folder-item'
    rootItem.textContent = '📁 Rotmappe'
    rootItem.onclick = async () => {
      await window.api.cloudSetFolder(service, '', 'Rotmappe', '')
      modal.style.display = 'none'
      refreshStatus()
    }
    list.appendChild(rootItem)

    for (const f of folders) {
      const item = document.createElement('button')
      item.className = 'cloud-folder-item'
      item.textContent = `📁 ${f.name}`
      item.onclick = async () => {
        await window.api.cloudSetFolder(service, f.id, f.name, f.path)
        modal.style.display = 'none'
        refreshStatus()
      }
      list.appendChild(item)
    }
  } catch (err) {
    list.innerHTML = `<div style="padding:16px;color:var(--red)">Feil: ${(err as Error).message}</div>`
  }
}

document.getElementById('cloud-folder-modal-close')?.addEventListener('click', () => {
  const modal = document.getElementById('cloud-folder-modal')
  if (modal) modal.style.display = 'none'
})

function saveServiceSettings(service: CloudServiceId, patch: Partial<CloudServiceSettings>): void {
  const key = service === 'google-drive' ? 'cloudGoogleDrive'
            : service === 'dropbox'       ? 'cloudDropbox'
            :                               'cloudOneDrive'
  const existing = settings[key] ?? { enabled: false, autoUpload: false }
  patchSettings({ [key]: { ...existing, ...patch } })
  window.api.saveSettings(settings).catch(console.error)
}

function showServiceError(service: CloudServiceId, message: string): void {
  const card = document.getElementById(`cloud-card-${service}`)
  if (!card) return
  let errEl = card.querySelector<HTMLElement>('.cloud-error')
  if (!errEl) {
    errEl = document.createElement('div')
    errEl.className = 'cloud-error'
    card.appendChild(errEl)
  }
  errEl.textContent = message
  errEl.style.display = ''
  setTimeout(() => { if (errEl) errEl.style.display = 'none' }, 5000)
}

function showUploadStatus(service: CloudServiceId, message: string, isError: boolean): void {
  const card = document.getElementById(`cloud-card-${service}`)
  const el   = card?.querySelector<HTMLElement>('.cloud-last-upload')
  if (el) {
    el.textContent = message
    el.style.color = isError ? 'var(--red)' : 'var(--green)'
    setTimeout(() => { el.style.color = '' }, 4000)
  }
}

export function applyPublishSettingsToUI(): void {
  refreshStatus()
  refreshQueue()
  applyStreamSettingsToUI()
  const thumbEls = panelElementsByPrefix('publish')
  if (thumbEls) void refreshThumbPanel(thumbEls, { kind: 'default' })
}

// ─── Live-stream destinations ───────────────────────────────────────────
//
// A draft list of destinations the user is editing. It mirrors
// settings.streamDestinations until saveStreamDestinations() persists it.
// Each entry tracks the optional user-entered stream key (`pendingKey`) so we
// can push it to the encrypted store on save without ever placing it in the
// settings JSON.

const STREAM_MAX_DESTINATIONS = 5

interface DraftDestination extends StreamDestinationStored {
  /** New key the user has typed in the input. Empty = no change. */
  pendingKey?: string
  /** Existing destination id, or '' for a newly-added row that isn't saved yet. */
  draftOnly?: boolean
}

let draftDestinations: DraftDestination[] = []
/** Ids removed by the user during this editing session — keys are deleted on save. */
const removedDestIds = new Set<string>()

function setupStreamDestinations(): void {
  applyStreamSettingsToUI()
  document.getElementById('btn-add-stream-destination')?.addEventListener('click', () => {
    if (draftDestinations.length >= STREAM_MAX_DESTINATIONS) return
    draftDestinations.push({
      id:      `dest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name:    '',
      rtmpUrl: '',
      enabled: true,
      hasKey:  false,
      draftOnly: true,
    })
    renderStreamDestinations()
    markPublishDirtyHint()
  })

  // Save is wired in files-page (saveFilesSettings) — we hook in via the
  // existing button click. We must also persist the destinations + push
  // keys to the encrypted store. files-page's saveFilesSettings runs
  // patchSettings without touching streamDestinations, so a second save here
  // is safe (both saves merge into the same Settings object via patchSettings).
  document.getElementById('btn-publish-save')?.addEventListener('click', () => {
    void saveStreamDestinations()
  })
  document.getElementById('btn-publish-cancel')?.addEventListener('click', () => {
    removedDestIds.clear()
    draftDestinations = cloneFromSettings()
    renderStreamDestinations()
  })
}

function applyStreamSettingsToUI(): void {
  draftDestinations = cloneFromSettings()
  removedDestIds.clear()
  renderStreamDestinations()
  // Quality + framerate radios
  const res = settings.streamResolution ?? '720p'
  const radio = document.querySelector<HTMLInputElement>(`input[name="stream-resolution"][value="${res}"]`)
  if (radio) radio.checked = true
  const fr = settings.streamFramerate ?? 30
  const sel = document.getElementById('stream-framerate') as HTMLSelectElement | null
  if (sel) sel.value = String(fr)
}

function cloneFromSettings(): DraftDestination[] {
  return (settings.streamDestinations ?? []).map(d => ({ ...d }))
}

function renderStreamDestinations(): void {
  const list = document.getElementById('stream-destinations-list')
  if (!list) return
  list.innerHTML = ''
  if (draftDestinations.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'stream-destinations-empty'
    empty.textContent = t('publish.streamNoneYet', 'Ingen destinasjoner enda.')
    list.appendChild(empty)
  }
  draftDestinations.forEach((d, idx) => {
    const row = document.createElement('div')
    row.className = 'stream-destination-row'
    row.dataset.idx = String(idx)
    const keyPlaceholder = d.hasKey
      ? t('publish.streamKeySaved', '•••••• Lagret')
      : t('publish.streamKeyPlaceholder', 'Lim inn stream-key her')
    row.innerHTML = `
      <div class="stream-destination-grid">
        <div>
          <label class="form-label" data-i18n="publish.streamName">NAVN</label>
          <input type="text" class="form-input" data-stream-field="name" value="${escHtml(d.name)}" placeholder="YouTube / Facebook / Kirkens server" />
        </div>
        <div>
          <label class="form-label" data-i18n="publish.streamRtmpUrl">RTMP-URL</label>
          <input type="text" class="form-input" data-stream-field="rtmpUrl" value="${escHtml(d.rtmpUrl)}" placeholder="rtmp://a.rtmp.youtube.com/live2" />
        </div>
        <div>
          <label class="form-label" data-i18n="publish.streamKey">STREAM-KEY</label>
          <input type="password" class="form-input" data-stream-field="streamKey" value="" placeholder="${escHtml(keyPlaceholder)}" />
        </div>
      </div>
      <div class="stream-destination-actions">
        <label class="toggle-row stream-destination-enabled">
          <span data-i18n="publish.enabled">Aktivert</span>
          <label class="toggle">
            <input type="checkbox" data-stream-field="enabled" ${d.enabled ? 'checked' : ''} />
            <span class="toggle-track"></span>
          </label>
        </label>
        <button class="btn-ghost btn-sm" type="button" data-stream-action="delete" aria-label="Slett">✕</button>
      </div>
    `

    row.querySelectorAll<HTMLInputElement>('input[data-stream-field]').forEach(inp => {
      inp.addEventListener('input', () => updateDraftFromRow(idx, row))
      inp.addEventListener('change', () => updateDraftFromRow(idx, row))
    })
    row.querySelector<HTMLElement>('[data-stream-action="delete"]')?.addEventListener('click', () => {
      const confirmMsg = t('publish.streamConfirmDelete', 'Slette denne destinasjonen?')
      if (!confirm(confirmMsg)) return
      const removed = draftDestinations[idx]
      if (removed && !removed.draftOnly) removedDestIds.add(removed.id)
      draftDestinations.splice(idx, 1)
      renderStreamDestinations()
      markPublishDirtyHint()
    })
    list.appendChild(row)
  })
}

function updateDraftFromRow(idx: number, row: HTMLElement): void {
  const d = draftDestinations[idx]
  if (!d) return
  const name    = (row.querySelector('input[data-stream-field="name"]')    as HTMLInputElement | null)?.value ?? ''
  const rtmpUrl = (row.querySelector('input[data-stream-field="rtmpUrl"]') as HTMLInputElement | null)?.value ?? ''
  const key     = (row.querySelector('input[data-stream-field="streamKey"]') as HTMLInputElement | null)?.value ?? ''
  const enabled = !!(row.querySelector('input[data-stream-field="enabled"]') as HTMLInputElement | null)?.checked
  d.name       = name
  d.rtmpUrl    = rtmpUrl
  d.enabled    = enabled
  d.pendingKey = key
}

/** Persist current draft to settings + encrypted key store. Called after the
 *  publish-tab's main save (which writes the other settings). */
async function saveStreamDestinations(): Promise<void> {
  // Validate: keep only rows that have a name + url. Skip silently otherwise
  // (the row stays in the DOM until the user explicitly removes it).
  const valid = draftDestinations.filter(d => d.name.trim() && d.rtmpUrl.trim())

  // Push keys before settings — that way `hasKey` reflects the saved state.
  for (const d of valid) {
    if (d.pendingKey && d.pendingKey.length > 0) {
      try {
        const r = await window.api.streamSetKey(d.id, d.pendingKey)
        if (r.ok) {
          d.hasKey = true
          d.pendingKey = ''
        } else if (r.error === 'safeStorage_unavailable') {
          // Refuse to silently lose the key — surface to user so they can
          // decide (use a different machine, or accept the risk on a personal box).
          alert(
            'Stream-key kunne ikke lagres sikkert på denne maskinen.\n\n' +
            'Mac Keychain / Windows Credential Manager er ikke tilgjengelig. ' +
            'Stream-keys lagres derfor IKKE for å unngå at de havner som ' +
            'klartekst på disk. Logg inn på en bruker med systemnøkkelring og prøv igjen.'
          )
        } else {
          console.error('[publish] streamSetKey failed', d.id, r.error)
        }
      } catch (err) {
        console.error('[publish] streamSetKey failed for', d.id, err)
      }
    }
  }
  // Delete keys for removed destinations
  for (const id of removedDestIds) {
    try { await window.api.streamDeleteKey(id) } catch (err) { console.error('[publish] streamDeleteKey failed', id, err) }
  }
  removedDestIds.clear()

  const resolution = (document.querySelector('input[name="stream-resolution"]:checked') as HTMLInputElement | null)?.value as ('480p' | '720p' | '1080p' | undefined)
  const framerate  = parseInt((document.getElementById('stream-framerate') as HTMLSelectElement | null)?.value ?? '30', 10) as 25 | 30

  const stored: StreamDestinationStored[] = valid.map(d => ({
    id: d.id, name: d.name, rtmpUrl: d.rtmpUrl, enabled: d.enabled, hasKey: d.hasKey,
  }))

  patchSettings({
    streamDestinations: stored,
    streamResolution:   resolution ?? settings.streamResolution ?? '720p',
    streamFramerate:    framerate,
  })
  try { await window.api.saveSettings(settings) } catch (err) { console.error('[publish] saveSettings failed', err) }

  // Refresh draft so future edits start from the saved state (hasKey may have
  // flipped, pendingKey is cleared).
  draftDestinations = cloneFromSettings()
  renderStreamDestinations()

  notifyLivePageDestinationsChanged()
}

function markPublishDirtyHint(): void {
  // Reuse the existing dirty-bar pattern by dispatching an input event on the
  // publish footer's parent. The page-footer .dirty class is toggled by
  // setupDirtyBar listeners on the page element.
  const page = document.getElementById('settings-publish')
  page?.dispatchEvent(new Event('input', { bubbles: true }))
}
