import { loadLocale, setApplyHook } from './i18n'
import { updateSettings } from './state'
import type { Settings } from '../types'

import { setupHome, refreshHome, loadRecentHistory } from './pages/home'
import { stopVU, setupClipReset } from './pages/home-vu'
import { setupAudioPage, applyAudioSettingsToUI, renderDeviceList, stopMonitoring } from './pages/audio-page'
import { setupSchedulePage, applyScheduleSettingsToUI, renderDayPickers, renderSlotsList } from './pages/schedule-page'
import { setupCalendarPage, renderCalendar, renderPlannedList } from './pages/calendar-page'
import { setupFilesPage, applyFilesSettingsToUI, updateFilenamePreview, toggleMp3Quality } from './pages/files-page'
import { setupGeneralPage, applyGeneralSettingsToUI } from './pages/general-page'
import { setupRecording } from './pages/recording'
import { setupEditorPage, openEditorWithFile, deactivateEditor } from './pages/editor-page'
import { checkAndShowOnboarding, showOnboarding } from './pages/onboarding'

// Expose globals that sub-modules need
declare global {
  interface Window {
    showPage: (id: string) => void
    loadSettings: () => Promise<void>
    showOnboarding: () => void
    __isRecording: boolean
    openEditorWithFile: (filePath: string) => void
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
      pickFolder:          () => Promise<string | null>
      openFolder:          (p: string) => Promise<void>
      revealFile:          (p: string) => Promise<void>
      clearSmtpPassword:   () => Promise<boolean>
      testEmail:           () => Promise<{ ok: boolean; error?: string }>
      updateHistoryNote:   (ts: number, note: string) => Promise<void>
      getAppVersion:       () => Promise<string>
      checkForUpdates:     () => Promise<void>
      installUpdate:       () => void
      scheduleOsWakes:      () => Promise<unknown>
      scheduleOsWakesAdmin: () => Promise<unknown>
      getSleepConfig:       () => Promise<unknown>
      fixMacSleep:          () => Promise<{ ok: boolean; message?: string }>
      fixWinWakeTimers:     () => Promise<{ ok: boolean; message?: string }>
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
      pickAudioFile:          ()                 => Promise<string | null>
      listAsioDrivers:        ()                 => Promise<string[]>
      cloudConnect:     (service: string) => Promise<{ ok: boolean; accountName?: string; error?: string }>
      cloudDisconnect:  (service: string) => Promise<void>
      cloudStatus:      ()                => Promise<Record<string, unknown>>
      cloudUploadFile:  (service: string, filePath: string, metadata?: unknown) => Promise<{ ok: boolean; error?: string }>
      cloudListFolders: (service: string, parentId?: string) => Promise<{ id: string; name: string; path?: string }[]>
      cloudSetFolder:   (service: string, folderId: string, folderName: string, folderPath?: string) => Promise<void>
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
  renderSlotsList()
  renderPlannedList()
  updateFilenamePreview()
}

function showPage(id: string): void {
  if (id !== 'home') stopVU()
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
    })
  })
}

async function init(): Promise<void> {
  // Set globals consumed by sub-modules
  window.showPage       = showPage
  window.loadSettings   = loadSettings
  window.showOnboarding = showOnboarding
  window.__isRecording  = false

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
  setupRecording()
  setupEditorPage()
  setupClipReset()
  setupSettingsTabs()

  window.openEditorWithFile = openEditorWithFile

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
