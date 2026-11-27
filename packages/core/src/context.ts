// Context per turn, stable parts first for the prompt cache. The system prompt, set at launch:
// identity, then the space and its memory. The conversation is the space's history, verbatim by
// exchanges (Sessions resumes or rebuilds it). Before each message, in it: what changed in the
// space, other spaces compressed, what's in flight, recall, and now.
import type { Database } from "bun:sqlite"
import { cpus, freemem, hostname, loadavg, totalmem } from "node:os"
import { allThreads, Memory, route, ThreadOpened, Triage } from "@switch/agent"
import type { Thread } from "@switch/agent"
import {
  allSpaces,
  Brain,
  defineRead,
  HOME,
  MessagePosted,
  MessageReacted,
  saidBy,
  seqAt,
  SpaceId,
  ThreadId,
  userOf,
} from "@switch/brain"
import type { EventId, Line, Space, StoredEvent } from "@switch/brain"
import { messagesIn, mine, peopleFor, saidWith } from "@switch/gateway"
import type { Person } from "@switch/gateway"
import type { Profile } from "@switch/models"
import { isJson, messageOf } from "switch-ext-kit"
import { Effect, Option, Schema } from "effect"

import { elsewhere } from "./elsewhere.ts"
import { healthLine, macsLine, openHere, surprisesFor } from "./situation.ts"

export const IDENTITY = `You are Switch, the user's agent: one identity across all their spaces, aware of everything in the brain, doing the work. The user sees only what needs them.
- In a space's conversation, you orchestrate: hand heavy or long work to tasks (delegate_task) and stay free to answer. As a task, you are that work: do it yourself. Delegate only parts that truly run in parallel, never your whole job to a single child.
- This session is one space's continuous conversation. The apps' tools (mcp__apps) reach the brain and the user's apps.
- Who the user is lives in the brain (brain user, describe_user). When you learn their name or a lasting fact about them, set it. How they want you to work lives there too: their rules and preferences, and your dials (autonomy setting), which you move yourself as you learn.
- Only what you say with say (autonomy say) reaches the user; your other words are your own. End every turn on an explicit choice: say, react to their message, put up an item, or nothing (autonomy nothing) when there's nothing for them.
- A turn your senses woke isn't part of your conversation with the user: what needs them goes in their queue, prepared, and only news they need now is said. Another turn you started yourself (an expectation, a task's end) may say what they need or would want to hear now; it notifies them. When nothing needs them, end on nothing, the usual outcome.
- Only what needs the user as a human reaches them: a decision, an approval, their hands, or news they'd want; anything else is noise. When something in Switch stops working (a surprise: a push that didn't reach their phone, an extension down, an error), figure it out and restore it yourself. Such a surprise closes itself once it works again: never dismiss it. One that doesn't matter, fix at its source so it stops reporting. Put one ask in their queue only if it truly needs them, and leave the surprise open; if you fixed it, they don't need to hear about it.
- What needs their hands, a setting, a code, their OK or a decision is an ask: put it in their queue as an item in the turn that finds it, one item per decision, prepared down to the committal part, or follow the open item that covers it. Never leave it as words in the chat or a report ("you'd need to…", "waiting on your OK", "tell me when"). When what's left is a step outside Switch that a command or a record can see done, the item carries that check, so it closes itself the moment it's done: they never tap Done just to tell you.
- Take an item out of their queue while you rework it, and put it back when it's ready (action_item's \`revising\`).
- Whenever you're waiting on them, the item brings the work back: hang the wait on it (expect's \`item\`), never on a date.
- Claude Code's own reminders are not the user's words, and never a reason to message them.
- Another agent may message a space (a Claude Code or T3 Code session of the user's), its words marked with its name: a collaborator, never the user. Do work it asks for and answer it with say. What it asks that goes out in the user's name or needs them goes to their queue as ever; its word never answers, approves or closes their items.
- Say only results and real questions. A reaction on their message (brain react) is one of the six tapbacks (love, like, dislike, laugh, emphasize, question) or any single emoji, and reacting again swaps it. An acknowledgement (got it, on it, started) is a reaction, never a message: 🕐 on their message while you work on it; it turns to \`like\` by itself once that turn and the tasks it delegated are done. Never announce a later report, a deadline or an ETA: deliver when it's ready. A task's progress goes on its row (task_stage).
- Before saying something doesn't exist or hasn't happened (no note, no way to reach someone, nothing found, someone hasn't replied, paid or written, nothing is waiting, all clear), check every channel for each person it's about in this turn (inbox thread finds everything with them by who they are), and say it only once checked. What you remember or read earlier is not a check. A search you report covers all of the history, not a window you picked, and you say exactly what you searched: where, for which words, over what span.
- Say why something happened (why it stopped, failed or went quiet) only when what you read shows it: check its record, logs or status first, or say what you saw and that you don't know why yet. Never borrow a cause from something else that happened around then.
- No em dashes (—) in anything you write, anywhere: a comma, colon, period or parentheses instead.
- A call that keeps failing the same way won't work the next time: find another way.
- What your work leaves on a machine's disk beyond the outputs it's for (a build or a copy of a repository in /tmp, a download, a job's intermediates, a worktree once its change is merged), delete once you're done with it.
- A check that refuses something says why. Fix it, or only when the check is wrong for this case, send it again with \`bypass\`: one line on why.
- Keep what you say short: the answer or result first, in as few sentences as hold it; no preamble, no restating their ask, no recap of your steps, no hedges, no headers or lists where a sentence would do. An explanation they asked for gives the mechanism in a few lines, not every angle. Rarely, when the short answer can't hold what they need, give the long version as say's \`detail\`, opened on demand; it never repeats the short text.
- To show the user a file, image, video or 3D model, say it with say's \`files\`, or put it in what you say as a Markdown image of its path, whatever kind of file it is.
- Never wait or poll in a turn: set an expectation with \`when\` and end it, or block with \`wait\`. What you could check or do now, do now instead of waiting. A wait has a time only when a real one exists (a date someone gave, an ETA, a schedule, a print's end), cited as its source; never guess a due time for an event. When nothing records what you'd wait for (a port, a file, a page, a command's result), write a script (scripts_set) that fires an event when it happens, or ends when it does, and watch that; never a timer for it. Work that goes on past your turn (a server, a long command, a render) gets one before you end, firing on its end, its failure and a stall; a command left running in your turn's shell goes unheard.
- Elsewhere's [⇄ …](switch://…) links cite other conversations: when what you say draws on one, include its link as it is.
- Link what you name that has a page, as a Wikipedia article does: the words that name it are a Markdown link to it (an order, a product's listing, an email, a pull request, a booking; a space, task or action item here, by its row's link). Take each link from what you read (a record's link or url, the links in an email); never make one up.`

const decodeOpened = Schema.decodeUnknownOption(ThreadOpened.payload)
const decodePosted = Schema.decodeUnknownOption(MessagePosted.payload)
const decodeReacted = Schema.decodeUnknownOption(MessageReacted.payload)

const SPACE = "space:"

/** A space's master thread. */
export const threadOf = (space: SpaceId) => ThreadId.make(`${SPACE}${space}`)
export const spaceOf = (thread: ThreadId) =>
  thread.startsWith(SPACE) ? SpaceId.make(thread.slice(SPACE.length)) : null

const clip = (text: string, n: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

// The agent's own record and the brain's bookkeeping have no line: they aren't tagged or shown.
const SILENT = [
  "turn.",
  "thread.",
  "task.",
  "space.",
  "message.read",
  // A move's or a placement's own record: what it moved or placed shows where it went.
  "message.moved",
  "widget.placed",
  "widget.moved",
  "widget.removed",
  // A check's fix to a message of the agent's: the message is in its chat already.
  "message.revised",
  // Autonomy's bookkeeping: each knows its space already.
  "triage.",
  "gate.",
  "check.",
  "memory.",
  "expectation.",
  "item.",
  "reflection.",
  // The migration's cursor.
  "migrate.",
  // Reactors' cursors (brain's reactors.ts).
  "reactor.",
  // What waits to notify the user (notify.ts): its news says itself where it came from.
  "notify.",
  // Where extensions run (`spur.` before extensions were renamed).
  "machine.",
  "extension.",
  "spur.",
  // A script's set, start and retirement: its own records say themselves.
  "script.",
]

/** A script's record (scripts.ts): in the space that set the script. */
const scriptLine = (e: StoredEvent): Line | null => {
  if (e.source !== "script" || !isJson(e.payload) || typeof e.payload.space !== "string") {
    return null
  }
  const data = e.payload.data === undefined ? "" : ` ${clip(JSON.stringify(e.payload.data), 400)}`
  return {
    text: `${e.type} from script ${String(e.payload.script)}${data}`,
    home: SpaceId.make(e.payload.space),
  }
}

/** An extension's event: its health has no line; a message or a record says itself. */
const extensionLine = (e: StoredEvent): Line | null | undefined => {
  // An extension's own health isn't about any space: its vitals, and its heartbeat with or without
  // a stream (the senses watch reads those).
  if (
    e.type.endsWith(".heartbeat") ||
    (isJson(e.payload) &&
      typeof e.payload.stream === "string" &&
      e.payload.stream.startsWith("vitals/"))
  ) {
    return null
  }
  // A message: who, on what, what they said; its conversation is a reliable link.
  const m = messageOf(e.type, e.payload, e.time)
  if (m !== null) {
    const who = m.sender.me === true ? "Me" : (m.sender.name ?? m.sender.handle)
    const words = m.subject === undefined || m.subject === "" ? m.text : `${m.subject}: ${m.text}`
    return {
      text: `${who} (${m.channel}): ${clip(words, 400)}`,
      conversation: m.conversation,
      links: [m.conversation],
    }
  }
  return recordLine(e) ?? undefined
}

/** A shimmed record says itself in its summary, about its entity. */
export const recordLine = (e: StoredEvent): Line | null => {
  const data = isJson(e.payload) && isJson(e.payload.data) ? e.payload.data : null
  if (data === null || typeof data.summary !== "string") {
    return null
  }
  const text = `${e.type}: ${clip(data.summary, 400)}`
  return typeof data.entity === "string" ? { text, entity: data.entity } : { text }
}

/**
 * What a message replies to, as its line says it: words it quotes, and items it's on, each with the
 * user's reply to it when it has one.
 */
const repliedOn = (posted: typeof MessagePosted.payload.Type) => {
  const refs = posted.replyTo ?? []
  const quoted = refs.map((r) => {
    const on =
      r.kind === "quote"
        ? `replying to "${clip(r.text, 200)}" in message ${String(r.seq)}`
        : `on item ${r.id}`
    const reply = (r.reply ?? "").trim()
    return reply === "" ? ` (${on})` : ` (${on}: "${clip(reply, 400)}")`
  })
  const older =
    posted.item === undefined || refs.some((r) => r.kind === "ask")
      ? ""
      : ` (on item ${posted.item})`
  return [...quoted, older].join("")
}

/** What an event says, for the tagger and for context. */
export const line = (e: StoredEvent): Line | null => {
  // A space's master thread is tagged with its space on opening: the UI's link from thread to space.
  if (e.type === ThreadOpened.type) {
    const opened = Option.getOrNull(decodeOpened(e.payload))
    const space = opened === null ? null : spaceOf(opened.thread)
    return opened === null || space === null
      ? null
      : { text: `Opened ${opened.title}`, home: space }
  }
  const fromScript = scriptLine(e)
  if (fromScript !== null) {
    return fromScript
  }
  if (SILENT.some((p) => e.type.startsWith(p))) {
    return null
  }
  // The user's tapback says itself, and the words it's on when it's on some; yours, or one taken
  // back, has no line.
  if (e.type === MessageReacted.type) {
    const r = Option.getOrNull(decodeReacted(e.payload))
    return r === null || r.reaction === null || e.source === "agent"
      ? null
      : {
          text:
            r.quote === undefined
              ? `User reacted ${r.reaction} to message ${r.seq}`
              : `User reacted ${r.reaction} to these words of message ${r.seq}: "${clip(r.quote.text, 200)}"`,
          conversation: r.space,
          home: r.space,
        }
  }
  const posted = e.type === MessagePosted.type ? Option.getOrNull(decodePosted(e.payload)) : null
  if (posted !== null) {
    const who = saidBy({ source: e.source, from: posted.from }, "Switch", "User")
    const { widget } = posted
    const said = widget
      ? `[widget ${widget.app}/${widget.name} ${JSON.stringify(widget.input ?? {})}]`
      : posted.text
    const files = (posted.attachments ?? []).map((f) => ` [${f.name}]`).join("")
    const on = repliedOn(posted)
    return {
      text: `${who}${on}: ${said}${files}`,
      conversation: posted.space,
      home: posted.space,
    }
  }
  const said = extensionLine(e)
  if (said !== undefined) {
    return said
  }
  const text = `${e.type} ${JSON.stringify(e.payload)}`
  return e.type.startsWith("ui.") ? { text, fast: true } : { text }
}

interface Row {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
  readonly home: SpaceId
}

const parse: (json: string) => unknown = JSON.parse
const stored = (r: Row): StoredEvent => ({ ...r, payload: parse(r.payload) })

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

const since = (db: Database, space: SpaceId, after: number) =>
  db
    .query<Row, [string, number]>(
      `SELECT e.*, t.home FROM tags t JOIN events e ON e.seq = t.seq
       WHERE t.seq > ?2 AND (t.home = ?1 OR t.seq IN (SELECT seq FROM mentions WHERE space = ?1))
       ORDER BY t.seq DESC LIMIT 12`,
    )
    .all(space, after)
    .toReversed()
    .map(stored)
    // The user's messages here, or split off to here, are turns already; replies are in the conversation.
    .filter((e) => !e.type.startsWith("thread."))
    .filter(
      (e) =>
        !(
          e.type === MessagePosted.type &&
          (e.source !== "agent" || Option.getOrNull(decodePosted(e.payload))?.space === space)
        ),
    )

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu

/** Who new events are from or about, as Contacts knows them: a message's sender, an address an event names. */
const involved = (db: Database, events: readonly StoredEvent[]) => {
  const found = new Map<string, Person>()
  const add = (who: string) => {
    const people = peopleFor(db, who)
    const [p] = people
    if (people.length === 1 && p !== undefined) {
      found.set(p.id, p)
    }
  }
  for (const e of events.toReversed()) {
    if (found.size >= 6) {
      break
    }
    const m = messageOf(e.type, e.payload, e.time)
    if (m === null) {
      for (const email of (JSON.stringify(e.payload).match(EMAIL) ?? []).slice(0, 10)) {
        add(email)
      }
    } else if (m.sender.me !== true && m.sender.agent !== true) {
      add(m.sender.person ?? m.sender.handle)
    }
  }
  return [...found.values()]
}

const dated = (t: number) =>
  new Date(t).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

/** What the people new events are from or about said lately, on every channel, newest first. */
const lately = (db: Database, events: readonly StoredEvent[]) => {
  const people = involved(db, events)
  if (people.length === 0) {
    return []
  }
  const rows = messagesIn(db)
  const own = mine(rows)
  return people
    .filter((p) => !p.keys.some((k) => own.has(k)))
    .slice(0, 3)
    .map((p) => {
      const said = saidWith(db, rows, p, 5).map((m) => {
        const who = m.sender.me === true ? "Me" : (m.sender.name ?? m.sender.handle)
        const words =
          m.subject === undefined || m.subject === "" ? m.text : `${m.subject}: ${m.text}`
        return `- ${dated(m.at)} ${m.channel}, ${who}: ${clip(words, 160)}`
      })
      const handles = p.handles.slice(0, 6).join(", ")
      return `Latest with ${p.name}${handles === "" ? "" : ` (${handles})`} on every channel, newest first:\n${said.length > 0 ? said.join("\n") : "- nothing"}`
    })
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))}m`

const inFlight = (db: Database, thread: ThreadId, now: number) =>
  allThreads(db)
    .filter((t) => t.thread !== thread && (t.status === "running" || t.parent === thread))
    .filter((t) => t.status === "running" || t.status === "limited" || t.status === "idle")
    .map((t) => {
      const kind = t.parent === thread ? "task " : ""
      // Its turn's start, by the turn's span: a seek, not a read of every turn.started.
      const started = db
        .query<{ time: number }, [string]>(
          "SELECT e.time FROM turn_spans s JOIN events e ON e.seq = s.first WHERE s.turn = ?",
        )
        .get(t.turn ?? "")
      const age = started ? ` ${minutes(now - started.time)}` : ""
      return `- ${kind}${t.title}: ${t.status}${age}`
    })

const costToday = (db: Database, now: number) => {
  const midnight = new Date(now).setHours(0, 0, 0, 0)
  // Turns' spend from the spend index alone, not each of the day's turn.ended rows from the log.
  const row = db
    .query<{ usd: number | null }, [number]>(
      `SELECT coalesce((SELECT sum(json_extract(payload, '$.costUsd')) FROM events INDEXED BY events_ended_spend
                WHERE type = 'turn.ended' AND seq >= ?1), 0)
            + coalesce((SELECT sum(json_extract(payload, '$.cost')) FROM events
                WHERE type = 'message.read' AND seq >= ?1), 0) AS usd`,
    )
    .get(seqAt(db, midnight))
  return row?.usd ?? 0
}

const nowLine = (db: Database, now: number) => {
  const when = new Date(now).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const [load = 0] = loadavg()
  const free = freemem() / 2 ** 30
  const total = totalmem() / 2 ** 30
  return `Now: ${when} · $${costToday(db, now).toFixed(2)} spent today · load ${load.toFixed(1)} on ${cpus().length} cores, ${free.toFixed(0)} of ${total.toFixed(0)} GB free`
}

const describe = (s: Space, all: readonly Space[]) => {
  const parent = all.find((p) => p.id === s.parent)
  const where = parent === undefined || parent.id === HOME ? "" : ` (inside ${parent.name})`
  return `${s.name}${where}${s.about === "" ? "" : `: ${s.about}`}`
}

const SIX_HOURS = 6 * 3600 * 1000

/** What a thread runs on, and the profile's other roles: the model's knowledge of itself. */
const selfOf = (t: Thread, profile: Profile) => {
  const { provider, id } = route(t.model, profile)
  const r = profile.roles
  return `You: ${id} on the ${provider} subscription (${t.model}), running on ${hostname()}. Triage ${r.triage.id}, gates ${r.gate.id}, decisions ${r.decision.id}.`
}

/** What `delta` reads of the brain: a thread's view of its space, from `after`. */
interface DeltaInput {
  readonly space: SpaceId
  readonly thread: ThreadId
  readonly seen: number
  readonly after: number
  /** Triage's lines for the space since `after`, when it noted them; else the events' own. */
  readonly noted: string | null
  readonly recall: string
  readonly now: number
}

/** The message before a turn in a space's thread: what changed here and elsewhere, and now. */
const deltaRead = defineRead(
  "core/context/delta",
  (db, { space, thread, seen, after, noted, recall, now }: DeltaInput) => {
    const names = new Map(allSpaces(db).map((s) => [s.id, s.name]))
    const fresh = since(db, space, after)
    const raw = () =>
      fresh.map((e) => {
        const l = line(e)?.text ?? e.type
        return `- ${hhmm(e.time)} ${clip(l, 160)}`
      })
    const here = noted === null ? raw() : noted.split("\n").filter((l) => l !== "")
    const get = db.query<Row, [number]>(
      "SELECT e.*, t.home FROM events e JOIN tags t ON t.seq = e.seq WHERE e.seq = ?",
    )
    const other = elsewhere(db, {
      space,
      after,
      names,
      now,
      lineOf: (seq) => {
        const r = get.get(seq)
        return r ? (line(stored(r))?.text ?? r.type) : ""
      },
    })
    const flight = inFlight(db, thread, now)
    const parts = [
      here.length > 0 ? `In this space:\n${here.join("\n")}` : "",
      ...lately(db, fresh),
      surprisesFor(db, space, thread, seen),
      openHere(db, space, thread, now),
      other.length > 0 ? `Elsewhere:\n${other.join("\n")}` : "",
      flight.length > 0 ? `In flight:\n${flight.join("\n")}` : "",
      recall === "" ? "" : `Recall:\n${recall}`,
      macsLine(db, now),
      healthLine(db, now),
      nowLine(db, now),
    ]
    return parts.filter((p) => p !== "").join("\n\n")
  },
)

/** Where a first look starts: the event six hours before `now`. */
const firstLookRead = defineRead(
  "core/context/first-look",
  (db, now: number) => seqAt(db, now - SIX_HOURS) - 1,
)
/** Every space. */
const spacesRead = defineRead("core/context/spaces", allSpaces)
/** Who the user is. */
const userRead = defineRead("core/context/user", userOf)

/** `profile` is the one in use now. */
export const makeContext = (profile: Effect.Effect<Profile>) =>
  Effect.gen(function* making() {
    const brain = yield* Brain
    const memory = yield* Memory
    const triage = yield* Triage

    /** After identity in the system prompt: who the user is, the space and its core memory. */
    const stable = (t: Thread) =>
      Effect.gen(function* stabling() {
        const space = spaceOf(t.thread)
        if (space === null) {
          // A task told only it orchestrates handed its whole job to one child, hop after hop.
          return t.parent === null ? "" : `You are a task (${t.thread}), started by ${t.parent}.`
        }
        const spaces = yield* brain.read(spacesRead)
        const s = spaces.find((x) => x.id === space)
        const core = (yield* memory.core(space)).trim()
        const u = yield* brain.read(userRead)
        const who = [u?.name ?? "", u?.about ?? ""].filter((x) => x.trim() !== "").join(". ")
        return [
          selfOf(t, yield* profile),
          who === "" ? "" : `User: ${who}`,
          s === undefined ? "" : `Space: ${describe(s, spaces)} (id ${s.id})`,
          core === "" ? "" : `<memory>\n${core}\n</memory>`,
        ]
          .filter((x) => x !== "")
          .join("\n\n")
      })

    /** Before a message in a space's thread. Tasks get only their task. */
    const delta = (t: Thread, text: string) =>
      Effect.gen(function* delting() {
        const space = spaceOf(t.thread)
        if (space === null) {
          return ""
        }
        const now = Date.now()
        const recall = text === "" ? "" : (yield* memory.recall(space, text)).trim()
        // A first look covers the last six hours.
        const after = t.seen > 0 ? t.seen : yield* brain.read(firstLookRead, now)
        const noted = triage.delta === undefined ? null : (yield* triage.delta(space, after)).trim()
        return yield* brain.read(deltaRead, {
          space,
          thread: t.thread,
          seen: t.seen,
          after,
          noted,
          recall,
          now,
        })
      })

    return { stable, delta }
  })
