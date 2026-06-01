import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { SHELL_NAVIGATE_EVENT } from "@/components/MainLayout";
import { VIEW_NAMES, type ViewName } from "@/lib/routing";

/**
 * A global ⌘K / Ctrl+K command palette.
 *
 * Opens on the platform shortcut, fuzzy-filters every top-level view by its
 * localised label, and navigates to the chosen view through the existing shell
 * mechanism ({@link SHELL_NAVIGATE_EVENT}, the same custom event the home cards
 * and history rows use). Arrow keys move the selection, Enter activates it, and
 * Escape closes. The keydown listener is global (so the palette works from any
 * view) and is torn down on unmount.
 *
 * Mounted once inside {@link MainLayout} so it is available on every view. Pure
 * UI + the shared navigate event; no Tauri IPC.
 */

/** A label per view, mirroring `MainLayout`'s `NAV_LABELS` (kept independent so
 *  the palette can be mounted/tested in isolation). */
const PALETTE_LABELS: Record<ViewName, { key: string; fallback: string }> = {
  home: { key: "nav.home", fallback: "Hjem" },
  schedule: { key: "schedule.title", fallback: "Planlegging" },
  history: { key: "nav.history", fallback: "Historikk" },
  review: { key: "review.title", fallback: "Gjennomgang" },
  search: { key: "search.title", fallback: "Søk i prekener" },
  editor: { key: "editor.title", fallback: "Redigering" },
  transcribe: { key: "transcribe.title", fallback: "Transkribering" },
  publish: { key: "publish.title", fallback: "Publisering" },
  streaming: { key: "streaming.title", fallback: "Direktesending" },
  cloud: { key: "cloud.title", fallback: "Sky-backup" },
  email: { key: "email.title", fallback: "E-postvarsler" },
  integrations: { key: "integrations.title", fallback: "Integrasjoner" },
  diagnostics: { key: "diagnostics.title", fallback: "Diagnose" },
  wake: { key: "wake.title", fallback: "Vekking fra dvale" },
  settings: { key: "nav.general", fallback: "Generelt" },
  update: { key: "general.updates", fallback: "Oppdateringer" },
};

/** A command the palette can run — one per navigable view. */
interface PaletteCommand {
  view: ViewName;
  label: string;
}

/**
 * Loose subsequence match: every character of `query` appears in `text` in
 * order (case-insensitive). Mirrors the forgiving "fuzzy" feel of typical
 * command palettes without a scoring library. An empty query matches all.
 */
export function fuzzyMatch(text: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  const haystack = text.toLowerCase();
  let i = 0;
  for (const ch of haystack) {
    if (ch === q[i]) {
      i += 1;
      if (i === q.length) return true;
    }
  }
  return i === q.length;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<PaletteCommand[]>(
    () =>
      VIEW_NAMES.map((view) => ({
        view,
        label: t(PALETTE_LABELS[view].key, PALETTE_LABELS[view].fallback),
      })),
    [t],
  );

  const results = useMemo(
    () => commands.filter((c) => fuzzyMatch(c.label, query)),
    [commands, query],
  );

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const run = useCallback(
    (view: ViewName) => {
      window.dispatchEvent(
        new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: view }),
      );
      close();
    },
    [close],
  );

  // Global open shortcut: ⌘K (mac) / Ctrl+K (win/linux).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the active row in range as the result set shrinks, and focus the input
  // when the palette opens.
  useEffect(() => {
    if (active >= results.length) setActive(Math.max(0, results.length - 1));
  }, [results.length, active]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (results.length ? (i + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) =>
        results.length ? (i - 1 + results.length) % results.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = results[active];
      if (chosen) run(chosen.view);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[15vh]"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.title", "Kommandopalett")}
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onInputKeyDown}
          placeholder={t("palette.placeholder", "Gå til … (skriv for å filtrere)")}
          aria-label={t("palette.placeholder", "Gå til … (skriv for å filtrere)")}
          className="w-full border-b border-border bg-bg px-4 py-3 text-sm text-text placeholder:text-text3 focus:outline-none"
        />
        <ul className="max-h-72 overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-sm text-text3">
              {t("palette.noMatches", "Ingen treff")}
            </li>
          ) : (
            results.map((cmd, i) => (
              <li key={cmd.view}>
                <button
                  type="button"
                  data-palette-view={cmd.view}
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(cmd.view)}
                  className={`flex w-full px-4 py-2 text-left text-sm transition-colors ${
                    i === active
                      ? "bg-surface2 text-accent"
                      : "text-text2 hover:bg-surface2"
                  }`}
                >
                  {cmd.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
