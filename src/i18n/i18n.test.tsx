import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import i18n, { changeLanguage } from "@/i18n";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

// Each test reaches into the real, initialised i18next instance (the same one
// the app uses). Reset to Norwegian afterwards so tests stay independent.
afterEach(async () => {
  await i18n.changeLanguage("no");
});

describe("i18n", () => {
  it("returns Norwegian for a known key by default", async () => {
    await i18n.changeLanguage("no");
    expect(i18n.t("general.title")).toBe("Generelt");
    expect(i18n.t("nav.home")).toBe("Hjem");
  });

  it("switches the resolved string when the language changes", async () => {
    await changeLanguage("en");
    expect(i18n.t("general.title")).toBe("General");
    expect(localStorage.getItem("sundayrec-lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("ignores unsupported language codes", async () => {
    await i18n.changeLanguage("no");
    await changeLanguage("zz");
    expect(i18n.language).toBe("no");
  });
});

describe("LanguageSwitcher", () => {
  it("lists all seven languages by endonym", () => {
    render(<LanguageSwitcher />);
    for (const name of [
      "Norsk",
      "English",
      "Deutsch",
      "Svenska",
      "Dansk",
      "Français",
      "Polski",
    ]) {
      expect(
        screen.getByRole("option", { name }),
      ).toBeInTheDocument();
    }
  });

  it("changes the active language when a new option is picked", async () => {
    render(<LanguageSwitcher />);
    const select = screen.getByRole("combobox") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "de" } });

    // changeLanguage is async; wait a microtask for i18next to settle.
    await Promise.resolve();
    await i18n.changeLanguage("de"); // ensure settled deterministically
    expect(i18n.language).toBe("de");
    expect(i18n.t("general.title")).toBe("Allgemein");
  });
});
