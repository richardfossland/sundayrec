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
  const masterEl    = $('opt-integrations-enabled')  as HTMLInputElement | null
  const verbatimEl  = $('opt-integrations-verbatim') as HTMLInputElement | null
  const stageEl     = $('opt-integrations-stage')    as HTMLInputElement | null
  const verbatimCard = $('integrations-verbatim-card')
  const stageCard    = $('integrations-stage-card')
  if (!masterEl || !verbatimEl || !stageEl) return

  const applyEnabledState = (): void => {
    const on = masterEl.checked
    verbatimEl.disabled = !on
    stageEl.disabled    = !on
    if (verbatimCard) verbatimCard.style.opacity = on ? '' : '0.5'
    if (stageCard)   stageCard.style.opacity    = on ? '' : '0.5'
  }

  try {
    const s = await window.api.getIntegrationSettings()
    masterEl.checked   = !!s.enabled
    verbatimEl.checked = !!s.verbatim?.enabled
    stageEl.checked    = !!s.stage?.enabled
  } catch {
    masterEl.checked = false
    verbatimEl.checked = false
    stageEl.checked = false
  }
  applyEnabledState()

  masterEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ enabled: masterEl.checked })
    applyEnabledState()
  })
  verbatimEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ verbatim: { enabled: verbatimEl.checked } })
  })
  stageEl.addEventListener('change', () => {
    void window.api.setIntegrationSettings({ stage: { enabled: stageEl.checked } })
  })
}
