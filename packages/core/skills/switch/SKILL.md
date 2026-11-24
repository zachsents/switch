---
name: switch
description: Changing Switch itself (the core, the agent, the brain, the desktop app in Rust, or the iPhone app) and shipping the change.
---

# Changing Switch

Switch is one repository: the core, the agent, the brain, the gateway and the clients. Change it
when what you need belongs there (a fix in the core, a better context, a client's view); grow a
extension for a new, separate capability (the `extensions` skill). Never work around a gap in Switch with a
extension.

## Make the change

- Read its `CLAUDE.md` and `CONCEPTS.md` first. The code knows no one: nothing about the user,
  their accounts, machines or businesses, which are data.
- Work in a worktree of your own, never in a checkout the user works in, nor the deploy's copy on
  the core machine (`~/.switch/src`):
  `git worktree add <path> -b <name> main && cd <path> && bun install`, then
  `(cd apps/desktop && bunx electrobun prepare)`, which the checks' lint needs.
- The desktop app is `apps/desktop-gpui` (Rust, gpui and UI SDK for gpui): change it there, never
  in `apps/desktop`, the old Electrobun app kept only for a rollback. `PORTING.md` says where each
  part is. Build it with `cargo build` in it (one `CARGO_TARGET_DIR` for every worktree on a Mac,
  debug builds); `sh scripts/bundle.sh` makes the app. A change shared by the desktop and the
  iPhone goes in both.
- `bun run check` (denylist, UI copy, lint, format) and `bun run typecheck` after edits.
- UI copy is labels, data and a one- or two-word placeholder; `ui-captions` fails on the rest.
  Its allowlist (`scripts/ui-captions.allow`) is for real information only, such as a permission
  that's off.

## Ship it

Land on main → checks → deploy → canary → automatic rollback. No pull requests or trains.

1. Bring main in (`git merge main`), settle conflicts keeping both sides, both checks clean.
2. Merge into main. The repository's hook deploys whenever main moves: the core machine checks,
   compiles, signs, swaps, runs a canary turn and watches; a failing canary rolls back.
3. Confirm your commit went live: `~/Library/Logs/switch/deploy.log` where the hook ran says
   `<sha> live`; on the core machine `readlink ~/.switch/current` ends in it. If a deploy is
   running, wait for it. If the canary failed, fix forward. Every machine's host takes the live
   release itself as it links to the new core, wherever the landing was made.
   The desktop app ships in its own lane after the core: built, signed, notarized and published
   to its feed, and each Mac's app updates itself when it won't interrupt.
4. Once it's live, publish it (`sh scripts/publish.sh`, on a Mac with the denylist) when it changed
   an extension or anything public you want out now.
5. Remove your worktree (`git worktree remove <path>`) and its branch. Its
   `node_modules` and build output (several GB once the desktop is built) stay on the disk
   otherwise; on a laptop, dozens of finished worktrees fill it within days.
