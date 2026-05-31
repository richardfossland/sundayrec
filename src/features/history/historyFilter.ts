/**
 * Pure history filtering / grouping / stats.
 *
 * Mirrors the Electron `filterAndRenderHistory` + `updateHistoryStats` +
 * audio/video pairing logic in `src/renderer/pages/home.ts`, but ported to the
 * Tauri `RecordingRow` shape and kept side-effect-free so the HistoryPanel can
 * stay a thin renderer. No DOM, no Tauri, no i18n.
 *
 * Parity notes vs. the Electron renderer:
 *   - search matches the filename, the local/ISO date and the free-text note,
 *     all case-insensitively (the Electron version matched filename + date +
 *     note the same way);
 *   - audio+video recordings from the same session are paired into one row.
 *     The Electron heuristic keyed on identical `date`+`startTime` with one of
 *     the pair carrying `note === 'Video'`; here we key on the identical
 *     `started_at` epoch with one row being a video file (by extension) or
 *     note-tagged, since the Tauri row has no separate start-time string;
 *   - stats sum the duration and count the recordings (the Electron version
 *     only counted `ok` rows, but the Tauri history table stores completed
 *     recordings only, so every row counts).
 */

import type { RecordingRow } from "@/lib/bindings/RecordingRow";

/** Video container extensions that mark a row as the video half of a pair. */
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "webm", "avi", "m4v"]);

/** The basename of a path, for display + search (handles `/` and `\`). */
export function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Lowercased file extension (no dot), or "" when there is none. */
function extensionOf(path: string): string {
  const base = fileName(path);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** True when a row is the video side of a session (by extension or note tag). */
export function isVideoRow(row: RecordingRow): boolean {
  if (VIDEO_EXTENSIONS.has(extensionOf(row.file_path))) return true;
  return (row.note ?? "").trim().toLowerCase() === "video";
}

/** ISO `YYYY-MM-DD` for an epoch-ms timestamp (used for date search + grouping). */
export function isoDate(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Case-insensitive full-text filter over filename, ISO date and note. An empty
 * (or whitespace-only) query returns the input unchanged.
 */
export function filterHistory(
  rows: readonly RecordingRow[],
  query: string,
): RecordingRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) => {
    const name = fileName(r.file_path).toLowerCase();
    const date = isoDate(r.started_at).toLowerCase();
    const note = (r.note ?? "").toLowerCase();
    return name.includes(q) || date.includes(q) || note.includes(q);
  });
}

/** An audio recording with an optional paired video recording. */
export interface PairedRecording {
  audio: RecordingRow;
  video: RecordingRow | null;
}

/**
 * Pair audio+video rows from the same session. Two adjacent rows pair when they
 * share a `started_at` and exactly one of them is a video row; the audio row
 * leads the pair. Order is otherwise preserved (callers pass newest-first).
 */
export function pairAudioVideo(
  rows: readonly RecordingRow[],
): PairedRecording[] {
  const out: PairedRecording[] = [];
  let i = 0;
  while (i < rows.length) {
    const curr = rows[i];
    const next = rows[i + 1];
    const isPair =
      next != null &&
      curr.started_at === next.started_at &&
      isVideoRow(curr) !== isVideoRow(next);
    if (isPair) {
      const [audio, video] = isVideoRow(curr) ? [next, curr] : [curr, next];
      out.push({ audio, video });
      i += 2;
    } else {
      out.push({ audio: curr, video: null });
      i += 1;
    }
  }
  return out;
}

/** Aggregate history stats surfaced in the panel header. */
export interface HistoryStats {
  /** Number of recordings (audio rows; a paired video does not double-count). */
  count: number;
  /** Total recorded duration in milliseconds (rows with a null duration skip). */
  totalDurationMs: number;
  /** The most recent `started_at` epoch-ms, or null when there are no rows. */
  lastRecordedAt: number | null;
}

/**
 * Compute history stats over the *paired* recordings so an audio+video session
 * counts once and its duration is taken from the audio half (the canonical
 * length), matching the Electron stats row.
 */
export function historyStats(rows: readonly RecordingRow[]): HistoryStats {
  const paired = pairAudioVideo(rows);
  let totalDurationMs = 0;
  let lastRecordedAt: number | null = null;
  for (const { audio } of paired) {
    if (audio.duration_ms != null) totalDurationMs += audio.duration_ms;
    if (lastRecordedAt === null || audio.started_at > lastRecordedAt) {
      lastRecordedAt = audio.started_at;
    }
  }
  return { count: paired.length, totalDurationMs, lastRecordedAt };
}
