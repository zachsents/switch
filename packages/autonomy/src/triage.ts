// Triage: a small model reads tagged events in batches and sorts each into ignore, a note on its
// space, or wake. The same call gives the other spaces it bears on (mentions), the open
// expectations it meets. It never makes a space: an event stays in the space it was tagged to.
// Notes fill each space's "since you last looked" delta; wakes go to the space's agent at once.
// A batch takes seconds, so wakes also have a fast path: one decision per event as it's tagged.
import type { Database } from "bun:sqlite"
import {
  allSpaces,
  Brain,
  defineEvent,
  EventId,
  HOME,
  ItemId,
  on,
  SpaceId,
  SpaceTagged,
  SpaceUntagged,
} from "@switch/brain"
import type { Incoming, Line, Projection, Space, StoredEvent, ThreadId } from "@switch/brain"
import { Models } from "@switch/models"
import type { Question } from "@switch/models"
import { Triage as TriageSlot, waitingEvent } from "@switch/agent"
import type { Wake } from "@switch/agent"
import { messageOf } from "switch-ext-kit"
import { Effect, Layer, Option, Schema } from "effect"

import { ANSWER, BEARING, asRecord, bore } from "./bearing.ts"
import { ExpectationMet, openExpectations, plain } from "./expect.ts"
import { ItemClosed, items as allItems } from "./items.ts"
import { field, isRecord, jsonOf, strings, text } from "./json.ts"
import type { Expectation } from "./expect.ts"
import { messageReferences } from "./message-mentions.ts"
import { ownerOf, repeats } from "./owner.ts"
import {
  AT_ONCE,
  BATCH_MS,
  GIVE_UP_MS,
  GUIDE,
  RETRY_MS,
  TRIGGER_BATCH_MS,
  TriageDecided,
  bodyOf,
  oneLine,
  recordLine,
  recordQuestion,
} from "./ponder.ts"
import { isQuery } from "./records-query.ts"
import type { WakeFilter, WakeRule } from "./rules.ts"

const VERDICTS = ["ignore", "note", "wake"] as const
export type Sorting = (typeof VERDICTS)[number]

/** One batch. `through` is the last tag it read, ignored ones included. */
export const TriageSorted = defineEvent(
  "triage.sorted",
  1,
  Schema.Struct({
    through: Schema.Number,
    items: Schema.Array(
      Schema.Struct({
        seq: Schema.Number,
        /** The event's. */
        time: Schema.Number,
        space: SpaceId,
        verdict: Schema.Literals(["note", "wake"]),
        note: Schema.String,
        mentions: Schema.Array(SpaceId),
        /** An outcome an app reported that shows in its space's chat as a line. */
        line: Schema.optionalKey(Schema.Boolean),
        /** A line's condition: the same app's event about the same thing (`conditionKey`). */
        key: Schema.optionalKey(Schema.String),
        /** The line it revises, the same condition continuing, rather than a line of its own. */
        same: Schema.optionalKey(Schema.Number),
      }),
    ),
    ms: Schema.Number,
    cost: Schema.Number,
  }),
)

/** The fast path woke the event's space; its batch notes it, and doesn't wake it again. */
export const TriageWoke = defineEvent(
  "triage.woke",
  1,
  Schema.Struct({
    seq: Schema.Number,
    time: Schema.Number,
    space: SpaceId,
    note: Schema.String,
    probability: Schema.Number,
    ms: Schema.Number,
    cost: Schema.Number,
  }),
)

/** A wake rule began gathering a burst at this record: a restart gathers again from it. */
export const TriageGathering = defineEvent(
  "triage.gathering",
  1,
  Schema.Struct({ rule: Schema.String, seq: Schema.Number, tag: Schema.Number }),
)

/**
 * A batch its model couldn't read (a usage limit, the gateway down): it's read again until it is,
 * across restarts, and nothing in it is lost. Read once its `sorted` is in.
 */
export const TriageDeferred = defineEvent(
  "triage.deferred",
  1,
  Schema.Struct({
    through: Schema.Number,
    tags: Schema.Array(Schema.Number),
    /**
     * Read long after it came: it wakes only the spaces whose work hasn't had a turn since, as one
     * that has has already had its chance at it.
     */
    late: Schema.optionalKey(Schema.Boolean),
    /** A Gateway model it's read on, rather than the profile's triage model. */
    model: Schema.optionalKey(
      Schema.Struct({ provider: Schema.Literal("gateway"), id: Schema.String }),
    ),
  }),
)

export const triage: Projection = {
  name: "triage",
  version: 2,
  tables: ["triage_notes", "triage_state", "triage_woke"],
  create: `
    CREATE TABLE triage_notes (seq INTEGER NOT NULL, space TEXT NOT NULL, home INTEGER NOT NULL,
      verdict TEXT NOT NULL, note TEXT NOT NULL, time INTEGER NOT NULL, PRIMARY KEY (space, seq));
    CREATE TABLE triage_state (id INTEGER PRIMARY KEY CHECK (id = 1), through INTEGER NOT NULL,
      cost REAL NOT NULL);
    INSERT INTO triage_state (id, through, cost) VALUES (1, 0, 0);
    CREATE TABLE triage_woke (seq INTEGER PRIMARY KEY, space TEXT NOT NULL);`,
  on: [
    on(TriageWoke, (db, p) => {
      db.query("INSERT OR IGNORE INTO triage_woke (seq, space) VALUES (?, ?)").run(p.seq, p.space)
      db.query(
        "INSERT OR IGNORE INTO triage_notes (seq, space, home, verdict, note, time) VALUES (?, ?, 1, 'wake', ?, ?)",
      ).run(p.seq, p.space, p.note, p.time)
      db.query("UPDATE triage_state SET cost = cost + ? WHERE id = 1").run(p.cost)
    }),
    on(TriageSorted, (db, p) => {
      const insert = db.query(
        "INSERT OR REPLACE INTO triage_notes (seq, space, home, verdict, note, time) VALUES (?, ?, ?, ?, ?, ?)",
      )
      for (const i of p.items) {
        insert.run(i.seq, i.space, 1, i.verdict, i.note, i.time)
        for (const m of i.mentions) {
          insert.run(i.seq, m, 0, i.verdict, i.note, i.time)
        }
      }
      db.query(
        "UPDATE triage_state SET through = max(through, ?), cost = cost + ? WHERE id = 1",
      ).run(p.through, p.cost)
    }),
    // A wake rule's decisions are triage's spend too.
    on(TriageDecided, (db, p) => {
      db.query("UPDATE triage_state SET cost = cost + ? WHERE id = 1").run(p.cost)
    }),
    // An event moved to another space (a retag) takes its note along.
    on(SpaceTagged, (db, p, e) => {
      if (e.source === "retag") {
        db.query("UPDATE OR REPLACE triage_notes SET space = ? WHERE seq = ? AND home = 1").run(
          p.home,
          p.seq,
        )
      }
    }),
    // One that's no space's after all takes its notes with it.
    on(SpaceUntagged, (db, p) => {
      db.query("DELETE FROM triage_notes WHERE seq = ?").run(p.seq)
    }),
  ],
  snapshot: (db) => db.query("SELECT through, cost FROM triage_state").get(),
}

/**
 * What a woken turn reads after what woke it, as Switchboard's woken record ended
 * (core/context.rs:1926-1960): each is a record it can open, and the work comes before the ask.
 * Its "nothing you say here reaches them" stays behind: a turn the agent starts itself may say.
 */
const wokenWith = (lines: readonly string[]) =>
  `${lines.join("\n")}\n\nEach is a record brain query opens by its seq. When something needs the user, do the work first: what you can without sending, spending or deciding for them (the reply drafted on the item, the files made, the answer found), so the item you put in their queue leaves them only the decision or the committal click. When that's more than this turn should take on, start a task for it (delegate_task, at the effort it deserves) that does it and puts up the item itself. Or do what their rules let you do without asking. When nothing needs them, end the turn on nothing: that's the usual outcome, and it's fine.`

/** A condition's line in a space's chat: the latest line of its key. */
export interface OpenLine {
  readonly seq: number
  readonly note: string
  /** When it was last revised. */
  readonly updated: number
  /** What its latest event said. */
  readonly said: string
}

/** Lines of one app's events about one thing are one condition's. */
export const conditionKey = (event: StoredEvent, line: Line) =>
  `${event.type} from ${event.source}${line.entity === undefined ? "" : ` on ${line.entity}`}`

/** A condition's line unrevised this long is over: its next event starts a line of its own. */
export const LINE_FRESH = 6 * 3600 * 1000

export const triageConfig = {
  events: [TriageSorted, TriageWoke, TriageDecided, TriageGathering, TriageDeferred],
  projections: [triage],
  commands: [],
}

interface Note {
  readonly seq: number
  readonly home: number
  readonly note: string
  readonly time: number
}

/** A space's notes after `since`, oldest first. */
export const notesSince = (db: Database, space: SpaceId, since: number): Note[] =>
  db
    .query<Note, [string, number]>(
      "SELECT seq, home, note, time FROM triage_notes WHERE space = ? AND seq > ? ORDER BY seq",
    )
    .all(space, since)

const SYSTEM = `You triage events for Switch, the user's personal agent. Switch keeps a tree of spaces (projects and sub-projects), each with one master thread and an agent working in it. Every event below already lives in one space (given). For each event decide:

- "v": "wake" when the space's agent should take care of it now: a person's message to the user or their business (a text, an email, a DM) that bears on the space, whatever it asks or says, so the agent drafts the reply, does the work or decides nothing's needed; and the user waiting on it, something broken or about to break, a deadline near, a job the agent started failing or finishing (the work that started it hears it). "note" only for what asks nothing of anyone, which the agent reads next time it looks: automated notices, status changes, receipts, updates on something already handled. Anything that needs a reply or action is "wake", never "note". One exception: a person's message in a conversation the user handles themselves (marked so) is "note" when it's personal (chatter, feelings, plans or questions between the two of them, which the user is answering already), and "wake" only for business, logistics Switch should act on (a booking, a delivery, a payment, something to schedule or look up) or an ask of Switch. "ignore" when no one working on its space needs it (noise, spam, marketing, routine state nothing hinges on).
- "person": true when the event is a message a person wrote to the user or their business, not an automated sender (a notification, alert, newsletter, receipt or no-reply address).
- "note": for note or wake, one line under 120 characters saying what changed, with the names and numbers that matter, about this event's own subject only: never restate other lines or other events. Empty for ignore.
- "line": true only for an app's event the user would want to see in its space's chat as it happens: an outcome such as an order paid, a delivery arrived, a print the user asked for done. Never for routine state, progress, messages or chatter, nor for the agent's own jobs (a build, a simulation, a script, a render it started), whose work hears how they end, nor for trouble in Switch itself (an extension or source down or crash-looping, an error): that is the agent's to fix, a "wake", not the user's to watch. Most events are false.
- "same": for a line, the line it continues when its subject has one: an id from "Lines in its space's chat now" ("L123"), or an earlier event in this batch that makes a line ("e2"). One subject is one line, revised in place to its latest state however it moves or is worded: an order placed, shipped and delivered is one line; "delayed", "still delayed", "delayed again, now Friday" are one delay. Its note then says the latest, with since when. "" only for a subject no line has yet (another order, another printer, a new job).
- "mentions": other spaces whose threads should show it too, as "mentioned in": only when someone working on that other space would need to see this event, because it reports on, changes, blocks or is caused by that space's own work. Sharing a topic, a person, a printer or a word is not enough, and the spaces above its own already see it. For a chat message, the other space must be referenced in the actual message's words or link; never infer it from the agent's app, provider, tools, system context or the project running the agent. A reference alone still needs the work relationship above. Most events mention nothing.
- "meets": ids of open expectations, or of action items that close themselves (each listed with its space), that this event shows have happened or now hold.

An event's time is when it happened. One from long before now came late (a source that was down caught up): wake only for what still needs acting on now, and note what's past.

The user's rules and preferences, when given below, say what they want woken for and what can wait.

Answer with JSON only: {"e0": {"v": "ignore", "person": false, "note": "", "line": false, "same": "", "mentions": [], "meets": []}, ...}, one key per event.`

// Measured on the membership corpus (.experiments/autonomy): ten per call.
const BATCH = 10
const parseSeqs: (json: string) => readonly number[] = JSON.parse
const parseModel: (json: string) => { readonly provider: "gateway"; readonly id: string } =
  JSON.parse
const MINUTE_MS = 60_000
const AGAIN_AT_ONCE = 3
const LATEST = 2
const EARLIER = 2
const EARLIER_WITHIN = 2 * 3600 * 1000
/** An event that happened this long before it's read came late: no fast wake, and its batch says now. */
const LATE_MS = 10 * 60_000
const cameLate = (t: Tagged, now: number) => t.event.time < now - LATE_MS

const FAST =
  "You triage events for Switch, the user's personal agent. Switch keeps a tree of spaces (projects and " +
  "sub-projects), each with an agent working in it. An event has just arrived in a space. Decide whether that space's " +
  "agent should act on it now, or whether it can wait until the agent next looks. The user's rules " +
  "and preferences, when given, say what they want woken for."

const WAKE: Question = {
  instructions:
    "Does this event need the agent to act within minutes, so that waiting until its next look would cost something?",
  choices: [
    {
      value: "wake",
      description:
        "Yes: someone other than the user just asked or answered something that needs a reply, something broke or failed, or a deadline is within hours.",
    },
    {
      value: "wait",
      description:
        "No: the user's own outgoing messages, status and progress reports, routine updates, listings, receipts, reminders far off, chatter, noise.",
    },
  ],
}
/** A glob over a record's stream, as Switchboard's filters wrote them: `*` one part, `**` any. */
export const globbed = (pattern: string, stream: string) =>
  new RegExp(
    `^${pattern
      .split("**")
      .map((part) =>
        part
          .split("*")
          .map((x) => x.replaceAll(/[.+?^${}()|[\]\\]/gu, "\\$&"))
          .join("[^/]*"),
      )
      .join(".*")}$`,
    "u",
  ).test(stream)

/** A dotted path into a record (`body.facts.inbox`): its envelope, `body` its body. */
const pathOf = (payload: unknown, path: string) => {
  const [head = "", ...rest] = path.split(".")
  let v = head === "body" ? bodyOf(payload) : field(payload, head)
  for (const k of rest) {
    v = field(v, k)
  }
  return v
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Whether a record is one a rule's filter lets in (protocol/src/kernels.rs:150-161 `Wakes::matches`):
 * its stream and kind, no source it leaves out, its fields; and none a trigger's `unless` rules out
 * (core/triggers.rs:89-99).
 */
export const lets = (w: WakeFilter, e: StoredEvent) => {
  const stream = text(field(e.payload, "stream"))
  const kind = text(field(e.payload, "kind"))
  const source = e.source.replace(/^sb:/u, "")
  return (
    w.streams.some((p) => globbed(p, stream)) &&
    (w.kinds.length === 0 || w.kinds.includes(kind)) &&
    !w.notFrom.some((p) => globbed(p, source)) &&
    Object.entries(w.match).every(([k, v]) => equal(pathOf(e.payload, k), v)) &&
    !Object.entries(w.unless).some(([k, v]) => equal(pathOf(e.payload, k), v))
  )
}

// Fast wakes at or above the user's `wake.at` dial (settings.ts); the batch still catches the
// rest. Against 147 corpus events Opus labeled with hindsight (.experiments/polish), its default
// 0.5 had precision .49, recall .82; the batch had .54 and .32.

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

const when = (time: number) =>
  new Date(time).toLocaleString("en-US", {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

const parseJson: (json: string) => unknown = JSON.parse

interface EventRow {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

const stored = (r: EventRow): StoredEvent => ({ ...r, payload: parseJson(r.payload) })

interface Tagged {
  readonly tag: StoredEvent
  readonly event: StoredEvent
  readonly line: Line
  readonly home: SpaceId
  /** Its tag's payload, which a retag carries over. */
  readonly tagged: typeof SpaceTagged.payload.Type
}

/** Spaces a mention can name: open ones, and not the home or above it. */
const lineage = (byId: ReadonlyMap<string, Space>, id: SpaceId) => {
  const out: SpaceId[] = []
  for (let s = byId.get(id); s !== undefined && !out.includes(s.id); s = byId.get(s.parent ?? "")) {
    out.push(s.id)
  }
  return out
}

export interface TriageConfig {
  readonly line: (event: StoredEvent) => Line | null
  /** A space's master thread, which its wakes go to. */
  readonly threadOf: (space: SpaceId) => ThreadId
  /** The user's rules and preferences for these spaces that bear on `about` (rules.ts). */
  readonly rules?: (spaces: readonly SpaceId[], about: string) => Effect.Effect<string>
  /** The user's wake rules for these spaces, each with what it reads (rules.ts `wakeRulesOf`). */
  readonly wakeRules?: (spaces: readonly SpaceId[]) => Effect.Effect<readonly WakeRule[]>
  /** How sure the fast path must be to wake: the user's `wake.at` dial. */
  readonly wakeAt?: Effect.Effect<number>
  /** A condition's line in a space's chat, when it has one. */
  readonly openLine: (db: Database, space: SpaceId, key: string) => OpenLine | null
  /** A space's chat lines revised lately, newest first: what a line can continue. */
  readonly openLines: (db: Database, space: SpaceId) => readonly OpenLine[]
}

/** Whether a rule decided on this record lately. */
const decidedFor = (db: Database, rule: string, seq: number) =>
  db
    .query(
      `SELECT 1 FROM events d, json_each(json_extract(d.payload, '$.records')) r
       WHERE d.type = 'triage.decided' AND d.time > ? AND json_extract(d.payload, '$.rule') = ?
         AND json_extract(r.value, '$.seq') = ? LIMIT 1`,
    )
    .get(Date.now() - GIVE_UP_MS, rule, seq) !== null

/** Whether the thread had a turn after `seq`. */
const turnSince = (db: Database, thread: ThreadId, seq: number) =>
  db
    .query(
      "SELECT 1 FROM events WHERE type = 'turn.started' AND json_extract(payload, '$.thread') = ? AND seq > ? LIMIT 1",
    )
    .get(thread, seq) !== null

/**
 * Where triage reads on from after a restart: the last tag a batch read, sorted or deferred (a
 * deferred one is read again by `due`). Null before it ever read one.
 */
const readThrough = (db: Database) =>
  db
    .query<{ through: number | null }, []>(
      `SELECT max(through) AS through FROM (
         SELECT through FROM triage_state WHERE through > 0
         UNION ALL SELECT max(json_extract(payload, '$.through')) FROM events WHERE type = 'triage.deferred')`,
    )
    .get()?.through ?? null

const card = (s: Space, byId: ReadonlyMap<string, Space>) => {
  if (s.id === HOME) {
    return `- ${HOME}: Home, the root; whatever fits no other space.`
  }
  const where =
    s.parent === HOME || s.parent === null
      ? "top level"
      : `inside ${byId.get(s.parent)?.name ?? s.parent}`
  return `- ${s.id}: ${s.name} (${where}). ${s.about}`.trim()
}

/** Another space's known identifiers in the text: a hint, never an answer. */
const named = (spaces: readonly Space[], above: readonly string[], said: string) => {
  const lower = said.toLowerCase()
  return spaces.filter(
    (s) =>
      !above.includes(s.id) &&
      s.id !== HOME &&
      s.about
        .split(/[,;.]\s*|\s+/u)
        .some((w) => w.length > 4 && /[A-Z0-9@-]/u.test(w) && lower.includes(w.toLowerCase())),
  )
}

// Everything the model reads besides the instructions, read when the batch is sorted.
const context = (
  db: Database,
  batch: readonly Tagged[],
  lineOf: (event: StoredEvent) => string,
  openLines: TriageConfig["openLines"],
  handled: ReadonlyMap<number, number>,
) => {
  const spaces = allSpaces(db).filter((s) => !s.archived)
  const lines = new Map(
    [...new Set(batch.map((t) => t.home))].map((space) => [space, openLines(db, space)] as const),
  )
  const byId = new Map<string, Space>(spaces.map((s) => [s.id, s]))
  const latest = db.query<EventRow, [string, number]>(
    "SELECT e.* FROM tags t JOIN events e ON e.seq = t.seq WHERE t.home = ? ORDER BY t.seq DESC LIMIT ?",
  )
  const recent = spaces.flatMap((s) => {
    const rows = latest.all(s.id, LATEST).toReversed()
    return rows.length > 0
      ? [`- ${s.id}: ${rows.map((r) => clip(lineOf(stored(r)), 140)).join(" | ")}`]
      : []
  })
  const earlier = db.query<EventRow, [string, number, number, number]>(
    "SELECT e.* FROM tags t JOIN events e ON e.seq = t.seq WHERE t.conversation = ? AND e.time > ? AND t.seq < ? ORDER BY t.seq DESC LIMIT ?",
  )
  const expected = openExpectations(db).filter(plain)
  // One whose `resolveWhen` is a query closes when it finds something (resolve.ts); the rest are words.
  const resolving = allItems(db, { status: "open" }).filter(
    (i) => i.completion !== "owner" && i.resolveWhen !== undefined && !isQuery(i.resolveWhen),
  )
  const listed = batch.map((t, i) => {
    const c = t.line.conversation
    const before =
      c === undefined || t.line.fast === true
        ? []
        : earlier.all(c, t.event.time - EARLIER_WITHIN, t.event.seq, EARLIER).toReversed()
    const hints = named(spaces, lineage(byId, t.home), t.line.text)
    const last = handled.get(t.event.seq)
    return [
      `e${i} (${when(t.event.time)}), lives in ${t.home}: ${t.line.text}`,
      ...(last === undefined
        ? []
        : [`  the user handles this conversation themselves (last wrote ${when(last)})`]),
      ...(before.length > 0
        ? [
            `  earlier in its conversation: ${before.map((r) => clip(lineOf(stored(r)), 160)).join(" | ")}`,
          ]
        : []),
      ...(hints.length > 0 ? [`  hints: names ${hints.map((s) => s.id).join(", ")}`] : []),
    ].join("\n")
  })
  const now = Date.now()
  const item = [
    batch.some((t) => cameLate(t, now)) ? `Now: ${when(now)}` : "",
    `Spaces:\n${spaces.map((s) => card(s, byId)).join("\n")}`,
    recent.length > 0 ? `Latest lines in each space's thread:\n${recent.join("\n")}` : "",
    [...lines].some(([, l]) => l.length > 0)
      ? `Lines in its space's chat now:\n${[...lines].flatMap(([space, l]) => l.map((o) => `- L${String(o.seq)} (${space}, ${when(o.updated)}): ${o.note}`)).join("\n")}`
      : "",
    expected.length > 0
      ? `Open expectations:\n${expected.map((x: Expectation) => `- ${x.id} (${x.space}): ${x.what}${x.by === null ? "" : `, by ${when(x.by)}`}`).join("\n")}`
      : "",
    resolving.length > 0
      ? `Action items that close themselves:\n${resolving.map((i) => `- ${i.id} (${i.space}): ${i.resolveWhen ?? ""}`).join("\n")}`
      : "",
    `Events:\n${listed.join("\n")}`,
  ]
    .filter((s) => s !== "")
    .join("\n\n")
  return {
    item,
    byId,
    meetable: new Set([...expected.map((x) => x.id), ...resolving.map((i) => i.id)]),
    resolving: new Set<string>(resolving.map((i) => i.id)),
    lines: (space: SpaceId): ReadonlySet<number> =>
      new Set((lines.get(space) ?? []).map((o) => o.seq)),
  }
}

/** What the fast path reads about one event: its space, that space's latest, the event. */
const quick = (db: Database, t: Tagged, lineOf: (event: StoredEvent) => string) => {
  const spaces = allSpaces(db).filter((s) => !s.archived)
  const byId = new Map<string, Space>(spaces.map((s) => [s.id, s]))
  const space = byId.get(t.home)
  const latest = db
    .query<EventRow, [string, number, number]>(
      "SELECT e.* FROM tags t JOIN events e ON e.seq = t.seq WHERE t.home = ? AND t.seq < ? ORDER BY t.seq DESC LIMIT ?",
    )
    .all(t.home, t.event.seq, LATEST)
    .toReversed()
  const c = t.line.conversation
  const before =
    c === undefined
      ? []
      : db
          .query<EventRow, [string, number, number, number]>(
            "SELECT e.* FROM tags t JOIN events e ON e.seq = t.seq WHERE t.conversation = ? AND e.time > ? AND t.seq < ? ORDER BY t.seq DESC LIMIT ?",
          )
          .all(c, t.event.time - EARLIER_WITHIN, t.event.seq, EARLIER)
          .toReversed()
  const expected = openExpectations(db, [t.home]).filter(plain)
  return [
    `Its space:\n${space ? card(space, byId) : `- ${t.home}`}`,
    latest.length > 0
      ? `Latest lines there: ${latest.map((r) => clip(lineOf(stored(r)), 140)).join(" | ")}`
      : "",
    expected.length > 0
      ? `Open expectations there: ${expected.map((x) => `${x.what}${x.by === null ? "" : `, by ${when(x.by)}`}`).join("; ")}`
      : "",
    before.length > 0
      ? `Earlier in its conversation: ${before.map((r) => clip(lineOf(stored(r)), 160)).join(" | ")}`
      : "",
    `Event (${when(t.event.time)}): ${t.line.text}`,
  ]
    .filter((x) => x !== "")
    .join("\n\n")
}

/** A finished task wakes the thread that started it, unless it was cancelled: that one knows. */
const readTags = (
  db: Database,
  tags: readonly StoredEvent[],
  line: (event: StoredEvent) => Line | null,
) => {
  const get = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq = ?")
  return tags.flatMap((tag): Tagged[] => {
    const tagged = Option.getOrNull(decodeTagged(tag.payload))
    const row = tagged === null ? null : get.get(tagged.seq)
    if (!row || tagged === null) {
      return []
    }
    const event = stored(row)
    // Its own bookkeeping and the agent's are never news: reading them would wake itself.
    const l =
      OWN.some((p) => event.type.startsWith(p)) || STATE.some((x) => event.type.endsWith(x))
        ? null
        : line(event)
    return l ? [{ tag, event, line: l, home: tagged.home, tagged }] : []
  })
}

/** One event's answer, checked against what exists. */
const answerOf = (
  a: unknown,
  t: Tagged,
  byId: ReadonlyMap<string, Space>,
  meetable: ReadonlySet<string>,
  /** A job's record, which its work hears instead. */
  owned: boolean,
) => {
  const v = field(a, "v")
  const above = lineage(byId, t.home)
  return {
    verdict: VERDICTS.find((x) => x === v) ?? "ignore",
    note: text(field(a, "note")),
    // Only an app's own event: a message or the UI is never a line of its own.
    // and a client's own report (a crash, a hang) is a diagnostic, never a line, nor a job's.
    line:
      !owned &&
      field(a, "line") === true &&
      t.line.home === undefined &&
      t.line.fast !== true &&
      !t.event.type.startsWith("client."),
    same: text(field(a, "same")),
    mentions: [
      ...new Set(
        strings(field(a, "mentions")).flatMap((s) => {
          const space = byId.get(s)
          if (!space || space.id === HOME || above.includes(space.id)) {
            return []
          }
          if (
            t.event.type === "message.posted" &&
            !messageReferences(text(field(t.event.payload, "text")), space)
          ) {
            return []
          }
          return [space.id]
        }),
      ),
    ],
    meets: strings(field(a, "meets")).filter((id) => meetable.has(id)),
    person: field(a, "person") === true,
  }
}

const decodeTagged = Schema.decodeUnknownOption(SpaceTagged.payload)

const OWN = [
  "triage.",
  "gate.",
  "memory.",
  "expectation.",
  "item.",
  "reflection.",
  "turn.",
  "thread.",
  // Switchboard's surprises were input to the next turn of the work they name, never a wake
  // (core docs.md, `surprise`); leads were the monologue's to act on, once each.
  "surprise.",
  "lead.",
  // The agent's own accounts and clients: their states and reports woke nothing there.
  "account.",
  "client.",
  "iphone.",
]

/**
 * State, not news. A Mac's attention and vitals: Switchboard read them for its Macs line and health,
 * and no kernel woke on them. A job's progress: its card shows that, never a line (Switchboard's
 * activities, core docs.md).
 */
const STATE = [".attention", ".vitals", "_progress"]

const sorted = (through: number, items: unknown[], ms: number, cost: number): Incoming => ({
  id: EventId.make(`sorted:${through}`),
  type: TriageSorted.type,
  source: "triage",
  payload: { through, items, ms, cost },
})

const rulesFor = (config: TriageConfig, spaces: readonly SpaceId[], about: string) =>
  config.rules ? config.rules(spaces, about) : Effect.succeed("")

// A message in its own chat is already a turn; mentioning it elsewhere is a note.
const settle = (verdict: Sorting, t: Tagged, mentioned: boolean): Sorting => {
  if (t.line.home !== undefined) {
    return mentioned ? "note" : "ignore"
  }
  return verdict
}

/** How long a rule's burst gathers: its own `batch_s`, else a trigger's or a kernel's default. */
const batchMs = (rule: WakeRule) => {
  const s = rule.wakes?.batchS ?? null
  if (s !== null) {
    return s * 1000
  }
  return rule.wakes?.at === null ? TRIGGER_BATCH_MS : BATCH_MS
}

/** A rule's decision on what it read, kept. */
const decided = (
  rule: WakeRule,
  at: number,
  read: readonly { readonly t: Tagged; readonly p: number }[],
  verdict: "wake" | "rest" | "lost",
  ms: number,
  cost: number,
): Incoming => ({
  id: EventId.make(`decided:${rule.name}:${String(read.at(-1)?.t.event.seq ?? 0)}`),
  type: TriageDecided.type,
  source: "triage",
  payload: {
    rule: rule.name,
    at,
    records: read.map((r) => ({ seq: r.t.event.seq, p: Math.round(r.p * 100) / 100 })),
    verdict,
    ms,
    cost,
  },
})

/** The user's own words never woke a kernel there (mail: sent false; DMs: new from them). */
const ownWords = (t: Tagged) =>
  messageOf(t.event.type, t.event.payload, t.event.time)?.sender.me === true

/**
 * Someone's message to the user (a text, an email, a DM): what triage is for. Its wake stands
 * whatever the wake rules say, and every message is news, though its thread is one entity.
 */
const fromSomeone = (t: Tagged) => {
  const m = messageOf(t.event.type, t.event.payload, t.event.time)
  return m !== null && m.sender.me !== true
}

/** The user wrote in its conversation after it: it's handled already. */
const answered = (db: Database, t: Tagged) => {
  const c = t.line.conversation
  return (
    c !== undefined &&
    db
      .query(
        `SELECT 1 FROM tags g JOIN events e ON e.seq = g.seq
         WHERE g.conversation = ? AND g.seq > ? AND e.time <= ?
           AND json_extract(e.payload, '$.sender.me') = 1 LIMIT 1`,
      )
      .get(c, t.event.seq, Date.now()) !== null
  )
}

/**
 * A message recorded before, said again (marked read, edited, delivered, a source's rescan): never
 * news. By the message's own id on the log, so it holds across restarts.
 */
const recordedBefore = (db: Database, t: Tagged) => {
  const m = messageOf(t.event.type, t.event.payload, t.event.time)
  return (
    m !== null &&
    db
      .query(
        "SELECT 1 FROM events INDEXED BY events_type WHERE type = ? AND seq < ? AND json_extract(payload, '$.message.id') = ? LIMIT 1",
      )
      .get(t.event.type, t.event.seq, m.id) !== null
  )
}

/** The user wrote in a conversation this recently: they're in it now. */
const ACTIVE_MS = 30 * MINUTE_MS
/** This many of the user's own messages in a conversation within HANDLED_WITHIN: it's theirs. */
const HANDLED_AT = 5
const HANDLED_WITHIN = 7 * 24 * 3600 * 1000

/**
 * When the user last wrote in its conversation, if they handle it themselves: they wrote there in
 * the last half hour, or often in the last week. Null otherwise.
 */
const handledBy = (db: Database, t: Tagged) => {
  const c = t.line.conversation
  if (c === undefined || !fromSomeone(t)) {
    return null
  }
  const own = db
    .query<{ last: number | null; n: number }, [string, number, number, number]>(
      `SELECT max(e.time) AS last, count(*) AS n FROM tags g JOIN events e ON e.seq = g.seq
       WHERE g.conversation = ? AND g.seq < ? AND e.time > ? AND e.time <= ?
         AND json_extract(e.payload, '$.sender.me') = 1`,
    )
    .get(c, t.event.seq, t.event.time - HANDLED_WITHIN, t.event.time)
  if (own === null || own.last === null) {
    return null
  }
  return own.last >= t.event.time - ACTIVE_MS || own.n >= HANDLED_AT ? own.last : null
}

/**
 * A person's message it doesn't ignore wakes its space: the agent takes care of it. One a source
 * brought in long after it was sent (a backfill of history), or in a conversation the user handles
 * themselves, goes by the model's verdict.
 */
const verdictOf = (
  a: { readonly verdict: Sorting; readonly person: boolean },
  t: Tagged,
  handled: boolean,
) => {
  const m = messageOf(t.event.type, t.event.payload, t.event.time)
  return a.verdict === "note" &&
    a.person &&
    !handled &&
    fromSomeone(t) &&
    m !== null &&
    m.at >= t.event.time - LATE_MS
    ? "wake"
    : a.verdict
}

/**
 * A wake the batch holds back as a note: what's said again or answered already, and once the user
 * has wake rules, what only a rule's own decision wakes, all but someone's message.
 */
const held = (
  t: Tagged,
  later: ReadonlySet<number>,
  rules: boolean,
  owners: ReadonlyMap<number, ThreadId>,
) => later.has(t.event.seq) || (rules && !fromSomeone(t) && !owners.has(t.event.seq))

/** A batch woke its space for it: no rule wakes it again. */
const batchWoke = (db: Database, seq: number) =>
  db
    .query(
      "SELECT 1 FROM triage_notes WHERE seq = ? AND home = 1 AND verdict = 'wake' AND seq NOT IN (SELECT seq FROM triage_woke)",
    )
    .get(seq) !== null

/**
 * Switch's own records as Switchboard's were, for the rules written against them: an item put up
 * as an ask in `asks` (its kind the ask's type, its words its text; one an app's ask raised is that
 * ask's record already), and a turn starting in a space's work (its master thread or a task) as
 * `work/<thread>`'s `turn`, running (claude/src/turn.rs:629-631, the turn record at its start).
 */
const switchboardRecord = (db: Database, e: StoredEvent): StoredEvent | null => {
  if (e.type === "item.opened") {
    const { kind, body, ...rest } = isRecord(e.payload) ? e.payload : {}
    if (rest.app !== undefined && rest.app === rest.decision) {
      return null
    }
    return {
      ...e,
      payload: { stream: "asks", kind: "ask", data: { ...rest, type: kind, text: body } },
    }
  }
  if (e.type === "turn.started") {
    const thread = text(field(e.payload, "thread"))
    const work = db
      .query<{ title: string }, [string]>(
        "SELECT title FROM threads WHERE thread = ? AND (thread LIKE 'space:%' OR parent IS NOT NULL)",
      )
      .get(thread)
    return work === null
      ? null
      : {
          ...e,
          payload: {
            stream: `work/${thread}`,
            kind: "turn",
            data: { summary: work.title, status: "running" },
          },
        }
  }
  return e
}

/**
 * A record a rule may read: any committed event that carries a stream, tagged or not, as
 * Switchboard's ponderer read the kernels' streams themselves (ponder.rs:226-229 `feed`), the user's
 * own words too (ponder.rs:78-81 leaves out only the kernel's own work), its own bookkeeping aside.
 * Its space is settled when its burst is read.
 */
const recordOf = (
  db: Database,
  event: StoredEvent,
  lineOf: (event: StoredEvent) => Line | null,
): Tagged | null => {
  const e = switchboardRecord(db, event)
  if (e === null) {
    return null
  }
  const stream = text(field(e.payload, "stream"))
  if (stream === "" || (e === event && OWN.some((p) => e.type.startsWith(p)))) {
    return null
  }
  const body = bodyOf(e.payload)
  const said = lineOf(e) ?? {
    text: `${e.type}: ${clip(text(field(body, "summary")) || text(field(body, "text")), 400)}`,
    ...(typeof field(body, "entity") === "string" && { entity: text(field(body, "entity")) }),
  }
  return {
    tag: e,
    event: e,
    line: said,
    home: HOME,
    tagged: { seq: e.seq, home: HOME, mentions: [], conversation: null, links: [] },
  }
}

/** Where a gathered record belongs by now: its tag's space, else Home. */
const placed = (db: Database, t: Tagged): Tagged => {
  const home =
    db.query<{ home: SpaceId }, [number]>("SELECT home FROM tags WHERE seq = ?").get(t.event.seq)
      ?.home ?? HOME
  return { ...t, home }
}

/** Sorts the tags in each batch the brain commits; returns the turns to wake. */
export const makeTriage = (config: TriageConfig) =>
  Effect.gen(function* triaging() {
    const brain = yield* Brain
    const models = yield* Models

    // Switchboard's `wakes.first`: only the first record about an entity counts, never the ones that
    // say it changed (a status said again, an ETA moved, another layer printed). Each entity's
    // first seq, by its type.
    const firsts = new Map<string, number>()
    const firstAbout = (db: Database, t: Tagged, entity: string | undefined) => {
      if (entity === undefined || entity === "") {
        return true
      }
      const key = `${t.event.type}\n${entity}`
      let seq = firsts.get(key)
      if (seq === undefined) {
        seq =
          db
            .query<{ seq: number | null }, [string, string]>(
              "SELECT min(seq) AS seq FROM events WHERE type = ? AND json_extract(payload, '$.data.entity') = ?",
            )
            .get(t.event.type, entity)?.seq ?? t.event.seq
        firsts.set(key, seq)
      }
      return seq === t.event.seq
    }

    // What's said again or answered already: a job's record when it says what its last did.
    const laterIn = (
      db: Database,
      batch: readonly Tagged[],
      owners: ReadonlyMap<number, ThreadId>,
    ) =>
      new Set(
        batch
          .filter((t) =>
            owners.has(t.event.seq)
              ? repeats(db, t.event)
              : ownWords(t) ||
                answered(db, t) ||
                recordedBefore(db, t) ||
                (!fromSomeone(t) && !firstAbout(db, t, t.line.entity)),
          )
          .map((t) => t.event.seq),
      )

    // A line's condition, and the line it revises: the one the model named for its subject (a line
    // in its space's chat, or one an earlier event of the batch makes), else the same condition
    // said the same way. `shown` holds each condition's line as the batch leaves it; `made`, the
    // line each event of the batch made or revised.
    const shownLine = (
      shown: Map<string, OpenLine>,
      made: Map<string, number>,
      t: Tagged,
      at: { readonly id: string; readonly space: SpaceId; readonly lines: ReadonlySet<number> },
      a: ReturnType<typeof answerOf>,
      note: string,
    ) =>
      Effect.gen(function* revise() {
        if (!a.line || a.note === "") {
          return {}
        }
        const { space } = at
        const key = conditionKey(t.event, t.line)
        const where = `${space}\n${key}`
        const open =
          shown.get(where) ?? (yield* brain.read((db) => config.openLine(db, space, key)))
        const said =
          open !== null && t.event.time - open.updated < LINE_FRESH && open.said === t.line.text
            ? open.seq
            : null
        const id = Number(a.same.slice(1))
        const chosen = a.same.startsWith("L") && at.lines.has(id) ? id : made.get(a.same)
        const same = chosen ?? said
        made.set(at.id, same ?? t.event.seq)
        shown.set(where, {
          seq: same ?? t.event.seq,
          note,
          updated: t.event.time,
          said: t.line.text,
        })
        return same === null ? { line: true, key } : { line: true, key, same }
      })

    // What it wakes waits in the record with its `sorted`, in one write. `late`: read long after it
    // came, it wakes only the spaces whose work hasn't had a turn since `through`.
    const sort = (
      batch: readonly Tagged[],
      through: number,
      model?: { readonly provider: "gateway"; readonly id: string },
      late = false,
    ) =>
      Effect.gen(function* sorting() {
        const rules = yield* rulesFor(
          config,
          [...new Set(batch.map((t) => t.home))],
          batch.map((t) => t.line.text).join("\n"),
        )
        const wakeRules = config.wakeRules
          ? yield* config.wakeRules([...new Set(batch.map((t) => t.home))])
          : []
        const read = [
          wakeRules.length === 0
            ? ""
            : `When to wake (the user's wake rules):\n${wakeRules.map((r) => `- ${r.words}`).join("\n")}`,
          rules,
        ]
          .filter((x) => x !== "")
          .join("\n\n")
        const stable = read === "" ? SYSTEM : `${SYSTEM}\n\n${read}`
        const handled = yield* brain.read(
          (db) =>
            new Map(
              batch.flatMap((t) => {
                const last = handledBy(db, t)
                return last === null ? [] : [[t.event.seq, last] as const]
              }),
            ),
        )
        const c = yield* brain.read((db) =>
          context(db, batch, (e) => config.line(e)?.text ?? "", config.openLines, handled),
        )
        const done = yield* model === undefined
          ? models.complete("triage", stable, c.item)
          : models.completeOn(model, stable, c.item)
        const reply = jsonOf(done.text)
        // What the fast path woke already: noted here, not woken twice.
        const woke = yield* brain.read(
          (db) =>
            new Set(
              batch.flatMap((t) =>
                db.query("SELECT 1 FROM triage_woke WHERE seq = ?").get(t.event.seq) === null
                  ? []
                  : [t.event.seq],
              ),
            ),
        )
        // The work that started each job a record reports on: its record wakes that work, never
        // the user's chat, and only when it says something new.
        const owners = yield* brain.read(
          (db) =>
            new Map(
              batch.flatMap((t) => {
                const owner = ownerOf(db, t.event)
                return owner === null ? [] : [[t.event.seq, owner] as const]
              }),
            ),
        )
        const later = yield* brain.read((db) => laterIn(db, batch, owners))
        const items: (typeof TriageSorted.payload.Type)["items"][number][] = []
        const wakes = new Map<ThreadId, string[]>()
        // Work someone's message wakes: a turn since may not have heard it.
        const owed = new Set<ThreadId>()
        const extra: Incoming[] = []
        const conditions = new Map<string, OpenLine>()
        const made = new Map<string, number>()
        for (const [i, t] of batch.entries()) {
          const owner = owners.get(t.event.seq)
          const a = answerOf(field(reply, `e${i}`), t, c.byId, c.meetable, owner !== undefined)
          for (const id of a.meets.filter((m) => c.resolving.has(m))) {
            extra.push({
              id: EventId.make(`resolved:${id}`),
              type: ItemClosed.type,
              source: "triage",
              payload: { id: ItemId.make(id), status: "resolved", why: clip(t.line.text, 200) },
            })
          }
          for (const id of a.meets.filter((m) => !c.resolving.has(m))) {
            extra.push({
              id: EventId.make(`met:${id}:${t.event.id}`),
              type: ExpectationMet.type,
              source: "triage",
              payload: { id, seq: t.event.seq },
            })
          }
          const { home } = t
          const { mentions } = a
          if (mentions.length > 0) {
            // A tag again, with the mentions: membership's projection takes the latest.
            extra.push({
              id: EventId.make(`triage:${t.event.id}`),
              type: SpaceTagged.type,
              source: "triage",
              payload: { ...t.tagged, home, mentions },
            })
          }
          const judged = woke.has(t.event.seq)
            ? "wake"
            : settle(verdictOf(a, t, handled.has(t.event.seq)), t, mentions.length > 0)
          const verdict =
            judged === "wake" &&
            !woke.has(t.event.seq) &&
            held(t, later, wakeRules.length > 0, owners)
              ? "note"
              : judged
          if (verdict !== "ignore") {
            const note = a.note === "" ? clip(t.line.text, 120) : a.note
            const shown = yield* shownLine(
              conditions,
              made,
              t,
              { id: `e${String(i)}`, space: home, lines: c.lines(home) },
              a,
              note,
            )
            items.push({
              seq: t.event.seq,
              time: t.event.time,
              space: home,
              verdict,
              note,
              mentions,
              ...shown,
            })
            if (verdict === "wake" && !woke.has(t.event.seq)) {
              const to = owner ?? config.threadOf(home)
              wakes.set(to, [...(wakes.get(to) ?? []), `- ${note} (seq ${String(t.event.seq)})`])
              if (fromSomeone(t)) {
                owed.add(to)
              }
            }
          }
        }
        const waking = yield* brain.read((db) =>
          [...wakes].filter(
            ([thread]) => !late || owed.has(thread) || !turnSince(db, thread, through),
          ),
        )
        yield* Effect.orDie(
          brain.ingest([
            ...extra,
            sorted(through, items, done.ms, done.cost),
            ...waking.map(([thread, lines]) =>
              waitingEvent(`sorted:${String(through)}:${thread}`, {
                thread,
                text: "",
                note: wokenWith(lines),
                from: "sensed",
              }),
            ),
          ]),
        )
        return waking.map(([thread]): Wake => ({ thread }))
      })

    const wakes = (events: readonly StoredEvent[]) =>
      Effect.gen(function* waking() {
        // Its own tags are its answers, not new events.
        const tags = events.filter(
          (e) => e.type === SpaceTagged.type && e.source !== "triage" && e.source !== "retag",
        )
        const out: Wake[] = []
        for (let i = 0; i < tags.length; i += BATCH) {
          const chunk = tags.slice(i, i + BATCH)
          const through = chunk.at(-1)?.seq ?? 0
          const batch = yield* brain.read((db) => readTags(db, chunk, config.line))
          if (batch.length === 0) {
            yield* Effect.orDie(brain.ingest([sorted(through, [], 0, 0)]))
            continue
          }
          const woke = yield* Effect.result(sort(batch, through))
          if (woke._tag === "Success") {
            out.push(...woke.success)
            continue
          }
          // Read again later (`due`), not dropped.
          yield* Effect.logWarning(`Triage couldn't read a batch: ${String(woke.failure)}`)
          yield* Effect.orDie(
            brain.ingest([
              {
                id: EventId.make(`deferred:${through}`),
                type: TriageDeferred.type,
                source: "triage",
                payload: { through, tags: chunk.map((e) => e.seq) },
              },
            ]),
          )
        }
        return out
      })

    /** The rules whose filters let this record in, as Switchboard gathered records for each kernel. */
    const hitsOf = (db: Database, wakeRules: readonly WakeRule[], t: Tagged) => {
      // Never the work it wakes (ponder.rs:80): its own turns would wake it again.
      const stream = text(field(t.event.payload, "stream"))
      if (stream.startsWith("work/") && stream === `work/${config.threadOf(placed(db, t).home)}`) {
        return []
      }
      // A rule's `first` is by the record's own entity (ponder.rs:252-257), which a message's line
      // (mail marked read, seen again) doesn't carry.
      const entity = text(field(bodyOf(t.event.payload), "entity"))
      return wakeRules.flatMap((rule) =>
        rule.wakes !== null &&
        lets(rule.wakes, t.event) &&
        (!rule.wakes.first || firstAbout(db, t, entity))
          ? [rule]
          : [],
      )
    }

    /** Whether the bearing kernel reads this record (bearing.ts), first by its own entity too. */
    const bears = (db: Database, t: Tagged) =>
      BEARING.wakes !== null &&
      lets(BEARING.wakes, t.event) &&
      firstAbout(db, t, text(field(bodyOf(t.event.payload), "entity")))

    // Each rule's burst, gathering (ponder.rs:180-196): due its `batch_s` after the first record.
    interface Burst {
      readonly rule: WakeRule
      readonly records: Tagged[]
      due: number
    }
    const bursts = new Map<string, Burst>()
    // What it reads again after a restart (from where it left off) that a rule decided already.
    const startedAt = yield* brain.read(
      (db) =>
        db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
    )
    const gather = (rule: WakeRule, t: Tagged, due: number) =>
      Effect.gen(function* gathering() {
        if (
          t.event.seq <= startedAt &&
          (yield* brain.read((db) => decidedFor(db, rule.name, t.event.seq)))
        ) {
          return
        }
        const was = bursts.get(rule.name)
        if (was !== undefined) {
          if (!was.records.some((r) => r.event.seq === t.event.seq)) {
            was.records.push(t)
          }
          return
        }
        bursts.set(rule.name, { rule, records: [t], due })
        yield* Effect.orDie(
          brain.ingest([
            {
              id: EventId.make(`gathering:${rule.name}:${String(t.event.seq)}`),
              type: TriageGathering.type,
              source: "triage",
              payload: { rule: rule.name, seq: t.event.seq, tag: t.tag.seq },
            },
          ]),
        )
      })

    /**
     * Reads a due burst against its rule's question, a probability each, keeping the decision; what's
     * at its threshold wakes its space (ponder.rs:279-341 `flush`). A rule at 0, or a trigger, wakes
     * for all of it without a decision. Fails when a decision can't be had: the burst is tried again.
     */
    const flush = (burst: Burst) =>
      Effect.gen(function* flushing() {
        const { rule } = burst
        // The bearing kernel's body reads it against the work running now, whatever woke a turn.
        if (rule.name === BEARING.name) {
          return yield* bore(
            burst.records
              .filter((t, i) => burst.records.findIndex((r) => r.event.seq === t.event.seq) === i)
              .map((t) => t.event),
          ).pipe(Effect.provideService(Brain, brain), Effect.provideService(Models, models))
        }
        const fresh = yield* brain.read((db) =>
          burst.records
            .filter(
              (t, i) =>
                burst.records.findIndex((r) => r.event.seq === t.event.seq) === i &&
                !batchWoke(db, t.event.seq),
            )
            .map((t) => placed(db, t)),
        )
        if (fresh.length === 0) {
          return []
        }
        const at = rule.wakes?.at ?? 0
        let through: { readonly t: Tagged; readonly p: number }[] = []
        // Its decisions, what they woke and the wakes are one write: a restart before it gathers the
        // burst again whole.
        const decisions: Incoming[] = []
        if (at <= 0) {
          through = fresh.map((t) => ({ t, p: 1 }))
          decisions.push(decided(rule, 0, through, "wake", 0, 0))
        } else {
          // One decision per 40, as Switchboard asked it (ponder.rs:292-366): its guide, the kernel's
          // name and question, each record's line; a predicate each, at the rule's threshold.
          const stable = `${GUIDE}\n\nThe kernel: ${rule.title}. Its question: ${rule.question}`
          const machines = yield* brain.read((db) => {
            const get = db.query<{ machine: string }, [string]>(
              "SELECT machine FROM extension_placements WHERE extension = ?",
            )
            return new Map(
              fresh.map((t) => [t.event.source, get.get(t.event.source)?.machine ?? null]),
            )
          })
          for (let i = 0; i < fresh.length; i += AT_ONCE) {
            const chunk = fresh.slice(i, i + AT_ONCE)
            const now = Date.now()
            const listed = chunk.map(
              (t, j) =>
                `Record ${String(j + 1)}:\n${recordLine(t.event, machines.get(t.event.source) ?? null, now)}`,
            )
            const d = yield* models.decide(
              { stable, item: listed.join("\n\n") },
              Object.fromEntries(
                chunk.map((_, j) => [`r${String(j)}`, recordQuestion(j)] as const),
              ),
            )
            const read = chunk.map((t, j) => ({
              t,
              p: d.answers[`r${String(j)}`]?.probabilities.yes ?? 0,
            }))
            const passed = read.filter((r) => r.p >= at)
            through = [...through, ...passed]
            decisions.push(
              decided(rule, at, read, passed.length > 0 ? "wake" : "rest", d.ms, d.cost),
            )
          }
        }
        if (through.length === 0) {
          yield* Effect.orDie(brain.ingest(decisions))
          return []
        }
        // A woken record per space, as Switchboard's `woken` listed what came in (ponder.rs:347-374;
        // its words as core/context.rs:1926-1950 gave them to the turn).
        const { title } = rule
        const goal = rule.goal === "" ? rule.question : rule.goal
        const head =
          rule.wakes?.at === null
            ? `# Woken: ${title}\nA trigger (${rule.name}) started this turn: it matches what your senses record by its rules alone, and no model chose what it let through. What it's for: ${goal}\n\n${String(fresh.length)} came in:`
            : `# Woken: ${title}\nYou set a wake rule (${rule.name}) to be woken by what your senses record. What it's for: ${goal}\n\nIts decision let ${String(through.length)} of the ${String(fresh.length)} that came in through:`
        const bySpace = new Map<SpaceId, string[]>()
        for (const { t, p } of through) {
          const why = at <= 0 ? "" : `: ${String(Math.round(p * 100))}% likely worth it`
          const said = `- ${oneLine(t.line.text, 300)} (${text(field(t.event.payload, "stream"))}, seq ${String(t.event.seq)})${why}`
          bySpace.set(t.home, [...(bySpace.get(t.home) ?? []), said])
        }
        yield* Effect.orDie(
          brain.ingest([
            ...decisions,
            ...through.map(({ t, p }) => ({
              id: EventId.make(`woke:${String(t.event.seq)}`),
              type: TriageWoke.type,
              source: "triage",
              payload: {
                seq: t.event.seq,
                time: t.event.time,
                space: t.home,
                note: clip(t.line.text, 120),
                probability: p,
                ms: 0,
                cost: 0,
              },
            })),
            ...[...bySpace].map(([space, lines]) =>
              waitingEvent(`woke:${rule.name}:${String(through[0]?.t.event.seq ?? 0)}:${space}`, {
                thread: config.threadOf(space),
                text: "",
                note: wokenWith([head, ...lines]),
                from: "sensed",
              }),
            ),
          ]),
        )
        return [...bySpace.keys()].map((space): Wake => ({ thread: config.threadOf(space) }))
      })

    /**
     * After a restart, each rule gathers again what it was gathering (ponder.rs:205-207, the cursor at
     * the earliest record still gathering): within six hours, every record past its last decision
     * from its first `gathering` on. A burst cut off partway through its decisions picks up after the
     * last one it kept; one fully decided has nothing past it but a burst gathering since.
     */
    const refill = Effect.gen(function* refilling() {
      const pending = yield* brain.read((db) =>
        db
          .query<{ rule: string; seq: number }, [number]>(
            `SELECT rule, max(first, decided + 1) AS seq FROM (
               SELECT json_extract(g.payload, '$.rule') AS rule, min(json_extract(g.payload, '$.seq')) AS first,
                 coalesce((
                   SELECT max(json_extract(r.value, '$.seq')) FROM events d, json_each(json_extract(d.payload, '$.records')) r
                   WHERE d.type = 'triage.decided' AND json_extract(d.payload, '$.rule') = json_extract(g.payload, '$.rule')), 0) AS decided
               FROM events g WHERE g.type = 'triage.gathering' AND g.time > ?
               GROUP BY rule)`,
          )
          .all(Date.now() - GIVE_UP_MS),
      )
      if (pending.length === 0) {
        return
      }
      const from = Math.min(...pending.map((p) => p.seq))
      const now = Date.now()
      const records = yield* brain.read((db) =>
        db
          .query<EventRow, [number, number]>(
            "SELECT * FROM events WHERE seq >= ? AND time > ? AND (json_extract(payload, '$.stream') IS NOT NULL OR type IN ('item.opened', 'turn.started', 'item.answered')) ORDER BY seq",
          )
          .all(from, now - GIVE_UP_MS)
          .map(stored)
          .flatMap((e) => recordOf(db, asRecord(db, e), config.line) ?? []),
      )
      const wakeRules = config.wakeRules ? yield* config.wakeRules([HOME]) : []
      for (const t of records) {
        // The user's answers to asks are bearing's, as they come (`urgent`), not the rules'.
        const hits = yield* brain.read((db) => [
          ...(t.event.type === ANSWER ? [] : hitsOf(db, wakeRules, t)),
          ...(bears(db, t) ? [BEARING] : []),
        ])
        for (const rule of hits) {
          const p = pending.find((x) => x.rule === rule.name)
          if (p !== undefined && t.event.seq >= p.seq) {
            yield* gather(rule, t, now + batchMs(rule))
          }
        }
      }
    }).pipe(Effect.ignore({ log: "Warn", message: "Wake rules couldn't gather again" }))
    let refilled = false

    // Batches deferred and not read since, read again in order, a few at a time so the wake rules'
    // bursts aren't held up behind them; the first that still can't be read leaves the rest for the
    // next try, a minute on.
    let deferredDue = 0
    const again = Effect.gen(function* readingAgain() {
      const left = yield* brain.read((db) =>
        db
          .query<
            { through: number; tags: string; late: number | null; model: string | null },
            [number]
          >(
            // The latest deferral of a batch says how it's read.
            `SELECT json_extract(d.payload, '$.through') AS through, json_extract(d.payload, '$.tags') AS tags,
               json_extract(d.payload, '$.late') AS late, json_extract(d.payload, '$.model') AS model
             FROM events d WHERE d.type = 'triage.deferred' AND NOT EXISTS (
               SELECT 1 FROM events s WHERE s.id = 'sorted:' || json_extract(d.payload, '$.through'))
               AND d.seq = (SELECT max(o.seq) FROM events o WHERE o.type = 'triage.deferred'
                 AND json_extract(o.payload, '$.through') = json_extract(d.payload, '$.through'))
             ORDER BY d.seq LIMIT ?`,
          )
          .all(AGAIN_AT_ONCE),
      )
      const out: Wake[] = []
      for (const d of left) {
        const seqs = parseSeqs(d.tags)
        const batch = yield* brain.read((db) => {
          const get = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq = ?")
          const tags = seqs.flatMap((seq) => {
            const row = get.get(seq)
            return row ? [stored(row)] : []
          })
          return readTags(db, tags, config.line)
        })
        const woke = yield* Effect.result(
          batch.length === 0
            ? Effect.as(Effect.orDie(brain.ingest([sorted(d.through, [], 0, 0)])), [])
            : sort(
                batch,
                d.through,
                d.model === null ? undefined : parseModel(d.model),
                d.late === 1,
              ),
        )
        if (woke._tag === "Failure") {
          deferredDue = Date.now() + MINUTE_MS
          break
        }
        out.push(...woke.success)
      }
      // A full handful: more wait, read on the next tick.
      deferredDue = Math.max(deferredDue, left.length < AGAIN_AT_ONCE ? Date.now() + MINUTE_MS : 0)
      return out
    })

    /**
     * The bursts whose time has come, read and woken: one turn per space. One that couldn't be read
     * waits five minutes and is tried again, and is let go once it's six hours old (ponder.rs:164-180).
     */
    const due = Effect.gen(function* dueing() {
      if (!refilled) {
        refilled = true
        yield* refill
      }
      const now = Date.now()
      const ready = [...bursts.values()].filter((b) => b.due <= now)
      const out: Wake[] = now >= deferredDue ? yield* again : []
      for (const burst of ready) {
        bursts.delete(burst.rule.name)
        const woke = yield* Effect.result(flush(burst))
        if (woke._tag === "Success") {
          out.push(...woke.success)
          continue
        }
        const kept = burst.records.filter((t) => t.event.time > now - GIVE_UP_MS)
        const lost = burst.records.filter((t) => t.event.time <= now - GIVE_UP_MS)
        if (lost.length > 0) {
          const at = burst.rule.wakes?.at ?? 0
          yield* Effect.orDie(
            brain.ingest([
              decided(
                burst.rule,
                at,
                lost.map((t) => ({ t, p: 0 })),
                "lost",
                0,
                0,
              ),
            ]),
          )
        }
        if (kept.length > 0) {
          // What came in while it was read joins it.
          const later = bursts.get(burst.rule.name)?.records ?? []
          bursts.set(burst.rule.name, {
            rule: burst.rule,
            records: [...kept, ...later],
            due: now + RETRY_MS,
          })
        }
      }
      return out
    }).pipe(Effect.orElseSucceed((): Wake[] => []))

    // The general question, on the first record about a thing or on someone's message.
    const byGeneral = (t: Tagged, item: string) =>
      Effect.gen(function* generally() {
        if (!fromSomeone(t) && !(yield* brain.read((db) => firstAbout(db, t, t.line.entity)))) {
          return null
        }
        const d = yield* models.decide({ stable: FAST, item }, { wake: WAKE })
        return { probability: d.answers.wake?.probabilities.wake ?? 0, ms: d.ms, cost: d.cost }
      })

    // The fast path: with wake rules, each record a rule lets in joins that rule's burst (Switchboard's
    // kernels, docs.md "Being woken"), and someone's message no rule reads gets the general question;
    // without, one decision per event, so an urgent one wakes its space in under a second. The
    // user's own messages are turns already, and fast streams (UI analytics) never wake.
    const quickly = (t: Tagged, wakeAt: number) =>
      Effect.gen(function* deciding() {
        const wakeRules = config.wakeRules ? yield* config.wakeRules([t.home]) : []
        const ruled =
          wakeRules.length > 0 &&
          (!fromSomeone(t) ||
            // A rule reads its kind: one it lets go as not the first about its thing (a mail seen
            // again) is no news (ponder.rs:252-257).
            wakeRules.some((rule) => rule.wakes !== null && lets(rule.wakes, t.event)))
        if (ruled) {
          return null
        }
        const read = yield* brain.read((db) => quick(db, t, (e) => config.line(e)?.text ?? ""))
        const rules = yield* rulesFor(config, [t.home], t.line.text)
        const item = rules === "" ? read : `${rules}\n\n${read}`
        const general = yield* byGeneral(t, item)
        if (general === null || general.probability < wakeAt) {
          return null
        }
        const { probability, ms, cost } = general
        const note = clip(t.line.text, 120)
        const thread = config.threadOf(t.home)
        // What it woke and the wake, in one write.
        yield* Effect.orDie(
          brain.ingest([
            {
              id: EventId.make(`woke:${t.event.seq}`),
              type: TriageWoke.type,
              source: "triage",
              payload: {
                seq: t.event.seq,
                time: t.event.time,
                space: t.home,
                note,
                probability,
                ms,
                cost,
              },
            },
            waitingEvent(`woke:${String(t.event.seq)}:wake`, {
              thread,
              text: "",
              note: wokenWith([`- ${note} (seq ${String(t.event.seq)})`]),
              from: "sensed",
            }),
          ]),
        )
        const woke: Wake = { thread }
        return woke
      }).pipe(Effect.orElseSucceed(() => null))

    const urgent = (events: readonly StoredEvent[]) =>
      Effect.gen(function* hurrying() {
        const wakeRules = config.wakeRules ? yield* config.wakeRules([HOME]) : []
        if (wakeRules.length > 0) {
          const now = Date.now()
          const records = yield* brain.read((db) =>
            events.flatMap((e) => recordOf(db, e, config.line) ?? []),
          )
          for (const t of records) {
            const hits = yield* brain.read((db) => hitsOf(db, wakeRules, t))
            for (const rule of hits) {
              yield* gather(rule, t, now + batchMs(rule))
            }
          }
        }
        // The bearing kernel reads what comes in whatever the rules (builtin.rs:305-329).
        const at = Date.now() + batchMs(BEARING)
        const bearing = yield* brain.read((db) =>
          events.flatMap((e) => {
            const t = recordOf(db, asRecord(db, e), config.line)
            return t !== null && bears(db, t) ? [t] : []
          }),
        )
        for (const t of bearing) {
          yield* gather(BEARING, t, at)
        }
        const tags = events.filter(
          (e) => e.type === SpaceTagged.type && e.source !== "triage" && e.source !== "retag",
        )
        if (tags.length === 0) {
          return []
        }
        // One that came late (a source catching up) waits for its batch, which reads it with the
        // time now: a backlog arriving at once wakes no space per event.
        const now = Date.now()
        const fresh = yield* brain.read((db) =>
          readTags(db, tags, config.line).filter(
            (t) =>
              t.line.home === undefined &&
              t.line.fast !== true &&
              !ownWords(t) &&
              !cameLate(t, now) &&
              // A message said again is no news; one in a conversation the user handles
              // themselves waits for its batch, which weighs what it asks.
              !recordedBefore(db, t) &&
              handledBy(db, t) === null &&
              // Read again after a restart, one it woke already isn't decided twice.
              db.query("SELECT 1 FROM triage_woke WHERE seq = ?").get(t.event.seq) === null,
          ),
        )
        const wakeAt = config.wakeAt ? yield* config.wakeAt : 0.5
        const out = yield* Effect.forEach(fresh, (t) => quickly(t, wakeAt), {
          concurrency: "unbounded",
        })
        return out.filter((w) => w !== null)
      })

    const note = (space: SpaceId, seq: number) =>
      delta(space, seq).pipe(
        Effect.provideService(Brain, brain),
        Effect.provideService(Models, models),
        Effect.orElseSucceed(() => ""),
      )

    return { wakes, urgent, due, delta: note, from: brain.read(readThrough) }
  })

/** The Triage slot the core leaves open. */
export const triageLayer = (config: TriageConfig) => Layer.effect(TriageSlot, makeTriage(config))

const DELTA_CHARS = 500

/**
 * What changed in a space since `since` (a seq), about 500 characters: its notes, newest kept
 * when they're too many, compressed by the triage model when they run long.
 */
export const delta = (space: SpaceId, since: number) =>
  Effect.gen(function* delting() {
    const brain = yield* Brain
    const models = yield* Models
    const notes = yield* brain.read((db) => notesSince(db, space, since))
    if (notes.length === 0) {
      return ""
    }
    const lines = notes.map(
      (n) =>
        `- ${new Date(n.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} ${n.note}${n.home === 1 ? "" : " (mentioned)"}`,
    )
    const all = lines.join("\n")
    if (all.length <= DELTA_CHARS * 1.2) {
      return all
    }
    const done = yield* Effect.option(
      models.complete(
        "triage",
        `Compress these notes on what changed in one space into at most ${DELTA_CHARS} characters, newest and most consequential first. Keep names, numbers and times. Plain lines starting with "- ", nothing else.`,
        lines.slice(-60).join("\n"),
      ),
    )
    const short = done._tag === "Some" ? done.value.text.trim() : ""
    return short === ""
      ? lines.slice(-6).join("\n").slice(-DELTA_CHARS)
      : short.slice(0, DELTA_CHARS * 1.2)
  })
