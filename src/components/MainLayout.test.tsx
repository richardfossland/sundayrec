import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { MainLayout, SHELL_NAVIGATE_EVENT } from "./MainLayout";
import { SIDEBAR_VIEWS, VIEW_NAMES, type ViewName } from "@/lib/routing";
import i18n from "@/i18n";

/** A stub node per view so we can assert which one is mounted. */
function stubViews(): Record<ViewName, React.ReactNode> {
  return Object.fromEntries(
    VIEW_NAMES.map((v) => [v, <div key={v}>view:{v}</div>]),
  ) as Record<ViewName, React.ReactNode>;
}

beforeEach(() => {
  i18n.changeLanguage("no");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MainLayout", () => {
  it("renders the home view by default", () => {
    render(<MainLayout views={stubViews()} />);
    expect(screen.getByText("view:home")).toBeInTheDocument();
    expect(screen.queryByText("view:settings")).not.toBeInTheDocument();
  });

  it("honours an explicit initial view", () => {
    render(<MainLayout views={stubViews()} initialView="settings" />);
    expect(screen.getByText("view:settings")).toBeInTheDocument();
  });

  it("offers a sidebar button for each primary view + the settings gear", () => {
    render(<MainLayout views={stubViews()} />);
    for (const v of SIDEBAR_VIEWS) {
      expect(
        document.querySelector(`button[data-view="${v}"]`),
      ).toBeInTheDocument();
    }
    // The settings gear sits at the bottom of the sidebar.
    expect(
      document.querySelector('button[data-view="settings"]'),
    ).toBeInTheDocument();
    // Embedded-only views (reached via tabs/⌘K) are NOT in the flat sidebar.
    expect(
      document.querySelector('button[data-view="cloud"]'),
    ).not.toBeInTheDocument();
  });

  it("switches the content pane when a nav button is clicked", () => {
    render(<MainLayout views={stubViews()} />);
    fireEvent.click(document.querySelector('button[data-view="editor"]')!);
    expect(screen.getByText("view:editor")).toBeInTheDocument();
    expect(screen.queryByText("view:home")).not.toBeInTheDocument();
  });

  it("marks the active nav button with aria-current", () => {
    render(<MainLayout views={stubViews()} />);
    expect(document.querySelector('button[data-view="home"]')).toHaveAttribute(
      "aria-current",
      "page",
    );
    fireEvent.click(document.querySelector('button[data-view="search"]')!);
    expect(
      document.querySelector('button[data-view="search"]'),
    ).toHaveAttribute("aria-current", "page");
    expect(
      document.querySelector('button[data-view="home"]'),
    ).not.toHaveAttribute("aria-current");
  });

  it("emits leave/enter effects on a real transition", () => {
    const onTransition = vi.fn();
    render(<MainLayout views={stubViews()} onTransition={onTransition} />);
    // home → editor: leave home (stopVU), enter editor (reactivateEditor).
    fireEvent.click(document.querySelector('button[data-view="editor"]')!);
    expect(onTransition).toHaveBeenCalledWith({
      leave: ["stopVU"],
      enter: ["reactivateEditor"],
      to: "editor",
    });
  });

  it("does not fire effects when re-selecting the active view", () => {
    const onTransition = vi.fn();
    render(<MainLayout views={stubViews()} onTransition={onTransition} />);
    fireEvent.click(document.querySelector('button[data-view="home"]')!);
    expect(onTransition).not.toHaveBeenCalled();
  });

  it("navigates in response to the shell:navigate DOM event", () => {
    render(<MainLayout views={stubViews()} />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: "review" }),
      ),
    );
    expect(screen.getByText("view:review")).toBeInTheDocument();
  });

  it("ignores an unknown view name in the navigate event", () => {
    render(<MainLayout views={stubViews()} />);
    act(() =>
      window.dispatchEvent(
        new CustomEvent(SHELL_NAVIGATE_EVENT, { detail: "bogus" }),
      ),
    );
    expect(screen.getByText("view:home")).toBeInTheDocument();
  });

  it("renders a header slot", () => {
    render(
      <MainLayout views={stubViews()} header={<span>lang-switcher</span>} />,
    );
    expect(screen.getByText("lang-switcher")).toBeInTheDocument();
  });
});
