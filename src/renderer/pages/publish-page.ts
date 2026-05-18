import { settings, patchSettings } from '../state'
import { flashSaved } from '../helpers'
import type { CloudServiceId, CloudServiceSettings, CloudStatus } from '../../types'

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

export function setupPublishPage(): void {
  refreshStatus()

  document.getElementById('btn-cloud-refresh')?.addEventListener('click', refreshStatus)

  // Connect/disconnect buttons
  document.querySelectorAll<HTMLElement>('[data-cloud-connect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const service = btn.dataset.cloudConnect as CloudServiceId
      btn.textContent = 'Kobler til…'
      btn.setAttribute('disabled', '')
      const result = await window.api.cloudConnect(service)
      btn.removeAttribute('disabled')
      if (result.ok) {
        refreshStatus()
      } else {
        btn.textContent = 'Koble til'
        showServiceError(service, result.error ?? 'Ukjent feil')
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
    flashSaved(document.getElementById('btn-files-save'))
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
}

async function refreshStatus(): Promise<void> {
  const status = await window.api.cloudStatus() as ServiceStatus
  currentStatus = status
  renderAllCards(status)
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
  } else {
    connectedSection?.style.setProperty('display', 'none')
    disconnectedSection?.style.setProperty('display', '')
  }

  const settingsKey = service === 'google-drive' ? 'cloudGoogleDrive'
                    : service === 'dropbox'       ? 'cloudDropbox'
                    :                               'cloudOneDrive'
  const cfg = settings[settingsKey]
  if (autoChk)    autoChk.checked    = cfg?.autoUpload ?? false
  if (enabledChk) enabledChk.checked = cfg?.enabled    ?? false
}

async function openFolderPicker(service: CloudServiceId): Promise<void> {
  const modal = document.getElementById('cloud-folder-modal')
  const list  = document.getElementById('cloud-folder-list')
  const title = document.getElementById('cloud-folder-modal-title')
  if (!modal || !list || !title) return

  title.textContent = `Velg mappe — ${SERVICE_NAMES[service]}`
  list.innerHTML = '<div style="padding:16px;color:var(--text3)">Laster…</div>'
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
}
