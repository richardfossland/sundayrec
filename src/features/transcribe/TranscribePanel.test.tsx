import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TranscribePanel } from "./TranscribePanel";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import type { WhisperModelMeta } from "@/lib/bindings/WhisperModelMeta";
import type { TranscriptData } from "@/lib/bindings/TranscriptData";
import i18n from "@/i18n";

// --- Tauri bridge + dialog mocks --------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => h.save(...args),
}));
const invoke = h.invoke;
const save = h.save;

const ROWS: RecordingRow[] = [
  {
    id: "r1",
    file_path: "/rec/2026-05-31.mp4",
    device_name: "Scarlett",
    started_at: 0,
    duration_ms: 3600000,
    byte_size: 1000,
    created_at: 1,
    note: null,
  },
];

const MODELS: WhisperModelMeta[] = [
  {
    id: "ggml-base",
    label: "Base (raskest)",
    description: "Liten modell.",
    url: "https://x/ggml-base.bin",
    sizeBytes: 147951465,
    sha256: "abc",
    realtimeFactor: 14,
    quality: "medium",
  },
  {
    id: "ggml-large-v3-turbo-q5_0",
    label: "Large turbo (anbefalt)",
    description: "Best.",
    url: "https://x/turbo.bin",
    sizeBytes: 574041195,
    sha256: "def",
    realtimeFactor: 6,
    quality: "best",
  },
];

const TRANSCRIPT: TranscriptData = {
  version: 1,
  model: "ggml-base",
  language: "no",
  duration: 65,
  createdAt: 1,
  translated: null,
  segments: [
    { start: 0, end: 2.5, text: "Hei alle sammen" },
    { start: 62, end: 65, text: "Amen" },
  ],
};

/** Route invoke() by command name; transcribe resolves to TRANSCRIPT by default. */
function routeInvoke(
  transcribeImpl: () => Promise<unknown> = () => Promise.resolve(TRANSCRIPT),
) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "recordings_list":
        return Promise.resolve(ROWS);
      case "whisper_list_models":
        return Promise.resolve(MODELS);
      case "whisper_transcribe":
        return transcribeImpl();
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
      <TranscribePanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  save.mockReset();
  routeInvoke();
  i18n.changeLanguage("no");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TranscribePanel", () => {
  it("lists recordings and the model registry", async () => {
    renderPanel();
    expect(await screen.findByText("2026-05-31.mp4")).toBeInTheDocument();
    expect(screen.getByText("Base (raskest)")).toBeInTheDocument();
    expect(screen.getByText("Large turbo (anbefalt)")).toBeInTheDocument();
  });

  it("transcribes the selected recording + model over IPC", async () => {
    renderPanel();
    await screen.findByText("2026-05-31.mp4");
    fireEvent.click(screen.getByText("Transkriber"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "whisper_transcribe",
        expect.objectContaining({
          inputPath: "/rec/2026-05-31.mp4",
          modelId: "ggml-base",
          translate: false,
        }),
      ),
    );
    // The transcript renders as a segment list.
    expect(await screen.findByText("Hei alle sammen")).toBeInTheDocument();
    expect(screen.getByText("Amen")).toBeInTheDocument();
  });

  it("exports the transcript to SRT via the save dialog + IPC", async () => {
    save.mockResolvedValue("/out/2026-05-31.srt");
    renderPanel();
    await screen.findByText("2026-05-31.mp4");
    fireEvent.click(screen.getByText("Transkriber"));
    await screen.findByText("Hei alle sammen");

    fireEvent.click(screen.getByText("SRT"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "whisper_export_transcript",
        expect.objectContaining({
          format: "srt",
          path: "/out/2026-05-31.srt",
        }),
      ),
    );
  });

  it("does not export when the save dialog is cancelled", async () => {
    save.mockResolvedValue(null);
    renderPanel();
    await screen.findByText("2026-05-31.mp4");
    fireEvent.click(screen.getByText("Transkriber"));
    await screen.findByText("Hei alle sammen");

    fireEvent.click(screen.getByText("VTT"));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith(
      "whisper_export_transcript",
      expect.anything(),
    );
  });

  it("shows the feature-disabled hint when transcribe is off", async () => {
    routeInvoke(() =>
      Promise.reject({
        message: "feature_disabled: whisper requires --features whisper",
      }),
    );
    renderPanel();
    await screen.findByText("2026-05-31.mp4");
    fireEvent.click(screen.getByText("Transkriber"));
    expect(
      await screen.findByText(
        "Transkribering er ikke bygd inn i denne versjonen.",
      ),
    ).toBeInTheDocument();
  });
});
