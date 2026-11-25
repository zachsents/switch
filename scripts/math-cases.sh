#!/bin/sh
# Math is found the same way on every surface: each finder against packages/gateway/src/math/
# cases.json. Pages' (TypeScript) and the iPhone's (Swift) here; the desktop's (Rust) is its
# `cargo test math`, which reads the same file.
{
  set -eu
  cd "$(dirname "$0")/.."
  cases=packages/gateway/src/math/cases.json
  (cd packages/gateway && bun test src/math)
  out=$(mktemp -d)
  trap 'rm -rf "$out"' EXIT
  # Top-level code runs only from a main.swift.
  cp scripts/math-cases.swift "$out/main.swift"
  swiftc -O -o "$out/cases" apps/iphone/Switchboard/Views/MathSplit.swift "$out/main.swift"
  "$out/cases" "$cases"
  exit
}
