# Release checklist — SundayRec (Tauri)

Single, current-state launchpad. The code is gate-green (918 Rust tests; `npm run
check` passes). Everything below that is **not** a code change is an owner action
(secrets / accounts / signing) or a rig verification. Distilled from
`NEEDS-RICHARD.md`, `DISTRIBUTION.md`, `RELEASE-AUDIT.md`, `SMOKE-TEST.md`.

## State of the release pipeline (verified in repo)

| Item                                                             | State                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| Build macOS + Windows on tag (`release.yml`)                     | ✅ wired                                                  |
| Auto-updater plugin + pubkey + endpoints (`tauri.conf.json`)     | ✅ wired                                                  |
| `includeUpdaterJson: true` in `release.yml`                      | ✅ set                                                    |
| `sundayrec://` deep-link scheme registered (config + Info.plist) | ✅ config done — GUI-UNVERIFIED                           |
| ts-rs bindings drift                                             | ✅ 0 diff (`npm run bindings`)                            |
| macOS signing + notarization                                     | 🔑 needs Apple secrets                                    |
| Updater signing                                                  | 🔑 needs `TAURI_SIGNING_*` secrets                        |
| Windows signing                                                  | ⏳ deferred (unsigned installer works; SmartScreen warns) |

## 1. Unblock CI (P0 — gates everything else)

- [ ] **GitHub Actions billing**: `ci.yml` and `release.yml` run on Actions and
      cannot start while the spending limit is frozen. Raise it / fix payment,
      then re-run on a tag. Fallback while blocked: local `tauri build` (see
      `RELEASE-AUDIT.md`).

## 2. macOS signing + notarization (Apple secrets)

Settings → Secrets and variables → Actions. Team ID **784GN847G4** is on file.

- [ ] `APPLE_CERTIFICATE` — base64 of the "Developer ID Application" `.p12`.
      ⚠️ The `.p12` on the Desktop reportedly has the **wrong password** —
      re-export from Keychain Access with a known password first.
- [ ] `APPLE_CERTIFICATE_PASSWORD` — the new export password.
- [ ] `APPLE_SIGNING_IDENTITY` — `Developer ID Application: … (784GN847G4)`.
- [ ] `APPLE_ID` — Apple Developer account email.
- [ ] `APPLE_PASSWORD` — an **app-specific** password. ⚠️ The previous one was
      **leaked in chat** — revoke it at appleid.apple.com → Sign-In and Security
      → App-Specific Passwords, generate a fresh one, store only as this secret.
- [ ] `APPLE_TEAM_ID` — `784GN847G4`.

## 3. Auto-update signing (plugin already wired — only secrets remain)

The keypair already exists (key-id `4f08a2f48edd9a17`, backup
`~/.tauri/sundayrec_updater.key`; pubkey is in `tauri.conf.json`). Just add:

- [ ] `TAURI_SIGNING_PRIVATE_KEY` — `cat ~/.tauri/sundayrec_updater.key`.
- [ ] `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its password (empty if none).

> Losing the private key breaks auto-update for installed users — keep the backup.

## 4. Optional runtime features (not build blockers)

- [ ] **Google OAuth client (Desktop type)** for cloud backup + Gmail email path
      → `SUNDAYREC_GOOGLE_CLIENT_ID` (see `GOOGLE-OAUTH-SETUP.md`).
- [ ] **Anthropic API key** (OS keychain) for the live AI sermon-companion
      summary — the keyless extractive path works without it.

## 5. Cut the release

- [ ] Bump version in lockstep: `package.json`, `src-tauri/tauri.conf.json`,
      `src-tauri/Cargo.toml`.
- [ ] `git tag vX.Y.Z && git push origin vX.Y.Z`.
- [ ] Watch the run; it produces a **draft** Release. **Publishing is a separate
      manual step** — review the draft, then mark it published/latest (same
      gotcha as the Electron SundayRec; a draft is served to no one).

## 6. Rig sign-off before publishing (needs hardware — `SMOKE-TEST.md`)

- [ ] §2–11 smoke test on a real Mac/Windows rig (capture, VU, editor ffmpeg,
      whisper, wake/scheduler, streaming).
- [ ] **Deep-link**: after a signed `tauri build`, open `sundayrec://…` and
      confirm it routes into the app (the config is in place but GUI-UNVERIFIED;
      requires the `tray` feature, which release builds include).
