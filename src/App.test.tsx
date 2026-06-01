import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import type { AppInfo } from "@/lib/bindings/AppInfo";

// Mock the Tauri IPC bridge — there's no backend in the jsdom test runner.
// App now also renders <VuMeter/>, which calls `list_input_devices` and
// subscribes to the `vu://levels` event, so both APIs are stubbed here.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === "list_input_devices") return { host: "CoreAudio", inputs: [] };
    if (cmd === "ffmpeg_health")
      return {
        available: true,
        version: "ffmpeg version 6.0",
        path: "/x/ffmpeg",
      };
    if (cmd === "recordings_list") return [];
    // PU-5: App mounts <TranscribePanel/>, which reads the model registry.
    if (cmd === "whisper_list_models") return [];
    // PU-1: App mounts <EmailSettingsPanel/>, which reads the email status.
    if (cmd === "email_status")
      return { featureBuilt: false, gmailConnected: false };
    // PU-6: App mounts <ReviewPanel/>, which reads the prep/review queue.
    if (cmd === "review_queue_list") return [];
    // Integrations: App mounts <IntegrationsPanel/>, which reads the bridge
    // feature flag + the persisted connection settings blob.
    if (cmd === "live_bridge_status") return false;
    if (cmd === "setting_get") return null;
    // P2b: App also mounts <SuiteHandoffPanel/>, which reads the Song API-key
    // presence on mount.
    if (cmd === "integrations_song_has_apikey") return false;
    // PU-3: App mounts <PublishPanel/>, which reads the publish feature status.
    if (cmd === "publish_feed_status")
      return { featureBuilt: false, episodeCount: 0 };
    // Fase 6: App mounts <CloudBackupPanel/>, which reads connection + queue.
    if (cmd === "cloud_connection_status") return [];
    if (cmd === "cloud_queue_status") return [];
    // F5.1/P5: App mounts the home + schedule views, which read settings +
    // schedule status. `onboardingDone` is set so the first-run wizard does
    // not block the shell in these tests.
    if (cmd === "settings_get")
      return { slots: [], specialRecordings: [], onboardingDone: true };
    if (cmd === "settings_save")
      return { slots: [], specialRecordings: [], onboardingDone: true };
    if (cmd === "scheduler_status") return { next: null, upcoming: [] };
    // F5.2: App mounts <WakePanel/>, which reads capabilities + sleep config.
    if (cmd === "wake_capabilities")
      return {
        platform: "mac-arm",
        canWakeFromSleep: true,
        canWakeFromOff: false,
        needsAdmin: true,
        knownIssues: [],
        recommendations: [],
      };
    if (cmd === "wake_get_sleep_config")
      return {
        autopoweroff: null,
        autopoweroffDelay: null,
        standby: null,
        standbyDelay: null,
        hibernateMode: null,
        wakeTimersEnabled: null,
        error: null,
      };
    return {
      name: "SundayRec",
      version: "0.1.0",
      tauri_version: "2.0.0",
      platform: "macos",
      arch: "aarch64",
      greeting: "Hello SundayRec — backend connected.",
    } satisfies AppInfo;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("mounts the shell with the SundayRec sidebar once app_info resolves", async () => {
    renderApp();
    // The shell sidebar carries the app name + a home nav button.
    await waitFor(() =>
      expect(
        document.querySelector('button[data-view="home"]'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("SundayRec")).toBeInTheDocument();
  });

  it("shows the flat Electron-style sidebar (5 pages + settings gear)", async () => {
    renderApp();
    await waitFor(() =>
      expect(
        document.querySelector('button[data-view="home"]'),
      ).toBeInTheDocument(),
    );
    // The everyday pages + the settings gear are the only sidebar buttons.
    for (const view of [
      "home",
      "schedule",
      "streaming",
      "editor",
      "search",
      "settings",
    ]) {
      expect(
        document.querySelector(`button[data-view="${view}"]`),
      ).toBeInTheDocument();
    }
    // The rest are embedded in the settings hub / contextual cards, not the
    // flat sidebar.
    for (const view of ["cloud", "email", "publish", "diagnostics", "update"]) {
      expect(
        document.querySelector(`button[data-view="${view}"]`),
      ).not.toBeInTheDocument();
    }
  });
});
