# switch-ext-browser

This Mac's own browser (Chrome, or another Chromium browser), signed in as the user is there, driven through its Chrome extension and the browser's debugger in background tabs, grouped and collapsed out of the way.

- `run`: a routine web task, step by step by the user's decision model (the profile's `browse` role). It stops before a step that would send, submit, buy, post or delete, unless the user asked for exactly that.
- `act`: exact control. Look, click, type, keys, scroll, screenshots, JavaScript, uploads, dialogs, console, network and tabs. `sign_in` fills a sign-in from a login in the user's vault ([switch-ext-secrets](../secrets); `save_account`, `accounts`), else the browser fills it from its saved passwords. `fill_secret` puts a vault secret (a card's number, an ID number) straight into a field.
- `secret`: the vault's secrets `fill_secret` uses: list them, keep a card the browser has saved, forget them.
- The `tab` widget shows the tab held for the user (an approval, a code, a human check), live, and they drive it from there.
- `browser.page` events say what's in front in the browser, and whether an agent is driving it.

Nothing secret passes through the agent: passwords, card and identity numbers are never typed by it or shown to it.

Ported from Switchboard's browser appendage and its extension.

A [Switch](https://switch.ax) extension, built on [switch-ext-kit](../../packages/kit).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/browser`, or add it in the desktop's Extensions view
(⌘K, Extensions). It runs on a machine that provides `browser` (`provides` in `~/.switch/config.json`):
the Mac whose browser is signed in to what the user's extensions need, and that nobody's using, since
`sign_in` and `autofill` bring the tab to the front for a few seconds.

## Setup

Once per Mac, after its first start writes its Chrome extension to `~/.switch/browser/extension`:
`chrome://extensions`, Developer mode on, Load unpacked, that folder. It updates itself from then on.
Accessibility belongs to the app the host runs under (for `sign_in` and `autofill`). The browser keeps no secrets: the vault seals each one to the browser's key for one fill, once the user has allowed the browser (its code shows in the Secrets app or the queue). The vault's `browser` import took in what the browser kept before.

## Develop

```sh
bun install
bun run check
bun test        # needs Chrome and swiftc
bun start   # serves MCP on stdio
```
