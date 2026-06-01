import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

import type { AppInfo } from "@/lib/bindings/AppInfo";
import type { Settings } from "@/lib/bindings/Settings";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import { DevicePicker } from "@/features/devices/DevicePicker";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";
import { DiagnosticsPanel } from "@/features/diagnostics/DiagnosticsPanel";
import { WakePanel } from "@/features/wake/WakePanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { TranscribePanel } from "@/features/transcribe/TranscribePanel";
import { ReviewPanel } from "@/features/review/ReviewPanel";
import { IntegrationsPanel } from "@/features/integrations/IntegrationsPanel";
import { SuiteHandoffPanel } from "@/features/integrations/SuiteHandoffPanel";
import { PublishPanel } from "@/features/publish/PublishPanel";
import { CloudBackupPanel } from "@/features/cloud/CloudBackupPanel";
import { EmailSettingsPanel } from "@/features/email/EmailSettingsPanel";
import { UpdatePanel } from "@/features/update/UpdatePanel";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { MainLayout } from "@/components/MainLayout";
import { ToastHost } from "@/components/Toast";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { REVIEW_QUEUE_KEY } from "@/features/review/queryKey";
import { changeLanguage } from "@/i18n";
import type { ViewName } from "@/lib/routing";

// Redesigned screens (Claude Design handoff → `src/design`). These are the
// five everyday pages + the settings hub, rebuilt against the `sr-*` design
// system. They are presentational for now; live data is rewired in a later
// pass ("vi fikser funksjonalitet senere").
import { HomeScreen } from "@/design/screens/HomeScreen";
import { ScheduleScreen } from "@/design/screens/ScheduleScreen";
import { LiveScreen } from "@/design/screens/LiveScreen";
import { EditScreen } from "@/design/screens/EditScreen";
import { SearchScreen } from "@/design/screens/SearchScreen";
import { SettingsScreen } from "@/design/screens/SettingsScreen";
import { RecordingScreen } from "@/design/screens/RecordingScreen";

const SCHEDULE_STATUS_KEY = ["scheduler_status"] as const;
const RECORDINGS_LIST_KEY = ["recordings", "list"] as const;

/**
 * The application root. Confirms the Tauri bridge (`app_info`), hydrates i18n
 * from the persisted `Settings`, shows the first-run onboarding wizard, and
 * mounts the redesigned shell (`MainLayout`). The everyday pages are the new
 * `src/design` screens; the remaining panels stay reachable via the ⌘K palette
 * and the settings hub while their own redesign is pending.
 */
function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  // The focused recording mode (sidebar hidden) is a full-window overlay; the
  // Home record button enters it. Real recording is wired later — for now it
  // shows the redesigned "tar opp" screen and the stop button returns home.
  const [recording, setRecording] = useState<null | { video: boolean }>(null);

  const { data, isLoading, isError, error } = useQuery<AppInfo>({
    queryKey: ["app_info"],
    queryFn: () => invoke<AppInfo>("app_info"),
  });

  // Hydrate i18n from the persisted setting once on startup (see Phase-1 note).
  const { data: settings } = useQuery<Settings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => invoke<Settings>("settings_get"),
  });
  useEffect(() => {
    if (settings?.language) void changeLanguage(settings.language);
  }, [settings?.language]);

  // Map the pure-routing lifecycle effect tags (from `nextNav`) to real work:
  // entering a data-backed view refreshes its query so it is never stale.
  const runEffects = useCallback(
    (effects: { enter: readonly string[]; to: ViewName }) => {
      if (effects.enter.includes("refreshHome")) {
        void queryClient.invalidateQueries({ queryKey: SCHEDULE_STATUS_KEY });
        void queryClient.invalidateQueries({ queryKey: RECORDINGS_LIST_KEY });
        void queryClient.invalidateQueries({ queryKey: REVIEW_QUEUE_KEY });
      }
      if (effects.enter.includes("refreshSchedule")) {
        void queryClient.invalidateQueries({ queryKey: SCHEDULE_STATUS_KEY });
      }
      if (effects.enter.includes("refreshReview")) {
        void queryClient.invalidateQueries({ queryKey: REVIEW_QUEUE_KEY });
      }
    },
    [queryClient],
  );

  if (isLoading) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center p-8 text-center">
        <p className="opacity-70">
          {t("home.connecting", "Kobler til backend …")}
        </p>
      </main>
    );
  }

  if (isError || !data) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
        <h1 className="text-2xl font-semibold">{t("app.name", "SundayRec")}</h1>
        <p className="text-red-400">
          {t("home.backendError", "Backend-feil")}:{" "}
          {(error as Error)?.message ??
            t("general.unknownError", "ukjent feil")}
        </p>
      </main>
    );
  }

  // Focused recording mode replaces the whole window (sidebar hidden), exactly
  // as the redesign specifies.
  if (recording) {
    return (
      <RecordingScreen
        video={recording.video}
        onStop={() => setRecording(null)}
      />
    );
  }

  // The view→component map. The five everyday pages + Settings are the
  // redesigned `src/design` screens; the rest keep their existing components
  // (reached via the ⌘K palette / contextual cards) until they are redesigned.
  const views: Record<ViewName, React.ReactNode> = {
    home: <HomeScreen onRecord={(video) => setRecording({ video })} />,
    schedule: <ScheduleScreen />,
    history: <HistoryPanel />,
    review: <ReviewPanel />,
    search: <SearchScreen />,
    editor: <EditScreen />,
    transcribe: <TranscribePanel />,
    publish: <PublishPanel />,
    streaming: <LiveScreen />,
    cloud: <CloudBackupPanel />,
    email: <EmailSettingsPanel />,
    integrations: (
      <div className="flex w-full max-w-md flex-col gap-6">
        <IntegrationsPanel />
        <SuiteHandoffPanel />
      </div>
    ),
    diagnostics: (
      <div className="flex w-full max-w-md flex-col gap-6">
        <DiagnosticsPanel />
        <FfmpegHealth />
        <DevicePicker />
      </div>
    ),
    wake: <WakePanel />,
    settings: <SettingsScreen />,
    update: <UpdatePanel />,
  };

  return (
    <ToastHost>
      <OnboardingFlow />
      <MainLayout
        views={views}
        onTransition={runEffects}
        footer={<SidebarStatus />}
      />
    </ToastHost>
  );
}

/**
 * The always-visible sidebar status line (bottom of the nav): a coloured dot
 * plus the next scheduled recording (or "Alt er klart") and the app version —
 * mirrors the old Electron sidebar footer.
 */
function SidebarStatus() {
  const { t } = useTranslation();
  const { data: status } = useQuery<ScheduleStatus>({
    queryKey: SCHEDULE_STATUS_KEY,
    queryFn: () => invoke<ScheduleStatus>("scheduler_status"),
  });
  const { data: info } = useQuery<AppInfo>({
    queryKey: ["app_info"],
    queryFn: () => invoke<AppInfo>("app_info"),
  });

  const next = status?.next ?? null;
  const nextLabel = next
    ? new Date(next).toLocaleString(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("home.readyTitle", "Alt er klart");

  return (
    <>
      <div className="sr-status-row">
        <span
          aria-hidden
          className="bdot"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: next ? "var(--sr-gold)" : "var(--sr-green)",
          }}
        />
        <span className="sr-status-label" title={nextLabel}>
          {nextLabel}
        </span>
      </div>
      {info?.version && <div className="sr-status-ver">v{info.version}</div>}
    </>
  );
}

export default App;
