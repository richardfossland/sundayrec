import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { StreamStatus } from "@/lib/bindings/StreamStatus";
import type { StreamResolution } from "@/lib/bindings/StreamResolution";
import type { StreamDestinationView } from "@/lib/bindings/StreamDestinationView";
import type { OverlayConfig } from "@/lib/bindings/OverlayConfig";
import { STREAM_STATUS_KEY } from "./queryKey";

/** The resolutions the backend renders, in display order. */
const RESOLUTIONS: readonly { value: StreamResolution; label: string }[] = [
  { value: "p480", label: "480p" },
  { value: "p720", label: "720p" },
  { value: "p1080", label: "1080p" },
] as const;

const FRAMERATES = [25, 30] as const;

/** A destination row in the renderer. The key never lives here — it's typed
 *  into a transient input and pushed to the keychain via `stream_set_key`. */
type DestRow = StreamDestinationView & { keyInput: string };

/** True when an IPC rejection is the default-build "streaming feature off"
 *  error, so the panel shows a calm hint rather than a red error. The seam
 *  returns `feature_disabled: …` in the message of a `validation` AppError. */
function isFeatureDisabled(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  return msg.includes("feature_disabled");
}

let nextDestId = 1;

/**
 * R3 live-streaming panel. Manages per-destination RTMP keys in the OS keychain
 * (`stream_set_key`/`stream_delete_key`), an optional lower-third text overlay,
 * and start/stop of the RTMP push (`stream_start`/`stream_stop`) with a live
 * status poll (`stream_status`). The stream spawn is behind the default-off
 * `streaming` cargo feature, so in the default build Start returns
 * `feature_disabled` and the panel shows a "not built into this build" hint —
 * the key vault still works so the user can save keys ahead of a streaming build.
 *
 * Pure IPC + render; exercised in tests with `invoke` mocked.
 */
export function StreamingPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [disabled, setDisabled] = useState(false);

  const [dests, setDests] = useState<DestRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");

  // Optional lower-third text overlay.
  const [overlayTitle, setOverlayTitle] = useState("");
  const [overlaySubtitle, setOverlaySubtitle] = useState("");

  const [resolution, setResolution] = useState<StreamResolution>("p720");
  const [framerate, setFramerate] = useState<number>(30);

  const status = useQuery<StreamStatus>({
    queryKey: STREAM_STATUS_KEY,
    queryFn: () => invoke<StreamStatus>("stream_status"),
    // Poll while a stream is active so the bitrate/fps stay fresh.
    refetchInterval: (q) => (q.state.data?.active ? 2000 : false),
  });

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STREAM_STATUS_KEY });
  }, [queryClient]);

  const setKeyMutation = useMutation({
    mutationFn: ({ destId, key }: { destId: string; key: string }) =>
      invoke<void>("stream_set_key", { destId, key }),
    onSuccess: (_d, { destId }) => {
      setDests((rows) =>
        rows.map((r) =>
          r.id === destId ? { ...r, hasKey: true, keyInput: "" } : r,
        ),
      );
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (destId: string) =>
      invoke<void>("stream_delete_key", { destId }),
    onSuccess: (_d, destId) => {
      setDests((rows) =>
        rows.map((r) => (r.id === destId ? { ...r, hasKey: false } : r)),
      );
    },
  });

  const startMutation = useMutation({
    mutationFn: () => {
      const overlays: OverlayConfig[] = overlayTitle.trim()
        ? [
            {
              id: "lower-third",
              name: "Lower third",
              enabled: true,
              source: {
                kind: "text",
                title: overlayTitle.trim(),
                subtitle: overlaySubtitle.trim() || null,
              },
              position: "bl",
              customX: null,
              customY: null,
              scale: 0.3,
              opacity: 1,
            },
          ]
        : [];
      return invoke<StreamStatus>("stream_start", {
        destinations: dests.map(({ keyInput: _k, ...d }) => d),
        resolution,
        framerate,
        videoBitrateKbps: null,
        audioBitrateKbps: null,
        alsoRecordPath: null,
        overlays,
        videoToken: "0",
        macAudioToken: null,
        winAudioName: null,
        snapshotPath: "",
      });
    },
    onSuccess: invalidate,
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });

  const stopMutation = useMutation({
    mutationFn: () => invoke<boolean>("stream_stop"),
    onSuccess: invalidate,
    onError: (e) => setDisabled(isFeatureDisabled(e)),
  });

  const addDestination = useCallback(() => {
    const name = newName.trim();
    const rtmpUrl = newUrl.trim();
    if (!name || !rtmpUrl) return;
    setDests((rows) => [
      ...rows,
      {
        id: `dest-${nextDestId++}`,
        name,
        rtmpUrl,
        enabled: true,
        hasKey: false,
        keyInput: "",
      },
    ]);
    setNewName("");
    setNewUrl("");
  }, [newName, newUrl]);

  const removeDestination = useCallback(
    (id: string) => {
      // Best-effort vault cleanup, then drop the row.
      deleteKeyMutation.mutate(id);
      setDests((rows) => rows.filter((r) => r.id !== id));
    },
    [deleteKeyMutation],
  );

  const st = status.data;
  const active = st?.active ?? false;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("streaming.title", "Direktesending")}
    >
      {disabled && (
        <p className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
          {t(
            "streaming.featureDisabled",
            "Direktesending er ikke bygd inn i denne versjonen. Nøkler kan likevel lagres.",
          )}
        </p>
      )}

      {/* ── Status ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-700 p-3">
        <span
          className={`rounded border px-1.5 py-0.5 text-xs ${
            active
              ? "border-emerald-700 text-emerald-300"
              : "border-zinc-600 text-zinc-400"
          }`}
        >
          {active
            ? t("streaming.live", "Sender direkte")
            : t("streaming.idle", "Av")}
        </span>
        {active && (
          <span className="text-xs opacity-70">
            {t("streaming.stats", "{{kbps}} kbps · {{fps}} fps", {
              kbps: st?.bitrateKbps ?? 0,
              fps: st?.fps ?? 0,
            })}
          </span>
        )}
        {active ? (
          <button
            type="button"
            className="rounded border border-red-800 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
            onClick={() => stopMutation.mutate()}
          >
            {t("streaming.stop", "Stopp")}
          </button>
        ) : (
          <button
            type="button"
            disabled={startMutation.isPending}
            className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            onClick={() => startMutation.mutate()}
          >
            {t("streaming.start", "Start")}
          </button>
        )}
      </div>

      {/* ── Quality ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          {t("streaming.resolution", "Oppløsning")}
          <select
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={resolution}
            onChange={(e) => setResolution(e.target.value as StreamResolution)}
          >
            {RESOLUTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          {t("streaming.framerate", "Bildefrekvens")}
          <select
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            value={framerate}
            onChange={(e) => setFramerate(Number(e.target.value))}
          >
            {FRAMERATES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* ── Lower third ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">
          {t("streaming.lowerThird", "Tekstplakat (nedre tredjedel)")}
        </h2>
        <input
          className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
          placeholder={t("streaming.lowerThirdTitle", "Tittel")}
          value={overlayTitle}
          onChange={(e) => setOverlayTitle(e.target.value)}
          aria-label={t("streaming.lowerThirdTitle", "Tittel")}
        />
        <input
          className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
          placeholder={t("streaming.lowerThirdSubtitle", "Undertittel")}
          value={overlaySubtitle}
          onChange={(e) => setOverlaySubtitle(e.target.value)}
          aria-label={t("streaming.lowerThirdSubtitle", "Undertittel")}
        />
      </div>

      {/* ── Destinations ────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">
          {t("streaming.destinations", "Destinasjoner")}
        </h2>
        {dests.length === 0 ? (
          <p className="opacity-60">
            {t("streaming.noDestinations", "Ingen destinasjoner ennå")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {dests.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 rounded-lg border border-zinc-700 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium" title={d.name}>
                      {d.name}
                    </p>
                    <p className="truncate text-xs opacity-70" title={d.rtmpUrl}>
                      {d.rtmpUrl}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                    onClick={() => removeDestination(d.id)}
                  >
                    {t("streaming.removeDest", "Fjern")}
                  </button>
                </div>
                {d.hasKey ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-emerald-300">
                      {t("streaming.keySaved", "•••• (lagret)")}
                    </span>
                    <button
                      type="button"
                      className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
                      onClick={() => deleteKeyMutation.mutate(d.id)}
                    >
                      {t("streaming.deleteKey", "Slett nøkkel")}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      className="min-w-0 flex-1 rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
                      placeholder={t("streaming.streamKey", "Strømnøkkel")}
                      value={d.keyInput}
                      aria-label={t("streaming.streamKeyFor", "Strømnøkkel for {{name}}", {
                        name: d.name,
                      })}
                      onChange={(e) =>
                        setDests((rows) =>
                          rows.map((r) =>
                            r.id === d.id
                              ? { ...r, keyInput: e.target.value }
                              : r,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      disabled={!d.keyInput.trim() || setKeyMutation.isPending}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
                      onClick={() =>
                        setKeyMutation.mutate({ destId: d.id, key: d.keyInput })
                      }
                    >
                      {t("streaming.saveKey", "Lagre nøkkel")}
                    </button>
                  </div>
                )}
                {setKeyMutation.isError &&
                  setKeyMutation.variables?.destId === d.id && (
                    <p className="text-xs text-red-400">
                      {t("streaming.keyRejected", "Ugyldig nøkkel")}
                    </p>
                  )}
              </li>
            ))}
          </ul>
        )}

        {/* Add a destination */}
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-zinc-700 p-3">
          <input
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder={t("streaming.destName", "Navn (f.eks. YouTube)")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label={t("streaming.destName", "Navn (f.eks. YouTube)")}
          />
          <input
            className="rounded border border-zinc-700 bg-transparent px-2 py-1 text-sm"
            placeholder="rtmp://…"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            aria-label={t("streaming.destUrl", "RTMP-URL")}
          />
          <button
            type="button"
            disabled={!newName.trim() || !newUrl.trim()}
            className="self-start rounded border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-50"
            onClick={addDestination}
          >
            {t("streaming.addDest", "Legg til destinasjon")}
          </button>
        </div>
      </div>
    </section>
  );
}
