#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# Load .env if present
ENV_FILE="$ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading $ENV_FILE"
  set -o allexport
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +o allexport
else
  echo "ERROR: $ENV_FILE not found."
  echo "Copy .env.example to .env and fill in your credentials."
  exit 1
fi

# Validate required vars
MISSING=()
for VAR in APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID CSC_IDENTITY; do
  if [[ -z "${!VAR:-}" ]]; then
    MISSING+=("$VAR")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: Missing required env vars: ${MISSING[*]}"
  exit 1
fi

# Check for duplicate certs that cause "ambiguous identity" errors with codesign.
# codesign always searches System.keychain regardless of the keychain list.
SYSTEM_KC="/Library/Keychains/System.keychain"
DUPE=$(security find-certificate -a -c "Developer ID Application: Richard Fossland" -Z "$SYSTEM_KC" 2>/dev/null | awk '/SHA-1 hash:/ {print $3}' || true)
if [[ -n "$DUPE" ]]; then
  echo ""
  echo "ERROR: Duplicate Developer ID certificate found in System.keychain (SHA1: $DUPE)"
  echo "This causes codesign to fail with 'ambiguous identity'."
  echo ""
  echo "Run this ONE-TIME command to remove it (requires your Mac password):"
  echo ""
  echo "  sudo security delete-certificate -Z $DUPE $SYSTEM_KC"
  echo ""
  echo "Then run 'npm run build:mac' again."
  exit 1
fi

cd "$ROOT"
echo "Building SundayRec for macOS (signing + notarizing)…"
npm run build
electron-builder --mac
