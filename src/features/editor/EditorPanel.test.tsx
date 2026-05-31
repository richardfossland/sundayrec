import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EditorPanel } from "./EditorPanel";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorMediaInfo } from "@/lib/bindings/EditorMediaInfo";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import type { EditorLoudness } from "@/lib/bindings/EditorLoudness";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
const invoke = h.invoke;

const RECORDINGS: RecordingRow[] = [
  {
    id: "r1",
    file_path: "/rec/2026-05-31.mp4",
    device_name: null,
    started_at: 1_700_000_000_000,
    duration_ms: 3_600_000,
    byte_size: 1024,
    created_at: 1_700_000_000_000,
    note: null,
  },
];

const INFO: EditorMediaInfo = {
  durationSec: 3600,
  hasVideo: true,
  hasAudio: true,
  channels: 2,
  sampleFmt: "fltp",
};

const SEGMENTS: EditorSegment[] = [
  { start: 0, end: 200, duration: 200, label: "Musikk", kind: "music" },
  { start: 200, end: 1400, duration: 1200, label: "Preken", kind: "sermon" },
];

const LOUDNESS: EditorLoudness = {
  inputI: -23.4,
  inputLra: 9.4,
  inputTp: -3.1,
  targetLufs: -16,
};

/** Route invoke() by command name. Pass a per-test override map of factories
 *  (called lazily on invoke) so rejections aren't created until consumed. */
function routeInvoke(over: Record<string, () => unknown> = {}) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd in over) return over[cmd]!();
    switch (cmd) {
      case "recordings_list":
        return Promise.resolve(RECORDINGS);
      case "editor_load_recording":
        return Promise.resolve(INFO);
      case "editor_peaks":
        return Promise.resolve({ peaks: [0.1, 0.9, 0.4], sampleRate: 8000 });
      case "editor_segments":
        return Promise.resolve(SEGMENTS);
      case "editor_mastering_analyze":
        return Promise.resolve(LOUDNESS);
      case "editor_export":
        return Promise.resolve({ outputPath: "/rec/2026-05-31_redigert.mp3" });
      default:
        return Promise.resolve(undefined);
    }
  });
}

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EditorPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  routeInvoke();
  i18n.changeLanguage("no");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditorPanel", () => {
  it("lists recordings from history", async () => {
    renderPanel();
    expect(await screen.findByText("2026-05-31.mp4")).toBeInTheDocument();
  });

  it("loads a recording (ffprobe) on pick and shows duration", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/rec/2026-05-31.mp4",
      }),
    );
    expect(await screen.findByText(/3600\.0s/)).toBeInTheDocument();
  });

  it("requests peaks over IPC", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    fireEvent.click(await screen.findByText("Bølgeform"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_peaks", {
        inputPath: "/rec/2026-05-31.mp4",
      }),
    );
    // 3 peak points reported back.
    expect(await screen.findByText(/3 bølgeform-punkter/)).toBeInTheDocument();
  });

  it("detects segments and highlights the sermon block", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    fireEvent.click(await screen.findByText("Finn segmenter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_segments", {
        inputPath: "/rec/2026-05-31.mp4",
      }),
    );
    expect(await screen.findByText(/Preken/)).toBeInTheDocument();
  });

  it("measures loudness against a preset", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    fireEvent.click(await screen.findByText("Mål lydstyrke"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_mastering_analyze", {
        inputPath: "/rec/2026-05-31.mp4",
        presetId: "speech-clear",
      }),
    );
    expect(await screen.findByText(/-23\.4 LUFS/)).toBeInTheDocument();
  });

  it("exports with the chosen format + preset over IPC", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    // Wait for the load probe so duration is populated in the request.
    await screen.findByText(/3600\.0s/);
    fireEvent.click(screen.getByText("Eksporter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_export", {
        request: expect.objectContaining({
          inputPath: "/rec/2026-05-31.mp4",
          format: "mp3",
          duration: 3600,
          masterPreset: null,
          outputFolder: "/rec",
        }),
      }),
    );
    expect(
      await screen.findByText(/2026-05-31_redigert\.mp3/),
    ).toBeInTheDocument();
  });

  it("shows a calm hint when the editor feature is disabled", async () => {
    routeInvoke({
      editor_load_recording: () =>
        Promise.reject({
          code: "validation",
          message:
            "feature_disabled: editor.load requires a build with `--features editor`",
        }),
    });
    renderPanel();
    fireEvent.click(await screen.findByText("2026-05-31.mp4"));
    expect(
      await screen.findByText(
        "Redigering er ikke bygget inn i denne versjonen.",
      ),
    ).toBeInTheDocument();
  });
});
