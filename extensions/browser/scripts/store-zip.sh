#!/bin/sh
# Makes the Chrome Web Store upload: the extension's files, its manifest without `key` (the store
# gives the listing its own id and key), zipped at the root.
#   sh scripts/store-zip.sh [out.zip]
set -eu
cd "$(dirname "$0")/.."
out=$(cd "$(dirname "${1:-switch-extension.zip}")" && pwd)/$(basename "${1:-switch-extension.zip}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp -R extension/background.js extension/hands.js extension/icons "$tmp/"
bun -e 'const m = await Bun.file(process.argv[1]).json(); delete m.key; await Bun.write(process.argv[2], `${JSON.stringify(m, null, 2)}\n`)' extension/manifest.json "$tmp/manifest.json"
rm -f "$out"
(cd "$tmp" && zip -q -X -r "$out" manifest.json background.js hands.js icons)
echo "$out"
