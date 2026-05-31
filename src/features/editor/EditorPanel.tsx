import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorMediaInfo } from "@/lib/bindings/EditorMediaInfo";
import type { EditorPeaks } from "@/lib/bindings/EditorPeaks";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import type { EditorLoudness } from "@/lib/bindings/EditorLoudness";
import type { EditorExportRequest } from "@/lib/bindings/EditorExportRequest";
import type { EditorExportResult } from "@/lib/bindings/EditorExportResult";
import { EDITOR_RECORDINGS_KEY } from "./queryKey";

/** The five mastering presets the core ships (ids kept in sync with
 *  `sundayrec_core::mastering::master_presets`); `none` skips mastering. */
const MASTER_PRESETS = [
  "none",
  "speech-natural",
  "speech-clear",
  "speech-punchy",
  "music-speech",
] as const;

/** The export formats the seam renders. */
const FORMATS = ["mp3", "aac", "wav", "flac", "mp4"] as const;
type Format = (typeof FORMATS)[number];

/** The basename of a path, for display (works for both `/` and `\`). */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** True when an IPC rejection is the default-build "editor feature off" error,
 *  so the panel can show a calm hint rather than a red error. The seam returns
 *  `feature_disabled: …` in the message of a `validation` AppError. */
function isFeatureDisabled(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("feature_disabled");
}

/**
 * R1 editor panel. Pick a recording from history, load it (ffprobe
 * duration/streams), pull the waveform peaks + content segments + a loudness
 * measurement, and export the (whole-file, for now) recording to a chosen
 * format with an optional mastering preset.
 *
 * The cut-region timeline UI is the renderer's job in a later phase; this panel
 * proves the full IPC surface end-to-end (load → peaks → segments → analyze →
 * export). The ffmpeg work is behind the default-off `editor` feature, so in the
 * shipping build the commands reject with `feature_disabled`; the panel renders
 * that as a "not built into this build" hint rather than an error.
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked.
 */
export function EditorPanel() {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [format, setFormat] = useState<Format>("mp3");
  const [preset, setPreset] = useState<(typeof MASTER_PRESETS)[number]>("none");
  const [disabled, setDisabled] = useState(false);

  const recordings = useQuery<RecordingRow[]>({
    queryKey: EDITOR_RECORDINGS_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });

  // Per-file derived data, refetched (mutations on demand) when the selection
  // changes. We use mutations rather than queries so each ffmpeg pass is
  // explicitly user-triggered (decoding a 3 h service isn't a background fetch).
  const loadMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorMediaInfo>("editor_load_recording", { inputPath: path }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });
  const peaksMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorPeaks>("editor_peaks", { inputPath: path }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });
  const segmentsMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorSegment[]>("editor_segments", { inputPath: path }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });
  const analyzeMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorLoudness>("editor_mastering_analyze", {
        inputPath: path,
        presetId: preset === "none" ? "speech-clear" : preset,
      }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });
  const exportMutation = useMutation({
    mutationFn: (request: EditorExportRequest) =>
      invoke<EditorExportResult>("editor_export", { request }),
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });

  const onSelect = useCallback(
    (path: string) => {
      setSelected(path);
      setDisabled(false);
      exportMutation.reset();
      // Probe immediately so the user sees duration/streams on pick.
      loadMutation.mutate(path);
    },
    [loadMutation, exportMutation],
  );

  const onExport = useCallback(() => {
    if (!selected) return;
    const info = loadMutation.data;
    const folder = selected.replace(/[/\\][^/\\]*$/, "");
    const request: EditorExportRequest = {
      inputPath: selected,
      cutRegions: [],
      duration: info?.durationSec ?? 0,
      format,
      outputFolder: folder,
      bitrate: null,
      bitDepth: null,
      masterPreset: preset === "none" ? null : preset,
    };
    exportMutation.mutate(request);
  }, [selected, loadMutation.data, format, preset, exportMutation]);

  const rows = recordings.data ?? [];
  const info = loadMutation.data;
  const loudness = analyzeMutation.data;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("editor.title", "Redigering")}
    >
      {disabled && (
        <p className="rounded border border-amber-700 p-2 text-xs text-amber-300">
          {t(
            "editor.featureDisabled",
            "Redigering er ikke bygget inn i denne versjonen.",
          )}
        </p>
      )}

      {/* ── Recording picker ───────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">
          {t("editor.pickTitle", "Velg opptak")}
        </h2>
        {rows.length === 0 ? (
          <p className="opacity-60">
            {t("editor.noRecordings", "Ingen opptak ennå")}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={`w-full truncate rounded border px-2 py-1 text-left text-xs hover:bg-zinc-800 ${
                    selected === r.file_path
                      ? "border-emerald-700"
                      : "border-zinc-700"
                  }`}
                  onClick={() => onSelect(r.file_path)}
                  title={r.file_path}
                >
                  {fileName(r.file_path)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Loaded recording ───────────────────────────────────────────── */}
      {selected && (
        <div className="flex flex-col gap-3">
          {info && (
            <p className="text-xs opacity-80">
              {t("editor.duration", "Varighet")}: {info.durationSec.toFixed(1)}s
              {" · "}
              {info.hasVideo
                ? t("editor.video", "video")
                : t("editor.audioOnly", "kun lyd")}
              {info.channels != null && ` · ${info.channels}ch`}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
              disabled={peaksMutation.isPending}
              onClick={() => peaksMutation.mutate(selected)}
            >
              {t("editor.loadPeaks", "Bølgeform")}
            </button>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
              disabled={segmentsMutation.isPending}
              onClick={() => segmentsMutation.mutate(selected)}
            >
              {t("editor.detectSegments", "Finn segmenter")}
            </button>
            <button
              type="button"
              className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
              disabled={analyzeMutation.isPending}
              onClick={() => analyzeMutation.mutate(selected)}
            >
              {t("editor.analyzeLoudness", "Mål lydstyrke")}
            </button>
          </div>

          {peaksMutation.data && (
            <p className="text-xs opacity-70">
              {t("editor.peaksCount", "{{n}} bølgeform-punkter", {
                n: peaksMutation.data.peaks.length,
              })}
            </p>
          )}

          {segmentsMutation.data && segmentsMutation.data.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs">
              {segmentsMutation.data.map((s, i) => (
                <li
                  key={`${s.start}-${i}`}
                  className={`rounded border px-2 py-1 ${
                    s.kind === "sermon"
                      ? "border-amber-600 text-amber-300"
                      : "border-zinc-700"
                  }`}
                >
                  {s.label} · {s.start.toFixed(0)}–{s.end.toFixed(0)}s
                </li>
              ))}
            </ul>
          )}

          {loudness && (
            <p className="text-xs opacity-80">
              {t("editor.loudness", "Lydstyrke")}: {loudness.inputI.toFixed(1)}{" "}
              LUFS → {loudness.targetLufs.toFixed(0)} LUFS
            </p>
          )}

          {/* ── Export ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
            <div className="flex items-center gap-2">
              <label className="text-xs opacity-70">
                {t("editor.format", "Format")}
              </label>
              <select
                className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-xs"
                value={format}
                onChange={(e) => setFormat(e.target.value as Format)}
                aria-label={t("editor.format", "Format")}
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
              <label className="text-xs opacity-70">
                {t("editor.preset", "Mastering")}
              </label>
              <select
                className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-xs"
                value={preset}
                onChange={(e) =>
                  setPreset(e.target.value as (typeof MASTER_PRESETS)[number])
                }
                aria-label={t("editor.preset", "Mastering")}
              >
                {MASTER_PRESETS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="self-start rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              disabled={exportMutation.isPending}
              onClick={onExport}
            >
              {t("editor.export", "Eksporter")}
            </button>
            {exportMutation.data && (
              <p className="text-xs text-emerald-300">
                {t("editor.exported", "Lagret")}:{" "}
                {fileName(exportMutation.data.outputPath)}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
