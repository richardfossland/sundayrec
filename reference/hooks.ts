/**
 * Shared data hooks for the redesigned screens.
 *
 * These wrap the existing Tauri IPC contract (the same commands/events the
 * legacy feature panels use) so every redesigned screen drives real data
 * without each one re-implementing device enumeration, the VU engine, the MJPEG
 * preview, or the disk probe. The backend's `start_vu`/`start_preview` engines
 * are singletons, so a hook starts the engine on mount and stops it on unmount
 * — only one screen consuming a given engine is visible at a time.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import type { DeviceInventory } from "@/lib/bindings/DeviceInventory";
import type { FfmpegDevice } from "@/lib/bindings/FfmpegDevice";
import type { VuLevels } from "@/lib/bindings/VuLevels";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";
import type { PreviewError } from "@/lib/bindings/PreviewError";
import type { DiskSpace } from "@/lib/bindings/DiskSpace";

/** dBFS at the bottom of a meter — anything quieter reads as empty. */
export const FLOOR_DBFS = -60;

/** Map a dBFS value (≤ 0; `null` = silence) to a 0..1 meter fraction. */
export function dbfsToFraction(db: number | null | undefined): number {
  if (db == null || !Number.isFinite(db) || db <= FLOOR_DBFS) return 0;
  if (db >= 0) return 1;
  return (db - FLOOR_DBFS) / -FLOOR_DBFS;
}

/**
 * Coarse signal-strength bucket for a live dBFS peak, used to drive the
 * dynamic "Svak / OK / Bra / Høy" label. Thresholds: `< -24` weak,
 * `-24..<-12` ok, `-12..<-6` good, `>= -6` loud. A null/non-finite reading
 * (silence / no telemetry yet) reads as `weak`.
 */
export function levelLabel(
  db: number | null | undefined,
): "weak" | "ok" | "good" | "loud" {
  if (db == null || !Number.isFinite(db)) return "weak";
  if (db < -24) return "weak";
  if (db < -12) return "ok";
  if (db < -6) return "good";
  return "loud";
}

/** Number of lit segments (of `total`) for a dBFS level on a segmented meter. */
export function dbfsToLit(
  db: number | null | undefined,
  total: number,
): number {
  return Math.round(dbfsToFraction(db) * total);
}

/** Format a dBFS reading for display (e.g. `-35.9` or `-∞`). */
export function formatDbfs(db: number | null | undefined): string {
  if (db == null || !Number.isFinite(db)) return "−∞";
  return db.toFixed(1);
}

/**
 * Seconds → a clock string, clamped to ≥0 and rounded. Default shows hours only
 * when present (`m:ss` or `h:mm:ss`); `forceHours` always emits `HH:MM:SS` with a
 * zero-padded hour (for a fixed-width countdown). The shared formatter for the
 * recording timer and the home live-countdown. (The editor ruler keeps its own
 * floor-based `formatTime`, and transcript timestamps their own unbounded `m:ss`.)
 */
export function formatClock(
  totalSec: number,
  opts?: { forceHours?: boolean },
): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (opts?.forceHours) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Enumerate the system's audio input devices once on mount. */
export function useInputDevices(): AudioDeviceList | null {
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<AudioDeviceList>("list_input_devices")
      .then((d) => alive && setDevices(d))
      .catch((e) => console.warn("list_input_devices failed", e));
    return () => {
      alive = false;
    };
  }, []);
  return devices;
}

/**
 * Live VU levels. While `active`, runs the Rust `start_vu` engine for
 * `deviceName` (null = system default) and reports the latest `vu://levels`
 * snapshot; stops the engine when inactive or unmounted.
 */
export function useVuLevels(
  active: boolean,
  deviceName?: string | null,
): VuLevels | null {
  const [levels, setLevels] = useState<VuLevels | null>(null);

  useEffect(() => {
    const unlisten = listen<VuLevels>("vu://levels", (e) =>
      setLevels(e.payload),
    );
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    void invoke("start_vu", { deviceName: deviceName ?? null }).catch((e) =>
      console.warn("start_vu failed", e),
    );
    return () => {
      void invoke("stop_vu").catch((e) => console.warn("stop_vu failed", e));
      setLevels(null);
    };
  }, [active, deviceName]);

  return active ? levels : null;
}

/**
 * Live camera preview. While `active`, runs the Rust MJPEG `start_preview`
 * engine and returns the latest frame as a ready-to-use `data:` URL plus its
 * dimensions; stops the engine when inactive or unmounted.
 *
 * Also surfaces a preview failure (`preview://error`: no camera, permission
 * denied, no video stream) as `error` so the UI can show a real message instead
 * of the silent dead placeholder. A received frame clears any prior error.
 */
export function useCameraPreview(
  active: boolean,
  device?: string | null,
): {
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
} {
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlistenFrame = listen<PreviewFrame>("preview://frame", (e) => {
      setFrame(e.payload);
      // A live frame means the camera recovered — clear any stale error.
      setError(null);
    });
    const unlistenError = listen<PreviewError>("preview://error", (e) =>
      setError(e.payload.message),
    );
    return () => {
      void unlistenFrame.then((off) => off());
      void unlistenError.then((off) => off());
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    // Re-arm: a fresh start should not show the previous session's error.
    setError(null);
    void invoke("start_preview", { device: device ?? null, fps: null }).catch(
      (e) => console.warn("start_preview failed", e),
    );
    return () => {
      void invoke("stop_preview").catch((e) =>
        console.warn("stop_preview failed", e),
      );
      setFrame(null);
      setError(null);
    };
  }, [active, device]);

  if (!active) return { dataUrl: null, width: null, height: null, error: null };
  if (!frame) return { dataUrl: null, width: null, height: null, error };
  return {
    dataUrl: `data:image/jpeg;base64,${frame.data}`,
    width: frame.width,
    height: frame.height,
    error: null,
  };
}

/**
 * Enumerate ffmpeg-visible video (camera) devices once on mount, via the same
 * `list_devices` inventory the legacy `DevicePicker` uses. The addressable
 * token for `start_preview`/recording is the avfoundation index (macOS) when
 * known, else the dshow name (Windows) — see {@link videoDeviceArg}.
 */
export function useVideoDevices(): FfmpegDevice[] {
  const [devices, setDevices] = useState<FfmpegDevice[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<DeviceInventory>("list_devices")
      .then((inv) => alive && setDevices(inv.video_inputs ?? []))
      .catch((e) => console.warn("list_devices failed", e));
    return () => {
      alive = false;
    };
  }, []);
  return devices;
}

/** The addressable token for a video device (avfoundation index, else name). */
export function videoDeviceArg(d: FfmpegDevice): string {
  return d.index !== null ? String(d.index) : d.name;
}

/** Free bytes on the save-folder volume (`null` while loading/unavailable). */
export function useDiskSpace(): number | null {
  const [freeBytes, setFreeBytes] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    invoke<DiskSpace>("get_disk_space")
      .then((d) => alive && setFreeBytes(d.freeBytes))
      .catch((e) => console.warn("get_disk_space failed", e));
    return () => {
      alive = false;
    };
  }, []);
  return freeBytes;
}

/** Format a byte count as a human GB/MB string (e.g. `569 GB`). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  const gb = bytes / 1_000_000_000;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}
