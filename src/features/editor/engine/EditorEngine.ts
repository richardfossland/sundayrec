// EditorEngine — framework-agnostic audio editor core. Owns the mutable state,
// the canvas + minimap, the Web Audio playback graph, and pointer/wheel input.
// Ports the Electron renderer's loader / playback / canvas-input modules; the
// only adaptation is the file-bytes source (Tauri asset protocol + fetch, with
// an `editor_read_file` backend fallback) instead of Electron's `window.api`.
//
// React mounts the canvas, calls the imperative methods, and subscribes to
// structural snapshots. Per-frame playhead/timecode is delivered via `onTick`
// so React never re-renders 60×/s — the canvas repaint is engine-owned.

import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import type { EditorFileRead } from "@/lib/bindings/EditorFileRead";
import {
  createEditorState,
  baseName,
  extOf,
  WEB_AUDIO_EXTS,
  type Cut,
  type EditorState,
  type Suggestion,
  type WaveLabels,
} from "./types";
import { computePeaks, computePeakGain, computeJinglePeaks } from "./peaks";
import {
  clampMain,
  clampPlayable,
  effIntroDur,
  effOutroDur,
  fitAll,
  getLayoutGeom,
  maxPlayableSec,
  panBy,
  secToX,
  xToMainSec,
  xToSec,
} from "./geometry";
import {
  addCut,
  deleteCut as deleteCutModel,
  getKeepSegs,
  getRemainingDuration,
  pushCutHistory,
  redoCut,
  snapOutOfCut,
  undoCut,
} from "./cuts";
import { drawMinimap, drawWaveform, type WaveColors } from "./render";

const CANVAS_HEIGHT = 200;
const MINIMAP_HEIGHT = 44;

/** Structural snapshot React reads. Recreated only when `version` bumps. */
export interface EditorSnapshot {
  version: number;
  filePath: string;
  fileName: string;
  hasFile: boolean;
  loading: boolean;
  error: string | null;
  duration: number;
  isPlaying: boolean;
  isPreview: boolean;
  cuts: Cut[];
  remainingSec: number;
  removedSec: number;
  clipCount: number;
  audioGainDb: number;
  normalized: boolean;
  includeIntroOutro: boolean;
  canUndo: boolean;
  canRedo: boolean;
  hasIntro: boolean;
  hasOutro: boolean;
  introDuration: number;
  outroDuration: number;
  suggestionCount: number;
  /** The longest detected sermon/speech block, for the one-click auto-trim. */
  sermon: { start: number; end: number; minutes: number } | null;
}

export class EditorEngine {
  private state: EditorState = createEditorState();
  private canvas: HTMLCanvasElement | null = null;
  private minimap: HTMLCanvasElement | null = null;
  private colors: WaveColors = { surface: "#111827", accent: "#f0bb47" };
  private drawRaf = 0;
  private version = 0;
  private snapshot: EditorSnapshot;
  private subscribers = new Set<() => void>();
  private loading = false;
  private error: string | null = null;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private labelsOverride: WaveLabels | null = null;

  /** Per-frame playhead callback (timecode). Set by the React shell. */
  onTick: ((sec: number, isPlaying: boolean) => void) | null = null;

  constructor() {
    this.snapshot = this.buildSnapshot();
  }

  // ── React glue ──────────────────────────────────────────────────────────

  subscribe = (cb: () => void): (() => void) => {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  };

  getSnapshot = (): EditorSnapshot => this.snapshot;

  private buildSnapshot(): EditorSnapshot {
    const s = this.state;
    return {
      version: this.version,
      filePath: s.filePath,
      fileName: s.filePath ? baseName(s.filePath) : "",
      hasFile: !!s.audioBuffer,
      loading: this.loading,
      error: this.error,
      duration: s.duration,
      isPlaying: s.isPlaying,
      isPreview: s.isPreview,
      cuts: s.cuts.map((c) => ({ ...c })),
      remainingSec: s.duration ? getRemainingDuration(s) : 0,
      removedSec: s.duration ? s.duration - getRemainingDuration(s) : 0,
      clipCount: s.clipTimes.length,
      audioGainDb: s.audioGainDb,
      normalized: s.audioGainDb !== 0,
      includeIntroOutro: s.includeIntroOutro,
      canUndo:
        s.cutHistoryIdx >= 0 && (s.cutHistoryIdx > 0 || s.cuts.length > 0),
      canRedo: s.cutHistoryIdx < s.cutHistory.length - 1,
      hasIntro: !!s.introBuffer,
      hasOutro: !!s.outroBuffer,
      introDuration: s.introDuration,
      outroDuration: s.outroDuration,
      suggestionCount: s.suggestions.length,
      sermon: this.findSermonBlock(),
    };
  }

  /** The longest sermon block (or, failing that, the longest speech block) —
   *  what the auto-trim banner offers to isolate. */
  private findSermonBlock(): {
    start: number;
    end: number;
    minutes: number;
  } | null {
    const pick = (type: string) =>
      this.state.suggestions
        .filter((s) => s.type === type)
        .reduce<
          (typeof this.state.suggestions)[number] | null
        >((best, s) => (!best || s.duration > best.duration ? s : best), null);
    const block = pick("sermon") ?? pick("speech");
    if (!block || block.duration < 60) return null;
    return {
      start: block.start,
      end: block.end,
      minutes: Math.round(block.duration / 60),
    };
  }

  /** Bump version + rebuild snapshot + notify React subscribers. */
  private emit(): void {
    this.version++;
    this.snapshot = this.buildSnapshot();
    for (const cb of this.subscribers) cb();
  }

  // ── Canvas attach / sizing ────────────────────────────────────────────────

  attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.readColors();
    canvas.addEventListener("mousedown", this.onDown);
    canvas.addEventListener("mousemove", this.onMove);
    canvas.addEventListener("mouseup", this.onUp);
    canvas.addEventListener("mouseleave", this.onLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    this.syncCanvasSize();
    this.scheduleDraw();
  }

  attachMinimap(canvas: HTMLCanvasElement): void {
    this.minimap = canvas;
    canvas.addEventListener("mousedown", this.onMinimapDown);
    window.addEventListener("mousemove", this.onMinimapMove);
    window.addEventListener("mouseup", this.onMinimapUp);
    this.drawMinimapNow();
  }

  private readColors(): void {
    try {
      const cs = getComputedStyle(document.documentElement);
      const surface = cs.getPropertyValue("--sr-ink-900").trim();
      const accent = cs.getPropertyValue("--sr-gold").trim();
      this.colors = {
        surface: surface || "#111827",
        accent: accent || "#f0bb47",
      };
    } catch {
      /* non-DOM test env — keep defaults */
    }
  }

  private syncCanvasSize(): void {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.height = CANVAS_HEIGHT + "px";
    const w =
      this.canvas.clientWidth ||
      this.canvas.parentElement?.getBoundingClientRect().width ||
      0;
    if (!w) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(CANVAS_HEIGHT * dpr);
  }

  /** Re-measure + repaint after a container resize. */
  resize(): void {
    this.syncCanvasSize();
    this.scheduleDraw();
    this.drawMinimapNow();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  private scheduleDraw(): void {
    if (this.drawRaf) return;
    this.drawRaf = requestAnimationFrame(() => {
      this.drawRaf = 0;
      this.draw();
    });
  }

  private currentSec(): number {
    const s = this.state;
    if (s.isPlaying && s.audioCtx) {
      return s.playStartSec + (s.audioCtx.currentTime - s.playStartCtxTime);
    }
    return s.playStartSec;
  }

  private draw(): void {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.width / dpr;
    const H = this.canvas.height / dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    drawWaveform(this.state, ctx, W, H, this.colors, this.currentSec());
    ctx.restore();
  }

  private drawMinimapNow(): void {
    if (!this.minimap) return;
    const ctx = this.minimap.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = this.minimap.parentElement?.clientWidth ?? 0;
    if (!W) return;
    this.minimap.style.width = W + "px";
    this.minimap.style.height = MINIMAP_HEIGHT + "px";
    this.minimap.width = W * dpr;
    this.minimap.height = MINIMAP_HEIGHT * dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    drawMinimap(this.state, ctx, W, MINIMAP_HEIGHT, this.colors);
    // Viewport box drawn directly on the minimap (no DOM overlay).
    if (this.state.duration) {
      const x1 = (this.state.vpStart / this.state.duration) * W;
      const x2 = (this.state.vpEnd / this.state.duration) * W;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(
        x1 + 0.5,
        0.5,
        Math.max(2, x2 - x1) - 1,
        MINIMAP_HEIGHT - 1,
      );
      ctx.fillStyle = "rgba(240,187,71,0.10)";
      ctx.fillRect(x1, 0, Math.max(2, x2 - x1), MINIMAP_HEIGHT);
    }
    ctx.restore();
  }

  // ── File loading (Web Audio; backend fallback for bytes) ──────────────────

  async loadFile(path: string): Promise<void> {
    const seq = ++this.state.loadSeq;
    this.stop();
    const prevCtx = this.state.audioCtx;
    this.state.audioCtx = null;
    if (prevCtx) {
      try {
        await prevCtx.close();
      } catch {
        /* ignore */
      }
      if (seq !== this.state.loadSeq) return;
    }

    // Reset per-file state
    const s = this.state;
    s.cuts = [];
    s.cutHistory = [];
    s.cutHistoryIdx = -1;
    s.suggestions = [];
    s.filePath = path;
    s.peaks = null;
    s.audioBuffer = null;
    s.playStartSec = 0;
    s.audioGainDb = 0;
    s.clipTimes = [];
    s.meta = {
      title: baseName(path)
        .replace(/\.[^.]+$/, "")
        .replace(/_redigert(_\d+)?$/, "")
        .replace(/_mastert$/, "")
        .replace(/_/g, " "),
      speaker: "",
      description: "",
      chapters: [],
    };
    this.loading = true;
    this.error = null;
    this.emit();

    try {
      const ctx = new AudioContext();
      const arrayBuf = await this.readFileBytes(path);
      if (seq !== this.state.loadSeq) {
        ctx.close().catch(() => {});
        return;
      }
      const buf = await ctx.decodeAudioData(arrayBuf);
      if (seq !== this.state.loadSeq) {
        ctx.close().catch(() => {});
        return;
      }
      s.audioCtx = ctx;
      s.audioBuffer = buf;
      s.duration = buf.duration;
      s.peaks = computePeaks(s, buf);
      fitAll(s);
      // Restore unsaved cuts from a previous session that ended abruptly (the
      // draft is written every edit and cleared on export — finding one means
      // we were closed mid-edit).
      await this.restoreDraft(path, seq);
      // A newer load may have started during restoreDraft's await — don't let
      // this stale load flip `loading`/emit over the newer one's state.
      if (seq !== this.state.loadSeq) return;
      this.loading = false;
      this.emit();
      this.syncCanvasSize();
      this.scheduleDraw();
      this.drawMinimapNow();
    } catch (e) {
      if (seq !== this.state.loadSeq) return;
      this.loading = false;
      this.error = e instanceof Error ? e.message : "Kunne ikke laste lydfilen";
      this.emit();
    }
  }

  /** Read file bytes for Web Audio decode. Asset protocol + fetch first
   *  (zero-copy, handles large files); `editor_read_file` as a fallback when
   *  fetch is unavailable (e.g. exotic path) or blocked. */
  private async readFileBytes(path: string): Promise<ArrayBuffer> {
    const ext = extOf(path);
    try {
      const resp = await fetch(convertFileSrc(path));
      if (resp.ok) return await resp.arrayBuffer();
    } catch {
      /* fall through to backend */
    }
    // Backend fallback — only for browser-decodable formats in Phase 1.
    if (WEB_AUDIO_EXTS.has(ext)) {
      const read = await invoke<EditorFileRead>("editor_read_file", {
        mediaPath: path,
      });
      if (read.bytes && read.bytes.length > 0) {
        return new Uint8Array(read.bytes).buffer;
      }
    }
    throw new Error(
      "Fant ingen lyddata i filen (eller filen er for stor for direkte avspilling).",
    );
  }

  // ── Cut-draft persistence (crash recovery) ────────────────────────────────

  /** Debounced (1.5 s) write of the live cut plan to the `.cuts-draft` sidecar,
   *  so a crash mid-edit doesn't lose the work. */
  private scheduleDraftSave(): void {
    const path = this.state.filePath;
    if (!path) return;
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null;
      const value = {
        cuts: this.state.cuts.map((c) => ({ ...c })),
        audioGainDb: this.state.audioGainDb,
        ts: Date.now(),
      };
      invoke<boolean>("editor_write_sidecar", {
        mediaPath: path,
        sidecar: "cutsDraft",
        value,
      }).catch(() => {});
    }, 1500);
  }

  private async restoreDraft(path: string, seq: number): Promise<void> {
    try {
      const draft = await invoke<{
        cuts?: { start: number; end: number }[];
        audioGainDb?: number;
        ts?: number;
      } | null>("editor_read_sidecar", {
        mediaPath: path,
        sidecar: "cutsDraft",
      });
      if (seq !== this.state.loadSeq) return;
      if (!draft || !Array.isArray(draft.cuts) || draft.cuts.length === 0)
        return;
      // Ignore drafts older than 7 days (avoid surprising months-old leftovers).
      const ageMs = draft.ts ? Date.now() - draft.ts : 0;
      if (draft.ts && ageMs > 7 * 86400_000) return;
      this.state.cuts = draft.cuts.filter(
        (c) =>
          typeof c.start === "number" &&
          typeof c.end === "number" &&
          c.end > c.start,
      );
      this.state.cutHistory = [JSON.parse(JSON.stringify(this.state.cuts))];
      this.state.cutHistoryIdx = 0;
      if (typeof draft.audioGainDb === "number")
        this.state.audioGainDb = draft.audioGainDb;
    } catch {
      /* no draft / sidecar unavailable */
    }
  }

  /** Remove the draft after a successful export (or on close). */
  clearDraft(): void {
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    const path = this.state.filePath;
    if (path) {
      invoke<boolean>("editor_delete_sidecar", {
        mediaPath: path,
        sidecar: "cutsDraft",
      }).catch(() => {});
    }
  }

  closeFile(): void {
    this.stop();
    // Flush a pending draft for the file we're leaving (don't delete it — a
    // reopen should restore unsaved cuts).
    if (this.draftTimer) {
      clearTimeout(this.draftTimer);
      this.draftTimer = null;
    }
    const prevCtx = this.state.audioCtx;
    this.state.audioCtx = null;
    if (prevCtx) prevCtx.close().catch(() => {});
    this.state = createEditorState();
    if (this.labelsOverride) this.state.labels = this.labelsOverride;
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
  }

  // ── Playback (Web Audio, with preview cut-skip + intro/outro) ─────────────

  togglePlay(preview: boolean): void {
    if (this.state.isPlaying && this.state.isPreview === preview) {
      this.stop();
      return;
    }
    this.stop();
    this.startPlay(preview);
  }

  private startPlay(preview: boolean): void {
    const s = this.state;
    if (!s.audioBuffer || !s.audioCtx) return;
    if (s.audioCtx.state === "suspended") s.audioCtx.resume().catch(() => {});

    s.playStartSec = snapOutOfCut(s, s.playStartSec, maxPlayableSec(s));
    s.isPreview = preview;
    s.loopStartSec = s.playStartSec;

    const introOn = s.includeIntroOutro && !!s.introBuffer;
    const outroOn = s.includeIntroOutro && !!s.outroBuffer;
    const inIntro = s.playStartSec < 0 && introOn;
    const inOutro = s.playStartSec > s.duration && outroOn;
    const mainStartSec = inIntro
      ? 0
      : inOutro
        ? s.duration
        : Math.max(0, s.playStartSec);

    s.isPlaying = true;
    s.playStartCtxTime = s.audioCtx.currentTime;

    let when = s.audioCtx.currentTime;
    const nodes: AudioBufferSourceNode[] = [];
    const mixGain = s.audioCtx.createGain();
    mixGain.gain.value =
      s.audioGainDb === 0 ? 1 : Math.pow(10, s.audioGainDb / 20);
    mixGain.connect(s.audioCtx.destination);

    if (introOn && s.playStartSec < s.duration && s.introBuffer) {
      const iDur = s.introBuffer.duration;
      const introOffset = inIntro
        ? Math.max(0, effIntroDur(s) + s.playStartSec)
        : 0;
      const playDur = iDur - introOffset;
      if (playDur > 0.01) {
        const introNode = s.audioCtx.createBufferSource();
        introNode.buffer = s.introBuffer;
        introNode.connect(mixGain);
        introNode.start(when, introOffset, playDur);
        when += playDur;
        nodes.push(introNode);
      }
    }

    if (!inOutro) {
      const allSegs: Cut[] = preview
        ? getKeepSegs(s)
        : [{ start: 0, end: s.duration }];
      const segments = allSegs.filter((seg) => seg.end > mainStartSec);
      let firstMainSec = -1;
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const offset = i === 0 ? Math.max(0, mainStartSec - seg.start) : 0;
        const dur = seg.end - seg.start - offset;
        if (dur <= 0.01) continue;
        if (firstMainSec < 0) firstMainSec = seg.start + offset;
        const node = s.audioCtx.createBufferSource();
        node.buffer = s.audioBuffer;
        node.connect(mixGain);
        node.start(when, seg.start + offset, dur);
        when += dur;
        nodes.push(node);
      }
      if (!inIntro && firstMainSec >= 0 && firstMainSec > mainStartSec + 0.01) {
        s.playStartSec = firstMainSec;
      }
    }

    s.sourceNodes = nodes;

    if (outroOn && s.outroBuffer) {
      const outroOffset = inOutro
        ? Math.max(0, s.playStartSec - s.duration)
        : 0;
      const oDur = s.outroBuffer.duration - outroOffset;
      if (oDur > 0.01) {
        const outroNode = s.audioCtx.createBufferSource();
        outroNode.buffer = s.outroBuffer;
        outroNode.connect(mixGain);
        outroNode.start(when, outroOffset, oDur);
        nodes.push(outroNode);
      }
    }

    if (nodes.length === 0) {
      s.isPlaying = false;
      return;
    }

    nodes[nodes.length - 1]?.addEventListener("ended", () => {
      if (!s.isPlaying) return;
      if (s.isLooping) {
        this.stop();
        s.playStartSec = s.loopStartSec;
        this.startPlay(s.isPreview);
      } else {
        s.isPlaying = false;
        cancelAnimationFrame(s.rafId);
        this.emit();
        this.scheduleDraw();
      }
    });

    this.emit();
    this.animate();
  }

  stop(): void {
    const s = this.state;
    for (const n of s.sourceNodes) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
    }
    s.sourceNodes = [];
    if (s.isPlaying && s.audioCtx) {
      s.playStartSec = clampPlayable(
        s,
        s.playStartSec + (s.audioCtx.currentTime - s.playStartCtxTime),
      );
    }
    s.isPlaying = false;
    cancelAnimationFrame(s.rafId);
    this.emit();
    this.scheduleDraw();
  }

  private animate = (): void => {
    const s = this.state;
    if (!s.isPlaying || !s.audioCtx) return;
    const curSec =
      s.playStartSec + (s.audioCtx.currentTime - s.playStartCtxTime);
    this.onTick?.(curSec, true);
    this.autoScrollToPlayhead(curSec);
    this.draw();
    s.rafId = requestAnimationFrame(this.animate);
  };

  private autoScrollToPlayhead(curSec: number): void {
    const s = this.state;
    if (curSec < 0 || curSec > s.duration) return;
    const span = s.vpEnd - s.vpStart;
    if (curSec > s.vpEnd - span * 0.1) {
      s.vpStart = curSec - span * 0.05;
      s.vpEnd = s.vpStart + span;
      if (s.vpEnd > s.duration) {
        s.vpEnd = s.duration;
        s.vpStart = Math.max(0, s.duration - span);
      }
      this.drawMinimapNow();
    }
  }

  // ── Seek / navigation ─────────────────────────────────────────────────────

  seekTo(sec: number): void {
    const s = this.state;
    this.stop();
    s.playStartSec = snapOutOfCut(s, clampPlayable(s, sec), maxPlayableSec(s));
    const mainPlayhead = clampMain(s, s.playStartSec);
    if (mainPlayhead < s.vpStart || mainPlayhead > s.vpEnd) {
      const span = s.vpEnd - s.vpStart;
      s.vpStart = Math.max(0, mainPlayhead - span * 0.3);
      s.vpEnd = Math.min(s.duration, s.vpStart + span);
      this.drawMinimapNow();
    }
    this.onTick?.(s.playStartSec, false);
    this.scheduleDraw();
  }

  seekBy(secs: number): void {
    const s = this.state;
    this.stop();
    s.playStartSec = clampPlayable(s, s.playStartSec + secs);
    const mainPlayhead = clampMain(s, s.playStartSec);
    if (mainPlayhead < s.vpStart || mainPlayhead > s.vpEnd) {
      const half = (s.vpEnd - s.vpStart) / 2;
      s.vpStart = Math.max(0, mainPlayhead - half);
      s.vpEnd = Math.min(s.duration, s.vpStart + half * 2);
      this.drawMinimapNow();
    }
    this.onTick?.(s.playStartSec, false);
    this.scheduleDraw();
  }

  jumpToCutBoundary(dir: 1 | -1): void {
    const s = this.state;
    if (s.cuts.length === 0) return;
    const ph = clampMain(s, s.playStartSec);
    const points: number[] = [];
    for (const c of s.cuts) points.push(c.start, c.end);
    points.sort((a, b) => a - b);
    let target: number | null = null;
    if (dir > 0) target = points.find((p) => p > ph + 0.05) ?? null;
    else {
      for (let i = points.length - 1; i >= 0; i--) {
        if (points[i] < ph - 0.05) {
          target = points[i];
          break;
        }
      }
    }
    if (target == null) return;
    this.seekTo(target);
  }

  previewCut(cut: Cut): void {
    const s = this.state;
    this.stop();
    const PRE_ROLL = 3;
    s.playStartSec = Math.max(0, cut.start - PRE_ROLL);
    if (s.playStartSec < s.vpStart || s.playStartSec > s.vpEnd) {
      const half = (s.vpEnd - s.vpStart) / 2;
      s.vpStart = Math.max(0, s.playStartSec - half * 0.3);
      s.vpEnd = Math.min(s.duration, s.vpStart + half * 2);
      this.drawMinimapNow();
    }
    this.startPlay(false);
  }

  // ── Viewport ───────────────────────────────────────────────────────────────

  zoom(factor: number): void {
    const s = this.state;
    const center = (s.vpStart + s.vpEnd) / 2;
    const span = (s.vpEnd - s.vpStart) * factor;
    s.vpStart = Math.max(0, center - span / 2);
    s.vpEnd = Math.min(s.duration, s.vpStart + span);
    if (s.vpEnd - s.vpStart < 0.5) s.vpEnd = s.vpStart + 0.5;
    this.scheduleDraw();
    this.drawMinimapNow();
  }

  fitView(): void {
    fitAll(this.state);
    this.scheduleDraw();
    this.drawMinimapNow();
  }

  // ── Cut mutations ──────────────────────────────────────────────────────────

  deleteCut(i: number): void {
    deleteCutModel(this.state, i);
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
  }

  clearAllCuts(): void {
    this.state.cuts = [];
    pushCutHistory(this.state);
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
  }

  undo(): void {
    undoCut(this.state);
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
  }

  redo(): void {
    redoCut(this.state);
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
  }

  // ── Normalize (peak gain) ───────────────────────────────────────────────────

  /** Returns true if a non-zero gain was applied; false if already at target. */
  normalizeToPeak(): boolean {
    if (!this.state.peaks) return false;
    const gain = computePeakGain(this.state.peaks);
    this.state.audioGainDb = gain;
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
    return gain !== 0;
  }

  resetNormalize(): void {
    this.state.audioGainDb = 0;
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
  }

  setIncludeIntroOutro(on: boolean): void {
    this.state.includeIntroOutro = on;
    this.emit();
    this.scheduleDraw();
  }

  // ── Intro / outro jingles (decoded client-side for the dimmed slots + the
  //    preview playback; the paths also go to the export seam) ───────────────

  private async decodeJingle(path: string): Promise<AudioBuffer> {
    const ab = await this.readFileBytes(path);
    const ctx = new AudioContext();
    try {
      return await ctx.decodeAudioData(ab);
    } finally {
      ctx.close().catch(() => {});
    }
  }

  /** Load (or, with `null`, clear) the intro jingle. */
  async setIntroFromPath(path: string | null): Promise<void> {
    const s = this.state;
    if (!path) {
      s.introBuffer = null;
      s.introDuration = 0;
      s.introPeaks = null;
    } else {
      try {
        const buf = await this.decodeJingle(path);
        s.introBuffer = buf;
        s.introDuration = buf.duration;
        s.introPeaks = computeJinglePeaks(buf);
      } catch {
        s.introBuffer = null;
        s.introDuration = 0;
        s.introPeaks = null;
      }
    }
    this.emit();
    this.scheduleDraw();
  }

  /** Load (or, with `null`, clear) the outro jingle. */
  async setOutroFromPath(path: string | null): Promise<void> {
    const s = this.state;
    if (!path) {
      s.outroBuffer = null;
      s.outroDuration = 0;
      s.outroPeaks = null;
    } else {
      try {
        const buf = await this.decodeJingle(path);
        s.outroBuffer = buf;
        s.outroDuration = buf.duration;
        s.outroPeaks = computeJinglePeaks(buf);
      } catch {
        s.outroBuffer = null;
        s.outroDuration = 0;
        s.outroPeaks = null;
      }
    }
    this.emit();
    this.scheduleDraw();
  }

  /** Override the canvas overlay labels (segment names, sections, tooltip) with
   *  translated strings. Persists across closeFile so the language sticks. */
  setLabels(labels: WaveLabels): void {
    this.labelsOverride = labels;
    this.state.labels = labels;
    this.scheduleDraw();
  }

  // ── Segment detection (speech / music / silence / sermon) ──────────────────

  /** Set the detected segments that paint behind the waveform and that cut
   *  edges snap to. Called by the screen after `editor_segments` resolves. */
  setSuggestions(suggestions: Suggestion[]): void {
    this.state.suggestions = suggestions;
    this.emit();
    this.scheduleDraw();
  }

  /** One-click "isolate the sermon": cut everything before the longest sermon/
   *  speech block and everything after it. Returns true if it made cuts. */
  autoTrimToSermon(): boolean {
    const block = this.findSermonBlock();
    if (!block) return false;
    const s = this.state;
    s.cuts = [];
    if (block.start > 0.2) addCut(s, 0, block.start);
    if (block.end < s.duration - 0.2) addCut(s, block.end, s.duration);
    this.emit();
    this.scheduleDraw();
    this.drawMinimapNow();
    this.scheduleDraftSave();
    return s.cuts.length > 0;
  }

  /** Cuts for `editor_export.cutRegions`. */
  exportCutRegions(): Cut[] {
    return this.state.cuts.map((c) => ({ ...c }));
  }

  // ── Pointer input (ported from editor/canvas-input.ts) ─────────────────────

  private onDown = (e: MouseEvent): void => {
    const s = this.state;
    if (!s.peaks || e.button !== 0 || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const extSec = xToSec(s, e.clientX - rect.left, rect.width);
    const mainSec = xToMainSec(s, e.clientX - rect.left, rect.width);

    const threshold = ((s.vpEnd - s.vpStart) / rect.width) * 10;
    for (let i = 0; i < s.cuts.length; i++) {
      if (Math.abs(mainSec - s.cuts[i].start) < threshold) {
        s.handleDrag = { cutIdx: i, side: "start" };
        return;
      }
      if (Math.abs(mainSec - s.cuts[i].end) < threshold) {
        s.handleDrag = { cutIdx: i, side: "end" };
        return;
      }
    }

    const yInCanvas = e.clientY - rect.top;
    const playX = secToX(s, s.playStartSec, rect.width);
    if (Math.abs(e.clientX - rect.left - playX) < 12 && yInCanvas < 28) {
      s.playheadDragging = true;
      this.stop();
      return;
    }

    s.dragStartSec = clampMain(s, extSec);
    s.dragEndSec = s.dragStartSec;
    s.isDragging = true;
  };

  private onMove = (e: MouseEvent): void => {
    const s = this.state;
    if (!s.peaks || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const extSec = xToSec(s, e.clientX - rect.left, rect.width);
    const mainSec = xToMainSec(s, e.clientX - rect.left, rect.width);

    if (s.handleDrag) {
      const c = s.cuts[s.handleDrag.cutIdx];
      const snapped = e.shiftKey
        ? mainSec
        : this.snapToSegmentBoundary(mainSec, rect.width);
      if (s.handleDrag.side === "start")
        c.start = Math.max(0, Math.min(c.end - 0.1, snapped));
      else c.end = Math.min(s.duration, Math.max(c.start + 0.1, snapped));
      this.scheduleDraw();
      return;
    }

    if (s.playheadDragging) {
      s.playStartSec = clampPlayable(s, extSec);
      this.onTick?.(s.playStartSec, false);
      this.scheduleDraw();
      return;
    }

    s.hoverSec = extSec;

    const threshold = ((s.vpEnd - s.vpStart) / rect.width) * 10;
    const nearBoundary = s.cuts.some(
      (c) =>
        Math.abs(mainSec - c.start) < threshold ||
        Math.abs(mainSec - c.end) < threshold,
    );
    const overCut = s.cuts.some((c) => mainSec >= c.start && mainSec <= c.end);
    const nearPlayhead =
      Math.abs(e.clientX - rect.left - secToX(s, s.playStartSec, rect.width)) <
        12 && e.clientY - rect.top < 28;
    this.canvas.style.cursor = nearBoundary
      ? "ew-resize"
      : nearPlayhead
        ? "col-resize"
        : overCut
          ? "pointer"
          : "crosshair";

    if (s.isDragging) s.dragEndSec = clampMain(s, extSec);
    this.scheduleDraw();
  };

  private onUp = (e: MouseEvent): void => {
    const s = this.state;
    if (!s.peaks || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const extSec = xToSec(s, e.clientX - rect.left, rect.width);
    const upMainSec = xToMainSec(s, e.clientX - rect.left, rect.width);

    if (s.handleDrag) {
      s.handleDrag = null;
      s.cuts.sort((a, b) => a.start - b.start);
      pushCutHistory(s);
      this.emit();
      this.scheduleDraw();
      this.drawMinimapNow();
      this.scheduleDraftSave();
      return;
    }

    if (s.playheadDragging) {
      s.playheadDragging = false;
      s.playStartSec = snapOutOfCut(s, s.playStartSec, maxPlayableSec(s));
      this.onTick?.(s.playStartSec, false);
      this.scheduleDraw();
      return;
    }

    if (!s.isDragging) return;
    s.isDragging = false;

    if (Math.abs(upMainSec - s.dragStartSec) > 0.1) {
      const a = e.shiftKey
        ? s.dragStartSec
        : this.snapToSegmentBoundary(s.dragStartSec, rect.width);
      const b = e.shiftKey
        ? upMainSec
        : this.snapToSegmentBoundary(upMainSec, rect.width);
      addCut(s, a, b);
      this.emit();
      this.scheduleDraftSave();
    } else {
      this.stop();
      s.playStartSec = snapOutOfCut(
        s,
        clampPlayable(s, extSec),
        maxPlayableSec(s),
      );
      this.onTick?.(s.playStartSec, false);
    }
    s.dragStartSec = -1;
    s.dragEndSec = -1;
    this.scheduleDraw();
    this.drawMinimapNow();
  };

  private onLeave = (): void => {
    const s = this.state;
    s.hoverSec = -99999;
    if (s.handleDrag) {
      s.handleDrag = null;
      s.cuts.sort((a, b) => a.start - b.start);
      pushCutHistory(s);
      this.emit();
      this.scheduleDraw();
      this.drawMinimapNow();
      this.scheduleDraftSave();
      return;
    }
    if (s.playheadDragging) {
      s.playheadDragging = false;
      this.scheduleDraw();
      return;
    }
    if (s.isDragging) {
      s.isDragging = false;
      if (Math.abs(s.dragEndSec - s.dragStartSec) > 0.1) {
        addCut(s, s.dragStartSec, s.dragEndSec);
        this.emit();
        this.scheduleDraftSave();
      }
      s.dragStartSec = -1;
      s.dragEndSec = -1;
      this.scheduleDraw();
      this.drawMinimapNow();
    } else {
      this.scheduleDraw();
    }
  };

  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    const s = this.state;
    if (!s.peaks || !this.canvas) return;
    const rect = this.canvas.getBoundingClientRect();
    const mainSec = xToMainSec(s, e.clientX - rect.left, rect.width);
    const idx = s.cuts.findIndex((c) => mainSec >= c.start && mainSec <= c.end);
    if (idx >= 0) this.deleteCut(idx);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const s = this.state;
    if (!this.canvas) return;
    if (e.ctrlKey || e.metaKey) {
      const rect = this.canvas.getBoundingClientRect();
      const mouseSec = xToMainSec(s, e.clientX - rect.left, rect.width);
      const factor = e.deltaY > 0 ? 1.25 : 0.75;
      const span = (s.vpEnd - s.vpStart) * factor;
      const frac = (mouseSec - s.vpStart) / (s.vpEnd - s.vpStart);
      s.vpStart = Math.max(0, mouseSec - frac * span);
      s.vpEnd = Math.min(s.duration, s.vpStart + span);
      if (s.vpEnd - s.vpStart < 0.5) s.vpEnd = s.vpStart + 0.5;
      this.scheduleDraw();
      this.drawMinimapNow();
    } else {
      panBy(s, (e.deltaY * (s.vpEnd - s.vpStart)) / 800);
      this.scheduleDraw();
      this.drawMinimapNow();
    }
  };

  private snapToSegmentBoundary(sec: number, W: number): number {
    const s = this.state;
    if (!s.suggestions.length) return sec;
    const threshold = Math.max(
      0.15,
      ((s.vpEnd - s.vpStart) / Math.max(1, W)) * 8,
    );
    let closest = sec;
    let minDist = threshold;
    for (const seg of s.suggestions) {
      for (const t of [seg.start, seg.end]) {
        const d = Math.abs(sec - t);
        if (d < minDist) {
          minDist = d;
          closest = t;
        }
      }
    }
    return closest;
  }

  // ── Minimap drag ────────────────────────────────────────────────────────────

  private onMinimapDown = (e: MouseEvent): void => {
    this.state.minimapDragging = true;
    this.jumpViewportToMouse(e);
  };
  private onMinimapMove = (e: MouseEvent): void => {
    if (this.state.minimapDragging) this.jumpViewportToMouse(e);
  };
  private onMinimapUp = (): void => {
    this.state.minimapDragging = false;
  };

  private jumpViewportToMouse(e: MouseEvent): void {
    const s = this.state;
    if (!s.duration || !this.minimap) return;
    const rect = this.minimap.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const center = frac * s.duration;
    const half = (s.vpEnd - s.vpStart) / 2;
    s.vpStart = Math.max(0, Math.min(s.duration - half * 2, center - half));
    s.vpEnd = s.vpStart + half * 2;
    this.scheduleDraw();
    this.drawMinimapNow();
  }

  // ── Teardown ────────────────────────────────────────────────────────────────

  destroy(): void {
    this.stop();
    if (this.canvas) {
      this.canvas.removeEventListener("mousedown", this.onDown);
      this.canvas.removeEventListener("mousemove", this.onMove);
      this.canvas.removeEventListener("mouseup", this.onUp);
      this.canvas.removeEventListener("mouseleave", this.onLeave);
      this.canvas.removeEventListener("wheel", this.onWheel);
      this.canvas.removeEventListener("contextmenu", this.onContextMenu);
    }
    if (this.minimap) {
      this.minimap.removeEventListener("mousedown", this.onMinimapDown);
    }
    window.removeEventListener("mousemove", this.onMinimapMove);
    window.removeEventListener("mouseup", this.onMinimapUp);
    if (this.drawRaf) cancelAnimationFrame(this.drawRaf);
    if (this.draftTimer) clearTimeout(this.draftTimer);
    const ctx = this.state.audioCtx;
    if (ctx) ctx.close().catch(() => {});
    this.subscribers.clear();
  }

  /** Layout geometry — exposed for tests / debugging. */
  layoutGeom(W: number) {
    return getLayoutGeom(this.state, W);
  }
  effIntroDur(): number {
    return effIntroDur(this.state);
  }
  effOutroDur(): number {
    return effOutroDur(this.state);
  }
}
