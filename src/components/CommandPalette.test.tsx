import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CommandPalette, fuzzyMatch } from "./CommandPalette";
import { SHELL_NAVIGATE_EVENT } from "./MainLayout";
import i18n from "@/i18n";

// CommandPalette has no Tauri IPC, but mock the bridge so an accidental import
// chain never reaches a real `invoke`/`listen`.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

/** Fire the global ⌘K shortcut. */
function pressCmdK() {
  act(() => {
    fireEvent.keyDown(window, { key: "k", metaKey: true });
  });
}

beforeEach(() => {
  i18n.changeLanguage("no");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fuzzyMatch", () => {
  it("matches an in-order subsequence, case-insensitively", () => {
    expect(fuzzyMatch("Planlegging", "plan")).toBe(true);
    expect(fuzzyMatch("Sky-backup", "sky")).toBe(true);
    expect(fuzzyMatch("Historikk", "hsk")).toBe(true);
  });

  it("rejects characters that are out of order or absent", () => {
    expect(fuzzyMatch("Hjem", "xyz")).toBe(false);
    expect(fuzzyMatch("Hjem", "mhj")).toBe(false);
  });

  it("matches everything for an empty query", () => {
    expect(fuzzyMatch("anything", "")).toBe(true);
  });
});

describe("CommandPalette", () => {
  it("is hidden until ⌘K is pressed", () => {
    render(<CommandPalette />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    pressCmdK();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("toggles closed on a second ⌘K", () => {
    render(<CommandPalette />);
    pressCmdK();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    pressCmdK();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<CommandPalette />);
    pressCmdK();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("filters views by the typed query", () => {
    render(<CommandPalette />);
    pressCmdK();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "sky" },
    });
    expect(
      document.querySelector('button[data-palette-view="cloud"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('button[data-palette-view="home"]'),
    ).not.toBeInTheDocument();
  });

  it("navigates to the chosen view on click, via the shell event", () => {
    const onNav = vi.fn();
    window.addEventListener(SHELL_NAVIGATE_EVENT, onNav);
    render(<CommandPalette />);
    pressCmdK();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "sky" },
    });
    fireEvent.click(
      document.querySelector('button[data-palette-view="cloud"]')!,
    );
    expect(onNav).toHaveBeenCalledTimes(1);
    expect((onNav.mock.calls[0][0] as CustomEvent).detail).toBe("cloud");
    // Selecting a command closes the palette.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    window.removeEventListener(SHELL_NAVIGATE_EVENT, onNav);
  });

  it("navigates with arrow keys + Enter", () => {
    const onNav = vi.fn();
    window.addEventListener(SHELL_NAVIGATE_EVENT, onNav);
    render(<CommandPalette />);
    pressCmdK();
    const input = screen.getByRole("textbox");
    // First result is "home"; ArrowDown moves to "schedule".
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((onNav.mock.calls[0][0] as CustomEvent).detail).toBe("schedule");
    window.removeEventListener(SHELL_NAVIGATE_EVENT, onNav);
  });

  it("removes the global keydown listener on unmount", () => {
    const { unmount } = render(<CommandPalette />);
    unmount();
    // After unmount the shortcut must not reopen anything.
    pressCmdK();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
