/**
 * Rediger — audio editor screen. A faithful port of the Electron renderer's
 * waveform editor (`src/renderer/pages/editor/*`), rebuilt on the React/Tauri
 * shell. All the heavy lifting lives in the framework-agnostic
 * {@link EditorEngine}: client-side Web-Audio peaks + playback (no backend
 * dependency for the waveform), Canvas2D rendering, and pointer/keyboard input.
 * This component is the thin chrome — file bar, transport, cut list, normalize,
 * and export wired to the Rust `editor_export` seam.
 *
 * See docs/EDITOR-PORT.md for the multi-phase plan. Done: waveform + playback +
 * cuts + normalize + export, metadata sidecars, cut-draft recovery, segment
 * detection + auto-trim, mastering, intro/outro, i18n. The video variant is the
 * last remaining piece.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorExportRequest } from "@/lib/bindings/EditorExportRequest";
import type { EditorExportResult } from "@/lib/bindings/EditorExportResult";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import type { EditorLoudness } from "@/lib/bindings/EditorLoudness";
import type { Settings } from "@/lib/bindings/Settings";
import { Badge, Btn, Card, EmptyState, Spinner, Toggle } from "@/design/atoms";
import { Icon } from "@/design/Icon";
import { EditorEngine } from "@/features/editor/engine/EditorEngine";
import { formatTime, formatDuration } from "@/features/editor/engine/format";
import { baseName } from "@/features/editor/engine/types";

const EXPORT_FORMATS = ["mp3", "wav", "flac", "mp4"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Mastering presets (two-pass loudnorm) the export can apply. `null` = none.
 *  Ids mirror the Electron editor + the Rust core preset table; labels resolve
 *  through i18n (the catalogs already carry these preset strings). */
const MASTER_PRESETS: { id: string | null; labelKey: string }[] = [
  { id: null, labelKey: "editor.masterNone" },
  { id: "speech-clear", labelKey: "editScreen.presetSpeechClear" },
  { id: "speech-punchy", labelKey: "editScreen.presetStreaming" },
  { id: "speech-natural", labelKey: "editScreen.presetNatural" },
  { id: "music-speech", labelKey: "editScreen.presetMusicSpeech" },
];

export function EditScreen() {
  const { t, i18n } = useTranslation();
  // One engine per mounted screen.
  const engine = useMemo(() => new EditorEngine(), []);
  const snap = useSyncExternalStore(engine.subscribe, engine.getSnapshot);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const minimapRef = useRef<HTMLCanvasElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [format, setFormat] = useState<ExportFormat>("mp3");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [showRecents, setShowRecents] = useState(false);
  const [masterPreset, setMasterPreset] = useState<string | null>(null);
  const [loudness, setLoudness] = useState<EditorLoudness | null>(null);
  const [analyzingLoudness, setAnalyzingLoudness] = useState(false);
  // Intro/outro jingle paths (decoded client-side for the timeline slots +
  // preview, and passed to the export seam). Seeded from settings.
  const [introPath, setIntroPath] = useState<string | null>(null);
  const [outroPath, setOutroPath] = useState<string | null>(null);

  // Metadata (title/speaker/description) — persisted to the per-recording
  // `.meta` sidecar. `hydrating` suppresses the debounced write while we apply
  // values just read from disk (so a load never echoes straight back out).
  const [title, setTitle] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [description, setDescription] = useState("");
  const hydrating = useRef(false);
  const metaPath = snap.filePath || null;

  // Recent recordings (the user's own history) for the quick-open list.
  const recordings = useQuery<RecordingRow[]>({
    queryKey: ["recordings", "list"],
    queryFn: () => invoke<RecordingRow[]>("recordings_list"),
  });

  // Settings — used to seed the intro/outro jingle paths (Electron parity).
  const settings = useQuery<Settings>({
    queryKey: ["settings"],
    queryFn: () => invoke<Settings>("settings_get"),
  });

  // Seed intro/outro from settings once, then decode them into the engine so
  // the dimmed slots render and preview playback includes them. Default the
  // "include on export" toggle ON when a jingle is configured.
  const seededIntroOutro = useRef(false);
  useEffect(() => {
    if (seededIntroOutro.current || !settings.data) return;
    seededIntroOutro.current = true;
    const ip = settings.data.editorIntroPath ?? null;
    const op = settings.data.editorOutroPath ?? null;
    setIntroPath(ip);
    setOutroPath(op);
    void engine.setIntroFromPath(ip);
    void engine.setOutroFromPath(op);
    if (ip || op) engine.setIncludeIntroOutro(true);
  }, [engine, settings.data]);

  // Persist a changed intro/outro path back to settings (read-modify-write the
  // full object, the app's settings_save contract).
  const persistIntroOutro = useCallback(
    (patch: Partial<Pick<Settings, "editorIntroPath" | "editorOutroPath">>) => {
      if (!settings.data) return;
      const next = { ...settings.data, ...patch };
      invoke<Settings>("settings_save", { settings: next }).catch(() => {});
    },
    [settings.data],
  );

  const pickIntro = useCallback(
    async (which: "intro" | "outro") => {
      try {
        const picked = await open({
          multiple: false,
          filters: [
            {
              name: "Lyd",
              extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"],
            },
          ],
        });
        if (typeof picked !== "string") return;
        if (which === "intro") {
          setIntroPath(picked);
          void engine.setIntroFromPath(picked);
          persistIntroOutro({ editorIntroPath: picked });
        } else {
          setOutroPath(picked);
          void engine.setOutroFromPath(picked);
          persistIntroOutro({ editorOutroPath: picked });
        }
        engine.setIncludeIntroOutro(true);
      } catch {
        /* dialog unavailable in dev/test */
      }
    },
    [engine, persistIntroOutro],
  );

  const clearIntro = useCallback(
    (which: "intro" | "outro") => {
      if (which === "intro") {
        setIntroPath(null);
        void engine.setIntroFromPath(null);
        persistIntroOutro({ editorIntroPath: null });
      } else {
        setOutroPath(null);
        void engine.setOutroFromPath(null);
        persistIntroOutro({ editorOutroPath: null });
      }
    },
    [engine, persistIntroOutro],
  );

  // ── Engine ↔ canvas lifecycle ───────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) engine.attachCanvas(canvas);
    if (minimapRef.current) engine.attachMinimap(minimapRef.current);
    engine.onTick = (sec, _playing) => {
      const el = timeRef.current;
      if (el) el.textContent = formatTime(Math.max(0, sec));
    };
    return () => engine.destroy();
  }, [engine]);

  // Repaint on container resize (sidebar collapse, window resize).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => engine.resize());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [engine]);

  // Translate the canvas overlay labels (segment names, sections, hover
  // tooltip) and refresh them when the app language changes.
  useEffect(() => {
    engine.setLabels({
      sermon: t("editor.tooltipSermon"),
      speech: t("editor.tooltipSpeech"),
      music: t("editor.tooltipMusic"),
      silence: t("editor.tooltipSilence"),
      mixed: t("editor.tooltipMixed"),
      intro: t("editor.tlIntro"),
      outro: t("editor.tlOutro"),
      main: t("editor.tlMain"),
    });
  }, [engine, t, i18n.language]);

  // Hydrate metadata from the `.meta` sidecar whenever a new file loads. Falls
  // back to the engine-derived title (filename, cleaned up) when absent.
  useEffect(() => {
    if (!metaPath) {
      setTitle("");
      setSpeaker("");
      setDescription("");
      return;
    }
    let cancelled = false;
    hydrating.current = true;
    invoke<{ title?: string; speaker?: string; description?: string } | null>(
      "editor_read_sidecar",
      {
        mediaPath: metaPath,
        sidecar: "meta",
      },
    )
      .catch(() => null)
      .then((meta) => {
        if (cancelled) return;
        setTitle(
          meta?.title ??
            snap.fileName.replace(/\.[^.]+$/, "").replace(/_/g, " "),
        );
        setSpeaker(meta?.speaker ?? "");
        setDescription(meta?.description ?? "");
        // Release the hydrate guard after the state settles.
        requestAnimationFrame(() => {
          hydrating.current = false;
        });
      });
    return () => {
      cancelled = true;
    };
    // Re-hydrate only when the file changes, not on fileName churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaPath]);

  // Debounced persist of metadata edits to the `.meta` sidecar.
  useEffect(() => {
    if (!metaPath || hydrating.current) return;
    const id = window.setTimeout(() => {
      invoke<boolean>("editor_write_sidecar", {
        mediaPath: metaPath,
        sidecar: "meta",
        value: { title, speaker, description },
      }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(id);
  }, [metaPath, title, speaker, description]);

  // Auto-detect content segments (speech / music / silence / sermon) in the
  // background once a file is open — feeds the waveform overlays, the snap-to-
  // boundary on cut edges, and the one-click "isolate the sermon" banner.
  const [analyzing, setAnalyzing] = useState(false);
  const [autoTrimDismissed, setAutoTrimDismissed] = useState(false);
  useEffect(() => {
    setAutoTrimDismissed(false);
    if (!metaPath) return;
    let cancelled = false;
    setAnalyzing(true);
    invoke<EditorSegment[]>("editor_segments", { inputPath: metaPath })
      .then((segs) => {
        if (cancelled) return;
        engine.setSuggestions(
          segs.map((s) => ({
            start: s.start,
            end: s.end,
            duration: s.duration,
            label: s.label,
            type: s.kind,
          })),
        );
      })
      .catch(() => {
        /* detection unavailable (feature off / ffmpeg) → no overlays */
      })
      .finally(() => {
        if (!cancelled) setAnalyzing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [engine, metaPath]);

  // Keyboard shortcuts (Electron parity): Space play · Shift+Space preview ·
  // Tab next cut · Shift+Tab prev cut · ⌘Z undo · ⌘⇧Z redo. Suppressed while
  // typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!snap.hasFile) return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.isContentEditable)
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        engine.togglePlay(e.shiftKey);
      } else if (e.code === "Tab") {
        e.preventDefault();
        engine.jumpToCutBoundary(e.shiftKey ? -1 : 1);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [engine, snap.hasFile]);

  // ── File open / close ─────────────────────────────────────────────────────
  const onSelect = useCallback(
    (path: string) => {
      setShowRecents(false);
      setExportResult(null);
      setExportError(null);
      void engine.loadFile(path);
    },
    [engine],
  );

  const onPickFile = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        filters: [
          {
            name: "Lyd",
            extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "opus"],
          },
        ],
      });
      if (typeof picked === "string") onSelect(picked);
    } catch {
      /* dialog plugin unavailable in dev/test → no-op */
    }
  }, [onSelect]);

  const onCloseFile = useCallback(() => {
    engine.closeFile();
    setExportResult(null);
    setExportError(null);
    if (timeRef.current) timeRef.current.textContent = "0:00";
  }, [engine]);

  // ── Normalize ───────────────────────────────────────────────────────────
  const onNormalize = useCallback(() => {
    engine.normalizeToPeak();
  }, [engine]);

  // ── Export — wire the cut plan to the Rust ffmpeg seam ────────────────────
  const onExport = useCallback(async () => {
    if (!snap.filePath) return;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    const folder = snap.filePath.replace(/[/\\][^/\\]*$/, "");
    const request: EditorExportRequest = {
      inputPath: snap.filePath,
      cutRegions: engine.exportCutRegions(),
      duration: snap.duration,
      format,
      outputFolder: folder,
      bitrate: null,
      bitDepth: null,
      masterPreset,
      // Intro/outro are audio-only and only when the toggle is on.
      introPath: snap.includeIntroOutro && format !== "mp4" ? introPath : null,
      outroPath: snap.includeIntroOutro && format !== "mp4" ? outroPath : null,
    };
    try {
      const res = await invoke<EditorExportResult>("editor_export", {
        request,
      });
      setExportResult(res.outputPath);
      // Export succeeded → the cut plan is committed; drop the crash-recovery draft.
      engine.clearDraft();
    } catch (err) {
      setExportError(
        String(err).includes("feature_disabled")
          ? t("editor.featureDisabled")
          : String(err),
      );
    } finally {
      setExporting(false);
    }
  }, [
    engine,
    snap.filePath,
    snap.duration,
    snap.includeIntroOutro,
    format,
    masterPreset,
    introPath,
    outroPath,
    t,
  ]);

  // Measure the file's loudness (EBU R128 LUFS) so the user can judge whether
  // mastering is needed before exporting. Resets whenever the file changes.
  useEffect(() => {
    setLoudness(null);
    setMasterPreset(null);
  }, [metaPath]);

  const onAnalyzeLoudness = useCallback(async () => {
    if (!metaPath) return;
    setAnalyzingLoudness(true);
    try {
      const l = await invoke<EditorLoudness>("editor_mastering_analyze", {
        inputPath: metaPath,
      });
      setLoudness(l);
    } catch {
      /* feature off / ffmpeg unavailable → no readout */
    } finally {
      setAnalyzingLoudness(false);
    }
  }, [metaPath]);

  const isPlaying = snap.isPlaying && !snap.isPreview;
  const isPreviewing = snap.isPlaying && snap.isPreview;

  return (
    <div className="sr-content">
      <div className="sr-pagehead">
        <h1 className="sr-pagetitle">{t("nav.editor")}</h1>
        <p className="sr-pagedesc">{t("editScreen.pageDesc")}</p>
      </div>

      {/* ── File bar ─────────────────────────────────────────────────── */}
      <Card>
        {!snap.hasFile && !snap.loading ? (
          <EmptyState
            icon="wave"
            title={t("editor.emptyTitle")}
            desc={t("editor.emptyDesc")}
            action={
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <Btn variant="gold" icon="folder" onClick={onPickFile}>
                  {t("editScreen.openFileShort")}
                </Btn>
                {(recordings.data?.length ?? 0) > 0 && (
                  <Btn
                    variant="ghost"
                    icon="clock"
                    onClick={() => setShowRecents((v) => !v)}
                  >
                    {t("editScreen.recentRecordings")}
                  </Btn>
                )}
              </div>
            }
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <Icon name="file" size={20} />
              <div style={{ flex: 1, minWidth: 160 }}>
                <div style={{ fontWeight: 600 }}>
                  {snap.loading
                    ? t("editScreen.loadingShort")
                    : snap.fileName || "—"}
                </div>
                <div className="sr-card-desc">
                  {formatDuration(snap.duration)}
                  {snap.clipCount > 0 && (
                    <>
                      {" · ⚠ "}
                      {t("editScreen.clipPeaks", { count: snap.clipCount })}
                    </>
                  )}
                </div>
              </div>
              <Btn
                variant="ghost"
                sm
                icon="clock"
                onClick={() => setShowRecents((v) => !v)}
              >
                {t("editScreen.recentRecordings")}
              </Btn>
              <Btn variant="ghost" sm icon="folder" onClick={onPickFile}>
                {t("editScreen.openOtherFile")}
              </Btn>
              <Btn variant="ghost" sm icon="x" onClick={onCloseFile}>
                {t("editScreen.closeFile")}
              </Btn>
            </div>

            {snap.hasFile && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Btn
                  variant={isPlaying ? "gold" : "ghost"}
                  icon="play"
                  iconFill
                  ariaLabel={t("editScreen.kbdPlay")}
                  onClick={() => engine.togglePlay(false)}
                >
                  {isPlaying
                    ? t("editScreen.kbdPause")
                    : t("editScreen.kbdPlay")}
                </Btn>
                <Btn
                  variant={isPreviewing ? "gold" : "ghost"}
                  icon="skip"
                  ariaLabel={t("editScreen.previewSkip")}
                  onClick={() => engine.togglePlay(true)}
                >
                  {t("editScreen.previewSkip")}
                </Btn>
                <span
                  style={{
                    fontVariantNumeric: "tabular-nums",
                    color: "var(--sr-text-2)",
                  }}
                >
                  <span ref={timeRef}>0:00</span> / {formatTime(snap.duration)}
                </span>
              </div>
            )}
          </div>
        )}

        {showRecents && (
          <div
            style={{
              marginTop: 12,
              borderTop: "1px solid var(--sr-ink-700)",
              paddingTop: 12,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: 240,
              overflow: "auto",
            }}
          >
            {(recordings.data?.length ?? 0) === 0 ? (
              <div className="sr-card-desc">
                {t("editScreen.noRecentRecordings")}
              </div>
            ) : (
              recordings.data!.map((r) => (
                <button
                  key={r.id}
                  className="sr-btn ghost"
                  style={{ justifyContent: "flex-start" }}
                  onClick={() => onSelect(r.file_path)}
                >
                  <Icon name="file" size={15} />
                  <span
                    style={{
                      flex: 1,
                      textAlign: "left",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {baseName(r.file_path)}
                  </span>
                  {r.duration_ms != null && (
                    <span className="sr-card-desc">
                      {formatDuration(r.duration_ms / 1000)}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        )}

        {snap.error && (
          <div style={{ marginTop: 10 }}>
            <Badge kind="err">{snap.error}</Badge>
          </div>
        )}
      </Card>

      {/* ── Auto-trim banner (detected sermon) ───────────────────────── */}
      {snap.hasFile &&
        snap.sermon &&
        !autoTrimDismissed &&
        snap.cuts.length === 0 && (
          <Card
            style={{
              borderColor: "var(--sr-gold-line)",
              background: "var(--sr-gold-tint)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <Icon name="sparkle" size={20} />
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontWeight: 600 }}>
                  {t("editScreen.assumedSermon", {
                    minutes: snap.sermon.minutes,
                  })}
                </div>
                <div className="sr-card-desc">
                  {formatTime(snap.sermon.start)} –{" "}
                  {formatTime(snap.sermon.end)}.{" "}
                  {t("editScreen.sermonBannerDesc")}
                </div>
              </div>
              <Btn
                variant="gold"
                icon="scissors"
                onClick={() => engine.autoTrimToSermon()}
              >
                {t("editScreen.keepSermonOnly")}
              </Btn>
              <Btn
                variant="ghost"
                sm
                onClick={() => setAutoTrimDismissed(true)}
              >
                {t("editScreen.dismiss")}
              </Btn>
            </div>
          </Card>
        )}

      {/* ── Waveform ─────────────────────────────────────────────────── */}
      <Card
        title={t("editScreen.timeline")}
        icon="wave"
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {analyzing && (
              <span
                className="sr-card-desc"
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Spinner size={13} /> {t("editScreen.analyzing")}
              </span>
            )}
            <Btn
              variant="ghost"
              sm
              icon="zoomOut"
              ariaLabel={t("editor.zoomOut")}
              onClick={() => engine.zoom(1.5)}
            />
            <Btn
              variant="ghost"
              sm
              icon="zoomIn"
              ariaLabel={t("editor.zoomIn")}
              onClick={() => engine.zoom(0.6)}
            />
            <Btn variant="ghost" sm onClick={() => engine.fitView()}>
              {t("editor.fitAll")}
            </Btn>
          </div>
        }
      >
        <div
          ref={wrapRef}
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
        >
          <canvas
            ref={canvasRef}
            style={{
              width: "100%",
              height: 200,
              borderRadius: 10,
              background: "var(--sr-ink-900)",
              display: "block",
            }}
          />
          {!snap.hasFile && (
            <div
              style={{
                marginTop: -160,
                marginBottom: 132,
                textAlign: "center",
                color: "var(--sr-text-3)",
                pointerEvents: "none",
              }}
            >
              {t("editor.dragHint")}
            </div>
          )}
          <canvas
            ref={minimapRef}
            style={{ width: "100%", height: 44, display: "block" }}
          />
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}
          >
            <KbdHint
              k={t("editScreen.kbdDrag")}
              label={t("editScreen.kbdMarkCut")}
            />
            <KbdHint
              k={t("editScreen.kbdSpace")}
              label={t("editScreen.kbdPlay")}
            />
            <KbdHint k="Tab" label={t("editScreen.kbdNextCut")} />
            <KbdHint k="⌘Z" label={t("editScreen.kbdUndo")} />
            <KbdHint
              k={t("editScreen.kbdRightClick")}
              label={t("editScreen.removeCut")}
            />
          </div>
        </div>
      </Card>

      {/* ── Normalize ────────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <Btn
              variant={snap.normalized ? "ghost" : "gold"}
              icon="normalize"
              onClick={onNormalize}
            >
              {snap.normalized
                ? `✓ ${t("editor.normalizeApplied")} (${snap.audioGainDb >= 0 ? "+" : ""}${snap.audioGainDb.toFixed(1)} dB)`
                : t("editScreen.normalizeLevel")}
            </Btn>
            <div className="sr-card-desc" style={{ flex: 1, minWidth: 160 }}>
              {snap.normalized
                ? t("editor.normalizeResult")
                : t("editScreen.normalizeDescAudio")}
            </div>
            {snap.normalized && (
              <Btn variant="ghost" sm onClick={() => engine.resetNormalize()}>
                {t("editScreen.resetBtn")}
              </Btn>
            )}
          </div>
        </Card>
      )}

      {/* ── Cut list ─────────────────────────────────────────────────── */}
      {snap.cuts.length > 0 && (
        <Card
          title={t("editor.cutRegion")}
          icon="scissors"
          action={
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Badge kind="gold">{snap.cuts.length}</Badge>
              <Btn
                variant="ghost"
                sm
                icon="refresh"
                disabled={!snap.canUndo}
                onClick={() => engine.undo()}
              >
                {t("editScreen.kbdUndo")}
              </Btn>
              <Btn
                variant="ghost"
                sm
                disabled={!snap.canRedo}
                onClick={() => engine.redo()}
              >
                {t("editScreen.redo")}
              </Btn>
              <Btn variant="danger" sm onClick={() => engine.clearAllCuts()}>
                {t("editor.cutsNone")}
              </Btn>
            </div>
          }
          desc={t("editScreen.keepRemove", {
            keep: formatDuration(snap.remainingSec),
            remove: formatDuration(snap.removedSec),
          })}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {snap.cuts.map((c, i) => (
              <div
                key={`${c.start}-${c.end}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "6px 10px",
                  borderRadius: 8,
                  background: "var(--sr-ink-850)",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontVariantNumeric: "tabular-nums" }}>
                    {formatTime(c.start)} – {formatTime(c.end)}
                  </div>
                  <div className="sr-card-desc">
                    {formatDuration(c.end - c.start)}
                  </div>
                </div>
                <Btn
                  variant="ghost"
                  sm
                  icon="play"
                  iconFill
                  ariaLabel={t("editScreen.previewSkip")}
                  onClick={() => engine.previewCut(c)}
                />
                <Btn
                  variant="ghost"
                  sm
                  icon="x"
                  ariaLabel={t("editScreen.removeCut")}
                  onClick={() => engine.deleteCut(i)}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Intro & Outro ────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card
          title={t("editScreen.introOutro")}
          icon="speaker"
          action={
            <button
              className="sr-btn ghost sm"
              onClick={() =>
                engine.setIncludeIntroOutro(!snap.includeIntroOutro)
              }
              style={{ gap: 8 }}
            >
              <Toggle on={snap.includeIntroOutro} />
              {t("editScreen.includeOnExport")}
            </button>
          }
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <IntroOutroRow
              label={t("editScreen.waveIntro")}
              path={introPath}
              durationSec={snap.introDuration}
              onPick={() => pickIntro("intro")}
              onClear={() => clearIntro("intro")}
            />
            <IntroOutroRow
              label={t("editScreen.waveOutro")}
              path={outroPath}
              durationSec={snap.outroDuration}
              onPick={() => pickIntro("outro")}
              onClear={() => clearIntro("outro")}
            />
            {format === "mp4" && (snap.hasIntro || snap.hasOutro) && (
              <div className="sr-card-desc">
                {t("editScreen.introOutroAudioOnly")}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* ── Metadata ─────────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card
          title={t("editScreen.metadata")}
          icon="list"
          desc={t("editScreen.metadataHint")}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">{t("editScreen.metaTitle")}</span>
              <input
                className="sr-input"
                value={title}
                placeholder={t("editScreen.metaTitlePlaceholder")}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">{t("editScreen.metaSpeaker")}</span>
              <input
                className="sr-input"
                value={speaker}
                placeholder={t("editScreen.metaSpeakerPlaceholder")}
                onChange={(e) => setSpeaker(e.target.value)}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">
                {t("editScreen.metaDescription")}
              </span>
              <textarea
                className="sr-input"
                value={description}
                rows={3}
                placeholder={t("editScreen.metaDescriptionPlaceholder")}
                onChange={(e) => setDescription(e.target.value)}
                style={{ resize: "vertical" }}
              />
            </label>
          </div>
        </Card>
      )}

      {/* ── Export ───────────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card title={t("editor.export")} icon="download">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <span className="sr-label">{t("editScreen.format")}</span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 6,
                }}
              >
                {EXPORT_FORMATS.map((f) => (
                  <button
                    key={f}
                    className={
                      "sr-btn " + (format === f ? "gold" : "ghost") + " sm"
                    }
                    onClick={() => setFormat(f)}
                  >
                    {f.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="sr-label">{t("editor.preset")}</span>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 6,
                }}
              >
                {MASTER_PRESETS.map((p) => (
                  <button
                    key={p.id ?? "none"}
                    className={
                      "sr-btn " +
                      (masterPreset === p.id ? "gold" : "ghost") +
                      " sm"
                    }
                    onClick={() => setMasterPreset(p.id)}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginTop: 8,
                  flexWrap: "wrap",
                }}
              >
                <Btn
                  variant="ghost"
                  sm
                  icon="eq"
                  loading={analyzingLoudness}
                  onClick={onAnalyzeLoudness}
                >
                  {t("editScreen.normalizeLevel")}
                </Btn>
                {loudness && (
                  <span className="sr-card-desc">
                    {t("editScreen.loudnessNow", {
                      input: loudness.inputI.toFixed(1),
                      target: loudness.targetLufs.toFixed(0),
                    })}
                    {loudness.inputI < loudness.targetLufs - 1 &&
                      ` · ${t("editScreen.masteringAdvised")}`}
                  </span>
                )}
              </div>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              <Btn
                variant="gold"
                icon="download"
                loading={exporting}
                onClick={onExport}
              >
                {t("editor.export")} {format.toUpperCase()}
              </Btn>
              <div className="sr-card-desc" style={{ flex: 1, minWidth: 160 }}>
                {snap.cuts.length > 0
                  ? t("editScreen.cutsWillRemove", {
                      count: snap.cuts.length,
                      remaining: formatDuration(snap.remainingSec),
                    })
                  : t("editScreen.wholeFileExport")}
              </div>
            </div>
            {exportResult && (
              <Badge kind="ok">
                {t("editScreen.savedAs", { name: baseName(exportResult) })}
              </Badge>
            )}
            {exportError && <Badge kind="err">{exportError}</Badge>}
          </div>
        </Card>
      )}
    </div>
  );
}

function IntroOutroRow({
  label,
  path,
  durationSec,
  onPick,
  onClear,
}: {
  label: string;
  path: string | null;
  durationSec: number;
  onPick: () => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "6px 10px",
        borderRadius: 8,
        background: "var(--sr-ink-850)",
      }}
    >
      <span className="sr-label" style={{ minWidth: 48 }}>
        {label}
      </span>
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: path ? "var(--sr-text)" : "var(--sr-text-3)",
        }}
      >
        {path ? baseName(path) : t("editScreen.noFileChosen")}
        {path && durationSec > 0 && (
          <span className="sr-card-desc"> · {formatDuration(durationSec)}</span>
        )}
      </span>
      <Btn variant="ghost" sm icon="folder" onClick={onPick}>
        {t("editScreen.chooseFile")}
      </Btn>
      {path && (
        <Btn
          variant="ghost"
          sm
          icon="x"
          ariaLabel={t("editScreen.resetBtn")}
          onClick={onClear}
        />
      )}
    </div>
  );
}

function KbdHint({ k, label }: { k: string; label: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontSize: 12,
      }}
    >
      <kbd
        style={{
          padding: "2px 6px",
          borderRadius: 5,
          background: "var(--sr-ink-750)",
          border: "1px solid var(--sr-ink-700)",
          fontFamily: "inherit",
          fontSize: 11,
        }}
      >
        {k}
      </kbd>
      <span style={{ color: "var(--sr-text-3)" }}>{label}</span>
    </span>
  );
}
