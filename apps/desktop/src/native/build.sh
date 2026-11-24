#!/bin/sh
# The app's native helpers, dist/switch-dictation, dist/switch-quicklook and
# dist/libswitch-snapshot.dylib, which electrobun.config.ts copies into the bundle, where a release
# signs them with the app's entitlements. swiftc is the Command Line Tools'; SpeechAnalyzer is macOS 26's.
set -eu
cd "$(dirname "$0")/../.."
mkdir -p dist
xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 -o dist/switch-dictation src/native/dictation.swift
xcrun swiftc -O -target arm64-apple-macos26.0 -o dist/switch-quicklook src/native/quicklook.swift
xcrun clang -O2 -fobjc-arc -dynamiclib -target arm64-apple-macos26.0 -framework AppKit -framework WebKit -o dist/libswitch-snapshot.dylib src/native/snapshot.m
