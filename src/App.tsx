import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

import type { AppInfo } from "@/lib/bindings/AppInfo";
import type { Settings } from "@/lib/bindings/Settings";
import { DevicePicker } from "@/features/devices/DevicePicker";
import { RecorderPanel } from "@/features/recorder/RecorderPanel";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";
import { DiagnosticsPanel } from "@/features/diagnostics/DiagnosticsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SchedulePage } from "@/features/schedule/SchedulePage";
import { WakePanel } from "@/features/wake/WakePanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { EditorPanel } from "@/features/editor/EditorPanel";
import { TranscribePanel } from "@/features/transcribe/TranscribePanel";
import { ReviewPanel } from "@/features/review/ReviewPanel";
import { CloudBackupPanel } from "@/features/cloud/CloudBackupPanel";
import { EmailSettingsPanel } from "@/features/email/EmailSettingsPanel";
import { StreamingPanel } from "@/features/streaming/StreamingPanel";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { changeLanguage } from "@/i18n";

/** Phase 0 proof-of-life: round-trip `app_info` through the Tauri bridge and
 *  render the backend's identity. Replaced by the real home screen in Phase 8. */
function App() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery<AppInfo>({
    queryKey: ["app_info"],
    queryFn: () => invoke<AppInfo>("app_info"),
  });

  // Hydrate i18n from the persisted setting once on startup. i18n initialises
  // synchronously from localStorage (fast cache); here we reconcile with the
  // canonical `Settings.language` and switch if it differs. We also seed the
  // settings query cache so SettingsPage opens without a second fetch.
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });
  useEffect(() => {
    if (settings?.language) void changeLanguage(settings.language);
  }, [settings?.language]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <h1 className="text-2xl font-semibold">{t("app.name", "SundayRec")}</h1>

      {isLoading && (
        <p className="opacity-70">
          {t("home.connecting", "Kobler til backend …")}
        </p>
      )}

      {isError && (
        <p className="text-red-400">
          {t("home.backendError", "Backend-feil")}:{" "}
          {(error as Error)?.message ??
            t("general.unknownError", "ukjent feil")}
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

          {/* F2.1: the device picker — choose mic + camera (real ffmpeg
              enumeration), persist to Settings, and drive the live VU (cpal)
              and the MJPEG camera preview (ffmpeg) from the selection. */}
          <DevicePicker />

          {/* Spike B: unified ffmpeg recorder prototype — start/stop a capture
              and watch live progress/silence/error events from the Rust engine. */}
          <RecorderPanel />

          {/* Spike A: bundled ffmpeg sidecar health-check — proves the
              externalBin wiring the recorder + preview depend on. */}
          <FfmpegHealth />

          {/* F1.2: Settings vertical. No router yet — surface the page behind a
              disclosure until the real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("nav.general", "Generelt")}
            </summary>
            <div className="mt-3">
              <SettingsPage />
            </div>
          </details>

          {/* F5.1: Schedule vertical — weekly slots + dated specials drive the
              backend scheduler supervisor. Same disclosure pattern until the
              real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("schedule.title", "Planlegging")}
            </summary>
            <div className="mt-3">
              <SchedulePage />
            </div>
          </details>

          {/* F5.2: Wake-from-sleep vertical — capabilities, sleep-config fix,
              schedule + verify OS wake timers. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("wake.title", "Vekking fra dvale")}
            </summary>
            <div className="mt-3">
              <WakePanel />
            </div>
          </details>

          {/* F1.3: Recording history + native file dialogs vertical. Same
              disclosure pattern until the real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("nav.history", "Historikk")}
            </summary>
            <div className="mt-3">
              <HistoryPanel />
            </div>
          </details>

          {/* R1: non-destructive editor — load a recording, peaks/segments/
              loudness, export to a chosen format with optional mastering. The
              ffmpeg work is behind the default-off `editor` feature, so the
              panel shows a "not built into this build" hint in the default
              build. Same disclosure pattern until the real shell lands. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("editor.title", "Redigering")}
            </summary>
            <div className="mt-3">
              <EditorPanel />
            </div>
          </details>

          {/* PU-5: transcription — pick a recording + a whisper model, run
              local AI transcription, and save the result to SRT/VTT/TXT. The
              inference is behind the default-off `whisper` feature, so the
              panel shows a "not built into this build" hint in the default
              build (the model registry still lists). Same disclosure pattern. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("transcribe.title", "Transkribering")}
            </summary>
            <div className="mt-3">
              <TranscribePanel />
            </div>
          </details>

          {/* PU-6: episode-prep / human-review queue — list recordings queued
              for review, show the detected sermon + attention reasons, and
              approve/discard each (and run the reminder sweep). Same disclosure
              pattern until the real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("review.title", "Gjennomgang")}
            </summary>
            <div className="mt-3">
              <ReviewPanel />
            </div>
          </details>

          {/* Fase 6: cloud-backup connections + durable upload queue. Same
              disclosure pattern until the real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("cloud.title", "Sky-backup")}
            </summary>
            <div className="mt-3">
              <CloudBackupPanel />
            </div>
          </details>

          {/* PU-1: email alerts — a Gmail-connect (no SMTP) or SMTP transport
              for a localized "email works" test. The send is behind the
              default-off `email` feature, so the panel shows a calm "not built
              into this build" hint in the default build (it reads `email_status`
              up-front). Same disclosure pattern until the real shell lands. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("email.title", "E-postvarsler")}
            </summary>
            <div className="mt-3">
              <EmailSettingsPanel />
            </div>
          </details>

          {/* R3: live RTMP streaming — per-destination keys in the keychain,
              optional lower-third text overlay, start/stop + live status. The
              ffmpeg push is behind the default-off `streaming` feature, so the
              panel shows a calm "not built into this build" hint in the default
              build (the key vault still works). Same disclosure pattern. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("streaming.title", "Direktesending")}
            </summary>
            <div className="mt-3">
              <StreamingPanel />
            </div>
          </details>

          {/* F2.2: preflight (ready-to-record) + diagnostics markdown report.
              Same disclosure pattern until the real shell/nav lands in Phase 8. */}
          <details className="w-full max-w-md text-left">
            <summary className="cursor-pointer text-sm font-medium">
              {t("diagnostics.title", "Diagnose")}
            </summary>
            <div className="mt-3">
              <DiagnosticsPanel />
            </div>
          </details>
        </div>
      )}
    </main>
  );
}

export default App;
