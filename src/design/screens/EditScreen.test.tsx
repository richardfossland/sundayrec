import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EditScreen } from "./EditScreen";
import i18n from "@/i18n";

/**
 * The ported editor screen is mostly engine-driven (Web Audio + canvas), which
 * jsdom can't exercise. These tests cover the React chrome: the empty state, the
 * recent-recordings list, and that no waveform/peaks backend call is made on
 * mount (the whole point of the port — the waveform is client-side). The
 * engine's logic is unit-tested in features/editor/engine/engine.test.ts.
 */
let recordings: unknown[] = [];
const invoke = vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
  if (cmd === "recordings_list") return recordings;
  return null;
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  convertFileSrc: (p: string) => `asset://${p}`,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}));

beforeEach(() => {
  invoke.mockClear();
  recordings = [];
  // Deterministic language for the text assertions below.
  void i18n.changeLanguage("no");
});

function renderEdit() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <EditScreen />
    </QueryClientProvider>,
  );
}

describe("EditScreen (ported)", () => {
  it("renders the empty state with open + timeline cards", () => {
    renderEdit();
    expect(screen.getByText("Rediger")).toBeTruthy();
    expect(screen.getByText("Ingen fil åpen")).toBeTruthy();
    expect(screen.getByText("Åpne fil")).toBeTruthy();
    expect(screen.getByText("Tidslinje")).toBeTruthy();
  });

  it("does NOT call any peaks/load backend command on mount (client-side waveform)", async () => {
    renderEdit();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("recordings_list", undefined),
    );
    const cmds = invoke.mock.calls.map((c) => c[0]);
    expect(cmds).not.toContain("editor_peaks");
    expect(cmds).not.toContain("editor_load_recording");
  });

  it("lists the user's recent recordings for quick-open", async () => {
    recordings = [
      {
        id: "r1",
        file_path: "/recordings/2026-05-17_pinse.wav",
        device_name: null,
        started_at: 0,
        duration_ms: 1934000,
        byte_size: null,
        created_at: 0,
        note: null,
      },
    ];
    renderEdit();
    await waitFor(() =>
      expect(screen.getAllByText("Siste opptak").length).toBeGreaterThan(0),
    );
  });
});
