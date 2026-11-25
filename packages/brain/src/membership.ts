import type { Database } from "bun:sqlite"
import { Models } from "@switch/models"
import type { Choice, Question } from "@switch/models"
import { Effect, Schema, Stream } from "effect"

import { Brain } from "./brain.ts"
import { EventId, SpaceId } from "./ids.ts"
import { defineEvent, on } from "./defs.ts"
import type { Projection, StoredEvent } from "./defs.ts"
import { MessageMoved } from "./messages.ts"
import { allSpaces, HOME, spaceAliases } from "./spaces.ts"
import type { Space } from "./spaces.ts"

// Membership: a decision model gives every event a home space (Home when it fits no other). Links
// (an email thread, an order code, a work id) are hints to it, never answers. Mentions, the other
// spaces an event bears on, are triage's: it re-tags the event with them.

/** What the tagger reads from an event. Events with no line aren't tagged. */
export interface Line {
  readonly text: string
  /** Same chat, email thread or typed place; the agent's replies carry it too. */
  readonly conversation?: string
  /** Identifiers that reliably tie events together: email thread, order code, work id. */
  readonly links?: readonly string[]
  /** What it reports on, when its writer names it (a printer, a module): its lines are one per condition. */
  readonly entity?: string
  /** A fast stream, such as UI analytics: tagged in batches, without conversation. */
  readonly fast?: boolean
  /** Where it belongs, when its writer knows (a message posted in a space): no model call. */
  readonly home?: SpaceId
}

export const SpaceTagged = defineEvent(
  "space.tagged",
  1,
  Schema.Struct({
    seq: Schema.Number,
    home: SpaceId,
    mentions: Schema.Array(SpaceId),
    conversation: Schema.NullOr(Schema.String),
    links: Schema.Array(Schema.String),
  }),
)

/** An event that's no space's after all, such as bookkeeping once filed: it leaves every thread. */
export const SpaceUntagged = defineEvent("space.untagged", 1, Schema.Struct({ seq: Schema.Number }))

export const membership: Projection = {
  name: "membership",
  version: 1,
  tables: ["tags", "mentions", "links"],
  create: `
    CREATE TABLE tags (seq INTEGER PRIMARY KEY, home TEXT NOT NULL, conversation TEXT);
    CREATE INDEX tags_home ON tags (home, seq);
    CREATE INDEX tags_conversation ON tags (conversation, seq);
    CREATE TABLE mentions (seq INTEGER NOT NULL, space TEXT NOT NULL, PRIMARY KEY (space, seq));
    CREATE TABLE links (link TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (link, seq));`,
  on: [
    on(SpaceTagged, (db, p) => {
      db.query("INSERT OR REPLACE INTO tags (seq, home, conversation) VALUES (?, ?, ?)").run(
        p.seq,
        p.home,
        p.conversation,
      )
      // A retag replaces the decision, including removal of a mistaken association.
      db.query("DELETE FROM mentions WHERE seq = ?").run(p.seq)
      db.query("DELETE FROM links WHERE seq = ?").run(p.seq)
      for (const space of p.mentions) {
        db.query("INSERT OR IGNORE INTO mentions (seq, space) VALUES (?, ?)").run(p.seq, space)
      }
      for (const link of p.links) {
        db.query("INSERT OR IGNORE INTO links (link, seq) VALUES (?, ?)").run(link, p.seq)
      }
    }),
    on(SpaceUntagged, (db, p) => {
      for (const table of ["tags", "mentions", "links"]) {
        db.query(`DELETE FROM ${table} WHERE seq = ?`).run(p.seq)
      }
    }),
    on(MessageMoved, (db, p) => {
      for (const seq of p.seqs) {
        db.query("UPDATE tags SET home = ? WHERE seq = ?").run(p.to, seq)
      }
    }),
  ],
  snapshot: (db) =>
    db
      .query<{ home: SpaceId; events: number }, []>(
        "SELECT home, count(*) AS events FROM tags GROUP BY home",
      )
      .all(),
}

export const membershipConfig = {
  events: [SpaceTagged, SpaceUntagged],
  projections: [membership],
  commands: [],
}

interface EventRow {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

const parseJson: (json: string) => unknown = JSON.parse

const stored = (row: EventRow): StoredEvent => ({
  seq: row.seq,
  id: row.id,
  time: row.time,
  type: row.type,
  v: row.v,
  source: row.source,
  payload: parseJson(row.payload),
})

const decodeMentions = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SpaceId)))

export interface ThreadRow {
  readonly event: StoredEvent
  /** Where it lives; another space when it's shown here as a mention. */
  readonly home: SpaceId
  readonly mentions: readonly SpaceId[]
}

/** A space's master thread: its events and the events that mention it, in order. */
export const thread = (db: Database, space: SpaceId): ThreadRow[] =>
  db
    .query<EventRow & { home: SpaceId; mentions: string }, [SpaceId]>(
      `SELECT e.*, t.home,
         (SELECT json_group_array(m.space) FROM mentions m WHERE m.seq = t.seq) AS mentions
       FROM tags t JOIN events e ON e.seq = t.seq
       WHERE t.seq IN (SELECT seq FROM tags WHERE home = ?1 UNION SELECT seq FROM mentions WHERE space = ?1)
       ORDER BY t.seq`,
    )
    .all(space)
    .map((r) => ({ event: stored(r), home: r.home, mentions: decodeMentions(r.mentions) }))

const LATEST = 2
const EARLIER = 4
const EARLIER_WITHIN = 2 * 3600 * 1000
// Measured on the corpus's UI events: 10 per call kept most recall (.68 vs .76 one by one); 54 lost it.
const BATCH = 10

const STABLE =
  "You route events for Switch, the user's personal agent. Switch keeps a tree of spaces (projects, sub-projects, items), " +
  "each with one master thread. Home is the root; it holds whatever fits no other space (social chatter, " +
  "personal life with no space, codes, noise). Put the event in the single most specific space it belongs to."
const HOME_QUESTION =
  "Which space's master thread does this event belong in? Pick the single most specific space, or home."

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)

const when = (time: number) =>
  new Date(time).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

/** Spaces a tag can name: not archived, and not under an archived space. */
const open = (all: readonly Space[]) => {
  const byId = new Map(all.map((s) => [s.id, s]))
  const closed = (s: Space | undefined, depth: number): boolean =>
    s !== undefined &&
    (s.archived ||
      (depth < 64 && closed(s.parent === null ? undefined : byId.get(s.parent), depth + 1)))
  return all
    .filter((s) => !closed(s, 0))
    .map((s) => ({ ...s, parentName: s.parent === null ? undefined : byId.get(s.parent)?.name }))
}

interface Pending {
  readonly event: StoredEvent
  readonly line: Line
}

const record = (e: Pending, home: SpaceId) => ({
  id: EventId.make(`tag:${e.event.id}`),
  type: SpaceTagged.type,
  source: "membership",
  payload: {
    seq: e.event.seq,
    home,
    mentions: [],
    conversation: e.line.conversation ?? null,
    links: [...(e.line.links ?? [])],
  },
})

const textOf = (line: (event: StoredEvent) => Line | null, row: EventRow) =>
  line(stored(row))?.text ?? ""

// Everything the model sees besides the events being tagged, read when they're tagged.
const context = (line: (event: StoredEvent) => Line | null, db: Database) => {
  const spaces = open(allSpaces(db))
  const aliases = spaceAliases(db)
  const also = (s: (typeof spaces)[number]) => {
    const was = aliases.get(s.id)
    return was ? `, once called ${was.join(", ")}` : ""
  }
  const describe = (s: (typeof spaces)[number]) =>
    s.id === HOME
      ? "Home: the root. Bears on no other space: social chatter, personal life with no space, codes, spam, noise, idle browsing."
      : `${s.name} (${s.parentName === undefined || s.parent === HOME ? "top level" : `inside ${s.parentName}`}${also(s)}). ${s.about}`.trim()
  // Home goes last, where the experiment's "none" was.
  const choices: Choice[] = [
    ...spaces.filter((s) => s.id !== HOME).map((s) => ({ value: s.id, description: describe(s) })),
    ...spaces.filter((s) => s.id === HOME).map((s) => ({ value: s.id, description: describe(s) })),
  ]
  const latest = db.query<EventRow, [string, number]>(
    "SELECT e.* FROM tags t JOIN events e ON e.seq = t.seq WHERE t.home = ? ORDER BY t.seq DESC LIMIT ?",
  )
  const recent = spaces.flatMap((s) => {
    const rows = latest.all(s.id, LATEST).toReversed()
    return rows.length > 0
      ? [`- ${s.id}: ${rows.map((r) => clip(textOf(line, r), 140)).join(" | ")}`]
      : []
  })
  const earlier = db.query<EventRow & { home: SpaceId }, [string, number, number, number]>(
    "SELECT e.*, t.home FROM tags t JOIN events e ON e.seq = t.seq WHERE t.conversation = ? AND e.time > ? AND t.seq < ? ORDER BY t.seq DESC LIMIT ?",
  )
  const linked = db.query<{ home: SpaceId }, [string]>(
    "SELECT t.home FROM links l JOIN tags t ON t.seq = l.seq WHERE l.link = ? AND t.home != 'home' ORDER BY l.seq DESC LIMIT 1",
  )
  const about = (e: Pending) => {
    const parts: string[] = []
    const c = e.line.conversation
    if (c !== undefined && e.line.fast !== true) {
      const rows = earlier.all(c, e.event.time - EARLIER_WITHIN, e.event.seq, EARLIER).toReversed()
      // Where each went: a follow-up mostly goes where its conversation did.
      if (rows.length > 0) {
        parts.push(
          `Earlier in the same conversation:\n${rows.map((r) => `- (in ${r.home}) ${clip(textOf(line, r), 240)}`).join("\n")}`,
        )
      }
    }
    const hints = (e.line.links ?? []).flatMap((l) => {
      const hit = linked.get(l)
      return hit ? [`${l} is also on events in ${hit.home}`] : []
    })
    if (hints.length > 0) {
      parts.push(`Links (hints, not answers): ${hints.join("; ")}`)
    }
    return parts
  }
  const head =
    recent.length > 0 ? [`Latest lines in each space's thread:\n${recent.join("\n")}`] : []
  const ids = new Map<string, SpaceId>(spaces.map((s) => [s.id, s.id]))
  /** The space a model's choice names, or Home when it names none. */
  const pick = (choice: string | undefined) =>
    (choice === undefined ? undefined : ids.get(choice)) ?? HOME
  return { choices, head, about, pick }
}

/** One event's home, as the model picks it from the spaces there are now. */
const homeOf = (
  line: (event: StoredEvent) => Line | null,
  e: Pending,
  given?: ReturnType<typeof context>,
) =>
  Effect.gen(function* single() {
    const brain = yield* Brain
    const models = yield* Models
    const c = given ?? (yield* brain.read((db) => context(line, db)))
    const item = [...c.head, ...c.about(e), `Event (${when(e.event.time)}): ${e.line.text}`].join(
      "\n\n",
    )
    const questions: Record<string, Question> = {
      home: { instructions: HOME_QUESTION, choices: c.choices },
    }
    const d = yield* models.decide({ stable: STABLE, item }, questions)
    return c.pick(d.answers.home?.choice)
  })

// A message the user sends with no space: the space it's plainly for, else Home. A wrong space costs
// more than Home, so it takes both a sure pick and words that point at that space alone. Measured on
// a week of the user's own messages (Nov 18 to 24), each routed as if sent with no space from the
// brain as it was before it: of 525 typed in a space, 26% went there, 74% to Home and 1 elsewhere;
// of 91 typed in Home, 90 stayed. Each space's latest chat lines told it more than its latest events.
const ROUTE_QUESTION =
  "Which space is the user's message for? Pick the single most specific space it is plainly about. " +
  "Pick home when it is general, could be for more than one space, or its words alone don't say which."
const NAMED_QUESTION =
  "Do the message's own words name or plainly point to something only one of the spaces has " +
  "(a person, company, product, order, part, place or file), rather than fitting several?"
const SURE = 0.8
const NAMED = 0.7
const CHAT = 8

/** What routing a message reads: the spaces, their latest lines, and the message. */
export const routing = (
  line: (event: StoredEvent) => Line | null,
  db: Database,
  text: string,
  time: number,
) => {
  const c = context(line, db)
  const latest = db.query<{ source: string; text: string }, [string, number]>(
    "SELECT source, text FROM messages WHERE space = ? AND widget IS NULL ORDER BY seq DESC LIMIT ?",
  )
  const chats = c.choices.flatMap((s) => {
    const rows = latest.all(s.value, CHAT).toReversed()
    const said = rows.map(
      (r) =>
        `${r.source === "agent" ? "Switch" : "User"}: ${clip(r.text.replaceAll(/\s+/gu, " "), 160)}`,
    )
    return rows.length > 0 ? [`- ${s.value}: ${said.join(" | ")}`] : []
  })
  const head = chats.length > 0 ? [`Latest in each space's chat:\n${chats.join("\n")}`] : []
  return {
    input: {
      stable: STABLE,
      item: [...head, `Message from the user (${when(time)}): ${text}`].join("\n\n"),
    },
    questions: {
      space: { instructions: ROUTE_QUESTION, choices: c.choices },
      named: { instructions: NAMED_QUESTION, choices: [], predicate: true },
    } satisfies Record<string, Question>,
    pick: c.pick,
  }
}

/** The space a message the user sent with no space goes to: the model's pick when it's sure, else Home. */
export const route = (line: (event: StoredEvent) => Line | null, text: string) =>
  Effect.gen(function* routingIt() {
    const brain = yield* Brain
    const models = yield* Models
    const r = yield* brain.read((db) => routing(line, db, text, Date.now()))
    const d = yield* models.decide(r.input, r.questions)
    const space = r.pick(d.answers.space?.choice)
    const sure = (d.answers.space?.probabilities[space] ?? 0) >= SURE
    return sure && (d.answers.named?.probabilities.yes ?? 0) >= NAMED ? space : HOME
  })

/**
 * The tag that puts an event in `home`, shown also in `mentions`: a chat line, a triage note and a
 * task it opens go along. `key` makes its id.
 */
export const retagged = (
  event: StoredEvent,
  l: Line,
  home: SpaceId,
  mentions: readonly SpaceId[],
  key: string,
) => ({
  id: EventId.make(`${key}:${event.id}`),
  type: SpaceTagged.type,
  // A retag moves an event triage has read already: it isn't news again.
  source: "retag",
  payload: {
    seq: event.seq,
    home,
    mentions: [...mentions],
    conversation: l.conversation ?? null,
    links: [...(l.links ?? [])],
  },
})

/**
 * `owned`: the space of the work an event belongs to, when some work owns it (a job it started):
 * the event goes there without a model.
 */
export const tagger = (
  line: (event: StoredEvent) => Line | null,
  owned: (db: Database, event: StoredEvent) => SpaceId | null = () => null,
) =>
  Effect.gen(function* tagging() {
    const brain = yield* Brain
    const models = yield* Models

    // A conversation's message the model couldn't place goes to Home, so triage still reads it.
    const one = (e: Pending) =>
      Effect.gen(function* single() {
        const owner = yield* brain.read((db) => owned(db, e.event))
        if (owner !== null) {
          yield* brain.ingest([record(e, owner)])
          return
        }
        const placed = homeOf(line, e)
        const home = yield* e.line.conversation === undefined
          ? placed
          : Effect.orElseSucceed(placed, () => HOME)
        yield* brain.ingest([record(e, home)])
      }).pipe(Effect.provideService(Brain, brain), Effect.provideService(Models, models))

    const batch = (es: readonly Pending[]) =>
      Effect.gen(function* batched() {
        const c = yield* brain.read((db) => context(line, db))
        const listed = es.map((e, i) =>
          [`e${i} (${when(e.event.time)}): ${e.line.text}`, ...c.about(e)].join("\n"),
        )
        const item = [...c.head, `Events:\n${listed.join("\n")}`].join("\n\n")
        const questions = Object.fromEntries(
          es.map((_, i) => [
            `e${i}`,
            {
              instructions: `For event e${i}: ${HOME_QUESTION}`,
              choices: c.choices,
            } satisfies Question,
          ]),
        )
        const d = yield* models.decide({ stable: STABLE, item }, questions)
        yield* brain.ingest(es.map((e, i) => record(e, c.pick(d.answers[`e${i}`]?.choice))))
      })

    // In order: a run of fast events goes in one call, every other event in its own.
    const tagChunk = (events: readonly StoredEvent[]) =>
      Effect.gen(function* chunk() {
        const run: Pending[] = []
        const flush = Effect.suspend(() => (run.length === 0 ? Effect.void : batch(run.splice(0))))
        for (const event of events) {
          const l = event.type.startsWith("space.") ? null : line(event)
          if (l?.home !== undefined) {
            yield* flush
            yield* brain.ingest([record({ event, line: l }, l.home)])
          } else if (l !== null && l.fast === true) {
            run.push({ event, line: l })
            if (run.length === BATCH) {
              yield* flush
            }
          } else if (l !== null) {
            yield* flush
            yield* one({ event, line: l })
          }
        }
        yield* flush
      }).pipe(
        // A failed call leaves its events untagged rather than stopping the tagger.
        Effect.ignore({ log: "Warn", message: "Tagging failed" }),
      )

    const after = yield* brain.read(
      (db) =>
        db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM tags").get()?.seq ?? 0,
    )
    return yield* brain
      .changes(after)
      .pipe(Stream.groupedWithin(64, "50 millis"), Stream.runForEach(tagChunk))
  })
