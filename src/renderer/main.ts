import { loadLocale, setApplyHook } from './i18n'
import { updateSettings } from './state'
import type { Settings } from '../types'

import { setupHome, refreshHome, loadRecentHistory } from './pages/home'
import { stopVU, setupClipReset } from './pages/home-vu'
import { setupAudioPage, applyAudioSettingsToUI, renderDeviceList } from './pages/audio-page'
import { setupSchedulePage, applyScheduleSettingsToUI, renderDayPickers, renderSlotsList } from './pages/schedule-page'
import { setupCalendarPage, renderCalendar, renderPlannedList } from './pages/calendar-page'
import { setupFilesPage, applyFilesSettingsToUI, updateFilenamePreview, toggleMp3Quality } from './pages/files-page'
import { setupGeneralPage, applyGeneralSettingsToUI } from './pages/general-page'
import { setupRecording } from './pages/recording'

// Expose globals that sub-modules need
declare global {
  interface Window {
    showPage: (id: string) => void
    loadSettings: () => Promise<void>
    __isRecording: boolean
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
      getAppVersion:       () => Promise<string>
      checkForUpdates:     () => Promise<void>
      installUpdate:       () => void
      scheduleOsWakes:      () => Promise<unknown>
      scheduleOsWakesAdmin: () => Promise<unknown>
      sendAudioChunk:      (buf: ArrayBuffer) => void
      confirmStart:        (data: unknown) => void
      chunksDone:          () => void
      notifyStarted:       (data: unknown) => void
      notifyStopped:       (entry: unknown) => void
      notifyError:         (data: unknown) => void
      on:                  (channel: string, fn: (...args: unknown[]) => void) => (() => void) | undefined
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
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.nav-link').forEach(a => a.classList.remove('active'))
  document.getElementById(`page-${id}`)?.classList.add('active')
  document.querySelector(`.nav-link[data-page="${id}"]`)?.classList.add('active')
  if (id === 'home')     refreshHome()
  if (id === 'schedule') renderCalendar()
  if (id === 'audio')    renderDeviceList('device-list')
}

async function init(): Promise<void> {
  // Set globals consumed by sub-modules
  window.showPage   = showPage
  window.loadSettings = loadSettings
  window.__isRecording = false

  if (navigator.userAgent.toLowerCase().includes('mac')) {
    document.body.classList.add('platform-darwin')
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
  setupClipReset()

  // Fetch app version from main (sandbox-safe — no fs/path in preload)
  window.appVersion = await window.api.getAppVersion().catch(() => '—')

  // Load settings, which triggers locale + UI apply
  await loadSettings()

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
