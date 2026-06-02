/**
 * Shell navigation helpers — the single place that knows how a child view asks
 * the app shell to switch views.
 *
 * `MainLayout` listens for the {@link SHELL_NAVIGATE_EVENT} DOM event; screens
 * dispatch it to jump elsewhere (the Home cards → settings, the schedule card →
 * wake, the search hit → editor). Before this module that `window.dispatchEvent`
 * boilerplate was hand-written in every screen; these helpers keep the event
 * name and the detail shape in ONE place.
 */

/** The DOM event the shell listens for. The source of truth — `MainLayout`
 *  re-exports it so existing `@/components/MainLayout` imports keep working. */
export const SHELL_NAVIGATE_EVENT = "shell:navigate";

/** Ask the shell to switch to `view` (a plain view name). */
export function navigateTo(view: string): void {
  window.dispatchEvent(new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: view }));
}

/**
 * Deep-link to the Innstillinger view, optionally opening a specific `tab` and
 * flashing a specific setting `anchor` (the Home device cards use this so
 * "Endre" lands on — and highlights — exactly the right control).
 */
export function navigateToSettings(tab?: string, anchor?: string): void {
  window.dispatchEvent(
    new CustomEvent(SHELL_NAVIGATE_EVENT, {
      detail: tab
        ? { view: "settings", tab, ...(anchor ? { anchor } : {}) }
        : "settings",
    }),
  );
}
