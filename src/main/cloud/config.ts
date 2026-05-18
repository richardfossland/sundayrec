// OAuth Client IDs — register apps and paste the IDs here:
//
// Google Drive:
//   https://console.cloud.google.com → Create project → APIs & Services → Credentials
//   → Create OAuth 2.0 Client ID → Desktop app → copy Client ID (no secret needed for PKCE)
//
// Dropbox:
//   https://www.dropbox.com/developers/apps → Create app → Files.content.write scope
//   → Settings → Redirect URIs: add "sundayrec://oauth/dropbox" → copy App key
//
// Microsoft OneDrive:
//   https://portal.azure.com → App registrations → New registration
//   → Add redirect URI: "sundayrec://oauth/onedrive" (Mobile/desktop) → copy Application (client) ID

export const CLOUD_CONFIG = {
  googleDrive: {
    clientId:    'PASTE_GOOGLE_CLIENT_ID_HERE',
    authUrl:     'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl:    'https://oauth2.googleapis.com/token',
    scope:       'https://www.googleapis.com/auth/drive.file openid email profile',
    redirectUri: 'sundayrec://oauth/google-drive',
  },
  dropbox: {
    clientId:    'PASTE_DROPBOX_APP_KEY_HERE',
    authUrl:     'https://www.dropbox.com/oauth2/authorize',
    tokenUrl:    'https://api.dropboxapi.com/oauth2/token',
    redirectUri: 'sundayrec://oauth/dropbox',
  },
  oneDrive: {
    clientId:    'PASTE_MICROSOFT_CLIENT_ID_HERE',
    authUrl:     'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl:    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope:       'Files.ReadWrite offline_access User.Read',
    redirectUri: 'sundayrec://oauth/onedrive',
  },
}
