# amazon

Amazon in the user's own browser, signed in as the user: reorders, cart changes and checkouts. A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`) that Switch runs through [switch-ext-kit](../../packages/kit)'s shim. It drives the user's browser through [switch-ext-browser](../browser)'s tools (`browser.py`), which must be installed.

`reorder`, `place` and a checkout's placing speak for the user. A checkout stops before Place your order and answers
the approval to put up. Signing in, adding a card and human checks are the user's to do in the browser. It notifies
the user (`sb notify`) when an order is placed.

## Setup

A `session` connection: signed in to Amazon in the browser switch-ext-browser drives. `config.json` in the extension's home:

```json
{"amazon": {"address": "words in a saved address", "card": "1234", "card_name": "", "ceiling_factor": 1.35,
             "tax_allowance": 1.11, "hold_hours": 24, "again_hours": 12, "tick_human_box": false}}
```

`address` picks one of Amazon's saved addresses; `card` is the saved card's last four. Without a `max_total`, a
reorder may cost at most last time's price times `ceiling_factor` times `tax_allowance`. A held checkout lasts
`hold_hours`; `again_hours` guards against ordering the same item twice.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/amazon`.
