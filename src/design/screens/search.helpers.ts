/**
 * Small, pure presentation helpers for {@link SearchScreen}.
 *
 * They turn a {@link HitContext} from the shared transcript index into the
 * exact gold `<mark>` markup the original mockup used, and format the timestamp
 * / date shown on each SearchHit card. Kept side-effect-free so the screen
 * stays a thin view over `@/features/search/searchIndex`.
 */
import type { HitContext } from "@/features/search/searchIndex";

/**
 * Escape HTML so transcript text is safe to inject, then strip any literal
 * square brackets — the screen's `highlight()` turns `[...]` into the gold
 * `<mark>`, so a stray bracket in the source text must not be mistaken for a
 * highlight marker.
 */
function safeText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/[[\]]/g, "");
}

/**
 * Build the snippet for a search hit, wrapping the matched term in `[brackets]`
 * — the exact marker the screen's `highlight()` helper converts into the gold
 * `<mark>`. Surrounding text is HTML-escaped and de-bracketed first so the only
 * brackets in the result are the ones we add, keeping the
 * `dangerouslySetInnerHTML` render safe.
 */
export function snippetWithBrackets(context: HitContext): string {
  const before = safeText(context.before);
  const after = safeText(context.after);
  if (!context.match) return before + after;
  return `${before}[${safeText(context.match)}]${after}`;
}

/** Whole seconds → `m:ss`, for the segment timestamp on each hit row.
 *  Shared with the editor (identical formatter). */
export { clock } from "./editor.helpers";

/**
 * Format a transcript `createdAt` (unix seconds or ms) as a short Norwegian
 * date for the hit card, e.g. `24. mai 2026`. Falls back to an empty string for
 * missing/invalid values so the card never shows `Invalid Date`.
 */
export function formatHitDate(createdAt: number | null | undefined): string {
  if (createdAt == null || !Number.isFinite(createdAt)) return "";
  // Sidecar timestamps are seconds; tolerate millisecond values too.
  const ms = createdAt > 1e12 ? createdAt : createdAt * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("nb-NO", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}
