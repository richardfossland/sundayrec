/**
 * Tests for src/main/editor.ts
 *
 * The editor module orchestrates ffmpeg subprocesses to:
 *   1) clean stale temp files at startup (cleanupEditorTempFiles)
 *   2) refuse replace-mode on FORCE_WAV formats (saveEdited)
 *   3) build ffmpeg argv from cut regions (saveEdited / exportEdited)
 *   4) track running export jobs so the UI can cancel them (activeExports / cancelExport)
 *   5) scale the kill-timer with file duration (exportEdited)
 *   6) map ffmpeg/internal errors to stable error codes the UI knows
 *
 * Mocking strategy:
 *   - child_process.spawn is mocked so spawnFfmpeg never actually launches ffmpeg
 *   - the mock returns a fake EventEmitter-like ChildProcess; tests drive the
 *     'close' event to simulate success / failure / cancellation
 *   - the real `fs` module is used for filesystem state checks (we sandbox into
 *     os.tmpdir()). This is the same pattern used in cloud-http-util.test.ts.
 *   - electron is auto-mocked via the moduleNameMapper in jest.config.ts
 */

import { EventEmitter } from 'events'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'
import fs from 'fs'

jest.mock('child_process', () => ({ spawn: jest.fn() }))

jest.mock('../src/main/native-recorder', () => ({
  ffmpegBin:  '/mock/ffmpeg',
  // codecFor is re-exported from recorder-utils; editor.ts imports both
  // separately, so we don't need to stub anything else here.
}))

jest.mock('../src/main/store', () => ({
  getAll: jest.fn(() => ({ bitrate: 192 })),
}))

import {
  cleanupEditorTempFiles,
  cancelExport,
  saveEdited,
  exportEdited,
  FORCE_WAV_FORMATS,
} from '../src/main/editor'

// ── spawn-mock infrastructure ────────────────────────────────────────────────
//
// Build a fake ChildProcess that looks enough like the real thing for
// editor.ts. The real spawnFfmpeg in editor.ts:
//   - listens on proc.stderr.on('data', ...)
//   - listens on proc.on('close', code => ...)
//   - sometimes calls proc.kill('SIGTERM')
// So our fake must have those wired up.

const mockSpawn = spawn as unknown as jest.Mock

interface FakeProc extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin:  { write: jest.Mock; end: jest.Mock }
  kill:   jest.Mock
  // helpers for tests
  _finish: (code: number, stderrText?: string) => void
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.stdin  = { write: jest.fn(), end: jest.fn() }
  proc.kill   = jest.fn()
  proc._finish = (code: number, stderrText = '') => {
    if (stderrText) proc.stderr.emit('data', Buffer.from(stderrText))
    proc.emit('close', code)
  }
  return proc
}

// Convenience: queue up a fake proc to be returned by the next spawn() call,
// and immediately resolve it with exit code 0 once we yield to the event loop.
function queueSuccessfulProc(): FakeProc {
  const proc = makeFakeProc()
  mockSpawn.mockReturnValueOnce(proc)
  // Schedule the close event on next tick so the awaited promise resolves
  setImmediate(() => proc._finish(0))
  return proc
}

// Sandbox directory for filesystem tests
let sandbox = ''
beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'editor-test-'))
  mockSpawn.mockReset()
})
afterEach(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch {}
})

// ─── cleanupEditorTempFiles ────────────────────────────────────────────────

describe('cleanupEditorTempFiles', () => {
  it('deletes .__editor_tmp and .__editor_bak files in the folder', async () => {
    fs.writeFileSync(path.join(sandbox, 'foo.mp3.__editor_tmp'), 'tmp')
    fs.writeFileSync(path.join(sandbox, 'bar.wav.__editor_bak'), 'bak')
    const removed = await cleanupEditorTempFiles(sandbox)
    expect(removed).toBe(2)
    expect(fs.existsSync(path.join(sandbox, 'foo.mp3.__editor_tmp'))).toBe(false)
    expect(fs.existsSync(path.join(sandbox, 'bar.wav.__editor_bak'))).toBe(false)
  })

  it('ignores non-editor files (real recordings stay untouched)', async () => {
    fs.writeFileSync(path.join(sandbox, 'song.mp3'), 'audio')
    fs.writeFileSync(path.join(sandbox, 'notes.txt'), 'text')
    fs.writeFileSync(path.join(sandbox, 'stale.__editor_tmp'), 'tmp')
    const removed = await cleanupEditorTempFiles(sandbox)
    expect(removed).toBe(1)
    expect(fs.existsSync(path.join(sandbox, 'song.mp3'))).toBe(true)
    expect(fs.existsSync(path.join(sandbox, 'notes.txt'))).toBe(true)
    expect(fs.existsSync(path.join(sandbox, 'stale.__editor_tmp'))).toBe(false)
  })

  it('returns 0 for a missing folder (no crash)', async () => {
    const missing = path.join(sandbox, 'does-not-exist')
    await expect(cleanupEditorTempFiles(missing)).resolves.toBe(0)
  })

  it('returns 0 for an empty / falsy folder argument', async () => {
    await expect(cleanupEditorTempFiles('')).resolves.toBe(0)
  })

  it('does not crash when readdir throws (e.g. permission denied)', async () => {
    const spy = jest.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }) as never
    )
    await expect(cleanupEditorTempFiles(sandbox)).resolves.toBe(0)
    spy.mockRestore()
  })

  it('continues if a single unlink fails (partial cleanup)', async () => {
    fs.writeFileSync(path.join(sandbox, 'a.__editor_tmp'), 'a')
    fs.writeFileSync(path.join(sandbox, 'b.__editor_tmp'), 'b')
    // Make the FIRST unlink call fail, the second succeed.
    const realUnlink = fs.promises.unlink
    const spy = jest.spyOn(fs.promises, 'unlink')
      .mockImplementationOnce(async () => { throw new Error('EBUSY') })
      .mockImplementationOnce((p) => realUnlink(p))
    const removed = await cleanupEditorTempFiles(sandbox)
    expect(removed).toBe(1)
    spy.mockRestore()
  })
})

// ─── FORCE_WAV_FORMATS ──────────────────────────────────────────────────────

describe('FORCE_WAV_FORMATS', () => {
  it('is exported as a Set', () => {
    expect(FORCE_WAV_FORMATS).toBeInstanceOf(Set)
  })

  it('includes the lossless / niche formats that have no ffmpeg-static encoder', () => {
    // These are the formats where transcoding to WAV is the only safe option.
    // If any disappear, replace-mode on user's files becomes unsafe again.
    for (const fmt of ['ape', 'dts', 'mpc', 'ra', 'ram', 'spx', 'gsm', 'amr', '3ga']) {
      expect(FORCE_WAV_FORMATS.has(fmt)).toBe(true)
    }
  })

  it('does not contain common safe formats (mp3, wav, flac, m4a)', () => {
    for (const fmt of ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus']) {
      expect(FORCE_WAV_FORMATS.has(fmt)).toBe(false)
    }
  })
})

// ─── saveEdited validation + force_wav_replace_unsafe guard ────────────────

describe('saveEdited input validation', () => {
  it('returns invalid_path for a non-string inputPath', async () => {
    const r = await saveEdited({
      inputPath: 123 as any, cutRegions: [], duration: 60, mode: 'new',
    })
    expect(r).toEqual({ ok: false, error: 'invalid_path' })
  })

  it('returns file_not_found when the file is missing', async () => {
    const r = await saveEdited({
      inputPath: path.join(sandbox, 'missing.mp3'),
      cutRegions: [], duration: 60, mode: 'new',
    })
    expect(r).toEqual({ ok: false, error: 'file_not_found' })
  })

  it('returns invalid_cut_regions when cutRegions is not an array', async () => {
    const file = path.join(sandbox, 'a.mp3')
    fs.writeFileSync(file, '')
    const r = await saveEdited({
      inputPath: file, cutRegions: 'not-array' as any, duration: 60, mode: 'new',
    })
    expect(r).toEqual({ ok: false, error: 'invalid_cut_regions' })
  })

  it('returns invalid_duration for zero or negative duration', async () => {
    const file = path.join(sandbox, 'a.mp3')
    fs.writeFileSync(file, '')
    const r1 = await saveEdited({ inputPath: file, cutRegions: [], duration: 0,  mode: 'new' })
    const r2 = await saveEdited({ inputPath: file, cutRegions: [], duration: -5, mode: 'new' })
    expect(r1.error).toBe('invalid_duration')
    expect(r2.error).toBe('invalid_duration')
  })
})

describe('saveEdited force_wav_replace_unsafe guard', () => {
  // For each FORCE_WAV format: replace-mode must refuse, save-as-new must NOT
  // refuse (it will transcode to WAV instead). The guard exists because
  // overwriting an .ape with WAV bytes silently corrupts the user's file.

  for (const fmt of Array.from(FORCE_WAV_FORMATS)) {
    it(`refuses replace-mode for .${fmt}`, async () => {
      const file = path.join(sandbox, `sample.${fmt}`)
      fs.writeFileSync(file, '')
      const r = await saveEdited({
        inputPath: file, cutRegions: [], duration: 60, mode: 'replace',
      })
      expect(r).toEqual({ ok: false, error: 'force_wav_replace_unsafe' })
    })
  }

  it('does NOT refuse safe formats (mp3) in replace-mode', async () => {
    const file = path.join(sandbox, 'safe.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 5, end: 10 }],
      duration: 60,
      mode: 'replace',
    })
    // The guard didn't fire; we get a normal ffmpeg call instead.
    expect(r.error).not.toBe('force_wav_replace_unsafe')
  })

  it('does NOT refuse safe formats (wav) in replace-mode', async () => {
    const file = path.join(sandbox, 'safe.wav')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 5, end: 10 }],
      duration: 60,
      mode: 'replace',
    })
    expect(r.error).not.toBe('force_wav_replace_unsafe')
  })

  it('does NOT refuse FORCE_WAV formats in "new" (save-as) mode', async () => {
    const file = path.join(sandbox, 'sample.ape')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 5, end: 10 }],
      duration: 60,
      mode: 'new',
    })
    // In new mode the output filename ends in .wav and the guard is bypassed.
    expect(r.error).not.toBe('force_wav_replace_unsafe')
  })
})

// ─── saveEdited keep-region edge cases ──────────────────────────────────────

describe('saveEdited keep-region logic', () => {
  it('returns no_audio_remaining when the cuts cover everything', async () => {
    const file = path.join(sandbox, 'all.mp3')
    fs.writeFileSync(file, '')
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 0, end: 60 }], // cut the entire clip
      duration: 60,
      mode: 'new',
    })
    expect(r).toEqual({ ok: false, error: 'no_audio_remaining' })
  })

  it('with no cuts, builds a single-segment ffmpeg command spanning [0, duration]', async () => {
    const file = path.join(sandbox, 'whole.mp3')
    fs.writeFileSync(file, '')
    const proc = queueSuccessfulProc()
    void proc
    const r = await saveEdited({
      inputPath: file, cutRegions: [], duration: 120, mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    // Single-segment path uses -af, not -filter_complex
    expect(argv).toContain('-af')
    expect(argv.join(' ')).toMatch(/atrim=start=0\.0000:end=120\.0000/)
  })

  it('one cut in the middle splits into TWO keeps and uses -filter_complex', async () => {
    const file = path.join(sandbox, 'split.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 30, end: 45 }],
      duration: 120,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('-filter_complex')
    const fc = argv[argv.indexOf('-filter_complex') + 1]
    // two atrim segments, concat n=2
    expect(fc).toMatch(/atrim=start=0\.0000:end=30\.0000/)
    expect(fc).toMatch(/atrim=start=45\.0000:end=120\.0000/)
    expect(fc).toMatch(/concat=n=2:v=0:a=1/)
  })

  it('cut at start (0) drops the leading keep; output begins at the cut end', async () => {
    const file = path.join(sandbox, 'lead.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 0, end: 10 }],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    // Single segment from 10→60 (no leading [0,0])
    expect(argv).toContain('-af')
    expect(argv.join(' ')).toMatch(/atrim=start=10\.0000:end=60\.0000/)
  })

  it('cut at end drops the trailing keep', async () => {
    const file = path.join(sandbox, 'tail.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 50, end: 60 }],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv.join(' ')).toMatch(/atrim=start=0\.0000:end=50\.0000/)
  })

  it('multiple cuts produce N+1 segments (or N if cuts touch boundaries)', async () => {
    const file = path.join(sandbox, 'multi.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [
        { start: 10, end: 15 },
        { start: 30, end: 35 },
        { start: 50, end: 55 },
      ],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    const fc = argv[argv.indexOf('-filter_complex') + 1]
    expect(fc).toMatch(/concat=n=4:v=0:a=1/)
  })

  it('unsorted cuts are sorted before keep-list construction', async () => {
    const file = path.join(sandbox, 'unsorted.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [
        { start: 50, end: 55 },
        { start: 10, end: 15 },
      ],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    const argv = mockSpawn.mock.calls[0][1] as string[]
    const fc = argv[argv.indexOf('-filter_complex') + 1]
    // Keeps (after sort) are [0,10], [15,50], [55,60]
    // So 'start=0.0000' appears before 'start=15.0000' before 'start=55.0000'.
    expect(fc.indexOf('start=0.0000')).toBeGreaterThanOrEqual(0)
    expect(fc.indexOf('start=0.0000')).toBeLessThan(fc.indexOf('start=15.0000'))
    expect(fc.indexOf('start=15.0000')).toBeLessThan(fc.indexOf('start=55.0000'))
  })
})

// ─── activeExports + cancelExport ───────────────────────────────────────────

describe('cancelExport', () => {
  it('returns false for an unknown jobId (no crash)', () => {
    expect(cancelExport('does-not-exist')).toBe(false)
  })

  it('SIGTERMs the registered ffmpeg subprocess and returns true', async () => {
    const file = path.join(sandbox, 'cancel.mp3')
    fs.writeFileSync(file, '')

    // Make spawn return a proc that NEVER finishes on its own — we'll cancel it.
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)

    const promise = exportEdited({
      jobId: 'job-A',
      inputPath: file,
      cutRegions: [],
      duration: 60,
      mode: 'new',
      outputFormat: 'mp3',
      processing: { ffmpegFilters: [] },
    })

    // exportEdited has registered the job by the time spawn returned.
    // Cancel it.
    const ok = cancelExport('job-A')
    expect(ok).toBe(true)
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM')

    // Simulate ffmpeg dying from the SIGTERM
    proc._finish(255, 'Exiting normally, received signal SIGTERM.')
    const r = await promise
    expect(r.ok).toBe(false)
    expect(r.error).toBe('cancelled')
  })

  it('removes the job from activeExports after a cancel', async () => {
    const file = path.join(sandbox, 'cancel2.mp3')
    fs.writeFileSync(file, '')

    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)

    const p = exportEdited({
      jobId: 'job-B',
      inputPath: file,
      cutRegions: [],
      duration: 60,
      mode: 'new',
      outputFormat: 'mp3',
      processing: { ffmpegFilters: [] },
    })

    expect(cancelExport('job-B')).toBe(true)
    // After cancel, the map entry is gone — calling cancel again returns false.
    expect(cancelExport('job-B')).toBe(false)

    proc._finish(255, 'SIGTERM')
    await p
  })

  it('tracks multiple concurrent jobs independently', async () => {
    const file1 = path.join(sandbox, 'c1.mp3')
    const file2 = path.join(sandbox, 'c2.mp3')
    fs.writeFileSync(file1, '')
    fs.writeFileSync(file2, '')

    const proc1 = makeFakeProc()
    const proc2 = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc1).mockReturnValueOnce(proc2)

    const p1 = exportEdited({
      jobId: 'job-1', inputPath: file1, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    const p2 = exportEdited({
      jobId: 'job-2', inputPath: file2, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })

    // Cancel only job-1
    expect(cancelExport('job-1')).toBe(true)
    expect(proc1.kill).toHaveBeenCalledWith('SIGTERM')
    expect(proc2.kill).not.toHaveBeenCalled()

    proc1._finish(255, 'SIGTERM')
    proc2._finish(0)
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.ok).toBe(false)
    expect(r1.error).toBe('cancelled')
    expect(r2.ok).toBe(true)
  })

  it('job WITHOUT a jobId is not registered (cancelExport on any id returns false)', async () => {
    const file = path.join(sandbox, 'nojob.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      // no jobId
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    expect(cancelExport('any-id')).toBe(false)
  })

  it('export success path also removes the job from activeExports', async () => {
    const file = path.join(sandbox, 'ok.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      jobId: 'job-cleanup',
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    // After success, cancel must return false (job already removed)
    expect(cancelExport('job-cleanup')).toBe(false)
  })

  it('export failure path also removes the job from activeExports', async () => {
    const file = path.join(sandbox, 'fail.mp3')
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const p = exportEdited({
      jobId: 'job-fail',
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    // Simulate ffmpeg crash (non-zero exit)
    setImmediate(() => proc._finish(1, 'Conversion failed!'))
    const r = await p
    expect(r.ok).toBe(false)
    expect(cancelExport('job-fail')).toBe(false)
  })
})

// ─── exportEdited error code mapping ────────────────────────────────────────

describe('exportEdited error code mapping', () => {
  it('maps SIGTERM/killed in stderr to error code "cancelled"', async () => {
    const file = path.join(sandbox, 'c.mp3')
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const p = exportEdited({
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    setImmediate(() => proc._finish(255, 'Received signal SIGTERM. Exiting.'))
    const r = await p
    expect(r.error).toBe('cancelled')
  })

  it('also matches lowercase "killed" in stderr → "cancelled"', async () => {
    const file = path.join(sandbox, 'k.mp3')
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const p = exportEdited({
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    setImmediate(() => proc._finish(137, 'ffmpeg got killed by host system'))
    const r = await p
    expect(r.error).toBe('cancelled')
  })

  it('maps an error message containing "timeout" → "timeout"', async () => {
    const file = path.join(sandbox, 't.mp3')
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const p = exportEdited({
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    setImmediate(() => proc._finish(1, 'ffmpeg encountered a timeout during processing'))
    const r = await p
    expect(r.error).toBe('timeout')
  })

  it('returns file_not_found for a missing input', async () => {
    const r = await exportEdited({
      inputPath: path.join(sandbox, 'nope.mp3'),
      cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    expect(r).toEqual({ ok: false, error: 'file_not_found' })
  })

  it('returns no_audio_remaining when all audio is cut out', async () => {
    const file = path.join(sandbox, 'empty.mp3')
    fs.writeFileSync(file, '')
    const r = await exportEdited({
      inputPath: file,
      cutRegions: [{ start: 0, end: 60 }],
      duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    expect(r).toEqual({ ok: false, error: 'no_audio_remaining' })
  })

  it('returns invalid_path / invalid_cut_regions / invalid_duration for bad params', async () => {
    expect((await exportEdited({
      inputPath: 42 as any, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })).error).toBe('invalid_path')

    const file = path.join(sandbox, 'v.mp3'); fs.writeFileSync(file, '')

    expect((await exportEdited({
      inputPath: file, cutRegions: 'x' as any, duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })).error).toBe('invalid_cut_regions')

    expect((await exportEdited({
      inputPath: file, cutRegions: [], duration: 0,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })).error).toBe('invalid_duration')
  })

  it('non-SIGTERM, non-timeout ffmpeg failure surfaces the stderr tail as the error', async () => {
    const file = path.join(sandbox, 'g.mp3')
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const p = exportEdited({
      inputPath: file, cutRegions: [], duration: 60,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    setImmediate(() => proc._finish(1, 'Invalid argument for option foo'))
    const r = await p
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Invalid argument/)
  })
})

// ─── exportEdited ffmpeg argument construction ──────────────────────────────

describe('exportEdited ffmpeg argv construction', () => {
  it('single keep + no processing + no intro/outro → uses -af (simple path)', async () => {
    const file = path.join(sandbox, 's.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('-af')
    expect(argv).not.toContain('-filter_complex')
  })

  it('processing filters force -filter_complex even with a single keep', async () => {
    const file = path.join(sandbox, 'p.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'mp3',
      processing: { ffmpegFilters: ['loudnorm=I=-16:TP=-1.5:LRA=11'] },
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('-filter_complex')
    const fc = argv[argv.indexOf('-filter_complex') + 1]
    expect(fc).toMatch(/loudnorm=I=-16/)
    expect(fc).toMatch(/\[main_out\]/)
  })

  it('intro + outro paths add concat with format-aligned segments', async () => {
    const file  = path.join(sandbox, 'main.mp3')
    const intro = path.join(sandbox, 'intro.mp3')
    const outro = path.join(sandbox, 'outro.mp3')
    fs.writeFileSync(file,  '')
    fs.writeFileSync(intro, '')
    fs.writeFileSync(outro, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'mp3',
      processing: { ffmpegFilters: [] },
      introPath: intro, outroPath: outro,
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    // 3 -i flags: intro, main, outro
    const iCount = argv.filter(a => a === '-i').length
    expect(iCount).toBe(3)
    const fc = argv[argv.indexOf('-filter_complex') + 1]
    expect(fc).toMatch(/intro_fmt/)
    expect(fc).toMatch(/outro_fmt/)
    expect(fc).toMatch(/concat=n=3:v=0:a=1/)
  })

  it('outputFormat=wav selects pcm_s16le codec', async () => {
    const file = path.join(sandbox, 'w.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'wav',
      processing: { ffmpegFilters: [] },
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('pcm_s16le')
  })

  it('outputFormat=wav with bitDepth=24 selects pcm_s24le', async () => {
    const file = path.join(sandbox, 'w24.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'wav', outputBitDepth: 24,
      processing: { ffmpegFilters: [] },
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('pcm_s24le')
  })

  it('invalid outputFormat falls back to mp3 (libmp3lame)', async () => {
    const file = path.join(sandbox, 'fb.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    await exportEdited({
      inputPath: file, cutRegions: [], duration: 30,
      mode: 'new', outputFormat: 'mystery' as any,
      processing: { ffmpegFilters: [] },
    })
    const argv = mockSpawn.mock.calls[0][1] as string[]
    expect(argv).toContain('libmp3lame')
  })
})

// ─── dynamic export timeout (MAX_EDIT_MS scaling) ───────────────────────────
//
// In exportEdited:
//   dynamicTimeoutMs = Math.max(10 * 60_000, Math.round(duration * 1000 * 0.6))
// So:
//   duration  60s  → max(600000, 36000)  = 600_000 ms (floor wins)
//   duration 600s  → max(600000, 360000) = 600_000 ms (floor wins)
//   duration 3600s → max(600000, 2160000) = 2_160_000 ms (scaling wins)
//   boundary: scaling >= floor when duration*600 >= 600_000 → duration >= 1000s

describe('exportEdited dynamic timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  async function captureKillTimeoutMs(durationSec: number): Promise<number> {
    const file = path.join(sandbox, `t${durationSec}.mp3`)
    fs.writeFileSync(file, '')
    const proc = makeFakeProc()
    mockSpawn.mockReturnValueOnce(proc)
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout')

    const p = exportEdited({
      inputPath: file, cutRegions: [], duration: durationSec,
      mode: 'new', outputFormat: 'mp3', processing: { ffmpegFilters: [] },
    })

    // Find the call whose delay is "large" — the kill timer is the one whose
    // delay is at least 10 * 60_000. There can also be small jest-internal
    // timers and node-internal microtask schedulers; this filter is robust.
    const killCall = setTimeoutSpy.mock.calls.find(c => typeof c[1] === 'number' && (c[1] as number) >= 60_000)
    expect(killCall).toBeDefined()

    // Resolve the export so the suite doesn't leak the pending promise.
    // We have to schedule the close before flushing timers so the promise
    // settles deterministically.
    proc._finish(0)
    await p

    setTimeoutSpy.mockRestore()
    return killCall![1] as number
  }

  it('short clip (60 s duration) → uses 10-min floor', async () => {
    const ms = await captureKillTimeoutMs(60)
    expect(ms).toBe(10 * 60_000)
  })

  it('boundary: 1000 s duration → exactly the floor (1000*1000*0.6 = 600_000)', async () => {
    const ms = await captureKillTimeoutMs(1000)
    expect(ms).toBe(600_000)
  })

  it('long clip (3600 s = 1 h) → scales to 2_160_000 ms (36 min)', async () => {
    const ms = await captureKillTimeoutMs(3600)
    expect(ms).toBe(Math.round(3600 * 1000 * 0.6))
  })

  it('very long clip (4 h) → scales well past the floor', async () => {
    const ms = await captureKillTimeoutMs(4 * 3600)
    expect(ms).toBe(Math.round(4 * 3600 * 1000 * 0.6))
    expect(ms).toBeGreaterThan(10 * 60_000)
  })
})

// ─── saveEdited succeeds and creates an output file (sandbox round-trip) ────

describe('saveEdited end-to-end (mocked ffmpeg)', () => {
  it('on success in "new" mode returns ok and a _redigert output path', async () => {
    const file = path.join(sandbox, 'orig.mp3')
    fs.writeFileSync(file, '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 5, end: 10 }],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    expect(r.outputPath).toMatch(/orig_redigert\.mp3$/)
  })

  it('avoids name collision by appending _2 if _redigert.mp3 already exists', async () => {
    const file = path.join(sandbox, 'collide.mp3')
    fs.writeFileSync(file, '')
    // Pre-create the collision target
    fs.writeFileSync(path.join(sandbox, 'collide_redigert.mp3'), '')
    queueSuccessfulProc()
    const r = await saveEdited({
      inputPath: file,
      cutRegions: [{ start: 5, end: 10 }],
      duration: 60,
      mode: 'new',
    })
    expect(r.ok).toBe(true)
    expect(r.outputPath).toMatch(/collide_redigert_2\.mp3$/)
  })
})
