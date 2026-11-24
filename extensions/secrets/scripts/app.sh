#!/bin/sh
# The Secrets app, built and signed as Switch's own apps are: with the Developer ID and notary key
# named in the machine's ~/.switch/deploy.json (identity, team, keychain, keychainPassFile,
# notaryKey, notaryKeyId, notaryIssuer, appId), never in this repo. Without an identity it builds
# unsigned. Its bundle id is $SECRETS_APP_ID, else <appId>.secrets.
#   scripts/app.sh             build/stable-macos-arm64/Secrets.app
#   scripts/app.sh install     and put it in /Applications
#   scripts/app.sh dev         a dev build (build/dev-macos-arm64), for testing
set -eu
S=$HOME/.switch
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
cd "$(dirname "$0")/.."

ENV=stable
if [ "${1:-}" = dev ]; then ENV=dev; fi
IDENTITY=$(conf identity)
APP_ID=$(conf appId)
KEYCHAIN=$(expand "$(conf keychain)")
KEYCHAIN_PASS=$(expand "$(conf keychainPassFile)")
if [ -n "$KEYCHAIN" ] && [ -f "$KEYCHAIN_PASS" ]; then
  security unlock-keychain -p "$(cat "$KEYCHAIN_PASS")" "$KEYCHAIN"
fi
if [ -n "$IDENTITY" ]; then
  export ELECTROBUN_DEVELOPER_ID="$IDENTITY"
  export ELECTROBUN_TEAMID="$(conf team)"
  NOTARY_KEY_ID=$(conf notaryKeyId)
  if [ -n "$NOTARY_KEY_ID" ]; then
    export ELECTROBUN_APPLEAPIKEY="$NOTARY_KEY_ID"
    export ELECTROBUN_APPLEAPIKEYPATH="$(expand "$(conf notaryKey)")"
    export ELECTROBUN_APPLEAPIISSUER="$(conf notaryIssuer)"
  fi
fi
if [ -z "${SECRETS_APP_ID:-}" ] && [ -n "$APP_ID" ]; then
  export SECRETS_APP_ID="$APP_ID.secrets"
fi
export SECRETS_APP_VERSION="0.1.$(date +%s)"

bunx electrobun prepare >/dev/null
bunx vite build
# The native helper (Touch ID, the concealed clipboard, the global shortcut), signed for the
# hardened runtime so the bundle notarizes.
swiftc -O -o dist/secrets-helper app/helper/main.swift
if [ -n "$IDENTITY" ]; then
  codesign --force --options runtime --timestamp -s "$IDENTITY" dist/secrets-helper
fi
bunx electrobun build --env=$ENV
app=build/$ENV-macos-arm64/Secrets.app
if [ "$ENV" = dev ]; then app=$(ls -d build/dev-macos-arm64/*.app | head -1); fi
if [ -n "$IDENTITY" ] && [ "$ENV" = stable ]; then
  codesign --verify --deep --strict "$app"
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|TeamIdentifier)='
fi
if [ "${1:-}" = install ]; then
  rm -rf "/Applications/Secrets (Switch).app.new"
  ditto "$app" "/Applications/Secrets (Switch).app.new"
  rm -rf "/Applications/Secrets (Switch).app"
  mv "/Applications/Secrets (Switch).app.new" "/Applications/Secrets (Switch).app"
  echo "/Applications/Secrets (Switch).app"
else
  echo "$app"
fi
