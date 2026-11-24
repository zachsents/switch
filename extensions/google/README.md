# switch-ext-google

Every inbox followed, mail searched and read, files and cells.

A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`, a Switchboard appendage) that Switch runs through
[switch-ext-kit](../../packages/kit)'s shim. Its messages carry who sent them, for Switch's inbox and Contacts.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/google`, or add it in the desktop's Extensions view (⌘K, Extensions). Switch runs it
on the first machine with what it needs (`always-on`).

## Setup

Connect each Google account in Switch's Connections when it asks. Consents are Switch's own: the core's OAuth client
and PKCE, coming back to a loopback redirect (`http://127.0.0.1:<port>/oauth/callback`). A connect this extension starts
itself (`google_connect`, `drive_connect`...) is served by its own listener on the machine it runs on and relayed to the
core, so it opens in that machine's browser. No Web client or public callback is needed.
