import { app, BrowserWindow, ipcMain, Notification, dialog, shell, systemPreferences, powerMonitor, protocol, net } from 'electron'
import path from 'path'
import fs from 'fs'
import * as logger from './logger'
import * as store from './store'
import * as scheduler from './scheduler'
import * as recorder from './recorder'
import { NOTIFY_LABELS } from './recorder'
import * as preroll from './preroll'
import * as tray from './tray'
import * as updater from './updater'
import * as mailer from './mailer'
import * as wake from './wake'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

// macOS sends SIGTERM when the OS restarts or updates — stop any active recording cleanly
process.on('SIGTERM', () => {
  console.log('[SundayRec] SIGTERM received — shutting down gracefully')
  if (recorder.isActive()) {
    recorder.onceIdle(() => { forceQuit = true; app.quit() })
    recorder.stopSession()
    setTimeout(() => { forceQuit = true; app.quit() }, 30000)
  } else {
    forceQuit = true
    app.quit()
  }
})

app.setName('SundayRec')

// ── OAuth callback handling (sundayrec://oauth/<service>?code=…&state=…) ─────
// On macOS, the OS dispatches the URL via app.on('open-url'). On Windows/Linux,
// the URL arrives as the last argv item — either at cold start or via
// second-instance when the browser launches a second copy.

function consumeAuthUrlFromArgv(argv: readonly string[]): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const a = argv[i]
    if (typeof a === 'string' && a.startsWith('sundayrec://')) return a
  }
  return null
}

async function dispatchAuthUrl(url: string): Promise<void> {
  try {
    const cloud = await import('./cloud')
    cloud.handleAuthUrl(url)
  } catch (err) {
    console.error('[oauth] handleAuthUrl failed:', (err as Error).message)
  }
}

/**
 * Keep the tray menu's "📬 N episoder klare" badge in sync with the persisted
 * review queue. Called whenever the queue may have changed (prep added, item
 * published, item discarded) and once at startup.
 */
async function syncTrayReviewQueueCount(): Promise<void> {
  try {
    const rq = await import('./review-queue')
    const pending = rq.getQueue().filter(e =>
      e.prep.status !== 'published' && e.prep.status !== 'discarded'
    ).length
    tray.setReviewQueueCount(pending)
  } catch (err) {
    console.error('[tray] sync review-queue count failed:', (err as Error).message)
  }
}

// macOS dispatch — must be registered before app.whenReady() so cold-start URLs work
app.on('open-url', (event, url) => {
  event.preventDefault()
  void dispatchAuthUrl(url)
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

// Prevent multiple instances — must be registered before requestSingleInstanceLock
app.on('second-instance', (_event, argv) => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
  // Windows/Linux: a second-instance event is how the OS passes a sundayrec://
  // URL to the already-running app. Scan argv for the OAuth callback.
  const url = consumeAuthUrlFromArgv(argv)
  if (url) void dispatchAuthUrl(url)
})
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// Initial cold-start argv scan (Windows launches the app with sundayrec://...
// directly the first time the browser triggers it). Defer dispatch until after
// the window is ready so the renderer can react to status events.
const initialAuthUrl = consumeAuthUrlFromArgv(process.argv)
if (initialAuthUrl) {
  app.whenReady().then(() => { void dispatchAuthUrl(initialAuthUrl) })
}

if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(path.join(__dirname, '../../assets/icon.png'))
}

const MISSED_NOTIFY_LABELS: Record<string, [string, string]> = {
  no: ['SundayRec — opptak ikke utført', 'Et planlagt opptak kan ha blitt hoppet over. Sjekk opptakshistorikken.'],
  en: ['SundayRec — recording possibly missed', 'A scheduled recording may have been skipped. Check recording history.'],
  de: ['SundayRec — Aufnahme möglicherweise verpasst', 'Eine geplante Aufnahme wurde möglicherweise übersprungen. Verlauf prüfen.'],
  sv: ['SundayRec — inspelning möjligen missad', 'En schemalagd inspelning kan ha hoppats över. Kontrollera historiken.'],
  da: ['SundayRec — optagelse muligvis misset', 'En planlagt optagelse kan være sprunget over. Tjek optagelseshistorikken.'],
  pl: ['SundayRec — nagranie możliwe pominięte', 'Zaplanowane nagranie mogło zostać pominięte. Sprawdź historię nagrań.'],
  fr: ['SundayRec — enregistrement peut-être manqué', "Un enregistrement planifié a peut-être été ignoré. Vérifiez l'historique."],
}

const WAKE_NOTIFY_LABELS: Record<string, [string, string]> = {
  no: ['SundayRec — vekket for opptak', 'Opptak starter kl. {time}'],
  en: ['SundayRec — woke for recording', 'Recording starts at {time}'],
  de: ['SundayRec — geweckt für Aufnahme', 'Aufnahme beginnt um {time}'],
  sv: ['SundayRec — väckt för inspelning', 'Inspelning startar kl. {time}'],
  da: ['SundayRec — vækket til optagelse', 'Optagelse starter kl. {time}'],
  pl: ['SundayRec — wybudzono do nagrania', 'Nagranie zaczyna się o {time}'],
  fr: ['SundayRec — réveillé pour enregistrement', "L'enregistrement commence à {time}"],
}

const IMMINENT_LABELS: Record<string, [string, string, string, string]> = {
  no: ['Avslutt likevel', 'Avbryt', 'Planlagt opptak nærmer seg',
       'Et opptak er planlagt om {mins} min. Lukk vinduet (✕) i stedet for å avslutte – da kjører appen i bakgrunnen.'],
  en: ['Quit anyway', 'Cancel', 'Scheduled recording approaching',
       'A recording is scheduled in {mins} min. Close the window (✕) instead of quitting – the app will run in the background.'],
  de: ['Trotzdem beenden', 'Abbrechen', 'Geplante Aufnahme steht bevor',
       'Eine Aufnahme ist in {mins} Min. geplant. Schließen Sie das Fenster (✕) statt zu beenden – die App läuft im Hintergrund weiter.'],
  sv: ['Avsluta ändå', 'Avbryt', 'Schemalagd inspelning börjar snart',
       'En inspelning är schemalagd om {mins} min. Stäng fönstret (✕) i stället – appen fortsätter i bakgrunden.'],
  da: ['Afslut alligevel', 'Annuller', 'Planlagt optagelse nærmer sig',
       'En optagelse er planlagt om {mins} min. Luk vinduet (✕) i stedet – appen kører videre i baggrunden.'],
  pl: ['Wyjdź mimo to', 'Anuluj', 'Planowane nagranie zbliża się',
       'Nagranie jest zaplanowane za {mins} min. Zamknij okno (✕) zamiast wychodzić – aplikacja będzie działać w tle.'],
  fr: ['Quitter quand même', 'Annuler', 'Enregistrement planifié dans peu de temps',
       "Un enregistrement est prévu dans {mins} min. Fermez la fenêtre (✕) plutôt que de quitter – l'application continue en arrière-plan."]
}

const QUIT_LABELS: Record<string, [string, string, string, string]> = {
  no: ['Stopp opptak og avslutt', 'Fortsett opptak', 'Opptak pågår', 'Opptaket vil bli lagret frem til nå hvis du avslutter.'],
  en: ['Stop recording and quit', 'Continue recording', 'Recording in progress', 'The recording will be saved up to this point if you quit.'],
  de: ['Aufnahme beenden und beenden', 'Aufnahme fortsetzen', 'Aufnahme läuft', 'Die Aufnahme wird bis jetzt gespeichert, wenn Sie beenden.'],
  sv: ['Stoppa inspelning och avsluta', 'Fortsätt inspelning', 'Inspelning pågår', 'Inspelningen sparas fram till nu om du avslutar.'],
  da: ['Stop optagelse og afslut', 'Fortsæt optagelse', 'Optagelse i gang', 'Optagelsen gemmes op til dette punkt, hvis du afslutter.'],
  pl: ['Zatrzymaj nagrywanie i wyjdź', 'Kontynuuj nagrywanie', 'Nagrywanie w toku', 'Nagranie zostanie zapisane do tego momentu, jeśli wyjdziesz.'],
  fr: ["Arrêter l'enregistrement et quitter", "Continuer l'enregistrement", 'Enregistrement en cours', "L'enregistrement sera sauvegardé jusqu'ici si vous quittez."]
}

let mainWindow: BrowserWindow

// ── Missed-recording detection ────────────────────────────────────────────────

// Store the next expected recording time so we can detect if it was skipped
function storeNextExpected(upcomingDates: Date[]): void {
  const iso = upcomingDates[0]?.toISOString() ?? null
  store.set('nextExpectedRecordingISO', iso)
}

// Call this on startup BEFORE the first wake.reschedule() overwrites the stored time.
// If the stored time has passed and no history entry covers it → the machine never woke up.
function checkTrulyMissedRecordings(): void {
  if (recorder.isActive()) return
  const storedISO = store.get('nextExpectedRecordingISO')
  if (!storedISO) return

  const expectedMs = new Date(storedISO).getTime()
  if (isNaN(expectedMs)) return

  const minutesAgo = (Date.now() - expectedMs) / 60000
  // Only flag between 25 min (after late-start window) and 24 hours ago
  if (minutesAgo < 25 || minutesAgo > 24 * 60) return

  const history = store.getHistory()
  const hasCoverage = history.some(e => e.timestamp && Math.abs(e.timestamp - expectedMs) < 25 * 60 * 1000)
  if (!hasCoverage) {
    const lang = store.get('language') ?? 'no'
    const lbl  = MISSED_NOTIFY_LABELS[lang] ?? MISSED_NOTIFY_LABELS.no
    if (Notification.isSupported()) new Notification({ title: lbl[0], body: lbl[1] }).show()
  }
}

// ── Video editor state ────────────────────────────────────────────────────────
let currentEditorVideoPath: string | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 660,
    minWidth: 820,
    minHeight: 580,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d0d11',
    show: false
  })

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  } else {
    // electron-vite dev server
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
  }

  mainWindow.webContents.setBackgroundThrottling(false)

  mainWindow.webContents.once('did-finish-load', () => {
    if (!recorder.isActive()) scheduler.checkMissedRecordings()
  })

  mainWindow.once('ready-to-show', () => {
    const isFirst    = !store.get('hasLaunched')
    const launchHide = process.argv.includes('--hidden')
    if (isFirst) {
      store.set('hasLaunched', true)
      mainWindow.show()
    } else if (!launchHide && store.get('showOnStartup')) {
      mainWindow.show()
    }
  })

  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow.hide()
    }
  })
}

// Must be called before app.ready so the renderer recognises the custom scheme
// as a privileged/secure origin (required for <video> and fetch from renderer).
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } }
])

app.whenReady().then(async () => {
  if (!store.get('saveFolder')) {
    const musicPath = app.getPath('music')
    const defaultFolder = fs.existsSync(musicPath)
      ? path.join(musicPath, 'SundayRec')
      : path.join(app.getPath('documents'), 'SundayRec')
    store.set('saveFolder', defaultFolder)
  }
  const saveFolder = store.get('saveFolder') ?? path.join(app.getPath('documents'), 'SundayRec')
  fs.mkdirSync(saveFolder, { recursive: true })
  if (!store.get('language')) {
    const locale    = app.getLocale() || 'en'
    const lang      = locale.slice(0, 2)
    const supported = ['no', 'nb', 'nn', 'en', 'de', 'sv', 'da', 'pl', 'fr']
    store.set('language', supported.includes(lang)
      ? (lang === 'nb' || lang === 'nn' ? 'no' : lang)
      : 'en')
  }

  if (process.platform === 'darwin') {
    const lang = store.get('language') ?? 'en'

    const micOk = await systemPreferences.askForMediaAccess('microphone')
    if (!micOk) {
      console.warn('[SundayRec] Microphone access denied')
      const MIC_DENIED: Record<string, [string, string, string]> = {
        no: ['Mikrofontilgang nektet', 'SundayRec trenger tilgang til mikrofon for å ta opp. Åpne Systeminnstillinger → Personvern & sikkerhet → Mikrofon og aktiver SundayRec.', 'Åpne Systeminnstillinger'],
        en: ['Microphone access denied', 'SundayRec needs microphone access to record. Open System Settings → Privacy & Security → Microphone and enable SundayRec.', 'Open System Settings'],
        de: ['Mikrofonzugriff verweigert', 'SundayRec benötigt Mikrofonzugriff. Öffnen Sie Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon.', 'Systemeinstellungen öffnen'],
        sv: ['Mikrofonåtkomst nekad', 'SundayRec behöver mikrofonåtkomst. Öppna Systeminställningar → Integritet & säkerhet → Mikrofon.', 'Öppna Systeminställningar'],
        da: ['Mikrofonadgang nægtet', 'SundayRec skal bruge mikrofonadgang. Åbn Systemindstillinger → Privatliv & sikkerhed → Mikrofon.', 'Åbn Systemindstillinger'],
        pl: ['Odmowa dostępu do mikrofonu', 'SundayRec potrzebuje dostępu do mikrofonu. Otwórz Ustawienia systemowe → Prywatność i bezpieczeństwo → Mikrofon.', 'Otwórz ustawienia systemowe'],
        fr: ['Accès au microphone refusé', "SundayRec a besoin d'accéder au microphone. Ouvrez Réglages système → Confidentialité et sécurité → Microphone.", 'Ouvrir les Réglages système'],
      }
      const [title, detail, openBtn] = MIC_DENIED[lang] ?? MIC_DENIED.en
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: [openBtn, 'OK'], defaultId: 0,
        title, message: title, detail
      })
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }

    const camOk = await systemPreferences.askForMediaAccess('camera')
    if (!camOk) {
      console.warn('[SundayRec] Camera access denied')
      const CAM_DENIED: Record<string, [string, string, string]> = {
        no: ['Kameratilgang nektet', 'SundayRec trenger tilgang til kamera for å ta opp video. Åpne Systeminnstillinger → Personvern & sikkerhet → Kamera og aktiver SundayRec.', 'Åpne Systeminnstillinger'],
        en: ['Camera access denied', 'SundayRec needs camera access for video recording. Open System Settings → Privacy & Security → Camera and enable SundayRec.', 'Open System Settings'],
        de: ['Kamerazugriff verweigert', 'SundayRec benötigt Kamerazugriff. Öffnen Sie Systemeinstellungen → Datenschutz & Sicherheit → Kamera.', 'Systemeinstellungen öffnen'],
        sv: ['Kameraåtkomst nekad', 'SundayRec behöver kameraåtkomst. Öppna Systeminställningar → Integritet & säkerhet → Kamera.', 'Öppna Systeminställningar'],
        da: ['Kameraadgang nægtet', 'SundayRec skal bruge kameraadgang. Åbn Systemindstillinger → Privatliv & sikkerhed → Kamera.', 'Åbn Systemindstillinger'],
        pl: ['Odmowa dostępu do kamery', 'SundayRec potrzebuje dostępu do kamery. Otwórz Ustawienia systemowe → Prywatność i bezpieczeństwo → Kamera.', 'Otwórz ustawienia systemowe'],
        fr: ['Accès à la caméra refusé', "SundayRec a besoin d'accéder à la caméra. Ouvrez Réglages système → Confidentialité et sécurité → Caméra.", 'Ouvrir les Réglages système'],
      }
      const [title, detail, openBtn] = CAM_DENIED[lang] ?? CAM_DENIED.en
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: [openBtn, 'OK'], defaultId: 0,
        title, message: title, detail
      })
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Camera')
      }
    }
  }

  // Register custom URL scheme for OAuth callbacks (sundayrec://oauth/...).
  // On Windows the installer registers it via electron-builder's `protocols`
  // entry; this call covers macOS and dev mode.
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('sundayrec', process.execPath, [path.resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('sundayrec')
  }

  // Register media:// protocol so the renderer can stream the currently-loaded
  // video file without exposing arbitrary file:// access.
  protocol.handle('media', async (req) => {
    if (!currentEditorVideoPath) return new Response('Not found', { status: 404 })
    const fileUrl = 'file://' + currentEditorVideoPath.replace(/\\/g, '/')
    // Forward all headers (including Range) so the browser can seek within the video
    return net.fetch(fileUrl, { headers: req.headers })
  })

  createWindow()
  tray.create(mainWindow)

  // Wire diagnose handler — runs in the main process, shows a native result dialog
  tray.setDiagnoseHandler(async () => {
    const settings = store.getAll()
    const { runDiagnostics } = await import('./diagnostics')
    let result: import('./diagnostics').DiagnosticsReport
    try {
      result = await runDiagnostics(settings, mainWindow)
    } catch (err) {
      await dialog.showMessageBox({ type: 'error', title: 'Diagnose', message: 'Diagnose feilet', detail: String(err), buttons: ['OK'] })
      return
    }
    const savedLine  = result.savedTo ? `Rapport lagret til Skrivebord:\n${result.savedTo}` : 'Kunne ikke lagre til Skrivebord.'
    const clipLine   = result.clipboardOk ? 'Innhold kopiert til utklippstavle.' : ''
    const audioLine  = result.captureOk ? '✅ Lydtest OK' : '❌ Lydtest feilet'
    const videoLine  = result.videoOk === true ? '✅ Videotest OK' : result.videoOk === false ? '❌ Videotest feilet' : ''
    const detail     = [audioLine, videoLine, '', savedLine, clipLine].filter(Boolean).join('\n')
    const btns       = result.savedTo ? ['Vis fil', 'OK'] : ['OK']
    const { response } = await dialog.showMessageBox({
      type: result.captureOk ? 'info' : 'warning',
      title: 'SundayRec — Diagnostikk',
      message: 'Diagnose fullført',
      detail,
      buttons: btns,
      defaultId: btns.length - 1,
    })
    if (result.savedTo && response === 0) shell.showItemInFolder(result.savedTo)
  })

  store.migrateActiveRecovery()
  recorder.recoverCrashedSession()
  scheduler.setBackendWarningSender((msg, sev, cat) => sendBackendWarning(mainWindow, msg, sev, cat))
  scheduler.init(mainWindow)
  updater.init(mainWindow)
  updater.check()
  setInterval(() => updater.check(), 60 * 60 * 1000)
  setupIPC()

  // Kick the cloud upload queue — any entries left from a previous session
  // (network outage, app restart mid-upload) get retried automatically.
  import('./cloud').then(c => c.flushQueue(mainWindow)).catch(err =>
    console.error('[cloud-queue] startup flush failed:', (err as Error).message)
  )

  // Clean up leftover editor temp/backup files from a previous crashed save.
  // The user's save folder is the only place we own — never walk arbitrary
  // editor sources.
  import('./editor').then(e => e.cleanupEditorTempFiles(saveFolder)).then(n => {
    if (n > 0) console.log(`[editor] cleaned ${n} stale temp file(s)`)
  }).catch(err => console.error('[editor] temp cleanup failed:', (err as Error).message))

  // Clean up leftover test-recordings from a previous crashed/killed session.
  import('./test-recorder').then(t => t.cleanupOldTestRecordings()).then(n => {
    if (n > 0) console.log(`[test-recorder] cleaned ${n} stale test file(s)`)
  }).catch(err => console.error('[test-recorder] cleanup failed:', (err as Error).message))

  // Clean up leftover mastering preview files from a previous run.
  import('./mastering').then(m => m.cleanupOldPreviews())
    .catch(err => console.error('[mastering] preview cleanup failed:', (err as Error).message))

  // Restart pre-roll after each session ends (manual or scheduled)
  recorder.setSessionEndCallback(() => {
    const s = store.getAll()
    if ((s.preRollSeconds ?? 0) > 0 && !recorder.isActive()) {
      setTimeout(() => {
        preroll.start(s).catch(err => {
          console.error('[preroll] post-session restart error:', err)
          sendBackendWarning(mainWindow, `Pre-roll restart failed: ${(err as Error).message}`, 'warn', 'preroll')
        })
      }, 1000) // brief pause for device release
    }
  })

  // Start pre-roll if enabled at launch
  const launchSettings = store.getAll()
  if ((launchSettings.preRollSeconds ?? 0) > 0) {
    preroll.start(launchSettings).catch(err => {
      console.error('[preroll] launch start error:', err)
      sendBackendWarning(mainWindow, `Pre-roll failed to start: ${(err as Error).message}`, 'warn', 'preroll')
    })
  }
  cleanupOldRecordings()
  store.pruneHistory()
  const initialUpcoming = scheduler.getUpcomingDates()
  // Check for truly missed recordings BEFORE overwriting the stored expected time
  checkTrulyMissedRecordings()
  storeNextExpected(initialUpcoming)
  wake.reschedule(initialUpcoming, mainWindow).catch(err => {
    console.error('[wake] reschedule error:', err)
    sendBackendWarning(mainWindow, `Wake scheduling failed: ${(err as Error).message}`, 'warn', 'wake')
  })
  tray.setNextRecording(initialUpcoming[0] ?? null)
  void syncTrayReviewQueueCount()

  // On wake from sleep: check for missed recordings, refresh OS wake list, notify user
  powerMonitor.on('resume', () => {
    // If a recording was active during sleep, ffmpeg is almost certainly dead
    // or hung — trigger the reconnect watchdog with extra patience. Must run
    // before scheduler.checkMissedRecordings(), which sees isActive()=true and
    // would short-circuit otherwise.
    if (recorder.isActive()) {
      recorder.notifyResumed()
    }
    scheduler.checkMissedRecordings()
    // Re-attempt queued uploads — internet often returns shortly after wake
    import('./cloud').then(c => c.flushQueue(mainWindow)).catch(err =>
      console.error('[cloud-queue] resume flush failed:', (err as Error).message)
    )
    // Restart pre-roll after wake. ffmpeg is killed by the OS during sleep, so
    // isActive may still be true while the process is dead. Stop first to reset
    // the flag, then restart after 2 s to let the audio device come back online.
    if (!recorder.isActive()) {
      const wakeSettings = store.getAll()
      if ((wakeSettings.preRollSeconds ?? 0) > 0) {
        preroll.stop().catch(() => {}).finally(() => {
          setTimeout(() => {
            preroll.start(wakeSettings).catch(err => {
              console.error('[preroll] wake restart error:', err)
              sendBackendWarning(mainWindow, `Pre-roll failed to restart after wake: ${(err as Error).message}`, 'warn', 'preroll')
            })
          }, 2000)
        })
      }
    }
    const upcoming = scheduler.getUpcomingDates()
    storeNextExpected(upcoming)
    wake.reschedule(upcoming, mainWindow).catch(err => {
      console.error('[wake] resume reschedule error:', err)
      sendBackendWarning(mainWindow, `Wake rescheduling failed after resume: ${(err as Error).message}`, 'warn', 'wake')
    })
    tray.setNextRecording(upcoming[0] ?? null)

    // Show notification if a recording is imminent (within 15 min)
    const next = upcoming[0]
    if (next && Notification.isSupported()) {
      const minsUntil = (next.getTime() - Date.now()) / 60000
      if (minsUntil >= 0 && minsUntil <= 15) {
        const lang = store.get('language') ?? 'no'
        const lbl  = WAKE_NOTIFY_LABELS[lang] ?? WAKE_NOTIFY_LABELS.no
        const timeStr = next.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        new Notification({ title: lbl[0], body: lbl[1].replace('{time}', timeStr) }).show()
      }
    }
  })

  // Refresh OS wake schedules every 6 hours so the list stays current
  setInterval(() => {
    const upcoming = scheduler.getUpcomingDates()
    storeNextExpected(upcoming)
    wake.reschedule(upcoming, mainWindow).catch(err => {
      console.error('[wake] periodic reschedule error:', err)
      sendBackendWarning(mainWindow, `Periodic wake rescheduling failed: ${(err as Error).message}`, 'warn', 'wake')
    })
    tray.setNextRecording(upcoming[0] ?? null)
  }, 6 * 60 * 60 * 1000)

  if (store.get('launchAtLogin')) {
    if (process.platform === 'win32') {
      // openAsHidden is ignored on Windows — pass --hidden arg instead
      app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--hidden'] })
    } else {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })
    }
  }
})

let forceQuit = false
let quitting  = false
app.on('before-quit', async (e) => {
  if (forceQuit) { quitting = true; return }

  const lang = store.get('language') ?? 'en'

  if (recorder.isActive()) {
    e.preventDefault()
    const lbl  = QUIT_LABELS[lang] ?? QUIT_LABELS.en
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [lbl[0], lbl[1]],
      defaultId: 1, cancelId: 1,
      message: lbl[2], detail: lbl[3]
    })
    if (response === 0) {
      recorder.onceIdle(() => { forceQuit = true; app.quit() })
      recorder.stopSession()
      // Safety fallback if ffmpeg hangs
      setTimeout(() => { forceQuit = true; app.quit() }, 30000)
    }
    return
  }

  // Warn if a scheduled recording is imminent
  const upcoming = scheduler.getUpcomingDates(1)
  const soonMs   = upcoming.length ? upcoming[0].getTime() - Date.now() : Infinity
  if (soonMs > 0 && soonMs < 60 * 60000) {
    e.preventDefault()
    const mins = Math.round(soonMs / 60000)
    const imLbl = IMMINENT_LABELS[lang] ?? IMMINENT_LABELS.en
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [imLbl[0], imLbl[1]],
      defaultId: 1, cancelId: 1,
      message: imLbl[2],
      detail: imLbl[3].replace('{mins}', String(mins))
    })
    if (response === 0) { forceQuit = true; app.quit() }
  } else {
    quitting = true
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})


app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[SundayRec] Renderer process gone:', details.reason, 'exitCode:', details.exitCode)
  // Recording runs entirely in the main process — do NOT stop it on renderer crash.
  // Reload the renderer so the user gets the UI back without losing the recording.
  try {
    if (app.isPackaged) {
      mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    } else {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173')
    }
  } catch (err) {
    console.error('[SundayRec] Failed to reload renderer after crash:', err)
    return
  }
  // After the renderer reloads, restore the recording overlay if a session is still active.
  // Use once() so this fires exactly once for this reload, then cleans up automatically.
  mainWindow.webContents.once('did-finish-load', () => {
    if (recorder.isActive()) {
      const opts = recorder.getActiveSessionOpts()
      if (opts) {
        // Longer delay to ensure the renderer's IPC listeners are fully registered even on slow loads.
        // 1200 ms was too tight; slow renderer loads may not have registered listeners in time.
        setTimeout(() => mainWindow?.webContents.send('recording-overlay-start', opts), 3000)
      }
    }
  })
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else mainWindow.show()
})

let ipcSetup = false

function setupIPC(): void {
  if (ipcSetup) return
  ipcSetup = true

  ipcMain.handle('install-update', () => {
    if (process.platform === 'darwin') {
      // macOS: unsigned app — open the releases page instead of attempting in-place install
      shell.openExternal('https://github.com/richardfossland/sundayrec/releases/latest')
      return
    }
    forceQuit = true
    quitting  = true
    setImmediate(() => {
      updater.doInstall()
      // Fallback: if quitAndInstall hasn't exited in 3s, force relaunch
      setTimeout(() => { app.relaunch(); app.exit(0) }, 3000)
    })
  })

  ipcMain.handle('get-platform', () => process.platform)

  ipcMain.handle('get-app-version', () => app.getVersion())

  ipcMain.handle('get-settings', () => store.getAll())

  ipcMain.handle('save-settings', (_, settings) => {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
    store.setAll(settings)
    scheduler.reschedule()
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, path: process.execPath, args: settings.launchAtLogin ? ['--hidden'] : [] })
    } else {
      app.setLoginItemSettings({ openAtLogin: !!settings.launchAtLogin, openAsHidden: true })
    }
    const upcomingAfterSave = scheduler.getUpcomingDates()
    storeNextExpected(upcomingAfterSave)
    wake.reschedule(upcomingAfterSave, mainWindow).catch(err => {
      console.error('[wake] reschedule error:', err)
      sendBackendWarning(mainWindow, `Wake rescheduling failed after settings save: ${(err as Error).message}`, 'warn', 'wake')
    })
    tray.setNextRecording(upcomingAfterSave[0] ?? null)
    // Sync pre-roll state with new settings (stop must complete before start)
    if (!recorder.isActive()) {
      const newPreRollSec = (settings as { preRollSeconds?: number }).preRollSeconds ?? 0
      preroll.stop().then(() => {
        if (newPreRollSec > 0) return preroll.start(store.getAll())
      }).catch(err => {
        console.error('[preroll] settings-change restart error:', err)
        sendBackendWarning(mainWindow, `Pre-roll failed to restart after settings change: ${(err as Error).message}`, 'warn', 'preroll')
      })
    }
    return true
  })

  ipcMain.handle('schedule-os-wakes',       () => wake.reschedule(scheduler.getUpcomingDates(), mainWindow, false))
  ipcMain.handle('schedule-os-wakes-admin', () => wake.reschedule(scheduler.getUpcomingDates(), mainWindow, true))
  ipcMain.handle('get-sleep-config',        () => wake.getSleepConfig())
  ipcMain.handle('fix-mac-sleep',           () => wake.fixMacSleep())
  ipcMain.handle('fix-win-wake-timers',     () => wake.fixWinWakeTimers())

  // ── Wake verification & test-wake ─────────────────────────────────────────
  ipcMain.handle('wake-detect-capabilities', async () => {
    const wv = await import('./wake-verification')
    return wv.detectCapabilities()
  })
  ipcMain.handle('wake-verify-scheduled', async () => {
    const wv = await import('./wake-verification')
    // Mirror what scheduleOsWakes scheduled: lead-time-shifted upcoming dates.
    const LEAD_MIN = 10
    const expected = scheduler.getUpcomingDates().map(d => new Date(d.getTime() - LEAD_MIN * 60_000))
    const status = await wv.verifyScheduledWakes(expected)
    // Serialise Date instances for the renderer
    return {
      ...status,
      expectedWakes: status.expectedWakes.map(d => d.toISOString()),
      observedWakes: status.observedWakes.map(o => ({
        scheduledAt: o.scheduledAt.toISOString(),
        ownerLabel:  o.ownerLabel,
      })),
    }
  })
  ipcMain.handle('wake-check-power', async () => {
    const wv = await import('./wake-verification')
    return wv.checkPowerSource()
  })
  ipcMain.handle('wake-check-standby', async () => {
    const wv = await import('./wake-verification')
    return wv.checkStandbyEnabled()
  })
  ipcMain.handle('wake-test', async (_, secondsAhead?: number) => {
    const sec = typeof secondsAhead === 'number' && secondsAhead > 0 ? secondsAhead : 60
    return wake.testWake(sec, mainWindow)
  })
  ipcMain.handle('wake-cancel-test', () => wake.cancelTestWake())
  ipcMain.handle('wake-failure-history', () => store.getWakeFailureHistory())
  ipcMain.handle('wake-clear-failure-history', () => { store.clearWakeFailureHistory(); return true })

  ipcMain.handle('export-profile', () => store.exportProfile())
  ipcMain.handle('import-profile', (_, json: string) => {
    const ok = store.importProfile(json)
    if (ok) scheduler.reschedule()
    return ok
  })
  ipcMain.handle('reset-settings', () => {
    store.reset()
    const musicPath = app.getPath('music')
    const defaultFolder = fs.existsSync(musicPath)
      ? path.join(musicPath, 'SundayRec')
      : path.join(app.getPath('documents'), 'SundayRec')
    store.set('saveFolder', defaultFolder)
    scheduler.reschedule()
    return true
  })

  ipcMain.handle('get-history', () => store.getHistory())
  ipcMain.handle('delete-history-entry', (_, ts: number) => store.deleteHistoryEntry(ts))
  ipcMain.handle('clear-history', () => store.clearHistory())
  ipcMain.handle('prune-history', () => store.pruneHistory())

  ipcMain.handle('get-next-recording', () => {
    const next = scheduler.getNextRecording()
    return next ? { date: next.date.toISOString() } : null
  })

  ipcMain.handle('get-disk-space', async () => {
    try {
      let folder = store.get('saveFolder') ?? app.getPath('documents')
      if (!fs.existsSync(folder)) folder = app.getPath('documents')
      if (process.platform === 'darwin' || process.platform === 'linux') {
        const { stdout } = await execFileAsync('df', ['-Pk', folder], { timeout: 5000 })
        const cols = stdout.trim().split('\n')[1]?.trim().split(/\s+/)
        const free = cols ? parseInt(cols[3]) : NaN
        if (!isNaN(free)) return { freeBytes: free * 1024 }
      }
      if (process.platform === 'win32') {
        // Use WMI to get free bytes by path — works for drive letters and UNC paths
        const escapedFolder = folder.replace(/'/g, "''")
        const { stdout } = await execFileAsync('powershell', [
          '-NoProfile', '-Command',
          `(Get-Item -LiteralPath '${escapedFolder}' -ErrorAction SilentlyContinue | ` +
          `Select-Object -ExpandProperty PSDrive -ErrorAction SilentlyContinue).Free`
        ], { timeout: 5000 })
        const free = parseInt(stdout.trim())
        if (!isNaN(free) && free >= 0) return { freeBytes: free }
        // Fallback: parse drive letter for local drives
        const m = folder.match(/^([A-Za-z]):/)
        if (m) {
          const { stdout: fb } = await execFileAsync('powershell', [
            '-NoProfile', '-Command', `(Get-PSDrive -Name '${m[1]}').Free`
          ], { timeout: 5000 })
          const free2 = parseInt(fb.trim())
          if (!isNaN(free2) && free2 >= 0) return { freeBytes: free2 }
        }
      }
    } catch {}
    return { freeBytes: null }
  })

  ipcMain.handle('start-recording-now', async (_, opts) => {
    if (opts !== undefined && opts !== null && (typeof opts !== 'object' || Array.isArray(opts))) {
      return { error: 'invalid_opts' }
    }
    // Sanitise numeric fields to prevent out-of-range values from crashing ffmpeg
    if (opts && typeof opts === 'object') {
      const o = opts as Record<string, unknown>
      if (o['maxMinutes'] !== undefined) {
        const v = Number(o['maxMinutes'])
        if (!Number.isFinite(v) || v < 1 || v > 1440) o['maxMinutes'] = undefined
      }
      if (o['splitMinutes'] !== undefined) {
        const v = Number(o['splitMinutes'])
        if (!Number.isFinite(v) || v < 1 || v > 480) o['splitMinutes'] = undefined
      }
    }
    const settings = { ...store.getAll(), ...(opts ?? {}) }
    // Map manualMaxMinutes → maxMinutes so the auto-stop timer actually fires
    if (!(settings as import('../types').RecordingOpts).maxMinutes && settings.manualMaxMinutes) {
      (settings as import('../types').RecordingOpts).maxMinutes = settings.manualMaxMinutes
    }
    const preRollSec = settings.preRollSeconds ?? 0

    // Harvest pre-roll buffer for manual recordings when enabled
    let prerollData: { rawPath: string; trimMs: number } | null = null
    if (preRollSec > 0 && preroll.isRunning()) {
      prerollData = await preroll.harvest(preRollSec)
      if (prerollData && process.platform === 'darwin') {
        await new Promise<void>(resolve => setTimeout(resolve, 300))
      }
    }

    return recorder.startSession(settings, mainWindow, prerollData)
  })
  ipcMain.handle('stop-recording-now', () => { recorder.stopSession(); return true })

  ipcMain.handle('run-test-recording', async () => {
    const { runTestRecording } = await import('./test-recorder')
    return runTestRecording(store.getAll())
  })

  ipcMain.handle('run-preflight', async () => {
    return scheduler.runManualPreflight()
  })

  ipcMain.handle('test-webhook', async () => {
    const s = store.getAll()
    if (!s.webhookUrl) return { ok: false, error: 'no_url' }
    try {
      const { sendWebhook } = await import('./webhook')
      const ok = await sendWebhook(s.webhookUrl, {
        app:       'SundayRec',
        church:    s.churchName || 'untitled',
        severity:  'warn',
        category:  'device',
        message:   'Test fra SundayRec — webhook fungerer.',
        timestamp: new Date().toISOString(),
      })
      return { ok }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('pick-folder', async () => {
    if (!mainWindow.isVisible()) mainWindow.show()
    mainWindow.focus()
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-folder', (_, p: string) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return
    return shell.openPath(p)
  })
  ipcMain.handle('reveal-file', (_, p: string) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return
    shell.showItemInFolder(p)
  })

  ipcMain.on('recording-error', (_, data: { error: string }) => {
    tray.setRecording(false)
    tray.setError(true)
    const lang = store.get('language') ?? 'no'
    const nl   = NOTIFY_LABELS[lang] ?? NOTIFY_LABELS.no
    notify(nl.err, data.error)
    const settings = store.getAll()
    if (settings.emailOnError) mailer.sendError(settings, store.getSmtpPassword(), data.error)
  })

  const WEAK_SIGNAL_LABELS: Record<string, string> = {
    no: 'Signalet er svakt — er mikseren på?',
    en: 'Signal is weak — is the mixer on?',
    de: 'Signal schwach — ist das Mischpult eingeschaltet?',
    sv: 'Signalen är svag — är mixern påslagen?',
    da: 'Signalet er svagt — er mixeren tændt?',
    pl: 'Sygnał jest słaby — czy mikser jest włączony?',
    fr: 'Signal faible — le mixeur est-il allumé ?',
  }
  ipcMain.on('weak-signal', () => {
    const lang = store.get('language') ?? 'no'
    notify('SundayRec', WEAK_SIGNAL_LABELS[lang] ?? WEAK_SIGNAL_LABELS.no)
  })

  ipcMain.handle('clear-smtp-password', () => {
    store.setSmtpPassword('')
    return true
  })

  ipcMain.handle('test-email', async () => {
    const s = store.getAll()
    mainWindow.webContents.send('email-test-status', { status: 'sending' })
    try {
      const result = await Promise.race([
        mailer.sendTest(s, store.getSmtpPassword()).then(() => ({ ok: true as const })),
        new Promise<{ ok: false; error: string }>(resolve =>
          setTimeout(() => resolve({ ok: false, error: 'Email test timed out after 15 seconds' }), 15000)
        )
      ])
      mainWindow.webContents.send('email-test-status', {
        status: result.ok ? 'ok' : 'error',
        message: result.ok ? undefined : result.error
      })
      return result
    } catch (err) {
      const message = (err as Error).message
      mainWindow.webContents.send('email-test-status', { status: 'error', message })
      return { ok: false, error: message }
    }
  })

  ipcMain.handle('update-history-note', (_, ts: number, note: string) => {
    if (typeof ts !== 'number' || typeof note !== 'string') return
    // Cap note length — without this a compromised renderer could write
    // arbitrarily large strings into the settings file and bloat startup time.
    // 4 KB is plenty for a free-form human note.
    if (note.length > 4096) note = note.slice(0, 4096)
    store.updateHistoryNote(ts, note)
  })

  // Threshold above which Web Audio decode would blow up RAM. Web Audio
  // decodes to 32-bit float PCM at the source sample-rate — a 1 GB FLAC turns
  // into ~5 GB of decoded PCM, which crashes the renderer. Beyond this size
  // we make the renderer fall back to the ffmpeg-extract path (8 kHz mono
  // WAV) which is enough for waveform display + cut finding.
  const EDITOR_INLINE_LIMIT = 400 * 1024 * 1024  // 400 MB

  ipcMain.handle('editor-read-file', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return null
    try {
      const stat = await fs.promises.stat(filePath)
      if (stat.size > EDITOR_INLINE_LIMIT) {
        // Return a sentinel object — old callers checked for falsy. New callers
        // see { tooLarge: true } and switch to the ffmpeg-extract path.
        return { tooLarge: true, size: stat.size }
      }
      return await fs.promises.readFile(filePath)
    } catch { return null }
  })

  ipcMain.handle('editor-save-file', async (_, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { saveEdited } = await import('./editor')
    return saveEdited(params)
  })

  ipcMain.handle('editor-pick-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [
        { name: 'Lyd og video', extensions: [
            'mp3', 'mp1', 'mp2', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'm4r',
            'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'mka',
            'ac3', 'eac3', 'dts', 'amr', '3ga', 'caf', 'ape', 'wv', 'tta',
            'mpc', 'au', 'snd', 'ra', 'ram', 'spx', 'gsm',
            'mp4', 'mov', 'mkv', 'm4v', 'avi', 'wmv', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'asf', 'f4v',
          ] },
        { name: 'Lydfiler', extensions: [
            'mp3', 'mp1', 'mp2', 'wav', 'flac', 'aac', 'm4a', 'm4b', 'm4r',
            'ogg', 'oga', 'opus', 'webm', 'aiff', 'aif', 'wma', 'mka',
            'ac3', 'eac3', 'dts', 'amr', '3ga', 'caf', 'ape', 'wv', 'tta',
            'mpc', 'au', 'snd', 'ra', 'ram', 'spx', 'gsm',
          ] },
        { name: 'Videofiler',   extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'wmv', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'asf', 'f4v'] },
      ]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('editor-export-file', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { exportEdited } = await import('./editor')
    const onProgress = (percent: number) => {
      try { event.sender.send('editor-export-progress', { percent }) } catch {}
    }
    return exportEdited({ ...params, onProgress })
  })

  ipcMain.handle('editor-cancel-export', async (_, jobId: string) => {
    if (typeof jobId !== 'string') return false
    const { cancelExport } = await import('./editor')
    return cancelExport(jobId)
  })

  ipcMain.handle('editor-pick-output-folder', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // Pick an audio file (for intro/outro in settings)
  ipcMain.handle('pick-audio-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // Metadata sidecar read/write
  ipcMain.handle('editor-read-meta', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return null
    const metaPath = sidecarPath(filePath, '.meta.json')
    if (!metaPath) return null
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-save-meta', async (_, filePath: string, metadata: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return false
    const metaPath = sidecarPath(filePath, '.meta.json')
    if (!metaPath) return false
    try {
      await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8')
      return true
    } catch { return false }
  })

  // ── Editor cut autosave (recovery after crash mid-edit) ───────────────────
  ipcMain.handle('editor-read-cuts-draft', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return null
    const draftPath = sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return null
    try {
      const raw = await fs.promises.readFile(draftPath, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-save-cuts-draft', async (_, filePath: string, cuts: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return false
    const draftPath = sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return false
    try {
      await fs.promises.writeFile(draftPath, JSON.stringify({ cuts, ts: Date.now() }), 'utf8')
      return true
    } catch { return false }
  })

  ipcMain.handle('editor-delete-cuts-draft', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return false
    const draftPath = sidecarPath(filePath, '.cuts-draft.json')
    if (!draftPath) return false
    try { await fs.promises.unlink(draftPath); return true } catch { return false }
  })

  ipcMain.handle('editor-detect-segments', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return []
    const { detectSegments } = await import('./editor')
    return detectSegments(filePath)
  })

  // ── Video editor IPC ──────────────────────────────────────────────────────

  ipcMain.handle('editor-set-video-path', (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return false
    currentEditorVideoPath = filePath
    return true
  })

  ipcMain.handle('editor-extract-audio-peaks', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return null
    const { extractAudioForPeaks } = await import('./editor')
    return extractAudioForPeaks(filePath)
  })

  ipcMain.handle('editor-probe-streams', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return null
    const { probeMediaStreams } = await import('./editor')
    return probeMediaStreams(filePath)
  })

  ipcMain.handle('editor-pick-video-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'm4v', 'avi', 'wmv', 'ts', 'mts', 'm2ts', 'flv', '3gp', 'asf', 'f4v'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('editor-save-video', async (_, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { saveVideoEdited } = await import('./editor')
    return saveVideoEdited(params)
  })

  ipcMain.handle('editor-export-video', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const { exportVideoEdited } = await import('./editor')
    const onProgress = (percent: number) => {
      try { event.sender.send('editor-export-progress', { percent }) } catch {}
    }
    return exportVideoEdited({ ...params, onProgress })
  })

  // ── Mastering (publish-ready audio) ───────────────────────────────────────
  ipcMain.handle('master-presets', async () => {
    const { MASTER_PRESETS } = await import('./mastering')
    return MASTER_PRESETS
  })

  ipcMain.handle('master-preview', async (_, inputPath: string, presetId: string, startSec: number, durationSec: number) => {
    if (typeof inputPath !== 'string' || !isAllowedMediaPath(inputPath)) return { ok: false, error: 'invalid_path' }
    const { buildPreview, getPresetById } = await import('./mastering')
    const preset = getPresetById(presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    try {
      const previewPath = await buildPreview(inputPath, preset, Number(startSec) || 0, Number(durationSec) || 15)
      return { ok: true, previewPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-measure', async (_, inputPath: string, presetId: string) => {
    if (typeof inputPath !== 'string' || !isAllowedMediaPath(inputPath)) return { ok: false, error: 'invalid_path' }
    const { measureLoudness, getPresetById } = await import('./mastering')
    const preset = getPresetById(presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    try {
      const measurement = await measureLoudness(inputPath, preset)
      return { ok: true, measurement, targetLufs: preset.targetLufs }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-apply', async (event, params) => {
    if (!params || typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'invalid_params' }
    const p = params as {
      inputPath?:   string
      outputPath?:  string
      presetId?:    string
      measurement?: import('./mastering').LoudnessMeasurement
      jobId?:       string
    }
    if (typeof p.inputPath !== 'string' || !isAllowedMediaPath(p.inputPath)) return { ok: false, error: 'invalid_path' }
    if (typeof p.outputPath !== 'string' || !p.outputPath) return { ok: false, error: 'invalid_output_path' }
    if (typeof p.presetId !== 'string' || !p.presetId)     return { ok: false, error: 'invalid_preset' }
    if (!p.measurement || typeof p.measurement !== 'object') return { ok: false, error: 'invalid_measurement' }
    const { applyMastering, getPresetById } = await import('./mastering')
    const preset = getPresetById(p.presetId)
    if (!preset) return { ok: false, error: 'invalid_preset' }
    const onProgress = (currentSec: number, totalSec: number) => {
      try { event.sender.send('master-progress', { currentSec, totalSec }) } catch {}
    }
    try {
      await applyMastering(p.inputPath, p.outputPath, preset, p.measurement, onProgress, p.jobId)
      return { ok: true, outputPath: p.outputPath }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('master-cancel', async (_, jobId: string) => {
    if (typeof jobId !== 'string') return false
    const { cancelMastering } = await import('./mastering')
    return cancelMastering(jobId)
  })

  ipcMain.handle('list-asio-drivers', async () => {
    const { listAsioDrivers } = await import('./native-recorder')
    return listAsioDrivers()
  })

  ipcMain.handle('list-ffmpeg-audio-devices', async () => {
    const { listFfmpegDevices } = await import('./native-recorder')
    return listFfmpegDevices()
  })

  ipcMain.handle('diagnose-audio', async () => {
    const { listFfmpegDevices, listWasapiDevices, probeWasapiAvailable } = await import('./native-recorder')
    const [dshowDevices, wasapiDevices] = await Promise.all([
      listFfmpegDevices().catch(() => []),
      listWasapiDevices().catch(() => [])
    ])
    return {
      dshow: dshowDevices.map(d => d.name),
      wasapi: wasapiDevices.map(d => d.name),
      wasapiAvailable: await probeWasapiAvailable().catch(() => false)
    }
  })

  // ── Cloud backup ──────────────────────────────────────────────────────────
  ipcMain.handle('cloud-connect', async (_, service: string) => {
    const cloud = await import('./cloud')
    return cloud.connectService(service as import('../types').CloudServiceId)
  })

  ipcMain.handle('cloud-cancel-connect', async (_, service: string) => {
    const cloud = await import('./cloud')
    return cloud.cancelPending(service as import('../types').CloudServiceId)
  })

  ipcMain.handle('cloud-disconnect', async (_, service: string) => {
    const cloud = await import('./cloud')
    return cloud.disconnectService(service as import('../types').CloudServiceId)
  })

  ipcMain.handle('cloud-status', async () => {
    const cloud = await import('./cloud')
    return cloud.getStatus()
  })

  ipcMain.handle('cloud-upload-file', async (_, service: string, filePath: string, metadata?: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedMediaPath(filePath)) return { ok: false, error: 'invalid_path' }
    try {
      const cloud = await import('./cloud')
      // Manual upload goes via the queue too so it gets retry semantics
      const { enqueueUpload } = await import('./cloud/upload-queue')
      enqueueUpload({ service: service as import('../types').CloudServiceId, filePath })
      void cloud.flushQueue(mainWindow)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('cloud-list-folders', async (_, service: string, parentId?: string) => {
    try {
      const cloud = await import('./cloud')
      return cloud.listFolders(service as import('../types').CloudServiceId, parentId)
    } catch { return [] }
  })

  ipcMain.handle('cloud-set-folder', async (_, service: string, folderId: string, folderName: string, folderPath?: string) => {
    const cloud = await import('./cloud')
    return cloud.setFolder(service as import('../types').CloudServiceId, folderId, folderName, folderPath)
  })

  ipcMain.handle('cloud-queue-status', async () => {
    const q = await import('./cloud/upload-queue')
    return q.getQueueStatus()
  })

  ipcMain.handle('cloud-queue-retry', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const q = await import('./cloud/upload-queue')
    const ok = q.retryNow(id)
    if (ok) {
      const cloud = await import('./cloud')
      void cloud.flushQueue(mainWindow)
    }
    return ok
  })

  ipcMain.handle('cloud-queue-remove', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const q = await import('./cloud/upload-queue')
    return q.removeFromQueue(id)
  })

  ipcMain.handle('cloud-queue-flush', async () => {
    const cloud = await import('./cloud')
    void cloud.flushQueue(mainWindow)
    return true
  })

  // ─── YouTube publish target ──────────────────────────────────────────────
  // YouTube is separate from the cloud-backup queue — exposed only in the
  // editor's export modal for video files. Token is stored under its own key
  // in the token-store so users can connect to Drive without YouTube and
  // vice-versa.
  ipcMain.handle('youtube-connect', async () => {
    const yt = await import('./cloud/youtube')
    return yt.connect()
  })
  ipcMain.handle('youtube-disconnect', async () => {
    const yt = await import('./cloud/youtube')
    yt.disconnect()
    return { ok: true }
  })
  ipcMain.handle('youtube-status', async () => {
    const yt = await import('./cloud/youtube')
    return { connected: yt.isConnected() }
  })
  ipcMain.handle('youtube-upload', async (_, filePath: string, metadata: unknown) => {
    if (typeof filePath !== 'string' || !filePath) return { ok: false, error: 'invalid_path' }
    if (!isAllowedMediaPath(filePath))             return { ok: false, error: 'invalid_path' }
    const yt = await import('./cloud/youtube')
    const md = (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, unknown>
    const safeMeta = {
      title:         typeof md.title === 'string' ? md.title : 'SundayRec Recording',
      description:   typeof md.description === 'string' ? md.description : '',
      tags:          Array.isArray(md.tags) ? (md.tags as unknown[]).filter(s => typeof s === 'string') as string[] : undefined,
      categoryId:    typeof md.categoryId === 'string' ? md.categoryId : undefined,
      privacyStatus: md.privacyStatus === 'public' || md.privacyStatus === 'unlisted' ? md.privacyStatus : 'private' as const,
    }
    const onProgress = (uploadedBytes: number, totalBytes: number) => {
      mainWindow?.webContents.send('youtube-upload-progress', { uploadedBytes, totalBytes })
    }
    return yt.uploadVideo(filePath, safeMeta, onProgress)
  })

  // Coalesce concurrent regenerate requests per service. Two quick clicks
  // (or a publish-after-export running while auto-publish from upload-complete
  // is mid-flight) otherwise race to write podcast.xml and upload it.
  const podcastRegenInflight = new Map<string, Promise<unknown>>()
  ipcMain.handle('podcast-regenerate', async (_, service: string) => {
    if (typeof service !== 'string' || !service) {
      return { ok: false, episodeCount: 0, error: 'invalid_service' }
    }
    const existing = podcastRegenInflight.get(service)
    if (existing) return existing
    const cloud = await import('./cloud')
    const promise = cloud.regeneratePodcastFeedManual(service as import('../types').CloudServiceId)
      .finally(() => podcastRegenInflight.delete(service))
    podcastRegenInflight.set(service, promise)
    return promise
  })

  // ── Review queue (prep-and-review v5.0) ───────────────────────────────────
  ipcMain.handle('review-queue-list', async () => {
    const rq = await import('./review-queue')
    return rq.getQueue()
  })

  ipcMain.handle('review-queue-get', async (_, id: string) => {
    if (typeof id !== 'string') return null
    const rq = await import('./review-queue')
    return rq.getQueueEntry(id)
  })

  ipcMain.handle('review-queue-update-trim', async (_, id: string, trim: { startSec: number; endSec: number }) => {
    if (typeof id !== 'string') return false
    if (!trim || typeof trim.startSec !== 'number' || typeof trim.endSec !== 'number') return false
    if (trim.endSec <= trim.startSec) return false
    const rq = await import('./review-queue')
    const ok = rq.updateEntry(id, { suggestedTrim: trim })
    if (ok) try { mainWindow.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-update-master-preset', async (_, id: string, presetId: string) => {
    if (typeof id !== 'string' || typeof presetId !== 'string') return false
    const rq = await import('./review-queue')
    const ok = rq.updateEntry(id, { masterPreset: presetId })
    if (ok) try { mainWindow.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-update-jingles', async (
    _, id: string, jingles: { introPath?: string | null; outroPath?: string | null },
  ) => {
    if (typeof id !== 'string' || !jingles || typeof jingles !== 'object') return false
    const rq = await import('./review-queue')
    const patch: { introPath?: string; outroPath?: string } = {}
    if ('introPath' in jingles) patch.introPath = jingles.introPath ?? undefined
    if ('outroPath' in jingles) patch.outroPath = jingles.outroPath ?? undefined
    const ok = rq.updateEntry(id, patch)
    if (ok) try { mainWindow.webContents.send('review-queue-update', { reason: 'patched', id }) } catch {}
    return ok
  })

  ipcMain.handle('review-queue-discard', async (_, id: string) => {
    if (typeof id !== 'string') return false
    const rq = await import('./review-queue')
    rq.markDiscarded(id)
    const removed = rq.removeFromQueue(id)
    if (removed) {
      try { mainWindow.webContents.send('review-queue-update', { reason: 'discarded', id }) } catch {}
      void syncTrayReviewQueueCount()
    }
    return removed
  })

  // Tracks in-flight publishes to enforce idempotency — clicking the button
  // twice within the same prep id MUST result in a single publish.
  const publishInFlight = new Set<string>()

  ipcMain.handle('review-queue-publish', async (_, id: string) => {
    if (typeof id !== 'string') return { ok: false, error: 'invalid_id' }
    const rq = await import('./review-queue')
    const entry = rq.getQueueEntry(id)
    if (!entry) return { ok: false, error: 'not_found' }
    if (entry.prep.status === 'published' || entry.prep.publishedAt) {
      return { ok: false, error: 'already_published' }
    }
    if (publishInFlight.has(id)) return { ok: false, error: 'in_progress' }
    publishInFlight.add(id)
    try {
      // Step 1 — mark as published so a re-entrant call is rejected even
      // before the upload finishes. publishedAt is set immediately.
      rq.markPublished(id)

      // Step 2 — for v1 we treat the existing recording file as the publish
      // target. The cloud auto-upload will have run already; we just kick the
      // RSS regenerate which inserts this episode into the public feed.
      const podcast = store.get('podcast')
      if (podcast?.enabled) {
        const cloud = await import('./cloud')
        await cloud.regeneratePodcastFeedManual(podcast.service)
      }

      // Step 3 — emit renderer update so the queue card refreshes
      try { mainWindow.webContents.send('review-queue-update', { reason: 'published', id }) } catch {}

      // Step 4 — remove from queue (v1 keeps history of publication via
      // history entries already; the queue is for pending items only).
      rq.removeFromQueue(id)
      void syncTrayReviewQueueCount()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      publishInFlight.delete(id)
    }
  })
  // Note: kick off reminder processing once at startup + hourly thereafter.
  // Scheduler will be re-checked further down (in app.whenReady).
  setInterval(() => {
    import('./review-queue').then(rq => rq.processReminders(mainWindow))
      .then(() => syncTrayReviewQueueCount())
      .catch(err => console.error('[review-queue] reminders error:', (err as Error).message))
  }, 60 * 60 * 1000)
  // Also run once shortly after startup so 24 h+ items get caught.
  setTimeout(() => {
    import('./review-queue').then(rq => rq.processReminders(mainWindow))
      .then(() => syncTrayReviewQueueCount())
      .catch(() => {})
  }, 30_000)

  ipcMain.handle('cloud-is-configured', async (_, service: string) => {
    const cloud = await import('./cloud')
    return cloud.isServiceConfigured(service as import('../types').CloudServiceId)
  })

  // ── Video ─────────────────────────────────────────────────────────────────
  ipcMain.handle('list-video-devices', async () => {
    const { listVideoFfmpegDevices } = await import('./native-recorder')
    return listVideoFfmpegDevices()
  })

  ipcMain.handle('video-preview-start', async (_, opts: { videoDeviceName?: string | null; videoDeviceIndex?: number | null; videoFramerate?: number }) => {
    // macOS: request camera permission before opening device
    if (process.platform === 'darwin') {
      const granted = await systemPreferences.askForMediaAccess('camera')
      if (!granted) {
        console.warn('[video-preview] Camera permission denied by macOS')
        return false
      }
    }
    const preview = await import('./video-preview')
    return preview.startPreview(opts, mainWindow)
  })

  ipcMain.handle('video-preview-stop', async () => {
    const preview = await import('./video-preview')
    await preview.stopPreview()
  })

  ipcMain.handle('run-diagnostics', async () => {
    const settings = store.getAll()
    const { runDiagnostics } = await import('./diagnostics')
    return runDiagnostics(settings, mainWindow)
  })

  ipcMain.handle('get-logs',          () => logger.getRecentLogs(200))
  ipcMain.handle('get-log-file-path', () => logger.getLogFilePath())

}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function sendBackendWarning(win: BrowserWindow | null, msg: string, severity: 'warn' | 'error', category: 'cloud' | 'preroll' | 'wake' | 'disk' | 'device'): void {
  win?.webContents.send('backend-warning', { msg, severity, category })
  const s = store.getAll()
  if (severity === 'error') {
    if (s.emailOnError && s.emailAddress) {
      mailer.sendError(s, store.getSmtpPassword(), `[${category}] ${msg}`).catch(err =>
        console.error('[sendBackendWarning] email send failed:', (err as Error).message)
      )
    }
  }
  // Webhook is independent of email — fires on errors always, and on warnings
  // if the user has opted in. Used by churches that watch a Slack/Discord
  // channel rather than email.
  const fireWebhook = severity === 'error' || (severity === 'warn' && s.webhookOnWarn)
  if (fireWebhook && s.webhookUrl) {
    import('./webhook').then(w => w.sendWebhook(s.webhookUrl!, {
      app:       'SundayRec',
      church:    s.churchName || '',
      severity,
      category,
      message:   msg,
      timestamp: new Date().toISOString(),
    })).catch(err => console.error('[sendBackendWarning] webhook failed:', (err as Error).message))
  }
}

async function cleanupOldRecordings(): Promise<void> {
  const days = store.get('autoDeleteDays')
  if (!days || days <= 0) return
  const cutoff  = Date.now() - days * 86400000
  const saveDir = path.resolve(store.get('saveFolder') ?? app.getPath('documents'))
  const history = store.getHistory()
  const settings = store.getAll()

  // Which cloud services is the user actively backing up to? Only consider the
  // ones with both enabled=true AND autoUpload=true — those are the services
  // where the user expects the file to be safe in the cloud before we delete
  // it locally.
  const expectedCloudIds: string[] = []
  if (settings.cloudGoogleDrive?.enabled && settings.cloudGoogleDrive?.autoUpload) expectedCloudIds.push('google-drive')
  if (settings.cloudDropbox?.enabled      && settings.cloudDropbox?.autoUpload)      expectedCloudIds.push('dropbox')
  if (settings.cloudOneDrive?.enabled     && settings.cloudOneDrive?.autoUpload)     expectedCloudIds.push('onedrive')

  const remaining: typeof history = []
  let changed = false
  let skippedAwaitingCloud = 0

  for (const entry of history) {
    const baseDelete =
      entry.timestamp && entry.timestamp < cutoff &&
      entry.path && entry.status === 'ok' &&
      path.resolve(entry.path).startsWith(saveDir + path.sep)
    if (!baseDelete) { remaining.push(entry); continue }

    // Guard against deleting recordings that haven't reached the cloud yet.
    // If the user has cloud auto-upload enabled, every configured service must
    // be present in entry.cloudUploaded before we drop the local copy.
    if (expectedCloudIds.length > 0) {
      const uploaded = new Set(entry.cloudUploaded ?? [])
      const missing = expectedCloudIds.filter(id => !uploaded.has(id))
      if (missing.length > 0) {
        skippedAwaitingCloud++
        remaining.push(entry)
        continue
      }
    }

    try {
      await fs.promises.unlink(entry.path!)
      changed = true  // omit from remaining — file gone
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') { changed = true; continue }  // already gone
      remaining.push(entry)  // deletion failed — keep history entry
    }
  }
  if (changed) store.set('recordingHistory', remaining)
  if (skippedAwaitingCloud > 0) {
    console.log(`[cleanup] kept ${skippedAwaitingCloud} local recording(s) — waiting for cloud upload to complete`)
  }
}

const ALLOWED_AUDIO_EXTS = new Set([
  '.mp3', '.mp1', '.mp2', '.wav', '.flac', '.aac', '.m4a', '.m4b', '.m4r',
  '.ogg', '.oga', '.opus', '.webm', '.aiff', '.aif', '.wma', '.mka',
  '.ac3', '.eac3', '.dts', '.amr', '.3ga', '.caf', '.ape', '.wv', '.tta',
  '.mpc', '.au', '.snd', '.ra', '.ram', '.spx', '.gsm',
])
const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.m4v',
  '.avi', '.wmv', '.ts', '.mts', '.m2ts', '.flv', '.3gp', '.asf', '.f4v'])
const ALLOWED_MEDIA_EXTS = new Set([...ALLOWED_AUDIO_EXTS, ...ALLOWED_VIDEO_EXTS])

function isAllowedAudioPath(p: string): boolean {
  return ALLOWED_AUDIO_EXTS.has(path.extname(p).toLowerCase())
}

function isAllowedMediaPath(p: string): boolean {
  return ALLOWED_MEDIA_EXTS.has(path.extname(p).toLowerCase())
}

function sidecarPath(audioPath: string, suffix: string): string | null {
  const resolved = path.resolve(audioPath)
  const dir      = path.dirname(resolved)
  const base     = path.basename(resolved, path.extname(resolved))
  const result   = path.join(dir, base + suffix)
  // Ensure sidecar stays in the same directory (guards against base containing '..')
  if (path.dirname(result) !== dir) return null
  return result
}
