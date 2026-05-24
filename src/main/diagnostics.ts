import { app, clipboard } from 'electron'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Settings } from '../types'

export interface DiagnosticsReport {
  markdown: string
  savedTo: string | null
  clipboardOk: boolean
  captureOk: boolean
}

async function getFfmpegVersion(ffmpegBin: string): Promise<string> {
  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    let settled = false
    const done = (result: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => { try { proc.kill() } catch {}; done('timeout') }, 4000)
    proc.on('close', () => done(out.match(/ffmpeg version (\S+)/)?.[1] ?? 'unknown'))
  })
}

interface CaptureTestResult {
  ok: boolean
  deviceName?: string
  format?: string
  fileSizeKB?: number
  error?: string
}

async function runAudioCaptureTest(ffmpegBin: string, settings: Settings): Promise<CaptureTestResult> {
  const { resolveDeviceInput } = await import('./native-recorder')
  let input: { format: string; device: string; resolvedName: string } | null = null
  try { input = await resolveDeviceInput(settings) } catch {}
  if (!input) return { ok: false, error: 'no_device' }

  const tmpFile = path.join(os.tmpdir(), `sundayrec-diag-audio-${Date.now()}.wav`)
  const inputArgs = input.format === 'wasapi'
    ? ['-f', 'wasapi', '-i', input.device]
    : input.format === 'dshow'
    ? ['-f', 'dshow', '-i', input.device]
    : ['-f', input.format, '-i', input.device]

  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner',
      ...inputArgs,
      '-t', '2', '-c:a', 'pcm_s16le', '-y', tmpFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 12000)

    proc.on('close', code => {
      clearTimeout(killer)
      let fileSizeKB: number | undefined
      try { const st = fs.statSync(tmpFile); fileSizeKB = Math.round(st.size / 1024); fs.unlinkSync(tmpFile) } catch {}
      if (code !== 0 || !fileSizeKB || fileSizeKB < 1) {
        const snippet = stderr.split('\n')
          .filter(l => l.trim() && !l.includes('Press [q]') && !l.includes('configuration:'))
          .slice(-6).join('\n')
        resolve({ ok: false, deviceName: input!.resolvedName, format: input!.format, error: snippet })
      } else {
        resolve({ ok: true, deviceName: input!.resolvedName, format: input!.format, fileSizeKB })
      }
    })
  })
}

async function runVideoCaptureTest(ffmpegBin: string, settings: Settings): Promise<CaptureTestResult> {
  if (!settings.videoEnabled) return { ok: false, error: 'video_disabled' }
  const { resolveVideoInput } = await import('./native-recorder')
  let input: { format: string; device: string; resolvedName: string } | null = null
  try {
    input = await resolveVideoInput({
      videoDeviceName:  settings.videoDeviceName ?? null,
      videoDeviceIndex: settings.videoDeviceIndex ?? null,
    })
  } catch {}
  if (!input) return { ok: false, error: 'no_video_device' }

  const tmpFile = path.join(os.tmpdir(), `sundayrec-diag-video-${Date.now()}.mp4`)

  // Minimal capture: 2 seconds, 1 fps, tiny resolution — just verify the device opens
  const inputArgs = process.platform === 'darwin'
    ? ['-f', 'avfoundation', '-framerate', '5', '-i', input.device]
    : ['-f', input.format, '-framerate', '5', '-i', input.device]

  return new Promise(resolve => {
    const proc = spawn(ffmpegBin, [
      '-nostdin', '-hide_banner',
      ...inputArgs,
      '-t', '2', '-vframes', '10', '-vf', 'scale=160:-2', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-an', '-y', tmpFile,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const killer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, 15000)

    proc.on('close', code => {
      clearTimeout(killer)
      let fileSizeKB: number | undefined
      try { const st = fs.statSync(tmpFile); fileSizeKB = Math.round(st.size / 1024); fs.unlinkSync(tmpFile) } catch {}
      if (code !== 0 || !fileSizeKB || fileSizeKB < 1) {
        const snippet = stderr.split('\n')
          .filter(l => l.trim() && !l.includes('Press [q]') && !l.includes('configuration:'))
          .slice(-6).join('\n')
        resolve({ ok: false, deviceName: input!.resolvedName, format: input!.format, error: snippet })
      } else {
        resolve({ ok: true, deviceName: input!.resolvedName, format: input!.format, fileSizeKB })
      }
    })
  })
}

function sanitizeSettings(s: Settings): Record<string, unknown> {
  return {
    language:          s.language,
    deviceName:        s.deviceName,
    deviceId:          s.deviceId,
    channels:          s.channels,
    sampleRate:        s.sampleRate,
    inputVolume:       s.inputVolume,
    eqBass:            s.eqBass,
    eqMid:             s.eqMid,
    eqTreble:          s.eqTreble,
    compEnabled:       s.compEnabled,
    compThreshold:     s.compThreshold,
    compRatio:         s.compRatio,
    compAttack:        s.compAttack,
    compRelease:       s.compRelease,
    limiterEnabled:    s.limiterEnabled,
    limiterCeiling:    s.limiterCeiling,
    format:            s.format,
    bitrate:           s.bitrate,
    filenamePattern:   s.filenamePattern,
    autoDeleteDays:    s.autoDeleteDays,
    slots:             s.slots,
    specialRecordings: (s.specialRecordings ?? []).length,
    stopOnSilence:     s.stopOnSilence,
    silenceThreshold:  s.silenceThreshold,
    silenceTimeoutMinutes: s.silenceTimeoutMinutes,
    splitMinutes:      s.splitMinutes,
    trimSilence:       s.trimSilence,
    reminderMinutes:   s.reminderMinutes,
    manualMaxMinutes:  s.manualMaxMinutes,
    preRollSeconds:    s.preRollSeconds,
    launchAtLogin:     s.launchAtLogin,
    showOnStartup:     s.showOnStartup,
    wakeFromSleep:     s.wakeFromSleep,
    protectRecording:  s.protectRecording,
    notifyStart:       s.notifyStart,
    notifyStop:        s.notifyStop,
    emailOnError:      s.emailOnError,
    videoEnabled:      s.videoEnabled,
    videoDeviceName:   s.videoDeviceName,
    videoResolution:   s.videoResolution,
    videoBitrate:      s.videoBitrate,
    videoFramerate:    s.videoFramerate,
    videoSeparate:     s.videoSeparate,
    videoFlip:         s.videoFlip,
    askOpenEditor:     s.askOpenEditor,
    churchName:        s.churchName,
    autoUpdate:        s.autoUpdate,
  }
}

export async function runDiagnostics(settings: Settings): Promise<DiagnosticsReport> {
  const {
    ffmpegBin,
    listFfmpegDevices,
    listWasapiDevices,
    listVideoFfmpegDevices,
    probeWasapiAvailable,
  } = await import('./native-recorder')

  const videoEnabled = !!settings.videoEnabled

  const [ffmpegVersion, audioDevices, wasapiDevices, videoDevices, wasapiAvailable, audioTest, videoTest] =
    await Promise.all([
      getFfmpegVersion(ffmpegBin),
      listFfmpegDevices().catch(() => []),
      listWasapiDevices().catch(() => []),
      listVideoFfmpegDevices().catch(() => []),
      probeWasapiAvailable().catch(() => false),
      runAudioCaptureTest(ffmpegBin, settings),
      videoEnabled
        ? runVideoCaptureTest(ffmpegBin, settings)
        : Promise.resolve<CaptureTestResult>({ ok: false, error: 'video_disabled' }),
    ])

  const now = new Date()
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
  const sanitized = sanitizeSettings(settings)

  const lines: string[] = [
    '# SundayRec Diagnostics',
    '',
    `**Dato:** ${dateStr}`,
    `**App-versjon:** ${app.getVersion()}`,
    `**OS:** ${os.type()} ${os.release()} (${os.arch()})`,
    `**Node:** ${process.version}`,
    `**ffmpeg:** ${ffmpegVersion}`,
    `**Platform:** ${process.platform}`,
    '',
  ]

  // ── Lydtest ────────────────────────────────────────────────────────────────
  lines.push('## Lydopptakstest (2 sekunder)')
  if (audioTest.ok) {
    lines.push(`- **Resultat:** ✅ OK`)
    lines.push(`- **Enhet:** \`${audioTest.deviceName}\` (${audioTest.format})`)
    lines.push(`- **Filstørrelse:** ${audioTest.fileSizeKB} KB`)
  } else {
    lines.push(`- **Resultat:** ❌ Feil`)
    if (audioTest.deviceName) lines.push(`- **Enhet:** \`${audioTest.deviceName}\` (${audioTest.format})`)
    if (audioTest.error) {
      lines.push('- **Feilmelding:**')
      lines.push('```'); lines.push(audioTest.error); lines.push('```')
    }
  }

  // ── Videotest ──────────────────────────────────────────────────────────────
  lines.push('', '## Videoopptakstest (2 sekunder)')
  if (!videoEnabled) {
    lines.push('_Video ikke aktivert i innstillinger_')
  } else if (videoTest.ok) {
    lines.push(`- **Resultat:** ✅ OK`)
    lines.push(`- **Enhet:** \`${videoTest.deviceName}\` (${videoTest.format})`)
    lines.push(`- **Filstørrelse:** ${videoTest.fileSizeKB} KB`)
  } else {
    lines.push(`- **Resultat:** ❌ Feil`)
    if (videoTest.deviceName) lines.push(`- **Enhet:** \`${videoTest.deviceName}\``)
    if (videoTest.error && videoTest.error !== 'no_video_device') {
      lines.push('- **Feilmelding:**')
      lines.push('```'); lines.push(videoTest.error); lines.push('```')
    } else if (videoTest.error === 'no_video_device') {
      lines.push('- Ingen videoenhet funnet')
    }
  }

  // ── Tilgjengelige enheter ──────────────────────────────────────────────────
  lines.push('', '## Tilgjengelige lydenheter')
  if (process.platform === 'win32') {
    lines.push('', `### DirectShow (${audioDevices.length})`)
    if (audioDevices.length) audioDevices.forEach(d => lines.push(`- \`${d.name}\``))
    else lines.push('_Ingen funnet_')
    lines.push('', `### WASAPI (${wasapiDevices.length}, tilgjengelig: ${wasapiAvailable ? 'ja' : 'nei'})`)
    if (wasapiDevices.length) wasapiDevices.forEach(d => lines.push(`- \`${d.name}\``))
    else lines.push('_Ingen funnet_')
  } else {
    lines.push('', `### AVFoundation lyd (${audioDevices.length})`)
    if (audioDevices.length) audioDevices.forEach(d => lines.push(`- [${d.index}] \`${d.name}\``))
    else lines.push('_Ingen funnet_')
  }

  lines.push('', `## Tilgjengelige videoenheter (${videoDevices.length})`)
  if (videoDevices.length) videoDevices.forEach(d => lines.push(`- [${d.index}] \`${d.name}\``))
  else lines.push('_Ingen videoenheter funnet_')

  // ── Alle innstillinger ─────────────────────────────────────────────────────
  lines.push('', '## Innstillinger (alle, unntatt passord/e-post)')
  lines.push('```json')
  lines.push(JSON.stringify(sanitized, null, 2))
  lines.push('```')

  lines.push('', '---', '_Generert av SundayRec Diagnostics_')

  const markdown = lines.join('\n')

  let savedTo: string | null = null
  try {
    const filename = `SundayRec-diagnose-${now.toISOString().slice(0, 10)}.md`
    const filePath = path.join(app.getPath('desktop'), filename)
    fs.writeFileSync(filePath, markdown, 'utf8')
    savedTo = filePath
  } catch (err) {
    console.error('[diagnostics] save failed:', err)
  }

  let clipboardOk = false
  try { clipboard.writeText(markdown); clipboardOk = true } catch {}

  return { markdown, savedTo, clipboardOk, captureOk: audioTest.ok }
}
