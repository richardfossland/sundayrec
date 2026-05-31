import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { EmailSettingsPanel } from "./EmailSettingsPanel";
import type { EmailStatus } from "@/lib/bindings/EmailStatus";
import i18n from "@/i18n";

// --- Tauri bridge mock ------------------------------------------------------

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));
const invoke = h.invoke;

const FEATURE_ON: EmailStatus = { featureBuilt: true, gmailConnected: false };

/** Route invoke() by command name; the send resolves unless overridden. */
function routeInvoke(
  status: EmailStatus = FEATURE_ON,
  sendImpl: () => Promise<unknown> = () => Promise.resolve(undefined),
) {
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "email_status":
        return Promise.resolve(status);
      case "email_send_test":
        return sendImpl();
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
      <EmailSettingsPanel />
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

describe("EmailSettingsPanel", () => {
  it("defaults to SMTP and shows the SMTP fields", async () => {
    renderPanel();
    expect(
      await screen.findByLabelText("SMTP-tjener (f.eks. smtp.gmail.com)"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Avsender-adresse")).toBeInTheDocument();
  });

  it("disables the test button until recipient + SMTP fields are filled", async () => {
    renderPanel();
    const btn = await screen.findByText("Send testvarsel");
    expect(btn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Mottaker (e-postadresse)"), {
      target: { value: "pastor@kirke.no" },
    });
    // Recipient alone isn't enough for SMTP.
    expect(btn).toBeDisabled();

    fireEvent.change(
      screen.getByLabelText("SMTP-tjener (f.eks. smtp.gmail.com)"),
      { target: { value: "smtp.gmail.com" } },
    );
    fireEvent.change(screen.getByLabelText("Passord / app-passord"), {
      target: { value: "app-pw" },
    });
    fireEvent.change(screen.getByLabelText("Avsender-adresse"), {
      target: { value: "rec@kirke.no" },
    });
    expect(btn).not.toBeDisabled();
  });

  it("sends an SMTP test alert over IPC with the typed fields", async () => {
    renderPanel();
    await screen.findByText("Send testvarsel");
    fireEvent.change(screen.getByLabelText("Mottaker (e-postadresse)"), {
      target: { value: "pastor@kirke.no" },
    });
    fireEvent.change(
      screen.getByLabelText("SMTP-tjener (f.eks. smtp.gmail.com)"),
      { target: { value: "smtp.gmail.com" } },
    );
    fireEvent.change(screen.getByLabelText("Passord / app-passord"), {
      target: { value: "app-pw" },
    });
    fireEvent.change(screen.getByLabelText("Avsender-adresse"), {
      target: { value: "rec@kirke.no" },
    });
    fireEvent.click(screen.getByText("Send testvarsel"));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "email_send_test",
        expect.objectContaining({
          transport: "smtp",
          recipient: "pastor@kirke.no",
          host: "smtp.gmail.com",
          pass: "app-pw",
          from: "rec@kirke.no",
        }),
      ),
    );
    expect(await screen.findByText("Testvarsel sendt.")).toBeInTheDocument();
  });

  it("shows the feature-disabled hint when send returns feature_disabled", async () => {
    routeInvoke(FEATURE_ON, () =>
      Promise.reject({
        message: "feature_disabled: email requires --features email",
      }),
    );
    renderPanel();
    await screen.findByText("Send testvarsel");
    fireEvent.change(screen.getByLabelText("Mottaker (e-postadresse)"), {
      target: { value: "p@k.no" },
    });
    fireEvent.change(
      screen.getByLabelText("SMTP-tjener (f.eks. smtp.gmail.com)"),
      { target: { value: "smtp.k.no" } },
    );
    fireEvent.change(screen.getByLabelText("Passord / app-passord"), {
      target: { value: "pw" },
    });
    fireEvent.change(screen.getByLabelText("Avsender-adresse"), {
      target: { value: "r@k.no" },
    });
    fireEvent.click(screen.getByText("Send testvarsel"));

    expect(
      await screen.findByText(
        "E-postvarsler er ikke bygd inn i denne versjonen. Innstillingene kan likevel lagres.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the feature-disabled hint up-front when the build lacks the feature", async () => {
    routeInvoke({ featureBuilt: false, gmailConnected: false });
    renderPanel();
    expect(
      await screen.findByText(
        "E-postvarsler er ikke bygd inn i denne versjonen. Innstillingene kan likevel lagres.",
      ),
    ).toBeInTheDocument();
  });

  it("offers the Gmail no-config path when Gmail is connected", async () => {
    routeInvoke({ featureBuilt: true, gmailConnected: true });
    renderPanel();
    // Gmail connected → once status loads it defaults to gmail, so the SMTP
    // host field disappears (it shows briefly while the status query is in
    // flight, since gmailConnected is unknown until then).
    await waitFor(() =>
      expect(
        screen.queryByLabelText("SMTP-tjener (f.eks. smtp.gmail.com)"),
      ).not.toBeInTheDocument(),
    );

    fireEvent.change(screen.getByLabelText("Mottaker (e-postadresse)"), {
      target: { value: "pastor@kirke.no" },
    });
    fireEvent.click(screen.getByText("Send testvarsel"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "email_send_test",
        expect.objectContaining({ transport: "gmail", host: null }),
      ),
    );
  });
});
