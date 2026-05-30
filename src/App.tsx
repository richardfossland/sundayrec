import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";

import type { AppInfo } from "@/lib/bindings/AppInfo";
import { VuMeter } from "@/features/vu/VuMeter";
import { CameraPreview } from "@/features/preview/CameraPreview";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";

/** Phase 0 proof-of-life: round-trip `app_info` through the Tauri bridge and
 *  render the backend's identity. Replaced by the real home screen in Phase 8. */
function App() {
  const { data, isLoading, isError, error } = useQuery<AppInfo>({
    queryKey: ["app_info"],
    queryFn: () => invoke<AppInfo>("app_info"),
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-2xl font-semibold">SundayRec</h1>

      {isLoading && <p className="opacity-70">Kobler til backend …</p>}

      {isError && (
        <p className="text-red-400">
          Backend-feil: {(error as Error)?.message ?? "ukjent feil"}
        </p>
      )}

      {data && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <p className="text-lg">SundayRec — backend OK</p>
            <p className="text-sm opacity-70">
              v{data.version} · {data.platform} ({data.arch}) · Tauri{" "}
              {data.tauri_version}
            </p>
          </div>

          {/* Spike A: live mic VU metered in Rust (cpal), pushed over a Tauri
              event — proves the webview never needs getUserMedia. */}
          <VuMeter />

          {/* Spike A: live camera preview as MJPEG frames decoded in Rust
              (ffmpeg) and painted into an <img> — no webview video codec. */}
          <CameraPreview />

          {/* Spike A: bundled ffmpeg sidecar health-check — proves the
              externalBin wiring the recorder + preview depend on. */}
          <FfmpegHealth />
        </div>
      )}
    </main>
  );
}

export default App;
