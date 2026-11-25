---
name: extensions
description: Growing an extension, a new capability (a sense, a tool, a monitor, a widget), or changing one; installing and pinning it.
---

# Growing an extension

An extension is a package that serves MCP on stdio: tools, events, widgets and a manifest, on switch-ext-kit.
Everything beyond the brain and the clients is one.

## When

- The user told you something a sense could have caught ("the kiln's done"). Grow the sense.
- A chore keeps coming up. Grow the tool once.
- Something that matters changes (an order queue, a build). Grow a monitor with a widget.

An extension is one general capability, grown once the work has repeated. Not a category (travel,
errands), and not for a one-off: a shell command, the browser or email does that. Not around a gap
in Switch itself: change Switch (the `switch` skill). How the user likes something done (pay once
they've approved) is memory, not extension code.

## Start

An extension has one of two homes (`extensions_list` shows each one's source):
- **A folder of Switch's `extensions/`** (`github:zachsents/switch`), for an important, general one:
  nothing personal in it. Accounts, hosts, ids and keys are data (its folder, a connection, the
  brain). Work in a worktree of Switch, as the `switch` skill says.
- **A folder in the user's private extensions monorepo**, for a personal one (one person's shop,
  restaurant or accounts). Names and businesses may be in it; secrets never are.

```sh
cp -R packages/kit/template extensions/<name> && cd extensions/<name>   # in Switch; the private monorepo's own folder otherwise
bun add switch-ext-kit effect @modelcontextprotocol/server   # + its own deps
bun add -d @types/bun @typescript/native-preview oxfmt oxlint oxlint-tsgolint ultracite
```

Rename `hello` throughout (package name, `extension.name`, the app, event and widget names), fill
`src/app.ts`, and keep `bun run check` clean: types, UI copy (`ui-captions`), lint, format. The
API (tools, events, widgets and their sizes, its own log, models, asks, sealed asks) is in
switch-ext-kit's README (`node_modules/switch-ext-kit/README.md`).

## What it is

- **Tools** become `<name>_<tool>` for every turn. `readOnly` for one that only looks; `speaks`
  for one that sends in the user's name (the Outbound gate reads it first); `appOnly` for one only
  a widget calls. A tool fails with what went wrong; one that waits answers before ten minutes with
  how far it got.
- **Events** land in the brain as they're emitted; triage decides what wakes a turn, so an extension
  only records. Name them `<name>.<what>`, after what they're about, never the machine.
- **Widgets** are A2UI from a read-only tool's result, refreshed by named events: Switch's catalog
  and A2UI's basic one (both drawn in Switch's look; charts take plain data), `McpApp` for custom
  drawing. Labels and data only: no captions, no empty states (hide).
  An extension never suggests or makes a space: a new widget is on no board until the user adds it
  (or asks you to place it).
- **Shared code** (a widget two extensions draw, as the vitals widget in `packages/vitals`) lives
  once in the repo, symlinked from each extension's `src`; the pack holds what the link points to at
  its commit, so a change reaches every extension pinned past it, with no release.
- **State** lives in its folder (its working directory), which moves with it: its own records in
  the kit's `Log`, any other file written with `writeFileAtomic`, never in place. What it emits waits
  in its outbox until the core has it. It reads the brain through `brain_query`, never brain.db.
- **Manifest** (`extension` in package.json): `name`, `main` (or `command`), `needs` (what its machine
  must provide: `macos`, `lan:<thing>`), `every` (one per machine), `heartbeat` (required: how often,
  at most ms apart, each of its `<name>[.<part>].heartbeat` events comes; three missed is trouble),
  `connections` (accounts the user connects; tokens come from the core, never kept in the
  extension), `widgets`.
- **Heartbeat**: beaten by what does the work (a sense's loop after each look), so it stops when that
  does. `facts.failing` says what's wrong now (null when nothing is); a sense reading a source that
  moves on without it (messages, mail) says `facts.behind_ms` (0 when its last look read everything
  there was, else how long since one did), and beats at once when either changes. Ten minutes behind
  is trouble.
- **Where it runs**: the first machine that provides its `needs`, unless placed (`extensions_place`).
  Its working folder is its own and outlives updates: state there by relative path; what it
  prints on stderr is `log` there. Something it starts to outlive it runs from elsewhere.
- **What only the user can do** (a login, a permission, an approval) is an ask (`Asks.open`), the
  furthest you can get without them. A secret comes by sealed ask, never in text.

## Install and pin

1. Run its checks (`bun run check` in its folder) and scan (`gitleaks dir --no-banner .`). In Switch,
   land it as the `switch` skill says, then publish (`sh scripts/publish.sh`); in the private
   monorepo, commit and push to main.
2. `extensions_install` with `github:zachsents/switch#<commit>` and `path: "extensions/<name>"`
   (the private monorepo's the same, with its folder). `<commit>` is the published one. An update
   is the same with the new commit (or `extensions_update`, which fetches where it was installed
   from again). The result says where it runs; `extensions_list` shows it. The brain is the only
   record of what's installed and where: a deploy changes neither.
3. Call its tools once through the apps to see it works, and check its events in the brain.
