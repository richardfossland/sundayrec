/**
 * Søk — full-text search across transcribed recordings. Ported from
 * `sr-edit-search.jsx`, now wired to the real transcript index.
 *
 * The visual design is unchanged: same `sr-*` markup, cozy reading width, the
 * SearchHit card structure, the gold <mark> highlight and the Norwegian copy.
 * Only the data is real now — a controlled search box drives the pure
 * {@link searchTranscripts} scan over the loaded sidecars (same functions the
 * canonical {@link SearchPage} uses), and clicking a hit triggers the same
 * "open in editor / SundayEdit" action.
 *
 * Robustness: the Tauri build does not yet expose a command to read the
 * `<name>.transcript.json` sidecars back, so the index is empty in dev/test;
 * every IPC call is best-effort and never throws, and the panel shows a calm
 * empty-state instead.
 */
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import { HISTORY_QUERY_KEY } from "@/features/history/queryKey";
import { SHELL_NAVIGATE_EVENT } from "@/components/MainLayout";
import {
  buildIndex,
  groupHits,
  indexStats,
  searchTranscripts,
  MIN_QUERY_LENGTH,
  type TranscriptSidecar,
} from "@/features/search/searchIndex";

import { clock, formatHitDate, snippetWithBrackets } from "./search.helpers";

import { Icon } from "../Icon";
import { Badge } from "../atoms";

function highlight(s: string): string {
  // The mockup marks query hits with [brackets]; render them as gold <mark>.
  return s.replace(
    /\[(.*?)\]/g,
    '<mark style="background:var(--sr-gold-tint-2);color:var(--sr-gold-bright);border-radius:3px;padding:0 2px">$1</mark>',
  );
}

function SearchHit({
  title,
  date,
  snippet,
  time,
  onOpen,
}: {
  title: string;
  date: string;
  snippet: string;
  time: string;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="sr-card pad" style={{ cursor: "pointer" }} onClick={onOpen}>
      <div className="sr-row" style={{ marginBottom: 8 }}>
        <Icon name="file" size={15} style={{ color: "var(--sr-gold)" }} />
        <span className="sr-grow" style={{ fontSize: 14, fontWeight: 600 }}>
          {title}
        </span>
        <span style={{ fontSize: 12, color: "var(--sr-text-3)" }}>{date}</span>
      </div>
      <div
        style={{ fontSize: 13.5, color: "var(--sr-text-2)", lineHeight: 1.5 }}
        dangerouslySetInnerHTML={{ __html: highlight(snippet) }}
      />
      <div className="sr-row" style={{ gap: 8, marginTop: 10 }}>
        <Badge kind="muted">
          <Icon name="play" size={11} fill style={{ marginRight: 2 }} />
          {t("searchScreen.openAt", "Åpne på {{time}}", { time })}
        </Badge>
      </div>
    </div>
  );
}

/**
 * Load the transcript sidecars to index. `transcripts_list` returns every
 * recording's parsed `<name>.transcript.json` (shaped as `{ basePath,
 * transcript }`); the recordings list still drives the empty-state count so the
 * UI can distinguish "no recordings" from "recordings, none transcribed yet".
 */
function useTranscriptSidecars(): {
  sidecars: TranscriptSidecar[];
  recordingCount: number;
} {
  const recordings = useQuery<RecordingRow[]>({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });
  const transcripts = useQuery<TranscriptSidecar[]>({
    queryKey: ["transcripts_list"],
    queryFn: () => invoke<TranscriptSidecar[]>("transcripts_list"),
  });
  const rows = recordings.data ?? [];
  const sidecars = transcripts.data ?? [];
  return { sidecars, recordingCount: rows.length };
}

/** Ask the shell to open a recording in the editor view at a timestamp. */
function openHit(basePath: string): void {
  // Same action SearchPage uses: switch the shell to the editor view, then
  // best-effort offer the external SundayEdit deep-link (ignored off-Tauri).
  window.dispatchEvent(
    new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: "editor" }),
  );
  void invoke("open_in_sundayedit", { path: basePath }).catch(() => {});
}

export function SearchScreen() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { sidecars, recordingCount } = useTranscriptSidecars();

  const index = useMemo(() => buildIndex(sidecars), [sidecars]);
  const stats = useMemo(() => indexStats(index), [index]);

  const groups = useMemo(() => {
    const hits = searchTranscripts(index, query);
    return groupHits(hits);
  }, [index, query]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= MIN_QUERY_LENGTH;

  const totalHits = useMemo(
    () => groups.reduce((n, g) => n + g.hits.length, 0),
    [groups],
  );

  const queryClient = useQueryClient();
  const [reindexing, setReindexing] = useState(false);
  const refreshIndex = useCallback(() => {
    setReindexing(true);
    // Re-pull both the recordings list and the transcript sidecars the index is
    // built from. Best-effort; never throws in dev/test.
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ["transcripts_list"] }),
    ]).finally(() => setReindexing(false));
  }, [queryClient]);

  return (
    <div className="sr-content cozy">
      <div className="sr-pagehead">
        <div className="sr-pagetitle">
          {t("searchScreen.title", "Søk i prekener")}
        </div>
        <div className="sr-pagesub">
          {t(
            "searchScreen.subtitle",
            "Søk på tvers av alle transkriberte opptak. Klikk på et treff for å åpne opptaket på det punktet.",
          )}
        </div>
      </div>
      <div className="sr-row" style={{ gap: 10, marginBottom: 20 }}>
        <label className="sr-row sr-grow sr-input" style={{ gap: 10 }}>
          <Icon name="search" size={17} style={{ color: "var(--sr-text-3)" }} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(
              "searchScreen.placeholder",
              "Søk etter ord eller fraser…",
            )}
            aria-label={t("searchScreen.title", "Søk i prekener")}
            className="sr-grow"
            style={{
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--sr-text)",
              fontSize: "inherit",
              fontFamily: "inherit",
              minWidth: 0,
            }}
          />
        </label>
        <button
          className="sr-btn ghost"
          onClick={refreshIndex}
          disabled={reindexing}
        >
          <Icon name="refresh" size={15} />
          {reindexing
            ? t("searchScreen.reindexing", "Oppdaterer…")
            : t("searchScreen.reindex", "Oppdater indeks")}
        </button>
      </div>
      <div
        style={{ fontSize: 12.5, color: "var(--sr-text-3)", marginBottom: 12 }}
      >
        {hasQuery
          ? t(
              "searchScreen.hitsCount",
              "{{hits}} treff i {{recordings}} opptak",
              {
                hits: totalHits,
                recordings: groups.length,
              },
            )
          : t(
              "searchScreen.minQuery",
              "Skriv minst to tegn for å søke i transkripsjonene.",
            )}
      </div>
      {!hasQuery ? null : groups.length === 0 ? (
        <div
          className="sr-card pad"
          style={{ fontSize: 13.5, color: "var(--sr-text-3)" }}
        >
          {stats.transcriptCount === 0
            ? recordingCount > 0
              ? t(
                  "searchScreen.emptyNoTranscripts",
                  "Ingen transkripsjoner ennå — åpne et opptak i Rediger og klikk Transkriber for å bygge opp et søkbart arkiv.",
                )
              : t(
                  "searchScreen.emptyNoRecordings",
                  "Ingen transkripsjoner ennå — transkriber et opptak først.",
                )
            : t("searchScreen.noHits", "Ingen treff for «{{query}}».", {
                query: trimmed,
              })}
        </div>
      ) : (
        <div className="sr-stack-3">
          {groups.map((group) =>
            group.hits.map((hit) => (
              <SearchHit
                key={`${group.entry.basePath}#${hit.segIndex}`}
                title={group.entry.displayName}
                date={formatHitDate(group.entry.transcript.createdAt)}
                time={clock(hit.segment.start)}
                snippet={snippetWithBrackets(hit.context)}
                onOpen={() => openHit(group.entry.basePath)}
              />
            )),
          )}
        </div>
      )}
    </div>
  );
}
