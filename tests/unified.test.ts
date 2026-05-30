/**
 * Tests for the unified-recorder's A/V sync + silence handling.
 *
 * Background: the unified pipeline opens camera + mic in ONE ffmpeg process.
 * On macOS both come from a single avfoundation input (one device clock), so
 * A/V stays sample-accurate with no correction. On Windows the two `-i` are
 * two independent dshow device clocks (camera vs mixer) whose sample-rates
 * differ by parts-per-million — without correction the audio drifts against
 * the video over a long recording ("lips out of sync after 90 minutes").
 *
 * unifiedAudioDriftFilter() injects the SAME aresample=async correction the
 * two-process muxAudioVideo() path uses, but only on Windows.
 *
 * createSilenceWatcher() restores silence detection to the unified path,
 * which previously had none — a muted mixer recorded silently with no alert.
 */

jest.mock('ffmpeg-static', () => '/usr/bin/ffmpeg')

import { unifiedAudioDriftFilter } from '../src/main/unified-recorder'
import { createSilenceWatcher, RECORDER_TIMEOUTS } from '../src/main/recorder-utils'
import { buildSilenceDetectFilter } from '../src/main/native-recorder'

describe('unifiedAudioDriftFilter', () => {
  it('applies aresample=async drift correction on Windows (two dshow clocks)', () => {
    expect(unifiedAudioDriftFilter('win32')).toBe('aresample=async=1000:first_pts=0')
  })

  it('applies NO filter on macOS (single avfoundation input = one clock)', () => {
    expect(unifiedAudioDriftFilter('darwin')).toBe('')
  })

  it('applies NO filter on other platforms (unified is gated off there)', () => {
    expect(unifiedAudioDriftFilter('linux')).toBe('')
  })

  it('matches the two-process muxAudioVideo drift filter exactly', () => {
    // muxAudioVideo() (video-recorder.ts) uses 'aresample=async=1000:first_pts=0'.
    // The unified Windows path must stay in lock-step so both capture modes
    // behave identically over long takes.
    expect(unifiedAudioDriftFilter('win32')).toContain('aresample=async=1000:first_pts=0')
  })
})

describe('buildSilenceDetectFilter', () => {
  it('uses the configured threshold when stopOnSilence is on (clamped)', () => {
    expect(buildSilenceDetectFilter({ stopOnSilence: true, silenceThreshold: -40 } as never))
      .toBe('silencedetect=noise=-40dB:duration=1')
    // clamp to [-70, -10]
    expect(buildSilenceDetectFilter({ stopOnSilence: true, silenceThreshold: -999 } as never))
      .toBe('silencedetect=noise=-70dB:duration=1')
  })

  it('falls back to a permissive -55 dB warning detector when stopOnSilence is off', () => {
    expect(buildSilenceDetectFilter({ stopOnSilence: false } as never))
      .toBe('silencedetect=noise=-55dB:duration=1')
  })
})

describe('createSilenceWatcher', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers() })

  it('fires onWarning once after silenceWarnMs of continuous silence', () => {
    const onWarning = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: false, silenceTimeoutMs: 60_000, onStopSilence: jest.fn(), onWarning,
    })
    w.feed('[silencedetect @ 0x1] silence_start: 0')
    expect(onWarning).not.toHaveBeenCalled()
    jest.advanceTimersByTime(RECORDER_TIMEOUTS.silenceWarnMs)
    expect(onWarning).toHaveBeenCalledTimes(1)
  })

  it('cancels the warning when sound returns (silence_end) before the timer', () => {
    const onWarning = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: false, silenceTimeoutMs: 60_000, onStopSilence: jest.fn(), onWarning,
    })
    w.feed('silence_start: 0')
    jest.advanceTimersByTime(RECORDER_TIMEOUTS.silenceWarnMs - 1)
    w.feed('silence_end: 12 | silence_duration: 12')
    jest.advanceTimersByTime(10_000)
    expect(onWarning).not.toHaveBeenCalled()
  })

  it('re-arms after silence_end so a later stretch warns again', () => {
    const onWarning = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: false, silenceTimeoutMs: 60_000, onStopSilence: jest.fn(), onWarning,
    })
    w.feed('silence_start: 0')
    jest.advanceTimersByTime(RECORDER_TIMEOUTS.silenceWarnMs)
    w.feed('silence_end: 70')
    w.feed('silence_start: 80')
    jest.advanceTimersByTime(RECORDER_TIMEOUTS.silenceWarnMs)
    expect(onWarning).toHaveBeenCalledTimes(2)
  })

  it('fires onStopSilence after silenceTimeoutMs only when stopOnSilence is on', () => {
    const onStopSilence = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: true, silenceTimeoutMs: 5_000, onStopSilence, onWarning: jest.fn(),
    })
    w.feed('silence_start: 0')
    jest.advanceTimersByTime(5_000)
    expect(onStopSilence).toHaveBeenCalledTimes(1)
  })

  it('never fires onStopSilence when stopOnSilence is off', () => {
    const onStopSilence = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: false, silenceTimeoutMs: 5_000, onStopSilence, onWarning: jest.fn(),
    })
    w.feed('silence_start: 0')
    jest.advanceTimersByTime(60_000)
    expect(onStopSilence).not.toHaveBeenCalled()
  })

  it('clear() cancels pending timers so nothing fires after process close', () => {
    const onWarning = jest.fn()
    const onStopSilence = jest.fn()
    const w = createSilenceWatcher({
      stopOnSilence: true, silenceTimeoutMs: 5_000, onStopSilence, onWarning,
    })
    w.feed('silence_start: 0')
    w.clear()
    jest.advanceTimersByTime(RECORDER_TIMEOUTS.silenceWarnMs)
    expect(onWarning).not.toHaveBeenCalled()
    expect(onStopSilence).not.toHaveBeenCalled()
  })
})
