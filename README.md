# Switch

A personal agent that runs on your own Macs. It keeps one memory of everything (the brain), wakes
to what happens, not only to chat, and shows you only what needs you. It runs on the agents you
already pay for, with tools added as extensions.

- `apps`: the clients. `desktop-gpui` (macOS, Rust), `iphone` (SwiftUI), `desktop` (old, kept for rollback).
- `packages`: the core and its parts (brain, agent, autonomy, gateway, models), and `kit`, the extension kit.
- `extensions`: extensions, each installable alone.
- `scripts`: checks, build, deploy and backups.

## Run

macOS, [Bun](https://bun.sh), Rust, and a signed-in [Claude Code](https://claude.com/claude-code).

```sh
bun install
bun run core                       # the core, keeping its brain in ~/.switch
cd apps/desktop-gpui && sh scripts/bundle.sh && open "build/Switch GPUI.app"
```

An extension installs from the app (⌘K, Extensions) or by asking the agent:
`github:zachsents/switch` with path `extensions/<name>`.

Design: [VISION](VISION.md), [CONCEPTS](CONCEPTS.md).

## License

[MIT](LICENSE)
