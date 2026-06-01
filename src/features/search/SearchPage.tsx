import { useCallback, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import { HISTORY_QUERY_KEY } from "@/features/history/queryKey";
import { SHELL_NAVIGATE_EVENT } from "@/components/MainLayout";
import {
  buildIndex,
  groupHits,
  indexStats,
  searchTranscripts,
  MIN_QUERY_LENGTH,
  type GroupedHits,
  type TranscriptSidecar,
} from "./searchIndex";

/**
 * "Søk i prekener" — full-text search across transcript sidecars, mirroring the
 * Electron `search-page.ts`. The pure scan lives in {@link searchTranscripts};
 * this panel feeds it the loaded sidecars, runs it on every keystroke, and
 * renders the grouped hits as clickable rows that open the recording in the
 * editor view (via the shell {@link SHELL_NAVIGATE_EVENT}).
 *
 * Sidecars are written next to each recording as `<name>.transcript.json` (by
 * the whisper export + the Verbatim import). The Tauri build does not yet expose
 * a command to *read* those sidecars back, so the index is currently empty and
 * the panel shows a calm empty-state; the search box still operates over the
 * (empty) index so the flow is correct the moment a loader command lands. We do
 * not invent a backend command here — the index source is the single seam to
 * fill in later.
 */

/**
 * Load the transcript sidecars to index. The recordings list tells us which
 * recordings exist; pairing each with its parsed sidecar needs a backend read
 * command that does not exist yet, so this returns no sidecars today. Kept as a
 * named seam so the only future change is wiring a real loader here.
 */
function useTranscriptSidecars(): {
  sidecars: TranscriptSidecar[];
  recordingCount: number;
  isLoading: boolean;
} {
  const recordings = useQuery<RecordingRow[]>({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });
  const rows = recordings.data ?? [];
  // No `transcript_read`/`transcripts_list` command exists; until one does the
  // index has no sidecars to scan.
  const sidecars = useMemo<TranscriptSidecar[]>(() => [], []);
  return {
    sidecars,
    recordingCount: rows.length,
    isLoading: recordings.isLoading,
  };
}

/** Whole seconds → `m:ss`, for the segment timestamp on each hit row. */
function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** Ask the shell to open a recording in the editor view. */
function openInEditor(basePath: string): void {
  // Surface the choice to the user by switching to the editor view; the deep
  // recording-path open is the editor's own concern.
  window.dispatchEvent(
    new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: "editor" }),
  );
  // Best-effort: also offer the external SundayEdit deep-link (same pattern as
  // the history rows), ignoring failures in non-Tauri/test contexts.
  void invoke("open_in_sundayedit", { path: basePath }).catch(() => {});
}

export function SearchPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { sidecars, recordingCount, isLoading } = useTranscriptSidecars();
  const [query, setQuery] = useState("");

  const index = useMemo(() => buildIndex(sidecars), [sidecars]);
  const stats = useMemo(() => indexStats(index), [index]);

  const groups: GroupedHits[] = useMemo(() => {
    const hits = searchTranscripts(index, query);
    return groupHits(hits);
  }, [index, query]);

  const totalHits = useMemo(
    () => groups.reduce((n, g) => n + g.hits.length, 0),
    [groups],
  );

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= MIN_QUERY_LENGTH;

  const refreshIndex = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });
  }, [queryClient]);

  return (
    <div className="flex w-full max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">
          {t("search.title", "Søk i prekener")}
        </h1>
        <p className="text-sm text-text2">
          {t(
            "search.subtitle",
            "Søk på tvers av alle transkriberte opptak. Klikk på et treff for å åpne opptaket på det punktet.",
          )}
        </p>
      </header>

      <div className="flex items-center gap-2">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.placeholder", "Søk etter ord eller fraser…")}
          aria-label={t("search.title", "Søk i prekener")}
          className="flex-1 rounded border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-text3 focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={refreshIndex}
          className="rounded border border-border bg-surface2 px-3 py-2 text-sm text-text2 transition-colors hover:bg-surface3 hover:text-text"
        >
          {t("search.reindex", "Oppdater indeks")}
        </button>
      </div>

      <p className="text-xs text-text3">
        {t("search.stats", "{{transcripts}} transkripsjoner · {{segments}} segmenter", {
          transcripts: stats.transcriptCount,
          segments: stats.segmentCount,
        })}
        {hasQuery &&
          ` · ${t("search.matchCount", "{{count}} treff", { count: totalHits })}`}
      </p>

      {/* ── Results / empty states ───────────────────────────────────── */}
      {!hasQuery ? (
        stats.transcriptCount === 0 ? (
          <EmptyIndex
            isLoading={isLoading}
            recordingCount={recordingCount}
            t={t}
          />
        ) : (
          <p className="text-sm text-text3">
            {t(
              "search.prompt",
              "Skriv minst to tegn for å søke i transkripsjonene.",
            )}
          </p>
        )
      ) : groups.length === 0 ? (
        <p className="text-sm text-text3">
          {t("search.noHits", "Ingen treff for")} «{trimmed}».
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {groups.map((group) => (
            <li
              key={group.entry.basePath}
              className="rounded border border-border bg-surface"
            >
              <button
                type="button"
                data-result={group.entry.basePath}
                onClick={() => openInEditor(group.entry.basePath)}
                className="flex w-full flex-col gap-2 px-3 py-2 text-left transition-colors hover:bg-surface2"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-accent">
                    {group.entry.displayName}
                  </span>
                  <span className="text-xs text-text3">
                    {t("search.hitsInRecording", "{{count}} treff", {
                      count: group.hits.length,
                    })}
                  </span>
                </span>
                {group.hits.slice(0, 3).map((hit) => (
                  <span
                    key={hit.segIndex}
                    className="flex gap-2 text-sm text-text2"
                  >
                    <span className="shrink-0 tabular-nums text-text3">
                      {clock(hit.segment.start)}
                    </span>
                    <span>
                      {hit.context.before}
                      <mark className="bg-accent/30 text-text">
                        {hit.context.match}
                      </mark>
                      {hit.context.after}
                    </span>
                  </span>
                ))}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Empty-state shown when nothing has been indexed yet. */
function EmptyIndex({
  isLoading,
  recordingCount,
  t,
}: {
  isLoading: boolean;
  recordingCount: number;
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string;
}) {
  if (isLoading) {
    return (
      <p className="text-sm text-text3">{t("search.loading", "Laster …")}</p>
    );
  }
  return (
    <div className="rounded border border-dashed border-border bg-surface p-4 text-sm text-text3">
      <p className="font-medium text-text2">
        {t("search.noTranscriptsTitle", "Ingen transkripsjoner ennå")}
      </p>
      <p className="mt-1">
        {recordingCount > 0
          ? t(
              "search.noTranscriptsDesc",
              "Åpne et opptak i Rediger og klikk Transkriber for å bygge opp et søkbart arkiv. Når du har én eller flere transkripsjoner, vises de her.",
            )
          : t(
              "search.empty",
              "Ingen transkripsjoner ennå — transkriber et opptak først.",
            )}
      </p>
    </div>
  );
}
