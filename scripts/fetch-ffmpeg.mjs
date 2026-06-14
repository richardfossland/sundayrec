#!/usr/bin/env node
// Copy static ffmpeg + ffprobe into src-tauri/binaries/ with the Rust
// target-triple suffix Tauri's `externalBin` expects (e.g.
// ffmpeg-aarch64-apple-darwin). Run before `tauri build`, both locally and
// in CI (each platform's runner copies its own binaries).
//
// Binaries come from the `ffmpeg-static` + `@ffprobe-installer/ffprobe` npm
// packages — GPL/LGPL ffmpeg builds. See docs/DISTRIBUTION.md for the
// licensing note before any public release.
//
// `ffmpeg-static` does NOT ship its binary inside the npm tarball — a
// postinstall step downloads it from GitHub Releases, which is not
// integrity-checked. On CI that download is occasionally truncated or
// rate-limited, leaving a file that exists but cannot execute. The old script
// copied it blindly and printed `✓`, then every ffmpeg integration test
// panicked (`health.available == false`) and a release build would have
// bundled a broken sidecar. So: VERIFY each binary actually runs, and
// re-download ffmpeg-static (its installer is idempotent) before giving up.

import { execSync, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, chmodSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "binaries");

// Rust host triple — what `externalBin` matches against.
const host = execSync("rustc -vV", { encoding: "utf8" })
  .split("\n")
  .find((l) => l.startsWith("host:"))
  .slice("host:".length)
  .trim();
const ext = host.includes("windows") ? ".exe" : "";

// `<bin> -version` exits 0 and names itself — the cheapest proof the file is a
// real, runnable executable for this arch, not a truncated download or an HTML
// error page saved under the binary's name. spawnSync never throws and runs no
// shell, so paths with spaces are safe.
function runs(bin, name) {
  if (!bin || !existsSync(bin)) return false;
  const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
  return (
    !r.error &&
    r.status === 0 &&
    `${r.stdout}${r.stderr}`.toLowerCase().includes(name)
  );
}

mkdirSync(outDir, { recursive: true });

// ffmpeg-static's installer sits next to the binary it resolves to and is
// idempotent — re-run it when the downloaded binary is unusable (flaky CI
// download). ffprobe ships inside its own tarball, so a broken one is a real
// install problem — the runs() gate below fails it loudly rather than looping.
// Path is stable across re-downloads (the installer writes the same file), so
// `const` holds even though the loop may re-run the installer to repopulate it.
const ffmpegSrc = require("ffmpeg-static");
const ffmpegInstaller = join(dirname(ffmpegSrc), "install.js");
for (let attempt = 1; !runs(ffmpegSrc, "ffmpeg") && attempt <= 3; attempt++) {
  console.warn(
    `⚠ ffmpeg-static binary missing or unrunnable — re-downloading (attempt ${attempt}/3)`,
  );
  try {
    execFileSync(process.execPath, [ffmpegInstaller], { stdio: "inherit" });
  } catch {
    /* spend the retry budget; the runs() check is the real gate */
  }
}

for (const [name, src] of [
  ["ffmpeg", ffmpegSrc],
  ["ffprobe", require("@ffprobe-installer/ffprobe").path],
]) {
  if (!runs(src, name)) {
    console.error(
      `✗ ${name}: source binary missing or unrunnable (${src}).\n` +
        `  Run \`npm install\`; if this is CI, the GitHub Releases download for\n` +
        `  ffmpeg-static likely failed — re-run the job.`,
    );
    process.exit(1);
  }
  const dest = join(outDir, `${name}-${host}${ext}`);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(
    `✓ ${name} → src-tauri/binaries/${name}-${host}${ext} (verified runnable)`,
  );
}
