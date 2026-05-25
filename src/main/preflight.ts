/**
 * Scheduled preflight check — runs 30 minutes before each scheduled recording
 * and verifies the whole pipeline is ready: device present, disk has space,
 * permission granted, and (optionally) internet connectivity is up for cloud
 * upload.
 *
 * Findings are sent through the standard `sendBackendWarning` channel so they
 * get routed to the tray, the user's email, AND any configured webhook with
 * no extra glue.
 */

import fs from 'fs'
import path from 'path'
import { app, systemPreferences } from 'electron'
import type { BrowserWindow } from 'electron'
import * as store from './store'
import * as logger from './logger'
import { ffmpegBin, resolveDeviceInput } from './native-recorder'

export interface PreflightFinding {
  severity: 'warn' | 'error'
  category: 'cloud' | 'preroll' | 'wake' | 'disk' | 'device'
  message:  string
}

const MIN_DISK_AUDIO_BYTES = 500 * 1024 * 1024     // 500 MB — comfortable for a 1.5 h MP3
const MIN_DISK_VIDEO_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB  — comfortable for a 1.5 h video

export async function runPreflight(): Promise<PreflightFinding[]> {
  const settings = store.getAll()
  const findings: PreflightFinding[] = []

  // 1. ffmpeg binary
  if (ffmpegBin !== 'ffmpeg' && !fs.existsSync(ffmpegBin)) {
    findings.push({ severity: 'error', category: 'device', message: 'ffmpeg-binær mangler. SundayRec må installeres på nytt.' })
  }

  // 2. Save folder writable + free space
  const folder = settings.saveFolder ?? path.join(app.getPath('documents'), 'SundayRec')
  try {
    fs.mkdirSync(folder, { recursive: true })
    const probe = path.join(folder, `.preflight_${Date.now()}`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch (err) {
    findings.push({ severity: 'error', category: 'disk', message: `Lagringsmappen kan ikke skrives: ${(err as Error).message}` })
  }

  try {
    const stats = await fs.promises.statfs(folder)
    const freeBytes = stats.bavail * stats.bsize
    const videoActive = !!(settings.videoEnabled && (settings.videoDeviceName || settings.videoDeviceIndex != null))
    const min = videoActive ? MIN_DISK_VIDEO_BYTES : MIN_DISK_AUDIO_BYTES
    if (freeBytes < min) {
      const gb = (freeBytes / 1_073_741_824).toFixed(1)
      findings.push({
        severity: 'error',
        category: 'disk',
        message:  `Bare ${gb} GB ledig på lagringsdisken — kanskje ikke nok for et helt opptak.`,
      })
    }
  } catch {
    // statfs unsupported — skip check rather than fail-stop
  }

  // 3. Microphone permission on macOS
  if (process.platform === 'darwin') {
    const micStatus = systemPreferences.getMediaAccessStatus('microphone')
    if (micStatus === 'denied' || micStatus === 'restricted') {
      findings.push({ severity: 'error', category: 'device', message: 'Mikrofontilgang er ikke gitt. Åpne Systeminnstillinger → Personvern → Mikrofon.' })
    }
    if (settings.videoEnabled && (settings.videoDeviceName || settings.videoDeviceIndex != null)) {
      const camStatus = systemPreferences.getMediaAccessStatus('camera')
      if (camStatus === 'denied' || camStatus === 'restricted') {
        findings.push({ severity: 'error', category: 'device', message: 'Kameratilgang er ikke gitt.' })
      }
    }
  }

  // 4. Device present (and matches the saved selection, not the OS fallback)
  const expectedName = (settings.deviceName ?? '').trim()
  try {
    const input = await resolveDeviceInput(settings)
    if (!input) {
      findings.push({ severity: 'error', category: 'device', message: 'Ingen lydenhet ble funnet ved oppstart.' })
    } else if (expectedName && !sameDevice(expectedName, input.resolvedName)) {
      findings.push({
        severity: 'warn',
        category: 'device',
        message:  `Lagret enhet "${expectedName}" ble ikke funnet. Vi kommer til å ta opp fra "${input.resolvedName}" i stedet.`,
      })
    }
  } catch (err) {
    findings.push({ severity: 'warn', category: 'device', message: `Kunne ikke verifisere lydenhet: ${(err as Error).message}` })
  }

  // 5. Cloud connectivity — only flag if user has cloud upload turned on
  const cloudEnabled = [settings.cloudGoogleDrive, settings.cloudDropbox, settings.cloudOneDrive]
    .some(c => c?.enabled && c?.autoUpload)
  if (cloudEnabled) {
    try {
      const { isOnline } = await import('./cloud/http-util')
      if (!await isOnline()) {
        findings.push({ severity: 'warn', category: 'cloud', message: 'Internett ser ut til å være nede. Opptaket vil bli lagret lokalt, og sky-opplastingen prøves automatisk på nytt senere.' })
      }
    } catch {}
  }

  return findings
}

function sameDevice(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return true
  return na.includes(nb) || nb.includes(na)
}

/**
 * Run preflight and pipe any findings through the supplied sender. Called by
 * scheduler 30 min before each scheduled job, and on-demand from the UI.
 */
export async function runScheduledPreflight(
  send: (msg: string, severity: 'warn' | 'error', category: PreflightFinding['category']) => void
): Promise<{ findings: PreflightFinding[] }> {
  logger.info('preflight', 'run')
  const findings = await runPreflight()
  for (const f of findings) send(f.message, f.severity, f.category)
  logger.info('preflight', 'done', { count: findings.length })
  return { findings }
}

// Suppress unused-import warning while keeping BrowserWindow type-import surface
export type { BrowserWindow }
