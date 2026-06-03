// Normalise ts-rs cross-crate imports in the generated bindings.
//
// ts-rs computes the relative import between two types from their `export_to`
// paths. Our types live in TWO crates (`src-tauri` and `crates/sundayrec-core`)
// whose `export_to` are anchored at different depths, so when a `src-tauri` type
// imports a `sundayrec-core` type ts-rs emits a path that escapes the repo, e.g.
//   import type { ChannelMode } from "../../../../src/lib/bindings/ChannelMode";
// That resolves to `<repo>/../src/lib/bindings/...` (outside the checkout), so it
// builds locally (where a stray copy exists) but fails on a clean CI checkout
// with TS2307. Every binding actually lives in this one directory, so the import
// is always a sibling. Rewrite any `(…/)*src/lib/bindings/Name` import to
// `./Name`. Idempotent; run as the last step of `npm run bindings`.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "lib",
  "bindings",
);
// `from "../../.../src/lib/bindings/Name"` (one or more `../`) → `from "./Name"`.
const BAD = /from "(?:\.\.\/)+src\/lib\/bindings\/([A-Za-z0-9_]+)"/g;

let fixed = 0;
for (const file of readdirSync(dir)) {
  if (!file.endsWith(".ts")) continue;
  const path = join(dir, file);
  const src = readFileSync(path, "utf8");
  const out = src.replace(BAD, 'from "./$1"');
  if (out !== src) {
    writeFileSync(path, out);
    fixed++;
  }
}
console.log(`fix-bindings-imports: normalised ${fixed} file(s).`);
