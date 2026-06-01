import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { StreamStatus } from "@/lib/bindings/StreamStatus";
import type { StreamResolution } from "@/lib/bindings/StreamResolution";
import type { StreamDestinationView } from "@/lib/bindings/StreamDestinationView";
import type { OverlayConfig } from "@/lib/bindings/OverlayConfig";
import type { OverlaySource } from "@/lib/bindings/OverlaySource";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";
import { STREAM_STATUS_KEY } from "./queryKey";

/** The resolutions the backend renders, in display order. */
const RESOLUTIONS: readonly { value: StreamResolution; label: string }[] = [
  { value: "p480", label: "480p" },
  { value: "p720", label: "720p" },
  { value: "p1080", label: "1080p" },
] as const;

const FRAMERATES = [25, 30] as const;

/** Selectable video bitrates (kbps). `null` means "let the encoder decide". */
const VIDEO_BITRATES = [2500, 4500, 6000] as const;

/** Selectable audio bitrates (kbps). */
const AUDIO_BITRATES = [128, 192, 256] as const;

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

/** Format an mm:ss (or hh:mm:ss) uptime string from a stream `startedAt`
 *  epoch-ms and the current epoch-ms. Pure so tests pin both ends. */
function formatUptime(startedAt: bigint | null, nowMs: number): string {
  if (startedAt === null) return "00:00";
  const secs = Math.max(0, Math.floor((nowMs - Number(startedAt)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

let nextDestId = 1;

/**
 * R3 live-streaming panel — the "Direktesending" screen. Manages per-destination
 * RTMP keys in the OS keychain (`stream_set_key`/`stream_delete_key`), an optional
 * lower-third text overlay, a live camera preview (the same MJPEG engine the
 * DevicePicker drives via `start_preview`/`preview://frame`/`stop_preview`), and
 * start/stop of the RTMP push (`stream_start`/`stream_stop`) with a live status
 * poll (`stream_status`) feeding an uptime/bitrate/fps dashboard.
 *
 * "Bare direktesending" vs "Direktesending + opptak" toggles the recording-side
 * `alsoRecordPath` start option. The stream spawn is behind the default-off
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

  // Optional lower-third overlay. It can be a text title/subtitle or an image
  // path; `overlayEnabled` is the explicit on/off toggle (R4) so a configured
  // overlay can be parked without losing the text/path the user typed.
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [overlayKind, setOverlayKind] = useState<"text" | "image">("text");
  const [overlayTitle, setOverlayTitle] = useState("");
  const [overlaySubtitle, setOverlaySubtitle] = useState("");
  const [overlayImage, setOverlayImage] = useState("");

  const [resolution, setResolution] = useState<StreamResolution>("p720");
  const [framerate, setFramerate] = useState<number>(30);
  const [videoBitrate, setVideoBitrate] = useState<number | null>(4500);
  const [audioBitrate, setAudioBitrate] = useState<number | null>(192);

  // "Direktesending + opptak" also writes a local recording alongside the push.
  // The backend resolves the actual path when `alsoRecordPath` is a non-empty
  // sentinel; we pass "auto" so the recorder picks the configured output dir.
  const [alsoRecord, setAlsoRecord] = useState(false);

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
      // Build the lower-third only when the toggle is on AND the chosen source
      // actually has content (a title for text, a path for image). Otherwise we
      // push no overlays so the encode stays clean.
      const source: OverlaySource | null =
        overlayKind === "image"
          ? overlayImage.trim()
            ? { kind: "image", path: overlayImage.trim() }
            : null
          : overlayTitle.trim()
            ? {
                kind: "text",
                title: overlayTitle.trim(),
                subtitle: overlaySubtitle.trim() || null,
              }
            : null;
      const overlays: OverlayConfig[] =
        overlayEnabled && source
          ? [
              {
                id: "lower-third",
                name: "Lower third",
                enabled: true,
                source,
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
        videoBitrateKbps: videoBitrate,
        audioBitrateKbps: audioBitrate,
        alsoRecordPath: alsoRecord ? "auto" : null,
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

  // ── Camera preview (same MJPEG engine the DevicePicker drives) ────────────
  const [previewRunning, setPreviewRunning] = useState(false);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<PreviewFrame>("preview://frame", (event) => {
      setFrame(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const startPreview = useCallback(async () => {
    setPreviewError(null);
    try {
      // Null device → backend uses the configured/default camera, matching the
      // DevicePicker's "no explicit selection" path.
      await invoke("start_preview", { device: null, fps: null });
      setPreviewRunning(true);
    } catch (e) {
      setPreviewError(String((e as { message?: string })?.message ?? e));
    }
  }, []);

  const stopPreview = useCallback(async () => {
    try {
      await invoke("stop_preview");
    } catch {
      // best-effort
    } finally {
      setPreviewRunning(false);
      setFrame(null);
    }
  }, []);

  // Stop the preview if the panel unmounts while it's running.
  useEffect(() => {
    return () => {
      if (previewRunning) void invoke("stop_preview").catch(() => {});
    };
  }, [previewRunning]);

  // ── Uptime ticker (only while live) ───────────────────────────────────────
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const dims =
    frame?.width && frame?.height ? `${frame.width}×${frame.height}` : null;

  const inputClass =
    "rounded-lg border border-border bg-surface2 px-2 py-1 text-sm text-text placeholder:text-text3";
  const selectClass =
    "rounded-lg border border-border bg-surface2 px-2 py-1 text-sm text-text";

  const startLabel = alsoRecord
    ? t("streaming.startRecord", "Start direktesending + opptak")
    : t("streaming.startOnly", "Bare direktesending");

  return (
    <section
      className="flex w-full flex-col gap-4 lg:flex-row"
      aria-label={t("streaming.title", "Direktesending")}
    >
      {/* ── Preview (large left area) ─────────────────────────────────── */}
      <div className="flex flex-1 flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-text">
            {t("streaming.preview", "Forhåndsvisning")}
          </h2>
          {previewRunning ? (
            <button
              type="button"
              className="rounded-lg bg-red-600 px-3 py-1 text-sm font-medium text-white hover:bg-red-500"
              onClick={() => void stopPreview()}
            >
              {t("streaming.stopPreview", "Stopp forhåndsvisning")}
            </button>
          ) : (
            <button
              type="button"
              className="rounded-lg bg-accent px-3 py-1 text-sm font-medium text-bg hover:bg-accent/90"
              onClick={() => void startPreview()}
            >
              {t("streaming.startPreview", "Start forhåndsvisning")}
            </button>
          )}
        </div>

        <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-surface2">
          {frame ? (
            <img
              className="h-full w-full object-contain"
              src={`data:image/jpeg;base64,${frame.data}`}
              alt={t("streaming.preview", "Forhåndsvisning")}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-xs text-text3">
              {previewRunning
                ? t("home.checking", "Venter på første bilde …")
                : t(
                    "streaming.previewPrompt",
                    "Trykk på Start forhåndsvisning",
                  )}
            </div>
          )}
          {dims && (
            <span className="absolute bottom-1 right-1 rounded-lg bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-text2">
              {dims}
            </span>
          )}
        </div>

        {previewError && (
          <p className="text-xs text-red-400">{previewError}</p>
        )}

        {/* ── Live-stats dashboard ────────────────────────────────────── */}
        <div
          className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-surface p-3"
          aria-label={t("streaming.statsTitle", "Sendestatistikk")}
        >
          <div className="flex flex-col items-center">
            <span className="text-xs text-text3">
              {t("streaming.uptime", "Sendetid")}
            </span>
            <span className="text-lg tabular-nums text-text">
              {formatUptime(active ? (st?.startedAt ?? null) : null, nowMs)}
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-text3">
              {t("streaming.bitrate", "Bitrate")}
            </span>
            <span className="text-lg tabular-nums text-text">
              {active ? (st?.bitrateKbps ?? 0) : 0}
              <span className="ml-1 text-xs text-text3">kbps</span>
            </span>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-xs text-text3">
              {t("streaming.fpsLabel", "Bilder/s")}
            </span>
            <span className="text-lg tabular-nums text-text">
              {active ? (st?.fps ?? 0) : 0}
              <span className="ml-1 text-xs text-text3">fps</span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Controls (right column) ───────────────────────────────────── */}
      <div className="flex w-full max-w-md flex-col gap-4">
        {disabled && (
          <p className="rounded-lg border border-accent/60 bg-accent p-3 text-sm text-bg">
            {t(
              "streaming.featureDisabled",
              "Direktesending er ikke bygd inn i denne versjonen. Nøkler kan likevel lagres.",
            )}
          </p>
        )}

        {/* ── Status + start/stop ─────────────────────────────────────── */}
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <span
              className={`rounded-lg border px-1.5 py-0.5 text-xs ${
                active
                  ? "border-emerald-700 text-emerald-300"
                  : "border-border text-text3"
              }`}
            >
              {active
                ? t("streaming.live", "Sender direkte")
                : t("streaming.idle", "Av")}
            </span>
            {active && (
              <span className="text-xs text-text2">
                {t("streaming.stats", "{{kbps}} kbps · {{fps}} fps", {
                  kbps: st?.bitrateKbps ?? 0,
                  fps: st?.fps ?? 0,
                })}
              </span>
            )}
          </div>

          {/* Bare direktesending vs Direktesending + opptak */}
          <label className="flex items-center gap-2 text-sm text-text2">
            <input
              type="checkbox"
              checked={alsoRecord}
              onChange={(e) => setAlsoRecord(e.target.checked)}
              aria-label={t("streaming.alsoRecord", "Ta også opp lokalt")}
            />
            {t("streaming.alsoRecord", "Ta også opp lokalt")}
          </label>

          {active ? (
            <button
              type="button"
              className="rounded-lg border border-red-800 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-950"
              onClick={() => stopMutation.mutate()}
            >
              {t("streaming.stop", "Stopp")}
            </button>
          ) : (
            <button
              type="button"
              disabled={startMutation.isPending}
              className={`rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                alsoRecord
                  ? "bg-red-600 text-white hover:bg-red-500"
                  : "bg-accent text-bg hover:bg-accent/90"
              }`}
              onClick={() => startMutation.mutate()}
            >
              {startLabel}
            </button>
          )}
        </div>

        {/* ── Quality ───────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-text2">
            {t("streaming.resolution", "Oppløsning")}
            <select
              className={selectClass}
              value={resolution}
              onChange={(e) =>
                setResolution(e.target.value as StreamResolution)
              }
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text2">
            {t("streaming.framerate", "Bildefrekvens")}
            <select
              className={selectClass}
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
          <label className="flex items-center gap-2 text-sm text-text2">
            {t("streaming.videoBitrate", "Videobitrate")}
            <select
              className={selectClass}
              value={videoBitrate ?? ""}
              onChange={(e) =>
                setVideoBitrate(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              aria-label={t("streaming.videoBitrate", "Videobitrate")}
            >
              <option value="">{t("streaming.auto", "Auto")}</option>
              {VIDEO_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-text2">
            {t("streaming.audioBitrate", "Lydbitrate")}
            <select
              className={selectClass}
              value={audioBitrate ?? ""}
              onChange={(e) =>
                setAudioBitrate(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              aria-label={t("streaming.audioBitrate", "Lydbitrate")}
            >
              <option value="">{t("streaming.auto", "Auto")}</option>
              {AUDIO_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {b} kbps
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* ── Lower third ───────────────────────────────────────────── */}
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
          <label className="flex items-center gap-2 text-sm font-medium text-text">
            <input
              type="checkbox"
              checked={overlayEnabled}
              onChange={(e) => setOverlayEnabled(e.target.checked)}
              aria-label={t("streaming.overlayToggle", "Vis tekstplakat")}
            />
            {t("streaming.lowerThird", "Tekstplakat (nedre tredjedel)")}
          </label>
          <label className="flex items-center gap-2 text-sm text-text2">
            {t("streaming.overlayKind", "Type")}
            <select
              className={selectClass}
              value={overlayKind}
              onChange={(e) =>
                setOverlayKind(e.target.value as "text" | "image")
              }
              aria-label={t("streaming.overlayKind", "Type")}
            >
              <option value="text">
                {t("streaming.overlayText", "Tekst")}
              </option>
              <option value="image">
                {t("streaming.overlayImage", "Bilde")}
              </option>
            </select>
          </label>
          {overlayKind === "text" ? (
            <>
              <input
                className={inputClass}
                placeholder={t("streaming.lowerThirdTitle", "Tittel")}
                value={overlayTitle}
                onChange={(e) => setOverlayTitle(e.target.value)}
                aria-label={t("streaming.lowerThirdTitle", "Tittel")}
              />
              <input
                className={inputClass}
                placeholder={t("streaming.lowerThirdSubtitle", "Undertittel")}
                value={overlaySubtitle}
                onChange={(e) => setOverlaySubtitle(e.target.value)}
                aria-label={t("streaming.lowerThirdSubtitle", "Undertittel")}
              />
            </>
          ) : (
            <input
              className={inputClass}
              placeholder={t("streaming.lowerThirdImage", "Sti til bilde (PNG)")}
              value={overlayImage}
              onChange={(e) => setOverlayImage(e.target.value)}
              aria-label={t("streaming.lowerThirdImage", "Sti til bilde (PNG)")}
            />
          )}
        </div>

        {/* ── Destinations ──────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-text">
            {t("streaming.destinations", "Destinasjoner")}
          </h2>
          {dests.length === 0 ? (
            <p className="text-text3">
              {t("streaming.noDestinations", "Ingen destinasjoner ennå")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {dests.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="truncate font-medium text-text"
                        title={d.name}
                      >
                        {d.name}
                      </p>
                      <p
                        className="truncate text-xs text-text2"
                        title={d.rtmpUrl}
                      >
                        {d.rtmpUrl}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3"
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
                        className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3"
                        onClick={() => deleteKeyMutation.mutate(d.id)}
                      >
                        {t("streaming.deleteKey", "Slett nøkkel")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="password"
                        className={`min-w-0 flex-1 ${inputClass}`}
                        placeholder={t("streaming.streamKey", "Strømnøkkel")}
                        value={d.keyInput}
                        aria-label={t(
                          "streaming.streamKeyFor",
                          "Strømnøkkel for {{name}}",
                          { name: d.name },
                        )}
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
                        disabled={
                          !d.keyInput.trim() || setKeyMutation.isPending
                        }
                        className="rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3 disabled:opacity-50"
                        onClick={() =>
                          setKeyMutation.mutate({
                            destId: d.id,
                            key: d.keyInput,
                          })
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
          <div className="flex flex-col gap-2 rounded-xl border border-dashed border-border2 p-4">
            <input
              className={inputClass}
              placeholder={t("streaming.destName", "Navn (f.eks. YouTube)")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              aria-label={t("streaming.destName", "Navn (f.eks. YouTube)")}
            />
            <input
              className={inputClass}
              placeholder="rtmp://…"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              aria-label={t("streaming.destUrl", "RTMP-URL")}
            />
            <button
              type="button"
              disabled={!newName.trim() || !newUrl.trim()}
              className="self-start rounded-lg border border-border bg-surface2 px-2 py-1 text-xs text-text2 hover:bg-surface3 disabled:opacity-50"
              onClick={addDestination}
            >
              {t("streaming.addDest", "Legg til destinasjon")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
