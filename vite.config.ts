import { defineConfig } from "vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// The frontend is the ported old Electron vanilla-TS renderer under
// `legacy/renderer/`. Vite's root is that directory, so the old `index.html`
// (which loads `./api-shim.ts` + `./main.ts` and `styles.css`) is the entry and
// every relative import (`../types`, `../../types`, `../../shared`, `../locales`)
// resolves against the mirrored `legacy/{types,shared,locales}` tree unchanged.
// No React/Tailwind — the old renderer ships its own styles.css.
//
// https://vite.dev/config/
export default defineConfig(async () => ({
  root: "legacy/renderer",
  plugins: [],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./legacy"),
    },
  },

  build: {
    // Tauri's frontendDist is "../dist" (relative to src-tauri), i.e. repo-root
    // /dist. From the `legacy/renderer` root that's two levels up.
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev`
  // or `tauri build`.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
