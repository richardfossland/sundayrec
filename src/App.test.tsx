import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./App";
import type { AppInfo } from "@/lib/bindings/AppInfo";

// Mock the Tauri IPC bridge — there's no backend in the jsdom test runner.
// App now also renders <VuMeter/>, which calls `list_input_devices` and
// subscribes to the `vu://levels` event, so both APIs are stubbed here.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === "list_input_devices") return { host: "CoreAudio", inputs: [] };
    if (cmd === "ffmpeg_health")
      return {
        available: true,
        version: "ffmpeg version 6.0",
        path: "/x/ffmpeg",
      };
    if (cmd === "recordings_list") return [];
    // F5.1: App mounts <SchedulePage/>, which reads settings + schedule status.
    if (cmd === "settings_get") return { slots: [], specialRecordings: [] };
    if (cmd === "scheduler_status") return { next: null, upcoming: [] };
    return {
      name: "SundayRec",
      version: "0.1.0",
      tauri_version: "2.0.0",
      platform: "macos",
      arch: "aarch64",
      greeting: "Hello SundayRec — backend connected.",
    } satisfies AppInfo;
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App", () => {
  it("renders the SundayRec title", () => {
    renderApp();
    expect(
      screen.getByRole("heading", { name: "SundayRec" }),
    ).toBeInTheDocument();
  });

  it("shows backend-OK with version once app_info resolves", async () => {
    renderApp();
    await waitFor(() =>
      expect(screen.getByText("SundayRec — backend OK")).toBeInTheDocument(),
    );
    // The version/platform line is split across text nodes by JSX whitespace,
    // so assert on the rendered document text rather than a single node.
    expect(document.body.textContent).toContain("v0.1.0");
    expect(document.body.textContent).toContain("macos");
  });
});
