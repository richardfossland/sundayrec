import { t } from '../../i18n'
import { E, $ } from './state'
import { formatTime } from './format'
import { updateTimecode } from './playback'
import { drawWaveform } from './waveform'

// ── Metadata + chapter list ─────────────────────────────────────────────────

export async function saveMetadata(): Promise<void> {
  if (!E.filePath) return
  await window.api.editorSaveMeta(E.filePath, E.meta)
  E.metaDirty = false
  const btn = $('btn-meta-save')
  if (btn) { btn.textContent = '✓ Lagret'; setTimeout(() => { btn.textContent = 'Lagre metadata' }, 1500) }
}

export function renderMetaPanel(): void {
  const titleEl = $('meta-title') as HTMLInputElement | null
  const spkEl   = $('meta-speaker') as HTMLInputElement | null
  const descEl  = $('meta-description') as HTMLTextAreaElement | null
  if (titleEl) titleEl.value = E.meta.title
  if (spkEl)   spkEl.value   = E.meta.speaker
  if (descEl)  descEl.value  = E.meta.description
}

export function renderChapterList(): void {
  const list = $('chapter-list')
  if (!list) return
  list.innerHTML = ''
  const countEl = $('editor-chapter-count')
  if (countEl) {
    countEl.textContent = String(E.meta.chapters.length)
    countEl.style.display = E.meta.chapters.length ? '' : 'none'
  }
  if (E.meta.chapters.length === 0) {
    list.innerHTML = `<div class="editor-chapters-empty">${t('editor.chaptersEmpty', 'Ingen kapitler ennå. Klikk «+ Legg til ved playhead» for å starte.')}</div>`
    return
  }
  for (let i = 0; i < E.meta.chapters.length; i++) {
    const ch = E.meta.chapters[i]
    const row = document.createElement('div')
    row.className = 'editor-chapter-row'

    const timeLbl = document.createElement('span')
    timeLbl.className = 'editor-chapter-time'
    timeLbl.textContent = formatTime(ch.time)
    timeLbl.title = t('editor.chapterClickSeek', 'Klikk for å søke')
    timeLbl.addEventListener('click', () => { E.playStartSec = ch.time; updateTimecode(ch.time); drawWaveform() })

    const nameInput = document.createElement('input')
    nameInput.className = 'editor-chapter-name'
    nameInput.value = ch.title
    nameInput.addEventListener('input', () => {
      E.meta.chapters[i].title = nameInput.value
      E.metaDirty = true
      drawWaveform()
    })

    const delBtn = document.createElement('button')
    delBtn.className = 'editor-chapter-del'
    delBtn.textContent = '✕'
    delBtn.addEventListener('click', () => {
      E.meta.chapters.splice(i, 1)
      E.metaDirty = true
      renderChapterList()
      drawWaveform()
    })

    row.appendChild(timeLbl)
    row.appendChild(nameInput)
    row.appendChild(delBtn)
    list.appendChild(row)
  }
}
