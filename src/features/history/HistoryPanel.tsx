import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import { HISTORY_QUERY_KEY } from "./queryKey";
import { filterHistory, historyStats } from "./historyFilter";

/** Debounce (ms) before a note edit is auto-saved — matches the settings feel. */
const NOTE_DEBOUNCE_MS = 600;

/** The basename of a path, for display (works for both `/` and `\`). */
function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Format epoch-ms as a localised date+time, or an em-dash if absent/zero. */
function formatDate(ms: number, lang: string): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(lang);
}

/** Format a duration in ms as `h:mm:ss` / `m:ss`, or an em-dash if absent. */
function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Format a byte size as MB with one decimal, or an em-dash if absent. */
function formatSize(bytes: number | null): string {
  if (bytes == null) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One history row, with its own debounced note editor. */
function HistoryRow({
  row,
  lang,
  onDelete,
  onRevealError,
  onSaveNote,
}: {
  row: RecordingRow;
  lang: string;
  onDelete: (id: string) => void;
  onRevealError: () => void;
  onSaveNote: (id: string, note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(row.note ?? "");
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reflect server-side changes (e.g. after a refetch) into the local field.
  useEffect(() => {
    setNote(row.note ?? "");
  }, [row.note]);

  useEffect(() => {
    return () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    };
  }, []);

  const onNoteChange = useCallback(
    (value: string) => {
      setNote(value);
      if (noteTimer.current) clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => {
        onSaveNote(row.id, value);
      }, NOTE_DEBOUNCE_MS);
    },
    [onSaveNote, row.id],
  );

  const reveal = useCallback(async () => {
    try {
      await revealItemInDir(row.file_path);
    } catch {
      onRevealError();
    }
  }, [row.file_path, onRevealError]);

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-zinc-700 p-3 text-left">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium" title={row.file_path}>
            {fileName(row.file_path)}
          </p>
          <p className="text-xs opacity-70">
            {formatDate(row.created_at, lang)} ·{" "}
            {formatDuration(row.duration_ms)} · {formatSize(row.byte_size)}
          </p>
          <p className="text-xs opacity-50">
            {row.device_name ?? t("history.unknownDevice", "Ukjent enhet")}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => void reveal()}
          >
            {t("history.revealInFolder", "Vis i mappe")}
          </button>
          <button
            type="button"
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
            onClick={() => {
              void invoke("open_in_sundayedit", { path: row.file_path }).catch(
                () => {},
              );
            }}
          >
            {t("history.openInEdit", "Åpne i SundayEdit")}
          </button>
          <button
            type="button"
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
            aria-label={t("history.deleteEntry", "Slett oppføring")}
            onClick={() => onDelete(row.id)}
          >
            {t("history.deleteEntry", "Slett oppføring")}
          </button>
        </div>
      </div>
      <input
        type="text"
        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
        aria-label={t("history.editNote", "Rediger notat")}
        placeholder={t("history.notePlaceholder", "Skriv notat…")}
        value={note}
        onChange={(e) => onNoteChange(e.target.value)}
      />
    </li>
  );
}

/**
 * F1.3 recording-history panel. Lists recordings newest-first over IPC
 * (`recordings_list`), formats duration/size, and offers per-row delete,
 * "reveal in folder" (native opener), and an inline debounced note editor
 * (`recording_update_note`). A "clear history" button wipes the list
 * (`recordings_clear`). Both destructive actions confirm first.
 *
 * The reveal action is GUI/HARDWARE-UNVERIFIED (needs a real file on disk and a
 * desktop shell); it is exercised here with the opener plugin mocked.
 */
export function HistoryPanel() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery<RecordingRow[]>({
    queryKey: HISTORY_QUERY_KEY,
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });

  const [revealError, setRevealError] = useState(false);
  const [query, setQuery] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: HISTORY_QUERY_KEY });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => invoke<void>("recordings_delete", { id }),
    onSuccess: invalidate,
  });

  const clearMutation = useMutation({
    mutationFn: () => invoke<void>("recordings_clear"),
    onSuccess: invalidate,
  });

  const noteMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      invoke<void>("recording_update_note", {
        id,
        note: note.length > 0 ? note : null,
      }),
  });

  const onDelete = useCallback(
    (id: string) => {
      if (
        window.confirm(
          t("history.confirmDelete", "Slett dette opptaket fra historikken?"),
        )
      ) {
        deleteMutation.mutate(id);
      }
    },
    [deleteMutation, t],
  );

  const onClear = useCallback(() => {
    if (window.confirm(t("history.confirmClear", "Slett hele historikken?"))) {
      clearMutation.mutate();
    }
  }, [clearMutation, t]);

  const onSaveNote = useCallback(
    (id: string, note: string) => noteMutation.mutate({ id, note }),
    [noteMutation],
  );

  // Pure filter/stats (mirrors home.ts filterAndRenderHistory + updateHistoryStats):
  // search the full set, but compute stats over everything (Electron parity).
  // Computed before the early returns so the hook order stays stable.
  const allRows = useMemo(() => data ?? [], [data]);
  const rows = useMemo(() => filterHistory(allRows, query), [allRows, query]);
  const stats = useMemo(() => historyStats(allRows), [allRows]);

  if (isLoading) {
    return (
      <p className="opacity-70">
        {t("home.connecting", "Kobler til backend …")}
      </p>
    );
  }

  if (isError) {
    return (
      <p className="text-red-400">
        {t("history.loadError", "Kunne ikke laste historikken")}
      </p>
    );
  }

  return (
    <section
      className="flex w-full max-w-md flex-col gap-3"
      aria-label={t("history.title", "Historikk")}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">
          {t("history.title", "Historikk")}
        </h2>
        {allRows.length > 0 && (
          <button
            type="button"
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
            onClick={onClear}
          >
            {t("history.clearBtn", "Slett alle")}
          </button>
        )}
      </div>

      {allRows.length > 0 && (
        <>
          <input
            type="search"
            className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
            aria-label={t("history.searchPlaceholder", "Søk i historikk…")}
            placeholder={t("history.searchPlaceholder", "Søk i historikk…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {stats.count > 0 && (
            <p className="text-xs opacity-60" data-testid="history-stats">
              {stats.count} {t("history.totalCount", "opptak")} ·{" "}
              {formatDuration(stats.totalDurationMs)}{" "}
              {t("history.totalDuration", "totalt")}
              {stats.lastRecordedAt != null && (
                <>
                  {" "}
                  · {t("history.lastRecording", "sist")}{" "}
                  {formatDate(stats.lastRecordedAt, i18n.language)}
                </>
              )}
            </p>
          )}
        </>
      )}

      {revealError && (
        <p className="text-xs text-amber-400" role="alert">
          {t(
            "history.revealError",
            "Kunne ikke åpne mappen — filen finnes kanskje ikke lenger",
          )}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="opacity-60">
          {allRows.length > 0 && query.trim() !== ""
            ? t("search.noHits", "Ingen treff for")
            : t("history.empty", "Ingen opptak ennå")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <HistoryRow
              key={row.id}
              row={row}
              lang={i18n.language}
              onDelete={onDelete}
              onRevealError={() => setRevealError(true)}
              onSaveNote={onSaveNote}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
