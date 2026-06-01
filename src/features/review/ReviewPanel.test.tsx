import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ReviewPanel } from "./ReviewPanel";
import type { ReviewQueueEntry } from "@/lib/bindings/ReviewQueueEntry";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
const invoke = h.invoke;

function entry(
  id: string,
  recordingPath: string,
  status: ReviewQueueEntry["prep"]["status"],
  trim: { startSec: number; endSec: number } | null,
  attentionReasons: string[] | null,
): ReviewQueueEntry {
  return {
    id,
    addedAt: 1_700_000_000_000,
    reminded: 0,
    ageInDays: 1,
    prep: {
      id: `prep-${id}`,
      recordingPath,
      timestamp: 1_700_000_000_000,
      status,
      analysisSegments: [],
      suggestedTrim: trim,
      sermonConfidence: trim ? 0.8 : null,
      masterPreset: "speech-clear",
      introPath: null,
      outroPath: null,
      attentionReasons,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
  };
}

const QUEUE: ReviewQueueEntry[] = [
  entry(
    "q1",
    "/rec/2026-05-31 Høymesse.mp4",
    "ready",
    { startSec: 600, endSec: 1_800 }, // 20 min sermon
    null,
  ),
  entry("q2", "/rec/2026-05-24.mp4", "needs-attention", null, [
    "Ingen klar preken-blokk",
  ]),
  entry("q3", "/rec/old.mp4", "published", null, null), // filtered out
];

function routeInvoke(queue = QUEUE) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "review_queue_list":
        return Promise.resolve(queue);
      case "review_mark_published":
      case "review_mark_discarded":
        return Promise.resolve(true);
      case "review_process_reminders":
        return Promise.resolve([]);
      case "editor_peaks":
        return Promise.resolve({ peaks: [0.1, 0.5, 0.9, 0.3], sampleRate: 8000 });
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
      <ReviewPanel />
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

describe("ReviewPanel", () => {
  it("lists active queue entries with detected sermon length", async () => {
    renderPanel();
    expect(
      await screen.findByText("2026-05-31 Høymesse.mp4"),
    ).toBeInTheDocument();
    // 1200 s / 60 = 20 min.
    expect(screen.getByText("Preken antatt: 20 min")).toBeInTheDocument();
  });

  it("shows the no-sermon hint and attention reasons", async () => {
    renderPanel();
    await screen.findByText("2026-05-24.mp4");
    expect(screen.getByText("Preken ikke detektert")).toBeInTheDocument();
    expect(screen.getByText("• Ingen klar preken-blokk")).toBeInTheDocument();
  });

  it("hides published/discarded entries", async () => {
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");
    expect(screen.queryByText("old.mp4")).not.toBeInTheDocument();
  });

  it("approves+publishes an entry over IPC", async () => {
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");
    const buttons = screen.getAllByText("✓ Godkjenn og publiser");
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("review_mark_published", {
        id: "q1",
      }),
    );
  });

  it("discards an entry after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");
    const buttons = screen.getAllByText("✗ Ikke publiser denne uka");
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("review_mark_discarded", {
        id: "q1",
      }),
    );
    confirmSpy.mockRestore();
  });

  it("runs the reminder sweep over IPC", async () => {
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");
    fireEvent.click(screen.getByText("Kjør påminnelser"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("review_process_reminders"),
    );
  });

  it("previews the selected recording with an audio element over convertFileSrc", async () => {
    const { container } = renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");
    fireEvent.click(screen.getAllByText("▸ Forhåndsvis")[0]!);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("editor_peaks", {
        inputPath: "/rec/2026-05-31 Høymesse.mp4",
      }),
    );
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(audio!.getAttribute("src")).toContain("asset://localhost/");
  });

  it("bulk-publishes every selected pending entry over IPC", async () => {
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");

    // Select both active entries via their checkboxes.
    fireEvent.click(screen.getByLabelText("Velg 2026-05-31 Høymesse.mp4"));
    fireEvent.click(screen.getByLabelText("Velg 2026-05-24.mp4"));

    expect(screen.getByText("2 valgt")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Publiser valgte"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("review_mark_published", { id: "q1" }),
    );
    expect(invoke).toHaveBeenCalledWith("review_mark_published", { id: "q2" });
  });

  it("bulk-discards selected entries after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPanel();
    await screen.findByText("2026-05-31 Høymesse.mp4");

    fireEvent.click(screen.getByLabelText("Velg 2026-05-31 Høymesse.mp4"));
    fireEvent.click(screen.getByText("Forkast valgte"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("review_mark_discarded", { id: "q1" }),
    );
    confirmSpy.mockRestore();
  });

  it("shows the empty state with no active entries", async () => {
    routeInvoke([QUEUE[2]!]); // only a published entry → none active
    renderPanel();
    expect(
      await screen.findByText("Ingen episoder venter på gjennomgang."),
    ).toBeInTheDocument();
  });
});
