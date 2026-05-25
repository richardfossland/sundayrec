/**
 * Tests for src/main/mastering.ts.
 *
 * Strategy:
 *   - Mock child_process.spawn to drive ffmpeg lifecycle from tests.
 *   - Test pure functions (preset list integrity, filter chain construction,
 *     loudnorm JSON parsing) directly.
 *   - Test cancellation via the jobId registry.
 */

import { EventEmitter } from 'events'

// ── Mocks (declared BEFORE importing the SUT) ───────────────────────────────

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/tmp/sundayrec-test') },
}))

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin: '/usr/bin/ffmpeg',
}))

jest.mock('../src/main/store', () => ({
  getAll: jest.fn(() => ({ bitrate: '192' })),
}))

jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    existsSync: jest.fn(() => true),
    accessSync: jest.fn(() => undefined),
    mkdirSync:  jest.fn(() => undefined),
    readdirSync: jest.fn(() => []),
    unlinkSync:  jest.fn(() => undefined),
    constants:   actual.constants,
  }
})

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}))

// ── Import the SUT (after all mocks) ────────────────────────────────────────

import {
  MASTER_PRESETS,
  parseLoudnormJson,
  buildMeasurePassFilters,
  buildApplyPassFilters,
  buildPreviewPassFilters,
  getPresetById,
  measureLoudness,
  applyMastering,
  buildPreview,
  cancelMastering,
  cleanupOldPreviews,
} from '../src/main/mastering'
import * as fs from 'fs'
import { spawn } from 'child_process'

// ── Helpers ─────────────────────────────────────────────────────────────────

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill:   jest.Mock
}

function makeFakeFfmpeg(opts: { exitCode?: number; stderr?: string; stdout?: string; defer?: boolean } = {}): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill   = jest.fn()
  const emit = () => {
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout))
    proc.emit('close', opts.exitCode ?? 0)
  }
  if (!opts.defer) process.nextTick(emit)
  ;(proc as unknown as { __emit: () => void }).__emit = emit
  return proc
}

beforeEach(() => {
  ;(spawn as unknown as jest.Mock).mockReset()
  ;(fs.existsSync as unknown as jest.Mock).mockReset().mockReturnValue(true)
  ;(fs.accessSync as unknown as jest.Mock).mockReset().mockReturnValue(undefined)
  ;(fs.mkdirSync  as unknown as jest.Mock).mockReset()
  ;(fs.readdirSync as unknown as jest.Mock).mockReset().mockReturnValue([])
  ;(fs.unlinkSync  as unknown as jest.Mock).mockReset()
})

// ════════════════════════════════════════════════════════════════════════════
// 1. Preset integrity
// ════════════════════════════════════════════════════════════════════════════

describe('MASTER_PRESETS', () => {
  it('exposes exactly 4 presets', () => {
    expect(MASTER_PRESETS).toHaveLength(4)
  })

  it('each preset has all required fields with sane types', () => {
    for (const p of MASTER_PRESETS) {
      expect(typeof p.id).toBe('string')
      expect(p.id.length).toBeGreaterThan(0)
      expect(typeof p.label).toBe('string')
      expect(typeof p.description).toBe('string')
      expect(typeof p.targetLufs).toBe('number')
      expect(typeof p.targetLra).toBe('number')
      expect(typeof p.truePeakDb).toBe('number')
      expect(typeof p.filters).toBe('string')
      expect(p.filters.length).toBeGreaterThan(0)
    }
  })

  it('preset IDs are unique', () => {
    const ids = MASTER_PRESETS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('includes the recommended speech-clear preset targeting -16 LUFS', () => {
    const clear = MASTER_PRESETS.find(p => p.id === 'speech-clear')
    expect(clear).toBeDefined()
    expect(clear!.targetLufs).toBe(-16)
  })

  it('all true peaks stay at or below -1 dBTP (broadcast safe)', () => {
    for (const p of MASTER_PRESETS) {
      expect(p.truePeakDb).toBeLessThanOrEqual(-1)
    }
  })

  it('every filter chain starts with a highpass (rumble removal)', () => {
    for (const p of MASTER_PRESETS) {
      expect(p.filters).toMatch(/^highpass=/)
    }
  })

  it('every filter chain contains at least one acompressor stage', () => {
    for (const p of MASTER_PRESETS) {
      expect(p.filters).toMatch(/acompressor=/)
    }
  })

  it('no filter chain contains a double comma or trailing comma', () => {
    for (const p of MASTER_PRESETS) {
      expect(p.filters).not.toMatch(/,,/)
      expect(p.filters.endsWith(',')).toBe(false)
      expect(p.filters.startsWith(',')).toBe(false)
    }
  })

  it('getPresetById returns the right preset for a known id', () => {
    expect(getPresetById('speech-clear')?.targetLufs).toBe(-16)
    expect(getPresetById('music-speech')?.targetLra).toBe(11)
  })

  it('getPresetById returns null for an unknown id', () => {
    expect(getPresetById('nonexistent')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. Filter chain construction
// ════════════════════════════════════════════════════════════════════════════

describe('buildMeasurePassFilters', () => {
  it('appends loudnorm with print_format=json for pass 1', () => {
    const preset = MASTER_PRESETS[1]   // speech-clear
    const out = buildMeasurePassFilters(preset)
    expect(out).toContain(preset.filters)
    expect(out).toContain('loudnorm=')
    expect(out).toContain('print_format=json')
    expect(out).toContain(`I=${preset.targetLufs}`)
    expect(out).toContain(`LRA=${preset.targetLra}`)
    expect(out).toContain(`TP=${preset.truePeakDb}`)
  })
})

describe('buildApplyPassFilters', () => {
  const m = { inputI: -23.5, inputLra: 9.4, inputTp: -3.12, inputThresh: -33.5, targetOffset: 1.23 }

  it('contains measured_I, measured_LRA, measured_TP, measured_thresh, offset, linear=true', () => {
    const preset = MASTER_PRESETS[1]
    const out = buildApplyPassFilters(preset, m)
    expect(out).toContain('measured_I=-23.50')
    expect(out).toContain('measured_LRA=9.40')
    expect(out).toContain('measured_TP=-3.12')
    expect(out).toContain('measured_thresh=-33.50')
    expect(out).toContain('offset=1.23')
    expect(out).toContain('linear=true')
  })

  it('preserves the preset filter chain before the loudnorm', () => {
    const preset = MASTER_PRESETS[2]  // speech-punchy
    const out = buildApplyPassFilters(preset, m)
    expect(out.startsWith(preset.filters + ',')).toBe(true)
  })
})

describe('buildPreviewPassFilters', () => {
  it('uses single-pass loudnorm with the target values only', () => {
    const preset = MASTER_PRESETS[0]
    const out = buildPreviewPassFilters(preset)
    expect(out).toContain('loudnorm=')
    expect(out).not.toContain('measured_I')   // no two-pass for preview
    expect(out).not.toContain('print_format')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. loudnorm JSON parsing
// ════════════════════════════════════════════════════════════════════════════

describe('parseLoudnormJson', () => {
  const realisticStderr = `
ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers
  built with Apple clang version 14.0.0
Input #0, mp3, from 'test.mp3':
  Duration: 00:25:13.45, start: 0.025057, bitrate: 192 kb/s
Stream mapping:
  Stream #0:0 -> #0:0 (mp3 (mp3float) -> pcm_s16le (native))
Press [q] to stop, [?] for help
Output #0, null, to 'pipe:':
  Stream #0:0: Audio: pcm_s16le, 44100 Hz, stereo, s16, 1411 kb/s
size=N/A time=00:25:13.45 bitrate=N/A speed=14.5x
video:0kB audio:260886kB subtitle:0kB other streams:0kB
[Parsed_loudnorm_0 @ 0x600003a8c000]
{
        "input_i" : "-22.45",
        "input_tp" : "-3.12",
        "input_lra" : "8.30",
        "input_thresh" : "-32.51",
        "output_i" : "-16.00",
        "output_tp" : "-1.00",
        "output_lra" : "5.20",
        "output_thresh" : "-26.05",
        "normalization_type" : "dynamic",
        "target_offset" : "0.75"
}
`

  it('extracts the loudnorm JSON block from realistic ffmpeg stderr', () => {
    const m = parseLoudnormJson(realisticStderr)
    expect(m).not.toBeNull()
    expect(m!.inputI).toBeCloseTo(-22.45, 2)
    expect(m!.inputLra).toBeCloseTo(8.30, 2)
    expect(m!.inputTp).toBeCloseTo(-3.12, 2)
    expect(m!.inputThresh).toBeCloseTo(-32.51, 2)
    expect(m!.targetOffset).toBeCloseTo(0.75, 2)
  })

  it('returns null when no JSON block is present', () => {
    const m = parseLoudnormJson('ffmpeg started\nsome random output\n')
    expect(m).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseLoudnormJson('')).toBeNull()
  })

  it('returns null when JSON block is malformed', () => {
    const m = parseLoudnormJson(`
[Parsed_loudnorm_0 @ 0x123]
{ "input_i" : "-22.5", "input_tp" :
`)
    expect(m).toBeNull()
  })

  it('returns null when JSON lacks required keys', () => {
    const m = parseLoudnormJson(`{ "output_i": "-16.00" }`)
    expect(m).toBeNull()
  })

  it('uses the LAST loudnorm block when multiple JSON blocks appear', () => {
    const stderr = `
{
  "input_i" : "-30.00", "input_tp" : "-10.00", "input_lra" : "2.0", "input_thresh" : "-40.0", "target_offset" : "0.0"
}
later output...
{
  "input_i" : "-20.00", "input_tp" : "-2.00", "input_lra" : "8.0", "input_thresh" : "-30.0", "target_offset" : "0.5"
}
`
    const m = parseLoudnormJson(stderr)
    expect(m!.inputI).toBeCloseTo(-20.0, 1)
  })

  it('defaults missing optional fields to 0 / -70', () => {
    const stderr = `{ "input_i" : "-22.0", "input_tp" : "-3.0", "input_lra" : "nan", "input_thresh" : "nan" }`
    const m = parseLoudnormJson(stderr)
    expect(m).not.toBeNull()
    expect(m!.inputI).toBeCloseTo(-22.0, 1)
    expect(m!.inputLra).toBe(0)
    expect(m!.inputThresh).toBe(-70)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. cancelMastering / job registry
// ════════════════════════════════════════════════════════════════════════════

describe('cancelMastering', () => {
  it('returns false for an unknown jobId (no job registered)', () => {
    expect(cancelMastering('does-not-exist')).toBe(false)
  })

  it('returns true after a job is registered (and kills the process)', async () => {
    const fake = makeFakeFfmpeg({ defer: true, exitCode: 1, stderr: 'SIGTERM\n' })
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => fake)

    const preset = MASTER_PRESETS[1]
    const m = { inputI: -22.5, inputLra: 8, inputTp: -3, inputThresh: -32, targetOffset: 0.5 }

    const jobId = 'job-cancel-1'
    const promise = applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m, undefined, jobId)
    // Let applyMastering subscribe + register
    await Promise.resolve()
    await Promise.resolve()

    // Now cancel
    const cancelled = cancelMastering(jobId)
    expect(cancelled).toBe(true)
    expect(fake.kill).toHaveBeenCalled()

    // Drain the rejected promise
    ;(fake as unknown as { __emit: () => void }).__emit()
    await expect(promise).rejects.toThrow(/cancelled/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. measureLoudness — pass 1 integration with spawn mock
// ════════════════════════════════════════════════════════════════════════════

describe('measureLoudness', () => {
  const preset = MASTER_PRESETS[1]   // speech-clear

  it('throws file_not_found if input does not exist', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValueOnce(false)
    await expect(measureLoudness('/tmp/nope.mp3', preset)).rejects.toThrow(/file_not_found/)
  })

  it('parses the JSON block when ffmpeg exits cleanly', async () => {
    const stderr = `
{
  "input_i" : "-23.45",
  "input_tp" : "-3.12",
  "input_lra" : "8.30",
  "input_thresh" : "-32.51",
  "output_i" : "-16.00",
  "target_offset" : "0.75"
}
`
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0, stderr }))
    const m = await measureLoudness('/tmp/in.mp3', preset)
    expect(m.inputI).toBeCloseTo(-23.45, 2)
    expect(m.inputTp).toBeCloseTo(-3.12, 2)
  })

  it('rejects with measure_failed when ffmpeg exits non-zero', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 1, stderr: 'something broke\n' }))
    await expect(measureLoudness('/tmp/in.mp3', preset)).rejects.toThrow(/measure_failed/)
  })

  it('rejects with measure_parse_failed when output lacks JSON', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0, stderr: 'no json here\n' }))
    await expect(measureLoudness('/tmp/in.mp3', preset)).rejects.toThrow(/parse_failed/)
  })

  it('spawns ffmpeg with the right -af filter chain', async () => {
    const stderr = `{ "input_i": "-22.0", "input_tp": "-3.0", "input_lra": "8.0", "input_thresh": "-30.0", "target_offset": "0.5" }`
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0, stderr }))
    await measureLoudness('/tmp/in.mp3', preset)
    const call = (spawn as unknown as jest.Mock).mock.calls[0]
    expect(call[0]).toBe('/usr/bin/ffmpeg')
    const args = call[1] as string[]
    const afIdx = args.indexOf('-af')
    expect(afIdx).toBeGreaterThanOrEqual(0)
    expect(args[afIdx + 1]).toContain('loudnorm=')
    expect(args[afIdx + 1]).toContain('print_format=json')
    expect(args).toContain('-f')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. applyMastering — pass 2 integration with spawn mock
// ════════════════════════════════════════════════════════════════════════════

describe('applyMastering', () => {
  const preset = MASTER_PRESETS[1]
  const m = { inputI: -22.5, inputLra: 8, inputTp: -3, inputThresh: -32, targetOffset: 0.5 }

  it('throws invalid_output_path when outputPath is empty', async () => {
    await expect(applyMastering('/tmp/in.mp3', '', preset, m)).rejects.toThrow(/invalid_output_path/)
  })

  it('resolves when ffmpeg exits 0', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await expect(applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m)).resolves.toBeUndefined()
  })

  it('rejects with apply_failed on non-zero exit', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 1, stderr: 'broken pipe\n' }))
    await expect(applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m)).rejects.toThrow(/apply_failed/)
  })

  it('invokes onProgress when ffmpeg emits out_time_ms', async () => {
    const stderr = 'Duration: 00:01:00.00, start: 0\n'
    const fake = makeFakeFfmpeg({ defer: true })
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => fake)

    const onProgress = jest.fn()
    const p = applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m, onProgress)
    // Push duration via stderr, then progress lines via stdout, then close.
    fake.stderr.emit('data', Buffer.from(stderr))
    fake.stdout.emit('data', Buffer.from('out_time_ms=30000000\n'))
    ;(fake as unknown as { __emit: () => void }).__emit()
    await p
    expect(onProgress).toHaveBeenCalled()
    // Last call should be the final-nudge to 100%
    const last = onProgress.mock.calls[onProgress.mock.calls.length - 1]
    expect(last[0]).toBe(last[1])
  })

  it('passes -progress pipe:1 and -y outputPath to ffmpeg', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    expect(args).toContain('-progress')
    expect(args).toContain('pipe:1')
    expect(args).toContain('-y')
    expect(args[args.length - 1]).toBe('/tmp/out.mp3')
  })

  it('uses libmp3lame for an .mp3 output extension', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await applyMastering('/tmp/in.wav', '/tmp/out.mp3', preset, m)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('libmp3lame')
  })

  it('uses pcm_s16le for a .wav output extension', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await applyMastering('/tmp/in.mp3', '/tmp/out.wav', preset, m)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('pcm_s16le')
  })

  it('uses flac for a .flac output extension', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await applyMastering('/tmp/in.mp3', '/tmp/out.flac', preset, m)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const caIdx = args.indexOf('-c:a')
    expect(args[caIdx + 1]).toBe('flac')
  })

  it('builds an -af with measured_ values from the measurement', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const afIdx = args.indexOf('-af')
    const af = args[afIdx + 1]
    expect(af).toContain('measured_I=-22.50')
    expect(af).toContain('measured_LRA=8.00')
    expect(af).toContain('measured_TP=-3.00')
    expect(af).toContain('measured_thresh=-32.00')
    expect(af).toContain('offset=0.50')
    expect(af).toContain('linear=true')
  })

  it('reports cancelled when ffmpeg is killed mid-run', async () => {
    const fake = makeFakeFfmpeg({ defer: true, exitCode: 1, stderr: 'received SIGTERM, terminating\n' })
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => fake)
    const p = applyMastering('/tmp/in.mp3', '/tmp/out.mp3', preset, m, undefined, 'job-kill')
    await Promise.resolve()
    cancelMastering('job-kill')
    ;(fake as unknown as { __emit: () => void }).__emit()
    await expect(p).rejects.toThrow(/cancelled/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. buildPreview
// ════════════════════════════════════════════════════════════════════════════

describe('buildPreview', () => {
  const preset = MASTER_PRESETS[1]

  it('writes to an os.tmpdir() mp3 path on success', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    const out = await buildPreview('/tmp/in.mp3', preset, 0, 15)
    expect(out).toMatch(/sundayrec-master-preview-[a-f0-9]+\.mp3$/)
  })

  it('places -ss BEFORE -i for accurate seeking', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await buildPreview('/tmp/in.mp3', preset, 30, 15)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const ssIdx = args.indexOf('-ss')
    const iIdx  = args.indexOf('-i')
    expect(ssIdx).toBeGreaterThanOrEqual(0)
    expect(iIdx).toBeGreaterThan(ssIdx)
  })

  it('caps duration at 60 seconds even if a longer value is requested', async () => {
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    await buildPreview('/tmp/in.mp3', preset, 0, 600)
    const args = (spawn as unknown as jest.Mock).mock.calls[0][1] as string[]
    const tIdx = args.indexOf('-t')
    expect(parseFloat(args[tIdx + 1])).toBeLessThanOrEqual(60)
  })

  it('rejects on ffmpeg failure', async () => {
    ;(fs.existsSync as unknown as jest.Mock).mockReturnValue(false)   // ffmpeg never writes the file
    ;(spawn as unknown as jest.Mock).mockImplementationOnce(() => makeFakeFfmpeg({ exitCode: 0 }))
    // restore existsSync for the input-check before spawn:
    ;(fs.existsSync as unknown as jest.Mock).mockImplementationOnce(() => true).mockImplementationOnce(() => false)
    await expect(buildPreview('/tmp/in.mp3', preset, 0, 15)).rejects.toThrow(/preview_failed/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 8. cleanupOldPreviews
// ════════════════════════════════════════════════════════════════════════════

describe('cleanupOldPreviews', () => {
  it('does not throw when tmpdir is empty', () => {
    ;(fs.readdirSync as unknown as jest.Mock).mockReturnValueOnce([])
    expect(() => cleanupOldPreviews()).not.toThrow()
  })

  it('unlinks only sundayrec-master-preview-*.mp3 files', () => {
    ;(fs.readdirSync as unknown as jest.Mock).mockReturnValueOnce([
      'sundayrec-master-preview-abc.mp3',
      'sundayrec-master-preview-def.mp3',
      'some-other-file.mp3',
      'sundayrec-master-preview-xyz.wav',   // wrong extension — skip
      'not-related.txt',
    ])
    cleanupOldPreviews()
    const calls = (fs.unlinkSync as unknown as jest.Mock).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls[0][0]).toContain('sundayrec-master-preview-abc.mp3')
    expect(calls[1][0]).toContain('sundayrec-master-preview-def.mp3')
  })

  it('swallows readdir errors silently', () => {
    ;(fs.readdirSync as unknown as jest.Mock).mockImplementationOnce(() => { throw new Error('EPERM') })
    expect(() => cleanupOldPreviews()).not.toThrow()
  })

  it('swallows individual unlink errors and continues', () => {
    ;(fs.readdirSync as unknown as jest.Mock).mockReturnValueOnce([
      'sundayrec-master-preview-a.mp3',
      'sundayrec-master-preview-b.mp3',
    ])
    ;(fs.unlinkSync as unknown as jest.Mock).mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(() => cleanupOldPreviews()).not.toThrow()
  })
})
