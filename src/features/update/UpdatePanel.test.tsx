import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UpdatePanel } from "./UpdatePanel";
import type { UpdateStatus } from "@/lib/bindings/UpdateStatus";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
const invoke = h.invoke;

/** Route invoke() by command name; `update_status` returns the given status,
 *  the action commands resolve to a benign value unless overridden. */
function routeInvoke(
  status: UpdateStatus,
  overrides: Record<string, () => Promise<unknown>> = {},
) {
  invoke.mockImplementation((cmd: string) => {
    if (overrides[cmd]) return overrides[cmd]!();
    switch (cmd) {
      case "update_status":
        return Promise.resolve(status);
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
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("no");
  invoke.mockReset();
  routeInvoke({ phase: "idle" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UpdatePanel", () => {
  it("shows the check hint when idle", async () => {
    renderPanel();
    expect(
      await screen.findByText("Klikk «Se etter oppdateringer» for å sjekke"),
    ).toBeInTheDocument();
  });

  it("invokes update_check when the check button is clicked", async () => {
    renderPanel();
    const btn = await screen.findByRole("button", {
      name: /Se etter oppdateringer/,
    });
    fireEvent.click(btn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update_check"));
  });

  it("offers a download button and invokes the download command when available", async () => {
    routeInvoke({ phase: "available", version: "4.99.0" });
    renderPanel();
    // The available line interpolates the version.
    expect(await screen.findByText(/4\.99\.0/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Last ned"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_download_install"),
    );
  });

  it("shows the download percentage while downloading", async () => {
    routeInvoke({ phase: "downloading", version: "4.99.0", percent: 42 });
    renderPanel();
    expect(await screen.findByText(/42/)).toBeInTheDocument();
  });

  it("offers restart & install when ready, invoking update_relaunch", async () => {
    routeInvoke({ phase: "readyToInstall", version: "4.99.0" });
    renderPanel();
    const btn = await screen.findByText("↺ Start på nytt og installer");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_relaunch"),
    );
  });

  it("shows a calm 'not built in' hint when the feature is disabled", async () => {
    routeInvoke(
      { phase: "idle" },
      {
        update_check: () =>
          Promise.reject({
            code: "validation",
            message:
              "feature_disabled: auto-update requires a build with `--features updater`",
          }),
      },
    );
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: /Se etter oppdateringer/ }),
    );
    expect(
      await screen.findByText(
        "Automatisk oppdatering er ikke bygget inn i denne versjonen.",
      ),
    ).toBeInTheDocument();
  });
});
