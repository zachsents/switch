# Vision

Code editors went through this once. VS Code won without the best compiler, debugger or language support. It won on three plain things: a layout that stays out of the way, an extension API that anyone could build on, and a small set of primitives (files, panels, commands, the status bar) that every extension shared. People started living in it because the extensions could do almost anything.

Switchboard aims to be that for working with agents. People don't want another proprietary agent or another closed suite of half-good tools. They want to use the agents they already pay for, build tools of their own, and see everything in one fast, plain place.

## What it is

- **Bring your own agent.** Turns run on the subscriptions and models the user already has (Claude, Codex, Antigravity, several accounts of each), and Switch moves between them when one hits its limits. The agent's identity doesn't belong to any one model.
- **Bring your own tools.** Every capability is an extension: MCP tools, events, and widgets, in one convention anyone can write to. General extensions are public, in this repo. Personal ones live in a private monorepo next to the brain.
- **The data is the user's.** One brain: an append-only log of everything that happened, plus what's derived from it. It can be copied, backed up, moved, or swapped.

## Applications bring no AI of their own

It ends up as a plain, flat framework, and applications are built on it. A CAD program, an editor, a CRM: each ships as an extension and connects straight to the user's brain. It gives the user's agent its tools (edit the model, run an analysis), sends the brain its events (a dimension changed, a simulation finished), and draws its own widgets or a full window.

The app doesn't come with an assistant of its own. The user's agent works inside it, with their memory, context and preferences, and the same agent carries on in the next app. Vendors stop shipping weak, bolted-on AI, and users stop putting up with it. Switch's own Contacts, Calendar and Secrets apps already work this way.

### Together, not taking turns
Exposing an app over MCP gives the agent a remote control. That forces a choice: either the agent drives, or the user does. An extension app is built for both at once, like two people in one document:
- **The app sends what the user does as events, as it happens:** the selection, the edit, the error that just appeared. The agent sees the work live, not only when it's handed over.
- **Context is shared:** "this" means whatever is selected. Nothing has to be described in chat.
- **The agent works in place:** its changes appear in the app as suggestions accepted with one click, or as live edits beside the user's. It never answers in a chat about what's in the app.
- **It acts when it notices:** a wall too thin to print, a dimension that breaks the assembly. It says so the moment it matters, inside the app, through the same expectations and asks as everywhere else.
- **Asks show up where the work is**, not in a separate queue the user has to go and check.

The app supplies the canvas and its own tools. Switch supplies the agent, its memory, and the live loop between them.

## The problems it takes on

### 1. An agent that stays the same agent
A model forgets everything between sessions. Switch gives the agent continuity:
- one event log the agent reads and writes
- core memories it always carries
- recall by search when something becomes relevant
- memories that fire when a matching action comes up

Spaces give that memory a shape: a project's past, present and future live in one place. The agent is the same agent on Tuesday as on Monday, whichever model is underneath.

### 2. Moved by the world, not by turns
People don't wait for a prompt. They react to what happens. Extensions are the senses: an email arrives, a print finishes, a payment fails, a page changes, a promise comes due. Triage decides what each event means and wakes the work it bears on. Expectations let the agent say "when X happens, do Y" or "check this by Friday" and be held to it. Turns start because something happened, not only because someone typed.

### 3. Chat isn't the interface
In a long chat, the important things get buried. "What do I need to do?" and "where does X stand?" turn into questions the user has to ask. What the user actually wants is three things:
- **The work gets done**, by agents as often as possible.
- **Clear action items** when something needs their judgment or their hands. One line each, with the action right there.
- **A trustworthy, live view of the situation**, whatever that means for the topic: the printers' cameras, an order's state, a deploy, an inbox.

So a space is a board of widgets, live views that extensions draw from real state, with Needs you and Running as first-class widgets. Chat is one widget among them, kept for talking, not for tracking.

### 4. An interface that stays out of the way
Trends age. A tool people live in for years has to be plain:
- **Dense:** little wasted space, information delivered compactly.
- **Easy to act on:** large hit areas, so it's always clear what can be clicked and it's easy to hit.
- **Quiet:** one background, three line weights (“The vertical panels should be separated with some pretty strong hierarchy whereas separating spaces from ‘Need to You’ from ‘Running’ should probably be one step below that, and then hairline within those.”), almost no animation, nothing flashy.
- **Fast:** everything paints its final state on the first frame, and switching anywhere is instant.

The fun belongs in the extensions (a watch face, a printer's live camera), never in the frame around them.

## The primitives

What extensions build on, kept small and stable:

- **Space:** a user-made place for a project or a part of life. Its board, its thread and its memory.
- **Widget:** a live view an extension draws (A2UI, or its own HTML), placed and sized by the user.
- **Event:** something that happened, from an extension, the user, or the agent. Everything is an event first.
- **Tool:** something the agent can do, through an extension.
- **Ask:** something only the user can decide or do. One line, one action, and closed once it's answered.
- **Expectation:** what should happen by when, watched and enforced.
- **Memory:** what the agent knows, recalled when it matters.

An extension is any program that speaks these: it emits events, offers tools, and draws widgets. Nothing in the core knows any particular extension, person or business.

## Why people would live in it

- **Everything in one place:** your agents, your accounts, your devices, your businesses. Each one is an extension on the same terms.
- **The layout is yours:** you edit it, and it never rearranges itself behind your back.
- **It works while you're away** and tells you only what needs you.
- **It's open:** the core, the convention and the general extensions. Your own extensions stay yours.

## Not this
- a proprietary agent, or a model you're locked into
- a chat app with features bolted on
- a design showcase
- an assistant that decides things on its own that it should ask about, or asks about things it should simply do. That line is learned per person and kept in the brain, not hard-coded.

## Later
- **A registry of extensions**, so finding and installing one is a search and a click.
- **Agents that talk across people:** one person's agent asks another's, within the grants each person sets.
- **The phone as a full peer:** the same spaces, asks and live views as the desktop.
- **Shared spaces**, for teams and businesses.
