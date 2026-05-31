//! Google OAuth client configuration for the cloud flow (Fase 6).
//!
//! For an installed Desktop app the client id (and the "secret", which Google
//! still requires for the code exchange) are NOT confidential — Google's own
//! docs say installed-app secrets can't be kept secret. So they ship via a
//! build-time `option_env!` baked at release, or a runtime env var for dev/CI.
//! Resolved once; `None` means "cloud not configured" and the connect command
//! surfaces a clear error instead of starting a doomed flow.

/// The resolved Google OAuth client for this build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleOAuthConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
}

impl GoogleOAuthConfig {
    /// Resolve from the runtime env (`SUNDAYREC_GOOGLE_CLIENT_ID` /
    /// `SUNDAYREC_GOOGLE_CLIENT_SECRET`), falling back to values baked in at
    /// build time via the same names. `None` if no non-blank client id is found.
    pub fn resolve() -> Option<Self> {
        let id = std::env::var("SUNDAYREC_GOOGLE_CLIENT_ID")
            .ok()
            .or_else(|| option_env!("SUNDAYREC_GOOGLE_CLIENT_ID").map(str::to_string));
        let secret = std::env::var("SUNDAYREC_GOOGLE_CLIENT_SECRET")
            .ok()
            .or_else(|| option_env!("SUNDAYREC_GOOGLE_CLIENT_SECRET").map(str::to_string));
        Self::normalize(id, secret)
    }

    /// Pure construction: a blank/missing id yields `None`; a blank secret is
    /// dropped to `None` so it isn't sent as an empty `client_secret`.
    pub fn normalize(id: Option<String>, secret: Option<String>) -> Option<Self> {
        let client_id = id.filter(|s| !s.trim().is_empty())?;
        let client_secret = secret.filter(|s| !s.trim().is_empty());
        Some(Self {
            client_id,
            client_secret,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_requires_a_nonblank_id() {
        assert_eq!(GoogleOAuthConfig::normalize(None, None), None);
        assert_eq!(GoogleOAuthConfig::normalize(Some("  ".into()), None), None);
        let c = GoogleOAuthConfig::normalize(Some("id123".into()), None).unwrap();
        assert_eq!(c.client_id, "id123");
        assert_eq!(c.client_secret, None);
    }

    #[test]
    fn normalize_drops_blank_secret() {
        let c = GoogleOAuthConfig::normalize(Some("id".into()), Some("   ".into())).unwrap();
        assert_eq!(c.client_secret, None);
        let c2 = GoogleOAuthConfig::normalize(Some("id".into()), Some("s".into())).unwrap();
        assert_eq!(c2.client_secret.as_deref(), Some("s"));
    }
}
