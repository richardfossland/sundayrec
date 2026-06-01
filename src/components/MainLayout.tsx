import { useCallback, useEffect, useReducer, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  initialNav,
  isViewName,
  nextNav,
  SIDEBAR_VIEWS,
  VIEW_NAMES,
  type NavState,
  type ViewName,
} from "@/lib/routing";
import { CommandPalette } from "@/components/CommandPalette";
import { Icon, type IconName } from "@/design/Icon";

/**
 * Custom DOM event a child view dispatches to ask the shell to switch views
 * (e.g. the home review-card → `review`). Decouples deep children from the
 * layout's reducer without prop-drilling a navigate callback.
 */
export const SHELL_NAVIGATE_EVENT = "shell:navigate";

/**
 * The app shell — the macOS desktop window from the redesign (`sr-shell.jsx` +
 * `tokens.css`). A titlebar (traffic lights + active-section title), a branded
 * sidebar with icon nav + a pinned Settings gear + the live status footer, and
 * a centred content pane (`.sr-content`, the fix for "flyter ut når vinduet
 * skaleres"). The redesigned screens render their own `.sr-content`; the shell
 * only provides the window chrome.
 *
 * The view→component mapping is injected by the caller (`App.tsx`) so this
 * file stays free of feature imports. `onTransition` receives the
 * {@link nextNav} effect tags so the caller can run view lifecycle; the layout
 * itself performs no IPC. Navigation + the `data-view` button contract are
 * unit-tested with stub views.
 */

/** Sidebar label key + fallback for each view (Norwegian source of truth). */
const NAV_LABELS: Record<ViewName, { key: string; fallback: string }> = {
  home: { key: "nav.home", fallback: "Hjem" },
  schedule: { key: "nav.schedule", fallback: "Tidsplan" },
  history: { key: "nav.history", fallback: "Historikk" },
  review: { key: "review.title", fallback: "Gjennomgang" },
  search: { key: "search.title", fallback: "Søk" },
  editor: { key: "nav.edit", fallback: "Rediger" },
  transcribe: { key: "transcribe.title", fallback: "Transkribering" },
  publish: { key: "publish.title", fallback: "Publisering" },
  streaming: { key: "nav.live", fallback: "Direkte" },
  cloud: { key: "cloud.title", fallback: "Sky-backup" },
  email: { key: "email.title", fallback: "E-postvarsler" },
  integrations: { key: "integrations.title", fallback: "Integrasjoner" },
  diagnostics: { key: "diagnostics.title", fallback: "Diagnose" },
  wake: { key: "wake.title", fallback: "Vekking fra dvale" },
  settings: { key: "nav.settings", fallback: "Innstillinger" },
  update: { key: "general.updates", fallback: "Oppdateringer" },
};

/** Line-icon per sidebar view (matches `SR_NAV` in the design's `sr-shell`). */
const NAV_ICON: Record<(typeof SIDEBAR_VIEWS)[number] | "settings", IconName> =
  {
    home: "home",
    schedule: "calendar",
    streaming: "live",
    editor: "edit",
    search: "search",
    settings: "gear",
  };

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
  /** Titlebar slot (e.g. the language switcher). */
  header?: ReactNode;
  /** Bottom-of-sidebar slot (e.g. the live next-recording status line). */
  footer?: ReactNode;
}

export function MainLayout({
  views,
  onTransition,
  initialView,
  header,
  footer,
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

  const navItemClass = (view: ViewName) =>
    "sr-navitem" + (nav.current === view ? " is-active" : "");

  return (
    <div className="sr-win">
      {/* ── Titlebar ─────────────────────────────────────────────────────────
          The native macOS traffic-lights overlay this dark bar (window uses
          `titleBarStyle: "Overlay"`), so we draw NO fake lights — just a
          draggable strip with left room for the real ones, the active-section
          title, and the header slot. */}
      <div
        className="sr-titlebar"
        data-tauri-drag-region
        style={{ paddingLeft: 80 }}
      >
        <div className="sr-wintitle">
          {t(NAV_LABELS[nav.current].key, NAV_LABELS[nav.current].fallback)}
        </div>
        {header && (
          <div style={{ marginLeft: "auto", zIndex: 6 }}>{header}</div>
        )}
      </div>

      {/* ── App body = sidebar + main ────────────────────────────────────── */}
      <div className="sr-app">
        <aside className="sr-sidebar" aria-label={t("app.name", "SundayRec")}>
          <div className="sr-brand">
            <div
              className="sr-brand-mark"
              style={{ backgroundImage: "url(/sundayrec-logo.jpg)" }}
            />
            <div className="sr-brand-name">{t("app.name", "SundayRec")}</div>
          </div>

          {/* Flat primary nav — the five everyday pages (Electron-parity). */}
          <nav className="sr-nav">
            {SIDEBAR_VIEWS.map((view) => {
              const label = NAV_LABELS[view];
              const active = nav.current === view;
              return (
                <button
                  key={view}
                  type="button"
                  data-view={view}
                  aria-current={active ? "page" : undefined}
                  className={navItemClass(view)}
                  onClick={() => showView(view)}
                >
                  <Icon
                    name={NAV_ICON[view]}
                    size={19}
                    fill={view === "streaming" && active}
                  />
                  <span>{t(label.key, label.fallback)}</span>
                </button>
              );
            })}
          </nav>

          {/* Spacer pushes Settings + status to the bottom. */}
          <div className="sr-sidebar-spacer" />

          <div className="sr-sidebar-foot">
            {/* Settings gear — the tabbed hub holding everything else. */}
            <button
              type="button"
              data-view="settings"
              aria-current={nav.current === "settings" ? "page" : undefined}
              className={navItemClass("settings")}
              onClick={() => showView("settings")}
            >
              <Icon name={NAV_ICON.settings} size={19} />
              <span>
                {t(NAV_LABELS.settings.key, NAV_LABELS.settings.fallback)}
              </span>
            </button>

            {/* Live status (next recording + version) — always visible. */}
            {footer && <div className="sr-status">{footer}</div>}
          </div>
        </aside>

        {/* ── Content pane ───────────────────────────────────────────────── */}
        <main
          className="sr-main"
          aria-label={t(
            NAV_LABELS[nav.current].key,
            NAV_LABELS[nav.current].fallback,
          )}
        >
          <div className="sr-scroll">{views[nav.current]}</div>
        </main>
      </div>

      {/* Global ⌘K command palette — available on every view. */}
      <CommandPalette />
    </div>
  );
}

/** The full set of view names, re-exported so callers can build the map. */
export { VIEW_NAMES };
