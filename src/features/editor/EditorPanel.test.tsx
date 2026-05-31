import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EditorPanel } from "./EditorPanel";
import { waveformPath } from "./waveform";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { EditorMediaInfo } from "@/lib/bindings/EditorMediaInfo";
import type { EditorSegment } from "@/lib/bindings/EditorSegment";
import type { EditorLoudness } from "@/lib/bindings/EditorLoudness";
import i18n from "@/i18n";

// --- Tauri bridge mocks -----------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => h.open(...args),
}));
const invoke = h.invoke;
const openDialog = h.open;

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
      case "editor_read_sidecar":
        // No draft by default — tests that need one override this.
        return Promise.resolve(null);
      case "editor_write_sidecar":
      case "editor_delete_sidecar":
        return Promise.resolve(true);
      case "editor_master_preview":
        return Promise.resolve({ previewPath: "/tmp/preview.mp3" });
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

/** Pick the first history recording and wait for its load probe to resolve. */
async function pickAndLoad() {
  fireEvent.click(await screen.findByText("2026-05-31.mp4"));
  await screen.findByText(/3600\.0s/);
}

beforeEach(() => {
  invoke.mockReset();
  openDialog.mockReset();
  routeInvoke();
  i18n.changeLanguage("no");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waveformPath", () => {
  it("returns an empty string for no peaks", () => {
    expect(waveformPath([], 100, 40)).toBe("");
  });

  it("maps peaks to a mirrored polygon spanning the width", () => {
    const pts = waveformPath([0, 1], 100, 40);
    // Two points → top edge L→R then bottom edge R→L (4 coord pairs).
    const coords = pts.split(" ");
    expect(coords).toHaveLength(4);
    // First top point at x=0, centre line (peak 0 → mid 20).
    expect(coords[0]).toBe("0.0,20.0");
    // Second top point at x=width, peak 1 → top edge (mid - mid = 0).
    expect(coords[1]).toBe("100.0,0.0");
  });
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

  it("auto-pulls peaks on pick and renders the waveform", async () => {
    renderPanel();
    await pickAndLoad();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_peaks", {
        inputPath: "/rec/2026-05-31.mp4",
      }),
    );
    // The waveform <svg> is rendered (role=img) and the count reported.
    expect(await screen.findByLabelText("Bølgeform")).toBeInTheDocument();
    expect(await screen.findByText(/3 bølgeform-punkter/)).toBeInTheDocument();
  });

  it("opens a file via the native dialog and loads it", async () => {
    openDialog.mockResolvedValue("/disk/sermon.wav");
    renderPanel();
    fireEvent.click(await screen.findByText("Åpne lydfil…"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/disk/sermon.wav",
      }),
    );
  });

  it("adds and removes cut regions", async () => {
    renderPanel();
    await pickAndLoad();
    // No regions yet → drag hint shown.
    expect(
      screen.getByText("Klikk og dra for å markere et kutt"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("Legg til kutt"));
    fireEvent.click(screen.getByText("Legg til kutt"));
    expect(screen.getAllByLabelText("Kutt")).toHaveLength(2);
    // Remove the first region.
    fireEvent.click(screen.getAllByLabelText("Fjern kutt")[0]!);
    expect(screen.getAllByLabelText("Kutt")).toHaveLength(1);
  });

  it("detects segments and highlights the sermon block", async () => {
    renderPanel();
    await pickAndLoad();
    fireEvent.click(screen.getByText("Finn segmenter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_segments", {
        inputPath: "/rec/2026-05-31.mp4",
      }),
    );
    expect(await screen.findByText(/Preken/)).toBeInTheDocument();
  });

  it("measures loudness against the default preset", async () => {
    renderPanel();
    await pickAndLoad();
    fireEvent.click(screen.getByText("Mål lydstyrke"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_mastering_analyze", {
        inputPath: "/rec/2026-05-31.mp4",
        presetId: "speech-clear",
      }),
    );
    expect(await screen.findByText(/-23\.4 LUFS/)).toBeInTheDocument();
  });

  it("exports with the chosen format, mastering target, and cut-plan", async () => {
    renderPanel();
    await pickAndLoad();
    // Pick the Podcast target → core preset id `speech-clear`.
    fireEvent.change(screen.getByLabelText("Mastering"), {
      target: { value: "speech-clear" },
    });
    // Add a cut region (seeded 0→10 against the 3600 s file).
    fireEvent.click(screen.getByText("Legg til kutt"));
    fireEvent.click(screen.getByText("Eksporter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_export", {
        request: expect.objectContaining({
          inputPath: "/rec/2026-05-31.mp4",
          format: "mp3",
          duration: 3600,
          masterPreset: "speech-clear",
          outputFolder: "/rec",
          cutRegions: [{ start: 0, end: 10 }],
        }),
      }),
    );
    expect(
      await screen.findByText(/2026-05-31_redigert\.mp3/),
    ).toBeInTheDocument();
  });

  it("exports with no mastering (target none) and no cuts by default", async () => {
    renderPanel();
    await pickAndLoad();
    fireEvent.click(screen.getByText("Eksporter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_export", {
        request: expect.objectContaining({
          masterPreset: null,
          cutRegions: [],
        }),
      }),
    );
  });

  it("autosaves the cut-plan to the cuts-draft sidecar after an edit", async () => {
    renderPanel();
    await pickAndLoad();
    fireEvent.click(screen.getByText("Legg til kutt"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_write_sidecar", {
        mediaPath: "/rec/2026-05-31.mp4",
        sidecar: "cutsDraft",
        value: expect.objectContaining({
          cuts: [{ start: 0, end: 10 }],
          ts: expect.any(Number),
        }),
      }),
    );
  });

  it("does not autosave a draft on a fresh untouched selection", async () => {
    renderPanel();
    await pickAndLoad();
    // No region edits yet → no write_sidecar should have fired.
    expect(invoke).not.toHaveBeenCalledWith(
      "editor_write_sidecar",
      expect.anything(),
    );
  });

  it("offers to restore a cuts-draft found on pick and restores it", async () => {
    routeInvoke({
      editor_read_sidecar: () =>
        Promise.resolve({
          cuts: [
            { start: 5, end: 12 },
            { start: 30, end: 44 },
          ],
          ts: 1_700_000_000_000,
        }),
    });
    renderPanel();
    await pickAndLoad();
    // Banner reports the count, restore brings the cuts back as editable rows.
    expect(await screen.findByText(/Fant lagrede kutt/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Gjenopprett"));
    expect(screen.getAllByLabelText("Kutt")).toHaveLength(2);
    // Banner is gone after restoring.
    expect(screen.queryByText(/Fant lagrede kutt/)).not.toBeInTheDocument();
  });

  it("deletes the cuts-draft after a successful export", async () => {
    renderPanel();
    await pickAndLoad();
    fireEvent.click(screen.getByText("Eksporter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_delete_sidecar", {
        mediaPath: "/rec/2026-05-31.mp4",
        sidecar: "cutsDraft",
      }),
    );
  });

  it("renders a mastering preview when a preset is chosen", async () => {
    renderPanel();
    await pickAndLoad();
    // No preset → no preview button.
    expect(screen.queryByText(/Forhåndsvis mastering/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mastering"), {
      target: { value: "speech-clear" },
    });
    fireEvent.click(screen.getByText(/Forhåndsvis mastering/));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_master_preview", {
        request: {
          inputPath: "/rec/2026-05-31.mp4",
          presetId: "speech-clear",
          startSec: 0,
          durationSec: 15,
        },
      }),
    );
    expect(await screen.findByLabelText("Forhåndsvisning")).toBeInTheDocument();
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
