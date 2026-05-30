import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import i18n from "@/i18n";
import { DevicePicker } from "./DevicePicker";
import type { AudioDeviceList } from "@/lib/bindings/AudioDeviceList";
import type { DeviceInventory } from "@/lib/bindings/DeviceInventory";
import type { Settings } from "@/lib/bindings/Settings";
import type { VuLevels } from "@/lib/bindings/VuLevels";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";

// --- Tauri bridge mocks -----------------------------------------------------

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  vuHandler: null as ((event: { payload: VuLevels }) => void) | null,
  previewHandler: null as ((event: { payload: PreviewFrame }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === "vu://levels")
      h.vuHandler = handler as (e: { payload: VuLevels }) => void;
    if (name === "preview://frame")
      h.previewHandler = handler as (e: { payload: PreviewFrame }) => void;
    return Promise.resolve(() => {
      if (name === "vu://levels") h.vuHandler = null;
      if (name === "preview://frame") h.previewHandler = null;
    });
  },
}));

const invoke = h.invoke;

const CPAL_INPUTS: AudioDeviceList = {
  host: "CoreAudio",
  inputs: [
    {
      name: "Built-in Microphone",
      direction: "input",
      channels: 1,
      sample_rates: [48_000],
      is_default: true,
    },
    {
      name: "Soundcraft Signature 12",
      direction: "input",
      channels: 2,
      sample_rates: [44_100, 48_000],
      is_default: false,
    },
  ],
};

const INVENTORY: DeviceInventory = {
  audio_inputs: [
    { name: "Soundcraft Signature 12", format: "avfoundation", index: 1 },
  ],
  video_inputs: [
    { name: "FaceTime HD Camera", format: "avfoundation", index: 0 },
    { name: "Logitech BRIO", format: "avfoundation", index: 1 },
  ],
};

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  // Only the fields DevicePicker reads/writes matter for these tests; the rest
  // are filled with harmless defaults to satisfy the type.
  return {
    language: null,
    hasLaunched: false,
    onboardingDone: false,
    deviceId: null,
    deviceName: null,
    videoEnabled: false,
    videoDeviceName: null,
    videoDeviceIndex: null,
    channels: "stereo",
    sampleRate: 48_000,
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
    autoUpdate: true,
    askOpenEditor: true,
    ...overrides,
  } as Settings;
}

/** Renders with a fresh QueryClient so each test has isolated caches. */
function renderPicker() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DevicePicker />
    </QueryClientProvider>,
  );
}

let storedSettings: Settings;

beforeEach(async () => {
  // i18next is a process-wide singleton; another test file may have switched the
  // language. Reset to Norwegian so the rendered strings are deterministic.
  await i18n.changeLanguage("no");
  invoke.mockReset();
  h.vuHandler = null;
  h.previewHandler = null;
  storedSettings = makeSettings();
  invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "list_input_devices":
        return Promise.resolve(CPAL_INPUTS);
      case "list_devices":
        return Promise.resolve(INVENTORY);
      case "settings_get":
        return Promise.resolve(storedSettings);
      case "settings_save":
        storedSettings = (args as { settings: Settings }).settings;
        return Promise.resolve(storedSettings);
      case "start_vu":
      case "stop_vu":
      case "start_preview":
      case "stop_preview":
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
});

describe("DevicePicker", () => {
  it("loads cpal mics and ffmpeg cameras into their dropdowns", async () => {
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText("CoreAudio")).toBeInTheDocument(),
    );
    // Mic options (cpal).
    expect(
      screen.getByRole("option", { name: /Built-in Microphone/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Soundcraft Signature 12/ }),
    ).toBeInTheDocument();
    // Cameras only render once video is enabled — not yet in the DOM.
    expect(
      screen.queryByRole("option", { name: "Logitech BRIO" }),
    ).not.toBeInTheDocument();
  });

  it("persists a mic choice and starts the VU with it", async () => {
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText("CoreAudio")).toBeInTheDocument(),
    );

    // Choose a mic → settings_save with deviceName.
    fireEvent.change(screen.getByLabelText("Tilgjengelige enheter"), {
      target: { value: "Soundcraft Signature 12" },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "settings_save",
        expect.objectContaining({
          settings: expect.objectContaining({
            deviceName: "Soundcraft Signature 12",
          }),
        }),
      ),
    );

    // Start VU drives the selected device.
    fireEvent.click(screen.getByRole("button", { name: "Test lyd" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_vu", {
        deviceName: "Soundcraft Signature 12",
      }),
    );

    // A loud peak fills the meter.
    h.vuHandler?.({ payload: { peak_dbfs: [-1], rms_dbfs: [-4] } });
    await waitFor(() => {
      const meter = screen.getByRole("meter");
      expect(Number(meter.getAttribute("aria-valuenow"))).toBeGreaterThan(90);
    });
  });

  it("toggles video on, persists camera choice, and starts the preview with the avfoundation index", async () => {
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText("CoreAudio")).toBeInTheDocument(),
    );

    // Enable video → settings_save videoEnabled, and the camera select appears.
    fireEvent.click(screen.getByLabelText("Video på"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "settings_save",
        expect.objectContaining({
          settings: expect.objectContaining({ videoEnabled: true }),
        }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("option", { name: "Logitech BRIO" }),
      ).toBeInTheDocument(),
    );

    // Choose the BRIO (index 1) → persists name + index.
    fireEvent.change(screen.getByLabelText("VELG KAMERA"), {
      target: { value: "Logitech BRIO" },
    });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "settings_save",
        expect.objectContaining({
          settings: expect.objectContaining({
            videoDeviceName: "Logitech BRIO",
            videoDeviceIndex: 1,
          }),
        }),
      ),
    );

    // Start preview addresses the camera by its avfoundation index ("1").
    fireEvent.click(screen.getByRole("button", { name: "🔄 Oppdater" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        device: "1",
        fps: null,
      }),
    );

    // A frame paints into the <img>.
    h.previewHandler?.({
      payload: { data: "AAAA", width: 1280, height: 720, seq: 1 },
    });
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "Kamera" })).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,AAAA",
      ),
    );
  });

  it("handles an empty device inventory gracefully", async () => {
    invoke.mockImplementation((cmd: string) => {
      switch (cmd) {
        case "list_input_devices":
          return Promise.resolve({ host: "CoreAudio", inputs: [] });
        case "list_devices":
          return Promise.resolve({ audio_inputs: [], video_inputs: [] });
        case "settings_get":
          return Promise.resolve(makeSettings({ videoEnabled: true }));
        case "settings_save":
          return Promise.resolve(makeSettings({ videoEnabled: true }));
        default:
          return Promise.resolve(null);
      }
    });
    renderPicker();
    await waitFor(() =>
      expect(screen.getByText("CoreAudio")).toBeInTheDocument(),
    );
    // No cameras → the empty-state hint renders (from `home.cameraNoResponse`).
    await waitFor(() =>
      expect(
        screen.getByText("Kamera svarte ikke — prøv å oppdatere"),
      ).toBeInTheDocument(),
    );
    // The mic dropdown still has just the default option (no crash).
    expect(screen.getByText("Innebygd mikrofon")).toBeInTheDocument();
  });
});
