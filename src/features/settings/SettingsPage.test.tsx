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
  channels: "stereo",
  sampleRate: 48000,
  inputVolume: 100,
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
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
});

afterEach(async () => {
  await i18n.changeLanguage("no");
});

describe("SettingsPage", () => {
  it("loads and renders the persisted settings", async () => {
    renderPage();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("FILFORMAT") as HTMLSelectElement).value,
      ).toBe("mp3"),
    );
    expect(
      (screen.getByLabelText("INNGANGSVOLUM") as HTMLInputElement).value,
    ).toBe("100");
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
});
