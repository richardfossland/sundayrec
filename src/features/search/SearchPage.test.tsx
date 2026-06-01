import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SearchPage } from "./SearchPage";
import type { RecordingRow } from "@/lib/bindings/RecordingRow";
import i18n from "@/i18n";

// --- Tauri bridge mocks -----------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const invoke = h.invoke;

const RECORDINGS: RecordingRow[] = [
  {
    id: "r1",
    file_path: "/Users/x/SundayRec/2026-05-31 Pinse.mp3",
    device_name: "Mixer",
    started_at: 1_716_000_000_000,
    duration_ms: 5_400_000,
    byte_size: 130_000_000,
    created_at: 1_716_000_000_000,
    note: null,
  },
];

function routeInvoke(recordings: RecordingRow[] = RECORDINGS) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "recordings_list":
        return Promise.resolve(recordings);
      default:
        return Promise.resolve(undefined);
    }
  });
}

function renderSearch() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SearchPage />
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

describe("SearchPage", () => {
  it("renders the search heading and box", async () => {
    renderSearch();
    expect(await screen.findByText("Søk i prekener")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Søk etter ord eller fraser/),
    ).toBeInTheDocument();
  });

  it("shows the empty-index state when no transcripts are indexed", async () => {
    renderSearch();
    expect(
      await screen.findByText("Ingen transkripsjoner ennå"),
    ).toBeInTheDocument();
    // With recordings present, it nudges toward transcribing them.
    expect(
      screen.getByText(/Åpne et opptak i Rediger/),
    ).toBeInTheDocument();
  });

  it("nudges to record first when there are no recordings either", async () => {
    routeInvoke([]);
    renderSearch();
    expect(
      await screen.findByText(/transkriber et opptak først/),
    ).toBeInTheDocument();
  });

  it("shows a no-matches message for a query with no hits", async () => {
    renderSearch();
    await screen.findByText("Ingen transkripsjoner ennå");
    fireEvent.change(
      screen.getByPlaceholderText(/Søk etter ord eller fraser/),
      { target: { value: "håp" } },
    );
    expect(await screen.findByText(/Ingen treff for/)).toBeInTheDocument();
  });

  it("refreshes the index when the reindex button is clicked", async () => {
    renderSearch();
    await screen.findByText("Ingen transkripsjoner ennå");
    invoke.mockClear();
    fireEvent.click(screen.getByText("↻ Oppdater indeks"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("recordings_list"),
    );
  });
});
