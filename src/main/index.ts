import { app, BrowserWindow, ipcMain, Notification, dialog, shell, systemPreferences, powerMonitor } from 'electron'
import path from 'path'
import fs from 'fs'
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

app.setName('SundayRec')

if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
  app.dock.setIcon(path.join(__dirname, '../../assets/icon.png'))
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
    const status = await systemPreferences.askForMediaAccess('microphone')
    if (!status) {
      console.warn('[SundayRec] Microphone access denied')
      // Show once per launch — user must fix in System Settings before recording works
      const MIC_DENIED: Record<string, [string, string, string]> = {
        no: ['Mikrofontilgang nektet', 'SundayRec trenger tilgang til mikrofon for å ta opp. Åpne Systeminnstillinger → Personvern & sikkerhet → Mikrofon og aktiver SundayRec.', 'Åpne Systeminnstillinger'],
        en: ['Microphone access denied', 'SundayRec needs microphone access to record. Open System Settings → Privacy & Security → Microphone and enable SundayRec.', 'Open System Settings'],
        de: ['Mikrofonzugriff verweigert', 'SundayRec benötigt Mikrofonzugriff. Öffnen Sie Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon.', 'Systemeinstellungen öffnen'],
        sv: ['Mikrofonåtkomst nekad', 'SundayRec behöver mikrofonåtkomst. Öppna Systeminställningar → Integritet & säkerhet → Mikrofon.', 'Öppna Systeminställningar'],
        da: ['Mikrofonadgang nægtet', 'SundayRec skal bruge mikrofonadgang. Åbn Systemindstillinger → Privatliv & sikkerhed → Mikrofon.', 'Åbn Systemindstillinger'],
        pl: ['Odmowa dostępu do mikrofonu', 'SundayRec potrzebuje dostępu do mikrofonu. Otwórz Ustawienia systemowe → Prywatność i bezpieczeństwo → Mikrofon.', 'Otwórz ustawienia systemowe'],
        fr: ['Accès au microphone refusé', "SundayRec a besoin d'accéder au microphone. Ouvrez Réglages système → Confidentialité et sécurité → Microphone.", 'Ouvrir les Réglages système'],
      }
      const lang = store.get('language') ?? 'en'
      const [title, detail, openBtn] = MIC_DENIED[lang] ?? MIC_DENIED.en
      const { response } = await dialog.showMessageBox({
        type: 'warning', buttons: [openBtn, 'OK'], defaultId: 0,
        title, message: title, detail
      })
      if (response === 0) {
        shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
      }
    }
  }

  // Register custom URL scheme for OAuth callbacks (sundayrec://oauth/...)
  app.setAsDefaultProtocolClient('sundayrec')

  createWindow()
  tray.create(mainWindow)
  recorder.recoverCrashedSession()
  scheduler.init(mainWindow)
  updater.init(mainWindow)
  updater.check()
  setupIPC()

  // Restart pre-roll after each session ends (manual or scheduled)
  recorder.setSessionEndCallback(() => {
    const s = store.getAll()
    if ((s.preRollSeconds ?? 0) > 0 && !recorder.isActive()) {
      setTimeout(() => {
        preroll.start(s).catch(err => console.error('[preroll] post-session restart error:', err))
      }, 1000) // brief pause for device release
    }
  })

  // Start pre-roll if enabled at launch
  const launchSettings = store.getAll()
  if ((launchSettings.preRollSeconds ?? 0) > 0) {
    preroll.start(launchSettings).catch(err => console.error('[preroll] launch start error:', err))
  }
  cleanupOldRecordings()
  store.pruneHistory()
  const initialUpcoming = scheduler.getUpcomingDates()
  wake.reschedule(initialUpcoming, mainWindow).catch(err => console.error('[wake] reschedule error:', err))
  tray.setNextRecording(initialUpcoming[0] ?? null)

  // On wake from sleep: check for missed recordings, refresh OS wake list, notify user
  powerMonitor.on('resume', () => {
    scheduler.checkMissedRecordings()
    // Restart pre-roll after wake (it stops when the Mac sleeps)
    if (!recorder.isActive()) {
      const wakeSettings = store.getAll()
      if ((wakeSettings.preRollSeconds ?? 0) > 0) {
        setTimeout(() => {
          preroll.start(wakeSettings).catch(err => console.error('[preroll] wake restart error:', err))
        }, 2000)
      }
    }
    const upcoming = scheduler.getUpcomingDates()
    wake.reschedule(upcoming, mainWindow).catch(err => console.error('[wake] resume reschedule error:', err))
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
    wake.reschedule(upcoming, mainWindow).catch(err => console.error('[wake] periodic reschedule error:', err))
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

app.on('second-instance', (_event, _argv) => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus() }
})

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[SundayRec] Renderer process gone:', details.reason, 'exitCode:', details.exitCode)
  // Stop pre-roll first so the audio device is released
  preroll.stop().catch(() => {})
  if (recorder.isActive()) {
    console.error('[SundayRec] Recording active during renderer crash — attempting emergency stop')
    recorder.stopSession()
  }
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
    forceQuit = true
    quitting  = true
    setImmediate(() => {
      updater.doInstall()
      // Fallback: if quitAndInstall hasn't exited in 3s, force relaunch
      setTimeout(() => { app.relaunch(); app.exit(0) }, 3000)
    })
  })

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
    wake.reschedule(upcomingAfterSave, mainWindow).catch(err => console.error('[wake] reschedule error:', err))
    tray.setNextRecording(upcomingAfterSave[0] ?? null)
    // Sync pre-roll state with new settings (stop must complete before start)
    if (!recorder.isActive()) {
      const newPreRollSec = (settings as { preRollSeconds?: number }).preRollSeconds ?? 0
      preroll.stop().then(() => {
        if (newPreRollSec > 0) return preroll.start(store.getAll())
      }).catch(err => console.error('[preroll] settings-change restart error:', err))
    }
    return true
  })

  ipcMain.handle('schedule-os-wakes',       () => wake.reschedule(scheduler.getUpcomingDates(), mainWindow, false))
  ipcMain.handle('schedule-os-wakes-admin', () => wake.reschedule(scheduler.getUpcomingDates(), mainWindow, true))
  ipcMain.handle('get-sleep-config',        () => wake.getSleepConfig())
  ipcMain.handle('fix-mac-sleep',           () => wake.fixMacSleep())
  ipcMain.handle('fix-win-wake-timers',     () => wake.fixWinWakeTimers())

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
    const settings = { ...store.getAll(), ...(opts ?? {}) }
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
    try {
      const s = store.getAll()
      await mailer.sendTest(s, store.getSmtpPassword())
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('update-history-note', (_, ts: number, note: string) => {
    if (typeof ts !== 'number' || typeof note !== 'string') return
    store.updateHistoryNote(ts, note)
  })

  ipcMain.handle('editor-read-file', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return null
    try { return await fs.promises.readFile(filePath) } catch { return null }
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
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'webm'] }]
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
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return null
    const metaPath = sidecarPath(filePath, '.meta.json')
    if (!metaPath) return null
    try {
      const raw = await fs.promises.readFile(metaPath, 'utf8')
      return JSON.parse(raw)
    } catch { return null }
  })

  ipcMain.handle('editor-save-meta', async (_, filePath: string, metadata: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return false
    const metaPath = sidecarPath(filePath, '.meta.json')
    if (!metaPath) return false
    try {
      await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8')
      return true
    } catch { return false }
  })

  ipcMain.handle('editor-detect-segments', async (_, filePath: string) => {
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return []
    const { detectSegments } = await import('./editor')
    return detectSegments(filePath)
  })

  ipcMain.handle('list-asio-drivers', async () => {
    const { listAsioDrivers } = await import('./native-recorder')
    return listAsioDrivers()
  })

  // ── Cloud backup ──────────────────────────────────────────────────────────
  ipcMain.handle('cloud-connect', async (_, service: string) => {
    const cloud = await import('./cloud')
    return cloud.connectService(service as import('../types').CloudServiceId)
  })

  ipcMain.handle('cloud-disconnect', (_, service: string) => {
    import('./cloud').then(c => c.disconnectService(service as import('../types').CloudServiceId))
  })

  ipcMain.handle('cloud-status', async () => {
    const cloud = await import('./cloud')
    return cloud.getStatus()
  })

  ipcMain.handle('cloud-upload-file', async (_, service: string, filePath: string, metadata?: unknown) => {
    if (typeof filePath !== 'string' || !isAllowedAudioPath(filePath)) return { ok: false, error: 'invalid_path' }
    try {
      const cloud = await import('./cloud')
      await cloud.uploadFile(service as import('../types').CloudServiceId, filePath, metadata as import('../types').RecordingMetadata | undefined)
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

  ipcMain.handle('cloud-set-folder', (_, service: string, folderId: string, folderName: string, folderPath?: string) => {
    import('./cloud').then(c => c.setFolder(service as import('../types').CloudServiceId, folderId, folderName, folderPath))
  })

}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

async function cleanupOldRecordings(): Promise<void> {
  const days = store.get('autoDeleteDays')
  if (!days || days <= 0) return
  const cutoff   = Date.now() - days * 86400000
  const saveDir  = path.resolve(store.get('saveFolder') ?? app.getPath('documents'))
  const history  = store.getHistory()
  const toDelete: typeof history = []
  const remaining = history.filter(entry => {
    if (
      entry.timestamp && entry.timestamp < cutoff &&
      entry.path && entry.status === 'ok' &&
      path.resolve(entry.path).startsWith(saveDir + path.sep)
    ) {
      toDelete.push(entry)
      return false
    }
    return true
  })
  if (!toDelete.length) return
  store.set('recordingHistory', remaining)
  for (const entry of toDelete) {
    try { await fs.promises.unlink(entry.path!) } catch { /* already gone */ }
  }
}

const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.webm'])

function isAllowedAudioPath(p: string): boolean {
  return ALLOWED_AUDIO_EXTS.has(path.extname(p).toLowerCase())
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
