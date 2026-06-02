/**
 * Direkte — live streaming. Ported from `sr-schedule-live.jsx`. Preview pane
 * with live L/R meters, stats + destinations + quality rail, overlays card,
 * and the start buttons.
 *
 * Data-driven against the same IPC contract as
 * `src/features/streaming/StreamingPanel.tsx`: it polls `stream_status` (shared
 * `STREAM_STATUS_KEY`) for the Statistikk card + header badge, drives the live
 * L/R meters from `useVuLevels(true)`, reflects/selects resolution + frame rate
 * locally, and calls `stream_start`/`stream_stop` from the start buttons. When
 * the `streaming` feature is off (dev/test) the status query falls back to the
 * "ready/off" sample state and starting is a no-op rather than a crash.
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Icon } from "../Icon";
import { Badge, Card, SegOpt, Toggle } from "../atoms";
import { dbfsToLit, formatDbfs, useVuLevels } from "../hooks";
import type { StreamStatus } from "@/lib/bindings/StreamStatus";
import type { StreamResolution } from "@/lib/bindings/StreamResolution";
import { STREAM_STATUS_KEY } from "@/features/streaming/queryKey";
import {
  FRAMERATES,
  RESOLUTIONS,
  SAMPLE_DEST,
  channelDbfs,
  formatUptime,
  makeDestRow,
  makeOverlayRow,
  toDestView,
  toOverlayConfigs,
  type DestRow,
  type OverlayRow,
} from "./live.helpers";

function Stat({ k, v, accent }: { k: string; v: string; accent?: string }) {
  return (
    <div
      className="sr-card"
      style={{ padding: 14, background: "var(--sr-ink-750)" }}
    >
      <div className="sr-label">{k}</div>
      <div
        className="sr-num"
        style={{
          fontSize: 21,
          fontWeight: 700,
          marginTop: 4,
          color: accent || "var(--sr-text)",
          fontFamily: "var(--sr-mono)",
        }}
      >
        {v}
      </div>
    </div>
  );
}

function HBar({ ch, on, db }: { ch: string; on: number; db: number | null }) {
  return (
    <div className="sr-row" style={{ gap: 8 }}>
      <span
        className="sr-mono"
        style={{ fontSize: 11, color: "var(--sr-text-3)", width: 10 }}
      >
        {ch}
      </span>
      <div className="sr-grow" style={{ display: "flex", gap: 2, height: 10 }}>
        {Array.from({ length: 28 }).map((_, i) => {
          const c =
            i < on
              ? i > 24
                ? "var(--sr-red)"
                : i > 20
                  ? "var(--sr-gold)"
                  : "var(--sr-green)"
              : "var(--sr-ink-700)";
          return (
            <span key={i} style={{ flex: 1, background: c, borderRadius: 1 }} />
          );
        })}
      </div>
      <span
        className="sr-mono sr-num"
        style={{
          fontSize: 11,
          color: "var(--sr-text-3)",
          width: 36,
          textAlign: "right",
        }}
      >
        {formatDbfs(db)}
      </span>
    </div>
  );
}

export function LiveScreen() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // Same status poll as StreamingPanel — shared key, poll only while live.
  const status = useQuery<StreamStatus>({
    queryKey: STREAM_STATUS_KEY,
    queryFn: () => invoke<StreamStatus>("stream_status"),
    refetchInterval: (q) => (q.state.data?.active ? 2000 : false),
    // The streaming feature is default-off in dev/test; treat a rejection as
    // "ready/off" rather than surfacing an error.
    retry: false,
  });

  const st = status.data;
  const active = st?.active ?? false;

  // Resolution + frame rate. Reflected from local selection (the backend has no
  // persisted getter the panel reads either); start passes these to the engine.
  const [resolution, setResolution] = useState<StreamResolution>("p720");
  const [framerate, setFramerate] = useState<number>(30);

  // Whether "Start direktesending + opptak" also writes a local file. Tracked so
  // the right primary button maps to the right `alsoRecordPath` start option.
  const [alsoRecord, setAlsoRecord] = useState(false);

  // Destinations: the canonical panel keeps these in memory (no persisted load),
  // so we mirror that and fall back to the design's sample row when empty. Keys
  // live in the OS keychain via stream_set_key/stream_delete_key — never here.
  const [dests, setDests] = useState<DestRow[]>([]);
  const shownDests = dests.length > 0 ? dests : null;

  // Inline "add destination" form, shown when the "+" / "Konfigurer" link is hit.
  const [editorOpen, setEditorOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const editorRef = useRef<HTMLDivElement | null>(null);

  // Local overlays folded into the stream_start payload's `overlays` array.
  const [overlays, setOverlays] = useState<OverlayRow[]>([]);

  // Live L/R meters from the VU engine while the page is mounted.
  const vu = useVuLevels(true);
  const lDb = channelDbfs(vu?.peak_dbfs, 0);
  const rDb = channelDbfs(vu?.peak_dbfs, 1);
  const lOn = dbfsToLit(lDb, 28);
  const rOn = dbfsToLit(rDb, 28);
  const hasSignal = (vu?.peak_dbfs?.length ?? 0) > 0 && (lOn > 0 || rOn > 0);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: STREAM_STATUS_KEY });

  const startMutation = useMutation({
    mutationFn: (withRecord: boolean) =>
      invoke<StreamStatus>("stream_start", {
        // Drop the transient key input; the keychain resolves keys by id.
        destinations: dests.map(toDestView),
        resolution,
        framerate,
        videoBitrateKbps: null,
        audioBitrateKbps: null,
        alsoRecordPath: withRecord ? "auto" : null,
        overlays: toOverlayConfigs(overlays),
        videoToken: "0",
        macAudioToken: null,
        winAudioName: null,
        snapshotPath: "",
      }),
    onSuccess: invalidate,
    // Feature off in dev/test → no-op rather than crash.
    onError: () => {},
  });

  const stopMutation = useMutation({
    mutationFn: () => invoke<boolean>("stream_stop"),
    onSuccess: invalidate,
    onError: () => {},
  });

  // Persist a destination's RTMP key to the OS keychain, exactly as the panel.
  const setKeyMutation = useMutation({
    mutationFn: ({ destId, key }: { destId: string; key: string }) =>
      invoke<void>("stream_set_key", { destId, key }),
    onSuccess: (_d, { destId }) =>
      setDests((rows) =>
        rows.map((r) =>
          r.id === destId ? { ...r, hasKey: true, keyInput: "" } : r,
        ),
      ),
    // Feature off in dev/test → no-op rather than crash.
    onError: () => {},
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (destId: string) =>
      invoke<void>("stream_delete_key", { destId }),
    onSuccess: (_d, destId) =>
      setDests((rows) =>
        rows.map((r) => (r.id === destId ? { ...r, hasKey: false } : r)),
      ),
    onError: () => {},
  });

  const openEditor = () => {
    setEditorOpen(true);
    // Scroll the inline form into view on the next paint.
    requestAnimationFrame(() =>
      editorRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      }),
    );
  };

  const addDestination = () => {
    const name = newName.trim();
    const rtmpUrl = newUrl.trim();
    if (!name || !rtmpUrl) return;
    setDests((rows) => [...rows, makeDestRow(name, rtmpUrl)]);
    setNewName("");
    setNewUrl("");
  };

  const removeDestination = (id: string) => {
    // Best-effort keychain cleanup, then drop the row.
    deleteKeyMutation.mutate(id);
    setDests((rows) => rows.filter((r) => r.id !== id));
  };

  const toggleDestination = (id: string) =>
    setDests((rows) =>
      rows.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
    );

  const setKeyInput = (id: string, value: string) =>
    setDests((rows) =>
      rows.map((r) => (r.id === id ? { ...r, keyInput: value } : r)),
    );

  const addOverlay = () =>
    setOverlays((rows) => [
      ...rows,
      makeOverlayRow(
        t("liveScreen.overlayDefaultLabel", "Logo {{n}}", {
          n: rows.length + 1,
        }),
        t("liveScreen.overlayDefaultTitle", "Velkommen til gudstjenesten"),
      ),
    ]);

  const removeOverlay = (id: string) =>
    setOverlays((rows) => rows.filter((r) => r.id !== id));

  // Uptime ticker — only while live.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  const startStream = (withRecord: boolean) => {
    setAlsoRecord(withRecord);
    if (active) {
      stopMutation.mutate();
    } else {
      startMutation.mutate(withRecord);
    }
  };

  const uptime = formatUptime(active ? (st?.startedAt ?? null) : null, nowMs);
  const bitrate = active ? (st?.bitrateKbps ?? 0) : 0;
  const fps = active ? (st?.fps ?? 0) : 0;
  const dropped = active ? (st?.dropped ?? 0) : 0;
  // Live per-destination health (name → ok), so a half-dead multi-destination
  // stream shows the dead one red instead of all-green. Defaults to "ok" for a
  // destination not yet reported on.
  const destHealth = new Map(
    (active ? (st?.destinations ?? []) : []).map((h) => [h.name, h.ok]),
  );

  return (
    <div className="sr-content wide">
      <div className="sr-row" style={{ marginBottom: 22 }}>
        <div className="sr-grow">
          <div className="sr-pagetitle">
            {t("liveScreen.title", "Direkte sending")}
          </div>
          <div className="sr-pagesub">
            {t(
              "liveScreen.subtitle",
              "Stream til YouTube, Facebook eller egen RTMP-server.",
            )}
          </div>
        </div>
        <Badge kind={active ? "err" : "ok"} dot>
          {active
            ? t("liveScreen.badgeSending", "Sender")
            : t("liveScreen.badgeReady", "Klar")}
        </Badge>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 340px",
          gap: 16,
          alignItems: "start",
        }}
      >
        {/* Preview */}
        <div className="sr-card" style={{ padding: 0, overflow: "hidden" }}>
          <div
            className="sr-media"
            style={{ aspectRatio: "16 / 9", borderRadius: 0, border: "none" }}
          >
            {t(
              "liveScreen.previewPlaceholder",
              "video-forhåndsvisning · det som sendes ut",
            )}
          </div>
          <div
            className="sr-col"
            style={{
              gap: 8,
              padding: "14px 16px",
              borderTop: "1px solid var(--sr-line)",
            }}
          >
            <div className="sr-row">
              <span className="sr-label sr-grow">
                {t("liveScreen.audioLevelLive", "Lydnivå — live")}
              </span>
              <Badge kind={hasSignal ? "ok" : "muted"} dot>
                {hasSignal
                  ? t("liveScreen.badgeSignal", "Signal")
                  : t("liveScreen.badgeSilent", "Stille")}
              </Badge>
            </div>
            <HBar ch="L" on={lOn} db={lDb} />
            <HBar ch="R" on={rOn} db={rDb} />
          </div>
        </div>

        {/* Rail */}
        <div className="sr-stack-3">
          <Card title={t("liveScreen.statsTitle", "Statistikk")} pad>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <Stat k={t("liveScreen.statTime", "Tid")} v={uptime} />
              <Stat
                k={t("liveScreen.statBitrate", "Bitrate")}
                v={`${bitrate} kbps`}
              />
              <Stat k={t("liveScreen.statFps", "FPS")} v={String(fps)} />
              <Stat
                k={t("liveScreen.statDroppedFrames", "Tapte rammer")}
                v={String(dropped)}
                accent={dropped > 0 ? "var(--sr-red)" : "var(--sr-green)"}
              />
            </div>
          </Card>
          <Card
            title={t("liveScreen.destinationsTitle", "Destinasjoner")}
            pad
            action={
              <button
                className="sr-btn ghost sm"
                onClick={openEditor}
                title={t("liveScreen.addDestination", "Legg til destinasjon")}
              >
                <Icon name="plus" size={14} />
              </button>
            }
          >
            {/* Real rows when configured; otherwise the design's sample row.
                The sample is normalised to a DestRow so the type stays uniform;
                `editable` gates the key/remove controls to real rows only. */}
            {(shownDests ?? [{ ...SAMPLE_DEST, keyInput: "" }]).map((d) => {
              const editable = shownDests !== null;
              // While live, reflect the REAL tee-slave health: a destination whose
              // slave failed turns red even though the overall stream is up.
              const liveOk = destHealth.get(d.name) ?? true;
              const destOffline = active && d.enabled && !liveOk;
              return (
                <div
                  key={d.id}
                  className="sr-col"
                  style={{
                    gap: 8,
                    padding: "11px 13px",
                    borderRadius: "var(--sr-r-sm)",
                    background: "var(--sr-ink-750)",
                    marginBottom: 8,
                  }}
                >
                  <div className="sr-row">
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background:
                          active && d.enabled && liveOk
                            ? "var(--sr-green)"
                            : "var(--sr-red)",
                      }}
                    />
                    <span
                      className="sr-grow"
                      style={{ fontSize: 13.5, fontWeight: 600 }}
                    >
                      {d.name}
                    </span>
                    {destOffline && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--sr-red)",
                        }}
                      >
                        {t("liveScreen.destDropped", "Frakoblet")}
                      </span>
                    )}
                    {editable ? (
                      <span
                        onClick={() => toggleDestination(d.id)}
                        style={{ cursor: "pointer", display: "inline-flex" }}
                        role="switch"
                        aria-checked={d.enabled}
                        title={
                          d.enabled
                            ? t("liveScreen.destActive", "Aktiv")
                            : t("liveScreen.destOff", "Av")
                        }
                      >
                        <Toggle on={d.enabled} />
                      </span>
                    ) : (
                      <Toggle on={d.enabled} />
                    )}
                  </div>
                  {editable && (
                    <div className="sr-row" style={{ gap: 6 }}>
                      {d.hasKey ? (
                        <>
                          <span
                            className="sr-grow sr-mono"
                            style={{ fontSize: 11, color: "var(--sr-green)" }}
                          >
                            {t("liveScreen.keySaved", "•••• (lagret)")}
                          </span>
                          <button
                            className="sr-btn ghost sm"
                            onClick={() => deleteKeyMutation.mutate(d.id)}
                          >
                            {t("liveScreen.deleteKey", "Slett nøkkel")}
                          </button>
                        </>
                      ) : (
                        <>
                          <input
                            type="password"
                            className="sr-input sr-grow"
                            style={{ minWidth: 0 }}
                            placeholder={t(
                              "liveScreen.streamKeyPlaceholder",
                              "Strømnøkkel",
                            )}
                            value={d.keyInput}
                            onChange={(e) => setKeyInput(d.id, e.target.value)}
                          />
                          <button
                            className="sr-btn ghost sm"
                            disabled={
                              !d.keyInput.trim() || setKeyMutation.isPending
                            }
                            onClick={() =>
                              setKeyMutation.mutate({
                                destId: d.id,
                                key: d.keyInput,
                              })
                            }
                          >
                            {t("liveScreen.saveKey", "Lagre")}
                          </button>
                        </>
                      )}
                      <button
                        className="sr-btn ghost sm"
                        onClick={() => removeDestination(d.id)}
                        title={t(
                          "liveScreen.removeDestination",
                          "Fjern destinasjon",
                        )}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {editorOpen && (
              <div
                ref={editorRef}
                className="sr-card sr-col"
                style={{
                  gap: 8,
                  padding: 12,
                  marginTop: 4,
                  background: "var(--sr-ink-750)",
                  border: "1px dashed var(--sr-line-strong)",
                }}
              >
                <input
                  className="sr-input"
                  placeholder={t(
                    "liveScreen.namePlaceholder",
                    "Navn (f.eks. YouTube)",
                  )}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
                <input
                  className="sr-input"
                  placeholder="rtmp://…"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                />
                <button
                  className="sr-btn gold sm"
                  disabled={!newName.trim() || !newUrl.trim()}
                  onClick={addDestination}
                >
                  <Icon name="plus" size={14} />
                  {t("liveScreen.addDestination", "Legg til destinasjon")}
                </button>
              </div>
            )}

            <a
              onClick={openEditor}
              style={{
                display: "inline-block",
                marginTop: 11,
                fontSize: 13,
                color: "var(--sr-gold)",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t(
                "liveScreen.configureDestinations",
                "→ Konfigurer destinasjoner",
              )}
            </a>
          </Card>
          <Card
            title={t("liveScreen.streamQualityTitle", "Strøm-kvalitet")}
            pad
          >
            <div className="sr-seg cols-3">
              {RESOLUTIONS.map((r) => (
                <span
                  key={r.value}
                  onClick={() => setResolution(r.value)}
                  style={{ cursor: "pointer", display: "block" }}
                >
                  <SegOpt
                    sel={resolution === r.value}
                    title={r.label}
                    badge={
                      r.badge
                        ? t("liveScreen.recommended", "Anbefalt")
                        : undefined
                    }
                    sub={r.sub}
                  />
                </span>
              ))}
            </div>
            <div className="sr-field" style={{ marginTop: 12 }}>
              <span className="sr-label">
                {t("liveScreen.frameRate", "Bilderate")}
              </span>
              <select
                className="sr-select"
                value={framerate}
                onChange={(e) => setFramerate(Number(e.target.value))}
              >
                {FRAMERATES.map((f) => (
                  <option key={f} value={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </div>
          </Card>
        </div>
      </div>

      {/* Overlays */}
      <div className="sr-card pad" style={{ marginTop: 16 }}>
        <div className="sr-card-head">
          <div>
            <div className="sr-card-title">
              <Icon name="image" size={17} />
              {t(
                "liveScreen.overlaysTitle",
                "Overlays — grafikk og presentasjon",
              )}
            </div>
            <div className="sr-card-desc" style={{ marginTop: 6 }}>
              {t(
                "liveScreen.overlaysDesc",
                "Legg kirkens logo, sangtekster eller annen grafikk over sendingen. Påvirker bare strømmen — opptak gjøres rent.",
              )}
            </div>
          </div>
          <button className="sr-btn ghost sm" onClick={addOverlay}>
            <Icon name="plus" size={14} />
            {t("liveScreen.addOverlay", "Legg til overlay")}
          </button>
        </div>
        {overlays.length === 0 ? (
          <div
            style={{
              padding: "18px",
              borderRadius: "var(--sr-r-sm)",
              border: "1px dashed var(--sr-line-strong)",
              textAlign: "center",
              color: "var(--sr-text-dim)",
              fontSize: 13,
            }}
          >
            {t("liveScreen.noOverlaysYet", "Ingen overlays ennå")}
          </div>
        ) : (
          <div
            style={{
              padding: "10px",
              borderRadius: "var(--sr-r-sm)",
              border: "1px dashed var(--sr-line-strong)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {overlays.map((o) => (
              <div
                key={o.id}
                className="sr-row"
                style={{
                  padding: "10px 12px",
                  borderRadius: "var(--sr-r-sm)",
                  background: "var(--sr-ink-750)",
                }}
              >
                <Icon name="image" size={16} />
                <div className="sr-col sr-grow" style={{ gap: 2 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                    {o.label}
                  </span>
                  <span style={{ fontSize: 12, color: "var(--sr-text-3)" }}>
                    {o.title}
                  </span>
                </div>
                <button
                  className="sr-btn ghost sm"
                  onClick={() => removeOverlay(o.id)}
                  title={t("liveScreen.removeOverlay", "Fjern overlay")}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Start buttons */}
      <div className="sr-stack-3" style={{ marginTop: 16 }}>
        <button
          className="sr-record"
          onClick={() => startStream(active ? alsoRecord : true)}
        >
          <span className="dot" />
          {active
            ? t("liveScreen.stopStreaming", "Stopp sending")
            : t(
                "liveScreen.startStreamingAndRecording",
                "Start direktesending + opptak",
              )}
        </button>
        <button
          className="sr-record secondary"
          disabled={active}
          onClick={() => startStream(false)}
        >
          {t(
            "liveScreen.streamingOnly",
            "Bare direktesending (uten lokal opptak)",
          )}
        </button>
        <div
          style={{
            textAlign: "center",
            fontSize: 12.5,
            color: "var(--sr-text-3)",
          }}
        >
          {t(
            "liveScreen.startHelpText",
            "Lokal opptaksfil havner i «Siste opptak» når strømmen stopper — høyere kvalitet enn livestreamen.",
          )}
        </div>
      </div>
    </div>
  );
}
