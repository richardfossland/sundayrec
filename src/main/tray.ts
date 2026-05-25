import { Tray, Menu, nativeImage, app, nativeTheme, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import * as store from './store'

let tray: Tray | null = null
let win: BrowserWindow | null = null
let isRecording = false
let hasError    = false
let themeDebounce: ReturnType<typeof setTimeout> | null = null
let nextRecording: Date | null = null
let diagnoseHandler: (() => void) | null = null
let reviewQueueCount = 0

const TRAY_LABELS: Record<string, [string, string, string, string, string, string, string]> = {
  //                  recording          error                    ready       open          stop          start         quit
  no: ['🔴 Tar opp…', '⚠️ Feil — klikk for detaljer', '✅ Klar', 'Åpne SundayRec', 'Stopp opptak', 'Start opptak nå', 'Avslutt'],
  en: ['🔴 Recording…', '⚠️ Error — click for details', '✅ Ready', 'Open SundayRec', 'Stop recording', 'Start recording now', 'Quit'],
  de: ['🔴 Aufnahme…', '⚠️ Fehler — klicken für Details', '✅ Bereit', 'SundayRec öffnen', 'Aufnahme stoppen', 'Aufnahme starten', 'Beenden'],
  sv: ['🔴 Spelar in…', '⚠️ Fel — klicka för detaljer', '✅ Klar', 'Öppna SundayRec', 'Stoppa inspelning', 'Starta inspelning nu', 'Avsluta'],
  da: ['🔴 Optager…', '⚠️ Fejl — klik for detaljer', '✅ Klar', 'Åbn SundayRec', 'Stop optagelse', 'Start optagelse nu', 'Afslut'],
  pl: ['🔴 Nagrywa…', '⚠️ Błąd — kliknij po szczegóły', '✅ Gotowy', 'Otwórz SundayRec', 'Zatrzymaj nagrywanie', 'Rozpocznij nagrywanie', 'Wyjdź'],
  fr: ['🔴 Enregistrement…', '⚠️ Erreur — cliquez pour détails', '✅ Prêt', 'Ouvrir SundayRec', "Arrêter l'enregistrement", 'Démarrer un enregistrement', 'Quitter']
}

const DIAGNOSE_LABEL: Record<string, string> = {
  no: 'Diagnoser system…',
  en: 'Run diagnostics…',
  de: 'Diagnose starten…',
  sv: 'Kör diagnostik…',
  da: 'Kør diagnostik…',
  pl: 'Uruchom diagnostykę…',
  fr: 'Lancer le diagnostic…',
}

const OPEN_FOLDER_LABEL: Record<string, string> = {
  no: 'Åpne lagringsmappe',
  en: 'Open recordings folder',
  de: 'Aufnahmeordner öffnen',
  sv: 'Öppna inspelningsmapp',
  da: 'Åbn optagelsesmappe',
  pl: 'Otwórz folder nagrań',
  fr: 'Ouvrir le dossier des enregistrements',
}

const CHECK_SYSTEM_LABEL: Record<string, string> = {
  no: 'Sjekk system nå',
  en: 'Check system now',
  de: 'System jetzt prüfen',
  sv: 'Kontrollera systemet nu',
  da: 'Tjek systemet nu',
  pl: 'Sprawdź system teraz',
  fr: 'Vérifier le système',
}

const REVIEW_QUEUE_LABEL: Record<string, (n: number) => string> = {
  no: n => `📬 ${n} ${n === 1 ? 'episode klar' : 'episoder klare'} for gjennomgang`,
  en: n => `📬 ${n} ${n === 1 ? 'episode' : 'episodes'} ready for review`,
  de: n => `📬 ${n} ${n === 1 ? 'Episode bereit' : 'Episoden bereit'} zur Überprüfung`,
  sv: n => `📬 ${n} ${n === 1 ? 'avsnitt' : 'avsnitt'} klart för granskning`,
  da: n => `📬 ${n} ${n === 1 ? 'episode' : 'episoder'} klar til gennemgang`,
  pl: n => `📬 ${n} ${n === 1 ? 'odcinek gotowy' : 'odcinki gotowe'} do przeglądu`,
  fr: n => `📬 ${n} ${n === 1 ? 'épisode prêt' : 'épisodes prêts'} à examiner`,
}

const TOOLTIP: Record<string, string> = {
  no: 'SundayRec — kjører i bakgrunnen',
  en: 'SundayRec — running in background',
  de: 'SundayRec — läuft im Hintergrund',
  sv: 'SundayRec — körs i bakgrunden',
  da: 'SundayRec — kører i baggrunden',
  pl: 'SundayRec — działa w tle',
  fr: "SundayRec — s'exécute en arrière-plan"
}

const NEXT_LABEL: Record<string, string> = {
  no: 'Neste opptak',
  en: 'Next recording',
  de: 'Nächste Aufnahme',
  sv: 'Nästa inspelning',
  da: 'Næste optagelse',
  pl: 'Następne nagranie',
  fr: 'Prochain enregistrement',
}

export function create(mainWindow: BrowserWindow): void {
  win = mainWindow

  const iconFile = process.platform === 'darwin' ? 'tray-idleTemplate.png' : 'tray-idle.png'
  const iconPath = path.join(__dirname, '../../assets', iconFile)
  let icon = nativeImage.createFromPath(iconPath)
  if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 })
  tray = new Tray(icon)

  updateTooltip()

  // Left click shows the menu (macOS convention — most menubar apps work this way).
  // The menu's top item is "Open SundayRec" so opening the window is still one click away.
  // Double-click goes straight to the window for users who want that shortcut.
  // On macOS: setContextMenu intercepts left click — so we manually pop up on click events
  //           and skip setContextMenu entirely.
  // On Windows/Linux: setContextMenu handles right-click natively; we also bind 'click'
  //                   to pop up the menu so left-click works consistently across platforms.
  tray.on('click', () => updateMenu(true))
  tray.on('double-click', () => {
    if (!win) return
    if (win.isVisible()) win.focus()
    else { win.show(); win.focus() }
  })

  if (process.platform === 'darwin') {
    tray.on('right-click', () => updateMenu(true))
  }

  // Update tray icon when Windows dark/light mode changes
  if (process.platform === 'win32') {
    nativeTheme.on('updated', () => {
      if (themeDebounce) clearTimeout(themeDebounce)
      themeDebounce = setTimeout(() => updateMenu(), 50)
    })
  }

  updateMenu()
}

function updateTooltip(): void {
  if (!tray) return
  const lang    = store.get('language') ?? 'no'
  let tooltip   = TOOLTIP[lang] ?? TOOLTIP.no
  if (nextRecording) {
    const dateStr = nextRecording.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    })
    tooltip += `\n${NEXT_LABEL[lang] ?? NEXT_LABEL.en}: ${dateStr}`
  }
  tray.setToolTip(tooltip)
}

function updateMenu(popup = false): void {
  if (!tray) return

  const lang = store.get('language') ?? 'no'
  const lbl  = TRAY_LABELS[lang] ?? TRAY_LABELS.no
  const [recLbl, errLbl, readyLbl, openLbl, stopLbl, startLbl, quitLbl] = lbl

  const statusLabel = isRecording ? recLbl : hasError ? errLbl : readyLbl

  const nextLabel = nextRecording
    ? nextRecording.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
    : null

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: statusLabel,
      enabled: hasError,
      click: hasError ? () => { win?.show(); win?.focus() } : undefined
    },
  ]
  if (nextLabel && !isRecording) {
    menuItems.push({ label: `${NEXT_LABEL[lang] ?? NEXT_LABEL.en}: ${nextLabel}`, enabled: false })
  }

  // High-priority callout: episodes waiting for human review. The whole prep-and-
  // review flow hinges on the user seeing this — surface it at the top of the menu
  // when there's anything queued.
  if (reviewQueueCount > 0) {
    const labelFn = REVIEW_QUEUE_LABEL[lang] ?? REVIEW_QUEUE_LABEL.en
    menuItems.push(
      { type: 'separator' },
      {
        label: labelFn(reviewQueueCount),
        click: () => {
          if (!win) return
          win.show(); win.focus()
          // Renderer listens for this and navigates to the first queue entry.
          win.webContents.send('tray-open-review-queue')
        },
      },
    )
  }

  menuItems.push(
    { type: 'separator' },
    { label: openLbl, click: () => { win?.show(); win?.focus() } },
    {
      label: isRecording ? stopLbl : startLbl,
      click: () => {
        if (!win) return
        if (isRecording) {
          win.webContents.send('tray-stop-recording')
        } else {
          win.show()
          win.webContents.send('tray-start-recording')
        }
      }
    },
    { type: 'separator' },
    {
      label: OPEN_FOLDER_LABEL[lang] ?? OPEN_FOLDER_LABEL.en,
      click: () => {
        const folder = store.get('saveFolder')
        if (folder) shell.openPath(folder).catch(() => {})
      },
    },
    {
      label: CHECK_SYSTEM_LABEL[lang] ?? CHECK_SYSTEM_LABEL.en,
      click: () => {
        if (!win) return
        win.show(); win.focus()
        win.webContents.send('tray-run-preflight')
      },
    },
    { type: 'separator' },
    { label: DIAGNOSE_LABEL[lang] ?? DIAGNOSE_LABEL.en, click: () => diagnoseHandler?.() },
    { type: 'separator' },
    { label: quitLbl, click: () => app.quit() }
  )

  const menu = Menu.buildFromTemplate(menuItems)

  if (process.platform === 'darwin') {
    // Don't call setContextMenu on macOS — it intercepts left click.
    // Menu is shown via right-click → popUpContextMenu instead.
    if (popup) tray.popUpContextMenu(menu)
  } else {
    tray.setContextMenu(menu)
  }

  const base = isRecording ? 'tray-recording' : hasError ? 'tray-error' : 'tray-idle'
  try {
    let iconFile: string
    if (process.platform === 'darwin') {
      iconFile = base + 'Template.png'
    } else if (process.platform === 'win32' && nativeTheme.shouldUseDarkColors) {
      iconFile = base + '-dark.png'
    } else {
      iconFile = base + '.png'
    }
    let icon = nativeImage.createFromPath(path.join(__dirname, '../../assets', iconFile))
    // Fall back to default icon if dark variant doesn't exist
    if (icon.isEmpty() && process.platform === 'win32') {
      icon = nativeImage.createFromPath(path.join(__dirname, '../../assets', base + '.png'))
    }
    if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 })
    tray.setImage(icon)
  } catch {}
}

export function setRecording(active: boolean): void {
  isRecording = active
  if (active) hasError = false
  updateMenu()
}

export function setError(active: boolean): void {
  hasError = active
  updateMenu()
}

export function setNextRecording(date: Date | null): void {
  nextRecording = date
  updateTooltip()
  updateMenu()
}

export function setDiagnoseHandler(fn: () => void): void {
  diagnoseHandler = fn
}

/** Update the count of episodes awaiting human review. Shown prominently in the tray menu. */
export function setReviewQueueCount(count: number): void {
  if (reviewQueueCount === count) return
  reviewQueueCount = count
  updateMenu()
}
