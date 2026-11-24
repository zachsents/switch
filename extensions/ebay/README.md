# ebay

What a model sold for on eBay, by condition, with a chart if asked (`comps`), and its cheapest live listings
(`listings`). Read-only. A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`) that Switch runs through [switch-ext-kit](../../packages/kit)'s shim. It drives the user's browser through [switch-ext-browser](../browser)'s tools (`browser.py`), which must be installed.

`run.sh` makes a venv in the extension's home with matplotlib (for the chart) the first time it starts. Charts are kept in
the extension's `home/files/`. Human checks are never solved: the tool says so and a `need` asks the user.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/ebay`.
