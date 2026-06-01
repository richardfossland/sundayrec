import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import {
  initialNav,
  isViewName,
  nextNav,
  VIEW_NAMES,
  type NavState,
  type ViewName,
} from "@/lib/routing";
import { CommandPalette } from "@/components/CommandPalette";

/**
 * Custom DOM event a child view dispatches to ask the shell to switch views
 * (e.g. the home review-card → `review`). Decouples deep children from the
 * layout's reducer without prop-drilling a navigate callback.
 */
export const SHELL_NAVIGATE_EVENT = "shell:navigate";

/**
 * The real app shell (replaces the Phase-0 `<details>` stack in `App.tsx`).
 *
 * A persistent sidebar lists every top-level view (mirrors the Electron
 * `.nav-link` rail in `index.html`); clicking one drives the pure
 * {@link nextNav} reducer and swaps the content pane. The sidebar order +
 * grouping mirrors the Electron navigation: the everyday views first, then
 * the production/distribution verticals, then system/settings.
 *
 * The view→component mapping is injected by the caller (`App.tsx`) so this
 * file stays free of feature imports and the panel wiring lives in one place.
 * `onTransition` receives the {@link nextNav} effect tags (leave/enter) so the
 * caller can run view lifecycle (start/stop VU, refresh queries) — the layout
 * itself performs no IPC. Navigation state + clicks are unit-tested with the
 * views passed as stub nodes.
 */

/** Sidebar label key + fallback for each view (Norwegian source of truth). */
const NAV_LABELS: Record<ViewName, { key: string; fallback: string }> = {
  home: { key: "nav.home", fallback: "Hjem" },
  schedule: { key: "schedule.title", fallback: "Planlegging" },
  history: { key: "nav.history", fallback: "Historikk" },
  review: { key: "review.title", fallback: "Gjennomgang" },
  search: { key: "search.title", fallback: "Søk" },
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

/** Visual grouping of the sidebar — purely cosmetic, order = NAV order. */
const NAV_GROUPS: ReadonlyArray<{
  heading: string;
  views: readonly ViewName[];
}> = [
  { heading: "", views: ["home", "schedule", "history", "review", "search"] },
  {
    heading: "produce",
    views: ["editor", "transcribe", "publish", "streaming"],
  },
  { heading: "distribute", views: ["cloud", "email", "integrations"] },
  { heading: "system", views: ["diagnostics", "wake", "settings", "update"] },
];

export interface MainLayoutProps {
  /** A node for every view (caller wires features → components). */
  views: Record<ViewName, ReactNode>;
  /** Run the leave/enter effect tags from a navigation (optional). */
  onTransition?: (effects: {
    leave: readonly string[];
    enter: readonly string[];
    to: ViewName;
  }) => void;
  /** Starting view (defaults to home). */
  initialView?: ViewName;
  /** Top-of-sidebar slot (e.g. the language switcher). */
  header?: ReactNode;
}

export function MainLayout({
  views,
  onTransition,
  initialView,
  header,
}: MainLayoutProps) {
  const { t } = useTranslation();
  const [nav, dispatch] = useReducer(
    (state: NavState, target: ViewName): NavState => {
      const transition = nextNav(state, target);
      if (transition.changed) {
        onTransition?.({
          leave: transition.leave,
          enter: transition.enter,
          to: target,
        });
      }
      return transition.state;
    },
    initialView,
    (v) => initialNav(v),
  );

  const showView = useCallback((target: ViewName) => dispatch(target), []);

  // Let descendant views request a navigation via a DOM event (see
  // SHELL_NAVIGATE_EVENT) — the home cards use this to jump to review/history.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (isViewName(detail)) showView(detail);
    };
    window.addEventListener(SHELL_NAVIGATE_EVENT, handler);
    return () => window.removeEventListener(SHELL_NAVIGATE_EVENT, handler);
  }, [showView]);

  const groupHeading = useMemo(
    () =>
      (key: string): string => {
        switch (key) {
          case "produce":
            return t("nav.produceGroup", "Produksjon");
          case "distribute":
            return t("nav.distributeGroup", "Distribusjon");
          case "system":
            return t("nav.systemGroup", "System");
          default:
            return "";
        }
      },
    [t],
  );

  return (
    <div className="flex min-h-screen bg-bg text-text">
      {/* ── Sidebar nav ──────────────────────────────────────────────── */}
      <nav
        className="flex w-56 shrink-0 flex-col gap-4 border-r border-border bg-bg p-3"
        aria-label={t("app.name", "SundayRec")}
      >
        <div className="flex items-center justify-between px-1">
          <span className="text-sm font-semibold">
            {t("app.name", "SundayRec")}
          </span>
          {header}
        </div>
        {NAV_GROUPS.map((group) => (
          <div key={group.heading || "main"} className="flex flex-col gap-0.5">
            {group.heading && (
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide opacity-40">
                {groupHeading(group.heading)}
              </p>
            )}
            {group.views.map((view) => {
              const label = NAV_LABELS[view];
              const active = nav.current === view;
              return (
                <button
                  key={view}
                  type="button"
                  data-view={view}
                  aria-current={active ? "page" : undefined}
                  className={`rounded px-2 py-1.5 text-left text-sm transition-colors ${
                    active
                      ? "border-l-2 border-accent bg-surface2 font-medium text-accent"
                      : "text-text2 hover:bg-surface hover:text-text"
                  }`}
                  onClick={() => showView(view)}
                >
                  {t(label.key, label.fallback)}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* ── Content pane ─────────────────────────────────────────────── */}
      <main
        className="flex flex-1 flex-col items-center gap-6 overflow-y-auto p-8"
        aria-label={t(
          NAV_LABELS[nav.current].key,
          NAV_LABELS[nav.current].fallback,
        )}
      >
        {views[nav.current]}
      </main>

      {/* Global ⌘K command palette — available on every view. */}
      <CommandPalette />
    </div>
  );
}

/** The full set of view names, re-exported so callers can build the map. */
export { VIEW_NAMES };
