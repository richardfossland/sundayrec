import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SettingsPage } from "./SettingsPage";
import type { Settings } from "@/lib/bindings/Settings";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
  // Settings now embeds panels (DevicePicker) that build media src URLs.
  convertFileSrc: (p: string) => p,
}));

// The embedded panels (DevicePicker, EmailSettingsPanel, …) subscribe to Tauri
// events on mount; stub the event API so `listen` resolves to a no-op unlisten
// instead of hitting the (absent) IPC bridge.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Some embedded panels use the dialog/clipboard plugins; stub them too.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(() => Promise.resolve(null)),
  save: vi.fn(() => Promise.resolve(null)),
}));

const invoke = h.invoke;

/** A full default-ish Settings the mocked `settings_get` returns. */
const DEFAULTS: Settings = {
  language: "no",
  hasLaunched: false,
  onboardingDone: false,
  deviceId: null,
  deviceName: null,
  videoEnabled: false,
  videoDeviceName: null,
  videoDeviceIndex: null,
  videoResolution: "720p",
  videoFramerate: 30,
  outputMode: "combined",
  keepSeparateAudio: false,
  avSync: true,
  channels: "stereo",
  sampleRate: 48000,
  inputVolume: 100,
  eqEnabled: false,
  eqBass: 0,
  eqMid: 0,
  eqTreble: 0,
  compEnabled: false,
  compThreshold: -24,
  compRatio: 4,
  compAttack: 10,
  compRelease: 200,
  limiterEnabled: true,
  limiterCeiling: -1,
  format: "mp3",
  bitrate: "192",
  filenamePattern: "date",
  saveFolder: null,
  autoDeleteDays: 0,
  stopOnSilence: false,
  silenceThreshold: -50,
  silenceTimeoutMinutes: 5,
  splitMinutes: 0,
  trimSilence: false,
  manualMaxMinutes: 0,
  preRollSeconds: 0,
  reminderMinutes: 0,
  launchAtLogin: false,
  showOnStartup: false,
  minimizeToTray: true,
  wakeFromSleep: true,
  protectRecording: true,
  slots: [],
  specialRecordings: [],
  churchName: "",
  responsiblePerson: "",
  notifyStart: true,
  notifyStop: true,
  webhookUrl: "",
  webhookOnWarning: false,
  emailOnError: false,
  emailAddress: "",
  emailSmtp: "",
  emailSmtpPort: 587,
  emailSmtpUser: "",
  editorIntroPath: null,
  editorOutroPath: null,
  autoUpdate: true,
  askOpenEditor: true,
};

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  // i18next is a process-wide singleton; another test file may have left it in
  // a non-Norwegian language. Pin it to Norwegian so the label assertions below
  // (which use the `no` catalog strings) are deterministic regardless of order.
  await i18n.changeLanguage("no");
  invoke.mockReset();
  // Default behaviour: get returns DEFAULTS; save echoes back the input
  // (the real backend validates+returns); reset returns DEFAULTS.
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "settings_get":
        return Promise.resolve(DEFAULTS);
      case "settings_save":
        return Promise.resolve((args?.settings as Settings) ?? DEFAULTS);
      case "settings_reset":
        return Promise.resolve(DEFAULTS);
      case "list_devices":
        return Promise.resolve({ audio_inputs: [], video_inputs: [] });
      // Settings is now a hub: the active tab also mounts feature panels, which
      // fire their own queries. Stub them so they render their empty states.
      case "list_input_devices":
        return Promise.resolve({ host: "CoreAudio", inputs: [] });
      case "ffmpeg_health":
        return Promise.resolve({ available: true, version: "ffmpeg 6.0", path: "" });
      case "email_status":
        return Promise.resolve({ featureBuilt: false, gmailConnected: false });
      case "update_status":
        return Promise.resolve(null);
      case "publish_feed_status":
        return Promise.resolve({ featureBuilt: false, episodeCount: 0 });
      case "cloud_connection_status":
        return Promise.resolve([]);
      case "cloud_queue_status":
        return Promise.resolve([]);
      case "live_bridge_status":
        return Promise.resolve(false);
      case "setting_get":
        return Promise.resolve(null);
      case "integrations_song_has_apikey":
        return Promise.resolve(false);
      default:
        return Promise.resolve(undefined);
    }
  });
});

afterEach(async () => {
  await i18n.changeLanguage("no");
});

describe("SettingsPage", () => {
  it("loads and renders the persisted settings", async () => {
    renderPage();
    // Lydkilde is the default tab — INNGANGSVOLUM is visible immediately.
    await waitFor(() =>
      expect(
        (screen.getByLabelText("INNGANGSVOLUM") as HTMLInputElement).value,
      ).toBe("100"),
    );
    // Switch to the Alt tab to verify FILFORMAT loaded correctly.
    fireEvent.click(screen.getByRole("button", { name: "Filer" }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("FILFORMAT") as HTMLSelectElement).value,
      ).toBe("mp3"),
    );
  });

  it("debounce-saves an edited field with the updated value", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      // Flush the initial query + draft seeding under fake timers.
      await vi.waitFor(() =>
        expect(
          (screen.getByLabelText("INNGANGSVOLUM") as HTMLInputElement).value,
        ).toBe("100"),
      );

      fireEvent.change(screen.getByLabelText("INNGANGSVOLUM"), {
        target: { value: "150" },
      });

      // Not saved until the debounce elapses.
      expect(invoke).not.toHaveBeenCalledWith(
        "settings_save",
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(600);

      expect(invoke).toHaveBeenCalledWith("settings_save", {
        settings: expect.objectContaining({ inputVolume: 150 }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes the file format and saves it", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      // Navigate to the Alt tab where FILFORMAT lives.
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: "Filer" })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Filer" }));
      await vi.waitFor(() =>
        expect(
          (screen.getByLabelText("FILFORMAT") as HTMLSelectElement).value,
        ).toBe("mp3"),
      );

      fireEvent.change(screen.getByLabelText("FILFORMAT"), {
        target: { value: "wav" },
      });
      await vi.advanceTimersByTimeAsync(600);

      expect(invoke).toHaveBeenCalledWith("settings_save", {
        settings: expect.objectContaining({ format: "wav" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset calls settings_reset", async () => {
    renderPage();
    // Gjenopprett standard is in the System tab.
    await screen.findByRole("button", { name: "System" });
    fireEvent.click(screen.getByRole("button", { name: "System" }));
    const resetBtn = await screen.findByRole("button", {
      name: "Gjenopprett standard",
    });
    fireEvent.click(resetBtn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("settings_reset"));
  });

  it("language change switches i18n and persists to settings.language", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      await vi.waitFor(() =>
        expect(screen.getByLabelText("Språk")).toBeInTheDocument(),
      );

      fireEvent.change(screen.getByLabelText("Språk"), {
        target: { value: "en" },
      });

      // i18n switched immediately (changeLanguage is async — let it settle).
      await vi.waitFor(() => expect(i18n.language).toBe("en"));

      await vi.advanceTimersByTimeAsync(600);
      expect(invoke).toHaveBeenCalledWith("settings_save", {
        settings: expect.objectContaining({ language: "en" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounce-saves the R7 church-profile field", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      // Menighetsnavn is in the System tab.
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: "System" })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "System" }));
      await vi.waitFor(() =>
        expect(screen.getByLabelText("Menighetsnavn")).toBeInTheDocument(),
      );

      fireEvent.change(screen.getByLabelText("Menighetsnavn"), {
        target: { value: "Domkirken" },
      });
      await vi.advanceTimersByTimeAsync(600);

      expect(invoke).toHaveBeenCalledWith("settings_save", {
        settings: expect.objectContaining({ churchName: "Domkirken" }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("debounce-saves the R7 email-on-error toggle", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      // Send e-post ved feil is in the Notater tab.
      await vi.waitFor(() =>
        expect(screen.getByRole("button", { name: "Varsler" })).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Varsler" }));
      await vi.waitFor(() =>
        expect(
          screen.getByLabelText("Send e-post ved feil"),
        ).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByLabelText("Send e-post ved feil"));
      await vi.advanceTimersByTimeAsync(600);

      expect(invoke).toHaveBeenCalledWith("settings_save", {
        settings: expect.objectContaining({ emailOnError: true }),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
