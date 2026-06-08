/**
 * "Sunday-suite" settings tab.
 *
 * Opt-in controls for the sister-app integrations. State is persisted through
 * the dedicated integrations IPC (window.api.get/setIntegrationSettings), not
 * the main settings save flow — so each toggle takes effect immediately and
 * the recording-core settings are never touched. When the master toggle is
 * off, sub-toggles are disabled and no integration code runs anywhere.
 */

const $ = (id: string) => document.getElementById(id)

export async function setupIntegrationsPage(): Promise<void> {
  const masterEl     = $('opt-integrations-enabled')  as HTMLInputElement | null
  const sundayEditEl   = $('opt-integrations-sundayedit') as HTMLInputElement | null
  const stageEl      = $('opt-integrations-stage')    as HTMLInputElement | null
  const songEl       = $('opt-integrations-song')     as HTMLInputElement | null
  const planEl       = $('opt-integrations-plan')     as HTMLInputElement | null
  if (!masterEl || !sundayEditEl || !stageEl || !songEl) return

  const cards = ['integrations-sundayedit-card', 'integrations-song-card', 'integrations-plan-card', 'integrations-stage-card', 'integrations-connection-card']

  const applyEnabledState = (): void => {
    const on = masterEl.checked
    ;[sundayEditEl, stageEl, songEl, planEl].filter(Boolean).forEach(el => { (el as HTMLInputElement).disabled = !on })
    cards.forEach(id => {
      const el = $(id)
      if (el) el.style.opacity = on ? '' : '0.5'
    })
    const keyRow = $('integrations-song-key-row')
    if (keyRow) keyRow.style.display = (on && songEl.checked) ? '' : 'none'
  }

  // Load current settings
  let current = { enabled: false, sundayedit: { enabled: false }, stage: { enabled: false }, song: { enabled: false }, connection: { churchId: '', songApiUrl: '' } }
  try {
    const s = await window.api.getIntegrationSettings()
    masterEl.checked   = !!s.enabled
    sundayEditEl.checked = !!s.sundayedit?.enabled
    stageEl.checked    = !!s.stage?.enabled
    songEl.checked     = !!s.song?.enabled
    if (planEl) planEl.checked = !!s.plan?.enabled
    current = s as typeof current

    // Connection fields
    const churchInput   = $('integration-church-id')    as HTMLInputElement | null
    const songUrlInput  = $('integration-song-api-url') as HTMLInputElement | null
    const planUrlInput  = $('integration-plan-api-url') as HTMLInputElement | null
    if (churchInput  && s.connection?.churchId)   churchInput.value   = s.connection.churchId
    if (songUrlInput && s.connection?.songApiUrl) songUrlInput.value  = s.connection.songApiUrl
    if (planUrlInput && s.connection?.planApiUrl) planUrlInput.value  = s.connection.planApiUrl

    // API key presence indicator
    const keyStatus = $('integration-song-apikey-status')
    if (keyStatus) {
      const hasKey = await window.api.songHasApiKey()
      keyStatus.textContent = hasKey ? '✓ API-nøkkel lagret (kryptert)' : ''
    }
  } catch {
    masterEl.checked = false
  }
  applyEnabledState()

  masterEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ enabled: masterEl.checked })
    applyEnabledState()
  })
  sundayEditEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ sundayedit: { enabled: sundayEditEl.checked } })
  })
  stageEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ stage: { enabled: stageEl.checked } })
  })
  planEl?.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ plan: { enabled: !!(planEl as HTMLInputElement).checked } })
  })
  songEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ song: { enabled: songEl.checked } })
    applyEnabledState()
  })

  // API-key save
  $('btn-song-apikey-save')?.addEventListener('click', async () => {
    const inp = $('integration-song-apikey') as HTMLInputElement | null
    const statusEl = $('integration-song-apikey-status')
    if (!inp) return
    await window.api.songSetApiKey(inp.value.trim())
    inp.value = ''
    if (statusEl) statusEl.textContent = '✓ API-nøkkel lagret (kryptert)'
  })

  // Connection save (church_id + Song API URL)
  $('btn-integrations-connection-save')?.addEventListener('click', async () => {
    const churchInput  = $('integration-church-id')    as HTMLInputElement | null
    const songUrlInput = $('integration-song-api-url') as HTMLInputElement | null
    const planUrlInput2 = $('integration-plan-api-url') as HTMLInputElement | null
    const patch = {
      connection: {
        ...(current.connection ?? {}),
        churchId:   churchInput?.value.trim()    || undefined,
        songApiUrl: songUrlInput?.value.trim()   || undefined,
        planApiUrl: planUrlInput2?.value.trim()  || undefined,
      },
    }
    await window.api.setIntegrationSettings(patch)
    const btn = $('btn-integrations-connection-save') as HTMLButtonElement | null
    if (btn) { btn.textContent = '✓ Lagret'; setTimeout(() => { btn.textContent = 'Lagre tilkobling' }, 1500) }
  })
}
