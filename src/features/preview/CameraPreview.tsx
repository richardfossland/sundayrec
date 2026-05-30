import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";

/**
 * Live camera preview. ffmpeg captures the camera as MJPEG in Rust; each JPEG
 * frame arrives as a `preview://frame` event and is painted into a plain
 * `<img>` — so the webview never touches `getUserMedia` or a video codec (see
 * docs/MIGRATION-TAURI2.md, "Webview media" risk).
 */
export function CameraPreview() {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [frame, setFrame] = useState<PreviewFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track whether at least one frame has landed, so the UI can distinguish
  // "starting…" from "streaming".
  const frameCount = useRef(0);

  // Subscribe to preview frames for the lifetime of the component.
  useEffect(() => {
    const unlisten = listen<PreviewFrame>("preview://frame", (event) => {
      frameCount.current += 1;
      setFrame(event.payload);
    });
    return () => {
      void unlisten.then((off) => off());
    };
  }, []);

  const start = useCallback(async () => {
    setError(null);
    frameCount.current = 0;
    try {
      await invoke("start_preview", { device: null, fps: null });
      setRunning(true);
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    }
  }, []);

  const stop = useCallback(async () => {
    try {
      await invoke("stop_preview");
    } catch (e) {
      setError(String((e as { message?: string })?.message ?? e));
    } finally {
      setRunning(false);
      setFrame(null);
    }
  }, []);

  // Stop the preview if the component unmounts while running.
  useEffect(() => {
    return () => {
      if (running) void invoke("stop_preview").catch(() => {});
    };
  }, [running]);

  const dims =
    frame?.width && frame?.height ? `${frame.width}×${frame.height}` : null;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-zinc-700 p-4"
      aria-label="Kamera-preview"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {t("home.videoPreview", "Kamera-preview")}
        </h2>
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
            Start preview
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="relative aspect-video overflow-hidden rounded bg-zinc-900">
        {frame ? (
          <img
            className="h-full w-full object-contain"
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="Kamera-preview"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs opacity-50">
            {running ? "Venter på første bilde …" : "Preview er av"}
          </div>
        )}
        {dims && (
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums opacity-80">
            {dims}
          </span>
        )}
      </div>

      {!running && (
        <p className="text-xs opacity-50">
          Trykk «Start preview» — bildene dekodes i Rust (ffmpeg → MJPEG), ikke i
          webviewen.
        </p>
      )}
    </section>
  );
}
