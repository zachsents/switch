# Contributing

Issues and pull requests are welcome.

- Read [CONCEPTS](CONCEPTS.md) and the rules in [CLAUDE.md](CLAUDE.md) first. The code knows no
  one (nothing about a user, their accounts or machines), every word is as short as it can be, and
  UI copy is labels and data.
- A new capability is usually an extension (`extensions/<name>`, on [`packages/kit`](packages/kit)),
  not a change to the core.
- Before a pull request: `bun run check` and `bun run typecheck`; for the desktop app, `cargo build`
  in `apps/desktop-gpui`.

This repository is published from Switch's development repository, one commit per publish. An
accepted pull request is taken in there with you credited, comes back in the next publish, and is
closed then rather than merged.
