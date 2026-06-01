import { useCallback, useMemo, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { ReviewQueueEntry } from "@/lib/bindings/ReviewQueueEntry";
import type { EpisodePrep } from "@/lib/bindings/EpisodePrep";
import type { EpisodePrepStatus } from "@/lib/bindings/EpisodePrepStatus";
import type { EditorPeaks } from "@/lib/bindings/EditorPeaks";
import { REVIEW_QUEUE_KEY } from "./queryKey";

/** Tailwind classes for each prep-status badge. */
const STATUS_BADGE: Record<EpisodePrepStatus, string> = {
  analyzing: "border-border text-text2",
  ready: "border-emerald-700 text-emerald-300",
  "needs-attention": "border-accent/60 text-accent",
  published: "border-sky-700 text-sky-300",
  discarded: "border-border text-text3",
};

/** The leaf filename of a recording path (no directory, keeps the extension). */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * A tiny inline waveform sparkline. Renders the `editor_peaks` buckets as a
 * row of vertical bars so the operator can eyeball the recording's energy
 * profile (long quiet stretches, where the sermon block sits) without leaving
 * the queue. Purely presentational — the peaks are fetched on demand.
 */
function WaveformSparkline({ peaks }: { peaks: number[] }) {
  // Downsample to at most ~64 bars so the row stays compact.
  const bars = useMemo(() => {
    if (peaks.length <= 64) return peaks;
    const step = peaks.length / 64;
    const out: number[] = [];
    for (let i = 0; i < 64; i++) {
      out.push(peaks[Math.floor(i * step)] ?? 0);
    }
    return out;
  }, [peaks]);

  return (
    <div
      className="flex h-8 items-end gap-px rounded-lg bg-bg px-1 py-1"
      aria-hidden="true"
    >
      {bars.map((p, i) => (
        <span
          key={i}
          className="flex-1 rounded-sm bg-accent/70"
          style={{ height: `${Math.max(4, Math.round(p * 100))}%` }}
        />
      ))}
    </div>
  );
}

/**
 * PU-6 episode-prep / human-review queue panel. Lists the recordings the prep
 * pipeline has queued for human review (`review_queue_list`), shows the
 * prep metadata the core derived — the detected sermon length + the
 * `attentionReasons` from `prep::derive_attention_reasons` — and lets the
 * operator advance each item: approve+publish (`review_mark_published`) or
 * discard for the week (`review_mark_discarded`). A "run reminders" sweep
 * (`review_process_reminders`) advances the day-1/2/7 reminder timeline the
 * scheduler would otherwise fire.
 *
 * It also offers an inline recording preview (an `<audio>` element + an
 * optional `editor_peaks` waveform sparkline) for the selected entry, and
 * bulk publish/discard over a checkbox selection that loops the existing
 * per-entry mark commands.
 *
 * The analysis that feeds the queue (`prep_build_episode`) and the actual
 * publish are separate seams; this panel works the queue the core persists.
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked.
 */
export function ReviewPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const queue = useQuery<ReviewQueueEntry[]>({
    queryKey: REVIEW_QUEUE_KEY,
    queryFn: () => invoke<ReviewQueueEntry[]>("review_queue_list"),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: REVIEW_QUEUE_KEY });
  }, [queryClient]);

  const publishMutation = useMutation({
    mutationFn: (id: string) => invoke<boolean>("review_mark_published", { id }),
    onSuccess: invalidate,
  });
  const discardMutation = useMutation({
    mutationFn: (id: string) => invoke<boolean>("review_mark_discarded", { id }),
    onSuccess: invalidate,
  });
  const remindersMutation = useMutation({
    mutationFn: () => invoke<unknown[]>("review_process_reminders"),
    onSuccess: invalidate,
  });

  // --- Preview (selected entry) ---------------------------------------------
  const [previewId, setPreviewId] = useState<string | null>(null);
  const peaksMutation = useMutation({
    mutationFn: (path: string) =>
      invoke<EditorPeaks>("editor_peaks", { inputPath: path }),
  });

  const onPreview = useCallback(
    (entry: ReviewQueueEntry) => {
      setPreviewId((cur) => (cur === entry.id ? null : entry.id));
      if (previewId !== entry.id) {
        peaksMutation.mutate(entry.prep.recordingPath);
      }
    },
    [peaksMutation, previewId],
  );

  // --- Bulk selection -------------------------------------------------------
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSelected = useCallback((id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onDiscard = useCallback(
    (id: string) => {
      if (
        window.confirm(
          t(
            "review.discardConfirm",
            "Forkast denne episoden? Selve opptaket beholdes, men det vil ikke publiseres.",
          ),
        )
      ) {
        discardMutation.mutate(id);
      }
    },
    [discardMutation, t],
  );

  const onBulkPublish = useCallback(() => {
    for (const id of selected) publishMutation.mutate(id);
    setSelected(new Set());
  }, [publishMutation, selected]);

  const onBulkDiscard = useCallback(() => {
    if (
      window.confirm(
        t(
          "review.bulkDiscardConfirm",
          "Forkast de valgte episodene? Opptakene beholdes, men publiseres ikke.",
        ),
      )
    ) {
      for (const id of selected) discardMutation.mutate(id);
      setSelected(new Set());
    }
  }, [discardMutation, selected, t]);

  const statusLabel = useCallback(
    (status: EpisodePrepStatus): string => {
      switch (status) {
        case "analyzing":
          return t("review.statusAnalyzing", "Analyserer");
        case "ready":
          return t("review.statusReady", "Klar");
        case "needs-attention":
          return t("review.needsAttention", "Trenger oppmerksomhet");
        case "published":
          return t("review.publishedOk", "Publisert");
        case "discarded":
          return t("review.statusDiscarded", "Forkastet");
      }
    },
    [t],
  );

  /** The detected sermon length in whole minutes, or null when none was found. */
  const sermonMinutes = useCallback((prep: EpisodePrep): number | null => {
    if (!prep.suggestedTrim) return null;
    const sec = prep.suggestedTrim.endSec - prep.suggestedTrim.startSec;
    return Math.max(0, Math.round(sec / 60));
  }, []);

  const entries = queue.data ?? [];
  const active = entries.filter(
    (e) => e.prep.status !== "published" && e.prep.status !== "discarded",
  );

  // Keep selection scoped to entries that are still active.
  const selectedCount = useMemo(
    () => active.filter((e) => selected.has(e.id)).length,
    [active, selected],
  );

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("review.queueTitle", "Klare for gjennomgang og publisering")}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-text">
          {t("review.queueTitle", "Klare for gjennomgang og publisering")}
        </h2>
        {entries.length > 0 && (
          <button
            type="button"
            disabled={remindersMutation.isPending}
            className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3 disabled:opacity-50"
            onClick={() => remindersMutation.mutate()}
          >
            {t("review.runReminders", "Kjør påminnelser")}
          </button>
        )}
      </div>

      {/* Bulk action bar — shown once any entries are selected. */}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between rounded-xl border border-accent/40 bg-surface2 px-3 py-2">
          <span className="text-xs text-text2">
            {t("review.selectedCount", "{{count}} valgt", {
              count: selectedCount,
            })}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={publishMutation.isPending}
              className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-bg hover:bg-accent/90 disabled:opacity-50"
              onClick={onBulkPublish}
            >
              {t("review.bulkPublish", "Publiser valgte")}
            </button>
            <button
              type="button"
              disabled={discardMutation.isPending}
              className="rounded-lg border border-border bg-surface3 px-2 py-1 text-xs text-text2 hover:bg-surface3 disabled:opacity-50"
              onClick={onBulkDiscard}
            >
              {t("review.bulkDiscard", "Forkast valgte")}
            </button>
          </div>
        </div>
      )}

      {queue.isError ? (
        <p className="text-red-400">
          {t("review.loadError", "Kunne ikke lese gjennomgangskøen")}
        </p>
      ) : active.length === 0 ? (
        <p className="text-text3">
          {t("review.queueEmpty", "Ingen episoder venter på gjennomgang.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((e) => {
            const minutes = sermonMinutes(e.prep);
            const reasons = e.prep.attentionReasons ?? [];
            const isSelected = selected.has(e.id);
            const isPreviewing = previewId === e.id;
            const peaks =
              isPreviewing && peaksMutation.data ? peaksMutation.data.peaks : null;
            return (
              <li
                key={e.id}
                className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelected(e.id)}
                      aria-label={t("review.selectEntry", "Velg {{name}}", {
                        name: fileName(e.prep.recordingPath),
                      })}
                      className="mt-1 h-4 w-4 shrink-0 accent-accent"
                    />
                    <div className="min-w-0">
                      <p
                        className="truncate font-medium text-text"
                        title={e.prep.recordingPath}
                      >
                        {fileName(e.prep.recordingPath)}
                      </p>
                      <p className="text-xs text-text2">
                        {minutes != null
                          ? t(
                              "review.sermonMinutes",
                              "Preken antatt: {{min}} min",
                              { min: minutes },
                            )
                          : t("review.sermonNotFound", "Preken ikke detektert")}
                      </p>
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded-lg border px-1.5 py-0.5 text-xs ${STATUS_BADGE[e.prep.status]}`}
                  >
                    {statusLabel(e.prep.status)}
                  </span>
                </div>

                {/* Needs-attention reasons rendered prominently. */}
                {reasons.length > 0 && (
                  <div className="rounded-lg border border-accent/40 bg-accent/10 p-2">
                    <p className="text-xs font-medium text-accent">
                      {t("review.needsAttention", "Trenger oppmerksomhet")}
                    </p>
                    <ul className="mt-1 flex flex-col gap-0.5">
                      {reasons.map((r) => (
                        <li key={r} className="text-xs text-accent">
                          • {r}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Inline preview. */}
                {isPreviewing && (
                  <div className="flex flex-col gap-2">
                    {peaks && peaks.length > 0 && (
                      <WaveformSparkline peaks={peaks} />
                    )}
                    <audio
                      controls
                      src={convertFileSrc(e.prep.recordingPath)}
                      className="w-full"
                    >
                      {t(
                        "review.audioUnsupported",
                        "Nettleseren støtter ikke lydavspilling.",
                      )}
                    </audio>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 self-end">
                  <button
                    type="button"
                    className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3"
                    onClick={() => onPreview(e)}
                  >
                    {isPreviewing
                      ? t("review.hidePreview", "Skjul forhåndsvisning")
                      : t("review.preview", "▸ Forhåndsvis")}
                  </button>
                  <button
                    type="button"
                    disabled={publishMutation.isPending}
                    className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-bg hover:bg-accent/90 disabled:opacity-50"
                    onClick={() => publishMutation.mutate(e.id)}
                  >
                    {t("review.publishBtn", "✓ Godkjenn og publiser")}
                  </button>
                  <button
                    type="button"
                    disabled={discardMutation.isPending}
                    className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3 disabled:opacity-50"
                    onClick={() => onDiscard(e.id)}
                  >
                    {t("review.discardBtn", "✗ Ikke publiser denne uka")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
