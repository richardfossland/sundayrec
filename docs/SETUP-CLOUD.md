# Cloud + Podcast Setup (Advanced / Developer Guide)

> **Audience:** developers, IT departments, or large churches who want to build SundayRec from source with their own OAuth credentials.
>
> If you are a volunteer who just wants to use SundayRec, you do **not** need this document — the official binaries from the [releases page](https://github.com/richardfossland/sundayrec/releases/latest) work out of the box. Use the [Quick Start Guide](QUICK-START.md) instead.

---

## Why this matters

The official SundayRec binaries ship with OAuth client IDs that the author has registered with Google, Dropbox and Microsoft. There are good reasons to register your own instead:

1. **OAuth quotas.** Each OAuth app has rate limits. Heavy users — large multi-site churches, denominational backup services — can hit them.
2. **Branding.** The OAuth consent screen shows the *app name*. If you fork SundayRec for your denomination ("Norkirken Recording", say), the consent screen should say that.
3. **Ownership.** If you go through Google's app verification, your church (not the SundayRec author) is the legal data processor.
4. **Auditing.** Your IT department can see exactly which scopes are used and who has authorised the app.

If none of those apply, just use the official build.

---

## Architecture overview

SundayRec uses **OAuth 2.0 with PKCE** for desktop authentication. Tokens are stored locally and encrypted with the OS keystore (Keychain on macOS, DPAPI on Windows). There is no SundayRec server in the loop — your app talks directly to Google / Dropbox / Microsoft.

The OAuth callback uses a custom URL scheme: `sundayrec://oauth/<provider>`. macOS and Windows both natively support this through the protocol registration in `package.json` (`build.protocols`).

```
┌──────────┐     1. open browser     ┌────────────────┐
│SundayRec │ ───────────────────────→│ Google/Dropbox │
│ (Mac/PC) │                         │   /Microsoft   │
│          │ ←───────────────────────│                │
└──────────┘    2. sundayrec://       └────────────────┘
                  oauth/<provider>?code=...
                  3. exchange code for tokens
                  4. encrypt with safeStorage → disk
```

---

## Google Drive

### 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>
2. Create a new project (e.g. "MyChurch SundayRec")
3. Enable the **Google Drive API** under *APIs & Services → Library*

### 2. Configure the OAuth consent screen

1. *APIs & Services → OAuth consent screen*
2. Choose **External**
3. App name: "MyChurch SundayRec" (this is what users see in the consent dialog)
4. User support email: your email
5. Authorised domains: leave empty (this is a desktop app)
6. Scopes — add only:
   - `https://www.googleapis.com/auth/drive.file` (per-file access; the app can only see files it created)
7. Submit for verification when ready for production use (development users will see "unverified app" warnings until then — capped at 100 users)

### 3. Create OAuth credentials

1. *APIs & Services → Credentials → Create credentials → OAuth client ID*
2. Application type: **Desktop app**
3. Note both the **Client ID** and **Client Secret**

> Google requires a client secret even for desktop apps with PKCE. It is not actually secret in the cryptographic sense — it ends up in the compiled binary. PKCE is what prevents the confused-deputy attack.

### 4. Add to `.env`

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
```

---

## Dropbox

### 1. Create an app

1. Go to <https://www.dropbox.com/developers/apps>
2. **Create app**
3. API: **Scoped access**
4. Type: **App folder** (cleanest) or **Full Dropbox** (less restrictive)
5. Name: e.g. "MyChurch SundayRec"

### 2. Configure scopes

Under the **Permissions** tab, enable:

- `files.content.write` (upload files)
- `files.content.read` (read back for verification)
- `files.metadata.read`

Click **Submit**.

### 3. Add the redirect URI

Under the **Settings** tab → **OAuth 2 → Redirect URIs**, add:

```
sundayrec://oauth/dropbox
```

### 4. Add to `.env`

```bash
DROPBOX_APP_KEY=your-app-key
```

Dropbox PKCE flow does not require an app secret in the desktop client, so you only need the app key.

---

## Microsoft OneDrive

> **Note:** OneDrive is in the codebase (`src/main/cloud/onedrive.ts`) but currently hidden from the UI pending Microsoft app verification. Re-enabling it requires uncommenting the UI element in `src/renderer/pages/files-page.ts` and rebuilding.

### 1. Register an Azure AD app

1. Go to <https://portal.azure.com/> → **Azure Active Directory** → **App registrations**
2. **New registration**
3. Name: "MyChurch SundayRec"
4. Supported account types: **Personal Microsoft accounts and accounts in any organisational directory** (multi-tenant + personal)
5. Redirect URI: select **Public client/native (mobile & desktop)** and enter:
   ```
   sundayrec://oauth/onedrive
   ```

### 2. Configure API permissions

Under **API permissions → Add a permission → Microsoft Graph → Delegated permissions**:

- `Files.ReadWrite`
- `offline_access`
- `User.Read`

### 3. Allow public client flows

Under **Authentication → Advanced settings → Allow public client flows** → set to **Yes** (required for the desktop PKCE flow).

### 4. Add to `.env`

```bash
ONEDRIVE_CLIENT_ID=your-application-client-id-guid
```

---

## Local development

1. Copy `.env.example` to `.env` and fill in the values above
2. `npm install`
3. `npm run dev`

The values from `.env` are baked into the build by `electron-vite` at build time — they do not need to be present at runtime.

---

## CI / GitHub Actions builds

To produce signed installers from CI with your own OAuth credentials, add these as GitHub Secrets in your fork:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `DROPBOX_APP_KEY`
- `ONEDRIVE_CLIENT_ID`

Plus the Apple signing secrets (see `.env.example` for full list):

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `CSC_LINK` (base64 of your `.p12`)
- `CSC_KEY_PASSWORD`

The workflow at `.github/workflows/build.yml` reads these as environment variables and passes them to `electron-vite`.

---

## Common gotchas

### "App not verified" on Google consent screen

Google requires a verification review for OAuth apps that access user data. Until verification, your app is capped at 100 users and shows a yellow "Continue (unsafe)" warning. Verification can take **2–4 weeks** and requires:

- A homepage URL (e.g. `https://sundayrec.com`)
- A privacy policy URL (use `PRIVACY.md` rendered on a public URL)
- A demo video showing the OAuth flow
- Domain verification through Search Console

### Dropbox "team admin must approve"

If your church uses Dropbox Business, an admin may need to approve the OAuth app for the team. Solo accounts and family plans don't have this restriction.

### Microsoft "AADSTS50194" — application is not configured as multi-tenant

If you registered the app as single-tenant but want to allow personal Microsoft accounts, change the supported account types under **Authentication** in the Azure portal.

### Redirect URI mismatch

The redirect URI in the OAuth provider's configuration must match the one in `src/main/cloud/oauth.ts` *exactly* — including trailing slashes and the `sundayrec://` scheme.

### Token refresh failing silently

If users report they get logged out after a few hours, check that you requested the right scopes:

- Google: scope `drive.file` (granular per-file access)
- Dropbox: nothing extra needed — refresh tokens are issued automatically
- Microsoft: scope `offline_access` is required to get a refresh token

---

## Need help?

If something in this guide is unclear or outdated, open an issue at <https://github.com/richardfossland/sundayrec/issues> or email **hello@sundayrec.com**. We try to keep this document current with the codebase, but OAuth provider UIs change frequently.
