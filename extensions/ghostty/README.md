# switch-ext-ghostty

[Ghostty](https://ghostty.org), the terminal, on each Mac: `open` a window, tab or split with a
command typed at its prompt (run, or waiting for ↵) in a folder, `type` into a terminal, and `list`
the windows, tabs and terminals. It drives Ghostty through its AppleScript dictionary (Ghostty 1.3
and later), so macOS asks once whether Switch may control Ghostty (Privacy & Security ›
Automation). Ghostty's dictionary has no way to read what a terminal shows, so neither has this.
Where Ghostty isn't installed, `open` opens Terminal instead, with no Automation needed.
`ghostty.heartbeat`, every five minutes and at once when it changes, says whether Ghostty is there
and whether Switch may drive it.

A [Switch](https://switch.ax) extension, built on
[switch-ext-kit](../../packages/kit).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/ghostty`, or add it in
the desktop's Extensions view (⌘K, Extensions). It runs on every Mac.

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
