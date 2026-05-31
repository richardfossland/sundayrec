/**
 * Pure, in-memory transcript search index.
 *
 * Mirrors the Electron `src/renderer/pages/search-page.ts` contract — full-text
 * search across every `<name>.transcript.json` sidecar — but as a side-effect-
 * free module: no DOM, no Tauri, no i18n. The future React panel feeds it the
 * sidecars (loaded over IPC), drives {@link searchTranscripts} on every
 * keystroke, and renders the structured hits; only the rendering is GUI work,
 * so the search itself is fully unit-testable here.
 *
 * Why a linear scan and not a search library (lunr/MiniSearch): even a
 * 200-sermon archive with ~10 000 segments is a few MB and scans in a handful
 * of milliseconds — see the Electron rationale. A library would add 50+ KB to
 * the bundle for no user-visible benefit at this scale.
 */

import type { TranscriptData } from "@/lib/bindings/TranscriptData";
import type { TranscriptSegment } from "@/lib/bindings/TranscriptSegment";

/** One transcript sidecar paired with its source recording path. */
export interface TranscriptSidecar {
  /** Source recording base path (no extension) the sidecar belongs to. */
  basePath: string;
  /** The parsed sidecar contents. */
  transcript: TranscriptData;
}

/** A built index entry: a sidecar plus a derived display name. */
export interface IndexEntry {
  basePath: string;
  /** Base filename without directory — the human label for a result card. */
  displayName: string;
  transcript: TranscriptData;
}

/** A single matched segment within an indexed recording. */
export interface SearchHit {
  entry: IndexEntry;
  /** Index of the matched segment within `entry.transcript.segments`. */
  segIndex: number;
  segment: TranscriptSegment;
  /** A ~`contextChars`-wide window around the first match, for display. */
  context: HitContext;
}

/** Highlight context: text either side of the matched substring. */
export interface HitContext {
  /** Text immediately before the match (with a leading `…` when truncated). */
  before: string;
  /** The matched substring, sliced from the original text (original casing). */
  match: string;
  /** Text immediately after the match (with a trailing `…` when truncated). */
  after: string;
}

/** Hits for one recording, grouped so a phrase repeated in one sermon does not
 *  drown out other sermons. */
export interface GroupedHits {
  entry: IndexEntry;
  hits: SearchHit[];
}

/** Aggregate stats over an index — surfaced in the panel's status line. */
export interface IndexStats {
  transcriptCount: number;
  segmentCount: number;
}

/** Minimum query length before a search runs (shorter queries browse instead). */
export const MIN_QUERY_LENGTH = 2;
/** Characters of context kept either side of a match in {@link HitContext}. */
export const DEFAULT_CONTEXT_CHARS = 60;
/** Hard cap on total hits to avoid pathological renders on huge archives. */
export const MAX_HITS = 500;

/** The basename of a path without directory, for both `/` and `\` separators. */
function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Build a search index from raw sidecars, newest-recording first (by the
 * transcript's `createdAt`). Sidecars with no segments are kept (they still
 * count toward stats and the "recently transcribed" browse list).
 */
export function buildIndex(
  sidecars: readonly TranscriptSidecar[],
): IndexEntry[] {
  return sidecars
    .map((s) => ({
      basePath: s.basePath,
      displayName: baseName(s.basePath),
      transcript: s.transcript,
    }))
    .sort((a, b) => b.transcript.createdAt - a.transcript.createdAt);
}

/** Aggregate transcript + segment counts over an index. */
export function indexStats(index: readonly IndexEntry[]): IndexStats {
  let segmentCount = 0;
  for (const e of index) segmentCount += e.transcript.segments?.length ?? 0;
  return { transcriptCount: index.length, segmentCount };
}

/**
 * Slice a ~`contextChars`-wide window around the first occurrence of `query`
 * (case-insensitive) in `text`. Returns the original-cased match plus the
 * surrounding text, with ellipses where the window was truncated.
 */
export function hitContext(
  text: string,
  query: string,
  contextChars = DEFAULT_CONTEXT_CHARS,
): HitContext {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return { before: text, match: "", after: "" };
  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + query.length + contextChars);
  const ellipsisStart = start > 0 ? "…" : "";
  const ellipsisEnd = end < text.length ? "…" : "";
  return {
    before: ellipsisStart + text.slice(start, idx),
    match: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length, end) + ellipsisEnd,
  };
}

/**
 * Linear-scan the index for every segment whose text contains `query`
 * (case-insensitive substring). Returns a flat, capped list of hits in index
 * order. A query shorter than {@link MIN_QUERY_LENGTH} matches nothing — the
 * panel should browse the recent list instead.
 */
export function searchTranscripts(
  index: readonly IndexEntry[],
  query: string,
  options: { contextChars?: number; maxHits?: number } = {},
): SearchHit[] {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) return [];
  const needle = trimmed.toLowerCase();
  const maxHits = options.maxHits ?? MAX_HITS;
  const hits: SearchHit[] = [];

  for (const entry of index) {
    const segments = entry.transcript.segments ?? [];
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.text.toLowerCase().includes(needle)) {
        hits.push({
          entry,
          segIndex: i,
          segment,
          context: hitContext(segment.text, trimmed, options.contextChars),
        });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

/**
 * Group hits by their source recording, preserving the order in which each
 * recording's first hit appeared (i.e. index/recency order).
 */
export function groupHits(hits: readonly SearchHit[]): GroupedHits[] {
  const byPath = new Map<string, GroupedHits>();
  const order: string[] = [];
  for (const hit of hits) {
    const key = hit.entry.basePath;
    let group = byPath.get(key);
    if (!group) {
      group = { entry: hit.entry, hits: [] };
      byPath.set(key, group);
      order.push(key);
    }
    group.hits.push(hit);
  }
  return order.map((k) => byPath.get(k)!);
}
