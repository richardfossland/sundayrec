/**
 * Rediger — audio editor screen. A faithful port of the Electron renderer's
 * waveform editor (`src/renderer/pages/editor/*`), rebuilt on the React/Tauri
 * shell. All the heavy lifting lives in the framework-agnostic
 * {@link EditorEngine}: client-side Web-Audio peaks + playback (no backend
 * dependency for the waveform), Canvas2D rendering, and pointer/keyboard input.
 * This component is the thin chrome — file bar, transport, cut list, normalize,
 * and export wired to the Rust `editor_export` seam.
 *
 * See docs/EDITOR-PORT.md for the multi-phase plan. Phase 1 = waveform +
 * playback + cuts + normalize + export. Intro/outro, metadata sidecars,
 * mastering, segment detection and the video variant land in later phases.
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

import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorExportRequest } from "@/lib/bindings/EditorExportRequest";
import type { EditorExportResult } from "@/lib/bindings/EditorExportResult";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import { Badge, Btn, Card, EmptyState, Spinner } from "@/design/atoms";
import { Icon } from "@/design/Icon";
import { EditorEngine } from "@/features/editor/engine/EditorEngine";
import { formatTime, formatDuration } from "@/features/editor/engine/format";
import { baseName } from "@/features/editor/engine/types";

const EXPORT_FORMATS = ["mp3", "wav", "flac", "mp4"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

export function EditScreen() {
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
      masterPreset: null,
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
          ? "Eksport er ikke aktivert i denne byggevarianten."
          : String(err),
      );
    } finally {
      setExporting(false);
    }
  }, [engine, snap.filePath, snap.duration, format]);

  const isPlaying = snap.isPlaying && !snap.isPreview;
  const isPreviewing = snap.isPlaying && snap.isPreview;

  return (
    <div className="sr-content">
      <div className="sr-pagehead">
        <h1 className="sr-pagetitle">Rediger</h1>
        <p className="sr-pagedesc">
          Klipp bort stillhet, normaliser og eksporter ferdig episode.
        </p>
      </div>

      {/* ── File bar ─────────────────────────────────────────────────── */}
      <Card>
        {!snap.hasFile && !snap.loading ? (
          <EmptyState
            icon="wave"
            title="Ingen fil åpnet"
            desc="Åpne et opptak for å klippe, normalisere og eksportere."
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
                  Åpne fil
                </Btn>
                {(recordings.data?.length ?? 0) > 0 && (
                  <Btn
                    variant="ghost"
                    icon="clock"
                    onClick={() => setShowRecents((v) => !v)}
                  >
                    Siste opptak
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
                  {snap.loading ? "Laster …" : snap.fileName || "Uten navn"}
                </div>
                <div className="sr-card-desc">
                  {formatDuration(snap.duration)}
                  {snap.clipCount > 0 && (
                    <> · ⚠ {snap.clipCount} klipp-topper</>
                  )}
                </div>
              </div>
              <Btn
                variant="ghost"
                sm
                icon="clock"
                onClick={() => setShowRecents((v) => !v)}
              >
                Siste opptak
              </Btn>
              <Btn variant="ghost" sm icon="folder" onClick={onPickFile}>
                Åpne annen fil
              </Btn>
              <Btn variant="ghost" sm icon="x" onClick={onCloseFile}>
                Lukk fil
              </Btn>
            </div>

            {snap.hasFile && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <Btn
                  variant={isPlaying ? "gold" : "ghost"}
                  icon="play"
                  iconFill
                  ariaLabel="Spill / pause"
                  onClick={() => engine.togglePlay(false)}
                >
                  {isPlaying ? "Pause" : "Spill"}
                </Btn>
                <Btn
                  variant={isPreviewing ? "gold" : "ghost"}
                  icon="skip"
                  ariaLabel="Forhåndsvis uten kutt"
                  onClick={() => engine.togglePlay(true)}
                >
                  Forhåndsvis
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
                Ingen opptak i historikken ennå.
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
                  Fant antatt preken — {snap.sermon.minutes} min
                </div>
                <div className="sr-card-desc">
                  {formatTime(snap.sermon.start)} –{" "}
                  {formatTime(snap.sermon.end)}. Klipp bort alt rundt med ett
                  klikk.
                </div>
              </div>
              <Btn
                variant="gold"
                icon="scissors"
                onClick={() => engine.autoTrimToSermon()}
              >
                Behold bare preken
              </Btn>
              <Btn
                variant="ghost"
                sm
                onClick={() => setAutoTrimDismissed(true)}
              >
                Avvis
              </Btn>
            </div>
          </Card>
        )}

      {/* ── Waveform ─────────────────────────────────────────────────── */}
      <Card
        title="Tidslinje"
        icon="wave"
        action={
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {analyzing && (
              <span
                className="sr-card-desc"
                style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <Spinner size={13} /> Analyserer …
              </span>
            )}
            <Btn
              variant="ghost"
              sm
              icon="zoomOut"
              ariaLabel="Zoom ut"
              onClick={() => engine.zoom(1.5)}
            />
            <Btn
              variant="ghost"
              sm
              icon="zoomIn"
              ariaLabel="Zoom inn"
              onClick={() => engine.zoom(0.6)}
            />
            <Btn variant="ghost" sm onClick={() => engine.fitView()}>
              Vis alt
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
              Åpne en fil for å se bølgeformen.
            </div>
          )}
          <canvas
            ref={minimapRef}
            style={{ width: "100%", height: 44, display: "block" }}
          />
          <div
            style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}
          >
            <KbdHint k="Dra" label="Marker kutt" />
            <KbdHint k="Mellomrom" label="Spill" />
            <KbdHint k="Tab" label="Neste kutt" />
            <KbdHint k="⌘Z" label="Angre" />
            <KbdHint k="Høyreklikk" label="Fjern kutt" />
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
                ? `✓ Normalisert (${snap.audioGainDb >= 0 ? "+" : ""}${snap.audioGainDb.toFixed(1)} dB)`
                : "Normaliser lydnivå"}
            </Btn>
            <div className="sr-card-desc" style={{ flex: 1, minWidth: 160 }}>
              {snap.normalized
                ? "Toppunkt nå −1 dBFS — trygg for eksport."
                : "Justerer toppunktet til −1 dBFS for en trygg sluttmiks."}
            </div>
            {snap.normalized && (
              <Btn variant="ghost" sm onClick={() => engine.resetNormalize()}>
                Tilbakestill
              </Btn>
            )}
          </div>
        </Card>
      )}

      {/* ── Cut list ─────────────────────────────────────────────────── */}
      {snap.cuts.length > 0 && (
        <Card
          title="Kutt"
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
                Angre
              </Btn>
              <Btn
                variant="ghost"
                sm
                disabled={!snap.canRedo}
                onClick={() => engine.redo()}
              >
                Gjør om
              </Btn>
              <Btn variant="danger" sm onClick={() => engine.clearAllCuts()}>
                Fjern alle
              </Btn>
            </div>
          }
          desc={`Beholder ${formatDuration(snap.remainingSec)} · fjerner ${formatDuration(snap.removedSec)}`}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {snap.cuts.map((c, i) => (
              <div
                key={`${c.start}-${c.end}-${i}`}
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
                  ariaLabel="Spill rundt kuttet"
                  onClick={() => engine.previewCut(c)}
                />
                <Btn
                  variant="ghost"
                  sm
                  icon="x"
                  ariaLabel="Fjern kutt"
                  onClick={() => engine.deleteCut(i)}
                />
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* ── Metadata ─────────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card title="Metadata" icon="list" desc="Tittel, taler, beskrivelse">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">TITTEL</span>
              <input
                className="sr-input"
                value={title}
                placeholder="F.eks. Pinsegudstjeneste, 24. mai"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">TALER</span>
              <input
                className="sr-input"
                value={speaker}
                placeholder="Talerens navn"
                onChange={(e) => setSpeaker(e.target.value)}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span className="sr-label">BESKRIVELSE</span>
              <textarea
                className="sr-input"
                value={description}
                rows={3}
                placeholder="Kort beskrivelse av episoden"
                onChange={(e) => setDescription(e.target.value)}
                style={{ resize: "vertical" }}
              />
            </label>
          </div>
        </Card>
      )}

      {/* ── Export ───────────────────────────────────────────────────── */}
      {snap.hasFile && (
        <Card title="Eksporter" icon="download">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
                Eksporter {format.toUpperCase()}
              </Btn>
              <div className="sr-card-desc" style={{ flex: 1, minWidth: 160 }}>
                {snap.cuts.length > 0
                  ? `${snap.cuts.length} kutt blir fjernet — beholder ${formatDuration(snap.remainingSec)}.`
                  : "Hele filen eksporteres (ingen kutt markert)."}
              </div>
            </div>
            {exportResult && (
              <Badge kind="ok">Lagret: {baseName(exportResult)}</Badge>
            )}
            {exportError && <Badge kind="err">{exportError}</Badge>}
          </div>
        </Card>
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
