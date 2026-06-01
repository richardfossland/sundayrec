/**
 * Small pure helpers for wiring HomeScreen to live IPC data, kept out of the
 * component so the JSX stays focused on the (unchanged) design markup.
 */
import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import type { VuLevels } from "@/lib/bindings/VuLevels";

/** Pick the human-readable name of the default/first input device, if any. */
export function defaultInputName(
  devices: AudioDeviceList | null,
): string | null {
  if (!devices || devices.inputs.length === 0) return null;
  const def = devices.inputs.find((d) => d.is_default);
  return (def ?? devices.inputs[0]).name;
}

/** Meta line for the mic device card (`Innebygd · stereo · 48 kHz`). */
export function inputMeta(devices: AudioDeviceList | null): string | null {
  if (!devices || devices.inputs.length === 0) return null;
  const def = devices.inputs.find((d) => d.is_default) ?? devices.inputs[0];
  const layout = def.channels >= 2 ? "stereo" : "mono";
  const rate = def.sample_rates.includes(48000)
    ? 48000
    : (def.sample_rates[def.sample_rates.length - 1] ?? null);
  const rateLabel = rate ? `${Math.round(rate / 1000)} kHz` : null;
  return [layout, rateLabel].filter(Boolean).join(" · ");
}

/** Peak dBFS for a channel, falling back to the mono channel when absent. */
export function channelPeak(
  levels: VuLevels | null,
  ch: number,
): number | null {
  if (!levels) return null;
  const peaks = levels.peak_dbfs;
  if (peaks.length === 0) return null;
  return peaks[ch] ?? peaks[0] ?? null;
}

/** Lit-segment count for the big (40-segment) L/R meter. */
export function bigMeterLit(db: number | null): number {
  if (db == null || !Number.isFinite(db)) return 0;
  const FLOOR = -60;
  if (db <= FLOOR) return 0;
  if (db >= 0) return 40;
  return Math.round(((db - FLOOR) / -FLOOR) * 40);
}

/** Render a scheduler `next` ISO-ish string as a short Norwegian date. */
export function formatNextDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("nb-NO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ── Storage / disk estimate ──────────────────────────────────────────────

/** Approximate on-disk bitrate (bytes per second) for the active mode. */
const VIDEO_BYTES_PER_HOUR = 3.5 * 1_000_000_000; // ~3.5 GB/h combined MP4
const AUDIO_BYTES_PER_HOUR = 0.6 * 1_000_000_000; // ~0.6 GB/h stereo WAV

/** Below this much free space the Disk readiness chip warns. */
export const DISK_LOW_BYTES = 4 * 1_000_000_000; // 4 GB

/** A sensible "full" cap so the progress bar has a reference (1 TB). */
const DISK_BAR_CAP_BYTES = 1_000_000_000_000; // 1 TB

/**
 * Estimated hours of recording left given free bytes and the current mode.
 * Returns `null` when free space is unknown so callers can fall back to copy.
 */
export function recordingHoursLeft(
  freeBytes: number | null | undefined,
  video: boolean,
): number | null {
  if (freeBytes == null || !Number.isFinite(freeBytes) || freeBytes <= 0) {
    return null;
  }
  const perHour = video ? VIDEO_BYTES_PER_HOUR : AUDIO_BYTES_PER_HOUR;
  return freeBytes / perHour;
}

/** Human meta line for the storage card (e.g. `~38 timer opptak igjen`). */
export function storageEstimateLabel(
  freeBytes: number | null | undefined,
  video: boolean,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string,
): string | null {
  const hours = recordingHoursLeft(freeBytes, video);
  if (hours == null) return null;
  const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return video
    ? t("homeScreen.storageHoursVideo", "~{{hours}} timer opptak igjen", {
        hours: rounded,
      })
    : t("homeScreen.storageHoursAudio", "~{{hours}} timer kun-lyd igjen", {
        hours: rounded,
      });
}

/**
 * Rough used-space percentage (0..100) for the storage progress bar, derived
 * from free bytes vs a 1 TB reference cap. `null` when free space is unknown
 * so the caller can drop the bar entirely.
 */
export function diskUsedPercent(
  freeBytes: number | null | undefined,
): number | null {
  if (freeBytes == null || !Number.isFinite(freeBytes) || freeBytes < 0) {
    return null;
  }
  const used = DISK_BAR_CAP_BYTES - freeBytes;
  const pct = (used / DISK_BAR_CAP_BYTES) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
