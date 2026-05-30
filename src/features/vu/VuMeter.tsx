import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import type { VuLevels } from "@/lib/bindings/VuLevels";

/** dBFS at the bottom of the bar — anything quieter reads as empty. */
const FLOOR_DBFS = -60;

/**
 * Map a dBFS value (≤ 0) to a 0..1 bar fraction. `-∞` (serialised as `null` by
 * the backend when a channel is silent) and anything at/under the floor read as
 * empty; 0 dBFS reads as full.
 */
function dbfsToFraction(db: number | null): number {
  if (db === null || !Number.isFinite(db) || db <= FLOOR_DBFS) return 0;
  if (db >= 0) return 1;
  return (db - FLOOR_DBFS) / -FLOOR_DBFS;
}

/** Colour the bar green → amber → red as the level approaches clipping. */
function barColor(db: number | null): string {
  if (db === null || db <= FLOOR_DBFS) return "bg-emerald-500";
  if (db >= -3) return "bg-red-500";
  if (db >= -12) return "bg-amber-400";
  return "bg-emerald-500";
}

function ChannelBar({ db, label }: { db: number | null; label: string }) {
  const fraction = dbfsToFraction(db);
  const pct = Math.round(fraction * 100);
  const dbLabel =
    db === null || !Number.isFinite(db) ? "-∞" : `${db.toFixed(1)} dB`;
  return (
    <div className="flex items-center gap-2">
      <span className="w-6 text-right text-xs tabular-nums opacity-70">
        {label}
      </span>
      <div
        className="h-3 flex-1 overflow-hidden rounded bg-zinc-800"
        role="meter"
        aria-label={`Kanal ${label} nivå`}
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full ${barColor(db)} transition-[width] duration-75`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-16 text-right text-xs tabular-nums opacity-70">
        {dbLabel}
      </span>
    </div>
  );
}

/**
 * Live microphone VU meter. Reads input devices over IPC, drives `start_vu` /
 * `stop_vu`, and renders one bar per channel from the `vu://levels` event — so
 * the webview never touches `getUserMedia`.
 */
export function VuMeter() {
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [levels, setLevels] = useState<VuLevels | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the device list once on mount.
  useEffect(() => {
    invoke<AudioDeviceList>("list_input_devices")
      .then(setDevices)
      .catch((e) => setError(String(e?.message ?? e)));
  }, []);

  // Subscribe to VU events for the lifetime of the component.
  useEffect(() => {
    const unlisten = listen<VuLevels>("vu://levels", (event) => {
      setLevels(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      await invoke("start_vu", {
        deviceName: selected === "" ? null : selected,
      });
      setRunning(true);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, [selected]);

  const stop = useCallback(async () => {
    try {
      await invoke("stop_vu");
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setRunning(false);
      setLevels(null);
    }
  }, []);

  // Stop the engine if the component unmounts while running.
  useEffect(() => {
    return () => {
      if (running) void invoke("stop_vu").catch(() => {});
    };
  }, [running]);

  const peaks = levels?.peak_dbfs ?? [];
  const channelCount = peaks.length || 1;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-zinc-700 p-4"
      aria-label="VU-meter"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {t("home.audioLevel", "Mikrofon-VU")}
        </h2>
        <span className="text-xs opacity-50">{devices?.host ?? "…"}</span>
      </div>

      <div className="flex items-center gap-2">
        <select
          className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm"
          aria-label="Velg inngangsenhet"
          value={selected}
          disabled={running}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Standard inngang</option>
          {devices?.inputs.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
              {d.is_default ? " (standard)" : ""}
            </option>
          ))}
        </select>

        {running ? (
          <button
            type="button"
            className="rounded bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500"
            onClick={() => void stop()}
          >
            Stopp
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500"
            onClick={() => void start()}
          >
            Start VU
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex flex-col gap-1.5">
        {Array.from({ length: channelCount }).map((_, ch) => (
          <ChannelBar
            key={ch}
            label={channelCount > 1 ? `${ch + 1}` : "M"}
            db={running ? (peaks[ch] ?? null) : null}
          />
        ))}
      </div>

      {!running && (
        <p className="text-xs opacity-50">
          Trykk «Start VU» og snakk i mikrofonen — nivået måles i Rust.
        </p>
      )}
    </section>
  );
}
