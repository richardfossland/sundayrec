/**
 * Overlay configuration UI on the Direktesending page.
 *
 * Each overlay is a row with: name, type, source-picker, position, scale,
 * opacity, chroma-key, enable-toggle, delete. Changes are debounced and
 * persisted via window.api.saveSettings(settings) — the same path the
 * Publisering tab uses for stream destinations.
 *
 * The UI is intentionally compact (single row per overlay, expand for
 * advanced controls) because most users will configure 1–2 overlays
 * (logo + one EasyWorship screen capture) and we want the live page to
 * stay scannable when the stream is running.
 */

import { settings, patchSettings } from '../state'
import { escHtml } from '../helpers'
import type { OverlayConfig, OverlayPosition, OverlaySourceType } from '../../types'

let listEl: HTMLElement | null = null
let emptyEl: HTMLElement | null = null

const POSITION_LABELS: Record<OverlayPosition, string> = {
  tl: '↖ Topp venstre',  tc: '↑ Topp midt',    tr: '↗ Topp høyre',
  cl: '← Senter venstre', c: '· Senter',        cr: '→ Senter høyre',
  bl: '↙ Bunn venstre',  bc: '↓ Bunn midt',    br: '↘ Bunn høyre',
  fullscreen: '◼ Fullskjerm',
  custom:     '⊕ Tilpasset',
}

const TYPE_LABELS: Record<OverlaySourceType, string> = {
  image:  'Bilde (PNG/JPG)',
  screen: 'Skjerm',
  window: 'Vindu / regionsutsnitt',
  ndi:    'NDI (kommer i v4.44)',
}

// ─── Setup ───────────────────────────────────────────────────────────────

export function setupLiveOverlays(): void {
  listEl  = document.getElementById('overlay-list')
  emptyEl = document.getElementById('overlay-empty')

  document.getElementById('btn-add-overlay')?.addEventListener('click', onAddClick)
  renderOverlayList()
}

/** Re-renders the overlay list. Called from live-page.reactivateLivePage()
 *  so user sees the freshest persisted state every time the tab is opened. */
export function reactivateLiveOverlays(): void {
  renderOverlayList()
}

// ─── Render ──────────────────────────────────────────────────────────────

function renderOverlayList(): void {
  if (!listEl || !emptyEl) return
  const overlays = settings.streamOverlays ?? []

  emptyEl.style.display = overlays.length === 0 ? '' : 'none'
  listEl.innerHTML = overlays.map(renderOverlayRow).join('')
  wireRowEvents()
}

function renderOverlayRow(ov: OverlayConfig): string {
  const ndiNotice = ov.type === 'ndi'
    ? `<div class="overlay-row-warn">⚠ NDI er under utvikling. Bruk skjerm-capture inntil videre.</div>`
    : ''

  const sourceLabel = ov.type === 'image'
    ? (ov.source ? ov.source.split('/').pop() : '<em>ingen valgt</em>')
    : ov.type === 'screen' || ov.type === 'window'
      ? (ov.source ? `Skjerm ${ov.source}` : '<em>ingen valgt</em>')
      : ov.type === 'ndi'
        ? (ov.source || '<em>ingen valgt</em>')
        : ''

  const chromaOn = !!ov.chromaKey
  const chromaColor = ov.chromaKey?.color ?? '#00FF00'
  const chromaSim   = ov.chromaKey?.similarity ?? 0.10
  const chromaBlend = ov.chromaKey?.blend ?? 0.10

  return `
  <div class="overlay-row" data-overlay-id="${escHtml(ov.id)}">
    <div class="overlay-row-header">
      <label class="overlay-toggle" title="Slå overlay av/på">
        <input type="checkbox" class="ov-enabled" ${ov.enabled ? 'checked' : ''} />
        <span class="overlay-toggle-knob"></span>
      </label>
      <input class="ov-name form-input form-input-sm" type="text" value="${escHtml(ov.name)}" placeholder="Navn" />
      <select class="ov-type form-input form-input-sm">
        ${(Object.keys(TYPE_LABELS) as OverlaySourceType[]).map(t =>
          `<option value="${t}" ${ov.type === t ? 'selected' : ''}>${escHtml(TYPE_LABELS[t])}</option>`,
        ).join('')}
      </select>
      <button class="btn-secondary btn-sm ov-pick-source" type="button">${escHtml(pickButtonLabel(ov.type))}</button>
      <button class="btn-secondary btn-sm ov-delete" type="button" title="Slett">✕</button>
    </div>
    <div class="overlay-row-source">
      <span class="muted">Kilde:</span> ${sourceLabel}
    </div>
    ${ndiNotice}
    <div class="overlay-row-controls">
      <label class="overlay-ctrl">
        Posisjon
        <select class="ov-position form-input form-input-sm">
          ${(Object.keys(POSITION_LABELS) as OverlayPosition[]).map(p =>
            `<option value="${p}" ${ov.position === p ? 'selected' : ''}>${escHtml(POSITION_LABELS[p])}</option>`,
          ).join('')}
        </select>
      </label>
      <label class="overlay-ctrl">
        Størrelse <span class="overlay-num" data-num="scale">${pct(ov.scale)}</span>
        <input class="ov-scale" type="range" min="0.05" max="1.0" step="0.05" value="${ov.scale}" />
      </label>
      <label class="overlay-ctrl">
        Gjennomsiktighet <span class="overlay-num" data-num="opacity">${pct(ov.opacity)}</span>
        <input class="ov-opacity" type="range" min="0" max="1" step="0.05" value="${ov.opacity}" />
      </label>
      <label class="overlay-ctrl overlay-ctrl-chroma">
        <input type="checkbox" class="ov-chroma-on" ${chromaOn ? 'checked' : ''} />
        Chroma key
        <input type="color" class="ov-chroma-color" value="${escHtml(chromaColor)}" ${chromaOn ? '' : 'disabled'} />
        <input class="ov-chroma-sim" type="range" min="0.01" max="0.5" step="0.01" value="${chromaSim}" ${chromaOn ? '' : 'disabled'} title="Likhet" />
      </label>
    </div>
  </div>`
}

function pickButtonLabel(t: OverlaySourceType): string {
  if (t === 'image')  return 'Velg bilde…'
  if (t === 'screen') return 'Velg skjerm…'
  if (t === 'window') return 'Velg vindu…'
  if (t === 'ndi')    return 'Velg NDI-kilde…'
  return 'Velg…'
}

function pct(n: number): string { return `${Math.round((n ?? 0) * 100)}%` }

// ─── Event wiring ────────────────────────────────────────────────────────

function wireRowEvents(): void {
  if (!listEl) return
  for (const row of Array.from(listEl.querySelectorAll<HTMLElement>('.overlay-row'))) {
    const id = row.dataset.overlayId
    if (!id) continue

    row.querySelector<HTMLInputElement>('.ov-enabled')?.addEventListener('change', e => {
      updateOverlay(id, { enabled: (e.target as HTMLInputElement).checked })
    })
    row.querySelector<HTMLInputElement>('.ov-name')?.addEventListener('change', e => {
      updateOverlay(id, { name: (e.target as HTMLInputElement).value.trim() || 'Overlay' })
    })
    row.querySelector<HTMLSelectElement>('.ov-type')?.addEventListener('change', e => {
      const newType = (e.target as HTMLSelectElement).value as OverlaySourceType
      // Changing type invalidates the source. Clear it so the user picks a new one.
      updateOverlay(id, { type: newType, source: '' })
      renderOverlayList()
    })
    row.querySelector<HTMLButtonElement>('.ov-pick-source')?.addEventListener('click', () => {
      void onPickSource(id)
    })
    row.querySelector<HTMLButtonElement>('.ov-delete')?.addEventListener('click', () => {
      if (!confirm('Slette dette overlayet?')) return
      deleteOverlay(id)
    })
    row.querySelector<HTMLSelectElement>('.ov-position')?.addEventListener('change', e => {
      updateOverlay(id, { position: (e.target as HTMLSelectElement).value as OverlayPosition })
    })
    row.querySelector<HTMLInputElement>('.ov-scale')?.addEventListener('input', e => {
      const v = parseFloat((e.target as HTMLInputElement).value)
      updateOverlay(id, { scale: v })
      updateNumLabel(row, 'scale', v)
    })
    row.querySelector<HTMLInputElement>('.ov-opacity')?.addEventListener('input', e => {
      const v = parseFloat((e.target as HTMLInputElement).value)
      updateOverlay(id, { opacity: v })
      updateNumLabel(row, 'opacity', v)
    })

    const chromaOn    = row.querySelector<HTMLInputElement>('.ov-chroma-on')
    const chromaColor = row.querySelector<HTMLInputElement>('.ov-chroma-color')
    const chromaSim   = row.querySelector<HTMLInputElement>('.ov-chroma-sim')

    chromaOn?.addEventListener('change', () => {
      if (chromaOn.checked) {
        updateOverlay(id, {
          chromaKey: {
            color:      chromaColor?.value ?? '#00FF00',
            similarity: parseFloat(chromaSim?.value ?? '0.1'),
            blend:      0.1,
          },
        })
      } else {
        updateOverlay(id, { chromaKey: null })
      }
      renderOverlayList()
    })
    chromaColor?.addEventListener('change', () => updateChroma(id, { color: chromaColor.value }))
    chromaSim?.addEventListener('input',    () => updateChroma(id, { similarity: parseFloat(chromaSim.value) }))
  }
}

function updateNumLabel(row: HTMLElement, key: string, value: number): void {
  const el = row.querySelector<HTMLElement>(`.overlay-num[data-num="${key}"]`)
  if (el) el.textContent = pct(value)
}

// ─── Pick source ─────────────────────────────────────────────────────────

async function onPickSource(id: string): Promise<void> {
  const ov = getOverlay(id)
  if (!ov) return

  if (ov.type === 'image') {
    const r = await window.api.overlayPickImage()
    if (!r) return
    updateOverlay(id, { source: r.path, name: ov.name === 'Overlay' ? r.name : ov.name })
    renderOverlayList()
    return
  }

  if (ov.type === 'screen' || ov.type === 'window') {
    const screens = await window.api.overlayListScreens() as Array<{ id: string; label: string }>
    if (!screens || screens.length === 0) {
      alert('Fant ingen skjermer. Sjekk at appen har skjerm-opptakstillatelse.')
      return
    }
    // Use a simple prompt-based picker for now — keeps the implementation
    // lean. A proper modal lands when we add per-window region selection
    // (planned for v4.45 alongside NDI).
    const choices = screens.map((s, i) => `${i + 1}. ${s.label}`).join('\n')
    const answer = prompt(`Velg skjerm:\n${choices}\n\nSkriv tallet:`, '1')
    const idx = parseInt(answer ?? '', 10) - 1
    if (Number.isNaN(idx) || idx < 0 || idx >= screens.length) return
    updateOverlay(id, { source: screens[idx].id })
    renderOverlayList()
    return
  }

  if (ov.type === 'ndi') {
    const r = await window.api.overlayListNdiSources() as { available: boolean; reason?: string }
    alert(r.reason ?? 'NDI er under utvikling.')
    return
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────

function onAddClick(): void {
  const overlays = [...(settings.streamOverlays ?? [])]
  const newOverlay: OverlayConfig = {
    id:       crypto.randomUUID(),
    name:     'Overlay',
    enabled:  true,
    type:     'image',
    source:   '',
    position: 'br',
    scale:    0.25,
    opacity:  1.0,
    chromaKey: null,
  }
  overlays.push(newOverlay)
  patchSettings({ streamOverlays: overlays })
  persistAndRerender()
}

function getOverlay(id: string): OverlayConfig | null {
  return (settings.streamOverlays ?? []).find(o => o.id === id) ?? null
}

function updateOverlay(id: string, patch: Partial<OverlayConfig>): void {
  const next = (settings.streamOverlays ?? []).map(o => (o.id === id ? { ...o, ...patch } : o))
  patchSettings({ streamOverlays: next })
  persistOnly()
}

function updateChroma(id: string, patch: Partial<NonNullable<OverlayConfig['chromaKey']>>): void {
  const ov = getOverlay(id)
  if (!ov) return
  const current = ov.chromaKey ?? { color: '#00FF00', similarity: 0.1, blend: 0.1 }
  updateOverlay(id, { chromaKey: { ...current, ...patch } })
}

function deleteOverlay(id: string): void {
  const next = (settings.streamOverlays ?? []).filter(o => o.id !== id)
  patchSettings({ streamOverlays: next })
  persistAndRerender()
}

// ─── Persistence ─────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null
function persistOnly(): void {
  // Debounce — sliders fire many input events per second.
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.api.saveSettings(settings).catch(err => console.error('[overlays] save failed', err))
  }, 250)
}

function persistAndRerender(): void {
  renderOverlayList()
  persistOnly()
}
