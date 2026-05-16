import { contextBridge, ipcRenderer } from 'electron'

const ALLOWED_CHANNELS = [
  'schedule-start-recording',
  'schedule-stop-recording',
  'stop-media-recorder',
  'recording-finished',
  'recording-error',
  'tray-start-recording',
  'tray-stop-recording',
  'update-available',
  'update-not-available',
  'update-checking',
  'update-download-progress',
  'update-downloaded',
  'update-error',
  'wake-schedule-result'
] as const

type AllowedChannel = typeof ALLOWED_CHANNELS[number]

contextBridge.exposeInMainWorld('api', {
  getSettings:    ()         => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s: unknown) => ipcRenderer.invoke('save-settings', s),

  exportProfile:  ()         => ipcRenderer.invoke('export-profile'),
  importProfile:  (json: string) => ipcRenderer.invoke('import-profile', json),
  resetSettings:  ()         => ipcRenderer.invoke('reset-settings'),

  getNextRecording: ()       => ipcRenderer.invoke('get-next-recording'),

  getHistory:          ()    => ipcRenderer.invoke('get-history'),
  deleteHistoryEntry:  (ts: number) => ipcRenderer.invoke('delete-history-entry', ts),
  clearHistory:        ()    => ipcRenderer.invoke('clear-history'),
  pruneHistory:        ()    => ipcRenderer.invoke('prune-history'),

  getDiskSpace:   ()         => ipcRenderer.invoke('get-disk-space'),

  startRecordingNow: (opts: unknown) => ipcRenderer.invoke('start-recording-now', opts),
  stopRecordingNow:  ()      => ipcRenderer.invoke('stop-recording-now'),

  pickFolder:     ()         => ipcRenderer.invoke('pick-folder'),
  openFolder:     (p: string) => ipcRenderer.invoke('open-folder', p),
  revealFile:     (p: string) => ipcRenderer.invoke('reveal-file', p),

  clearSmtpPassword: ()      => ipcRenderer.invoke('clear-smtp-password'),
  getAppVersion:    ()       => ipcRenderer.invoke('get-app-version'),

  checkForUpdates: ()        => ipcRenderer.invoke('check-for-updates'),
  installUpdate:   ()        => ipcRenderer.invoke('install-update'),

  scheduleOsWakes:      ()   => ipcRenderer.invoke('schedule-os-wakes'),
  scheduleOsWakesAdmin: ()   => ipcRenderer.invoke('schedule-os-wakes-admin'),

  sendAudioChunk: (buf: ArrayBuffer) => ipcRenderer.send('audio-chunk', buf),
  confirmStart:   (data: unknown)    => ipcRenderer.send('recording-confirmed-start', data),
  chunksDone:     ()                 => ipcRenderer.send('recording-chunks-done'),

  notifyStarted: (data: unknown) => ipcRenderer.send('recording-started', data),
  notifyStopped: (entry: unknown) => ipcRenderer.send('recording-stopped', entry),
  notifyError:   (data: unknown) => ipcRenderer.send('recording-error', data),

  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!ALLOWED_CHANNELS.includes(channel as AllowedChannel)) return
    const sub = (_: Electron.IpcRendererEvent, ...args: unknown[]) => fn(...args)
    ipcRenderer.on(channel, sub)
    return () => ipcRenderer.removeListener(channel, sub)
  }
})
