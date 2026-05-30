import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { DiagnosticsReport } from "@/lib/bindings/DiagnosticsReport";
import type { PreflightFinding } from "@/lib/bindings/PreflightFinding";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DiagnosticsPanel />
    </QueryClientProvider>,
  );
}

const REPORT: DiagnosticsReport = {
  markdown: "# SundayRec Diagnostics\n\n## System\n- **App-versjon:** 0.1.0",
  savedTo:
    "/Users/x/Library/Application Support/SundayRec/SundayRec-diagnose.md",
  captureOk: null,
  videoOk: null,
};

beforeEach(() => {
  h.invoke.mockReset();
});

describe("DiagnosticsPanel", () => {
  it("runs diagnostics and renders the report markdown + saved status", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "run_diagnostics") return Promise.resolve(REPORT);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Kjør diagnose/ }));

    await waitFor(() =>
      expect(
        screen.getByText(/SundayRec Diagnostics/, { exact: false }),
      ).toBeInTheDocument(),
    );
    expect(h.invoke).toHaveBeenCalledWith("run_diagnostics");
    // Tri-state capture results render as "ikke testet" for null.
    expect(screen.getAllByText(/ikke testet/).length).toBeGreaterThanOrEqual(2);
    // Saved indicator shown.
    expect(screen.getByText(/Lagret/)).toBeInTheDocument();
    // Copy button appears once a report exists.
    expect(screen.getByRole("button", { name: /Kopier/ })).toBeInTheDocument();
  });

  it("shows capture-test pass/fail when the report carries them", async () => {
    h.invoke.mockResolvedValue({
      ...REPORT,
      captureOk: true,
      videoOk: false,
    } satisfies DiagnosticsReport);

    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Kjør diagnose/ }));

    await waitFor(() => expect(screen.getByText(/OK ✓/)).toBeInTheDocument());
    expect(screen.getByText(/Feil ✗/)).toBeInTheDocument();
  });

  it("lists preflight findings with error/warn styling", async () => {
    const findings: PreflightFinding[] = [
      {
        severity: "error",
        category: "device",
        message: "ffmpeg-binær mangler.",
      },
      {
        severity: "warn",
        category: "disk",
        message: "Bare 0.3 GB ledig på lagringsdisken.",
      },
    ];
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "run_preflight") return Promise.resolve(findings);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Sjekk klar-til-opptak/ }),
    );

    await waitFor(() =>
      expect(screen.getByText(/ffmpeg-binær mangler/)).toBeInTheDocument(),
    );
    expect(screen.getByText(/0\.3 GB ledig/)).toBeInTheDocument();
  });

  it("shows 'alt klart' when preflight returns no findings", async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === "run_preflight")
        return Promise.resolve([] as PreflightFinding[]);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });

    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: /Sjekk klar-til-opptak/ }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Alt klart for opptak/)).toBeInTheDocument(),
    );
  });
});
