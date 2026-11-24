# uber-courier

Uber couriers in the user's own browser: `quote`, `stage`, `confirm`, `track`, `wait`, `discard` and `status`. A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`) that Switch runs through [switch-ext-kit](../../packages/kit)'s shim. It drives the user's browser through [switch-ext-browser](../browser)'s tools (`browser.py`), which must be installed.

`confirm` books and speaks for the user; `stage` answers the approval to put up. Its `uber_courier` events are what a
shop's orders follow. It notifies the user (`sb notify`) of a courier's driver.

## Setup

A `session` connection to Uber, in the browser. `config.json` in the extension's home:

```json
{"uber": {"pickup": {"address": "1 Main St, Springfield, CO 80000", "unit": "", "phone": "555-555-0100"},
           "note": "", "zone": "America/Denver", "near": [39.7, -105.0]}}
```

The pickup every courier leaves from, the first words of each drop-off `note`, the time `zone`, and `near` [lat, lng]
to bias address search.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/uber-courier`.
