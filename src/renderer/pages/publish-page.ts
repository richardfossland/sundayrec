import { settings, patchSettings } from '../state'
import { flashSaved } from '../helpers'
import { t } from '../i18n'
import type { CloudServiceId, CloudServiceSettings, CloudStatus, CloudQueueStatus } from '../../types'

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

  // Connect/disconnect buttons
  document.querySelectorAll<HTMLElement>('[data-cloud-connect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.cloudConnect as CloudServiceId
      if (!configured[service]) {
        showServiceError(service, `${SERVICE_NAMES[service]} er ikke konfigurert i denne byggingen. Be utvikleren om en build med OAuth-nøkkel.`)
        return
      }
      btn.textContent = 'Kobler til…'
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
    banner.style.cssText = 'background:#5b1f1f;color:#ffd0d0;padding:10px 12px;border-radius:8px;margin:8px 0;display:flex;gap:8px;align-items:center;justify-content:space-between'
    const text = document.createElement('div')
    text.textContent = `${SERVICE_NAMES[service]} trenger pålogging på nytt. Klikk for å koble til.`
    const btn = document.createElement('button')
    btn.textContent = 'Koble til på nytt'
    btn.className = 'btn'
    btn.style.cssText = 'background:#fff;color:#1a1a1a;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600'
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = 'Kobler til…'
      try {
        const result = await window.api.cloudConnect(service)
        if (result.ok) refreshStatus()
        else { btn.disabled = false; btn.textContent = 'Koble til på nytt'; showServiceError(service, result.error ?? 'Ukjent feil') }
      } catch {
        btn.disabled = false; btn.textContent = 'Koble til på nytt'
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
    notice.className = 'cloud-not-configured'
    notice.style.cssText = 'background:#4a3a1f;color:#ffe6a8;padding:8px 12px;border-radius:8px;margin:8px 0;font-size:12px'
    notice.textContent = `${SERVICE_NAMES[service]}-OAuth-nøkkel er ikke satt i denne byggingen.`
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
}
