#!/bin/sh
# The Contacts app, built and signed as Switch's own apps are: with the Developer ID and notary key
# named in the machine's ~/.switch/deploy.json (identity, team, keychain, keychainPassFile,
# notaryKey, notaryKeyId, notaryIssuer, appId), never in this repo. Without an identity it builds
# unsigned. Its bundle id is $CONTACTS_APP_ID, else <appId>.contacts.
#   scripts/app.sh             build/stable-macos-arm64/Contacts.app
#   scripts/app.sh install     and put it in /Applications
set -eu
S=$HOME/.switch
conf() { plutil -extract "$1" raw -o - "$S/deploy.json" 2>/dev/null || true; }
expand() { case $1 in "~/"*) echo "$HOME/${1#\~/}" ;; *) echo "$1" ;; esac; }
cd "$(dirname "$0")/.."

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
if [ -z "${CONTACTS_APP_ID:-}" ] && [ -n "$APP_ID" ]; then
  export CONTACTS_APP_ID="$APP_ID.contacts"
fi
export CONTACTS_APP_VERSION="0.1.$(date +%s)"

bunx electrobun prepare >/dev/null
bunx vite build
bunx electrobun build --env=stable
app=build/stable-macos-arm64/Contacts.app
if [ -n "$IDENTITY" ]; then
  codesign --verify --deep --strict "$app"
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|TeamIdentifier)='
fi
if [ "${1:-}" = install ]; then
  rm -rf "/Applications/Contacts (Switch).app.new"
  ditto "$app" "/Applications/Contacts (Switch).app.new"
  rm -rf "/Applications/Contacts (Switch).app"
  mv "/Applications/Contacts (Switch).app.new" "/Applications/Contacts (Switch).app"
  echo "/Applications/Contacts (Switch).app"
else
  echo "$app"
fi
