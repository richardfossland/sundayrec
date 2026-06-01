/**
 * Rediger — the editor. Ported from `sr-edit-search.jsx`. Two variants from the
 * design: an audio file (waveform + section cards) and a loaded video file
 * (synced video preview beside the waveform, video export formats). A small
 * file-type switch toggles between them so both designs are reachable; once a
 * file is loaded we auto-pick the variant from the probe (video → video).
 *
 * This screen is data-driven over the existing editor/whisper IPC contract
 * (mirrors `src/features/editor/EditorPanel.tsx` + `TranscribePanel.tsx`):
 *   - editor_load_recording / editor_peaks / editor_segments
 *   - editor_mastering_analyze (normalize/analyze) / editor_master_preview
 *   - editor_export
 *   - whisper_list_models / whisper_transcribe / whisper_export_transcript
 * Every wired value falls back to the original sample/empty state — the ffmpeg
 * and whisper commands sit behind default-off cargo features and reject with
 * `feature_disabled` in dev/test, so nothing here may crash on null.
 *
 * DESIGN: the exact `sr-*` markup, the Lydfil/Videofil ModeSwitch, the
 * Waveform, the file bar, the Collapsible cards and Norwegian copy are
 * preserved verbatim; only hardcoded sample values are swapped for live data
 * and the action buttons are wired.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Icon } from "../Icon";
import { Badge, Card, Collapsible, Meter, SegOpt, Toggle } from "../atoms";
import { waveformPath } from "@/features/editor/waveform";
import {
  clampMain,
  crossedMarker,
  fitAll,
  panBy,
  snapWithFeedback,
  wheelZoomFactor,
  xToSec,
  zoomBy,
  type Segment,
  type Viewport,
} from "@/features/editor/editorGeometry";
import { haptic, makeHapticThrottle } from "@/lib/haptics";
import { EDITOR_RECORDINGS_KEY } from "@/features/editor/queryKey";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorMediaInfo } from "@/lib/bindings/EditorMediaInfo";
import type { EditorPeaks } from "@/lib/bindings/EditorPeaks";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import type { EditorLoudness } from "@/lib/bindings/EditorLoudness";
import type { EditorExportRequest } from "@/lib/bindings/EditorExportRequest";
import type { EditorExportResult } from "@/lib/bindings/EditorExportResult";
import type { EditorMasterPreviewRequest } from "@/lib/bindings/EditorMasterPreviewRequest";
import type { EditorMasterPreviewResult } from "@/lib/bindings/EditorMasterPreviewResult";
import type { WhisperModelMeta } from "@/lib/bindings/WhisperModelMeta";
import type { TranscriptData } from "@/lib/bindings/TranscriptData";
import type { TranscriptExportFormat } from "@/lib/bindings/TranscriptExportFormat";
import type { EditorMasterApplyRequest } from "@/lib/bindings/EditorMasterApplyRequest";
import type { EditorMasterApplyResult } from "@/lib/bindings/EditorMasterApplyResult";
import type { EditorMasterProgress } from "@/lib/bindings/EditorMasterProgress";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";
import {
  buildTrimCuts,
  clock,
  effectiveTrim,
  fileExt,
  fileName,
  formatHms,
  mediaMeta,
  moveTrimEdge,
  peaksWindow,
  secToViewFrac,
  variantForMedia,
  viewportTicks,
  WAVE_BARS,
} from "./editor.helpers";

/** True when an IPC rejection is a default-build "feature off" error, so we can
 *  stay quiet rather than crash — mirrors EditorPanel/TranscribePanel. */
function isFeatureDisabled(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("feature_disabled");
}

/** `convertFileSrc`, but never throws — in dev/test (no Tauri host) it can be
 *  absent or reject, so we fall back to the raw path. The <audio>/<img> tag then
 *  fails to load gracefully (onError) rather than crashing the editor. */
function safeConvertFileSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** A short id for a mastering-apply job, used to correlate progress events and
 *  to cancel an in-flight apply. */
function makeJobId(): string {
  return `master-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The `.cuts-draft` sidecar shape this screen persists (reopen-ability for the
 *  Intro/Outro toggle + the trim bounds). Free JSON over the sidecar IPC. */
interface DraftSidecar {
  includeIntroOutro?: boolean;
  trimStart?: string;
  trimEnd?: string;
}

/** The `.meta` sidecar shape — the episode metadata form. */
interface MetaSidecar {
  title?: string;
  speaker?: string;
  description?: string;
}

/** Debounced (600 ms) write of a sidecar value for the loaded file. Skips the
 *  hydrate-driven render (so loading a draft never echoes straight back out) and
 *  swallows IPC rejection (the sidecar commands are infallible-ish but absent in
 *  dev/test). Pure plumbing around editor_write_sidecar. */
function useDebouncedSidecar(
  mediaPath: string | null,
  sidecar: "meta" | "cutsDraft",
  value: DraftSidecar | MetaSidecar,
  hydratingRef: React.MutableRefObject<boolean>,
) {
  useEffect(() => {
    if (!mediaPath || hydratingRef.current) return;
    const id = window.setTimeout(() => {
      invoke<boolean>("editor_write_sidecar", {
        mediaPath,
        sidecar,
        value,
      }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(id);
  }, [mediaPath, sidecar, value, hydratingRef]);
}

/** The mastering presets the design's single <select> picks from. The first is
 *  the "recommended" option shown by default; each maps to a core preset id. */
const MASTER_PRESETS = [
  {
    id: "speech-clear",
    labelKey: "editScreen.presetSpeechClear",
    label: "Tale — tydelig (anbefalt)",
  },
  {
    id: "speech-punchy",
    labelKey: "editScreen.presetStreaming",
    label: "Strømming (−14 LUFS)",
  },
  {
    id: "speech-natural",
    labelKey: "editScreen.presetNatural",
    label: "Naturlig (−19 LUFS)",
  },
  {
    id: "music-speech",
    labelKey: "editScreen.presetMusicSpeech",
    label: "Musikk + tale (−16 LUFS)",
  },
] as const;

/** Everything the editor screen + its two variants need, owned here so the
 *  Lydfil/Videofil markup stays a thin view over one IPC-backed model. */
type EditorModel = ReturnType<typeof useEditorModel>;

function useEditorModel() {
  const [selected, setSelected] = useState<string | null>(null);
  const [presetId, setPresetId] = useState<string>(MASTER_PRESETS[0].id);
  // Trim (Videofil) — free-text HH:MM:SS bounds; empty = the file's own bound.
  // Parsed + turned into cut regions at export time (see runExport).
  const [trimStart, setTrimStart] = useState("");
  const [trimEnd, setTrimEnd] = useState("");
  // Interactive timeline: the visible window + the playhead position. Reset to
  // fit-all / 0 whenever a file loads or closes (the duration changes below).
  const [viewport, setViewport] = useState<Viewport>(() => fitAll(0));
  const [playheadSec, setPlayheadSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  // Intro/Outro "include on export" toggle (persisted in the .cuts-draft
  // sidecar) and the Metadata form (persisted in the .meta sidecar).
  const [includeIntroOutro, setIncludeIntroOutro] = useState(true);
  const [metaTitle, setMetaTitle] = useState("");
  const [metaSpeaker, setMetaSpeaker] = useState("");
  const [metaDescription, setMetaDescription] = useState("");

  // The hidden <audio> element that backs playback + the playhead. It is owned
  // here (a ref) so play/pause/seek route through one source of truth and the
  // waveform stays a thin view. convertFileSrc turns the local path into the
  // asset:// URL the webview can load; if the asset protocol scope is closed it
  // simply fails to load and we degrade to a silent (no-audio) playhead.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // `true` once a load error fired (asset scope closed / unsupported) — keeps
  // the play button from pretending it can play.
  const [audioBroken, setAudioBroken] = useState(false);
  const assetSrc = useMemo(
    () => (selected ? safeConvertFileSrc(selected) : null),
    [selected],
  );

  const recordings = useQuery<RecordingRow[]>({
    queryKey: EDITOR_RECORDINGS_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });

  // Per-file passes are user-triggered mutations (decoding a service is not a
  // background fetch), exactly as EditorPanel does it.
  const loadMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorMediaInfo>("editor_load_recording", { inputPath: path }),
  });
  const peaksMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorPeaks>("editor_peaks", { inputPath: path }),
  });
  const segmentsMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorSegment[]>("editor_segments", { inputPath: path }),
  });
  // "Normaliser lydnivå" + "Analyser" both run the loudness measurement pass
  // (editor_mastering_analyze) — the same command EditorPanel's "Mål lydstyrke"
  // calls. (A standalone peak-to-−1 dBFS pass is a // TODO; analyze is the
  // wired, tested seam today.)
  const analyzeMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorLoudness>("editor_mastering_analyze", {
        inputPath: path,
        presetId,
      }),
  });
  const previewMutation = useMutation({
    mutationFn: (request: EditorMasterPreviewRequest) =>
      invoke<EditorMasterPreviewResult>("editor_master_preview", { request }),
  });
  const exportMutation = useMutation({
    mutationFn: (request: EditorExportRequest) =>
      invoke<EditorExportResult>("editor_export", { request }),
  });

  // Mastering APPLY (commit): the full two-pass render to a sibling
  // `*_mastert.<ext>` file, emitting `editor-master-progress` ticks under a job
  // id we own (so we can cancel). Distinct from the windowed preview above.
  const [masterJobId, setMasterJobId] = useState<string | null>(null);
  const [masterProgress, setMasterProgress] =
    useState<EditorMasterProgress | null>(null);
  const applyMutation = useMutation({
    mutationFn: (request: EditorMasterApplyRequest) =>
      invoke<EditorMasterApplyResult>("editor_master_apply", { request }),
  });

  const onMasterApply = useCallback(() => {
    if (!selected) return;
    const ext = fileExt(selected) || "mp3";
    const outputPath = selected.replace(
      /(\.[^./\\]+)?$/,
      `_mastert.${ext === "mp4" || ext === "mkv" || ext === "mov" ? "mp3" : ext}`,
    );
    const jobId = makeJobId();
    setMasterJobId(jobId);
    setMasterProgress(null);
    applyMutation.mutate(
      { inputPath: selected, outputPath, presetId, jobId, bitrate: null },
      { onSettled: () => setMasterJobId(null) },
    );
  }, [selected, presetId, applyMutation]);

  const onMasterCancel = useCallback(() => {
    if (masterJobId) {
      invoke<boolean>("editor_master_cancel", { jobId: masterJobId }).catch(
        () => {},
      );
    }
  }, [masterJobId]);

  // Live progress: subscribe to the apply ticks for the current job only.
  useEffect(() => {
    if (!masterJobId) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<EditorMasterProgress>("editor-master-progress", (e) => {
      if (e.payload.jobId === masterJobId) setMasterProgress(e.payload);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [masterJobId]);

  const onSelect = useCallback(
    (path: string) => {
      setSelected(path);
      setTrimStart("");
      setTrimEnd("");
      setIsPlaying(false);
      setAudioBroken(false);
      setMasterProgress(null);
      peaksMutation.reset();
      segmentsMutation.reset();
      analyzeMutation.reset();
      previewMutation.reset();
      exportMutation.reset();
      applyMutation.reset();
      // Probe (duration/streams) + waveform immediately on pick.
      loadMutation.mutate(path);
      peaksMutation.mutate(path);
    },
    [
      loadMutation,
      peaksMutation,
      segmentsMutation,
      analyzeMutation,
      previewMutation,
      exportMutation,
      applyMutation,
    ],
  );

  // "Åpne annen fil" — native picker, edit any audio/video on disk.
  const onPickFile = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "Lyd/video",
            extensions: [
              "mp3",
              "m4a",
              "aac",
              "wav",
              "flac",
              "mp4",
              "mkv",
              "mov",
            ],
          },
        ],
      });
      if (typeof picked === "string") onSelect(picked);
    } catch {
      /* dialog plugin unavailable in dev/test → no-op */
    }
  }, [onSelect]);

  const onCloseFile = useCallback(() => {
    setSelected(null);
    setTrimStart("");
    setTrimEnd("");
    setIsPlaying(false);
    setAudioBroken(false);
    setMasterProgress(null);
    setMetaTitle("");
    setMetaSpeaker("");
    setMetaDescription("");
    setIncludeIntroOutro(true);
    loadMutation.reset();
    peaksMutation.reset();
    segmentsMutation.reset();
    analyzeMutation.reset();
    previewMutation.reset();
    exportMutation.reset();
    applyMutation.reset();
  }, [
    loadMutation,
    peaksMutation,
    segmentsMutation,
    analyzeMutation,
    previewMutation,
    exportMutation,
    applyMutation,
  ]);

  const onNormalize = useCallback(() => {
    if (selected) analyzeMutation.mutate(selected);
  }, [selected, analyzeMutation]);

  const onAnalyze = useCallback(() => {
    if (selected) segmentsMutation.mutate(selected);
  }, [selected, segmentsMutation]);

  // "Marker preken automatisk": pick the longest speech/sermon segment from the
  // already-loaded analysis and mark it — move the playhead to its start and set
  // the trim bounds to it (so a follow-up export keeps just the sermon). If the
  // file hasn't been analysed yet, run the analysis first (the user can then
  // press the button again on the populated segment list).
  const onMarkSermon = useCallback(() => {
    if (!selected) return;
    const segs = segmentsMutation.data ?? [];
    const speech = segs.filter(
      (sg) => sg.kind === "speech" || sg.kind === "sermon",
    );
    if (speech.length === 0) {
      // Nothing to mark yet → kick off detection.
      segmentsMutation.mutate(selected);
      return;
    }
    const longest = speech.reduce((a, b) => (b.duration > a.duration ? b : a));
    setTrimStart(formatHms(longest.start));
    setTrimEnd(formatHms(longest.end));
    setPlayheadSec(longest.start);
  }, [selected, segmentsMutation]);

  const onPreview = useCallback(() => {
    if (!selected) return;
    previewMutation.mutate({
      inputPath: selected,
      presetId,
      startSec: 0,
      durationSec: 15,
    });
  }, [selected, presetId, previewMutation]);

  // "Mastre fil" / "Eksporter ferdig episode" — export with the chosen format +
  // mastering preset, applying the Videofil trim as cut regions (everything
  // before Start and after Slutt is removed). Empty trim → whole file.
  const runExport = useCallback(
    (format: string, withMaster: boolean) => {
      if (!selected) return;
      const folder = selected.replace(/[/\\][^/\\]*$/, "");
      const duration = loadMutation.data?.durationSec ?? 0;
      const base: EditorExportRequest = {
        inputPath: selected,
        cutRegions: buildTrimCuts(trimStart, trimEnd, duration),
        duration,
        format,
        outputFolder: folder,
        bitrate: null,
        bitDepth: null,
        masterPreset: withMaster ? presetId : null,
      };
      // "Begge" = export twice from the SAME trim + mastering plan: first the
      // full MP4 (video + audio), then an audio-only MP3. We fire mp4 and, once
      // it settles (success OR feature-disabled/error), fire mp3 — so the user
      // sees a single in-progress run that produces both files. onError on the
      // mutation keeps either pass a graceful no-op if the backend rejects.
      if (format === "begge") {
        exportMutation.mutate(
          { ...base, format: "mp4" },
          {
            onSettled: () => exportMutation.mutate({ ...base, format: "mp3" }),
          },
        );
        return;
      }
      exportMutation.mutate(base);
    },
    [selected, loadMutation.data, presetId, trimStart, trimEnd, exportMutation],
  );

  // Whenever the loaded file's duration changes (open / close / re-probe), refit
  // the viewport to the whole file and park the playhead at the start.
  const duration = loadMutation.data?.durationSec ?? 0;
  useEffect(() => {
    setViewport(fitAll(duration));
    setPlayheadSec(0);
  }, [duration]);

  // Interactive timeline gestures, all routed through the pure geometry model.
  const zoom = useCallback(
    (factor: number, anchorSec?: number) => {
      setViewport((vp) => zoomBy(vp, factor, duration, anchorSec));
    },
    [duration],
  );
  const pan = useCallback(
    (deltaSec: number) => {
      setViewport((vp) => panBy(vp, deltaSec, duration));
    },
    [duration],
  );
  const scrub = useCallback(
    (sec: number) => {
      const next = clampMain(sec, duration);
      setPlayheadSec(next);
      // Clicking/dragging the waveform seeks the backing audio so play resumes
      // from where you dropped the playhead.
      const a = audioRef.current;
      if (a && Number.isFinite(next)) {
        try {
          a.currentTime = next;
        } catch {
          /* not seekable yet → ignore */
        }
      }
    },
    [duration],
  );

  // ←/→ keyboard nudge: step the playhead by `deltaSec` (±1 s, ±5 s with shift).
  // Fires a subtle `levelChange` detent when nudging into the 0 / end wall so a
  // held arrow at the edge feels like it stopped. Reuses `scrub` for the seek.
  const nudgeHapticRef = useRef(makeHapticThrottle(140));
  const nudgePlayhead = useCallback(
    (deltaSec: number) => {
      setPlayheadSec((cur) => {
        const next = clampMain(cur + deltaSec, duration);
        if (next === cur && deltaSec !== 0)
          nudgeHapticRef.current("levelChange");
        const a = audioRef.current;
        if (a && Number.isFinite(next)) {
          try {
            a.currentTime = next;
          } catch {
            /* not seekable yet → ignore */
          }
        }
        return next;
      });
    },
    [duration],
  );

  // A throttled `levelChange` tap for "you've hit a hard limit" (trim min-gap /
  // file bound). Throttled so holding against the wall doesn't buzz every frame.
  const limitHapticRef = useRef(makeHapticThrottle(140));

  // A tiny one-deep undo for the trim fields, so the ⌘Z hint actually does
  // something on the audio/video editor (which edits via the trim window rather
  // than the cut-history machine). We snapshot the trim BEFORE a fresh drag
  // gesture begins; ⌘Z restores that snapshot. `null` = nothing to undo.
  const trimUndoRef = useRef<{ start: string; end: string } | null>(null);
  const trimDragLive = useRef(false);
  const canUndoTrim = useCallback(() => trimUndoRef.current != null, []);
  const undoTrim = useCallback(() => {
    const snap = trimUndoRef.current;
    if (!snap) return;
    trimUndoRef.current = null;
    setTrimStart(snap.start);
    setTrimEnd(snap.end);
    void haptic("generic");
  }, []);
  // Clear the "drag in progress" latch once a gesture ends (pointer-up clears
  // the live flag in the Waveform via onTrimCommit below).
  const onTrimCommit = useCallback(() => {
    trimDragLive.current = false;
  }, []);

  // Drag-to-trim on the waveform: move one KEEP-window edge to a second, then
  // write it back through the numeric trim fields (which stay the readout +
  // export source of truth). Clamped + ordered via the pure helpers. When the
  // requested second is past a limit (the clamp moved it), fire a subtle
  // `levelChange` haptic so you feel the detent.
  const onTrimEdge = useCallback(
    (edge: "start" | "end", sec: number) => {
      // Snapshot once at the start of a drag gesture so ⌘Z reverts the whole
      // drag, not each intermediate frame.
      if (!trimDragLive.current) {
        trimUndoRef.current = { start: trimStart, end: trimEnd };
        trimDragLive.current = true;
      }
      const win = effectiveTrim(trimStart, trimEnd, duration);
      const next = moveTrimEdge(edge, sec, win, duration);
      const landed = edge === "start" ? next.start : next.end;
      // >~30 ms of clamp = we're pressed against a limit → detent tap.
      if (Math.abs(landed - sec) > 0.03) limitHapticRef.current("levelChange");
      if (edge === "start") setTrimStart(formatHms(next.start));
      else setTrimEnd(formatHms(next.end));
    },
    [trimStart, trimEnd, duration],
  );

  // Play/pause the backing audio. Toggling sets `isPlaying`; the <audio>'s own
  // play/pause/ended events keep it honest (see EditScreen's <audio> handlers).
  const togglePlay = useCallback(() => {
    const a = audioRef.current;
    if (!a || audioBroken) return;
    if (a.paused) {
      // Resume from the current playhead so Space respects manual scrubs.
      if (Math.abs(a.currentTime - playheadSec) > 0.25) {
        try {
          a.currentTime = playheadSec;
        } catch {
          /* ignore */
        }
      }
      void a.play().catch(() => setAudioBroken(true));
    } else {
      a.pause();
    }
  }, [audioBroken, playheadSec]);

  // While playing, follow the audio clock on the animation frame so the playhead
  // glides smoothly rather than ticking on `timeupdate` (4 Hz). Parked when
  // paused so we don't spin a rAF loop for nothing.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused) setPlayheadSec(a.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // "Skip" → advance the playhead to the next segment boundary after the current
  // position (the start of the next detected segment), or to the file end when
  // none remain. Falls back to a no-op when there are no segments to skip past.
  const skipToNextBoundary = useCallback(() => {
    const segs = segmentsMutation.data ?? [];
    if (segs.length === 0) return;
    const boundaries = Array.from(
      new Set(segs.flatMap((sg) => [sg.start, sg.end])),
    ).sort((a, b) => a - b);
    const next = boundaries.find((b) => b > playheadSec + 0.001);
    setPlayheadSec(clampMain(next ?? duration, duration));
  }, [segmentsMutation.data, playheadSec, duration]);
  const hasSegments = (segmentsMutation.data ?? []).length > 0;

  // ── Sidecar persistence (reopen-ability) ──────────────────────────────────
  // On file load, hydrate the Intro/Outro toggle + trim from `.cuts-draft` and
  // the Metadata form from `.meta`. A `hydratingRef` gate stops the very first
  // populated render from echoing straight back out through the debounced save.
  const hydratingRef = useRef(false);
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    hydratingRef.current = true;
    Promise.all([
      invoke<DraftSidecar | null>("editor_read_sidecar", {
        mediaPath: selected,
        sidecar: "cutsDraft",
      }).catch(() => null),
      invoke<MetaSidecar | null>("editor_read_sidecar", {
        mediaPath: selected,
        sidecar: "meta",
      }).catch(() => null),
    ]).then(([draft, meta]) => {
      if (cancelled) return;
      if (draft && typeof draft === "object") {
        if (typeof draft.includeIntroOutro === "boolean") {
          setIncludeIntroOutro(draft.includeIntroOutro);
        }
        if (typeof draft.trimStart === "string") setTrimStart(draft.trimStart);
        if (typeof draft.trimEnd === "string") setTrimEnd(draft.trimEnd);
      }
      if (meta && typeof meta === "object") {
        if (typeof meta.title === "string") setMetaTitle(meta.title);
        if (typeof meta.speaker === "string") setMetaSpeaker(meta.speaker);
        if (typeof meta.description === "string") {
          setMetaDescription(meta.description);
        }
      }
      // Let the next change-driven save through (after this render settles).
      queueMicrotask(() => {
        hydratingRef.current = false;
      });
    });
    return () => {
      cancelled = true;
      hydratingRef.current = false;
    };
  }, [selected]);

  // Debounced write of the `.cuts-draft` sidecar whenever the persisted bits of
  // the cut plan change (intro/outro toggle + the trim bounds).
  useDebouncedSidecar(
    selected,
    "cutsDraft",
    useMemo<DraftSidecar>(
      () => ({ includeIntroOutro, trimStart, trimEnd }),
      [includeIntroOutro, trimStart, trimEnd],
    ),
    hydratingRef,
  );
  // Debounced write of the `.meta` sidecar whenever the metadata form changes.
  useDebouncedSidecar(
    selected,
    "meta",
    useMemo<MetaSidecar>(
      () => ({
        title: metaTitle,
        speaker: metaSpeaker,
        description: metaDescription,
      }),
      [metaTitle, metaSpeaker, metaDescription],
    ),
    hydratingRef,
  );

  return {
    selected,
    presetId,
    setPresetId,
    trimStart,
    setTrimStart,
    trimEnd,
    setTrimEnd,
    viewport,
    playheadSec,
    zoom,
    pan,
    scrub,
    nudgePlayhead,
    onTrimEdge,
    onTrimCommit,
    undoTrim,
    canUndoTrim,
    // Playback
    audioRef,
    assetSrc,
    isPlaying,
    setIsPlaying,
    audioBroken,
    setAudioBroken,
    togglePlay,
    // Intro/Outro + metadata sidecar state
    includeIntroOutro,
    setIncludeIntroOutro,
    metaTitle,
    setMetaTitle,
    metaSpeaker,
    setMetaSpeaker,
    metaDescription,
    setMetaDescription,
    // Mastering apply (commit) + progress
    onMasterApply,
    onMasterCancel,
    isApplyPending: applyMutation.isPending,
    masterProgress,
    applyResult: applyMutation.data ?? null,
    applyError:
      applyMutation.isError && !isFeatureDisabled(applyMutation.error),
    rows: recordings.data ?? [],
    info: loadMutation.data ?? null,
    peaks: peaksMutation.data ?? null,
    segments: segmentsMutation.data ?? [],
    loudness: analyzeMutation.data ?? null,
    preview: previewMutation.data ?? null,
    exportResult: exportMutation.data ?? null,
    isPeaksPending: peaksMutation.isPending,
    isAnalyzePending: analyzeMutation.isPending,
    isSegmentsPending: segmentsMutation.isPending,
    isPreviewPending: previewMutation.isPending,
    isExportPending: exportMutation.isPending,
    exportError:
      exportMutation.isError && !isFeatureDisabled(exportMutation.error),
    onSelect,
    onPickFile,
    onCloseFile,
    onNormalize,
    onAnalyze,
    onMarkSermon,
    onPreview,
    runExport,
    skipToNextBoundary,
    hasSegments,
  };
}

/** The Transkribering section's own model (whisper models + run + export). */
function useTranscribeModel(selected: string | null) {
  const [modelId, setModelId] = useState("");
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);

  const models = useQuery<WhisperModelMeta[]>({
    queryKey: ["whisper_models"],
    queryFn: () => invoke<WhisperModelMeta[]>("whisper_list_models"),
  });
  const modelList = models.data ?? [];
  const effectiveModel = modelId || modelList[0]?.id || "";

  const transcribeMutation = useMutation({
    mutationFn: () =>
      invoke<TranscriptData>("whisper_transcribe", {
        inputPath: selected ?? "",
        modelId: effectiveModel,
        language: null,
        translate: false,
        subtitleStyle: true,
      }),
    onSuccess: (data) => setTranscript(data),
  });

  const exportMutation = useMutation({
    mutationFn: async (format: TranscriptExportFormat) => {
      if (!transcript) return;
      const path = await save({
        defaultPath: `${
          selected ? fileName(selected).replace(/\.[^.]+$/, "") : "transcript"
        }.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      }).catch(() => null);
      if (path) {
        await invoke<void>("whisper_export_transcript", {
          data: transcript,
          format,
          path,
        });
      }
    },
  });

  const onTranscribe = useCallback(() => {
    setTranscript(null);
    transcribeMutation.mutate();
  }, [transcribeMutation]);

  return {
    modelList,
    modelId,
    setModelId,
    effectiveModel,
    transcript,
    isPending: transcribeMutation.isPending,
    onTranscribe,
    onExport: (f: TranscriptExportFormat) => exportMutation.mutate(f),
    canTranscribe: !!selected && effectiveModel.length > 0,
  };
}

/** Fraction of WAVE_BARS painted as the (blue) intro/outro bands. Purely visual,
 *  fixed at any zoom so the design's three-band look never moves. */
const INTRO_FRAC = 0.15;

/** A boundary the playhead can snap-tick across while scrubbing — derived from
 *  the detected segments. */
function segmentMarkers(segments: Segment[]): number[] {
  if (segments.length === 0) return [];
  return Array.from(new Set(segments.flatMap((s) => [s.start, s.end]))).sort(
    (a, b) => a - b,
  );
}

/** The static gold/blue waveform bars for the visible window. Memoised on the
 *  bars array alone so a scrub (playhead move) never re-paints 150 spans — only
 *  zoom/pan, which actually changes the windowed data, does. The single biggest
 *  smoothness win: the heavy part of the tree is inert during scrub + playback. */
const WaveformBars = memo(function WaveformBars({
  bars,
  introEnd,
  outroStart,
}: {
  bars: number[];
  introEnd: number;
  outroStart: number;
}) {
  return (
    <>
      {bars.map((h, i) => {
        const main = i >= introEnd && i < outroStart;
        return (
          <span
            key={i}
            style={{
              flex: 1,
              height: h * 100 + "%",
              borderRadius: 1,
              background: main ? "var(--sr-gold)" : "rgba(156,196,232,0.55)",
            }}
          />
        );
      })}
    </>
  );
});

/** The overlaid centre band from the shared `waveformPath` geometry. Memoised so
 *  it only re-rasterises when the windowed bars change (zoom/pan), not on scrub. */
const WaveformPoly = memo(function WaveformPoly({ path }: { path: string }) {
  if (!path) return null;
  return (
    <svg
      viewBox="0 0 1000 100"
      preserveAspectRatio="none"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity: 0.18,
      }}
    >
      <polygon points={path} fill="var(--sr-gold-bright)" />
    </svg>
  );
});

/** The white playhead line — the ONLY thing that moves on a scrub/playback
 *  frame. Driven by a CSS `translateX` percentage so the browser composites it
 *  on the GPU (a transform, not a layout-triggering `left`). Isolated + memoised
 *  so updating it never touches the bars/overlay/ticks. */
const Playhead = memo(function Playhead({ frac }: { frac: number }) {
  const visible = frac >= 0 && frac <= 1;
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: 2,
        background: "#fff",
        pointerEvents: "none",
        // GPU-composited move; `willChange` keeps it on its own layer. `cqw`
        // resolves against the bars container (which sets `containerType:
        // inline-size`), so 100cqw == the full waveform width — no JS layout read.
        transform: `translateX(${frac * 100}cqw)`,
        willChange: "transform",
        opacity: visible ? 1 : 0,
      }}
    />
  );
});

/** Interactive waveform: the design's fixed gold-bar timeline, now live + driven
 *  by the shared `editorGeometry` viewport model. Bars are the peaks WINDOWED to
 *  the visible `[viewport.start, viewport.end]` then downsampled to WAVE_BARS, so
 *  zoom/pan reveal real detail. A centre polyline (the shared `waveformPath`
 *  helper) is overlaid so the exact peaks→geometry math is reused. The white
 *  playhead, the ★ preken marker and the ruler ticks all map through the
 *  viewport. Pointer-drag scrubs the playhead; wheel pans (shift / horizontal)
 *  or zooms-around-cursor. Falls back to the neutral placeholder when no peaks.
 *  Intro/outro band colouring stays FIXED fractions of WAVE_BARS — visual only.
 *
 *  SMOOTHNESS: every continuous gesture (pointer-move scrub/trim, wheel
 *  zoom/pan) is COALESCED into a single requestAnimationFrame tick — we stash
 *  the latest event in a ref and apply it once per frame, so a 120 Hz trackpad
 *  never fires 120 React state updates. The heavy bars/overlay are memoised on
 *  the windowed data, and the playhead is an isolated GPU-transform leaf, so a
 *  scrub frame re-renders almost nothing. Wheel-zoom is eased (pressure-
 *  proportional, `wheelZoomFactor`) and zooms toward the cursor. Trim drags
 *  snap to segment boundaries (subtle `alignment` haptic on snap, `levelChange`
 *  at the min/max limit); scrubbing past a marker fires a throttled `generic`
 *  tick. */
function Waveform({
  peaks,
  durationSec,
  viewport,
  playheadSec,
  onScrub,
  onZoom,
  onPan,
  segments,
  trim,
  onTrimEdge,
  onTrimCommit,
}: {
  peaks: number[] | null;
  durationSec: number;
  viewport: Viewport;
  playheadSec: number;
  onScrub: (sec: number) => void;
  onZoom: (factor: number, anchorSec?: number) => void;
  onPan: (deltaSec: number) => void;
  /** Detected segments — boundaries to snap trim handles to + tick the playhead
   *  across while scrubbing. Empty array = no snap / no marker haptics. */
  segments?: Segment[];
  /** The KEEP window in seconds; when present, two draggable handles + a gold
   *  KEEP highlight (with dimmed cut regions either side) are drawn. */
  trim?: { start: number; end: number };
  /** Move one trim edge to a second (the screen clamps + writes it back). */
  onTrimEdge?: (edge: "start" | "end", sec: number) => void;
  /** Fired once when a trim drag gesture ends (pointer-up), so the model can
   *  close its one-deep undo snapshot for the gesture. */
  onTrimCommit?: () => void;
}) {
  const { t } = useTranslation();
  const barsRef = useRef<HTMLDivElement | null>(null);
  const pressed = useRef(false);
  // Which trim handle (if any) the current pointer-drag is moving.
  const draggingEdge = useRef<"start" | "end" | null>(null);
  const span = viewport.end - viewport.start;
  const segs = useMemo(() => segments ?? [], [segments]);
  const markers = useMemo(() => segmentMarkers(segs), [segs]);

  // Live viewport in a ref so the rAF tick reads the freshest geometry without
  // re-creating the frame callbacks every render.
  const vpRef = useRef(viewport);
  vpRef.current = viewport;
  const playheadRef = useRef(playheadSec);
  playheadRef.current = playheadSec;

  // Hover readout: the second under the cursor (null when not hovering). State
  // only — a low-frequency, GUI-only nicety; updated off the same rAF.
  const [hoverSec, setHoverSec] = useState<number | null>(null);

  // One throttled haptic emitter for the playhead-crosses-marker tick (≥120 ms
  // between ticks so a fast scrub across dense markers buzzes at most ~8×/s).
  const markerHapticRef = useRef(makeHapticThrottle(120));

  // Bars: window the peaks to the visible range, then downsample to WAVE_BARS.
  const bars = useMemo(
    () =>
      peaks && peaks.length > 0
        ? peaksWindow(
            peaks,
            viewport.start,
            viewport.end,
            durationSec,
            WAVE_BARS,
          )
        : [],
    [peaks, viewport.start, viewport.end, durationSec],
  );
  const hasBars = bars.length > 0;
  const introEnd = Math.round(WAVE_BARS * INTRO_FRAC);
  const outroStart = WAVE_BARS - introEnd;
  const ticks = useMemo(
    () => viewportTicks(viewport.start, viewport.end),
    [viewport.start, viewport.end],
  );
  // Reuse the tested peaks→SVG geometry for an overlaid centre band.
  const polyPath = useMemo(
    () => (hasBars ? waveformPath(bars, 1000, 100) : ""),
    [bars, hasBars],
  );

  // Playhead position as a 0..1 fraction of the viewport (rendered only if in
  // view). The isolated <Playhead> leaf consumes this.
  const playFrac = span > 0 ? (playheadSec - viewport.start) / span : -1;

  // Trim handle/highlight fractions across the viewport (null when off-screen).
  const trimStartFrac = trim
    ? secToViewFrac(trim.start, viewport.start, viewport.end)
    : null;
  const trimEndFrac = trim
    ? secToViewFrac(trim.end, viewport.start, viewport.end)
    : null;
  const showTrim = !!trim && !!onTrimEdge && hasBars;
  // Keep the latest trim fracs in a ref for the rAF-driven handle hit-test.
  const trimFracRef = useRef<{ start: number | null; end: number | null }>({
    start: null,
    end: null,
  });
  trimFracRef.current = { start: trimStartFrac, end: trimEndFrac };

  // Map a pointer's clientX into a main-file second via the bars container box,
  // reading the LIVE viewport ref (so the value is correct even mid-gesture).
  const xToSecFromEvent = useCallback((clientX: number): number | null => {
    const el = barsRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return xToSec(clientX - rect.left, vpRef.current, rect.width);
  }, []);

  // Which trim handle (if any) a clientX is within ~10 px of — handles win over
  // a plain scrub so you can grab an edge sitting under the playhead.
  const handleAtX = useCallback(
    (clientX: number): "start" | "end" | null => {
      if (!showTrim) return null;
      const el = barsRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const x = clientX - rect.left;
      const { start: sFrac, end: eFrac } = trimFracRef.current;
      const startX = sFrac != null ? sFrac * rect.width : null;
      const endX = eFrac != null ? eFrac * rect.width : null;
      const dStart = startX != null ? Math.abs(x - startX) : Infinity;
      const dEnd = endX != null ? Math.abs(x - endX) : Infinity;
      if (dStart > 10 && dEnd > 10) return null;
      return dStart <= dEnd ? "start" : "end";
    },
    [showTrim],
  );

  // ── rAF coalescing ─────────────────────────────────────────────────────────
  // Pointer-move and wheel are high-frequency. We never act on them inline;
  // instead each handler stashes its intent in a ref and schedules ONE rAF that
  // applies the latest value, so React sees at most one update per frame.
  const rafRef = useRef(0);
  const pendingMoveX = useRef<number | null>(null);
  const pendingWheel = useRef<{
    dx: number;
    dy: number;
    x: number;
    shift: boolean;
  } | null>(null);

  const flush = useCallback(() => {
    rafRef.current = 0;
    const el = barsRef.current;
    const width = el ? el.getBoundingClientRect().width : 0;

    // Wheel first (zoom/pan reshape the viewport the move then reads).
    const w = pendingWheel.current;
    if (w && width > 0) {
      pendingWheel.current = null;
      const sp = vpRef.current.end - vpRef.current.start;
      if (w.shift || Math.abs(w.dx) > Math.abs(w.dy)) {
        onPan(((w.dx || w.dy) / width) * sp);
      } else {
        const anchor = xToSecFromEvent(w.x) ?? undefined;
        onZoom(wheelZoomFactor(w.dy), anchor);
      }
    }

    // Then the latest pointer position (scrub or trim-edge drag).
    const mx = pendingMoveX.current;
    if (mx != null) {
      pendingMoveX.current = null;
      const raw = xToSecFromEvent(mx);
      if (raw != null) {
        if (draggingEdge.current && onTrimEdge) {
          // Snap the trim edge to a nearby segment boundary; tap on snap.
          const { sec, snapped } = snapWithFeedback(
            raw,
            segs,
            vpRef.current,
            width || 1000,
            { speech: true, music: true, silence: false },
          );
          if (snapped) void haptic("alignment");
          onTrimEdge(draggingEdge.current, sec);
        } else if (pressed.current) {
          // Scrubbing: tick (throttled) when we sweep across a marker.
          if (crossedMarker(playheadRef.current, raw, markers)) {
            markerHapticRef.current("generic");
          }
          onScrub(raw);
        }
      }
    }
  }, [onPan, onZoom, onScrub, onTrimEdge, xToSecFromEvent, segs, markers]);

  const schedule = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!hasBars) return;
      const sec = xToSecFromEvent(e.clientX);
      if (sec == null) return;
      const edge = handleAtX(e.clientX);
      pressed.current = true;
      barsRef.current?.setPointerCapture?.(e.pointerId);
      if (edge && onTrimEdge) {
        draggingEdge.current = edge;
        onTrimEdge(edge, sec);
      } else {
        draggingEdge.current = null;
        onScrub(sec);
      }
    },
    [hasBars, xToSecFromEvent, handleAtX, onTrimEdge, onScrub],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Always update the hover readout (cheap), coalesced via the same frame.
      pendingMoveX.current = e.clientX;
      if (!pressed.current) {
        // Hover-only: refresh the readout + cursor affordance on the next frame.
        const sec = xToSecFromEvent(e.clientX);
        setHoverSec(sec);
        pendingMoveX.current = null; // not a drag → don't scrub
        return;
      }
      schedule();
    },
    [xToSecFromEvent, schedule],
  );

  const onPointerEnd = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const wasTrim = draggingEdge.current != null;
      pressed.current = false;
      draggingEdge.current = null;
      pendingMoveX.current = null;
      barsRef.current?.releasePointerCapture?.(e.pointerId);
      if (wasTrim) onTrimCommit?.();
    },
    [onTrimCommit],
  );

  const onPointerLeave = useCallback(() => {
    if (!pressed.current) setHoverSec(null);
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!hasBars) return;
      e.preventDefault();
      pendingWheel.current = {
        dx: e.deltaX,
        dy: e.deltaY,
        x: e.clientX,
        shift: e.shiftKey,
      };
      schedule();
    },
    [hasBars, schedule],
  );

  // Cursor affordance: a resize cursor over a trim handle (so you know you can
  // drag it), otherwise a col-resize scrub cursor over the loaded waveform, and
  // a plain pointer before anything is loaded. Pure presentation.
  const overHandle =
    hoverSec != null &&
    showTrim &&
    trim != null &&
    (Math.abs(hoverSec - trim.start) < span * 0.02 ||
      Math.abs(hoverSec - trim.end) < span * 0.02);
  const cursor = !hasBars ? "pointer" : overHandle ? "ew-resize" : "col-resize";

  return (
    <div style={{ position: "relative" }}>
      <div
        className="sr-row"
        style={{
          justifyContent: "space-between",
          marginBottom: 6,
          fontSize: 11,
          color: "var(--sr-text-3)",
        }}
      >
        <span style={{ color: "#9CC4E8", fontWeight: 600 }}>
          {t("editScreen.waveIntro", "Intro · {{seconds}}s", {
            seconds: "30.8",
          })}
        </span>
        <span style={{ color: "var(--sr-gold)", fontWeight: 600 }}>
          {t("editScreen.waveMain", "Hovedopptak")}
        </span>
        <span style={{ color: "#9CC4E8", fontWeight: 600 }}>
          {t("editScreen.waveOutro", "Outro · {{seconds}}s", {
            seconds: "30.8",
          })}
        </span>
      </div>
      <div
        ref={barsRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          height: 150,
          padding: "0 2px",
          background: "var(--sr-ink-1000)",
          borderRadius: "var(--sr-r-xs)",
          position: "relative",
          overflow: "hidden",
          // A container so the playhead's `cqw` transform tracks this box width.
          containerType: "inline-size",
          cursor,
          touchAction: "none",
        }}
      >
        {hasBars ? (
          <WaveformBars
            bars={bars}
            introEnd={introEnd}
            outroStart={outroStart}
          />
        ) : (
          // Neutral placeholder when no file/peaks are loaded yet.
          <div
            className="sr-grow"
            style={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              color: "var(--sr-text-dim)",
            }}
          >
            {t("editScreen.noWaveformYet", "Ingen bølgeform ennå")}
          </div>
        )}
        {/* GUI-UNVERIFIED centre band from the shared waveformPath geometry. */}
        <WaveformPoly path={polyPath} />
        {/* Drag-to-trim overlay: dim the CUT regions (before start / after end),
            tint the KEEP window gold, and draw two draggable edge handles. The
            container's pointer handlers own the drag; the handles are visual +
            an enlarged grab cue only. */}
        {showTrim && trimStartFrac != null && trimStartFrac > 0 && (
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${trimStartFrac * 100}%`,
              background: "rgba(10,21,33,0.62)",
              pointerEvents: "none",
            }}
          />
        )}
        {showTrim && trimEndFrac != null && trimEndFrac < 1 && (
          <div
            style={{
              position: "absolute",
              left: `${trimEndFrac * 100}%`,
              top: 0,
              bottom: 0,
              right: 0,
              background: "rgba(10,21,33,0.62)",
              pointerEvents: "none",
            }}
          />
        )}
        {showTrim && trimStartFrac != null && trimEndFrac != null && (
          <div
            style={{
              position: "absolute",
              left: `${trimStartFrac * 100}%`,
              width: `${(trimEndFrac - trimStartFrac) * 100}%`,
              top: 0,
              bottom: 0,
              background: "rgba(240,187,71,0.08)",
              borderTop: "2px solid var(--sr-gold)",
              borderBottom: "2px solid var(--sr-gold)",
              pointerEvents: "none",
            }}
          />
        )}
        {showTrim &&
          (
            [
              ["start", trimStartFrac],
              ["end", trimEndFrac],
            ] as const
          ).map(([edge, frac]) =>
            frac == null ? null : (
              <div
                key={edge}
                aria-label={
                  edge === "start"
                    ? t("editScreen.trimStartHandle", "Trim-start")
                    : t("editScreen.trimEndHandle", "Trim-slutt")
                }
                style={{
                  position: "absolute",
                  left: `${frac * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 3,
                  marginLeft: -1.5,
                  background: "var(--sr-gold)",
                  cursor: "ew-resize",
                  // The container handles the drag; let events fall through so a
                  // grab anywhere near the edge starts the resize.
                  pointerEvents: "none",
                  boxShadow: "0 0 0 1px rgba(10,21,33,0.6)",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%,-50%)",
                    width: 9,
                    height: 26,
                    borderRadius: 3,
                    background: "var(--sr-gold)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.45)",
                  }}
                />
              </div>
            ),
          )}
        {/* Hover readout: a faint time pill following the cursor (not while
            dragging — the playhead readout in the file bar covers that). */}
        {hoverSec != null && !pressed.current && hasBars && (
          <div
            aria-hidden
            className="sr-mono sr-num"
            style={{
              position: "absolute",
              left: `${((hoverSec - viewport.start) / (span || 1)) * 100}%`,
              top: 6,
              transform: "translateX(-50%)",
              padding: "1px 5px",
              fontSize: 10.5,
              borderRadius: 4,
              background: "rgba(10,21,33,0.78)",
              color: "var(--sr-text-2)",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            {clock(hoverSec)}
          </div>
        )}
        {/* White playhead — isolated GPU-transform leaf (the only thing that
            moves on a scrub/playback frame). */}
        <Playhead frac={playFrac} />
      </div>
      <div
        className="sr-row"
        style={{
          justifyContent: "space-between",
          marginTop: 5,
          fontSize: 10.5,
          color: "var(--sr-text-dim)",
          fontFamily: "var(--sr-mono)",
        }}
      >
        {ticks.map((tick, i) => (
          <span key={i}>{tick}</span>
        ))}
      </div>
    </div>
  );
}

function ModeSwitch({
  mode,
  onChange,
}: {
  mode: "audio" | "video";
  onChange: (m: "audio" | "video") => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="sr-row"
      style={{ justifyContent: "flex-end", marginBottom: 12 }}
    >
      <div className="sr-tabs">
        <div
          className={"sr-tab" + (mode === "audio" ? " is-active" : "")}
          onClick={() => onChange("audio")}
        >
          {t("editScreen.modeAudio", "Lydfil")}
        </div>
        <div
          className={"sr-tab" + (mode === "video" ? " is-active" : "")}
          onClick={() => onChange("video")}
        >
          {t("editScreen.modeVideo", "Videofil")}
        </div>
      </div>
    </div>
  );
}

/** The Transkribering Collapsible body — real models + run + SRT/VTT/TXT. */
function TranscribeSection({ selected }: { selected: string | null }) {
  const { t } = useTranslation();
  const m = useTranscribeModel(selected);
  const segs = m.transcript?.segments ?? [];
  // Show the first two transcript lines (the design shows two) or the original
  // sample copy when nothing has been transcribed yet.
  const lines =
    segs.length > 0
      ? segs.slice(0, 2).map((s) => ({ t: clock(s.start), text: s.text }))
      : [
          {
            t: "02:14",
            text: "… og nåden bærer oss gjennom alt dette, hver eneste dag.",
          },
          { t: "02:48", text: "La oss be sammen, slik Jesus lærte oss …" },
        ];

  return (
    <Collapsible
      icon="list"
      title={t("editScreen.transcription", "Transkribering")}
      open
      meta={
        <div className="sr-row" style={{ gap: 8 }}>
          {m.modelList.length > 0 && (
            <select
              className="sr-select"
              style={{ fontSize: 12, padding: "4px 8px" }}
              value={m.modelId || m.effectiveModel}
              onChange={(e) => m.setModelId(e.target.value)}
              aria-label={t("editScreen.model", "Modell")}
              onClick={(e) => e.stopPropagation()}
            >
              {m.modelList.map((mm) => (
                <option key={mm.id} value={mm.id}>
                  {mm.label}
                </option>
              ))}
            </select>
          )}
          <button
            className="sr-btn gold sm"
            disabled={!m.canTranscribe || m.isPending}
            onClick={m.onTranscribe}
          >
            <Icon name="play" size={13} fill />
            {m.isPending
              ? t("editScreen.transcribing", "Transkriberer …")
              : t("editScreen.transcribe", "Transkriber")}
          </button>
        </div>
      }
    >
      <div
        style={{
          padding: "13px 15px",
          borderRadius: "var(--sr-r-sm)",
          background: "var(--sr-ink-750)",
        }}
      >
        {lines.map((l, i) => (
          <div
            key={i}
            className="sr-row"
            style={{ gap: 10, marginBottom: i === 0 ? 8 : 0 }}
          >
            <span
              className="sr-mono sr-num"
              style={{ color: "var(--sr-gold)", fontSize: 12 }}
            >
              {l.t}
            </span>
            <span style={{ fontSize: 13.5, color: "var(--sr-text-2)" }}>
              {l.text}
            </span>
          </div>
        ))}
        <div className="sr-row" style={{ gap: 8, marginTop: 12 }}>
          {(["srt", "vtt", "txt"] as const).map((f) => (
            <button
              key={f}
              className="sr-btn ghost sm"
              disabled={!m.transcript}
              onClick={() => m.onExport(f)}
            >
              <Icon name="download" size={13} />
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </Collapsible>
  );
}

/** The hidden <audio> that backs playback + the playhead. Owned by the model
 *  (audioRef); this just renders it with the asset:// src + the events that keep
 *  isPlaying / audioBroken honest. Rendered once per variant near the file bar. */
function BackingAudio({ m }: { m: EditorModel }) {
  if (!m.assetSrc) return null;
  return (
    <audio
      ref={m.audioRef}
      src={m.assetSrc}
      preload="metadata"
      style={{ display: "none" }}
      onPlay={() => m.setIsPlaying(true)}
      onPause={() => m.setIsPlaying(false)}
      onEnded={() => m.setIsPlaying(false)}
      onError={() => {
        m.setAudioBroken(true);
        m.setIsPlaying(false);
      }}
    />
  );
}

/** The round play/pause button in the file bar — toggles the backing audio. */
function PlayButton({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  return (
    <button
      className="sr-btn gold sm"
      style={{ width: 34, height: 34, padding: 0, borderRadius: "50%" }}
      onClick={m.togglePlay}
      disabled={!m.selected || m.audioBroken}
      aria-label={
        m.isPlaying
          ? t("editScreen.kbdPause", "Pause")
          : t("editScreen.kbdPlay", "Spill")
      }
      type="button"
    >
      {m.isPlaying ? (
        // No "pause" glyph in the icon set → two CSS bars, sized like the icon.
        <span
          aria-hidden
          style={{ display: "inline-flex", gap: 3, alignItems: "center" }}
        >
          <span
            style={{ width: 3.5, height: 13, background: "currentColor" }}
          />
          <span
            style={{ width: 3.5, height: 13, background: "currentColor" }}
          />
        </span>
      ) : (
        <Icon name="play" size={15} fill />
      )}
    </button>
  );
}

/** The "Bruk mastering / Eksporter" commit button + progress bar + output path,
 *  wired to editor_master_apply (+ editor-master-progress + cancel). */
function MasterApplyControls({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  const p = m.masterProgress;
  const pct =
    p && p.totalSec > 0
      ? Math.min(100, Math.max(0, (p.currentSec / p.totalSec) * 100))
      : null;
  return (
    <div style={{ marginTop: 16 }}>
      <div className="sr-row" style={{ gap: 10 }}>
        <button
          className="sr-btn gold"
          onClick={m.onMasterApply}
          disabled={!m.selected || m.isApplyPending}
          type="button"
        >
          <Icon name="check" size={15} strokeWidth={2.4} />
          {m.isApplyPending
            ? t("editScreen.applyingMaster", "Mastrer fil …")
            : t("editScreen.applyMaster", "Bruk mastering / Eksporter")}
        </button>
        {m.isApplyPending && (
          <button
            className="sr-btn ghost sm"
            onClick={m.onMasterCancel}
            type="button"
          >
            {t("editScreen.cancel", "Avbryt")}
          </button>
        )}
      </div>
      {m.isApplyPending && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              height: 8,
              borderRadius: 4,
              background: "var(--sr-ink-1000)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${pct ?? 6}%`,
                background: "var(--sr-gold)",
                transition: "width 0.2s linear",
              }}
            />
          </div>
          <div
            className="sr-mono sr-num"
            style={{ fontSize: 11.5, color: "var(--sr-text-3)", marginTop: 5 }}
          >
            {pct != null
              ? t("editScreen.masterProgress", "{{pct}}% · {{cur}} / {{tot}}", {
                  pct: pct.toFixed(0),
                  cur: clock(p!.currentSec),
                  tot: clock(p!.totalSec),
                })
              : t("editScreen.preparingMaster", "Forbereder …")}
          </div>
        </div>
      )}
      {m.applyResult && !m.isApplyPending && (
        <div
          style={{ marginTop: 10, fontSize: 12.5, color: "var(--sr-green)" }}
        >
          {t("editScreen.masteredSavedAs", "Mastret fil lagret: {{name}}", {
            name: fileName(m.applyResult.outputPath),
          })}
        </div>
      )}
      {m.applyError && !m.isApplyPending && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: "var(--sr-red)" }}>
          {t("editScreen.applyError", "✕ Kunne ikke mastre filen")}
        </div>
      )}
    </div>
  );
}

/** A clickable wrapper turning the presentational Toggle atom into a control. */
function ToggleButton({
  on,
  onToggle,
  label,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
      <Toggle on={on} />
    </button>
  );
}

/** The Intro & Outro Collapsible body — the include-on-export switch, persisted
 *  in the .cuts-draft sidecar via the model. */
function IntroOutroCard({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  return (
    <Collapsible
      icon="scissors"
      title={t("editScreen.introOutro", "Intro & Outro")}
      meta={
        <>
          <span
            style={{
              fontSize: 12.5,
              color: "var(--sr-text-3)",
              marginRight: 12,
            }}
          >
            {t("editScreen.includeOnExport", "Inkluder ved eksport")}
          </span>
          <ToggleButton
            on={m.includeIntroOutro}
            onToggle={() => m.setIncludeIntroOutro(!m.includeIntroOutro)}
            label={t("editScreen.includeOnExport", "Inkluder ved eksport")}
          />
        </>
      }
    />
  );
}

/** The Metadata Collapsible body — title/speaker/description form persisted in
 *  the .meta sidecar via the model. */
function MetadataCard({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  return (
    <Collapsible
      icon="list"
      title={t("editScreen.metadata", "Metadata")}
      open
      meta={
        <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
          {m.metaTitle ||
            t("editScreen.metadataHint", "Tittel, taler, beskrivelse")}
        </span>
      }
    >
      <div className="sr-stack-2">
        <label className="sr-field">
          <span className="sr-label">
            {t("editScreen.metaTitle", "Tittel")}
          </span>
          <input
            className="sr-input"
            value={m.metaTitle}
            onChange={(e) => m.setMetaTitle(e.target.value)}
            placeholder={t(
              "editScreen.metaTitlePlaceholder",
              "Pinsegudstjeneste 24. mai",
            )}
            disabled={!m.selected}
          />
        </label>
        <label className="sr-field">
          <span className="sr-label">
            {t("editScreen.metaSpeaker", "Taler")}
          </span>
          <input
            className="sr-input"
            value={m.metaSpeaker}
            onChange={(e) => m.setMetaSpeaker(e.target.value)}
            placeholder={t(
              "editScreen.metaSpeakerPlaceholder",
              "Navn på taler",
            )}
            disabled={!m.selected}
          />
        </label>
        <label className="sr-field">
          <span className="sr-label">
            {t("editScreen.metaDescription", "Beskrivelse")}
          </span>
          <textarea
            className="sr-input"
            rows={3}
            value={m.metaDescription}
            onChange={(e) => m.setMetaDescription(e.target.value)}
            placeholder={t(
              "editScreen.metaDescriptionPlaceholder",
              "Kort beskrivelse av episoden",
            )}
            disabled={!m.selected}
            style={{ resize: "vertical" }}
          />
        </label>
      </div>
    </Collapsible>
  );
}

/** The video variant's synced frame preview — extracts a JPEG at the playhead
 *  (debounced ~150 ms) via editor_extract_frame and shows it. Falls back to the
 *  design placeholder when no frame is available (no file / command absent). */
function VideoFramePreview({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  const [frame, setFrame] = useState<string | null>(null);
  const selected = m.selected;
  const sec = m.playheadSec;

  // Reset on file change so a stale frame never lingers on the new file.
  useEffect(() => {
    setFrame(null);
  }, [selected]);

  // Debounced extract at the current playhead (rounded to ¼ s so tiny rAF
  // jitters during playback don't spam the backend).
  const quantSec = Math.round(sec * 4) / 4;
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const id = window.setTimeout(() => {
      invoke<PreviewFrame | string | null>("editor_extract_frame", {
        inputPath: selected,
        sec: quantSec,
      })
        .then((res) => {
          if (cancelled || res == null) return;
          // The sibling command may return a bare base64 string or a
          // PreviewFrame { data }. Accept either.
          const data = typeof res === "string" ? res : res.data;
          if (data) setFrame(`data:image/jpeg;base64,${data}`);
        })
        .catch(() => {
          /* command absent / disabled → keep the placeholder */
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [selected, quantSec]);

  return (
    <div
      className="sr-media"
      style={{
        aspectRatio: "16 / 9",
        borderRadius: 0,
        border: "none",
        overflow: "hidden",
        padding: 0,
      }}
    >
      {frame ? (
        <img
          src={frame}
          alt={t("editScreen.videoPreview", "Videoforhåndsvisning")}
          style={{ width: "100%", height: "100%", objectFit: "contain" }}
        />
      ) : (
        t("editScreen.followsPlayhead", "følger spillehodet · 720p")
      )}
    </div>
  );
}

function EditAudio({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  const [format, setFormat] = useState("mp3");
  // Per-episode cover art: no Settings/sidecar field in this Fase-1 model, so
  // the chosen image path lives in local screen state.
  const [coverPath, setCoverPath] = useState<string | null>(null);
  const onPickCover = async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [
          { name: "Bilde", extensions: ["png", "jpg", "jpeg", "webp"] },
        ],
      });
      if (typeof picked === "string") setCoverPath(picked);
    } catch {
      /* dialog unavailable in dev/test → no-op */
    }
  };
  const name = m.selected
    ? fileName(m.selected)
    : "2026-05-17_pinse_mastert.mp3";
  const meta = m.info
    ? mediaMeta(m.info, m.selected ? fileExt(m.selected) : null)
    : "32 min 14 s · WAV · 48 kHz";
  const dur = m.info?.durationSec ?? 0;
  const segCount = m.segments.length;
  // The KEEP window for the drag-trim markers (audio shows them only once a
  // user has set a bound, so the default whole-file view stays uncluttered).
  const trimWindow =
    dur > 0 && (m.trimStart || m.trimEnd)
      ? effectiveTrim(m.trimStart, m.trimEnd, dur)
      : undefined;

  return (
    <>
      <BackingAudio m={m} />
      {/* File bar */}
      <div className="sr-card pad" style={{ marginBottom: 14 }}>
        <div className="sr-row" style={{ gap: 12 }}>
          <Icon name="file" size={18} style={{ color: "var(--sr-gold)" }} />
          <div className="sr-grow">
            <div
              className="sr-mono"
              style={{ fontSize: 13.5, fontWeight: 600 }}
            >
              {name}
            </div>
            <div style={{ fontSize: 12, color: "var(--sr-text-3)" }}>
              {meta}
            </div>
          </div>
          <button
            className="sr-btn ghost sm"
            onClick={() => void m.onPickFile()}
          >
            {t("editScreen.openOtherFile", "Åpne annen fil")}
          </button>
          <button
            className="sr-btn ghost sm"
            onClick={m.onCloseFile}
            disabled={!m.selected}
          >
            {t("editScreen.closeFile", "Lukk fil")}
          </button>
          <div className="sr-row" style={{ gap: 6, marginLeft: 8 }}>
            <PlayButton m={m} />
            <button
              className="sr-btn ghost sm"
              style={{ padding: 8 }}
              onClick={m.skipToNextBoundary}
              disabled={!m.hasSegments}
              aria-label={t("editScreen.kbdNextCut", "Neste kutt")}
              type="button"
            >
              <Icon name="skip" size={15} />
            </button>
            <span
              className="sr-mono sr-num"
              style={{
                fontSize: 12.5,
                color: "var(--sr-text-2)",
                marginLeft: 4,
              }}
            >
              {dur > 0
                ? `${clock(m.playheadSec)} / ${clock(dur)}`
                : "5:08 / 32:14"}
            </span>
          </div>
        </div>
      </div>

      {/* Waveform */}
      <div className="sr-card pad" style={{ marginBottom: 14 }}>
        <Waveform
          peaks={m.peaks?.peaks ?? null}
          durationSec={dur}
          viewport={m.viewport}
          playheadSec={m.playheadSec}
          onScrub={m.scrub}
          onZoom={m.zoom}
          onPan={m.pan}
          segments={m.segments}
          trim={trimWindow}
          onTrimEdge={m.onTrimEdge}
          onTrimCommit={m.onTrimCommit}
        />
        <div
          className="sr-row"
          style={{ gap: 7, marginTop: 14, flexWrap: "wrap" }}
        >
          <button
            className="sr-btn ghost sm"
            style={{ padding: 8 }}
            onClick={() => m.zoom(0.5)}
          >
            <Icon name="zoomIn" size={15} />
          </button>
          <button
            className="sr-btn ghost sm"
            style={{ padding: 8 }}
            onClick={() => m.zoom(2)}
          >
            <Icon name="zoomOut" size={15} />
          </button>
          <div className="sr-grow" />
          {[
            ["Space", t("editScreen.kbdPlay", "Spill")],
            ["Tab", t("editScreen.kbdNextCut", "Neste kutt")],
            ["P", t("editScreen.kbdJumpToSermon", "Hopp til preken")],
            ["⌘Z", t("editScreen.kbdUndo", "Angre")],
          ].map(([k, l]) => (
            <span
              key={k}
              className="sr-row"
              style={{ gap: 6, fontSize: 12, color: "var(--sr-text-3)" }}
            >
              <span className="sr-kbd">{k}</span> {l}
            </span>
          ))}
        </div>
      </div>

      <div className="sr-stack-3">
        {/* Normalize → loudness analysis pass (editor_mastering_analyze). */}
        <div className="sr-card pad">
          <div className="sr-row">
            <button
              className="sr-btn gold"
              onClick={m.onNormalize}
              disabled={!m.selected || m.isAnalyzePending}
            >
              <Icon name="normalize" size={16} />
              {m.isAnalyzePending
                ? t("editScreen.measuring", "Måler …")
                : t("editScreen.normalizeLevel", "Normaliser lydnivå")}
            </button>
            <span className="sr-grow sr-srow-d" style={{ marginTop: 0 }}>
              {m.loudness
                ? t(
                    "editScreen.loudnessMeasured",
                    "Målt {{input}} LUFS → mål {{target}} LUFS · topp {{peak}} dBTP.",
                    {
                      input: m.loudness.inputI.toFixed(1),
                      target: m.loudness.targetLufs.toFixed(0),
                      peak: m.loudness.inputTp.toFixed(1),
                    },
                  )
                : t(
                    "editScreen.normalizeDescAudio",
                    "Justerer toppunktet til −1 dBFS for trygg sluttmiks.",
                  )}
            </span>
          </div>
        </div>

        <IntroOutroCard m={m} />
        <MetadataCard m={m} />

        {/* Analyze → editor_segments (tale/musikk/stillhet detection). */}
        <Collapsible
          icon="wave"
          title={t("editScreen.analyzeRecording", "Analyser opptak")}
          open
          meta={
            <button
              className="sr-btn gold sm"
              onClick={m.onAnalyze}
              disabled={!m.selected || m.isSegmentsPending}
            >
              <Icon name="play" size={13} fill />
              {m.isSegmentsPending
                ? t("editScreen.analyzing", "Analyserer …")
                : t("editScreen.analyze", "Analyser")}
            </button>
          }
        >
          <div className="sr-srow-d" style={{ marginTop: 0, marginBottom: 14 }}>
            {segCount > 0
              ? t("editScreen.segmentsFound", "{{count}} segmenter funnet", {
                  count: segCount,
                })
              : "Sist analysert: 31.5 20:35 · 3 tale-segmenter funnet"}
          </div>
          <div className="sr-label" style={{ marginBottom: 10 }}>
            {t("editScreen.shownOnTimeline", "På tidslinjen vises")}
          </div>
          <div className="sr-row" style={{ gap: 18, marginBottom: 16 }}>
            {(
              [
                [
                  t("editScreen.speechSegments", "Tale-segmenter"),
                  "var(--sr-green)",
                  true,
                ],
                [
                  t("editScreen.musicSegments", "Musikk-segmenter"),
                  "var(--sr-blue)",
                  true,
                ],
                [
                  t("editScreen.silence", "Stillhet"),
                  "var(--sr-text-3)",
                  false,
                ],
              ] as const
            ).map(([l, c, on]) => (
              <span
                key={l}
                className="sr-row"
                style={{ gap: 8, fontSize: 13.5 }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    background: on ? c : "transparent",
                    border: "1.5px solid " + c,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {on && (
                    <Icon
                      name="check"
                      size={11}
                      strokeWidth={3}
                      style={{ color: "#0A1521" }}
                    />
                  )}
                </span>
                {l}
              </span>
            ))}
          </div>
          <button
            className="sr-btn ghost"
            onClick={m.onMarkSermon}
            disabled={!m.selected || m.isSegmentsPending}
            type="button"
          >
            <Icon name="sparkle" size={15} />
            {t("editScreen.markSermonAuto", "Marker preken automatisk")}
          </button>
        </Collapsible>

        {/* Transcribe — real whisper models + run + SRT/VTT/TXT export. */}
        <TranscribeSection selected={m.selected} />

        {/* Mastering */}
        <Card
          title={t(
            "editScreen.masteringTitle",
            "Mastering — klargjør for publisering",
          )}
          icon="eq"
          pad
          desc={t(
            "editScreen.masteringDesc",
            "Standardiserer lydstyrke og lydkvalitet for podkast og streaming. Bruker EBU R128-normalisering.",
          )}
        >
          <div className="sr-field" style={{ marginTop: 16, maxWidth: 360 }}>
            <span className="sr-label">
              {t("editScreen.preset", "Forhåndsinnstilling")}
            </span>
            <select
              className="sr-select"
              value={m.presetId}
              onChange={(e) => m.setPresetId(e.target.value)}
              aria-label={t("editScreen.preset", "Forhåndsinnstilling")}
            >
              {MASTER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.labelKey, p.label)}
                </option>
              ))}
            </select>
          </div>
          <div className="sr-row" style={{ gap: 10, marginTop: 16 }}>
            <button
              className="sr-btn ghost"
              onClick={m.onPreview}
              disabled={!m.selected || m.isPreviewPending}
            >
              <Icon name="speaker" size={15} />
              {m.isPreviewPending
                ? t("editScreen.makingPreview", "Lager forhåndsvisning …")
                : t("editScreen.listenPreview", "Lytt på forhåndsvisning")}
            </button>
            <button
              className="sr-btn gold"
              onClick={() => m.runExport(format, true)}
              disabled={!m.selected || m.isExportPending}
            >
              <Icon name="check" size={15} strokeWidth={2.4} />
              {m.isExportPending
                ? t("editScreen.mastering", "Mastrer …")
                : t("editScreen.masterFile", "Mastre fil")}
            </button>
          </div>
          {m.preview && (
            <audio
              controls
              src={safeConvertFileSrc(m.preview.previewPath)}
              style={{ width: "100%", marginTop: 12 }}
              aria-label={t("editScreen.preview", "Forhåndsvisning")}
            />
          )}
          {/* Commit the mastered result to disk (progress + cancel). */}
          <MasterApplyControls m={m} />
        </Card>

        {/* Episode image + export */}
        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
        >
          <Card
            title={t("editScreen.episodeImage", "Episodebilde")}
            icon="image"
            pad
          >
            <div className="sr-row" style={{ gap: 14, marginTop: 14 }}>
              <div
                className="sr-media"
                style={{ width: 96, height: 96, flex: "0 0 96px" }}
              >
                cover
              </div>
              <div className="sr-grow">
                <div
                  style={{ fontSize: 13.5, fontWeight: 600 }}
                  className={coverPath ? "sr-mono" : undefined}
                >
                  {coverPath
                    ? (coverPath.split(/[/\\]/).pop() ?? coverPath)
                    : t("editScreen.usingDefaultImage", "Bruker standardbilde")}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--sr-text-3)",
                    margin: "2px 0 8px",
                  }}
                >
                  2400×1601 px
                </div>
                <Badge kind="warn">
                  {t("editScreen.shouldBeSquare", "Bør være kvadratisk (1:1)")}
                </Badge>
                <div style={{ marginTop: 10 }}>
                  <button
                    className="sr-btn ghost sm"
                    type="button"
                    onClick={() => void onPickCover()}
                  >
                    {t("editScreen.changeImage", "Bytt bilde")}
                  </button>
                </div>
              </div>
            </div>
          </Card>
          <Card
            title={t("editScreen.exportEpisode", "Eksporter episode")}
            icon="download"
            pad
          >
            <div className="sr-field" style={{ marginTop: 14 }}>
              <span className="sr-label">
                {t("editScreen.format", "Format")}
              </span>
              <div className="sr-seg cols-3" style={{ marginTop: 2 }}>
                {(["mp3", "wav", "mp4"] as const).map((f) => (
                  <div key={f} onClick={() => setFormat(f)}>
                    <SegOpt sel={format === f} title={f.toUpperCase()} />
                  </div>
                ))}
              </div>
            </div>
            <button
              className="sr-btn gold block"
              style={{ marginTop: 14 }}
              onClick={() => m.runExport(format, false)}
              disabled={!m.selected || m.isExportPending}
            >
              <Icon name="download" size={15} />
              {m.isExportPending
                ? t("editScreen.exporting", "Eksporterer …")
                : t(
                    "editScreen.exportFinishedEpisode",
                    "Eksporter ferdig episode",
                  )}
            </button>
            {m.exportResult && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12.5,
                  color: "var(--sr-green)",
                }}
              >
                {t("editScreen.savedAs", "Lagret: {{name}}", {
                  name: fileName(m.exportResult.outputPath),
                })}
              </div>
            )}
            {m.exportError && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 12.5,
                  color: "var(--sr-red)",
                }}
              >
                {t("editScreen.exportError", "✕ Feil ved eksport")}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function EditVideo({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  const [format, setFormat] = useState("mp4");
  const name = m.selected
    ? fileName(m.selected)
    : "Pinsegudstjeneste_2026-05-24.mp4";
  const meta = m.info
    ? mediaMeta(m.info, m.selected ? fileExt(m.selected) : null)
    : "32 min 14 s · MP4 · 720p · 30 fps · H.264 + AAC";
  const dur = m.info?.durationSec ?? 0;
  // Video always shows the drag-trim KEEP markers — trim is the primary edit on
  // the video timeline. Defaults to the whole file until the user drags an edge.
  const trimWindow =
    dur > 0 ? effectiveTrim(m.trimStart, m.trimEnd, dur) : undefined;

  return (
    <>
      <BackingAudio m={m} />
      {/* File bar */}
      <div className="sr-card pad" style={{ marginBottom: 14 }}>
        <div className="sr-row" style={{ gap: 12 }}>
          <Icon name="video" size={18} style={{ color: "var(--sr-gold)" }} />
          <div className="sr-grow">
            <div
              className="sr-mono"
              style={{ fontSize: 13.5, fontWeight: 600 }}
            >
              {name}
            </div>
            <div style={{ fontSize: 12, color: "var(--sr-text-3)" }}>
              {meta}
            </div>
          </div>
          <Badge kind="muted">
            <Icon name="video" size={12} style={{ marginRight: 3 }} />
            {t("editScreen.videoAndAudio", "Video + lyd")}
          </Badge>
          <button
            className="sr-btn ghost sm"
            onClick={() => void m.onPickFile()}
          >
            {t("editScreen.openOtherFile", "Åpne annen fil")}
          </button>
          <button
            className="sr-btn ghost sm"
            onClick={m.onCloseFile}
            disabled={!m.selected}
          >
            {t("editScreen.closeFile", "Lukk fil")}
          </button>
        </div>
      </div>

      {/* Video preview + waveform side by side */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 360px",
          gap: 14,
          marginBottom: 14,
          alignItems: "start",
        }}
      >
        <div className="sr-card" style={{ padding: 14 }}>
          <Waveform
            peaks={m.peaks?.peaks ?? null}
            durationSec={dur}
            viewport={m.viewport}
            playheadSec={m.playheadSec}
            onScrub={m.scrub}
            onZoom={m.zoom}
            onPan={m.pan}
            segments={m.segments}
            trim={trimWindow}
            onTrimEdge={m.onTrimEdge}
            onTrimCommit={m.onTrimCommit}
          />
          <div
            className="sr-row"
            style={{ gap: 7, marginTop: 14, flexWrap: "wrap" }}
          >
            <PlayButton m={m} />
            <button
              className="sr-btn ghost sm"
              style={{ padding: 8 }}
              onClick={m.skipToNextBoundary}
              disabled={!m.hasSegments}
              aria-label={t("editScreen.kbdNextCut", "Neste kutt")}
              type="button"
            >
              <Icon name="skip" size={15} />
            </button>
            <span
              className="sr-mono sr-num"
              style={{
                fontSize: 12.5,
                color: "var(--sr-text-2)",
                marginLeft: 4,
              }}
            >
              {dur > 0
                ? `${clock(m.playheadSec)} / ${clock(dur)}`
                : "5:08 / 32:14"}
            </span>
            <div className="sr-grow" />
            <button
              className="sr-btn ghost sm"
              style={{ padding: 8 }}
              onClick={() => m.zoom(0.5)}
            >
              <Icon name="zoomIn" size={15} />
            </button>
            <button
              className="sr-btn ghost sm"
              style={{ padding: 8 }}
              onClick={() => m.zoom(2)}
            >
              <Icon name="zoomOut" size={15} />
            </button>
          </div>
        </div>
        {/* Synced video preview */}
        <div className="sr-card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            className="sr-row"
            style={{
              gap: 10,
              padding: "11px 13px",
              borderBottom: "1px solid var(--sr-line)",
            }}
          >
            <Icon
              name="video"
              size={16}
              style={{ color: "var(--sr-text-3)" }}
            />
            <span
              className="sr-grow"
              style={{ fontSize: 13.5, fontWeight: 600 }}
            >
              {t("editScreen.videoPreview", "Videoforhåndsvisning")}
            </span>
            <span
              className="sr-mono sr-num"
              style={{ fontSize: 12, color: "var(--sr-text-3)" }}
            >
              {dur > 0 ? clock(m.playheadSec) : "05:08"}
            </span>
          </div>
          <VideoFramePreview m={m} />
          <div
            className="sr-row"
            style={{
              gap: 8,
              padding: "11px 13px",
              borderTop: "1px solid var(--sr-line)",
            }}
          >
            <Icon
              name="speaker"
              size={15}
              style={{ color: "var(--sr-text-3)" }}
            />
            <div className="sr-grow">
              <Meter on={5} />
            </div>
          </div>
        </div>
      </div>

      <div className="sr-stack-3">
        {/* Normalize → loudness analysis pass. */}
        <div className="sr-card pad">
          <div className="sr-row">
            <button
              className="sr-btn gold"
              onClick={m.onNormalize}
              disabled={!m.selected || m.isAnalyzePending}
            >
              <Icon name="normalize" size={16} />
              {m.isAnalyzePending
                ? t("editScreen.measuring", "Måler …")
                : t("editScreen.normalizeLevel", "Normaliser lydnivå")}
            </button>
            <span className="sr-grow sr-srow-d" style={{ marginTop: 0 }}>
              {m.loudness
                ? t(
                    "editScreen.loudnessMeasuredVideo",
                    "Målt {{input}} LUFS → mål {{target}} LUFS. Bildet røres ikke.",
                    {
                      input: m.loudness.inputI.toFixed(1),
                      target: m.loudness.targetLufs.toFixed(0),
                    },
                  )
                : t(
                    "editScreen.normalizeDescVideo",
                    "Justerer lyden i videoen til −1 dBFS. Bildet røres ikke.",
                  )}
            </span>
          </div>
        </div>

        {/* Trim → cut regions: drag the gold edge handles on the waveform OR
            type the Start/Slutt fields below (they stay in sync). Everything
            before Start / after Slutt is removed on export (buildTrimCuts →
            editor_export.cutRegions). Empty = whole file. */}
        <Collapsible
          icon="scissors"
          title={t("editScreen.trimStartEnd", "Trim — start & slutt")}
          open
          meta={
            <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
              {m.trimStart || "00:00:00"} –{" "}
              {m.trimEnd || (dur > 0 ? formatHms(dur) : "00:32:14")}
            </span>
          }
        >
          <div className="sr-srow-d" style={{ marginTop: 0, marginBottom: 14 }}>
            {t(
              "editScreen.trimDescDrag",
              "Dra de gylne håndtakene på bølgeformen for å sette start og slutt — eller skriv tidene inn under. Trim gjelder både bilde og lyd samtidig.",
            )}
          </div>
          <div className="sr-row" style={{ gap: 12 }}>
            <label className="sr-field sr-grow">
              <span className="sr-label">{t("editScreen.start", "Start")}</span>
              <input
                className="sr-input mono"
                value={m.trimStart}
                onChange={(e) => m.setTrimStart(e.target.value)}
                placeholder="00:00:00"
                inputMode="numeric"
              />
            </label>
            <label className="sr-field sr-grow">
              <span className="sr-label">{t("editScreen.end", "Slutt")}</span>
              <input
                className="sr-input mono"
                value={m.trimEnd}
                onChange={(e) => m.setTrimEnd(e.target.value)}
                placeholder={dur > 0 ? formatHms(dur) : "00:31:48"}
                inputMode="numeric"
              />
            </label>
          </div>
        </Collapsible>

        <MetadataCard m={m} />
        {/* Transcribe — real whisper models + run + SRT/VTT/TXT export. */}
        <TranscribeSection selected={m.selected} />

        {/* Export — video formats */}
        <Card
          title={t("editScreen.exportEpisode", "Eksporter episode")}
          icon="download"
          pad
          desc={t(
            "editScreen.exportVideoDesc",
            "Med video lastet kan du eksportere ferdig MP4 til YouTube, eller hente ut bare lyden til podkast.",
          )}
        >
          <div className="sr-field" style={{ marginTop: 16 }}>
            <span className="sr-label">{t("editScreen.format", "Format")}</span>
            <div className="sr-seg cols-4" style={{ marginTop: 2 }}>
              <div onClick={() => setFormat("mp4")}>
                <SegOpt
                  sel={format === "mp4"}
                  title="MP4"
                  sub={t("editScreen.videoAndAudio", "Video + lyd")}
                />
              </div>
              <div onClick={() => setFormat("mp3")}>
                <SegOpt
                  sel={format === "mp3"}
                  title="MP3"
                  sub={t("editScreen.audioOnly", "Kun lyd")}
                />
              </div>
              <div onClick={() => setFormat("wav")}>
                <SegOpt
                  sel={format === "wav"}
                  title="WAV"
                  sub={t("editScreen.audioOnly", "Kun lyd")}
                />
              </div>
              {/* "Begge" runs two export passes (MP4 then MP3) from the same
                  trim + mastering plan — see runExport. */}
              <div onClick={() => setFormat("begge")}>
                <SegOpt
                  sel={format === "begge"}
                  title={t("editScreen.both", "Begge")}
                  sub="MP4 + MP3"
                />
              </div>
            </div>
          </div>
          <button
            className="sr-btn gold block"
            style={{ marginTop: 16 }}
            onClick={() => m.runExport(format, false)}
            disabled={!m.selected || m.isExportPending}
          >
            <Icon name="download" size={15} />
            {m.isExportPending
              ? t("editScreen.exporting", "Eksporterer …")
              : t(
                  "editScreen.exportFinishedEpisode",
                  "Eksporter ferdig episode",
                )}
          </button>
          {m.exportResult && (
            <div
              style={{
                marginTop: 10,
                fontSize: 12.5,
                color: "var(--sr-green)",
              }}
            >
              {t("editScreen.savedAs", "Lagret: {{name}}", {
                name: fileName(m.exportResult.outputPath),
              })}
            </div>
          )}
          {m.exportError && (
            <div
              style={{ marginTop: 10, fontSize: 12.5, color: "var(--sr-red)" }}
            >
              {t("editScreen.exportError", "✕ Feil ved eksport")}
            </div>
          )}
          {/* Commit a mastered audio render (progress + cancel) alongside the
              video export — the standalone two-pass apply seam. */}
          <MasterApplyControls m={m} />
        </Card>
      </div>
    </>
  );
}

export function EditScreen() {
  const m = useEditorModel();
  // Manual ModeSwitch choice; overridden by the loaded file's probe (video →
  // video variant) so the right design shows for the file you actually opened.
  const [manualMode, setManualMode] = useState<"audio" | "video">("audio");
  const autoMode = variantForMedia(m.info);
  const mode = autoMode ?? manualMode;

  // Keyboard transport. All shortcuts are ignored while typing in a field so
  // trim/metadata entry isn't hijacked:
  //   Space      play / pause
  //   ← / →      nudge the playhead −/+ 1 s (±5 s with Shift)
  //   Tab        skip to the next detected segment boundary
  //   ⌘Z / Ctrl-Z  undo the last trim drag (when there's a snapshot to revert)
  const {
    selected,
    audioBroken,
    togglePlay,
    nudgePlayhead,
    skipToNextBoundary,
    undoTrim,
    canUndoTrim,
  } = m;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      ) {
        return;
      }
      if (!selected) return;

      // ⌘Z / Ctrl-Z → undo the last trim drag (best-effort; no-op when empty).
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        if (e.shiftKey) return; // leave redo to the browser/future use
        if (canUndoTrim()) {
          e.preventDefault();
          undoTrim();
        }
        return;
      }
      // Bare modifier combos otherwise pass through (copy/paste in fields etc.).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "Space") {
        if (audioBroken) return;
        e.preventDefault();
        togglePlay();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudgePlayhead(e.shiftKey ? -5 : -1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        nudgePlayhead(e.shiftKey ? 5 : 1);
        return;
      }
      if (e.code === "Tab") {
        e.preventDefault();
        skipToNextBoundary();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    selected,
    audioBroken,
    togglePlay,
    nudgePlayhead,
    skipToNextBoundary,
    undoTrim,
    canUndoTrim,
  ]);

  return (
    <div className={"sr-content" + (mode === "video" ? " wide" : "")}>
      <ModeSwitch mode={mode} onChange={setManualMode} />
      {mode === "audio" ? <EditAudio m={m} /> : <EditVideo m={m} />}
    </div>
  );
}
