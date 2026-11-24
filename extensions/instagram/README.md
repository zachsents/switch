# switch-ext-instagram

The inbox read through the browser extension without opening a chat, so nothing shows Seen.

A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[switch-ext-kit](../../packages/kit)'s shim. Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/instagram`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Needs the browser extension (`extensions/browser`) on a machine whose Chrome is signed in to Instagram.
