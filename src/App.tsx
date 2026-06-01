import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";

import type { AppInfo } from "@/lib/bindings/AppInfo";
import type { Settings } from "@/lib/bindings/Settings";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";
import { DevicePicker } from "@/features/devices/DevicePicker";
import { FfmpegHealth } from "@/features/diagnostics/FfmpegHealth";
import { DiagnosticsPanel } from "@/features/diagnostics/DiagnosticsPanel";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { SchedulePage } from "@/features/schedule/SchedulePage";
import { WakePanel } from "@/features/wake/WakePanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { EditorPanel } from "@/features/editor/EditorPanel";
import { TranscribePanel } from "@/features/transcribe/TranscribePanel";
import { ReviewPanel } from "@/features/review/ReviewPanel";
import { IntegrationsPanel } from "@/features/integrations/IntegrationsPanel";
import { SuiteHandoffPanel } from "@/features/integrations/SuiteHandoffPanel";
import { PublishPanel } from "@/features/publish/PublishPanel";
import { CloudBackupPanel } from "@/features/cloud/CloudBackupPanel";
import { EmailSettingsPanel } from "@/features/email/EmailSettingsPanel";
import { StreamingPanel } from "@/features/streaming/StreamingPanel";
import { UpdatePanel } from "@/features/update/UpdatePanel";
import { HomePage } from "@/features/home/HomePage";
import { SearchPage } from "@/features/search/SearchPage";
import { OnboardingFlow } from "@/features/onboarding/OnboardingFlow";
import { MainLayout, SHELL_NAVIGATE_EVENT } from "@/components/MainLayout";
import { ToastHost } from "@/components/Toast";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { SETTINGS_QUERY_KEY } from "@/features/settings/queryKey";
import { REVIEW_QUEUE_KEY } from "@/features/review/queryKey";
import { changeLanguage } from "@/i18n";
import type { ViewName } from "@/lib/routing";

const SCHEDULE_STATUS_KEY = ["scheduler_status"] as const;
const RECORDINGS_LIST_KEY = ["recordings", "list"] as const;

/**
 * The application root. Confirms the Tauri bridge (`app_info`), hydrates i18n
 * from the persisted `Settings`, shows the first-run onboarding wizard, and
 * mounts the real shell (`MainLayout`) with every feature panel wired to a
 * view — replacing the Phase-0 `<details>` stack. Every panel that existed
 * before remains reachable; the shell sidebar is the new entry point.
 */
function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

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

  // The view→component map, organised after the original Electron layout: the
  // five everyday pages live in the sidebar; the rest are embedded where they
  // belong (Tidsplan folds in wake-from-sleep, Rediger folds in transcription,
  // and the Settings hub's tabs absorb publish/cloud/email/update/integrations/
  // diagnostics). The standalone entries remain so the ⌘K palette and the home
  // cards (history/review) can still reach them.
  const views: Record<ViewName, React.ReactNode> = {
    home: <HomePageView />,
    // Tidsplan = month calendar + weekly slots + a collapsible "Vekk maskin
    // fra dvale" panel, exactly as the old app grouped them.
    schedule: (
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <SchedulePage />
        <details className="rounded-xl border border-border bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text">
            {t("wake.title", "Vekk maskin fra dvale")}
          </summary>
          <div className="border-t border-border p-4">
            <WakePanel />
          </div>
        </details>
      </div>
    ),
    history: <HistoryPanel />,
    review: <ReviewPanel />,
    search: <SearchPage />,
    // Rediger = the editor with transcription as a section below it.
    editor: (
      <div className="flex w-full max-w-4xl flex-col gap-6">
        <EditorPanel />
        <TranscribePanel />
      </div>
    ),
    transcribe: <TranscribePanel />,
    publish: <PublishPanel />,
    streaming: <StreamingPanel />,
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
    settings: <SettingsPage />,
    update: <UpdatePanel />,
  };

  return (
    <ToastHost>
      <OnboardingFlow />
      <MainLayout
        views={views}
        onTransition={runEffects}
        header={<LanguageSwitcher />}
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
    <div className="flex flex-col gap-0.5 text-[11px] text-text3">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            next ? "bg-accent" : "bg-emerald-500"
          }`}
        />
        <span className="truncate" title={nextLabel}>
          {nextLabel}
        </span>
      </span>
      {info?.version && <span>v{info.version}</span>}
    </div>
  );
}

/** The home view, wired so its cards can drive the shell navigation. */
function HomePageView() {
  // HomePage navigation is delegated to the layout via a custom event so the
  // home cards (review/history/schedule) can switch views without threading a
  // callback through MainLayout's view map.
  const navigate = useCallback((view: ViewName) => {
    window.dispatchEvent(
      new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: view }),
    );
  }, []);
  return <HomePage onNavigate={navigate} />;
}

export default App;
