import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";

import {
  DISMISS_MS,
  ToastHost,
  toastReducer,
  useToast,
  useToastApi,
} from "./Toast";
import i18n from "@/i18n";

// --- Tauri event bridge mock -------------------------------------------------
// Capture the registered listeners so tests can fire backend events by name.

const h = vi.hoisted(() => {
  const handlers = new Map<string, (e: { payload: unknown }) => void>();
  return {
    handlers,
    listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(name, cb);
      return Promise.resolve(() => handlers.delete(name));
    }),
    emit(name: string, payload: unknown) {
      handlers.get(name)?.({ payload });
    },
  };
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => (h.listen as (...a: unknown[]) => unknown)(...args),
}));

beforeEach(() => {
  h.handlers.clear();
  h.listen.mockClear();
  i18n.changeLanguage("no");
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("toastReducer", () => {
  const empty = { toasts: [], seq: 0 };

  it("appends a pushed toast with a fresh id", () => {
    const s = toastReducer(empty, {
      type: "push",
      key: "a",
      severity: "warn",
      message: "hi",
    });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ key: "a", severity: "warn", message: "hi", id: 1 });
  });

  it("coalesces a re-pushed key (replaces, does not stack)", () => {
    let s = toastReducer(empty, { type: "push", key: "a", severity: "warn", message: "first" });
    s = toastReducer(s, { type: "push", key: "a", severity: "error", message: "second" });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]).toMatchObject({ message: "second", severity: "error", id: 2 });
  });

  it("keeps distinct keys side by side", () => {
    let s = toastReducer(empty, { type: "push", key: "a", severity: "warn", message: "x" });
    s = toastReducer(s, { type: "push", key: "b", severity: "info", message: "y" });
    expect(s.toasts.map((t) => t.key)).toEqual(["a", "b"]);
  });

  it("dismisses by key", () => {
    let s = toastReducer(empty, { type: "push", key: "a", severity: "warn", message: "x" });
    s = toastReducer(s, { type: "dismiss", key: "a" });
    expect(s.toasts).toHaveLength(0);
  });
});

describe("DISMISS_MS contract", () => {
  it("warns auto-dismiss at 8s, info at 6s, errors are sticky", () => {
    expect(DISMISS_MS.warn).toBe(8000);
    expect(DISMISS_MS.info).toBe(6000);
    expect(DISMISS_MS.error).toBeNull();
  });
});

describe("useToast", () => {
  it("auto-dismisses a warn after its delay", () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.push({ key: "w", severity: "warn", message: "weak" }));
    expect(result.current.toasts).toHaveLength(1);
    act(() => vi.advanceTimersByTime(8000));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("keeps an error toast until dismissed", () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.push({ key: "e", severity: "error", message: "boom" }));
    act(() => vi.advanceTimersByTime(60000));
    expect(result.current.toasts).toHaveLength(1);
    act(() => result.current.dismiss("e"));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("re-arms the timer when a key is re-pushed (coalesce)", () => {
    const { result } = renderHook(() => useToast());
    act(() => result.current.push({ key: "w", severity: "warn", message: "a" }));
    act(() => vi.advanceTimersByTime(5000));
    // Re-push the same key — the old 8s timer is cancelled, a new one armed.
    act(() => result.current.push({ key: "w", severity: "warn", message: "b" }));
    act(() => vi.advanceTimersByTime(5000));
    // 10s total elapsed but only 5s since the re-push → still visible.
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]!.message).toBe("b");
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.toasts).toHaveLength(0);
  });
});

describe("ToastHost backend wiring", () => {
  it("subscribes to the recorder warning/error/finish channels", () => {
    render(<ToastHost />);
    const names = h.listen.mock.calls.map((c) => c[0]);
    expect(names).toContain("recording://error");
    expect(names).toContain("recording://silence");
    expect(names).toContain("recording://finished");
  });

  it("surfaces a recording error as a sticky alert", async () => {
    render(<ToastHost />);
    act(() => h.emit("recording://error", { code: "device", message: "Mic borte" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Mic borte");
    // Errors never auto-dismiss.
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByRole("alert")).toHaveTextContent("Mic borte");
  });

  it("surfaces a silence event as a warning and auto-dismisses it", async () => {
    render(<ToastHost />);
    act(() => h.emit("recording://silence", { code: "silence", message: "Stille" }));
    expect(await screen.findByText("Stille")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(8000));
    await waitFor(() => expect(screen.queryByText("Stille")).not.toBeInTheDocument());
  });

  it("surfaces a recording-finished summary as an info toast", async () => {
    render(<ToastHost />);
    act(() => h.emit("recording://finished", { message: "Fullført — 1t 30m" }));
    expect(await screen.findByText("Fullført — 1t 30m")).toBeInTheDocument();
  });

  it("coalesces repeated silence warnings into one banner", async () => {
    render(<ToastHost />);
    act(() => h.emit("recording://silence", { code: "silence", message: "Stille 1" }));
    act(() => h.emit("recording://silence", { code: "silence", message: "Stille 2" }));
    await screen.findByText("Stille 2");
    expect(screen.queryByText("Stille 1")).not.toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("dismisses a toast when the close button is clicked", async () => {
    render(<ToastHost />);
    act(() => h.emit("recording://error", { code: "x", message: "Klikk vekk" }));
    await screen.findByText("Klikk vekk");
    fireEvent.click(screen.getByLabelText("Lukk"));
    expect(screen.queryByText("Klikk vekk")).not.toBeInTheDocument();
  });

  it("lets children push their own toast via the context", async () => {
    function Child() {
      const api = useToastApi();
      return (
        <button
          type="button"
          onClick={() =>
            api.push({ key: "export", severity: "info", message: "Eksport ferdig" })
          }
        >
          go
        </button>
      );
    }
    render(
      <ToastHost>
        <Child />
      </ToastHost>,
    );
    fireEvent.click(screen.getByText("go"));
    expect(await screen.findByText("Eksport ferdig")).toBeInTheDocument();
  });
});
