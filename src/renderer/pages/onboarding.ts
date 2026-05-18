import { settings, patchSettings } from '../state'
import { getAudioDevices } from '../audio/capture'
import { makeVuState, tickVU, stopVuState } from '../audio/vu'

// ── VU state for the audio test step ────────────────────────────
let obVu     = makeVuState()
let obStream: MediaStream   | null = null
let obCtx:   AudioContext   | null = null

function stopObVU(): void {
  stopVuState(obVu); obVu = makeVuState()
  obStream?.getTracks().forEach(t => t.stop()); obStream = null
  obCtx?.close(); obCtx = null
}

// ── Device picked in step 2 ──────────────────────────────────────
let pickedDeviceId:   string | null = null
let pickedDeviceName: string | null = null

// ── Public entry point ───────────────────────────────────────────
export function checkAndShowOnboarding(): void {
  if (settings.onboardingDone) return
  const el = document.getElementById('onboarding-overlay')
  if (!el) return
  el.style.display = 'flex'
  document.getElementById('ob-btn-skip-all')?.addEventListener('click', finish)
  goTo(1)
}

// ── Finish / save flag ───────────────────────────────────────────
function finish(): void {
  stopObVU()
  patchSettings({ onboardingDone: true })
  void window.api.saveSettings(settings)
  const el = document.getElementById('onboarding-overlay')
  if (!el) return
  el.style.transition = 'opacity .35s'
  el.style.opacity = '0'
  setTimeout(() => { el.style.display = 'none'; el.style.opacity = '' }, 380)
}

// ── Step router ──────────────────────────────────────────────────
function goTo(step: number): void {
  stopObVU()
  const prog = document.getElementById('ob-progress')
  const body = document.getElementById('ob-body')
  if (!prog || !body) return

  prog.innerHTML = [1, 2, 3, 4].map(i =>
    `<div class="ob-dot${i === step ? ' active' : i < step ? ' done' : ''}"></div>`
  ).join('')

  body.style.opacity = '0'
  body.style.transform = 'translateY(8px)'

  setTimeout(() => {
    if      (step === 1) s1(body)
    else if (step === 2) void s2(body)
    else if (step === 3) void s3(body)
    else if (step === 4) s4(body)
    else                 sDone(body)
    body.style.transition = 'opacity .22s, transform .22s'
    body.style.opacity    = '1'
    body.style.transform  = 'translateY(0)'
  }, 80)
}

function allDots(): void {
  const prog = document.getElementById('ob-progress')
  if (prog) prog.innerHTML = [1,2,3,4].map(() => `<div class="ob-dot done"></div>`).join('')
}

// ── Step 1: Welcome ──────────────────────────────────────────────
function s1(body: HTMLElement): void {
  body.innerHTML = `
    <div class="ob-icon">
      <svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zM7 11a5 5 0 0010 0h2a7 7 0 01-14 0zm5 8h4v2h-4z"/></svg>
    </div>
    <h2 class="ob-title">Velkommen til SundayRec</h2>
    <p class="ob-desc">La oss sette opp programmet på noen minutter, slik at alt er klart til søndagen.</p>
    <div class="ob-features">
      <div class="ob-feature"><span>🎛️</span><span>Velg mikser eller lydkort</span></div>
      <div class="ob-feature"><span>✅</span><span>Test at lyden fungerer</span></div>
      <div class="ob-feature"><span>📅</span><span>Sett opp automatisk søndagsopptak</span></div>
    </div>
    <div class="ob-actions">
      <button class="btn-primary" id="ob-n1" style="justify-content:center">Kom i gang →</button>
      <button class="ob-text-btn" id="ob-s1">Hopp over — sett opp manuelt</button>
    </div>`
  document.getElementById('ob-n1')?.addEventListener('click', () => goTo(2))
  document.getElementById('ob-s1')?.addEventListener('click', finish)
}

// ── Step 2: Pick device ───────────────────────────────────────────
async function s2(body: HTMLElement): Promise<void> {
  pickedDeviceId   = settings.deviceId   ?? null
  pickedDeviceName = settings.deviceName ?? null

  body.innerHTML = `
    <h2 class="ob-title">Hvilken lydenhet bruker dere?</h2>
    <p class="ob-desc">Velg mikseren eller lydkortet som er koblet til datamaskinen.</p>
    <div id="ob-dev-list" class="ob-dev-list"><div class="ob-loading">Leter etter lydenheter…</div></div>
    <div class="ob-actions">
      <button class="btn-primary" id="ob-n2" style="justify-content:center">Bruk valgt enhet →</button>
      <button class="ob-text-btn" id="ob-s2">Hopp over dette steget</button>
    </div>`

  const list = document.getElementById('ob-dev-list')!
  const devices = await getAudioDevices()

  if (!devices.length) {
    list.innerHTML = `<p class="ob-empty">Ingen lydenheter funnet. Kontroller at mikseren er koblet til via USB.</p>`
  } else {
    const preferred = devices.find(d => !/built-in|innebygd|default/i.test(d.label)) ?? devices[0]
    if (!pickedDeviceId) { pickedDeviceId = preferred?.deviceId ?? null; pickedDeviceName = preferred?.label ?? null }

    list.innerHTML = devices.map(d => {
      const builtIn  = /built-in|innebygd|default/i.test(d.label)
      const selected = d.deviceId === pickedDeviceId
      return `<div class="ob-dev-card${selected ? ' sel' : ''}" data-id="${esc(d.deviceId)}" data-name="${esc(d.label)}">
        <span class="ob-dev-emoji">${builtIn ? '💻' : '🎛️'}</span>
        <div class="ob-dev-info">
          <div class="ob-dev-name">${esc(d.label || 'Ukjent enhet')}</div>
          <div class="ob-dev-hint">${builtIn ? 'Innebygd mikrofon — passer til testing' : 'Mikser / lydkort — anbefalt for gudstjeneste'}</div>
        </div>
        <span class="ob-badge${builtIn ? ' warn' : ' ok'}">${builtIn ? 'Ikke anbefalt' : 'Anbefalt ✓'}</span>
      </div>`
    }).join('')

    list.querySelectorAll<HTMLElement>('.ob-dev-card').forEach(card => {
      card.addEventListener('click', () => {
        list.querySelectorAll('.ob-dev-card').forEach(c => c.classList.remove('sel'))
        card.classList.add('sel')
        pickedDeviceId   = card.dataset.id   ?? null
        pickedDeviceName = card.dataset.name ?? null
      })
    })
  }

  document.getElementById('ob-n2')?.addEventListener('click', () => {
    if (pickedDeviceId) {
      patchSettings({ deviceId: pickedDeviceId, deviceName: pickedDeviceName })
      void window.api.saveSettings(settings)
    }
    goTo(3)
  })
  document.getElementById('ob-s2')?.addEventListener('click', () => goTo(3))
}

// ── Step 3: Audio test ────────────────────────────────────────────
async function s3(body: HTMLElement): Promise<void> {
  body.innerHTML = `
    <h2 class="ob-title">Test at lyden fungerer</h2>
    <p class="ob-desc">Si noe i mikrofonen, eller spill lyd gjennom mikseren. Sjekk at indikatoren beveger seg.</p>
    <div class="ob-vu-wrap">
      <div class="ob-vu-track"><div class="ob-vu-fill" id="ob-vu-fill"></div></div>
      <div class="ob-vu-lbl" id="ob-vu-lbl">Venter på lyd…</div>
    </div>
    <div class="ob-actions">
      <button class="btn-primary" id="ob-n3" style="justify-content:center">Lyden fungerer →</button>
      <button class="ob-text-btn" id="ob-s3">Hopp over dette steget</button>
    </div>`

  const devId = pickedDeviceId ?? (settings.deviceId ?? null)
  try {
    obStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(devId && devId !== 'default' ? { deviceId: { ideal: devId } } : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      },
      video: false
    })
    obCtx = new AudioContext()
    const src   = obCtx.createMediaStreamSource(obStream)
    const split = obCtx.createChannelSplitter(2)
    obVu = makeVuState()
    obVu.analyserL = obCtx.createAnalyser(); obVu.analyserL.fftSize = 1024
    obVu.analyserR = obCtx.createAnalyser(); obVu.analyserR.fftSize = 1024
    src.connect(split)
    split.connect(obVu.analyserL, 0)
    split.connect(obVu.analyserR, 1)

    tickVU(obVu, null, null, null, null, null, null, (dbL, dbR) => {
      const db   = Math.max(dbL, dbR)
      const fill = document.getElementById('ob-vu-fill')
      const lbl  = document.getElementById('ob-vu-lbl')
      if (!fill || !lbl) return
      fill.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)) + '%'
      if      (db >= -3)  { fill.style.background = 'var(--red)';    lbl.textContent = 'For høyt — skru ned volumet på mikseren'; lbl.style.color = 'var(--red)' }
      else if (db >= -12) { fill.style.background = 'var(--orange)'; lbl.textContent = 'Høyt, men OK';                           lbl.style.color = 'var(--orange)' }
      else if (db >= -40) { fill.style.background = 'var(--green)';  lbl.textContent = '✓ Bra signal — lyden fungerer';          lbl.style.color = 'var(--green)' }
      else if (db > -55)  { fill.style.background = 'var(--text3)';  lbl.textContent = 'Svakt signal — sjekk kabelen';          lbl.style.color = 'var(--text3)' }
      else                { fill.style.background = 'var(--text4)';  lbl.textContent = 'Venter på lyd…';                         lbl.style.color = 'var(--text3)' }
    })
  } catch {
    const lbl = document.getElementById('ob-vu-lbl')
    if (lbl) { lbl.textContent = 'Kunne ikke starte lydtest. Sjekk at tillatelse er gitt i systeminnstillingene.'; lbl.style.color = 'var(--orange)' }
  }

  document.getElementById('ob-n3')?.addEventListener('click', () => goTo(4))
  document.getElementById('ob-s3')?.addEventListener('click', () => goTo(4))
}

// ── Step 4: Schedule ─────────────────────────────────────────────
function s4(body: HTMLElement): void {
  const existingSun = settings.slots?.find(s => s.days.includes(6))
  const defStart    = existingSun?.start ?? '10:00'
  const defDur      = existingSun
    ? (() => {
        const [sh, sm] = (existingSun.start).split(':').map(Number)
        const [eh, em] = (existingSun.stop).split(':').map(Number)
        return (eh * 60 + em) - (sh * 60 + sm)
      })()
    : 90

  body.innerHTML = `
    <h2 class="ob-title">Automatisk søndagsopptak</h2>
    <p class="ob-desc">SundayRec kan starte og stoppe opptaket automatisk — uten at noen trenger å huske det.</p>
    <div class="ob-sched-card">
      <label class="ob-toggle-row">
        <span>Aktiver automatisk søndagsopptak</span>
        <input type="checkbox" id="ob-on" ${existingSun || true ? 'checked' : ''} style="width:auto;cursor:pointer">
      </label>
      <div id="ob-sched-fields">
        <div class="ob-field-row">
          <span class="ob-field-lbl">Gudstjenesten starter kl.</span>
          <input type="time" class="form-input" id="ob-start" value="${defStart}" style="max-width:110px">
        </div>
        <div class="ob-field-row">
          <span class="ob-field-lbl">Varer ca.</span>
          <div style="display:flex;align-items:center;gap:6px">
            <input type="number" class="form-input" id="ob-dur" min="15" max="360" value="${defDur}" style="max-width:80px;text-align:right">
            <span style="color:var(--text3);font-size:13px">minutter</span>
          </div>
        </div>
      </div>
    </div>
    <div class="ob-actions">
      <button class="btn-primary" id="ob-n4" style="justify-content:center">Fullfør oppsett →</button>
      <button class="ob-text-btn" id="ob-s4">Hopp over — legg til manuelt under Planlegging</button>
    </div>`

  const chk    = document.getElementById('ob-on') as HTMLInputElement
  const fields = document.getElementById('ob-sched-fields')!
  const setFieldsOpacity = () => { fields.style.opacity = chk.checked ? '1' : '.4'; fields.style.pointerEvents = chk.checked ? '' : 'none' }
  setFieldsOpacity()
  chk.addEventListener('change', setFieldsOpacity)

  const save = () => {
    if (chk.checked) {
      const startVal = (document.getElementById('ob-start') as HTMLInputElement)?.value ?? '10:00'
      const durMin   = Math.max(15, parseInt((document.getElementById('ob-dur') as HTMLInputElement)?.value ?? '90') || 90)
      const [sh, sm] = startVal.split(':').map(Number)
      const endMin   = sh * 60 + sm + durMin
      const stopVal  = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`
      const slots    = (settings.slots ?? []).filter(s => !s.days.includes(6))
      slots.push({ days: [6], start: startVal, stop: stopVal })
      patchSettings({ slots })
      void window.api.saveSettings(settings)
    }
    allDots()
    sDone(document.getElementById('ob-body')!)
  }

  document.getElementById('ob-n4')?.addEventListener('click', save)
  document.getElementById('ob-s4')?.addEventListener('click', () => { allDots(); sDone(document.getElementById('ob-body')!) })
}

// ── Done ──────────────────────────────────────────────────────────
function sDone(body: HTMLElement): void {
  stopObVU()
  body.innerHTML = `
    <div class="ob-done-ring">
      <svg viewBox="0 0 24 24"><path fill-rule="evenodd" d="M16.707 8.293a1 1 0 010 1.414l-6 6a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414L10 13.586l5.293-5.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
    </div>
    <h2 class="ob-title">Alt er klart!</h2>
    <p class="ob-desc">SundayRec er klar til å ta opp gudstjenester. Du kan endre alle innstillinger i menyen når som helst.</p>
    <div class="ob-tips">
      <div class="ob-tip"><strong>Hjem</strong> — Se status på mikrofon og neste opptak</div>
      <div class="ob-tip"><strong>Planlegging</strong> — Legg til og endre opptakstider</div>
      <div class="ob-tip"><strong>Innstillinger</strong> — Juster lydkvalitet og lagringsmappe</div>
    </div>
    <div class="ob-actions">
      <button class="btn-primary" id="ob-done" style="justify-content:center">Åpne SundayRec →</button>
    </div>`
  document.getElementById('ob-done')?.addEventListener('click', finish)
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m))
}
