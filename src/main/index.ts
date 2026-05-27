import { app, BrowserWindow, ipcMain, Notification, dialog, shell, systemPreferences, powerMonitor, protocol, net, screen } from 'electron'
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
import { registerGmailIpc } from './ipc/gmail'
import { registerYouTubeIpc } from './ipc/youtube'
import { registerStreamIpc } from './ipc/stream'
import { registerCloudIpc } from './ipc/cloud'
import { registerThumbnailIpc } from './ipc/thumbnail'
import { registerWhisperIpc } from './ipc/whisper'
import { registerMasterIpc } from './ipc/master'
import { registerVideoPreviewIpc } from './ipc/video-preview'
import { registerReviewQueueIpc } from './ipc/review-queue'
import { registerEditorIpc } from './ipc/editor'
import { registerWakeIpc } from './ipc/wake'
import { registerHistoryIpc } from './ipc/history'
import { registerRecordingIpc } from './ipc/recording'
import { registerAudioDevicesIpc } from './ipc/audio-devices'
import { registerTranscriptIpc } from './ipc/transcript'
import { registerEmailWebhookIpc } from './ipc/email-webhook'
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
  // Includes saveFolder + every folder we've ever saved a recording to (from
  // recordingHistory) so external/mounted drives don't accumulate orphans.
  const editFolders = new Set<string>()
  if (saveFolder) editFolders.add(saveFolder)
  for (const entry of store.getHistory()) {
    if (entry.path) editFolders.add(path.dirname(entry.path))
  }
  import('./editor').then(e => e.cleanupEditorTempFiles(Array.from(editFolders))).then(n => {
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

  // Shared context for the per-domain IPC modules in src/main/ipc/. As we
  // split handlers out of this file (was a ~1200-line monolith), each
  // domain takes a snapshot of the same set of main-process services.
  // mainWindow is exposed via getter because crash-recovery reassigns it.
  const ipcCtx: import('./ipc/types').IpcContext = {
    get mainWindow() { return mainWindow ?? null },
    sendBackendWarning,
  }

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

  // Wake/schedule IPC — moved to ipc/wake.ts (schedule-os-wakes,
  // wake-detect-capabilities, wake-test, etc.)
  registerWakeIpc(ipcCtx)

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

  // History IPC — moved to ipc/history.ts (get/delete/clear/prune + note)
  registerHistoryIpc(ipcCtx)

  // Recording IPC — moved to ipc/recording.ts (start/stop-now, test,
  // preflight, get-next, get-disk-space)
  registerRecordingIpc(ipcCtx)

  // Email + webhook test handlers — moved to ipc/email-webhook.ts
  registerEmailWebhookIpc(ipcCtx)

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

  // Editor IPC — moved to ipc/editor.ts (read/save/pick/export/peaks/probe,
  // metadata, cuts-draft, transcript sidecars, video editor handlers).
  registerEditorIpc({
    ...ipcCtx,
    isAllowedAudioPath,
    isAllowedMediaPath,
    sidecarPath,
    trustFolder,
    setEditorVideoPath: (p: string) => { currentEditorVideoPath = p },
  })

  // Pick an audio file (for intro/outro in settings)
  ipcMain.handle('pick-audio-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a'] }]
    })
    if (r.canceled) return null
    trustFolder(r.filePaths[0])
    return r.filePaths[0]
  })

  // Drag-drop and explicit user file-picks trust the folder for this session.
  // Used by the editor when a user drops a recording from outside the standard
  // user folders — defense in depth still applies to renderer-fabricated paths.
  ipcMain.handle('register-trusted-path', (_, filePath: string) => {
    if (typeof filePath !== 'string' || !filePath) return false
    // Sanity: only honour paths to files that actually exist on disk. A
    // malicious renderer can't fabricate a /etc/passwd existence — Electron
    // runs as user, not root, and the user would have had to drag-drop
    // /etc/passwd themselves.
    try {
      if (!fs.existsSync(filePath)) return false
      trustFolder(filePath)
      return true
    } catch { return false }
  })

  // Mastering (publish-ready audio) — moved to ipc/master.ts
  registerMasterIpc({ ...ipcCtx, isAllowedMediaPath })

  // Thumbnail (podcast cover art) — moved to ipc/thumbnail.ts
  registerThumbnailIpc({ ...ipcCtx, isAllowedMediaPath })

  // Audio devices (ASIO, ffmpeg, WASAPI) — moved to ipc/audio-devices.ts
  registerAudioDevicesIpc(ipcCtx)

  // Cloud-backup handlers — moved to ipc/cloud.ts. Passes isAllowedMediaPath
  // via the extended context so the path-traversal guard stays inline.
  registerCloudIpc({ ...ipcCtx, isAllowedMediaPath })

  // YouTube connect/disconnect/status — moved to ipc/youtube.ts.
  // (youtube-upload still lives below because it depends on
  // isAllowedMediaPath which is local to this file.)
  registerYouTubeIpc(ipcCtx)

  // Gmail OAuth — moved to ipc/gmail.ts
  registerGmailIpc(ipcCtx)

  // ─── Live streaming ──────────────────────────────────────────────────────
  // Streaming + overlay handlers — moved to ipc/stream.ts
  registerStreamIpc(ipcCtx)

  // Transcript archive search — moved to ipc/transcript.ts
  registerTranscriptIpc(ipcCtx)

  // Whisper transcription — moved to ipc/whisper.ts
  registerWhisperIpc({ ...ipcCtx, isAllowedMediaPath })

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

  // Review queue (prep-and-review v5.0) — moved to ipc/review-queue.ts
  registerReviewQueueIpc({ ...ipcCtx, syncTrayReviewQueueCount })
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

  // Video preview — moved to ipc/video-preview.ts
  registerVideoPreviewIpc(ipcCtx)

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

// Roots under which user media files are allowed to live. Anything outside
// is treated as a path-traversal attempt (or a misconfigured request) and
// rejected before it can reach ffmpeg/fs.
//
// We collect roots lazily — saveFolder may not be set at startup, and the
// editor allows reading from any user-selected folder via the file picker
// (Electron's dialog already enforces user consent there). The Documents
// folder is a reasonable broad fallback for "user-selected via picker".
function getAllowedMediaRoots(): string[] {
  const roots: string[] = []
  const saveFolder = store.get('saveFolder')
  if (saveFolder) roots.push(path.resolve(saveFolder))
  // app.getPath returns absolute paths to per-user folders Electron knows are safe.
  try { roots.push(path.resolve(app.getPath('documents'))) } catch {}
  try { roots.push(path.resolve(app.getPath('downloads'))) } catch {}
  try { roots.push(path.resolve(app.getPath('desktop'))) } catch {}
  try { roots.push(path.resolve(app.getPath('music'))) } catch {}
  try { roots.push(path.resolve(app.getPath('videos'))) } catch {}
  try { roots.push(path.resolve(app.getPath('temp'))) } catch {}
  return roots
}

/** True if `child` is the same path as or a descendant of `parent`. Uses
 *  path.relative to avoid string-prefix bugs (e.g. /foo/bar matching /foo/barr). */
function isUnderRoot(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Files explicitly chosen by the user via system dialog or drag-drop are
// session-trusted. Without this, opening a recording from an external drive
// would fail silently in editor-* IPC handlers — the path-defense was meant
// to block renderer-fabricated paths, not legitimate user picks.
const sessionTrustedFolders = new Set<string>()

function trustFolder(filePath: string): void {
  try { sessionTrustedFolders.add(path.dirname(path.resolve(filePath))) } catch {}
}

function isAllowedAudioPath(p: string): boolean {
  if (!ALLOWED_AUDIO_EXTS.has(path.extname(p).toLowerCase())) return false
  const resolved = path.resolve(p)
  if (getAllowedMediaRoots().some(r => isUnderRoot(resolved, r))) return true
  return Array.from(sessionTrustedFolders).some(f => isUnderRoot(resolved, f))
}

function isAllowedMediaPath(p: string): boolean {
  if (!ALLOWED_MEDIA_EXTS.has(path.extname(p).toLowerCase())) return false
  const resolved = path.resolve(p)
  if (getAllowedMediaRoots().some(r => isUnderRoot(resolved, r))) return true
  return Array.from(sessionTrustedFolders).some(f => isUnderRoot(resolved, f))
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
