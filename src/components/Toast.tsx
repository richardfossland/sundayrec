import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";

import type { RecordingEvent } from "@/lib/bindings/RecordingEvent";

/**
 * Toast layer — mirrors the Electron `showBackendWarning()` /
 * `showRecordingFinishedSummary()` flow in `src/renderer/pages/home.ts`:
 *   - backend warnings/errors surface as transient banners,
 *   - a `warn` auto-dismisses after 8 s, an `error` stays until dismissed,
 *   - a new toast of the same *key* replaces the old one (coalesce — the
 *     Electron code removes prior `.backend-warning-toast.severity-X` first),
 *   - an editor/recording-finish summary surfaces as an `info` toast.
 *
 * The reducer + timing live in {@link useToast}; the visual host is
 * {@link ToastHost}. Interaction (push/dismiss/coalesce) is testable with
 * `listen` mocked; only the pixel paint is GUI-UNVERIFIED.
 */

export type ToastSeverity = "info" | "warn" | "error";

export interface Toast {
  /** Stable identity — same `key` coalesces (replaces) an existing toast. */
  readonly key: string;
  readonly severity: ToastSeverity;
  readonly message: string;
  /** Monotonic id for React list keys (distinct from the coalesce `key`). */
  readonly id: number;
}

/** Auto-dismiss delay in ms by severity. `error` is sticky (Electron parity). */
export const DISMISS_MS: Record<ToastSeverity, number | null> = {
  info: 6000,
  warn: 8000,
  error: null,
};

interface ToastState {
  readonly toasts: readonly Toast[];
  readonly seq: number;
}

type ToastAction =
  | { type: "push"; key: string; severity: ToastSeverity; message: string }
  | { type: "dismiss"; key: string }
  | { type: "clear" };

/**
 * Pure reducer. `push` coalesces by `key`: an existing toast with the same key
 * is dropped and the new one appended (so the freshest message wins and the
 * banner does not stack), exactly like the Electron remove-then-add.
 */
export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "push": {
      const id = state.seq + 1;
      const kept = state.toasts.filter((tt) => tt.key !== action.key);
      return {
        seq: id,
        toasts: [
          ...kept,
          {
            key: action.key,
            severity: action.severity,
            message: action.message,
            id,
          },
        ],
      };
    }
    case "dismiss":
      return { ...state, toasts: state.toasts.filter((tt) => tt.key !== action.key) };
    case "clear":
      return { ...state, toasts: [] };
  }
}

export interface ToastApi {
  readonly toasts: readonly Toast[];
  /** Push a toast; same `key` coalesces. Defaults to a derived key. */
  push: (input: {
    key?: string;
    severity: ToastSeverity;
    message: string;
  }) => void;
  dismiss: (key: string) => void;
  clear: () => void;
}

/**
 * Toast store with severity-based auto-dismiss. `warn`/`info` schedule a
 * timeout; `error` is sticky. Re-pushing a key resets its timer (the old
 * timeout is cleared) so a refreshed warning gets a full window again.
 */
export function useToast(): ToastApi {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [], seq: 0 });
  // key → timeout handle, so coalescing can cancel the prior auto-dismiss.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((key: string) => {
    const handle = timers.current.get(key);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(key);
    }
    dispatch({ type: "dismiss", key });
  }, []);

  const push = useCallback<ToastApi["push"]>(
    ({ key, severity, message }) => {
      const k = key ?? `${severity}:${message}`;
      // Cancel any pending dismiss for this key before re-arming.
      const prior = timers.current.get(k);
      if (prior) clearTimeout(prior);
      dispatch({ type: "push", key: k, severity, message });
      const delay = DISMISS_MS[severity];
      if (delay !== null) {
        const handle = setTimeout(() => {
          timers.current.delete(k);
          dispatch({ type: "dismiss", key: k });
        }, delay);
        timers.current.set(k, handle);
      } else {
        timers.current.delete(k);
      }
    },
    [],
  );

  const clear = useCallback(() => {
    for (const handle of timers.current.values()) clearTimeout(handle);
    timers.current.clear();
    dispatch({ type: "clear" });
  }, []);

  // Clean up any pending timers on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const handle of map.values()) clearTimeout(handle);
      map.clear();
    };
  }, []);

  return useMemo(
    () => ({ toasts: state.toasts, push, dismiss, clear }),
    [state.toasts, push, dismiss, clear],
  );
}

const ToastContext = createContext<ToastApi | null>(null);

/** Access the app toast API (push/dismiss). Must be inside a {@link ToastHost}. */
export function useToastApi(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToastApi must be used within <ToastHost>");
  return ctx;
}

const SEVERITY_CLASS: Record<ToastSeverity, string> = {
  info: "border-emerald-700 bg-emerald-950/80 text-emerald-100",
  warn: "border-amber-600 bg-amber-950/80 text-amber-100",
  error: "border-red-700 bg-red-950/80 text-red-100",
};

const SEVERITY_ICON: Record<ToastSeverity, string> = {
  info: "✓",
  warn: "⚠",
  error: "✕",
};

/**
 * Mounts the toast stack and subscribes to the backend channels that warrant a
 * banner (mirrors Electron home wiring):
 *   - `recording://error`   → sticky error toast,
 *   - `recording://silence` → 8 s warning toast,
 *   - `recording://finished`→ an info "complete" summary.
 *
 * Children can push their own toasts via {@link useToastApi} (e.g. the editor
 * "export done"). The `listen` subscriptions are exercised in tests with the
 * Tauri event bridge mocked; only the pixel paint is GUI-UNVERIFIED.
 */
export function ToastHost({ children }: { children?: ReactNode }) {
  const api = useToast();
  const { t } = useTranslation();
  const { push } = api;

  useEffect(() => {
    const unError = listen<RecordingEvent>("recording://error", (event) =>
      push({
        key: "recording-error",
        severity: "error",
        message:
          event.payload.message ||
          t("status.recordingError", "Opptaksfeil"),
      }),
    );
    const unSilence = listen<RecordingEvent>("recording://silence", (event) =>
      push({
        key: "recording-silence",
        severity: "warn",
        message:
          event.payload.message ||
          t("home.testSignalSilent", "⚠️ Stillhet — mikser av?"),
      }),
    );
    const unFinished = listen<{ message?: string } | null>(
      "recording://finished",
      (event) =>
        push({
          key: "recording-finished",
          severity: "info",
          message:
            event.payload?.message || t("history.complete", "Fullført"),
        }),
    );
    return () => {
      void unError.then((off) => off());
      void unSilence.then((off) => off());
      void unFinished.then((off) => off());
    };
  }, [push, t]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed right-4 top-4 z-50 flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label={t("general.notifications", "Varsler")}
      >
        {api.toasts.map((tt) => (
          <div
            key={tt.id}
            role={tt.severity === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg ${SEVERITY_CLASS[tt.severity]}`}
          >
            <span aria-hidden className="mt-0.5 shrink-0">
              {SEVERITY_ICON[tt.severity]}
            </span>
            <span className="flex-1">{tt.message}</span>
            <button
              type="button"
              aria-label={t("general.close", "Lukk")}
              className="shrink-0 opacity-70 hover:opacity-100"
              onClick={() => api.dismiss(tt.key)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
