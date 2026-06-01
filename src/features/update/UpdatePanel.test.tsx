import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { UpdatePanel } from "./UpdatePanel";
import type { UpdateStatus } from "@/lib/bindings/UpdateStatus";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn(), getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => h.getVersion(),
}));
const invoke = h.invoke;
const getVersion = h.getVersion;

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
  getVersion.mockReset();
  getVersion.mockResolvedValue("4.98.0");
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
    // The available line + the release-notes comparison both show the version.
    expect((await screen.findAllByText(/4\.99\.0/)).length).toBeGreaterThan(0);
    fireEvent.click(
      screen.getByRole("button", { name: /Last ned/ }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_download_install"),
    );
  });

  it("renders installed-vs-available versions in the release-notes block when an update is available", async () => {
    routeInvoke({ phase: "available", version: "4.99.0" });
    renderPanel();
    // Installed version from getVersion().
    expect(await screen.findByText("4.98.0")).toBeInTheDocument();
    expect(screen.getByText("Installert versjon")).toBeInTheDocument();
    // The available version is shown under "Ny versjon".
    expect(screen.getByText("Ny versjon")).toBeInTheDocument();
    expect(screen.getByText("4.99.0")).toBeInTheDocument();
  });

  it("shows 'Du har nyeste versjon' with the installed version when up to date", async () => {
    routeInvoke({ phase: "upToDate" });
    renderPanel();
    expect(await screen.findByText("Du har nyeste versjon")).toBeInTheDocument();
    expect(screen.getByText("4.98.0")).toBeInTheDocument();
  });

  it("shows the download percentage and a progressbar while downloading", async () => {
    routeInvoke({ phase: "downloading", version: "4.99.0", percent: 42 });
    renderPanel();
    expect(await screen.findByText(/42/)).toBeInTheDocument();
    const bar = await screen.findByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
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
