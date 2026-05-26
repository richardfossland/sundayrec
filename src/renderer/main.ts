import { loadLocale, setApplyHook } from './i18n'
import { updateSettings } from './state'
import type { Settings } from '../types'

import { setupHome, refreshHome, loadRecentHistory, startVideoPreview, stopVideoPreview, loadVideoInfoStrip, deactivateHome } from './pages/home'
import { stopVU, setupClipReset } from './pages/home-vu'
import { setupAudioPage, applyAudioSettingsToUI, renderDeviceList, stopMonitoring } from './pages/audio-page'
import { setupSchedulePage, applyScheduleSettingsToUI, renderDayPickers, renderSlotsList } from './pages/schedule-page'
import { setupCalendarPage, renderCalendar, renderPlannedList } from './pages/calendar-page'
import { setupFilesPage, applyFilesSettingsToUI, updateFilenamePreview, toggleMp3Quality } from './pages/files-page'
import { setupGeneralPage, applyGeneralSettingsToUI } from './pages/general-page'
import { setupRecording } from './pages/recording'
import { setupEditorPage, openEditorWithFile, openEditorReviewMode, deactivateEditor } from './pages/editor-page'
import { checkAndShowOnboarding, showOnboarding } from './pages/onboarding'
import { setupVideoPage, applyVideoSettingsToUI, refreshVideoDevices } from './pages/video-page'
import { setupPublishPage, applyPublishSettingsToUI } from './pages/publish-page'

// Expose globals that sub-modules need
declare global {
  interface Window {
    showPage: (id: string) => void
    loadSettings: () => Promise<void>
    showOnboarding: () => void
    __isRecording: boolean
    openEditorWithFile: (filePath: string) => void
    openEditorReviewMode?: (prepId: string, filePath: string) => void
    api: {
      getSettings:         () => Promise<Settings>
      saveSettings:        (s: Settings) => Promise<boolean>
      exportProfile:       () => Promise<unknown>
      importProfile:       (json: string) => Promise<boolean>
      resetSettings:       () => Promise<boolean>
      getNextRecording:    () => Promise<{ date: string } | null>
      getHistory:          () => Promise<unknown[]>
      deleteHistoryEntry:  (ts: number) => Promise<void>
      clearHistory:        () => Promise<void>
      pruneHistory:        () => Promise<number>
      getDiskSpace:        () => Promise<{ freeBytes: number | null }>
      startRecordingNow:   (opts: unknown) => Promise<{ ok?: boolean; error?: string }>
      stopRecordingNow:    () => Promise<boolean>
      runTestRecording:    () => Promise<{ ok: boolean; signal?: 'silent' | 'low' | 'normal'; rmsDb?: number; error?: string }>
      runPreflight:        () => Promise<{ findings: { severity: 'warn' | 'error'; category: string; message: string }[] }>
      testWebhook:         () => Promise<{ ok: boolean; error?: string }>
      pickFolder:          () => Promise<string | null>
      openFolder:          (p: string) => Promise<void>
      revealFile:          (p: string) => Promise<void>
      clearSmtpPassword:   () => Promise<boolean>
      testEmail:           () => Promise<{ ok: boolean; error?: string }>
      updateHistoryNote:   (ts: number, note: string) => Promise<void>
      getAppVersion:       () => Promise<string>
      checkForUpdates:     () => Promise<void>
      installUpdate:       () => void
      getPlatform:         () => Promise<string>
      scheduleOsWakes:      () => Promise<unknown>
      scheduleOsWakesAdmin: () => Promise<unknown>
      getSleepConfig:       () => Promise<unknown>
      fixMacSleep:          () => Promise<{ ok: boolean; message?: string }>
      fixWinWakeTimers:     () => Promise<{ ok: boolean; message?: string }>
      wakeDetectCapabilities: () => Promise<{
        platform: 'mac-arm' | 'mac-intel' | 'win' | 'linux' | 'other'
        canWakeFromSleep: boolean
        canWakeFromOff:   boolean
        needsAdmin:       boolean
        knownIssues:      string[]
        recommendations:  string[]
      }>
      wakeVerifyScheduled: () => Promise<{
        capabilities: {
          platform: 'mac-arm' | 'mac-intel' | 'win' | 'linux' | 'other'
          canWakeFromSleep: boolean
          canWakeFromOff:   boolean
          needsAdmin:       boolean
          knownIssues:      string[]
          recommendations:  string[]
        }
        expectedWakes:  string[]
        observedWakes:  { scheduledAt: string; ownerLabel: string }[]
        hasMismatch:    boolean
        onBattery:      boolean | null
        standbyEnabled: boolean | null
      }>
      wakeCheckPower:   () => Promise<boolean | null>
      wakeCheckStandby: () => Promise<boolean | null>
      wakeTest:         (secondsAhead?: number) => Promise<{
        ok: boolean
        reason?: 'no_sleep' | 'no_resume' | 'too_late' | 'cancelled' | 'unsupported' | 'error'
        message?:      string
        scheduledFor?: string
        actualAt?:     string
        deltaSec?:     number
      }>
      wakeCancelTest:          () => Promise<boolean>
      wakeFailureHistory:      () => Promise<{
        timestamp: number; scheduledAt: string; kind: 'missed' | 'test_ok' | 'test_fail';
        label: string; reason?: string; deltaSec?: number
      }[]>
      wakeClearFailureHistory: () => Promise<boolean>
      notifyError:         (data: unknown) => void
      notifyWeakSignal:    () => void
      on:                  (channel: string, fn: (...args: unknown[]) => void) => (() => void) | undefined
      editorReadFile:         (filePath: string) => Promise<unknown>
      editorSaveFile:         (params: unknown)  => Promise<{ ok: boolean; outputPath?: string; error?: string }>
      editorPickFile:         ()                 => Promise<string | null>
      editorExportFile:       (params: unknown)  => Promise<{ ok: boolean; outputPath?: string; error?: string }>
      editorPickOutputFolder: ()                 => Promise<string | null>
      editorReadMeta:         (filePath: string) => Promise<unknown>
      editorSaveMeta:         (filePath: string, metadata: unknown) => Promise<boolean>
      editorDetectSegments:   (filePath: string) => Promise<{ start: number; end: number; duration: number; label: string; type: string }[]>
      editorReadCutsDraft:    (filePath: string) => Promise<unknown>
      editorSaveCutsDraft:    (filePath: string, cuts: unknown) => Promise<void>
      editorDeleteCutsDraft:  (filePath: string) => Promise<void>
      pickAudioFile:          ()                 => Promise<string | null>
      listAsioDrivers:        ()                 => Promise<string[]>
      listFfmpegAudioDevices: () => Promise<{ name: string; index: number }[]>
      cloudConnect:        (service: string) => Promise<{ ok: boolean; accountName?: string; error?: string }>
      cloudCancelConnect:  (service: string) => Promise<boolean>
      cloudDisconnect:     (service: string) => Promise<void>
      cloudStatus:         ()                => Promise<Record<string, unknown>>
      cloudIsConfigured:   (service: string) => Promise<boolean>
      cloudUploadFile:     (service: string, filePath: string, metadata?: unknown) => Promise<{ ok: boolean; error?: string }>
      cloudListFolders:    (service: string, parentId?: string) => Promise<{ id: string; name: string; path?: string }[]>
      cloudSetFolder:      (service: string, folderId: string, folderName: string, folderPath?: string) => Promise<void>
      cloudQueueStatus:    () => Promise<{ entries: { id: string; service: string; filename: string; status: string; attempts: number; nextAttempt: number; lastError?: string }[] }>
      cloudQueueRetry:     (id: string) => Promise<boolean>
      cloudQueueRemove:    (id: string) => Promise<boolean>
      cloudQueueFlush:     () => Promise<boolean>
      podcastRegenerate:   (service: string) => Promise<{ ok: boolean; feedUrl?: string; episodeCount: number; error?: string }>
      youtubeConnect:      () => Promise<{ ok: boolean; error?: string }>
      youtubeDisconnect:   () => Promise<{ ok: boolean }>
      youtubeStatus:       () => Promise<{ connected: boolean }>
      youtubeUpload:       (filePath: string, metadata: unknown) => Promise<{ ok: boolean; videoId?: string; url?: string; error?: string }>
      reviewQueueList:                () => Promise<import('../types').ReviewQueueEntry[]>
      reviewQueueGet:                 (id: string) => Promise<import('../types').ReviewQueueEntry | null>
      reviewQueuePublish:             (id: string) => Promise<{ ok: boolean; error?: string }>
      reviewQueueDiscard:             (id: string) => Promise<boolean>
      reviewQueueUpdateTrim:          (id: string, trim: { startSec: number; endSec: number }) => Promise<boolean>
      reviewQueueUpdateMasterPreset:  (id: string, presetId: string) => Promise<boolean>
      reviewQueueUpdateJingles:       (id: string, jingles: { introPath?: string | null; outroPath?: string | null }) => Promise<boolean>
      listVideoDevices:  () => Promise<{ name: string; index: number }[]>
      videoPreviewStart: (opts: unknown) => Promise<boolean>
      videoPreviewStop:  () => Promise<void>
      editorSetVideoPath:      (filePath: string) => Promise<boolean>
      editorExtractAudioPeaks: (filePath: string) => Promise<{ data: Uint8Array; duration: number } | null>
      editorPickVideoFile:     ()                 => Promise<string | null>
      editorSaveVideo:         (params: unknown)  => Promise<{ ok: boolean; outputPath?: string; error?: string }>
      editorExportVideo:       (params: unknown)  => Promise<{ ok: boolean; outputPath?: string; error?: string }>
      editorProbeStreams:      (filePath: string) => Promise<{ hasVideo: boolean; hasAudio: boolean } | null>
      masterPresets:           () => Promise<{ id: string; label: string; description: string; targetLufs: number; targetLra: number; truePeakDb: number; filters: string }[]>
      masterPreview:           (inputPath: string, presetId: string, startSec: number, durationSec: number) => Promise<{ ok: boolean; previewPath?: string; error?: string }>
      masterMeasure:           (inputPath: string, presetId: string) => Promise<{ ok: boolean; measurement?: { inputI: number; inputLra: number; inputTp: number; inputThresh: number; targetOffset: number }; targetLufs?: number; error?: string }>
      masterApply:             (params: { inputPath: string; outputPath: string; presetId: string; measurement: { inputI: number; inputLra: number; inputTp: number; inputThresh: number; targetOffset: number }; jobId: string }) => Promise<{ ok: boolean; outputPath?: string; error?: string }>
      masterCancel:            (jobId: string) => Promise<boolean>
      getLogs:                 ()                 => Promise<unknown[]>
      getLogFilePath:          ()                 => Promise<string | null>
      diagnoseAudio?:          () => Promise<{ dshow: string[]; wasapi: string[]; wasapiAvailable: boolean }>
    }
    appVersion?: string
  }
}

export async function loadSettings(): Promise<void> {
  const s = await window.api.getSettings()
  updateSettings(s)
  applyAllSettingsToUI(s)
}

function applyAllSettingsToUI(s: Settings): void {
  const lang = s.language ?? 'no'
  loadLocale(lang)
  applyAudioSettingsToUI()
  applyScheduleSettingsToUI()
  applyFilesSettingsToUI()
  applyGeneralSettingsToUI()
  applyVideoSettingsToUI()
  applyPublishSettingsToUI()
  loadVideoInfoStrip()
  renderSlotsList()
  renderPlannedList()
  updateFilenamePreview()
}

function showPage(id: string): void {
  if (id !== 'home') { stopVU(); stopVideoPreview(); deactivateHome() }
  if (id !== 'editor') deactivateEditor()
  if (id !== 'settings') stopMonitoring()
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'))
  document.getElementById(`page-${id}`)?.classList.add('active')
  document.querySelector(`.nav-link[data-page="${id}"]`)?.classList.add('active')
  if (id === 'home')     refreshHome()
  if (id === 'schedule') renderCalendar()
  if (id === 'settings') {
    const activeTab = document.querySelector<HTMLElement>('#settings-tabs .inner-tab.active')?.dataset.tab
    if (!activeTab || activeTab === 'settings-audio') renderDeviceList('device-list')
    if (activeTab === 'settings-video') refreshVideoDevices()
  }
}

function setupSettingsTabs(): void {
  document.querySelectorAll<HTMLElement>('#settings-tabs .inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#settings-tabs .inner-tab').forEach(t => t.classList.remove('active'))
      btn.classList.add('active')
      const tabId = btn.dataset.tab ?? ''
      document.querySelectorAll<HTMLElement>('#page-settings .inner-page').forEach(p => p.classList.remove('active'))
      document.getElementById(tabId)?.classList.add('active')
      if (tabId === 'settings-audio') renderDeviceList('device-list')
      else stopMonitoring()
      if (tabId === 'settings-video') refreshVideoDevices()
    })
  })
}

/**
 * Verify that blob: URLs can be loaded into <img> tags. The video preview path
 * depends on this — frames arrive as JPEG buffers and are displayed via
 * URL.createObjectURL(new Blob(...)). If the CSP forgets to allow blob:, frames
 * still arrive but img.src silently fails (CSP violation goes to console as a
 * warning, not as a JS error). To catch that regression early, this runs on
 * startup and surfaces a visible banner if it fails.
 *
 * The smallest valid JPEG is 134 bytes — we embed a 1×1 white one as base64.
 */
function verifyBlobUrlsAllowed(): void {
  const tinyJpegB64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAr/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AB//Z'
  const bytes = Uint8Array.from(atob(tinyJpegB64), c => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  const img = new Image()
  let settled = false
  const done = (ok: boolean): void => {
    if (settled) return
    settled = true
    URL.revokeObjectURL(url)
    if (!ok) {
      console.error('[main] CSP smoke test FAILED — blob: URLs are blocked. Check Content-Security-Policy meta tag in index.html — img-src must include blob:.')
      const banner = document.getElementById('global-error-banner')
      const msg    = document.getElementById('global-error-msg')
      if (msg)    msg.textContent = 'Konfigurasjonsfeil: kamera-preview vil ikke fungere (CSP blokkerer blob:-URL-er). Restart appen — hvis problemet vedvarer, kontakt support.'
      if (banner) banner.style.display = ''
    }
  }
  img.onload  = () => done(true)
  img.onerror = () => done(false)
  // Belt-and-braces: if neither fires within 3 s assume CSP block.
  setTimeout(() => done(false), 3000)
  img.src = url
}

async function init(): Promise<void> {
  // Set globals consumed by sub-modules
  window.showPage       = showPage
  window.loadSettings   = loadSettings
  window.showOnboarding = showOnboarding
  window.__isRecording  = false

  // Fail loud on CSP regressions that break the video-preview display path.
  verifyBlobUrlsAllowed()

  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('mac')) {
    document.body.classList.add('platform-darwin')
  } else if (ua.includes('windows')) {
    document.body.classList.add('platform-win32')
  }

  // Hook i18n to re-run calendar/schedule renderers after locale load
  setApplyHook(() => {
    renderDayPickers()
    renderCalendar()
    updateFilenamePreview()
  })

  // Navigation
  document.querySelectorAll('.nav-link').forEach(a => {
    a.addEventListener('click', e => {
      e.preventDefault()
      showPage((a as HTMLElement).dataset.page!)
    })
  })

  // Wire up all pages
  setupHome()
  setupAudioPage()
  setupSchedulePage()
  setupCalendarPage()
  setupFilesPage()
  setupGeneralPage()
  setupVideoPage()
  setupRecording()
  setupEditorPage()
  setupPublishPage()
  setupClipReset()
  setupSettingsTabs()

  window.openEditorWithFile = openEditorWithFile
  window.openEditorReviewMode = openEditorReviewMode

  // Fetch app version from main (sandbox-safe — no fs/path in preload)
  window.appVersion = await window.api.getAppVersion().catch(() => '—')

  // Load settings, which triggers locale + UI apply
  await loadSettings()

  // Show first-run onboarding wizard for new users
  checkAndShowOnboarding()

  // Initial page load
  await refreshHome()
  renderDeviceList('device-list')
  renderDayPickers()
  renderCalendar()
  updateFilenamePreview()
  toggleMp3Quality()
}

window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled promise rejection:', e.reason)
  e.preventDefault()
})

init().catch(err => console.error('Init failed:', err))
