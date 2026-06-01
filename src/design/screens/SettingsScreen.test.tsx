/**
 * Tests for the redesigned `SettingsScreen` — the 7-tab settings hub.
 *
 * The Tauri IPC bridge is stubbed (no backend in jsdom). `settings_get`
 * returns the real `DEFAULT_SETTINGS` fixture so every control reflects a
 * complete, type-safe `Settings` value; `settings_save` echoes the settings
 * back so the optimistic-then-canonical cache update works. We assert the
 * page chrome, tab switching, and — the key behaviour — that toggling a mapped
 * control persists via `invoke("settings_save", …)`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { act } from "@testing-library/react";

import { invoke } from "@tauri-apps/api/core";
import { SettingsScreen } from "./SettingsScreen";
import { setPendingSettingsTab } from "./settingsTab";
import { DEFAULT_SETTINGS } from "./settings.helpers";
import type { Settings } from "@/lib/bindings/Settings";
import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";
import i18n from "@/i18n";

// Mock the Tauri IPC bridge. `settings_get` hands back the real default
// `Settings` so the screen renders against a full, valid object; `settings_save`
// echoes the passed settings so the mutation's `onSuccess` cache write works.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(
    async (cmd: string, args?: Record<string, unknown>): Promise<unknown> => {
      if (cmd === "settings_get") return DEFAULT_SETTINGS;
      if (cmd === "settings_save") return (args?.settings as Settings) ?? null;
      if (cmd === "list_devices") return { video_inputs: [] };
      // The Sunday-suite tab reads/writes the opt-in integrations bag. Start
      // disabled; `integrations_set_settings` echoes a merged bag so the
      // optimistic→canonical toggle update works.
      if (cmd === "integrations_get_settings") return { enabled: false };
      if (cmd === "integrations_set_settings")
        return {
          enabled: false,
          ...((args?.patch as Record<string, unknown>) ?? {}),
        };
      if (cmd === "plan_recording_opts")
        return {
          audio_device_name: "",
          video_device_name: null,
          output_path: "/x/Gudstjeneste_2026.wav",
          stop_on_silence: false,
          silence_threshold_db: null,
          silence_timeout_minutes: 0,
          framerate: 0,
          channel_mode: "stereo",
          sample_rate: 48000,
          bitrate_kbps: 192,
          split_minutes: 0,
          manual_max_minutes: 0,
          live_levels: true,
          keep_separate_audio: false,
          separate_audio_format: "wav",
        } satisfies RecordingOpts;
      return null;
    },
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockClear();
  i18n.changeLanguage("no");
});

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SettingsScreen />
    </QueryClientProvider>,
  );
}

describe("SettingsScreen", () => {
  it("renders the page title, all 7 tabs, and the default Lydkilde content", async () => {
    renderSettings();

    // Page title.
    expect(screen.getByText("Innstillinger")).toBeInTheDocument();

    // All seven tab labels.
    for (const label of [
      "Lydkilde",
      "Video",
      "Filer",
      "Publisering",
      "Varsler",
      "System",
      "Sunday-suite",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }

    // The default tab (Lydkilde) content is shown — the "Kanaler" card.
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );
  });

  it("switches to the System tab and shows its content", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );

    // Click the System tab.
    fireEvent.click(screen.getByText("System"));

    // System-tab content appears...
    await waitFor(() => {
      expect(screen.getByText("Kirkeprofil")).toBeInTheDocument();
      expect(screen.getByText("Språk")).toBeInTheDocument();
    });

    // ...and the Lydkilde-only "Kanaler" card is gone.
    expect(screen.queryByText("Kanaler")).not.toBeInTheDocument();
  });

  it("persists a control change via settings_save (channel SegOpt on Lydkilde)", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );

    // The default channel is "stereo"; selecting the "Mono" option in the
    // Kanaler segmented control runs `update({ channels: "monoMix" })`, which
    // persists through the save mutation.
    fireEvent.click(screen.getByText("Mono"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "settings_save",
        expect.objectContaining({
          settings: expect.objectContaining({ channels: "monoMix" }),
        }),
      ),
    );
  });

  it("persists a Sunday-suite integration toggle via integrations_set_settings", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );

    // Open the Sunday-suite tab.
    fireEvent.click(screen.getByText("Sunday-suite"));
    await waitFor(() =>
      expect(screen.getByText("Integrasjoner")).toBeInTheDocument(),
    );

    // Flip the master "Aktiver Sunday-suite-integrasjoner" toggle — it must
    // patch the integrations bag with `{ enabled: true }`.
    const masterRow = screen
      .getByText("Aktiver Sunday-suite-integrasjoner")
      .closest(".sr-srow") as HTMLElement;
    fireEvent.click(masterRow.querySelector('[role="switch"]') as HTMLElement);

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "integrations_set_settings",
        expect.objectContaining({
          patch: expect.objectContaining({ enabled: true }),
        }),
      ),
    );
  });

  it("opens the deep-linked tab from a pending tab on mount (WS-6)", async () => {
    // Simulate a deep-link: a navigation set the pending tab before mount.
    setPendingSettingsTab("filer");
    renderSettings();

    // The Filer tab is shown immediately (its "Lagringsmappe" card), and the
    // default Lydkilde "Kanaler" card is NOT.
    await waitFor(() =>
      expect(screen.getByText("Lagringsmappe")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Kanaler")).not.toBeInTheDocument();
  });

  it("switches tabs when a shell:navigate event carries a tab (WS-6)", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );

    // A live deep-link (screen already mounted) switches to the Video tab.
    act(() => {
      window.dispatchEvent(
        new CustomEvent("shell:navigate", {
          detail: { view: "settings", tab: "video" },
        }),
      );
    });

    await waitFor(() =>
      expect(screen.getByText("Aktiver videoopptak")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Kanaler")).not.toBeInTheDocument();
  });

  it("previews the planned filename on the Filer tab via plan_recording_opts", async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText("Kanaler")).toBeInTheDocument(),
    );

    // Open the Filer tab — it mounts <FilenamePreview/>.
    fireEvent.click(screen.getByText("Filer"));

    // The preview label appears and the planned filename basename is shown.
    await waitFor(() =>
      expect(screen.getByText("Forhåndsvisning")).toBeInTheDocument(),
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "plan_recording_opts",
        expect.anything(),
      );
      expect(screen.getByText("Gudstjeneste_2026.wav")).toBeInTheDocument();
    });
  });
});
