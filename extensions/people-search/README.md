# people-search

Public-records people search (FastPeopleSearch, then TruePeopleSearch) for a phone number, name, address or email:
`phone`, `name`, `address`, `email`, `person` and `status`. Read-only. A [Switch](https://switch.ax) extension: a Python MCP server (`sbmcp.py`) that Switch runs through [switch-ext-kit](../../packages/kit)'s shim. It drives the user's browser through [switch-ext-browser](../browser)'s tools (`browser.py`), which must be installed.

Human checks are never solved: the tool says so and a `need` asks the user to pass it in the tab.

## Install

Ask Switch's agent to install `github:zachsents/switch` with path `extensions/people-search`.
