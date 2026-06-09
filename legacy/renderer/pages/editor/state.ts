import type { RecordingMetadata } from '../../../types'

// ── Shared types ────────────────────────────────────────────────────────────
export interface Cut { start: number; end: number }
export interface Suggestion { start: number; end: number; duration: number; label: string; type: string }
export interface HandleDrag { cutIdx: number; side: 'start' | 'end' }

// ── Immutable format sets ─────────────────────────────────────────────────────
// Formats always routed to the video editor path (HTML video element + ffmpeg peaks)
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.wmv', '.ts', '.mts', '.m2ts', '.flv', '.3gp', '.asf', '.f4v'])
// Ambiguous containers (can be video or audio) — probe to decide
export const PROBE_EXTS = new Set(['.mkv', '.webm', '.mka'])
// Audio formats the browser (Web Audio API) can decode natively
export const WEB_AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.m4b', '.m4r', '.ogg', '.oga', '.opus', '.webm'])

// ── DOM helpers ───────────────────────────────────────────────────────────────
export const $ = (id: string) => document.getElementById(id)

// Colours / sizes read from CSS variables
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

// ── Shared mutable editor state ───────────────────────────────────────────────
// Single mutable object shared across all editor/ modules. The editor is a
// singleton page, so module-level shared state is the natural model. Modules
// `import { E } from './state'` and read/write `E.cuts`, `E.duration`, … —
// ESM live bindings forbid reassigning imported `let`, hence the object.
export const E = {
  filePath: '',
  duration: 0,
  peaks: null as Float32Array | null,
  cuts: [] as Cut[],
  cutHistory: [] as Cut[][],   // undo/redo stack
  cutHistoryIdx: -1,           // pointer into cutHistory (-1 = no history yet)
  suggestions: [] as Suggestion[],

  // Intro/Outro
  introBuffer: null as AudioBuffer | null,
  outroBuffer: null as AudioBuffer | null,
  introDuration: 0,
  outroDuration: 0,
  includeIntroOutro: false,
  // Cached peak arrays for intro/outro (rendered as dimmed waveform on timeline)
  introPeaks: null as Float32Array | null,
  outroPeaks: null as Float32Array | null,

  // Analyze panel display toggles
  showSpeechSegments: true,
  showMusicSegments: true,
  showSilenceSegments: false,
  lastAnalyzedAt: 0,  // epoch ms; 0 = never analyzed for current file

  // Dirty state — tracks whether the editor has unsaved changes (cuts,
  // normalize, intro/outro swap, mastering preset, metadata edits, …).
  editorDirty: false,

  // Holds the unsubscribe fn returned by window.api.on('editor-export-progress', …)
  exportProgressUnsub: null as (() => void) | null | undefined,

  // Video routing
  isVideoFile: false,
  videoEl: null as HTMLVideoElement | null,
  videoIntroPath: '',
  videoOutroPath: '',

  // Metadata + chapters
  meta: { title: '', speaker: '', description: '', chapters: [] } as RecordingMetadata,
  metaDirty: false,

  // Viewport (seconds visible in main canvas)
  vpStart: 0,
  vpEnd: 0,

  // Playback
  audioCtx: null as AudioContext | null,
  sourceNodes: [] as AudioBufferSourceNode[],
  audioBuffer: null as AudioBuffer | null,
  playStartCtxTime: 0,
  playStartSec: 0,
  isPlaying: false,
  isPreview: false,
  rafId: 0,
  loadSeq: 0,
  pendingSeekSec: null as number | null,  // seek target applied once the file finishes loading

  // Interaction state
  dragStartSec: -1,
  dragEndSec: -1,
  isDragging: false,
  hoverSec: -99999,    // ghost cursor position (extended timeline coords; -99999 = no hover)
  minimapDragging: false,

  // Export state
  exportOutputFolder: '',
  publishAfterExport: false,  // set by "Eksporter og publiser" button — runs publishing after export completes

  // Clipping detection
  clipTimes: [] as number[],

  // Peak normalization gain (applied to playback + waveform render + export).
  // 0 = no normalization. Positive values amplify, negative attenuate.
  audioGainDb: 0,

  // Audio enhancement (sent to editor_export). Empty strings = off.
  vocalChainPreset: '',          // '' | voice-light | voice-podcast | voice-noisy-room
  masterPreset: '',              // '' | speech-natural | speech-clear | speech-punchy | music-speech
  channelRepairMode: '',         // '' | swapLr | duplicateLeft | duplicateRight | monoMix | gainDb
  channelRepairLeftDb: 0,        // only for gainDb (auto-balance)
  channelRepairRightDb: 0,       // only for gainDb (auto-balance)

  // Video export container + codec (for video files).
  videoFormat: 'mp4',            // mp4 | mov | mkv
  videoCodec: 'h264',            // h264 | h265
  // When a video file is loaded, export its audio track only (drops video) to a
  // normal audio format instead of re-encoding the video.
  videoExportAudioOnly: false,

  // Advanced vocal-chain mixer (full per-stage processing override). When
  // useMixer is true the export sends this object as `processing` (wins over the
  // vocalChainPreset). Mirrors EditorProcessing / VocalChain::default().
  useMixer: false,
  mixer: {
    highpassEnabled: true, highpassHz: 80,
    denoiseEnabled: false, denoiseDb: 12, denoiseFloorDb: -25,
    dereverbEnabled: false, dereverbStrength: 0.4,
    gateEnabled: false, gateThresholdDb: -40, gateRatio: 2,
    eq: [] as Array<{ freqHz: number; gainDb: number; q: number }>,
    compEnabled: true, compThresholdDb: -18, compRatio: 3,
    compAttackMs: 5, compReleaseMs: 80, compMakeupDb: 2,
    deesserEnabled: false, deesserIntensity: 0.4,
    limiterEnabled: false, limiterDb: -1,
    gainDb: 0,
  },

  // Loop playback
  isLooping: false,
  loopStartSec: 0,

  // Cut handle dragging
  handleDrag: null as HandleDrag | null,

  // Playhead dragging (drag the playhead triangle)
  playheadDragging: false,

  // DOM refs — definitely assigned in setupEditorPage before any use
  canvas: null as unknown as HTMLCanvasElement,
  minimap: null as unknown as HTMLCanvasElement,
  minimapVp: null as unknown as HTMLElement,
}

// ── Dirty-state helpers ───────────────────────────────────────────────────
// markDirty/clearDirty are called from many editor/ modules (cuts, metadata,
// mastering, detection, loader). They live here so no sub-module needs to
// import editor-page. editor-page registers the header-refresh callback in
// setup, keeping state.ts free of DOM/UI imports.
let _onDirtyChange: (() => void) | null = null
export function setOnDirtyChange(cb: () => void): void { _onDirtyChange = cb }

export function markDirty(): void {
  if (E.editorDirty) return
  E.editorDirty = true
  _onDirtyChange?.()
}
export function clearDirty(): void {
  E.editorDirty = false
  _onDirtyChange?.()
}
