import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EditScreen } from "./EditScreen";
import i18n from "@/i18n";

/**
 * Mock the Tauri IPC bridge. The editor screen probes a file (load/peaks/
 * segments), analyses mastering and exports — all behind `invoke`. We resolve
 * each command with a binding-shaped fixture (and `null` for anything else, so
 * an unexpected call cannot crash the screen). The `invoke` spy is what the
 * key trim→cutRegions assertion inspects.
 */
const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  switch (cmd) {
    case "recordings_list":
      return [];
    case "editor_load_recording":
      // EditorMediaInfo — hasVideo:true so the screen auto-picks the video
      // variant once a file is loaded.
      return {
        durationSec: 1934,
        hasVideo: true,
        hasAudio: true,
        channels: 2,
        sampleFmt: "s16",
      };
    case "editor_peaks":
      return { peaks: [0.1, 0.5, 0.9, 0.3], sampleRate: 8000 };
    case "editor_segments":
      return [];
    case "editor_mastering_analyze":
      return { inputI: -18, inputLra: 7, inputTp: -1, targetLufs: -16 };
    case "editor_export":
      return { outputPath: "/x/out.mp4" };
    case "editor_master_apply":
      return { outputPath: "/x/out_mastert.mp3" };
    case "editor_master_cancel":
      return true;
    case "editor_read_sidecar":
      // No persisted draft/meta in the test fixtures.
      return null;
    case "editor_write_sidecar":
      return true;
    case "editor_extract_frame":
      // PreviewFrame-shaped stub (a 1px base64 JPEG placeholder).
      return { data: "AAAA", width: 1, height: 1, seq: 1 };
    case "whisper_list_models":
      return [];
    default:
      return null;
  }
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  // The editor turns local paths into asset:// URLs for playback/frames; in the
  // test host just echo the path back.
  convertFileSrc: (p: string) => `asset://localhost/${p}`,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => "/x/sermon.mp4"),
  save: vi.fn(async () => "/x/out.srt"),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

beforeEach(() => {
  invoke.mockClear();
  i18n.changeLanguage("no");
});

function renderEdit() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <EditScreen />
    </QueryClientProvider>,
  );
}

/** Find the last `editor_export` request the screen sent to `invoke`. */
function lastExportRequest(): {
  cutRegions: Array<{ start: number; end: number }>;
  inputPath: string;
  duration: number;
} {
  const call = [...invoke.mock.calls]
    .reverse()
    .find((c) => c[0] === "editor_export");
  expect(call, "expected an editor_export invoke").toBeTruthy();
  return (call![1] as { request: unknown }).request as {
    cutRegions: Array<{ start: number; end: number }>;
    inputPath: string;
    duration: number;
  };
}

describe("EditScreen", () => {
  it("renders the editor file bar + export card", () => {
    renderEdit();
    // The file bar's "open another file" action is present in the default
    // (no-file) audio variant.
    expect(screen.getByText("Åpne annen fil")).toBeInTheDocument();
    // The export card title is shown.
    expect(screen.getByText("Eksporter episode")).toBeInTheDocument();
  });

  it("trims a loaded video file into a non-empty cutRegions on export", async () => {
    renderEdit();

    // Load a file: the mocked dialog returns a path, which probes as a video
    // (hasVideo:true) → the screen flips to the Videofil variant on its own.
    fireEvent.click(screen.getByText("Åpne annen fil"));

    // Wait for the probe to resolve — the trim cut math depends on the loaded
    // duration (1934 s), so don't trust it until the field bounds reflect it.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/x/sermon.mp4",
      }),
    );

    // Be explicit about the variant too (auto-selected, but the tab is also
    // clickable) — click "Videofil" so the trim inputs are guaranteed mounted.
    fireEvent.click(screen.getByText("Videofil"));

    // The trim Start / Slutt inputs only exist in the video variant. Start is
    // the field whose placeholder is the static "00:00:00".
    const startInput = await screen.findByPlaceholderText("00:00:00");
    fireEvent.change(startInput, { target: { value: "00:00:30" } });

    // Slutt: 25:00 of the 1934 s (≈32:14) file → an after-end cut too. The end
    // field's placeholder is the loaded duration (00:32:14), so it's the other
    // numeric textbox.
    const endInput = screen
      .getAllByRole("textbox")
      .find(
        (el) => (el as HTMLInputElement).placeholder !== "00:00:00",
      ) as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: "00:25:00" } });

    // Export the finished episode.
    fireEvent.click(screen.getByText("Eksporter ferdig episode"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_export", expect.anything()),
    );

    const req = lastExportRequest();
    expect(req.inputPath).toBe("/x/sermon.mp4");
    expect(req.duration).toBe(1934);
    // THE KEY ASSERTION: a non-empty cut plan, with the first region removing
    // everything before the 30 s start (start at 0).
    expect(Array.isArray(req.cutRegions)).toBe(true);
    expect(req.cutRegions.length).toBeGreaterThan(0);
    expect(req.cutRegions[0]).toEqual({ start: 0, end: 30 });
    // The 25:00 (1500 s) end < 1934 s file → an after-end cut too.
    expect(req.cutRegions).toContainEqual({ start: 1500, end: 1934 });
  });

  it("opens another file via the picker → editor_load_recording", async () => {
    renderEdit();
    fireEvent.click(screen.getByText("Åpne annen fil"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/x/sermon.mp4",
      }),
    );
  });

  it("hydrates from the sidecars on load and persists metadata edits", async () => {
    renderEdit();
    fireEvent.click(screen.getByText("Åpne annen fil"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/x/sermon.mp4",
      }),
    );
    // The sidecars are read on load (cutsDraft + meta).
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_read_sidecar", {
        mediaPath: "/x/sermon.mp4",
        sidecar: "meta",
      }),
    );

    // The metadata form is now a real, editable field set.
    const titleInput = await screen.findByPlaceholderText(
      "Pinsegudstjeneste 24. mai",
    );
    fireEvent.change(titleInput, { target: { value: "Min episode" } });

    // Debounced (600 ms) write of the .meta sidecar carrying the new title.
    await waitFor(
      () =>
        expect(invoke).toHaveBeenCalledWith("editor_write_sidecar", {
          mediaPath: "/x/sermon.mp4",
          sidecar: "meta",
          value: expect.objectContaining({ title: "Min episode" }),
        }),
      { timeout: 2000 },
    );
  });

  it("commits the mastered result via editor_master_apply", async () => {
    renderEdit();
    fireEvent.click(screen.getByText("Åpne annen fil"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_load_recording", {
        inputPath: "/x/sermon.mp4",
      }),
    );
    // The mastered-apply commit button is present in both variants (here the
    // auto-selected video variant's export card).
    fireEvent.click(screen.getByText("Bruk mastering / Eksporter"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "editor_master_apply",
        expect.objectContaining({
          request: expect.objectContaining({
            inputPath: "/x/sermon.mp4",
            presetId: expect.any(String),
            jobId: expect.any(String),
          }),
        }),
      ),
    );
  });
});
