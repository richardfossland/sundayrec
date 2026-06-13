# Distribution & auto-update

SundayRec ships as installers for macOS and Windows via GitHub Releases. The
release pipeline (`.github/workflows/release.yml`) is in place; making it
**signed + auto-updating** is a matter of **secrets and accounts only you can
provide**. This doc is the checklist.

## How it works

1. You bump the version (in `package.json`, `src-tauri/tauri.conf.json`, and
   `src-tauri/Cargo.toml` — keep them in sync) and push a tag `vX.Y.Z`.
2. `release.yml` builds on macOS (Apple Silicon) and Windows, fetches the
   ffmpeg/ffprobe sidecars, signs + notarizes macOS (once the secrets exist),
   and creates a **draft** GitHub Release with the installers attached.
3. You review the draft and publish it.

> **Deploy gotcha (same as the Electron SundayRec):** the build uploads as a
> **draft / prerelease**. "Publishing" is a separate manual step — review the
> draft, then mark it published/latest. A built-but-unpublished release is not
> served to anyone.

## Phase status

| Capability                   | State                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| Build macOS + Windows on tag | ✅ wired (`release.yml`)                                                              |
| macOS signing + notarization | 🔑 activates when the Apple secrets below are added                                   |
| Windows signing              | ⏳ deferred (unsigned installer works; SmartScreen warns)                             |
| Auto-update (`latest.json`)  | ✅ plugin + pubkey + `includeUpdaterJson` wired; needs only `TAURI_SIGNING_*` secrets |

Until the Apple secrets are added, the workflow still runs and produces
**unsigned** installers (tauri-action skips signing when the secrets are
absent). Unsigned apps warn on first launch: macOS → right-click ▸ Open;
Windows → "More info" ▸ "Run anyway".

## Required GitHub repository secrets

Settings → Secrets and variables → Actions → New repository secret.

### macOS code signing + notarization

You already do this for the Electron SundayRec, so the same Developer ID cert
and credentials apply.

| Secret                       | Value                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of your "Developer ID Application" cert exported as `.p12`: `base64 -i cert.p12 \| pbcopy`.                           |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12`.                                                                              |
| `APPLE_SIGNING_IDENTITY`     | e.g. `Developer ID Application: Richard Fossland (TEAMID)`. Find it with `security find-identity -v -p codesigning`.         |
| `APPLE_ID`                   | Your Apple Developer account email.                                                                                          |
| `APPLE_PASSWORD`             | An **app-specific password** (appleid.apple.com → Sign-In and Security → App-Specific Passwords), not your account password. |
| `APPLE_TEAM_ID`              | Your 10-character Apple Team ID.                                                                                             |

### Auto-update signing (Phase 9 — not needed yet)

The updater is off until Phase 9. When you get there:

1. Install the plugin: `npm run tauri add updater`.
2. Generate the keypair (store the private key safely, **never** in the repo):
   ```bash
   npm run tauri signer generate -- -w ~/.tauri/sundayrec_updater.key
   ```
3. Put the **public** key in `tauri.conf.json` under `plugins.updater.pubkey`
   and configure the `endpoints` to the GitHub `latest` release.
4. Add these secrets and flip `includeUpdaterJson: true` in `release.yml`:

| Secret                               | Value                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`          | Contents of `~/.tauri/sundayrec_updater.key`: `cat ~/.tauri/sundayrec_updater.key \| pbcopy`, then paste. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you set for that key (empty string if generated without one).                                |

> Keep the private key safe — losing it means existing installs can no longer
> auto-update (they'd need a manual reinstall with a new key).

### Windows code signing (deferred)

Not wired yet — the Windows installer is currently unsigned (it works, but
SmartScreen warns). Adding an EV/OV code-signing cert + the matching secrets is
a later task.

## Cut a release

```bash
# bump version in package.json AND src-tauri/tauri.conf.json AND src-tauri/Cargo.toml
git tag v0.1.0
git push origin v0.1.0
# → watch the run, review the draft Release, then publish it.
```

## CI (every push / PR)

`.github/workflows/ci.yml` runs on `main` pushes and PRs: frontend
lint/format/typecheck/tests, Rust fmt/clippy/tests across the workspace, a
ts-rs bindings drift check, and a `--no-bundle` compile of the whole app on
Linux. No secrets required.
