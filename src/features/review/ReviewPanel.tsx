import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { ReviewQueueEntry } from "@/lib/bindings/ReviewQueueEntry";
import type { EpisodePrep } from "@/lib/bindings/EpisodePrep";
import type { EpisodePrepStatus } from "@/lib/bindings/EpisodePrepStatus";
import { REVIEW_QUEUE_KEY } from "./queryKey";

/** Tailwind classes for each prep-status badge. */
const STATUS_BADGE: Record<EpisodePrepStatus, string> = {
  analyzing: "border-zinc-600 text-zinc-300",
  ready: "border-emerald-700 text-emerald-300",
  "needs-attention": "border-amber-700 text-amber-300",
  published: "border-sky-700 text-sky-300",
  discarded: "border-zinc-700 text-zinc-500",
};

/** The leaf filename of a recording path (no directory, keeps the extension). */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
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
    (e) =>
      e.prep.status !== "published" && e.prep.status !== "discarded",
  );

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("review.queueTitle", "Klare for gjennomgang og publisering")}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">
          {t("review.queueTitle", "Klare for gjennomgang og publisering")}
        </h2>
        {entries.length > 0 && (
          <button
            type="button"
            disabled={remindersMutation.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            onClick={() => remindersMutation.mutate()}
          >
            {t("review.runReminders", "Kjør påminnelser")}
          </button>
        )}
      </div>

      {queue.isError ? (
        <p className="text-red-400">
          {t("review.loadError", "Kunne ikke lese gjennomgangskøen")}
        </p>
      ) : active.length === 0 ? (
        <p className="opacity-60">
          {t("review.queueEmpty", "Ingen episoder venter på gjennomgang.")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((e) => {
            const minutes = sermonMinutes(e.prep);
            const reasons = e.prep.attentionReasons ?? [];
            return (
              <li
                key={e.id}
                className="flex flex-col gap-2 rounded-lg border border-zinc-700 p-3 text-left"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p
                      className="truncate font-medium"
                      title={e.prep.recordingPath}
                    >
                      {fileName(e.prep.recordingPath)}
                    </p>
                    <p className="text-xs opacity-70">
                      {minutes != null
                        ? t(
                            "review.sermonMinutes",
                            "Preken antatt: {{min}} min",
                            { min: minutes },
                          )
                        : t("review.sermonNotFound", "Preken ikke detektert")}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-xs ${STATUS_BADGE[e.prep.status]}`}
                  >
                    {statusLabel(e.prep.status)}
                  </span>
                </div>

                {reasons.length > 0 && (
                  <ul className="flex flex-col gap-0.5">
                    {reasons.map((r) => (
                      <li key={r} className="text-xs text-amber-300">
                        • {r}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex gap-2 self-end">
                  <button
                    type="button"
                    disabled={publishMutation.isPending}
                    className="rounded border border-emerald-700 px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950 disabled:opacity-50"
                    onClick={() => publishMutation.mutate(e.id)}
                  >
                    {t("review.publishBtn", "✓ Godkjenn og publiser")}
                  </button>
                  <button
                    type="button"
                    disabled={discardMutation.isPending}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
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
