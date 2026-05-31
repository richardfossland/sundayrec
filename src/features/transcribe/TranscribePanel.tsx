import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { WhisperModelMeta } from "@/lib/bindings/WhisperModelMeta";
import type { TranscriptData } from "@/lib/bindings/TranscriptData";
import type { TranscriptExportFormat } from "@/lib/bindings/TranscriptExportFormat";
import { HISTORY_QUERY_KEY } from "@/features/history/queryKey";
import { WHISPER_MODELS_KEY } from "./queryKey";

/** The export formats offered, mirroring the core `TranscriptExportFormat`. */
const EXPORT_FORMATS: readonly TranscriptExportFormat[] = [
  "srt",
  "vtt",
  "txt",
] as const;

/** The languages offered, mirroring `sundayrec_core::whisper::language_options`
 *  (`auto` + the suite's seven). Labels are localised via i18n. */
const LANGUAGES = [
  "auto",
  "no",
  "en",
  "sv",
  "da",
  "de",
  "fr",
  "pl",
] as const;

/** True when an IPC rejection is the default-build "whisper feature off" error,
 *  so the panel shows a calm hint rather than a red error. The seam returns
 *  `feature_disabled: …` in the message of a `validation` AppError. */
function isFeatureDisabled(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("feature_disabled");
}

/** The basename of a path, for display (works for both `/` and `\`). */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Strip the extension from a basename, for the default export filename. */
function stem(path: string): string {
  return fileName(path).replace(/\.[^.]+$/, "");
}

/** Format seconds as `m:ss` for the transcript segment list. */
function clock(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * PU-5 transcription panel. Picks a recording (from history) + a whisper model
 * (`whisper_list_models`), an output language, and runs `whisper_transcribe`.
 * The result renders as a seekable segment list and can be saved to SRT/VTT/TXT
 * via `whisper_export_transcript` (native save dialog).
 *
 * Transcription (and the model download) is behind the default-off `whisper`
 * cargo feature, so in the default build `whisper_transcribe` returns
 * `feature_disabled` and the panel shows a calm "not built into this build"
 * hint. The model registry list works in every build.
 *
 * Pure IPC + render; exercised in tests with `invoke` + the dialog plugin mocked.
 */
export function TranscribePanel() {
  const { t } = useTranslation();

  const recordings = useQuery<RecordingRow[]>({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });

  const models = useQuery<WhisperModelMeta[]>({
    queryKey: WHISPER_MODELS_KEY,
    queryFn: () => invoke<WhisperModelMeta[]>("whisper_list_models"),
  });

  const [recordingPath, setRecordingPath] = useState("");
  const [modelId, setModelId] = useState("");
  const [language, setLanguage] = useState<string>("auto");
  const [translate, setTranslate] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptData | null>(null);
  const [disabled, setDisabled] = useState(false);

  const rows = recordings.data ?? [];
  const modelList = models.data ?? [];

  // Default the selections to the first available option once the lists load.
  const effectiveModel = modelId || modelList[0]?.id || "";
  const effectivePath = recordingPath || rows[0]?.file_path || "";

  const transcribeMutation = useMutation({
    mutationFn: () =>
      invoke<TranscriptData>("whisper_transcribe", {
        inputPath: effectivePath,
        modelId: effectiveModel,
        language: language === "auto" ? null : language,
        translate,
        subtitleStyle: true,
      }),
    onSuccess: (data) => {
      setTranscript(data);
      setDisabled(false);
    },
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });

  const exportMutation = useMutation({
    mutationFn: async (format: TranscriptExportFormat) => {
      if (!transcript) return;
      const path = await save({
        defaultPath: `${stem(effectivePath) || "transcript"}.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
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
    setDisabled(false);
    setTranscript(null);
    transcribeMutation.mutate();
  }, [transcribeMutation]);

  const segmentCount = transcript?.segments.length ?? 0;
  const canTranscribe = effectivePath.length > 0 && effectiveModel.length > 0;

  const languageLabel = useMemo(
    () => (code: string) => {
      switch (code) {
        case "auto":
          return t("transcribe.langAuto", "Automatisk");
        case "no":
          return "Norsk";
        case "en":
          return "English";
        case "sv":
          return "Svenska";
        case "da":
          return "Dansk";
        case "de":
          return "Deutsch";
        case "fr":
          return "Français";
        case "pl":
          return "Polski";
        default:
          return code;
      }
    },
    [t],
  );

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("transcribe.title", "Transkribering")}
    >
      {disabled && (
        <p className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
          {t(
            "transcribe.featureDisabled",
            "Transkribering er ikke bygd inn i denne versjonen.",
          )}
        </p>
      )}

      {/* ── Recording picker ────────────────────────────────────────── */}
      <label className="flex flex-col gap-1 text-sm">
        {t("transcribe.recording", "Opptak")}
        {rows.length === 0 ? (
          <span className="opacity-60">
            {t("transcribe.noRecordings", "Ingen opptak ennå")}
          </span>
        ) : (
          <select
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={effectivePath}
            onChange={(e) => setRecordingPath(e.target.value)}
            aria-label={t("transcribe.recording", "Opptak")}
          >
            {rows.map((r) => (
              <option key={r.id} value={r.file_path}>
                {fileName(r.file_path)}
              </option>
            ))}
          </select>
        )}
      </label>

      {/* ── Model picker ────────────────────────────────────────────── */}
      <label className="flex flex-col gap-1 text-sm">
        {t("transcribe.model", "Modell")}
        <select
          className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
          value={effectiveModel}
          onChange={(e) => setModelId(e.target.value)}
          aria-label={t("transcribe.model", "Modell")}
        >
          {modelList.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {/* ── Language + translate ────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t("transcribe.language", "Språk")}
          <select
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            aria-label={t("transcribe.language", "Språk")}
          >
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={translate}
            onChange={(e) => setTranslate(e.target.checked)}
            aria-label={t("transcribe.translate", "Oversett til engelsk")}
          />
          {t("transcribe.translate", "Oversett til engelsk")}
        </label>
      </div>

      <button
        type="button"
        disabled={!canTranscribe || transcribeMutation.isPending}
        className="self-start rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
        onClick={onTranscribe}
      >
        {transcribeMutation.isPending
          ? t("transcribe.running", "Transkriberer…")
          : t("transcribe.start", "Transkriber")}
      </button>

      {transcribeMutation.isError && !disabled && (
        <p className="text-xs text-red-400" role="alert">
          {t("transcribe.failed", "Transkribering feilet.")}
        </p>
      )}

      {/* ── Transcript + export ─────────────────────────────────────── */}
      {transcript && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">
              {t("transcribe.result", "Transkripsjon")}{" "}
              <span className="opacity-60">
                {t("transcribe.segmentCount", "({{n}} segmenter)", {
                  n: segmentCount,
                })}
              </span>
            </h2>
            <div className="flex gap-2">
              {EXPORT_FORMATS.map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                  onClick={() => exportMutation.mutate(fmt)}
                >
                  {fmt.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          {segmentCount === 0 ? (
            <p className="opacity-60">
              {t("transcribe.empty", "Ingen tale funnet i opptaket.")}
            </p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {transcript.segments.map((s, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <span className="shrink-0 tabular-nums opacity-50">
                    {clock(s.start)}
                  </span>
                  <span>{s.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
