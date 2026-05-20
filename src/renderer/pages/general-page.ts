import { t, loadLocale, currentLang } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, flashMsg, setVal } from '../helpers'

export function setupGeneralPage(): void {
  document.getElementById('btn-show-onboarding')?.addEventListener('click', () => window.showOnboarding())
  document.getElementById('opt-email-error')?.addEventListener('change', toggleEmailSection)

  document.getElementById('btn-clear-smtp-pass')?.addEventListener('click', async () => {
    await window.api.clearSmtpPassword()
    const passInput = document.getElementById('email-pass') as HTMLInputElement | null
    const clearBtn  = document.getElementById('btn-clear-smtp-pass') as HTMLElement | null
    if (passInput) { passInput.value = ''; passInput.placeholder = '' }
    if (clearBtn)  clearBtn.style.display = 'none'
  })

  document.getElementById('btn-export')?.addEventListener('click', async () => {
    const data = await window.api.exportProfile()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `sundayrec-${settings.churchName || 'profil'}.json`
    })
    a.click()
  })

  document.getElementById('btn-import')?.addEventListener('click', () => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' })
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return
      const text = await file.text()
      const ok   = await window.api.importProfile(text)
      const btn  = document.getElementById('btn-import')
      if (ok) {
        await window.loadSettings()
        flashMsg(btn, '✓ ' + t('general.importOk', 'Profil importert!'), true)
      } else {
        flashMsg(btn, '✕ ' + t('general.importFail', 'Ugyldig profil-fil.'), false)
      }
    }
    input.click()
  })

  document.getElementById('btn-restore')?.addEventListener('click', async () => {
    if (!confirm(t('general.confirmReset'))) return
    await window.api.resetSettings()
    await window.loadSettings()
  })

  document.getElementById('btn-test-email')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-email')
    if (btn) { (btn as HTMLButtonElement).disabled = true }
    const result = await window.api.testEmail()
    const msgKey = result.ok ? 'general.testEmailOk' : 'general.testEmailFail'
    const fallback = result.ok ? '✓ Testmelding sendt' : '✕ Sending feilet'
    flashMsg(btn, t(msgKey, fallback), result.ok)
    if (btn) { (btn as HTMLButtonElement).disabled = false }
  })

  document.getElementById('btn-check-updates')?.addEventListener('click', async () => {
    setUpdateStatus('pending', t('update.checking', 'Sjekker etter oppdateringer…'))
    await window.api.checkForUpdates()
  })

  document.getElementById('btn-toast-install')?.addEventListener('click', () => window.api.installUpdate())
  document.getElementById('btn-restart-install')?.addEventListener('click', () => window.api.installUpdate())
  document.getElementById('btn-toast-close')?.addEventListener('click', () => {
    const toast = document.getElementById('update-toast')
    if (toast) toast.style.display = 'none'
  })

  document.getElementById('btn-general-save')?.addEventListener('click', saveGeneralSettings)
  document.getElementById('btn-general-cancel')?.addEventListener('click', () => applyGeneralSettingsToUI())
  document.getElementById('btn-varsler-save')?.addEventListener('click', saveGeneralSettings)
  document.getElementById('btn-varsler-cancel')?.addEventListener('click', () => applyGeneralSettingsToUI())

  // Update events from main
  window.api.on('update-checking',          () => setUpdateStatus('pending', t('update.checking', 'Sjekker etter oppdateringer…')))
  window.api.on('update-not-available',     () => { setUpdateStatus('ok', t('update.upToDate', 'Du er oppdatert')); hideToast() })
  window.api.on('update-available',         (info: unknown) => {
    const v = (info as { version: string }).version
    setUpdateStatus('pending', t('update.available', 'Ny versjon {v} er tilgjengelig — laster ned…').replace('{v}', v))
    showUpdateToast(
      t('update.toastAvailableTitle', 'Oppdatering tilgjengelig'),
      t('update.toastAvailableText', 'Versjon {v} lastes ned…').replace('{v}', v)
    )
  })
  window.api.on('update-download-progress', (prog: unknown) => {
    const pct  = Math.round((prog as { percent?: number }).percent ?? 0)
    const wrap = document.getElementById('update-progress-wrap')
    const bar  = document.getElementById('update-progress-bar') as HTMLElement | null
    if (wrap) wrap.style.display = 'block'
    if (bar)  bar.style.width   = pct + '%'
    setUpdateStatus('pending', t('update.downloading', 'Laster ned… {pct}%').replace('{pct}', String(pct)))
    setToastProgress(pct)
  })
  window.api.on('update-downloaded', (info: unknown) => {
    const v = (info as { version: string }).version
    const wrap = document.getElementById('update-progress-wrap')
    if (wrap) wrap.style.display = 'none'
    const restartBtn = document.getElementById('btn-restart-install')
    if (restartBtn) restartBtn.style.display = 'inline-flex'
    setUpdateStatus('ready', t('update.readyInstall', 'Versjon {v} er klar — start på nytt for å installere').replace('{v}', v))
    showUpdateToast(
      t('update.toastReadyTitle', 'Klar for installasjon'),
      t('update.toastReadyText', 'Versjon {v} er lastet ned').replace('{v}', v),
      true
    )
  })
  window.api.on('update-error', (msg: unknown) => {
    setUpdateStatus('error', t('update.error', 'Kunne ikke sjekke for oppdateringer'))
    console.warn('Update error:', msg)
  })
}

export function applyGeneralSettingsToUI(): void {
  setVal('language-select', settings.language ?? 'no')
  setVal('church-name',        settings.churchName        ?? '')
  setVal('responsible-person', settings.responsiblePerson ?? '')
  setCheckbox('opt-notify-start',  settings.notifyStart !== false)
  setCheckbox('opt-notify-stop',   settings.notifyStop  !== false)
  setCheckbox('opt-email-error',   !!settings.emailOnError)
  setCheckbox('opt-autostart',        !!settings.launchAtLogin)
  setCheckbox('opt-show-on-startup',  !!settings.showOnStartup)
  setCheckbox('opt-auto-update',      settings.autoUpdate !== false)
  setCheckbox('opt-ask-open-editor',  settings.askOpenEditor !== false)
  setVal('email-address', settings.emailAddress   ?? '')
  setVal('email-smtp',    settings.emailSmtp      ?? '')
  setVal('email-port',    settings.emailSmtpPort  ?? 587)
  setVal('email-user',    settings.emailSmtpUser  ?? '')
  const passInput = document.getElementById('email-pass') as HTMLInputElement | null
  const clearBtn  = document.getElementById('btn-clear-smtp-pass') as HTMLElement | null
  if (passInput) {
    passInput.value = ''
    passInput.placeholder = settings.emailSmtpPassSet ? '••••••••' : ''
  }
  if (clearBtn) clearBtn.style.display = settings.emailSmtpPassSet ? 'inline' : 'none'
  toggleEmailSection()

  // Version display
  const raw = (window as unknown as { appVersion?: string }).appVersion ?? ''
  const displayVersion = (() => {
    const m = raw.match(/^0\.(\d+)\.(\d+)/)
    if (m) {
      const major = parseInt(m[1]), minor = parseInt(m[2])
      return minor === 0 ? `Beta ${major}` : `Beta ${major}.${minor}`
    }
    const rel = raw.match(/^(\d+)\.(\d+)/)
    if (rel) return `v${rel[1]}.${rel[2]}`
    return raw || '—'
  })()
  ;['app-version', 'sidebar-version', 'hero-app-version'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.textContent = displayVersion
  })

  setUpdateStatus('', t('update.checkHint', 'Klikk «Se etter oppdateringer» for å sjekke'))
}

async function saveGeneralSettings(): Promise<void> {
  const newLang = (document.getElementById('language-select') as HTMLSelectElement | null)?.value ?? 'no'
  patchSettings({
    language:          newLang,
    churchName:        (document.getElementById('church-name')        as HTMLInputElement | null)?.value ?? '',
    responsiblePerson: (document.getElementById('responsible-person') as HTMLInputElement | null)?.value ?? '',
    notifyStart:       !!(document.getElementById('opt-notify-start') as HTMLInputElement | null)?.checked,
    notifyStop:        !!(document.getElementById('opt-notify-stop')  as HTMLInputElement | null)?.checked,
    emailOnError:      !!(document.getElementById('opt-email-error')  as HTMLInputElement | null)?.checked,
    emailAddress:      (document.getElementById('email-address')     as HTMLInputElement | null)?.value ?? '',
    emailSmtp:         (document.getElementById('email-smtp')        as HTMLInputElement | null)?.value ?? '',
    emailSmtpPort:     +((document.getElementById('email-port')      as HTMLInputElement | null)?.value ?? 587),
    emailSmtpUser:     (document.getElementById('email-user')        as HTMLInputElement | null)?.value ?? '',
    emailSmtpPass:     (document.getElementById('email-pass')        as HTMLInputElement | null)?.value ?? '',
    launchAtLogin:     !!(document.getElementById('opt-autostart')         as HTMLInputElement | null)?.checked,
    showOnStartup:     !!(document.getElementById('opt-show-on-startup')   as HTMLInputElement | null)?.checked,
    autoUpdate:        !!(document.getElementById('opt-auto-update')       as HTMLInputElement | null)?.checked,
    askOpenEditor:     !!(document.getElementById('opt-ask-open-editor')   as HTMLInputElement | null)?.checked
  })
  await window.api.saveSettings(settings)
  if (newLang !== currentLang) loadLocale(newLang)
  const activeTab = document.querySelector<HTMLElement>('#settings-tabs .inner-tab.active')?.dataset.tab
  const flashBtn = activeTab === 'settings-notifications'
    ? document.getElementById('btn-varsler-save')
    : document.getElementById('btn-general-save')
  flashSaved(flashBtn)
}

function toggleEmailSection(): void {
  const emailSect = document.getElementById('email-section')
  const emailErr  = document.getElementById('opt-email-error') as HTMLInputElement | null
  if (emailSect && emailErr) emailSect.style.display = emailErr.checked ? 'block' : 'none'
}

function setCheckbox(id: string, val: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (el) el.checked = val
}

export function setUpdateStatus(dotCls: string, text: string): void {
  const dot = document.getElementById('update-status-dot')
  const txt = document.getElementById('update-status-text')
  if (dot) dot.className  = 'update-status-dot' + (dotCls ? ' ' + dotCls : '')
  if (txt) txt.textContent = text
}

function showUpdateToast(title: string, text: string, showInstall = false): void {
  const toast   = document.getElementById('update-toast')
  const titleEl = document.getElementById('update-toast-title')
  const textEl  = document.getElementById('update-toast-text')
  const actions = document.getElementById('update-toast-actions')
  const progEl  = document.getElementById('update-toast-progress')
  if (!toast) return
  if (titleEl) titleEl.textContent = title
  if (textEl)  textEl.textContent  = text
  if (actions) actions.style.display = showInstall ? 'block' : 'none'
  if (progEl)  progEl.style.display  = showInstall ? 'none'  : 'block'
  // Re-trigger animation
  toast.style.display = 'none'
  requestAnimationFrame(() => { toast.style.display = 'flex' })
}

function setToastProgress(pct: number): void {
  const bar = document.getElementById('update-toast-bar') as HTMLElement | null
  if (bar) bar.style.width = pct + '%'
}

function hideToast(): void {
  const toast = document.getElementById('update-toast')
  if (toast) toast.style.display = 'none'
}
