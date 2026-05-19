import { Tray, Menu, nativeImage, app, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import path from 'path'
import * as store from './store'

let tray: Tray | null = null
let win: BrowserWindow | null = null
let isRecording = false
let hasError    = false
let themeDebounce: ReturnType<typeof setTimeout> | null = null
let nextRecording: Date | null = null

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

  tray.on('click', () => {
    if (!win) return
    if (win.isVisible()) win.focus()
    else { win.show(); win.focus() }
  })

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

function updateMenu(): void {
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
  menuItems.push(
    { type: 'separator' },
    { label: openLbl, click: () => { win?.show(); win?.focus() } },
    { type: 'separator' },
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
    { label: quitLbl, click: () => app.quit() }
  )

  const menu = Menu.buildFromTemplate(menuItems)

  tray.setContextMenu(menu)

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
