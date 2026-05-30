import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CameraPreview } from "./CameraPreview";
import type { PreviewFrame } from "@/lib/bindings/PreviewFrame";

// --- Tauri bridge mocks -----------------------------------------------------

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  frameHandler: null as ((event: { payload: PreviewFrame }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => h.invoke(...args),
}));

// Capture the `preview://frame` handler so the test can push fake frames.
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: PreviewFrame }) => void) => {
    if (name === "preview://frame") h.frameHandler = handler;
    return Promise.resolve(() => {
      h.frameHandler = null;
    });
  },
}));

const invoke = h.invoke;

// A 1×1 transparent JPEG isn't needed — the component just forwards `data`.
const FAKE_B64 = "/9j/FAKEBASE64==";

function emitFrame(frame: PreviewFrame) {
  h.frameHandler?.({ payload: frame });
}

beforeEach(() => {
  invoke.mockReset();
  h.frameHandler = null;
  invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "start_preview":
      case "stop_preview":
        return Promise.resolve(null);
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
});

describe("CameraPreview", () => {
  it("shows the off state before starting", () => {
    render(<CameraPreview />);
    expect(screen.getByText("Preview er av")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start preview" }),
    ).toBeInTheDocument();
  });

  it("starts the preview and paints the latest frame into an <img>", async () => {
    render(<CameraPreview />);

    fireEvent.click(screen.getByRole("button", { name: "Start preview" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_preview", {
        device: null,
        fps: null,
      }),
    );
    // Before a frame: waiting state.
    expect(screen.getByText("Venter på første bilde …")).toBeInTheDocument();

    emitFrame({ data: FAKE_B64, width: 1280, height: 720, seq: 1 });

    await waitFor(() => {
      const img = screen.getByRole("img", { name: "Kamera-preview" });
      expect(img).toHaveAttribute("src", `data:image/jpeg;base64,${FAKE_B64}`);
    });
    // Dimensions overlay reflects the frame header.
    expect(screen.getByText("1280×720")).toBeInTheDocument();
  });

  it("updates the <img> when a newer frame arrives", async () => {
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Start preview" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("start_preview", expect.anything()));

    emitFrame({ data: "AAA", width: 640, height: 480, seq: 1 });
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,AAA",
      ),
    );

    emitFrame({ data: "BBB", width: 640, height: 480, seq: 2 });
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,BBB",
      ),
    );
  });

  it("stops the preview and clears the image", async () => {
    render(<CameraPreview />);
    fireEvent.click(screen.getByRole("button", { name: "Start preview" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stopp" })).toBeInTheDocument(),
    );
    emitFrame({ data: FAKE_B64, width: 320, height: 240, seq: 1 });
    await waitFor(() => expect(screen.getByRole("img")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Stopp" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_preview"));
    await waitFor(() =>
      expect(screen.getByText("Preview er av")).toBeInTheDocument(),
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
