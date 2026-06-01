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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Icon } from "../Icon";
import { Badge, Card, Collapsible, Meter, SegOpt, Toggle } from "../atoms";
import { waveformPath } from "@/features/editor/waveform";
import {
  clampMain,
  fitAll,
  panBy,
  xToSec,
  zoomBy,
  type Viewport,
} from "@/features/editor/editorGeometry";
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
import {
  buildTrimCuts,
  clock,
  fileExt,
  fileName,
  formatHms,
  mediaMeta,
  peaksWindow,
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

  const onSelect = useCallback(
    (path: string) => {
      setSelected(path);
      setTrimStart("");
      setTrimEnd("");
      peaksMutation.reset();
      segmentsMutation.reset();
      analyzeMutation.reset();
      previewMutation.reset();
      exportMutation.reset();
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
    loadMutation.reset();
    peaksMutation.reset();
    segmentsMutation.reset();
    analyzeMutation.reset();
    previewMutation.reset();
    exportMutation.reset();
  }, [
    loadMutation,
    peaksMutation,
    segmentsMutation,
    analyzeMutation,
    previewMutation,
    exportMutation,
  ]);

  const onNormalize = useCallback(() => {
    if (selected) analyzeMutation.mutate(selected);
  }, [selected, analyzeMutation]);

  const onAnalyze = useCallback(() => {
    if (selected) segmentsMutation.mutate(selected);
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
      setPlayheadSec(clampMain(sec, duration));
    },
    [duration],
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
    onPreview,
    runExport,
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

/** Interactive waveform: the design's fixed gold-bar timeline, now live + driven
 *  by the shared `editorGeometry` viewport model. Bars are the peaks WINDOWED to
 *  the visible `[viewport.start, viewport.end]` then downsampled to WAVE_BARS, so
 *  zoom/pan reveal real detail. A centre polyline (the shared `waveformPath`
 *  helper) is overlaid so the exact peaks→geometry math is reused. The white
 *  playhead, the ★ preken marker and the ruler ticks all map through the
 *  viewport. Pointer-drag scrubs the playhead; wheel pans (shift / horizontal)
 *  or zooms-around-cursor. Falls back to the neutral placeholder when no peaks.
 *  Intro/outro band colouring stays FIXED fractions of WAVE_BARS — visual only. */
function Waveform({
  peaks,
  durationSec,
  viewport,
  playheadSec,
  onScrub,
  onZoom,
  onPan,
}: {
  peaks: number[] | null;
  durationSec: number;
  viewport: Viewport;
  playheadSec: number;
  onScrub: (sec: number) => void;
  onZoom: (factor: number, anchorSec?: number) => void;
  onPan: (deltaSec: number) => void;
}) {
  const { t } = useTranslation();
  const barsRef = useRef<HTMLDivElement | null>(null);
  const pressed = useRef(false);
  const span = viewport.end - viewport.start;
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
  const ticks = viewportTicks(viewport.start, viewport.end);
  // Reuse the tested peaks→SVG geometry for an overlaid centre band.
  const polyPath = useMemo(
    () => (hasBars ? waveformPath(bars, 1000, 100) : ""),
    [bars, hasBars],
  );

  // Playhead position as a 0..1 fraction of the viewport (rendered only if in
  // view).
  const playFrac = span > 0 ? (playheadSec - viewport.start) / span : -1;

  // Map a pointer's clientX into a main-file second via the bars container box.
  const xToSecFromEvent = useCallback(
    (clientX: number): number | null => {
      const el = barsRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return null;
      return xToSec(clientX - rect.left, viewport, rect.width);
    },
    [viewport],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!hasBars) return;
      const sec = xToSecFromEvent(e.clientX);
      if (sec == null) return;
      pressed.current = true;
      barsRef.current?.setPointerCapture?.(e.pointerId);
      onScrub(sec);
    },
    [hasBars, xToSecFromEvent, onScrub],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!pressed.current) return;
      const sec = xToSecFromEvent(e.clientX);
      if (sec != null) onScrub(sec);
    },
    [xToSecFromEvent, onScrub],
  );

  const onPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    pressed.current = false;
    barsRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (!hasBars) return;
      const el = barsRef.current;
      const width = el ? el.getBoundingClientRect().width : 0;
      if (width <= 0) return;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        onPan(((e.deltaX || e.deltaY) / width) * span);
      } else {
        const anchor = xToSecFromEvent(e.clientX) ?? undefined;
        onZoom(e.deltaY > 0 ? 1.1 : 0.9, anchor);
      }
    },
    [hasBars, span, xToSecFromEvent, onPan, onZoom],
  );

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
          cursor: hasBars ? "ew-resize" : "pointer",
          touchAction: "none",
        }}
      >
        {hasBars ? (
          bars.map((h, i) => {
            const main = i >= introEnd && i < outroStart;
            return (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: h * 100 + "%",
                  borderRadius: 1,
                  background: main
                    ? "var(--sr-gold)"
                    : "rgba(156,196,232,0.55)",
                }}
              />
            );
          })
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
        {polyPath && (
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
            <polygon points={polyPath} fill="var(--sr-gold-bright)" />
          </svg>
        )}
        {/* White playhead — only when it falls inside the current viewport. */}
        {playFrac >= 0 && playFrac <= 1 && (
          <div
            style={{
              position: "absolute",
              left: `${playFrac * 100}%`,
              top: 0,
              bottom: 0,
              width: 2,
              background: "#fff",
              pointerEvents: "none",
            }}
          />
        )}
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

function EditAudio({ m }: { m: EditorModel }) {
  const { t } = useTranslation();
  const [format, setFormat] = useState("mp3");
  const name = m.selected
    ? fileName(m.selected)
    : "2026-05-17_pinse_mastert.mp3";
  const meta = m.info
    ? mediaMeta(m.info, m.selected ? fileExt(m.selected) : null)
    : "32 min 14 s · WAV · 48 kHz";
  const dur = m.info?.durationSec ?? 0;
  const segCount = m.segments.length;

  return (
    <>
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
            <button
              className="sr-btn gold sm"
              style={{ width: 34, height: 34, padding: 0, borderRadius: "50%" }}
            >
              <Icon name="play" size={15} fill />
            </button>
            <button className="sr-btn ghost sm" style={{ padding: 8 }}>
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
              <Toggle on />
            </>
          }
        />
        <Collapsible
          icon="list"
          title={t("editScreen.metadata", "Metadata")}
          meta={
            <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
              {t("editScreen.metadataHint", "Tittel, taler, beskrivelse")}
            </span>
          }
        />

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
          <button className="sr-btn ghost">
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
              src={m.preview.previewPath}
              style={{ width: "100%", marginTop: 12 }}
              aria-label={t("editScreen.preview", "Forhåndsvisning")}
            />
          )}
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
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {t("editScreen.usingDefaultImage", "Bruker standardbilde")}
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
                  <button className="sr-btn ghost sm">
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

  return (
    <>
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
          />
          <div
            className="sr-row"
            style={{ gap: 7, marginTop: 14, flexWrap: "wrap" }}
          >
            <button
              className="sr-btn gold sm"
              style={{ width: 34, height: 34, padding: 0, borderRadius: "50%" }}
            >
              <Icon name="play" size={15} fill />
            </button>
            <button className="sr-btn ghost sm" style={{ padding: 8 }}>
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
              05:08
            </span>
          </div>
          <div
            className="sr-media"
            style={{ aspectRatio: "16 / 9", borderRadius: 0, border: "none" }}
          >
            {t("editScreen.followsPlayhead", "følger spillehodet · 720p")}
          </div>
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

        {/* Trim → cut regions: Start/Slutt (HH:MM:SS) are removed before/after
            on export (buildTrimCuts → editor_export.cutRegions). Empty = whole
            file. Drag-on-waveform trim is a separate follow-up (C-7). */}
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
              "editScreen.trimDesc",
              "Klipp bort dødtid før og etter gudstjenesten. Trim gjelder både bilde og lyd samtidig.",
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

        <Collapsible
          icon="list"
          title={t("editScreen.metadata", "Metadata")}
          meta={
            <span style={{ fontSize: 12.5, color: "var(--sr-text-3)" }}>
              {t("editScreen.metadataHint", "Tittel, taler, beskrivelse")}
            </span>
          }
        />
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

  return (
    <div className={"sr-content" + (mode === "video" ? " wide" : "")}>
      <ModeSwitch mode={mode} onChange={setManualMode} />
      {mode === "audio" ? <EditAudio m={m} /> : <EditVideo m={m} />}
    </div>
  );
}
