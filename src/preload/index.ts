import { contextBridge, ipcRenderer } from 'electron'

const ALLOWED_CHANNELS = [
  'recording-overlay-start',
  'recording-overlay-stop',
  'recording-finished',
  'recording-error',
  'recording-progress',
  'recording-reconnecting',
  'recording-reconnected',
  'tray-start-recording',
  'tray-stop-recording',
  'update-available',
  'update-not-available',
  'update-checking',
  'update-download-progress',
  'update-downloaded',
  'update-error',
  'wake-schedule-result',
  'editor-export-progress',
  'cloud-upload-progress',
  'cloud-upload-done',
  'video-preview-frame',
  'video-preview-stopped',
  'video-preview-meta',
  'video-progress',
  'video-capture-error',
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
  testEmail:        ()       => ipcRenderer.invoke('test-email'),
  updateHistoryNote: (ts: number, note: string) => ipcRenderer.invoke('update-history-note', ts, note),
  getAppVersion:    ()       => ipcRenderer.invoke('get-app-version'),

  editorReadFile:         (filePath: string) => ipcRenderer.invoke('editor-read-file', filePath),
  editorSaveFile:         (params: unknown)  => ipcRenderer.invoke('editor-save-file', params),
  editorPickFile:         ()                 => ipcRenderer.invoke('editor-pick-file'),
  editorExportFile:       (params: unknown)  => ipcRenderer.invoke('editor-export-file', params),
  editorPickOutputFolder: ()                 => ipcRenderer.invoke('editor-pick-output-folder'),
  editorReadMeta:         (filePath: string) => ipcRenderer.invoke('editor-read-meta', filePath),
  editorSaveMeta:         (filePath: string, metadata: unknown) => ipcRenderer.invoke('editor-save-meta', filePath, metadata),
  editorDetectSegments:   (filePath: string) => ipcRenderer.invoke('editor-detect-segments', filePath),

  editorSetVideoPath:      (filePath: string) => ipcRenderer.invoke('editor-set-video-path', filePath),
  editorExtractAudioPeaks: (filePath: string) => ipcRenderer.invoke('editor-extract-audio-peaks', filePath),
  editorPickVideoFile:     ()                 => ipcRenderer.invoke('editor-pick-video-file'),
  editorSaveVideo:         (params: unknown)  => ipcRenderer.invoke('editor-save-video', params),
  editorExportVideo:       (params: unknown)  => ipcRenderer.invoke('editor-export-video', params),

  pickAudioFile: () => ipcRenderer.invoke('pick-audio-file'),

  listAsioDrivers: () => ipcRenderer.invoke('list-asio-drivers'),
  listFfmpegAudioDevices: () => ipcRenderer.invoke('list-ffmpeg-audio-devices'),

  cloudConnect:     (service: string) => ipcRenderer.invoke('cloud-connect', service),
  cloudDisconnect:  (service: string) => ipcRenderer.invoke('cloud-disconnect', service),
  cloudStatus:      ()                => ipcRenderer.invoke('cloud-status'),
  cloudUploadFile:  (service: string, filePath: string, metadata?: unknown) => ipcRenderer.invoke('cloud-upload-file', service, filePath, metadata),
  cloudListFolders: (service: string, parentId?: string) => ipcRenderer.invoke('cloud-list-folders', service, parentId),
  cloudSetFolder:   (service: string, folderId: string, folderName: string, folderPath?: string) => ipcRenderer.invoke('cloud-set-folder', service, folderId, folderName, folderPath),

  checkForUpdates: ()        => ipcRenderer.invoke('check-for-updates'),
  installUpdate:   ()        => ipcRenderer.invoke('install-update'),

  scheduleOsWakes:      ()   => ipcRenderer.invoke('schedule-os-wakes'),
  scheduleOsWakesAdmin: ()   => ipcRenderer.invoke('schedule-os-wakes-admin'),
  getSleepConfig:       ()   => ipcRenderer.invoke('get-sleep-config'),
  fixMacSleep:          ()   => ipcRenderer.invoke('fix-mac-sleep'),
  fixWinWakeTimers:     ()   => ipcRenderer.invoke('fix-win-wake-timers'),

  notifyError:      (data: unknown) => ipcRenderer.send('recording-error', data),
  notifyWeakSignal: () => ipcRenderer.send('weak-signal'),

  listVideoDevices:  () => ipcRenderer.invoke('list-video-devices'),
  videoPreviewStart: (opts: unknown) => ipcRenderer.invoke('video-preview-start', opts),
  videoPreviewStop:  () => ipcRenderer.invoke('video-preview-stop'),

  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!ALLOWED_CHANNELS.includes(channel as AllowedChannel)) return
    const sub = (_: Electron.IpcRendererEvent, ...args: unknown[]) => fn(...args)
    ipcRenderer.on(channel, sub)
    return () => ipcRenderer.removeListener(channel, sub)
  }
})
