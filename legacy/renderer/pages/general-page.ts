import { t, loadLocale, currentLang } from '../i18n'
import { settings, patchSettings } from '../state'
import { flashSaved, flashMsg, setVal, setupDirtyBar } from '../helpers'

let _markGeneralClean = () => {}
let _markVarslerClean = () => {}

function markAllClean(): void { _markGeneralClean(); _markVarslerClean() }

export function setupGeneralPage(): void {
  const gBar = setupDirtyBar('settings-general')
  const vBar = setupDirtyBar('settings-notifications')
  _markGeneralClean = gBar.clean
  _markVarslerClean = vBar.clean

  document.getElementById('btn-show-onboarding')?.addEventListener('click', () => window.showOnboarding())
  document.getElementById('opt-email-error')?.addEventListener('change', toggleEmailSection)

  document.getElementById('btn-clear-smtp-pass')?.addEventListener('click', async () => {
    await window.api.clearSmtpPassword()
    const passInput = document.getElementById('email-pass') as HTMLInputElement | null
    const clearBtn  = document.getElementById('btn-clear-smtp-pass') as HTMLElement | null
    if (passInput) { passInput.value = ''; passInput.placeholder = '' }
    if (clearBtn)  clearBtn.style.display = 'none'
  })

  // Gmail OAuth — alternative to SMTP. Click "Logg inn med Google" → opens
  // Google's consent screen in the system browser; once back, the row shows
  // "Sender via <email>" and the Avansert SMTP section becomes optional.
  document.getElementById('btn-email-gmail-connect')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-email-gmail-connect') as HTMLButtonElement | null
    if (!btn) return
    btn.disabled = true
    const oldText = btn.textContent
    btn.textContent = t('notify.emailGmailConnecting', 'Kobler til…')
    try {
      const r = await window.api.gmailConnect()
      if (!r.ok) {
        alert(t('notify.emailGmailFailed', 'Kunne ikke koble til Google: ') + (r.error ?? ''))
      }
    } catch (err) {
      alert(t('notify.emailGmailFailed', 'Kunne ikke koble til Google: ') + (err as Error).message)
    } finally {
      btn.disabled = false
      btn.textContent = oldText
      await refreshGmailStatus()
    }
  })

  document.getElementById('btn-email-gmail-disconnect')?.addEventListener('click', async () => {
    if (!confirm(t('notify.emailGmailConfirmDisconnect', 'Koble fra Google-kontoen? E-postvarsler vil falle tilbake til SMTP.'))) return
    await window.api.gmailDisconnect()
    await refreshGmailStatus()
  })

  // Note: btn-export / btn-import / btn-restore handlers were removed in v4.31
  // when the System tab was simplified. The corresponding IPC handlers
  // (export-profile / import-profile / reset-settings) remain available for
  // any future re-introduction or tests.

  document.getElementById('btn-test-email')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-email')
    if (btn) { (btn as HTMLButtonElement).disabled = true }
    const result = await window.api.testEmail()
    const msgKey = result.ok ? 'general.testEmailOk' : 'general.testEmailFail'
    const fallback = result.ok ? '✓ Testmelding sendt' : '✕ Sending feilet'
    flashMsg(btn, t(msgKey, fallback), result.ok)
    if (btn) { (btn as HTMLButtonElement).disabled = false }
  })

  document.getElementById('btn-test-webhook')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-webhook') as HTMLButtonElement | null
    if (!btn) return
    // Force-save the webhook URL first so the user doesn't have to click Save
    // before testing a freshly-pasted URL.
    const url = (document.getElementById('webhook-url') as HTMLInputElement | null)?.value.trim() ?? ''
    if (!url) { flashMsg(btn, '✕ ' + t('general.pasteUrlFirst', 'Lim inn URL først'), false); return }
    btn.disabled = true
    patchSettings({ webhookUrl: url })
    await window.api.saveSettings(settings)
    const result = await window.api.testWebhook() as { ok: boolean; error?: string }
    flashMsg(btn, result.ok ? '✓ Sendt — sjekk kanalen' : `✕ ${result.error ?? 'Feil'}`, result.ok)
    btn.disabled = false
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

  // "Rediger — standardklipp"-kortet er fjernet i v4.31 — intro/outro settes
  // i editor-fanen og lagres direkte til Settings.editorIntroPath/OutroPath
  // derfra. updateEditorClipUI()-kallet under er en no-op nå men beholdes
  // som safe-shim for tilfelle ekstern kode trigger applyGeneralSettingsToUI.

  document.getElementById('btn-varsler-save')?.addEventListener('click', saveGeneralSettings)
  document.getElementById('btn-varsler-cancel')?.addEventListener('click', () => applyGeneralSettingsToUI())

  // Update events from main
  // On macOS, autoDownload is disabled (unsigned app — in-place ZIP install loops).
  // update-available shows a download link; update-downloaded only fires on Windows.
  let _isMac = false
  window.api.getPlatform?.().then(p => { _isMac = p === 'darwin' }).catch(() => {})

  window.api.on('update-checking',          () => setUpdateStatus('pending', t('update.checking', 'Sjekker etter oppdateringer…')))
  window.api.on('update-not-available',     () => { setUpdateStatus('ok', t('update.upToDate', 'Du er oppdatert')); hideToast() })
  window.api.on('update-available',         (info: unknown) => {
    const v = (info as { version: string }).version
    if (_isMac) {
      setUpdateStatus('ready', t('update.availableMac', 'Versjon {v} tilgjengelig — last ned ny DMG').replace('{v}', v))
      const restartBtn = document.getElementById('btn-restart-install')
      if (restartBtn) {
        restartBtn.textContent = `↓ Last ned v${v}`
        restartBtn.style.display = 'inline-flex'
      }
      showUpdateToast(
        t('update.toastAvailableTitle', 'Oppdatering tilgjengelig'),
        t('update.toastAvailableMac', 'Versjon {v} — klikk for å laste ned').replace('{v}', v),
        true
      )
    } else {
      setUpdateStatus('pending', t('update.available', 'Ny versjon {v} er tilgjengelig — laster ned…').replace('{v}', v))
      showUpdateToast(
        t('update.toastAvailableTitle', 'Oppdatering tilgjengelig'),
        t('update.toastAvailableText', 'Versjon {v} lastes ned…').replace('{v}', v)
      )
    }
  })
  window.api.on('update-download-progress', (prog: unknown) => {
    if (_isMac) return
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
  markAllClean()
  setVal('language-select', settings.language ?? 'no')
  setVal('church-name',        settings.churchName        ?? '')
  setVal('responsible-person', settings.responsiblePerson ?? '')
  setCheckbox('opt-notify-start',  settings.notifyStart !== false)
  setCheckbox('opt-notify-stop',   settings.notifyStop  !== false)
  const reminderSel = document.getElementById('opt-reminder-minutes') as HTMLSelectElement | null
  if (reminderSel) reminderSel.value = String(settings.reminderMinutes ?? 0)
  setCheckbox('opt-email-error',   !!settings.emailOnError)
  setCheckbox('opt-autostart',        !!settings.launchAtLogin)
  setCheckbox('opt-show-on-startup',  !!settings.showOnStartup)
  setCheckbox('opt-auto-update',      settings.autoUpdate !== false)
  setCheckbox('opt-ask-open-editor',  settings.askOpenEditor !== false)
  setVal('email-address', settings.emailAddress   ?? '')
  setVal('email-smtp',    settings.emailSmtp      ?? '')
  setVal('email-port',    settings.emailSmtpPort  ?? 587)
  setVal('email-user',    settings.emailSmtpUser  ?? '')
  setVal('webhook-url',   settings.webhookUrl     ?? '')
  setCheckbox('opt-webhook-on-warn', !!settings.webhookOnWarn)
  const passInput = document.getElementById('email-pass') as HTMLInputElement | null
  const clearBtn  = document.getElementById('btn-clear-smtp-pass') as HTMLElement | null
  if (passInput) {
    passInput.value = ''
    passInput.placeholder = settings.emailSmtpPassSet ? '••••••••' : ''
  }
  if (clearBtn) clearBtn.style.display = settings.emailSmtpPassSet ? 'inline' : 'none'
  toggleEmailSection()
  // Best-effort — failures are non-fatal (the SMTP path still works).
  void refreshGmailStatus()

  // Version display — show full semver (vX.Y.Z) so brukere ser også patch-
  // releases (hotfixes). Tidligere truncated til major.minor noe som skjulte
  // hotfix-info som "v4.30.1 fixet OAuth-secrets-i-CI".
  const raw = (window as unknown as { appVersion?: string }).appVersion ?? ''
  const displayVersion = (() => {
    // 0.x.y → "Beta" prefix (legacy pre-release labeling)
    const beta = raw.match(/^0\.(\d+)\.(\d+)/)
    if (beta) {
      const major = parseInt(beta[1]), minor = parseInt(beta[2])
      return minor === 0 ? `Beta ${major}` : `Beta ${major}.${minor}`
    }
    // Modern releases: show full vMAJOR.MINOR.PATCH (full semver)
    const rel = raw.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (rel) return `v${rel[1]}.${rel[2]}.${rel[3]}`
    // Fallback: anything else with at least two parts
    const fallback = raw.match(/^(\d+)\.(\d+)/)
    if (fallback) return `v${fallback[1]}.${fallback[2]}`
    return raw || '—'
  })()
  ;['app-version', 'sidebar-version', 'hero-app-version'].forEach(id => {
    const el = document.getElementById(id)
    if (el) el.textContent = displayVersion
  })

  setUpdateStatus('', t('update.checkHint', 'Klikk «Se etter oppdateringer» for å sjekke'))
  updateEditorClipUI()
}

async function saveGeneralSettings(): Promise<void> {
  const newLang = (document.getElementById('language-select') as HTMLSelectElement | null)?.value ?? 'no'
  patchSettings({
    language:          newLang,
    churchName:        (document.getElementById('church-name')        as HTMLInputElement | null)?.value ?? '',
    responsiblePerson: (document.getElementById('responsible-person') as HTMLInputElement | null)?.value ?? '',
    notifyStart:       !!(document.getElementById('opt-notify-start') as HTMLInputElement | null)?.checked,
    notifyStop:        !!(document.getElementById('opt-notify-stop')  as HTMLInputElement | null)?.checked,
    reminderMinutes:   parseInt((document.getElementById('opt-reminder-minutes') as HTMLSelectElement | null)?.value ?? '0') || 0,
    emailOnError:      !!(document.getElementById('opt-email-error')  as HTMLInputElement | null)?.checked,
    emailAddress:      (document.getElementById('email-address')     as HTMLInputElement | null)?.value ?? '',
    emailSmtp:         (document.getElementById('email-smtp')        as HTMLInputElement | null)?.value ?? '',
    emailSmtpPort:     +((document.getElementById('email-port')      as HTMLInputElement | null)?.value ?? 587),
    emailSmtpUser:     (document.getElementById('email-user')        as HTMLInputElement | null)?.value ?? '',
    emailSmtpPass:     (document.getElementById('email-pass')        as HTMLInputElement | null)?.value ?? '',
    webhookUrl:        (document.getElementById('webhook-url')       as HTMLInputElement | null)?.value.trim() || undefined,
    webhookOnWarn:     !!(document.getElementById('opt-webhook-on-warn') as HTMLInputElement | null)?.checked,
    launchAtLogin:     !!(document.getElementById('opt-autostart')         as HTMLInputElement | null)?.checked,
    showOnStartup:     !!(document.getElementById('opt-show-on-startup')   as HTMLInputElement | null)?.checked,
    autoUpdate:        !!(document.getElementById('opt-auto-update')       as HTMLInputElement | null)?.checked,
    askOpenEditor:     !!(document.getElementById('opt-ask-open-editor')   as HTMLInputElement | null)?.checked
  })
  await window.api.saveSettings(settings)
  if (newLang !== currentLang) loadLocale(newLang)
  markAllClean()
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

/**
 * Read the current Gmail-OAuth status from main and update the
 * email-OAuth-card on screen accordingly. Two states:
 *   • Not connected → show "Logg inn med Google" button + default sub-text
 *   • Connected → show "Koble fra"-knapp + "Sender via <email>"-sub-text
 *
 * Also flips the Avansert SMTP <details> closed when Gmail is connected,
 * since the SMTP fields are no longer required.
 */
async function refreshGmailStatus(): Promise<void> {
  let status: { connected: boolean; email?: string; needsReauth?: boolean } = { connected: false }
  try { status = await window.api.gmailStatus() } catch { /* gmail not available — keep defaults */ }

  const connectBtn    = document.getElementById('btn-email-gmail-connect') as HTMLElement | null
  const disconnectBtn = document.getElementById('btn-email-gmail-disconnect') as HTMLElement | null
  const statusEl      = document.getElementById('email-gmail-status') as HTMLElement | null
  const smtpAdvanced  = document.getElementById('email-smtp-advanced') as HTMLDetailsElement | null

  if (status.connected) {
    if (connectBtn)    connectBtn.style.display = 'none'
    if (disconnectBtn) disconnectBtn.style.display = ''
    if (statusEl) {
      const reauth = status.needsReauth ? ' ' + t('notify.emailGmailReauth', '⚠ Krever ny pålogging') : ''
      statusEl.textContent = t('notify.emailGmailSendsAs', 'Sender via') + ' ' + (status.email ?? '—') + reauth
      statusEl.style.color = status.needsReauth ? 'var(--red)' : 'var(--green)'
    }
    // Auto-collapse the SMTP advanced section — Gmail handles the send now.
    if (smtpAdvanced) smtpAdvanced.open = false
  } else {
    if (connectBtn)    connectBtn.style.display = ''
    if (disconnectBtn) disconnectBtn.style.display = 'none'
    if (statusEl) {
      statusEl.textContent = t('notify.emailGmailDesc', 'Send via din Gmail-konto — ingen SMTP-konfig.')
      statusEl.style.color = ''
    }
  }
}

function setCheckbox(id: string, val: boolean): void {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (el) el.checked = val
}

export function updateEditorClipUI(): void {
  const introPath = settings.editorIntroPath ?? ''
  const outroPath = settings.editorOutroPath ?? ''

  const introDisplay = document.getElementById('general-editor-intro-display')
  const outrDisplay  = document.getElementById('general-editor-outro-display')
  const introClear   = document.getElementById('btn-clear-editor-intro')
  const outrClear    = document.getElementById('btn-clear-editor-outro')

  if (introDisplay) introDisplay.textContent = introPath
    ? introPath.split(/[\\/]/).pop() ?? introPath
    : t('general.noClipSelected', 'Ingen fil valgt')
  if (outrDisplay)  outrDisplay.textContent  = outroPath
    ? outroPath.split(/[\\/]/).pop() ?? outroPath
    : t('general.noClipSelected', 'Ingen fil valgt')

  if (introClear) (introClear as HTMLElement).style.display = introPath ? '' : 'none'
  if (outrClear)  (outrClear  as HTMLElement).style.display = outroPath ? '' : 'none'
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
