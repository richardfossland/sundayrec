import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

import type { AppInfo } from "@/lib/bindings/AppInfo";
import { VuMeter } from "@/features/vu/VuMeter";
import { CameraPreview } from "@/features/preview/CameraPreview";
import { RecorderPanel } from "@/features/recorder/RecorderPanel";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

/** Phase 0 proof-of-life: round-trip `app_info` through the Tauri bridge and
 *  render the backend's identity. Replaced by the real home screen in Phase 8. */
function App() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery<AppInfo>({
    queryKey: ["app_info"],
    queryFn: () => invoke<AppInfo>("app_info"),
  });

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <h1 className="text-2xl font-semibold">{t("app.name", "SundayRec")}</h1>

      {isLoading && (
        <p className="opacity-70">{t("home.connecting", "Kobler til backend …")}</p>
      )}

      {isError && (
        <p className="text-red-400">
          {t("home.backendError", "Backend-feil")}:{" "}
          {(error as Error)?.message ?? t("general.unknownError", "ukjent feil")}
        </p>
      )}

      {data && (
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-col items-center gap-1">
            <p className="text-lg">
              {t("home.backendOk", "SundayRec — backend OK")}
            </p>
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

          {/* Spike B: unified ffmpeg recorder prototype — start/stop a capture
              and watch live progress/silence/error events from the Rust engine. */}
          <RecorderPanel />

          {/* Spike A: bundled ffmpeg sidecar health-check — proves the
              externalBin wiring the recorder + preview depend on. */}
          <FfmpegHealth />
        </div>
      )}
    </main>
  );
}

export default App;
