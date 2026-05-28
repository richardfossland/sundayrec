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
  'tray-open-review-queue',
  'tray-run-preflight',
  'update-available',
  'update-not-available',
  'update-checking',
  'update-download-progress',
  'update-downloaded',
  'update-error',
  'wake-schedule-result',
  'editor-export-progress',
  'master-progress',
  'cloud-upload-progress',
  'cloud-upload-done',
  'cloud-queue-update',
  'video-preview-frame',
  'video-preview-stopped',
  'video-preview-meta',
  'video-progress',
  'video-capture-error',
  'email-test-status',
  'backend-warning',
  'test-wake-progress',
  'review-queue-update',
  'youtube-upload-progress',
  'whisper-progress',
  'whisper-model-progress',
  'stream-stats',
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
  runTestRecording:  ()      => ipcRenderer.invoke('run-test-recording'),
  runPreflight:      ()      => ipcRenderer.invoke('run-preflight'),
  testWebhook:       ()      => ipcRenderer.invoke('test-webhook'),

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
  editorCancelExport:     (jobId: string)    => ipcRenderer.invoke('editor-cancel-export', jobId),
  editorPickOutputFolder: ()                 => ipcRenderer.invoke('editor-pick-output-folder'),
  editorReadMeta:         (filePath: string) => ipcRenderer.invoke('editor-read-meta', filePath),
  editorSaveMeta:         (filePath: string, metadata: unknown) => ipcRenderer.invoke('editor-save-meta', filePath, metadata),
  editorReadCutsDraft:    (filePath: string) => ipcRenderer.invoke('editor-read-cuts-draft', filePath),
  editorSaveCutsDraft:    (filePath: string, cuts: unknown) => ipcRenderer.invoke('editor-save-cuts-draft', filePath, cuts),
  editorDeleteCutsDraft:  (filePath: string) => ipcRenderer.invoke('editor-delete-cuts-draft', filePath),
  editorDetectSegments:   (filePath: string) => ipcRenderer.invoke('editor-detect-segments', filePath),

  editorSetVideoPath:      (filePath: string) => ipcRenderer.invoke('editor-set-video-path', filePath),
  editorExtractAudioPeaks: (filePath: string) => ipcRenderer.invoke('editor-extract-audio-peaks', filePath),
  editorPickVideoFile:     ()                 => ipcRenderer.invoke('editor-pick-video-file'),
  editorSaveVideo:         (params: unknown)  => ipcRenderer.invoke('editor-save-video', params),
  editorExportVideo:       (params: unknown)  => ipcRenderer.invoke('editor-export-video', params),
  editorProbeStreams:      (filePath: string) => ipcRenderer.invoke('editor-probe-streams', filePath),

  // Mastering (publishable-ready audio)
  masterPresets:  () => ipcRenderer.invoke('master-presets'),
  masterPreview:  (inputPath: string, presetId: string, startSec: number, durationSec: number) =>
                    ipcRenderer.invoke('master-preview', inputPath, presetId, startSec, durationSec),
  masterMeasure:  (inputPath: string, presetId: string) => ipcRenderer.invoke('master-measure', inputPath, presetId),
  masterApply:    (params: unknown)                     => ipcRenderer.invoke('master-apply', params),
  masterCancel:   (jobId: string)                       => ipcRenderer.invoke('master-cancel', jobId),

  pickAudioFile: () => ipcRenderer.invoke('pick-audio-file'),

  // Thumbnail (podcast cover art)
  thumbnailSetDefault:    (sourcePath?: string)               => ipcRenderer.invoke('thumbnail:set-default', sourcePath),
  thumbnailClearDefault:  ()                                  => ipcRenderer.invoke('thumbnail:clear-default'),
  thumbnailSetEpisode:    (recordingPath: string, sourcePath?: string) =>
                                                                ipcRenderer.invoke('thumbnail:set-episode', recordingPath, sourcePath),
  thumbnailClearEpisode:  (recordingPath: string)             => ipcRenderer.invoke('thumbnail:clear-episode', recordingPath),
  thumbnailResolve:       (recordingPath: string)             => ipcRenderer.invoke('thumbnail:resolve', recordingPath),
  thumbnailGetDefaultInfo:()                                  => ipcRenderer.invoke('thumbnail:get-default-info'),

  listAsioDrivers: () => ipcRenderer.invoke('list-asio-drivers'),
  listFfmpegAudioDevices: () => ipcRenderer.invoke('list-ffmpeg-audio-devices'),
  diagnoseAudio: (): Promise<{ dshow: string[]; wasapi: string[]; wasapiAvailable: boolean }> => ipcRenderer.invoke('diagnose-audio'),

  cloudConnect:        (service: string) => ipcRenderer.invoke('cloud-connect', service),
  cloudCancelConnect:  (service: string) => ipcRenderer.invoke('cloud-cancel-connect', service),
  cloudDisconnect:     (service: string) => ipcRenderer.invoke('cloud-disconnect', service),
  cloudStatus:         ()                => ipcRenderer.invoke('cloud-status'),
  cloudUploadFile:     (service: string, filePath: string, metadata?: unknown) => ipcRenderer.invoke('cloud-upload-file', service, filePath, metadata),
  cloudListFolders:    (service: string, parentId?: string) => ipcRenderer.invoke('cloud-list-folders', service, parentId),
  cloudSetFolder:      (service: string, folderId: string, folderName: string, folderPath?: string) => ipcRenderer.invoke('cloud-set-folder', service, folderId, folderName, folderPath),
  cloudIsConfigured:   (service: string) => ipcRenderer.invoke('cloud-is-configured', service),
  cloudQueueStatus:    ()                => ipcRenderer.invoke('cloud-queue-status'),
  cloudQueueRetry:     (id: string)      => ipcRenderer.invoke('cloud-queue-retry', id),
  cloudQueueRemove:    (id: string)      => ipcRenderer.invoke('cloud-queue-remove', id),
  cloudQueueFlush:     ()                => ipcRenderer.invoke('cloud-queue-flush'),
  podcastRegenerate:   (service: string) => ipcRenderer.invoke('podcast-regenerate', service),

  registerTrustedPath: (filePath: string) => ipcRenderer.invoke('register-trusted-path', filePath),

  gmailConnect:        ()                             => ipcRenderer.invoke('gmail-connect'),
  gmailDisconnect:     ()                             => ipcRenderer.invoke('gmail-disconnect'),
  gmailStatus:         ()                             => ipcRenderer.invoke('gmail-status'),

  streamStatus:        ()                             => ipcRenderer.invoke('stream-status'),
  streamStart:         (params: unknown)              => ipcRenderer.invoke('stream-start', params),
  streamStop:          ()                             => ipcRenderer.invoke('stream-stop'),
  streamPreviewPath:   ()                             => ipcRenderer.invoke('stream-preview-path'),
  streamSetKey:        (destId: string, key: string)  => ipcRenderer.invoke('stream-set-key', destId, key),
  streamDeleteKey:     (destId: string)               => ipcRenderer.invoke('stream-delete-key', destId),

  overlayListScreens:    ()                           => ipcRenderer.invoke('overlay-list-screens'),
  overlayListNdiSources: ()                           => ipcRenderer.invoke('overlay-list-ndi-sources'),
  overlayPickImage:      ()                           => ipcRenderer.invoke('overlay-pick-image'),

  transcriptListAll:       ()                       => ipcRenderer.invoke('transcript-list-all'),
  transcriptResolveSource: (basePath: string)       => ipcRenderer.invoke('transcript-resolve-source', basePath),

  editorReadTranscript:    (filePath: string)       => ipcRenderer.invoke('editor-read-transcript', filePath),
  editorWriteTranscript:   (filePath: string, t: unknown) => ipcRenderer.invoke('editor-write-transcript', filePath, t),
  editorDeleteTranscript:  (filePath: string)       => ipcRenderer.invoke('editor-delete-transcript', filePath),

  whisperStatus:           ()                       => ipcRenderer.invoke('whisper-status'),
  whisperDownloadModel:    (modelId: string)        => ipcRenderer.invoke('whisper-download-model', modelId),
  whisperCancelDownload:   (modelId: string)        => ipcRenderer.invoke('whisper-cancel-download', modelId),
  whisperDeleteModel:      (modelId: string)        => ipcRenderer.invoke('whisper-delete-model', modelId),
  whisperTranscribe:       (params: unknown)        => ipcRenderer.invoke('whisper-transcribe', params),
  whisperCancelTranscribe: (jobId: string)          => ipcRenderer.invoke('whisper-cancel-transcribe', jobId),

  youtubeConnect:      ()                  => ipcRenderer.invoke('youtube-connect'),
  youtubeDisconnect:   ()                  => ipcRenderer.invoke('youtube-disconnect'),
  youtubeStatus:       ()                  => ipcRenderer.invoke('youtube-status'),
  youtubeUpload:       (filePath: string, metadata: unknown) => ipcRenderer.invoke('youtube-upload', filePath, metadata),

  // Review queue (prep-and-review v5.0)
  reviewQueueList:    () => ipcRenderer.invoke('review-queue-list'),
  reviewQueueGet:     (id: string) => ipcRenderer.invoke('review-queue-get', id),
  reviewQueuePublish: (id: string) => ipcRenderer.invoke('review-queue-publish', id),
  reviewQueueDiscard: (id: string) => ipcRenderer.invoke('review-queue-discard', id),
  reviewQueueUpdateTrim: (id: string, trim: { startSec: number; endSec: number }) =>
    ipcRenderer.invoke('review-queue-update-trim', id, trim),
  reviewQueueUpdateMasterPreset: (id: string, presetId: string) =>
    ipcRenderer.invoke('review-queue-update-master-preset', id, presetId),
  reviewQueueUpdateJingles: (id: string, jingles: { introPath?: string | null; outroPath?: string | null }) =>
    ipcRenderer.invoke('review-queue-update-jingles', id, jingles),

  checkForUpdates: ()        => ipcRenderer.invoke('check-for-updates'),
  installUpdate:   ()        => ipcRenderer.invoke('install-update'),
  getPlatform:     ()        => ipcRenderer.invoke('get-platform'),

  scheduleOsWakes:      ()   => ipcRenderer.invoke('schedule-os-wakes'),
  scheduleOsWakesAdmin: ()   => ipcRenderer.invoke('schedule-os-wakes-admin'),
  getSleepConfig:       ()   => ipcRenderer.invoke('get-sleep-config'),
  fixMacSleep:          ()   => ipcRenderer.invoke('fix-mac-sleep'),
  fixWinWakeTimers:     ()   => ipcRenderer.invoke('fix-win-wake-timers'),

  // Wake verification + test-wake
  wakeDetectCapabilities: () => ipcRenderer.invoke('wake-detect-capabilities'),
  wakeVerifyScheduled:    () => ipcRenderer.invoke('wake-verify-scheduled'),
  wakeCheckPower:         () => ipcRenderer.invoke('wake-check-power'),
  wakeCheckStandby:       () => ipcRenderer.invoke('wake-check-standby'),
  wakeTest:               (secondsAhead?: number) => ipcRenderer.invoke('wake-test', secondsAhead),
  wakeCancelTest:         () => ipcRenderer.invoke('wake-cancel-test'),
  wakeFailureHistory:     () => ipcRenderer.invoke('wake-failure-history'),
  wakeClearFailureHistory:() => ipcRenderer.invoke('wake-clear-failure-history'),

  notifyError:      (data: unknown) => ipcRenderer.send('recording-error', data),
  notifyWeakSignal: () => ipcRenderer.send('weak-signal'),

  listVideoDevices:  () => ipcRenderer.invoke('list-video-devices'),
  videoPreviewStart: (opts: unknown) => ipcRenderer.invoke('video-preview-start', opts),
  videoPreviewStop:  () => ipcRenderer.invoke('video-preview-stop'),

  runDiagnostics: (): Promise<{ markdown: string; savedTo: string | null; clipboardOk: boolean; captureOk: boolean; videoOk: boolean | null }> => ipcRenderer.invoke('run-diagnostics'),

  getLogs:        (): Promise<unknown[]> => ipcRenderer.invoke('get-logs'),
  getLogFilePath: (): Promise<string | null> => ipcRenderer.invoke('get-log-file-path'),

  // Sunday-suite integrations (opt-in; inert until enabled)
  getIntegrationSettings: () => ipcRenderer.invoke('integrations-get-settings'),
  setIntegrationSettings: (patch: unknown) => ipcRenderer.invoke('integrations-set-settings', patch),
  getServiceLink:         (recordingPath: string) => ipcRenderer.invoke('integrations-get-service-link', recordingPath),
  verbatimSend:           (opts: unknown) => ipcRenderer.invoke('integrations-verbatim-send', opts),
  verbatimImport:         (recordingPath: string, subtitlePath: string, language?: string) => ipcRenderer.invoke('integrations-verbatim-import', recordingPath, subtitlePath, language),
  stageImport:            (recordingPath: string, manifestPath: string, wasStreamed?: boolean) => ipcRenderer.invoke('integrations-stage-import', recordingPath, manifestPath, wasStreamed),
  songSetApiKey:          (key: string) => ipcRenderer.invoke('integrations-song-set-apikey', key),
  songHasApiKey:          () => ipcRenderer.invoke('integrations-song-has-apikey'),
  songSubmitUsage:        (recordingPath: string) => ipcRenderer.invoke('integrations-song-submit-usage', recordingPath),

  on: (channel: string, fn: (...args: unknown[]) => void) => {
    if (!ALLOWED_CHANNELS.includes(channel as AllowedChannel)) return
    const sub = (_: Electron.IpcRendererEvent, ...args: unknown[]) => fn(...args)
    ipcRenderer.on(channel, sub)
    return () => ipcRenderer.removeListener(channel, sub)
  }
})
