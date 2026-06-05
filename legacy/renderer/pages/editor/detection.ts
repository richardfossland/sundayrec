import { t } from '../../i18n'
import { E, $, markDirty, type Suggestion } from './state'
import { formatTime, formatDuration } from './format'
import { drawWaveform, drawMinimap } from './waveform'
import { pushCutHistory, renderCutList, updateRemainingDisplay } from './cuts'

// Segment detection / analyze panel. (Full detection logic lands here in a
// later phase; for now just the display predicate the waveform renderer needs.)

export function shouldShowSegment(type: string): boolean {
  if (type === 'sermon') return true
  if (type === 'speech') return E.showSpeechSegments
  if (type === 'music')  return E.showMusicSegments
  if (type === 'silence') return E.showSilenceSegments
  // mixed / unknown → render only if speech is on (closest match)
  return E.showSpeechSegments
}


/** Per-type visibility filter for segments. Sermon (the highlighted
 *  suggested-keep range) is always visible — it's the most actionable
 *  outcome of analysis. Speech / music / silence honour the user's toggles. */
/** Runs segment detection. `auto` = true skips the button-disabled UI dance
 *  (used for auto-run after file load — we don't want to spook the user with
 *  a disabled button they didn't click). */
export async function runDetection(auto = false): Promise<void> {
  if (!E.filePath) return
  const btn       = $('btn-detect-segments') as HTMLButtonElement | null
  const analyzing = $('editor-segments-analyzing')
  if (!auto && btn) { btn.disabled = true; btn.textContent = t('editor.analyzing', 'Analyserer…') }
  if (analyzing)   analyzing.style.display = ''

  E.suggestions = []
  renderAnalyzePanel()
  hideSuggestionBanner()

  const fpAtStart = E.filePath
  let raw: Suggestion[] = []
  try {
    raw = (await window.api.editorDetectSegments(E.filePath)) as Suggestion[]
  } catch {
    raw = []
  }
  // Guard against the user closing/swapping the file mid-analysis: drop the
  // result if we're no longer on the same recording.
  if (fpAtStart !== E.filePath) return

  E.suggestions = raw
  E.lastAnalyzedAt = Date.now()

  if (!auto && btn) { btn.disabled = false; btn.textContent = t('editor.analyzeRun', '▶ Analyser opptak') }
  if (analyzing)   analyzing.style.display = 'none'
  renderAnalyzePanel()
  drawWaveform()

  // Show the auto-trim suggestion banner whenever we have a meaningful trim
  // (silence/music head or tail bigger than 0.5 s). Don't show if the user
  // already has cuts — they're clearly editing manually.
  if (E.cuts.length === 0) showSuggestionBanner()
}

/**
 * Render the merged "Analyser opptak" panel — replaces the old
 * separate Kapittelmarkører + Analyser opptak sections. Shows a summary
 * line ("Sist analysert: 31.5 14:23 · 3 tale-segmenter funnet"), the
 * three on-timeline toggles (speech/music/silence), and the
 * "Marker preken automatisk" button.
 *
 * Backwards-compat note: `meta.chapters` is still maintained as the
 * underlying data model but no longer surfaced as its own card — chapter
 * dots still render on the canvas if present, and any history sidecar
 * with existing chapter metadata is preserved on save.
 */
export function renderAnalyzePanel(): void {
  const summary  = $('editor-analyze-summary')
  const controls = $('editor-analyze-controls')
  const markBtn  = $('btn-apply-auto-trim')
  const markHint = $('editor-auto-trim-hint')

  // Render summary line if we've ever analyzed this file.
  if (summary) {
    if (E.lastAnalyzedAt > 0) {
      const speechCount = E.suggestions.filter(s => s.type === 'speech' || s.type === 'sermon').length
      const d = new Date(E.lastAnalyzedAt)
      const date = `${d.getDate()}.${d.getMonth() + 1}`
      const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      summary.textContent = `${t('editor.analyzedAt', 'Sist analysert')}: ${date} ${time} · ${speechCount} ${t('editor.speechSegments', 'tale-segmenter funnet')}`
      summary.style.display = ''
    } else {
      summary.style.display = 'none'
    }
  }

  if (controls) controls.style.display = E.lastAnalyzedAt > 0 ? '' : 'none'

  // Show "Bruk forslag" / sermon-picker only when we have a sermon detected.
  const hasSermon = E.suggestions.some(s => s.type === 'sermon')
  if (markBtn)  (markBtn as HTMLElement).style.display  = hasSermon ? '' : 'none'
  if (markHint) (markHint as HTMLElement).style.display = hasSermon ? '' : 'none'
  renderSermonPicker()
}

/** Apply trim cuts around the currently-marked sermon segment: drop every-
 *  thing before sermon.start and after sermon.end. */
export function applySermonTrim(): void {
  const sermon = E.suggestions.find(s => s.type === 'sermon')
  if (!sermon || !E.duration) return
  E.cuts = []
  if (sermon.start > 0.5) {
    E.cuts.push({ start: 0, end: Math.min(sermon.start, E.duration) })
  }
  if (sermon.end < E.duration - 0.5) {
    E.cuts.push({ start: Math.max(0, sermon.end), end: E.duration })
  }
  pushCutHistory()
  markDirty()
  renderCutList()
  updateRemainingDisplay()
  drawWaveform()
  drawMinimap()
}

/** Promote a specific speech segment to be the "sermon" (overrides the
 *  auto-detected pick). Demotes the previous sermon back to plain 'speech'. */
export function setSermonSegment(speechIdx: number): void {
  // Reset any current sermon → speech
  for (const s of E.suggestions) {
    if (s.type === 'sermon') { s.type = 'speech'; s.label = t('editor.speechLabel', 'Tale') }
  }
  // Promote the chosen speech segment
  const speeches = E.suggestions.filter(s => s.type === 'speech' || s.type === 'sermon')
  const target = speeches[speechIdx]
  if (!target) return
  target.type = 'sermon'
  target.label = 'Preken'
  renderAnalyzePanel()
  drawWaveform()
}

/** Render the sermon-picker dropdown so the user can override the auto-pick.
 *  Shows when there's more than one speech segment that could plausibly be
 *  the sermon (≥ 1 min). Hidden otherwise — single-segment recordings have
 *  no alternative to offer. */
export function renderSermonPicker(): void {
  const picker = $('editor-sermon-picker') as HTMLSelectElement | null
  const wrap   = $('editor-sermon-picker-wrap')
  if (!picker || !wrap) return

  // Build list of all speech-like segments (speech + sermon), in time order.
  const speeches = E.suggestions
    .filter(s => s.type === 'speech' || s.type === 'sermon')
    .filter(s => s.duration >= 60)   // 1-min floor — too-short blocks aren't useful as sermon
    .slice()
    .sort((a, b) => a.start - b.start)

  if (speeches.length < 2) {
    wrap.style.display = 'none'
    return
  }

  wrap.style.display = ''
  picker.innerHTML = ''
  for (let i = 0; i < speeches.length; i++) {
    const s = speeches[i]
    const opt = document.createElement('option')
    opt.value = String(i)
    const startLbl = formatTime(s.start)
    const durLbl   = formatDuration(s.duration)
    const marker   = s.type === 'sermon' ? '★ ' : ''
    opt.textContent = `${marker}${t('editor.speechBlock', 'Tale-blokk')} ${i + 1} — ${startLbl} (${durLbl})`
    if (s.type === 'sermon') opt.selected = true
    picker.appendChild(opt)
  }
}

export function showSuggestionBanner(): void {
  const banner = $('editor-suggestion-banner')
  const detail = $('editor-suggestion-detail')
  const sermon = E.suggestions.find(s => s.type === 'sermon')
  if (!banner || !detail || !sermon || !E.duration) return
  const headDur = sermon.start
  const tailDur = E.duration - sermon.end
  if (headDur < 0.5 && tailDur < 0.5) { banner.style.display = 'none'; return }
  const parts: string[] = []
  if (headDur > 0.5) parts.push(`${formatDuration(headDur)} ${t('editor.beforeSermon', 'før prekenen')}`)
  if (tailDur > 0.5) parts.push(`${formatDuration(tailDur)} ${t('editor.afterSermon', 'etter prekenen')}`)
  const keep = formatDuration(sermon.end - sermon.start)
  detail.textContent = `${parts.join(' + ')} ${t('editor.willBeTrimmed', 'fjernes')} · ${keep} ${t('editor.willRemain', 'preken igjen')}`
  banner.style.display = ''
}

export function hideSuggestionBanner(): void {
  const banner = $('editor-suggestion-banner')
  if (banner) banner.style.display = 'none'
}
