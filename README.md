# Switch

A personal agent that runs on your own Mac. It keeps one memory of everything (the brain), wakes
to what happens, not only to chat, and shows you only what needs you. It runs on the agents you
already pay for, with tools added as extensions.

## Install

[Download Switch for Mac](https://github.com/zachsents/switch/releases/latest/download/Switch.dmg),
open it and drag Switch to Applications. At first launch, Setup takes you through the rest:
developer tools, signing in to Claude, extensions and accounts. It updates itself.

Needs macOS 14 or later on Apple silicon, and a Claude subscription. The brain, keys and
extensions stay on your Mac, in `~/.switch`.

## Build

[Bun](https://bun.sh), Rust, and a signed-in [Claude Code](https://claude.com/claude-code).

```sh
bun install
bun run core                       # the core, keeping its brain in ~/.switch
cd apps/desktop-gpui && sh scripts/bundle.sh && open "build/Switch GPUI.app"
```

- `apps`: the clients. `desktop-gpui` (macOS, Rust), `iphone` (SwiftUI), `desktop` (old, kept for rollback).
- `packages`: the core and its parts (brain, agent, autonomy, gateway, models), and `kit`, the extension kit.
- `extensions`: extensions, each installable alone.
- `scripts`: checks, build, release and backups.

An extension installs from the app (⌘K, Extensions) or by asking the agent:
`github:zachsents/switch` with path `extensions/<name>`. To write one, start from
[`packages/kit`](packages/kit).

Design: [VISION](VISION.md), [CONCEPTS](CONCEPTS.md). Contributing: [CONTRIBUTING](CONTRIBUTING.md).
Security: [SECURITY](SECURITY.md).

## License

[MIT](LICENSE)
