import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { RecordingScreen } from "./RecordingScreen";
import i18n from "@/i18n";
import type { RecordingOpts } from "@/lib/bindings/RecordingOpts";

/**
 * Captured `recording://…` event handlers, keyed by event name, so a test can
 * synchronously fire a fake backend event. Declared via `vi.hoisted` so the
 * mock factory (hoisted above the imports) can close over the same object.
 */
const handlers = vi.hoisted(
  () => ({}) as Record<string, (e: { payload: unknown }) => void>,
);

/**
 * A complete planner result — mirrors the `RecordingOpts` binding exactly.
 * Hoisted so the (hoisted) `invoke` mock factory can return it.
 */
const PLANNED = vi.hoisted(
  (): RecordingOpts => ({
    audio_device_name: "",
    video_device_name: null,
    output_path: "/x/Gudstjeneste.wav",
    stop_on_silence: false,
    silence_threshold_db: null,
    silence_timeout_minutes: 5,
    framerate: 30,
    channel_mode: "stereo",
    input_channel_l: null,
    input_channel_r: null,
    sample_rate: 48000,
    bitrate_kbps: 192,
    split_minutes: 0,
    manual_max_minutes: 0,
    live_levels: true,
    keep_separate_audio: false,
    separate_audio_format: "wav",
    video_resolution: "720p",
  }),
);

// The screen drives the real Tauri IPC contract; jsdom has no backend, so stub
// `invoke`. `plan_recording_opts` → a full opts object, the recorder commands →
// null, the disk probe → 500 GB free. Hoisted so the mock factory can use it.
const invoke = vi.hoisted(() =>
  vi.fn(async (cmd: string): Promise<unknown> => {
    if (cmd === "plan_recording_opts") return PLANNED;
    if (cmd === "start_recording") return null;
    if (cmd === "stop_recording") return null;
    if (cmd === "get_disk_space") return { freeBytes: 500_000_000_000 };
    return null;
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

// Capture each `listen(name, cb)` so tests can fire events by name.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    handlers[name] = cb;
    return Promise.resolve(() => {});
  }),
}));

beforeEach(() => {
  i18n.changeLanguage("no");
  invoke.mockClear();
  for (const k of Object.keys(handlers)) delete handlers[k];
});

/** Render the screen in a fresh, retry-free QueryClient (reads settings cache). */
function renderRec(props: { video?: boolean; onStop?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RecordingScreen {...props} />
    </QueryClientProvider>,
  );
}

describe("RecordingScreen", () => {
  it("plans then starts the recorder on mount", async () => {
    renderRec();
    // Both calls live in an async mount effect → wait for them.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("plan_recording_opts", {
        customName: null,
        maxMinutes: null,
        video: false,
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", {
        opts: PLANNED,
      }),
    );
    // Order: the planner resolves before start fires with its result.
    const calls = invoke.mock.calls.map((c) => c[0]);
    expect(calls.indexOf("plan_recording_opts")).toBeLessThan(
      calls.indexOf("start_recording"),
    );
  });

  it("shows the planned output path under 'Lagres som …'", async () => {
    renderRec();
    await waitFor(() =>
      expect(screen.getByText(/Lagres som/)).toHaveTextContent(
        "/x/Gudstjeneste.wav",
      ),
    );
  });

  it("reflects a progress event in the file-size readout", async () => {
    renderRec();
    await waitFor(() => expect(handlers["recording://progress"]).toBeDefined());

    // 1_887_436 bytes / 1 MiB ≈ 1.8 MB.
    act(() =>
      handlers["recording://progress"]?.({
        payload: { bytes_written: 1_887_436 },
      }),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/1\.8 MB/).length).toBeGreaterThan(0),
    );
  });

  it("handles started + levels events without crashing", async () => {
    renderRec();
    await waitFor(() => expect(handlers["recording://started"]).toBeDefined());
    await waitFor(() => expect(handlers["recording://levels"]).toBeDefined());

    act(() => handlers["recording://started"]?.({ payload: {} }));
    act(() =>
      handlers["recording://levels"]?.({
        payload: { peak_db_left: -6, peak_db_right: -6 },
      }),
    );

    // Once started, the status flips to the "recording now" label.
    await waitFor(() =>
      expect(screen.getByText("Tar opp nå")).toBeInTheDocument(),
    );
  });

  it("stops the recorder and calls onStop when the stop button is clicked", async () => {
    const onStop = vi.fn();
    renderRec({ onStop });
    // Let the mount start-sequence settle first.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("start_recording", { opts: PLANNED }),
    );

    fireEvent.click(
      screen.getByText("Trykk for å stoppe opptaket").closest("button")!,
    );

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_recording"));
    await waitFor(() => expect(onStop).toHaveBeenCalled());
  });

  it("shows the auto-stop countdown and extends/cancels it via the recorder commands", async () => {
    renderRec();
    await waitFor(() => expect(handlers["recording://state"]).toBeDefined());

    // The backend stamps an absolute deadline (~90 s out) on the state event.
    act(() =>
      handlers["recording://state"]?.({
        payload: {
          state: "recording",
          reconnect_count: 0,
          scheduled_stop_ms: Date.now() + 90_000,
        },
      }),
    );

    // The countdown banner appears (label + a HH:MM:SS near 00:01:30).
    await waitFor(() =>
      expect(screen.getByText("Auto-stopp om")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByText("+30 min"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("recording_extend_autostop", {
        minutes: 30,
      }),
    );

    fireEvent.click(screen.getByText("Avbryt auto-stopp"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("recording_cancel_autostop"),
    );
  });

  it("hides the auto-stop banner when no deadline is set", async () => {
    renderRec();
    await waitFor(() => expect(handlers["recording://state"]).toBeDefined());
    act(() =>
      handlers["recording://state"]?.({
        payload: {
          state: "recording",
          reconnect_count: 0,
          scheduled_stop_ms: null,
        },
      }),
    );
    // No auto-stop armed → no countdown banner.
    expect(screen.queryByText("Auto-stopp om")).not.toBeInTheDocument();
  });
});
