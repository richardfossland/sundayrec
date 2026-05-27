/**
 * prep-episode — turns a finished recording into a publish-ready EpisodePrep
 * and adds it to the human-review queue. This is the orchestrator that ties
 * together audio-analysis (sermon detection), mastering (default preset), and
 * the existing settings.podcast.* configuration.
 *
 * Pipeline:
 *   1. Run audio-analysis.analyzeAudio() on the recording
 *   2. Find the most plausible sermon segment (longest speech > 3 min,
 *      starting after the 5-min mark)
 *   3. Compute a confidence score from segment confidence + duration
 *   4. Apply defaults: master preset = settings.podcast.defaultMasterPreset
 *      (fallback 'speech-clear'), jingles = settings.podcast.defaultIntroPath/
 *      defaultOutroPath (fallback editorIntroPath/editorOutroPath)
 *   5. Decide status: 'needs-attention' if confidence < 0.6 OR no segment
 *      > 3 min was found; otherwise 'ready'
 *   6. Add to review-queue and fire notifications (tray, email, webhook,
 *      renderer IPC)
 *
 * Important: this module is ALWAYS lazy-imported from recorder.ts so the
 * heavy audio-analysis stack only loads when prep is actually needed.
 */

import crypto from 'crypto'
import path from 'path'
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import * as store from './store'
import * as logger from './logger'
import * as mailer from './mailer'
import type { AnalysisSegment } from './audio-analysis'
import type {
  EpisodePrep,
  PrepAnalysisSegment,
  PodcastSettings,
  Settings,
} from '../types'

// ── Tuning constants ──────────────────────────────────────────────────────

/**
 * Confidence threshold below which we flag the episode 'needs-attention'.
 *
 * 0.6 chosen because the per-frame classifier emits 0.7 confidence for "solid
 * speech" (3 of 4 features fit) and we want at least that level for a sermon
 * candidate. After mean-aggregating across many frames, 0.6 lands roughly at
 * "two-thirds of the segment's frames passed the 'solid speech' bar" — enough
 * to be useful as a suggestion but not high enough to skip review. Lower than
 * 0.6 starts pulling in music-heavy worship sets and prayer meetings.
 */
export const ATTENTION_CONFIDENCE_THRESHOLD = 0.6

/** Earliest start (seconds from beginning) for sermon segment candidates.
 *  Skips the worship/prayer prelude that opens most services. */
export const MIN_SERMON_START_SEC = 5 * 60

/** Shortest segment we'll consider a "real" sermon — under this we flag attention. */
export const MIN_SERMON_DURATION_SEC = 3 * 60

/** Minimum total music duration before we suspect this is a concert. */
const CONCERT_MUSIC_RATIO_THRESHOLD = 0.5

/** Minimum mid-recording silence run before we suspect editing/dropouts. */
const MID_RECORDING_SILENCE_RUN_SEC = 60

// ── Default settings access ───────────────────────────────────────────────

function getPodcastSettings(): PodcastSettings | undefined {
  return store.get('podcast') as PodcastSettings | undefined
}

function getDefaultMasterPreset(): string {
  return getPodcastSettings()?.defaultMasterPreset ?? 'speech-clear'
}

function getDefaultIntro(): string | undefined {
  const pc = getPodcastSettings()
  const all = store.getAll() as Settings
  return pc?.defaultIntroPath ?? all.editorIntroPath ?? undefined
}

function getDefaultOutro(): string | undefined {
  const pc = getPodcastSettings()
  const all = store.getAll() as Settings
  return pc?.defaultOutroPath ?? all.editorOutroPath ?? undefined
}

// ── Sermon detection ──────────────────────────────────────────────────────

/**
 * Choose the most plausible sermon segment from a list of analysis segments.
 *
 * Strategy: among speech segments that start ≥ MIN_SERMON_START_SEC and are
 * ≥ MIN_SERMON_DURATION_SEC long, pick the longest. Ties broken by higher
 * confidence. Returns null if no candidate qualifies.
 *
 * The "after 5 min" rule reflects how Norwegian church services almost
 * universally start with worship/announcements, with the sermon landing
 * 5–15 min in. A speech block before that 5-min mark is almost certainly
 * announcements, not the sermon — so we skip it even if it's the longest.
 */
export function findSermonSegment(
  segments: PrepAnalysisSegment[],
  durationSec: number,
): { startSec: number; endSec: number; confidence: number; segIndex: number } | null {
  // ── Case 0: sermon-only recording ─────────────────────────────────────
  // Some churches record only the sermon, not the full service. If ≥80%
  // of the file is speech and there's essentially no music (<5%), treat
  // the entire file as sermon and return bounds covering all speech.
  //
  // Single O(n) pass — earlier implementation did 5 separate iterations
  // (filter, reduce ×3, findIndex). Same result, one walk.
  if (durationSec > 60) {
    let speechCount  = 0
    let speechDur    = 0
    let musicDur     = 0
    let confSum      = 0
    let firstSpeechIdx = -1
    let firstSpeechStart = Infinity
    let lastSpeechEnd    = -Infinity
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (s.type === 'speech') {
        speechCount++
        speechDur += s.durationSec
        confSum   += s.confidence
        if (s.startSec < firstSpeechStart) {
          firstSpeechStart = s.startSec
          firstSpeechIdx   = i
        }
        if (s.endSec > lastSpeechEnd) lastSpeechEnd = s.endSec
      } else if (s.type === 'music') {
        musicDur += s.durationSec
      }
    }
    const speechRatio = speechDur / durationSec
    const musicRatio  = musicDur  / durationSec

    if (speechCount > 0 && speechRatio >= 0.80 && musicRatio < 0.05) {
      return {
        startSec:   firstSpeechStart,
        endSec:     Math.min(lastSpeechEnd, durationSec),
        confidence: confSum / speechCount,
        segIndex:   Math.max(0, firstSpeechIdx),
      }
    }
  }

  let best: { startSec: number; endSec: number; confidence: number; segIndex: number } | null = null
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s.type !== 'speech') continue
    if (s.startSec < MIN_SERMON_START_SEC) continue
    if (s.durationSec < MIN_SERMON_DURATION_SEC) continue
    // Sanity: don't allow the candidate to overshoot the file
    const endSec = Math.min(s.endSec, durationSec || s.endSec)
    if (
      !best ||
      s.durationSec > (best.endSec - best.startSec) ||
      (s.durationSec === (best.endSec - best.startSec) && s.confidence > best.confidence)
    ) {
      best = { startSec: s.startSec, endSec, confidence: s.confidence, segIndex: i }
    }
  }
  return best
}

// ── Attention reasons (Norwegian, hardcoded) ──────────────────────────────

export const ATTENTION_REASONS = {
  noSermonBlock: 'Vi fant ingen klar preken-blokk på over 3 minutter etter de første 5 min — kan være kort preken eller bønnemøte',
  speechAtStart: 'Største tale-segment er i starten — kanskje ikke prekenen?',
  midSilence:    'Mye stillhet midt i opptaket — kan tyde på at noe er klippet bort',
  mostlyMusic:   'Lange musikk-blokker — er dette en konsert i stedet for en gudstjeneste?',
  lowConfidence: 'Sermon-deteksjon hadde lav konfidens — sjekk at prekenen er innenfor det markerte området',
  veryShort:     'Hele opptaket er kort — kanskje en del av en serie eller et avbrutt opptak',
} as const

/**
 * Walk through segments and figure out why this episode might need extra
 * attention. Returns an array of human-readable Norwegian reasons. Empty
 * array means "this looks normal".
 */
export function deriveAttentionReasons(
  segments: PrepAnalysisSegment[],
  sermonResult: ReturnType<typeof findSermonSegment>,
  durationSec: number,
): string[] {
  const reasons: string[] = []

  if (!sermonResult) {
    // Was there a long speech segment at the very start? Common when the
    // pastor preaches first and worship comes after. Suggest it but flag.
    const earlySpeech = segments.find(
      s => s.type === 'speech' && s.startSec < MIN_SERMON_START_SEC && s.durationSec >= MIN_SERMON_DURATION_SEC,
    )
    if (earlySpeech) {
      reasons.push(ATTENTION_REASONS.speechAtStart)
    } else {
      reasons.push(ATTENTION_REASONS.noSermonBlock)
    }
  } else if (sermonResult.confidence < ATTENTION_CONFIDENCE_THRESHOLD) {
    reasons.push(ATTENTION_REASONS.lowConfidence)
  }

  // Mid-recording long silence: a run of silence segments totaling
  // > MID_RECORDING_SILENCE_RUN_SEC after the first 2 min and before the
  // last 2 min suggests dropouts or aggressive pre-editing of the file.
  if (durationSec > 5 * 60) {
    const startGuard = 120
    const endGuard   = Math.max(120, durationSec - 120)
    let silenceRunSec = 0
    let inMidSection = false
    for (const s of segments) {
      if (s.startSec < startGuard) continue
      if (s.startSec > endGuard) break
      inMidSection = true
      if (s.type === 'silence') silenceRunSec += s.durationSec
    }
    if (inMidSection && silenceRunSec > MID_RECORDING_SILENCE_RUN_SEC) {
      reasons.push(ATTENTION_REASONS.midSilence)
    }
  }

  // Concert detection: total music duration > 50 % of recording
  if (durationSec > 0) {
    const musicSec = segments.filter(s => s.type === 'music').reduce((sum, s) => sum + s.durationSec, 0)
    if (musicSec / durationSec > CONCERT_MUSIC_RATIO_THRESHOLD) {
      reasons.push(ATTENTION_REASONS.mostlyMusic)
    }
  }

  // Very short recording (< 8 min total) — almost certainly not a normal service
  if (durationSec > 0 && durationSec < 8 * 60) {
    reasons.push(ATTENTION_REASONS.veryShort)
  }

  return reasons
}

// ── Core: buildEpisodePrep ────────────────────────────────────────────────

/**
 * Convert an AnalysisSegment[] from audio-analysis.ts into the
 * PrepAnalysisSegment[] type stored on EpisodePrep. The shape is identical
 * but typed locally so the renderer doesn't need to import from main/.
 */
function toPrepSegments(segments: AnalysisSegment[]): PrepAnalysisSegment[] {
  return segments.map(s => ({
    startSec:    s.startSec,
    endSec:      s.endSec,
    durationSec: s.durationSec,
    type:        s.type,
    confidence:  s.confidence,
    avgRmsDb:    s.avgRmsDb,
    label:       s.label,
  }))
}

/**
 * Compute total recording duration from a segment list — last segment's endSec
 * is the most reliable signal since analyzeAudio() emits contiguous segments.
 */
function deriveDurationSec(segments: PrepAnalysisSegment[]): number {
  if (segments.length === 0) return 0
  return segments[segments.length - 1].endSec
}

/**
 * Single-pass prep pipeline. Pure with respect to the file system (only reads
 * the recording) — does NOT add to the queue or send notifications. The async
 * wrapper `prepEpisodeAsync` does that.
 *
 * Exported for testability: tests can inject mock analyzeAudio results and
 * assert on the resulting EpisodePrep without running ffmpeg.
 */
export async function buildEpisodePrep(
  recordingPath: string,
  analyzeFn?: (p: string) => Promise<AnalysisSegment[]>,
): Promise<EpisodePrep> {
  const now = Date.now()
  const id  = crypto.randomUUID()

  // Lazy-load analyzeAudio if no override was given. Keeps the FFT stack
  // out of the bundle until first use.
  const runAnalyze = analyzeFn ?? (await import('./audio-analysis')).analyzeAudio

  let rawSegments: AnalysisSegment[] = []
  try {
    rawSegments = await runAnalyze(recordingPath)
  } catch (err) {
    logger.warn('prep', 'analyze_failed', { error: (err as Error).message })
  }

  const segments    = toPrepSegments(rawSegments)
  const durationSec = deriveDurationSec(segments)
  const sermon      = findSermonSegment(segments, durationSec)

  const attentionReasons = deriveAttentionReasons(segments, sermon, durationSec)

  const status: EpisodePrep['status'] = attentionReasons.length > 0 ? 'needs-attention' : 'ready'

  const prep: EpisodePrep = {
    id,
    recordingPath,
    timestamp:        now,
    status,
    analysisSegments: segments,
    suggestedTrim:    sermon ? { startSec: sermon.startSec, endSec: sermon.endSec } : undefined,
    sermonConfidence: sermon?.confidence,
    masterPreset:     getDefaultMasterPreset(),
    introPath:        getDefaultIntro(),
    outroPath:        getDefaultOutro(),
    attentionReasons: attentionReasons.length > 0 ? attentionReasons : undefined,
    createdAt:        now,
    updatedAt:        now,
  }
  return prep
}

// ── Async entry point — called from recorder.ts ───────────────────────────

/**
 * Called by recorder.ts after a recording finishes (specifically, at the end
 * of finishSessionAsync after the history entry is added). Runs the analysis
 * + prep pipeline in the background and adds the result to the review queue.
 *
 * NEVER throws — any error is logged and the function returns. The recorder
 * must continue working even if prep fails.
 *
 * The function does the following in order:
 *   1. Build the EpisodePrep (runs ffmpeg-based analysis — can take a minute)
 *   2. Add to review queue
 *   3. Send tray notification + email (if emailOnError is on) + webhook
 *   4. Emit 'review-queue-update' to the renderer
 */
export async function prepEpisodeAsync(recordingPath: string, win: BrowserWindow): Promise<void> {
  try {
    logger.info('prep', 'prep_started', { recordingPath: path.basename(recordingPath) })

    const prep = await buildEpisodePrep(recordingPath)

    // Link the prep to the source recording entry so we can mark it published
    // later. The history entry was added moments earlier in finishSessionAsync.
    const history = store.getHistory()
    const match = history.find(h => h.path === recordingPath)
    if (match?.timestamp) prep.recordingTimestamp = match.timestamp

    const reviewQueue = await import('./review-queue')
    reviewQueue.addToQueue(prep)

    // Refresh the tray menu badge so users see "📬 N episoder klare" immediately.
    try {
      const tray = await import('./tray')
      const pending = reviewQueue.getQueue().filter(e =>
        e.prep.status !== 'published' && e.prep.status !== 'discarded'
      ).length
      tray.setReviewQueueCount(pending)
    } catch (err) {
      logger.warn('prep', 'tray_sync_failed', { error: (err as Error).message })
    }

    logger.info('prep', 'prep_complete', {
      id:               prep.id,
      status:           prep.status,
      sermonConfidence: prep.sermonConfidence,
      reasonCount:      prep.attentionReasons?.length ?? 0,
    })

    sendReadyNotifications(prep, win)
  } catch (err) {
    logger.warn('prep', 'prep_failed', { error: (err as Error).message })
  }
}

// ── Notifications ─────────────────────────────────────────────────────────

const NOTIF_LABELS: Record<string, { title: string; body: string; bodyAttention: string }> = {
  no: {
    title:         'SundayRec',
    body:          'Søndagens opptak er klart til gjennomgang',
    bodyAttention: 'Søndagens opptak er klart — men trenger en sjekk før publisering',
  },
  en: {
    title:         'SundayRec',
    body:          "Sunday's recording is ready for review",
    bodyAttention: "Sunday's recording is ready — but needs a quick check before publishing",
  },
}

function notifLabels(): { title: string; body: string; bodyAttention: string } {
  const lang = (store.get('language') ?? 'no') as string
  return NOTIF_LABELS[lang] ?? NOTIF_LABELS.no
}

function sendReadyNotifications(prep: EpisodePrep, win: BrowserWindow): void {
  const labels = notifLabels()
  const needsAttention = prep.status === 'needs-attention'
  const body = needsAttention ? labels.bodyAttention : labels.body

  // Tray notification
  try {
    if (Notification.isSupported()) {
      new Notification({ title: labels.title, body }).show()
    }
  } catch {}

  // Email — re-use emailOnError as the on/off switch since users who care about
  // error emails also want to know when their episode is ready.
  const s = store.getAll() as Settings
  if (s.emailOnError && s.emailAddress) {
    void mailer.sendError(s, store.getSmtpPassword(), body).catch(err =>
      logger.warn('prep', 'email_send_failed', { error: (err as Error).message }),
    )
  }

  // Webhook
  if (s.webhookUrl) {
    void import('./webhook').then(w => w.sendWebhook(s.webhookUrl!, {
      app:       'SundayRec',
      church:    s.churchName || '',
      severity:  needsAttention ? 'warn' : 'warn',
      category:  'device',
      message:   body,
      timestamp: new Date().toISOString(),
    })).catch(err => logger.warn('prep', 'webhook_failed', { error: (err as Error).message }))
  }

  // Renderer event — refreshes the home-page queue card immediately
  try {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('review-queue-update', { reason: 'added', id: prep.id })
    }
  } catch (err) {
    logger.warn('prep', 'renderer_notify_failed', { error: (err as Error).message })
  }
}
