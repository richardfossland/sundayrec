import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SchedulePage } from "./SchedulePage";
import type { Settings } from "@/lib/bindings/Settings";
import type { ScheduleStatus } from "@/lib/bindings/ScheduleStatus";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));

const invoke = h.invoke;

const BASE_SETTINGS: Settings = {
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
  slots: [{ days: [6], start: "11:00", stop: "12:00", max: null }],
  specialRecordings: [],
  autoUpdate: true,
  askOpenEditor: true,
};

const STATUS: ScheduleStatus = {
  next: "2026-06-07T11:00:00",
  upcoming: ["2026-06-07T11:00:00", "2026-06-14T11:00:00"],
};

function mockBridge(settings: Settings = BASE_SETTINGS) {
  invoke.mockImplementation((cmd: string, args?: unknown) => {
    switch (cmd) {
      case "settings_get":
        return Promise.resolve(settings);
      case "scheduler_status":
        return Promise.resolve(STATUS);
      case "settings_save":
        return Promise.resolve((args as { settings: Settings }).settings);
      case "scheduler_reschedule":
        return Promise.resolve(STATUS);
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SchedulePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  mockBridge();
});

describe("SchedulePage", () => {
  it("renders the next recording and the existing weekly slot", async () => {
    renderPage();
    // Next-recording line is populated from scheduler_status.
    await waitFor(() => {
      expect(screen.getByTestId("next-recording").textContent).not.toBe("");
    });
    // The single seeded slot shows up with the Sunday button pressed.
    await waitFor(() => {
      expect(screen.getByTestId("slot-0")).toBeTruthy();
    });
    const slot = screen.getByTestId("slot-0");
    const sun = slot.querySelector('[aria-pressed="true"]');
    expect(sun?.textContent).toBe("Sø");
  });

  it("adds a weekly slot and persists + reschedules", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("slot-0")).toBeTruthy());

    // Two "Legg til" buttons (weekly + special); the first is the weekly one.
    fireEvent.click(screen.getAllByText("Legg til")[0]);

    // A second slot row appears.
    await waitFor(() => expect(screen.getByTestId("slot-1")).toBeTruthy());

    // The save flow calls settings_save then scheduler_reschedule.
    await waitFor(() => {
      const saved = invoke.mock.calls.find((c) => c[0] === "settings_save");
      expect(saved).toBeTruthy();
      const savedSettings = (saved![1] as { settings: Settings }).settings;
      expect(savedSettings.slots.length).toBe(2);
    });
    await waitFor(() => {
      expect(
        invoke.mock.calls.some((c) => c[0] === "scheduler_reschedule"),
      ).toBe(true);
    });
  });

  it("toggles a weekday off and saves the reduced day set", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId("slot-0")).toBeTruthy());

    const slot = screen.getByTestId("slot-0");
    const sun = slot.querySelector(
      '[aria-pressed="true"]',
    ) as HTMLButtonElement;
    fireEvent.click(sun); // turn Sunday off → empty day set

    await waitFor(() => {
      const saved = [...invoke.mock.calls]
        .reverse()
        .find((c) => c[0] === "settings_save");
      expect(saved).toBeTruthy();
      const savedSettings = (saved![1] as { settings: Settings }).settings;
      expect(savedSettings.slots[0].days).toEqual([]);
    });
  });
});
