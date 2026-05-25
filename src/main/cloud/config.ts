// OAuth Client IDs — load from environment variables (build-time via electron-vite
// define, or runtime via process.env in dev). Never commit real values.
//
// Set these in .env before building:
//   GOOGLE_CLIENT_ID=...   (https://console.cloud.google.com → Desktop OAuth client)
//   DROPBOX_APP_KEY=...    (https://www.dropbox.com/developers/apps, with sundayrec://oauth/dropbox redirect)
//   ONEDRIVE_CLIENT_ID=... (https://portal.azure.com → App registrations, with sundayrec://oauth/onedrive redirect)

// These globals are replaced at build time by electron-vite's define mechanism
// (see electron.vite.config.ts). At runtime in dev, process.env overrides them.
declare const __GOOGLE_CLIENT_ID__:     string
declare const __GOOGLE_CLIENT_SECRET__: string
declare const __DROPBOX_APP_KEY__:      string
declare const __ONEDRIVE_CLIENT_ID__:   string

function pick(envKey: string, baked: string): string {
  // Allow runtime override via env var (useful for dev and CI testing)
  const fromEnv = process.env[envKey]
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return baked
}

export const CLOUD_CONFIG = {
  googleDrive: {
    clientId:     pick('GOOGLE_CLIENT_ID',     __GOOGLE_CLIENT_ID__),
    // Google requires client_secret in token exchange even for Desktop apps with PKCE.
    // It is not truly secret for desktop apps per Google's own documentation, but
    // must be sent to satisfy the token endpoint.
    clientSecret: pick('GOOGLE_CLIENT_SECRET', __GOOGLE_CLIENT_SECRET__),
    authUrl:     'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:    'https://oauth2.googleapis.com/token',
    scope:       'https://www.googleapis.com/auth/drive.file openid email profile',
    redirectUri: 'sundayrec://oauth/google-drive',
  },
  dropbox: {
    clientId:    pick('DROPBOX_APP_KEY',    __DROPBOX_APP_KEY__),
    authUrl:     'https://www.dropbox.com/oauth2/authorize',
    tokenUrl:    'https://api.dropboxapi.com/oauth2/token',
    redirectUri: 'sundayrec://oauth/dropbox',
  },
  oneDrive: {
    clientId:    pick('ONEDRIVE_CLIENT_ID', __ONEDRIVE_CLIENT_ID__),
    authUrl:     'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl:    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:       'Files.ReadWrite offline_access User.Read',
    redirectUri: 'sundayrec://oauth/onedrive',
  },
}

/** True if the OAuth client for this service has been configured (build or env). */
export function isServiceConfigured(service: 'google-drive' | 'dropbox' | 'onedrive'): boolean {
  const id = service === 'google-drive' ? CLOUD_CONFIG.googleDrive.clientId
           : service === 'dropbox'      ? CLOUD_CONFIG.dropbox.clientId
           :                              CLOUD_CONFIG.oneDrive.clientId
  return id.length > 0 && !id.startsWith('PASTE_')
}
