import { describe, expect, it } from "vitest";

import no from "@/locales/no.json";
import en from "@/locales/en.json";
import de from "@/locales/de.json";
import sv from "@/locales/sv.json";
import da from "@/locales/da.json";
import fr from "@/locales/fr.json";
import pl from "@/locales/pl.json";

/**
 * i18n PARITY GUARD.
 *
 * Every shipped catalog must expose exactly the same set of leaf keys. `no` is
 * the canonical source of truth; `en` is the canonical *English* fallback the
 * UI falls back to when a key is somehow missing at runtime. Drift in either
 * direction (a key added to one catalog but not the others, or a typo'd key)
 * silently degrades the UI to raw key strings in some languages, so we fail
 * the build the moment the key sets diverge.
 */

type Json = Record<string, unknown>;

/** Flatten a nested catalog to dotted leaf keys (`a.b.c`). Arrays are leaves. */
function flatKeys(
  obj: Json,
  prefix = "",
  out = new Set<string>(),
): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      flatKeys(v as Json, key, out);
    } else {
      out.add(key);
    }
  }
  return out;
}

const CATALOGS: Record<string, Json> = { no, en, sv, da, de, fr, pl };

describe("i18n parity", () => {
  const reference = flatKeys(no as Json);

  it("ships seven catalogs", () => {
    expect(Object.keys(CATALOGS)).toHaveLength(7);
  });

  it("every catalog has a non-trivial number of keys", () => {
    // Guards against an empty/partial JSON sneaking in.
    expect(reference.size).toBeGreaterThan(500);
  });

  for (const [lang, catalog] of Object.entries(CATALOGS)) {
    it(`${lang} shares the exact same key set as the canonical 'no' catalog`, () => {
      const keys = flatKeys(catalog);
      const missing = [...reference].filter((k) => !keys.has(k));
      const extra = [...keys].filter((k) => !reference.has(k));
      // Report the actual divergence so a failure is self-explanatory.
      expect({ lang, missing, extra }).toEqual({
        lang,
        missing: [],
        extra: [],
      });
    });
  }

  it("no two catalogs differ in size (fast cross-check)", () => {
    const sizes = Object.fromEntries(
      Object.entries(CATALOGS).map(([l, c]) => [l, flatKeys(c).size]),
    );
    const unique = new Set(Object.values(sizes));
    expect({ sizes, uniqueSizes: unique.size }).toEqual({
      sizes,
      uniqueSizes: 1,
    });
  });
});
