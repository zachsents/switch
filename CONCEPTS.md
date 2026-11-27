# Switch

Switch is the agent. **Switchboard** is its client: the desktop and iPhone apps.

**Mission.** One agent, aware of everything, doing the work. Its user sees only what needs them, and less over time.

## Principles
- **Knows no one.** Switch's code and docs know nothing about any user, business, account, machine or place. Everything personal is data: in the brain, in installed extensions, or connected by the user in the client.
- **Only what needs a human.** The user is messaged or shown only what they're needed for as a human being: a decision, an approval, their hands, or news they'd want. Anything else is noise. Errors and trouble go to the agent (a surprise that wakes it), which fixes them and asks only when it truly needs them. What stays: what they asked to see (the usage-limit notice when nothing can run, Not Delivered on their message, the profile switch card) and errors only they can act on (their app can't reach the core).
- **Concise.** Every message, doc and UI label is as short as it can be.
- **Few concepts.** Merge overlaps and boil concepts down; never stack a new one on top.
- **Standards over invention:** MCP tools, MCP events, existing UI conventions. Copy proven formats, such as Claude Code's memory files and skills, so they work with any provider.
- **Fast.** Time and compute are costs the agent feels.
- **Plain tools.** Black screen, big hit targets, no frills.
- **Switchboard's style, not its layout.** Keep the direction of its style (the Switchboard Interface Standard, rev D: switchboard/mac/DESIGN.md). Its layouts are no law: redesign freely; the polish is in interactions, mostly from Base UI primitives and UI SDK behaviors.
- **Grid, not cards.** Every element fills its grid cell edge to edge, like a TUI, with hairline dividers between cells. No rounded cards, no floating panels, no padding around boxes. The message box, for example, is the entire bottom cell.

## Concepts
1. **Brain.** One ordered event log, with projections built from it. Everything goes in: messages, extension events, device state, turn output.
2. **Extension.** Anything that plugs in publishes:
   - MCP tools
   - MCP events: what changed (created, updated) and what the user did in the UI (viewed, opened then backed out, switched to another), like analytics. The computer is the agent's body; the user touching it is felt.
   - widgets: UI it publishes for clients to render in a space or in chat, as A2UI (v1.0). Three steps of embedding: A2UI's basic catalog and Switch's own catalog (the house parts and charts), both drawn in Switch's look, and A2UI's `McpApp` component (an MCP App in a sandboxed iframe) for custom drawing. Renderers: `@a2ui/react` on desktop, `A2UISwiftUI` on iPhone. The iPhone's catalogs carry every component desktop's do (`bun run catalogs` checks the names). The agent makes widgets too, in its turn: a surface of those parts, or a page in McpApp's frame; each is the brain's widget, shown in a chat or placed in a space like any other.
   - optionally, a native app

   A business's admin app, small utility apps and the clients are all extensions. A client (desktop, iPhone) is a extension that also **hosts**: it reads the brain and renders widgets. Its tools let the agent drive it (open a space, show something, screenshot).

   Live Activities and Wallet passes aren't widgets: iOS draws them from compiled templates. They're iPhone tools (start, update or end an activity; issue a pass) that any extension or the agent can call.

   **Contacts** is a universal extension: one set of people and companies, the source of truth. Address books (Apple, Google) are imported once, then kept in sync outbound only; other extensions (a CRM) and every sender flow in. The agent enriches them on its own (people search for unsaved numbers, email, company, socials), recording where each fact came from, and every change can be undone.

   **Calendar** is universal too: every Google and iCloud calendar in one. Unlike contacts, other people's invites live there, so the providers stay the source of truth: it syncs both ways. The agent schedules, keeps travel and prep time, and turns events into expectations.

   **Connections:** extensions declare the accounts they need (provider, scopes, one or many) and how they're connected: OAuth, a key the user types into a sealed card (straight to the core's Keychain), or a session the extension holds. The user connects and disconnects them in the client; when one is missing, the agent asks with an action item. Old grants move in once and stay where they were until the new ones answer. Nothing is hardcoded.

   **Extensions are their own packages.** A extension is one general capability that makes repeated work efficient. Not a category (travel, errands) and not a one-off site script: a one-off is done with the general extensions (the browser, email). An important, general one is a folder of this repo's `extensions/`; a personal one is a folder in the user's private extensions monorepo. Each installs alone, at a commit, by the user or the agent, and is built on the extension kit (`packages/kit`). How the user likes one used (pay once they've approved an order) is learned in the brain, never written into a extension. Switch and Switchboard know only the convention, never a particular extension. Only core resources ship inside the core: the brain and the clients.

   A extension can be only a widget, such as a watch face. Where widgets show is brain state: placement events, made by the user or by the agent when asked. A extension never suggests or makes a space: a new widget is in no space until it's placed in one. Nothing is hardcoded.
3. **Agent.** One identity. A turn is an agent session (Claude Code for now) whose context is rendered from the brain.
   - **Profile:** a named mapping from each brain role (turn, triage, gate, decision, browse) to a provider and model.
   - Providers mix within one profile. A "Claude" profile can use Opus for turns, Sonnet for gates and a decision model such as Jev (TypeSafe) or Clef (Cloudflare).
   - Named profiles and their active selection live in the brain. Settings → Models creates, duplicates, edits, deletes and selects them without restarting. Running turns finish on their current provider; the next turn/request reads the active profile. A profile can pin a turn account or spread across available accounts automatically.
   - Heavy tasks follow the selected turn model. Internal roles offer only implemented completion/decision paths. None is built in: a brain with no profiles is given the defaults once, and each is then changed, renamed or removed like any other.
   - **Default profiles, one per provider:** Claude, Codex and Antigravity, roughly equivalent tier for tier (Opus/Sonnet/Haiku and their counterparts).
   - **Accounts:** any number of subscriptions per provider. Turns spread evenly across the accounts that support the current profile, and move off one automatically when it hits a usage limit.
4. **Space.** One continuous history per thing being dealt with, in a tree (see Spaces). Its master thread is the view of it, used for discussion.
5. **Action item.** What needs the user, the furthest the agent can get without them. What the user's answer runs (an approved send, the answer to an extension's ask) waits for its extension to connect, up to a minute, before it goes; approved as the core restarts, it runs once the extension is back, and a restart while it waits reads the answer again from the reactor's cursor, never marked as going out (Switchboard's requests waited in `requests/<target>` the same way, SPEC.md §5.4). A connected extension serves what it announces: state it reads from the core at start, it reads again on a call that finds it missing, rather than refuse.

## How the agent works
- **Orchestrator.** The thread talking to the user never does the heavy work. It hands work to subagents and stays free to respond.
- **Intent over literal words.** Users are often wrong. Find the goal behind what they say, and push back when the literal ask doesn't serve it. When something offhand turns out to be hard, report it ("no HMR, but reloads take 500 ms") instead of building a half-baked substitute. Leftover slop becomes a fixture that later agents build around. A deliberate "just figure it out" means build whatever it takes.

## Threads and sessions (measured: .experiments/sessions)
1. **One live session per thread.** A stream-json process while the thread is active; `--resume` otherwise. Follow-ups keep the agent's own tool calls in its history: about 4s, against 9s for a fresh session.
2. **Delta before each message.** A triaged "since you last looked" note, scoped to the space (about 500 chars), placed in the user message, since a resumed session keeps its system prompt.
3. **Mid-turn: only "wake" items,** delivered between tool calls. Noise never derailed a run.
4. **Side threads.** An extension asks Switch in a thread of its own in a space (`side:<extension>:<space>:<key>`, the kit's `Switch.ask`): the same agent, memory and context, its say going back to the extension, never into the space's chat. The space's turns see its latest words, and history_search finds them. An extension also puts words into a live session (`Switch.steer`), wakes a turn with its `<name>.wake` event, and reads the brain within its reach (`Switch.read`).
5. **Compaction and fresh starts build a transcript, never a summary.**
   - Every exchange verbatim; tool I/O only for the last few.
   - Summaries invented motives.

## Attention (events → turns)
1. **Ingest.** No model; events go straight into the brain.
2. **Triage.** A small model, batched. It sorts each event into ignore, note on a space, or wake a turn.
3. **Act.** Opus. Running turns get salient events as a short digest between tool calls, never mid-reply.

Each message also gets a cheap pre-read: fix misheard names, title it, split a brain dump into its spaces, set the effort.

## Gates (small model, before anything leaves)
- **Outbound.** Is it concise? Could I take it further first? An action item must be the furthest I can get without the user.
- **Memory.** Is it general enough? If not, generalize it or drop it. Recall is pushed, never left to the agent:
  1. **Core:** a 2k-token global field plus a 1k field per space, inherited down the tree, always loaded. The agent compresses them to fit. (Measured: .experiments/recall; 4k global did no better.)
  2. **Situational:** before each message, full-text and vector search, then a decision model keeps what applies, loosely: tightening it trades recall for noise one for one. These are fast and cheap enough to use inline anywhere.
  3. **Triggered:** memories tied to an action ("before deploying") are injected right before that tool call.
  - Too specific: "If Electrobun lacks HMR, report reload time."
  - General: "Serve the intent; report hard offhand asks instead of building half-baked substitutes."
  - Each memory records the lesson, why it holds, and how to apply it.

## Autonomy (measured: Switchboard, Nov 5–19)
Four mechanisms; the monologue is just the agent's own turns, started by them.
- **Triage:** ignore, note on a space, or wake.
- **Expectation:** "X by T, else wake." One primitive for promises, watches and confirmations.
- **Gate:** one small model, criteria per exit (reply, ask, memory), scored by what happened next.
- **Reflection:** periodic. Repeated hand-work becomes a tool; ignored output gets dropped.

What nothing records (a port, a file, a page, a command's result), a **script** watches: the agent writes it, and a host runs it outside any turn on the Mac it picks, through deploys and restarts, until its work ends. It fires events (`switch event <name> [json]`), its end is `script.ended`, and an expectation watches those, never a timer. An ask whose step a command can see done carries that check, run until it succeeds, which closes the ask.

Self-started work is not capped by wake count or daily spend; reflection reports what it started, its cost and what came of it. Memory has one write path (dedupe, generalize).

## Drives
- **Time.** Every turn sees elapsed time, cost and machine load. Reflection finds slow paths (browser instead of API, queues) and fixes them.
- **Perception.** Turn an experience into something analyzable: frame diffs of a glitch, overhang plots.
- **Growth.** A periodic reflection: what did I repeat, where was I passive, what should become a script?

## Context per turn

Kept small:
- identity
- relevant rules
- the space's history, verbatim by exchanges
- a timeline of other spaces, compressed
- what's in flight
- now

Stable parts first, for the prompt cache.

## Loop

Land on main → checks (~3 min) → canary → running turns end, or are paused once the pressure builds (each landing not live adds a point a minute; 10 pauses them) and carried on by the new core → swap → automatic rollback. No trains, no blocking UI review. Heavy jobs get their own lanes.

Every host runs exactly the core's release, wherever the landing came from: forward after a ship, back after a rollback. The core says its release first on each host's link; a host on another one fetches that release's build for its target from the core, checks it (a Mac's bundle by its signature, as its own; elsewhere by the SHA-256 the core states), swaps it in and exits for launchd or systemd to start, all before it offers the new core anything. A release carries a build for every target a host has reported.

## From T3 Code (/tmp/t3code)
- One write path: pure decide, then one SQLite transaction (events, projections). What reacts to an event reads the log from a cursor kept in the brain, with ids derived from that event, so a restart replays it without doing anything twice; work owed to a thread waits in the record (`thread.waiting`) until a turn takes it in.
- Snapshot plus sequence cursor for client sync.
- Thread → run → execution-node tree; provider IDs are refs.
- Orchestrator MCP for delegation (children only narrow permissions; retries are idempotent).
- Claude Agent SDK edge cases: steer, interrupt, resume, orphan cleanup.
- Idle compaction timed to the cache TTL; usage-limit auto-resume.
- 50 ms delta coalescing; command output kept off the event store.
- A reconnect supervisor for mobile.

## From Switchboard (keep)
- the event log and records
- open asks as actionable items, with their text, choices, drafts and attachments; approvals wake the current agent with the original instructions, rather than replaying callbacks into the old runtime
- appendages sensing devices and browser
- AQB-style fast browsing (a decision model drives the clicks)
- live activities and Wallet
- monologue and reflection
- spreading turns across subscriptions and machines
- canary and rollback

## Drop
- the Nov 17 failures: per-message work items, all rules loaded, wake re-entry storms, a single-machine turn host
- the merge pipeline, CI lanes, and the proof and video tools
- widget up/down votes: users glance at widgets but don't vote; glances and dwell are the signal

## Stack
- **Runtime and language:** Bun and TypeScript everywhere, with Effect, but the desktop app, which is Rust. Ship with `bun build --compile`, and AOT when it's stable.
- **The core's thread only serves.** Heavy work (a model's light copy, a zip, a backup) never runs on it: one stalled second stalls every socket, turn stream and host. It goes to a child, often `switch` itself with a subcommand, below the core's Interactive priority (utility or background).
- **A runaway is stopped.** macOS swaps out a process that outgrows the memory until the disk is full. So each Mac's host looks every 5 s and SIGKILLs an agent's process whose footprint (compressed and swapped included) passes half the Mac's memory, and raises a surprise for its work. An agent's process carries a mark everything it starts inherits, detached or not: `SWITCH_WORK` (a turn's, a script's) or `SWITCH_EXTENSION`. What launchd keeps (the core, the hosts) and unmarked processes (the user's own) are never stopped. Something that needs that much runs smaller, or on a box rented for it.
- **What makes something on the disk removes it.** A deploy keeps the last 3 releases (and the live and previous) and its brain backups (the last 3 and each of the last 7 days' newest, compressed). A turn deletes what its work left beyond its outputs: builds and repository copies in /tmp, downloads, intermediates, merged worktrees.
- **Desktop app:** Rust on gpui (Zed's), with UI SDK for gpui (Vercel UI SDK's behaviors, ported 1:1), in `apps/desktop-gpui`; web content in WKWebView where it's a page's own. The Electrobun app (`apps/desktop`) is kept only for a rollback. No Electron.
- **UI:** gpui and UI SDK for gpui on the desktop; React, Base UI and Tailwind v4 only in what stays web (the old app, pages).
- **Models:** small ones through Vercel AI Gateway; heavy ones on the user's subscriptions (Claude Code, Codex, Antigravity).
- **iPhone:** native Swift, for Live Activities, Wallet and widgets.
- **Toolchain:** tsgo, oxlint `--type-aware` with strict rules, oxfmt, bun test.

## Spaces (measured: .experiments/membership)
- **Home is the root space.** Every top-level space sits inside it, and its chat is for anything uncategorized: life, whatever. Events that fit no space land here.
- **Every space has the same layout:** what's running, action items, the spaces inside it, widgets, and the chat. Home is the same, with at most a slight variation.
- **One layout, nothing to configure:** the band, then a rail on the left (the spaces inside; Needs you and Running, each only this space's own), the chat in the middle, and the space's widgets on the right (its placements in order, each full width at its own height; the column scrolls as a whole, nothing inside a widget does). On a narrow window the widgets fold away first.
- **Chat** is the thread, with the message box as its bottom cell. Never Switchboard's Home layout, with an input on top and recent messages under it.
- **Settings views** (Connections, Extensions, Memory, System) are views, not spaces.
- **A tree of the user's spaces:** projects and sub-projects. A thread can be split off into a space of its own, by the user.
- **Switch never makes a space on its own.** Spaces are made by the user, or by the agent when the user's own words ask for one. Triage, reflection and extensions never make one: an event goes to the best existing space, else Home, and a question becomes an action item there. (Switchboard once made them automatically and that was removed as too inconsistent.)
- **Where things land.** An event goes to the space it's tagged with, and the turn it wakes runs there. What work makes (a task, an item, an expectation, a memory, a Live Activity) goes to the space it names (by id, name, a former name, or Switchboard's `ws:<id>`), else to the space of the work that made it, else Home: Switchboard's rule for tasks and asks (`spaceFor`).
- **One master thread per space:** its past, present and future events, including vague follow-ups.
- **A new space takes in its past.** Made under another, it takes from there what's about its own subject (its person, job or project, not a word it shares with its description): the turn model reads the parent's chat a stretch at a time with what came before, then its tasks, open items, expectations and widgets, and they move, leaving nothing behind; a line mainly about something else that reports on it shows in both (Switchboard's `adopt`, judged instead of matched by title; measured: the decision model line by line held .32–.37 precision, the turn model 1.0 at .96–1.0 recall).
- **A decision model tags every event** (Jev: .83/.82 precision/recall, 288 ms, $0.12 per 1k events). It sees the conversation so far, including the agent's replies, and each space's latest lines. Fast streams are tagged in batches.
- **Reliable links are hints, never overrides:** email thread, order code, work id. Standing queries and time-adjacency links lost (.51 and .77 overall).
- **Mentions point both ways.** An event shows normally in its space, and as "mentioned in Y" in any other space it bears on.

## Connections
Connections use extension-declared session `signIn` and `status` tools. Sign-in returns a widget
view; only the status tool's current accounts close its ask. Existing session asks gain that action.
OAuth uses PKCE in the core and a callback on the user's client, relayed through `connections.finish`.
`connections.readiness` reports client kinds and registered redirects without credentials. Installed
clients use the client's loopback listener; web clients require an exact registered redirect.

Consent results carry `kind: "oauth"`; a session's ordinary `url` opens without an OAuth callback.
Owner-verified items retain their controls through revisions and accept dismissal from clients;
only their verifier publishes completion. Client observations cannot forge item or connection events.

## Other agents
Claude Code, Codex and T3 Code sessions reach Switch at `<core>/peer`, an HTTP MCP server, with a
`peer` credential as bearer (`POST /auth/mint` `{"name":"Agents","kind":"peer","scopes":["peer"]}`):
`spaces`, `read`, `work`, `post`, and `ask` (post, then wait for the answer). Their words show under
the name they give, wake the space's agent as a collaborator's, and are never the user's: what goes
out in the user's name or needs them still goes to their queue. Switch writes to T3 Code threads
through switch-ext-t3code.

## Later
- **Agents talking across people.** One person's agent asking another person's agent for a fix directly. For now it arrives as texts. Keep the door open: every message has a sender (a person or someone's agent), and grants per contact say what their agent may ask for. Likely over A2A or a shared board; the Outbound gate covers replies.
