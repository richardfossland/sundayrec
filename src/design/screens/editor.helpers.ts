/**
 * Small, pure presentation helpers for {@link EditScreen}.
 *
 * They turn the editor IPC results ({@link EditorMediaInfo}, {@link EditorPeaks})
 * into the exact shapes the original "Rediger" mockup rendered — a duration/
 * format meta string, the fixed-count waveform bar array, and the time-axis
 * ticks — without reimplementing any waveform maths (that lives in the shared
 * `@/features/editor/*` helpers). Kept side-effect-free so the screen stays a
 * thin view over the editor feature's IPC contract.
 */
import type { EditorMediaInfo } from "@/lib/bindings/EditorMediaInfo";
import type { EditorCutRegion } from "@/lib/bindings/EditorCutRegion";

/** The number of bars the design's `Waveform` renders. */
export const WAVE_BARS = 150;

/** Tolerance (seconds) below which a trim edge is treated as "at the bound". */
const TRIM_EPSILON = 0.05;

/** Parse a free-text `HH:MM:SS` / `MM:SS` / `SS` field to seconds; `null` when
 *  empty or non-numeric (so the caller falls back to the file bound). */
export function parseHms(value: string): number | null {
  const str = value.trim();
  if (!str) return null;
  const parts = str.split(":").map((p) => Number(p));
  if (parts.length === 0 || parts.length > 3) return null;
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** `seconds → "HH:MM:SS"`, the trim fields' display format. */
export function formatHms(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * Turn the two trim fields into the cut regions to REMOVE: everything before
 * `start` and everything after `end`. Empty/invalid fields fall back to the
 * file bounds (0 / `duration`), so an untouched trim exports the whole file.
 * Matches `editor_export`'s `cutRegions` contract (regions are cut out).
 */
export function buildTrimCuts(
  trimStart: string,
  trimEnd: string,
  duration: number,
): EditorCutRegion[] {
  if (!(duration > 0)) return [];
  const clamp = (v: number) => Math.min(Math.max(v, 0), duration);
  const start = clamp(parseHms(trimStart) ?? 0);
  const end = clamp(parseHms(trimEnd) ?? duration);
  const cuts: EditorCutRegion[] = [];
  if (start > TRIM_EPSILON) cuts.push({ start: 0, end: start });
  if (end < duration - TRIM_EPSILON && end > start)
    cuts.push({ start: end, end: duration });
  return cuts;
}

/** `seconds → "M min S s"`, matching the mockup's file-bar duration copy. */
export function formatDurationLong(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

/** `seconds → "M:SS"`, for the playhead readout + axis ticks. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

/** The basename of a path, for display (works for both `/` and `\`). */
export function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/**
 * Whether a loaded file should render as the video variant. We auto-detect from
 * the probe (a stream with video → video variant); falls back to `null` so the
 * caller can keep the user's manual ModeSwitch choice when nothing is loaded.
 */
export function variantForMedia(
  info: EditorMediaInfo | null | undefined,
): "audio" | "video" | null {
  if (!info) return null;
  return info.hasVideo ? "video" : "audio";
}

/**
 * The secondary "32 min 14 s · WAV · 48 kHz" line under the file name. Built
 * from whatever the probe surfaced; missing fields are simply dropped so the
 * line degrades gracefully rather than printing `undefined`.
 */
export function mediaMeta(
  info: EditorMediaInfo | null | undefined,
  format: string | null,
): string {
  if (!info) return "";
  const parts: string[] = [formatDurationLong(info.durationSec)];
  if (format) parts.push(format.toUpperCase());
  if (info.channels != null) {
    parts.push(info.channels === 1 ? "mono" : `${info.channels} kanaler`);
  }
  if (info.sampleFmt) parts.push(info.sampleFmt);
  return parts.join(" · ");
}

/** The container extension (lowercase, no dot) of a path, e.g. `mp3`. */
export function fileExt(path: string): string {
  const m = /\.([^./\\]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
}

/**
 * Downsample (or pad) the raw peaks array to exactly {@link WAVE_BARS} bar
 * heights in `[0, 1]`, so the design's fixed-bar waveform paints real data.
 * Each output bucket takes the max-abs of the peaks that map into it (the same
 * "max per bucket" the core uses), preserving transients. Empty peaks → `[]`,
 * letting the caller fall back to the neutral placeholder.
 */
export function peaksToBars(peaks: number[], bars = WAVE_BARS): number[] {
  if (peaks.length === 0) return [];
  if (peaks.length === bars) return peaks.slice();
  const out: number[] = new Array(bars).fill(0);
  for (let i = 0; i < bars; i++) {
    const lo = Math.floor((i / bars) * peaks.length);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) / bars) * peaks.length));
    let max = 0;
    for (let j = lo; j < hi && j < peaks.length; j++) {
      const v = Math.abs(peaks[j]!);
      if (v > max) max = v;
    }
    // Floor the bar so a near-silent file still shows a faint baseline, exactly
    // like the original pseudo-bars never hit zero height.
    out[i] = Math.max(0.06, max);
  }
  return out;
}

/**
 * The mono-spaced axis ticks under the waveform — evenly spaced `M:SS` labels
 * across `[0, duration]`. `count` matches the mockup's seven ticks.
 */
export function axisTicks(durationSec: number, count = 7): string[] {
  if (durationSec <= 0) {
    return ["0:00", "5:00", "10:00", "15:00", "20:00", "25:00", "30:00"];
  }
  return Array.from({ length: count }, (_v, i) =>
    clock((durationSec * i) / (count - 1)),
  );
}
