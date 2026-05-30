import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { DiagnosticsReport } from "@/lib/bindings/DiagnosticsReport";
import type { PreflightFinding } from "@/lib/bindings/PreflightFinding";

/**
 * F2.2 diagnostics + preflight panel.
 *
 *   - "Kjør diagnose" → `run_diagnostics`: builds the markdown report in Rust
 *     (pure formatter in `sundayrec-core`), saves it under the app-data dir, and
 *     returns it. We render the markdown verbatim in a <pre> and offer a copy
 *     button (UI-side `navigator.clipboard`, since the clipboard is a webview
 *     concern).
 *   - "Sjekk klar-til-opptak" → `run_preflight`: returns the findings the pure
 *     core decided on (empty = all clear).
 *
 * No dedicated i18n keys exist for diagnostics yet, so every `t()` here carries
 * a Norwegian fallback (the source-of-truth language) rather than inventing a
 * key tree the other locales don't have.
 */

/** Tri-state render of a capture test result. */
function captureLabel(
  ok: boolean | null,
  t: (k: string, d: string) => string,
): { text: string; className: string } {
  if (ok === null)
    return {
      text: t("diagnostics.notTested", "ikke testet"),
      className: "opacity-60",
    };
  if (ok)
    return { text: t("diagnostics.ok", "OK ✓"), className: "text-emerald-400" };
  return { text: t("diagnostics.failed", "Feil ✗"), className: "text-red-400" };
}

export function DiagnosticsPanel() {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const diagnostics = useMutation<DiagnosticsReport>({
    mutationFn: () => invoke<DiagnosticsReport>("run_diagnostics"),
  });

  const preflight = useMutation<PreflightFinding[]>({
    mutationFn: () => invoke<PreflightFinding[]>("run_preflight"),
  });

  const report = diagnostics.data;

  const onCopy = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [report]);

  const audio = report ? captureLabel(report.captureOk, t) : null;
  const video = report ? captureLabel(report.videoOk, t) : null;
  const findings = preflight.data;

  return (
    <section
      className="flex w-full max-w-md flex-col gap-4"
      aria-label={t("diagnostics.title", "Diagnose")}
    >
      {/* ── Preflight: ready-to-record ──────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="self-start rounded bg-emerald-600 px-3 py-1 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          disabled={preflight.isPending}
          onClick={() => preflight.mutate()}
        >
          {preflight.isPending
            ? t("diagnostics.checking", "Sjekker …")
            : t("diagnostics.preflightBtn", "Sjekk klar-til-opptak")}
        </button>

        {preflight.isError && (
          <p className="text-xs text-red-400">
            {(preflight.error as Error)?.message ??
              t("general.unknownError", "Ukjent feil")}
          </p>
        )}

        {findings && findings.length === 0 && (
          <p className="text-sm text-emerald-400">
            {t("diagnostics.allClear", "Alt klart for opptak ✓")}
          </p>
        )}

        {findings && findings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {findings.map((f, i) => (
              <li
                key={i}
                className={`text-sm ${
                  f.severity === "error" ? "text-red-400" : "text-amber-400"
                }`}
              >
                {f.severity === "error" ? "✗" : "⚠"} {f.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Diagnostics report ──────────────────────────────────────────── */}
      <div className="flex flex-col gap-2 border-t border-zinc-800 pt-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded bg-zinc-700 px-3 py-1 text-sm font-medium text-white hover:bg-zinc-600 disabled:opacity-50"
            disabled={diagnostics.isPending}
            onClick={() => diagnostics.mutate()}
          >
            {diagnostics.isPending
              ? t("diagnostics.running", "Kjører …")
              : t("diagnostics.runBtn", "Kjør diagnose")}
          </button>

          {report && (
            <button
              type="button"
              className="rounded border border-zinc-600 px-3 py-1 text-sm hover:bg-zinc-800"
              onClick={() => void onCopy()}
            >
              {copied
                ? t("diagnostics.copied", "Kopiert ✓")
                : t("diagnostics.copy", "Kopier")}
            </button>
          )}
        </div>

        {diagnostics.isError && (
          <p className="text-xs text-red-400">
            {(diagnostics.error as Error)?.message ??
              t("general.unknownError", "Ukjent feil")}
          </p>
        )}

        {report && (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span className={audio?.className}>
                {t("diagnostics.audioCapture", "Lyd")}: {audio?.text}
              </span>
              <span className={video?.className}>
                {t("diagnostics.videoCapture", "Video")}: {video?.text}
              </span>
              {report.savedTo && (
                <span className="opacity-60" title={report.savedTo}>
                  {t("diagnostics.savedTo", "Lagret")} ✓
                </span>
              )}
            </div>

            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-zinc-900 p-3 text-left text-xs">
              {report.markdown}
            </pre>
          </>
        )}
      </div>
    </section>
  );
}
