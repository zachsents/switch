# marketplace

Facebook Marketplace: searches and saved searches that say what's new, and the chats with sellers and buyers.

A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[switch-ext-kit](../../packages/kit)'s shim. It drives Facebook in the user's own Chrome through the
[browser extension](../browser). Searching and the chats' loop only read; `send` messages a
seller or buyer in the user's name, so Switch's Outbound gate sees it first. Widgets: `watches` (each saved search, with
what's new and cheaper) and `chats` (the week's chats, marked where a reply is owed).

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/marketplace`.
Switch runs it on the first machine with what it needs (`always-on`).

## Setup

- Install the browser extension (`extensions/browser`), and sign in to Facebook in that Chrome (the `Facebook` connection is that session).
- Nothing else: saved searches, chats, sends and photos stay in the extension's `home`. A search with no `near` uses the
  location the Facebook account's Marketplace is set to.
