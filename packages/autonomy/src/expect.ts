// Expectation: "X by T, else wake." One primitive for promises ("I'll check back at 5"), watches
// ("when the print finishes, put up the card") and confirmations ("make sure the deploy landed").
// Each belongs to the work that made it (its thread) and is judged against the brain, not guessed:
// - `when`, a query that finds nothing until it happens: the moment it finds something, its work
//   wakes to do what it said; once that turn is over its `check` (or `when`) runs again, and
//   finding nothing then is a surprise. If T comes first, that's a miss its work hears.
// - `check`, a query that shows it held: run at T; holding, it's met with no turn; not, its work
//   wakes with `otherwise`, and the check runs again after: still nothing is a surprise.
// - `promise`, something the agent will do itself (without a `when`): judged at T, once no turn is
//   running in its work (six hours at most), by Switchboard's promise judge (crates/monologue/src/
//   watch.rs): what its work did since it was said, its check's rows when it has one, and what its
//   work still waits on. Kept, it's met. Made for once something else happens that hasn't yet, while
//   its work still waits on it (an ask still open in the user's queue), it's neither: it rests 10
//   minutes, each rest twice the last up to 3 hours, and is judged again. Not kept yet, its work
//   wakes to keep it, and ten minutes on it's judged again: broken, it's a surprise and its work is
//   steered. promises.ts writes them from what the agent says, too.
// - none of these: triage marks it met when an event shows it; at T it lapses and wakes its work.
// T is only ever a real time, cited by its source (a date someone gave, an ETA, a schedule, a
// print's end). A wait with a `when`, or one hanging on an ask in the user's queue (a `when` on that
// item closing), has none: it waits until it fires, they answer, or its work is dropped. The user,
// Nov 22: "Why would it just silently wait till Tuesday to check? … completely arbitrary, made-up,
// inflated timelines". A watch hands its work every row it finds: one that turns up while the turn
// it woke runs, or before its run after, wakes the work again with it (Nov 22: a second access code
// entered during the first's turn was found after it and counted as met, never reaching the work;
// Switchboard's watches.rs had the same gap). A watch on a state (a work's status, an item closing)
// is met once nothing new turns up after its turn. One on a work whose find has gone by then (a
// task cut off by a usage limit that carried on, or steered back to work) watches again, and wakes
// its work once it holds again, as a row of a work's later turn is new (Nov 24: watches on tasks
// fired on a usage-limit cut, were judged broken minutes later as the tasks carried on, and their
// surprises stayed open after the tasks ended and reported). A watch on the log stays open: once
// its turn is
// over it goes back to watching, and each new event it matches wakes its work again, until its
// `check` holds after a wake, the scripts whose events it names end, its work drops it, or its work
// is dropped (Nov 23: a watch "on each
// box progress event" was met two minutes after the first, the agent saying it was still open; the
// run's failure an hour on reached no one). And an event a script records for its work reaches
// that work: one no open watch of it matches wakes it anyway, so what runs outside a turn always
// has its owner hear it end. A watch on the log wakes only for what's new, not for records that
// only say something changed, unless it asks for those; one whose work let 3 wakes in a row pass
// with nothing done is closed, and the work hears why (`news`, `ignored`).
// When its work is dropped (a task cancelled, its space archived) it's retired with it, and so is a
// watch on a task that's dropped: it won't end any other way.
import type { Database } from "bun:sqlite"
import {
  Brain,
  defineCommand,
  defineEvent,
  dependsOf,
  EventId,
  on,
  passed,
  Query,
  react,
  SpaceId,
  startOf,
  ThreadId,
  touches,
  userOf,
  whoOf,
} from "@switch/brain"
import type { Found, Projection } from "@switch/brain"
import { waitingEvent } from "@switch/agent"
import { Models } from "@switch/models"
import { Effect, Option, Schema, Stream } from "effect"

import { fieldsOf, items, ReviseItem } from "./items.ts"
import { field, jsonOf, list, text } from "./json.ts"
import { raise, resolve } from "./surprise.ts"

export const ExpectationSet = defineEvent(
  "expectation.set",
  1,
  Schema.Struct({
    id: Schema.String,
    space: SpaceId,
    /** What should happen, as an event would show it. */
    what: Schema.String,
    /** When, in ms: the latest it may come. Only a real time, with its source; a watch has none. */
    by: Schema.optionalKey(Schema.Number),
    /** Where `by` comes from: a date someone gave, an ETA, a schedule, a print's end. */
    source: Schema.optionalKey(Schema.String),
    /** What to do if it doesn't. */
    otherwise: Schema.String,
    /** The work that made it, which it wakes. Its space's thread when unset. */
    thread: Schema.optionalKey(ThreadId),
    check: Schema.optionalKey(Query),
    when: Schema.optionalKey(Query),
    promise: Schema.optionalKey(Schema.Boolean),
    /**
     * The seq of the agent's message a promise was read from (promises.ts): it's judged on what
     * happened from then, and it's a promise of the agent's words rather than one its work set.
     */
    said: Schema.optionalKey(Schema.Number),
  }),
)

/** `seq` is the event that showed it happened, 0 when a query or a judge did. */
export const ExpectationMet = defineEvent(
  "expectation.met",
  1,
  Schema.Struct({ id: Schema.String, seq: Schema.Number }),
)

/** Its time came and it hadn't happened (and, for a watch, that's a miss). */
export const ExpectationLapsed = defineEvent(
  "expectation.lapsed",
  1,
  Schema.Struct({ id: Schema.String }),
)

export const ExpectationDropped = defineEvent(
  "expectation.dropped",
  1,
  Schema.Struct({ id: Schema.String }),
)

/** Its work woke for it: `when` found something, or T came with it not kept. */
export const ExpectationWoke = defineEvent(
  "expectation.woke",
  1,
  Schema.Struct({
    id: Schema.String,
    /** What it found, or why it woke. */
    found: Schema.String,
    /** When it's judged again. */
    judgeAt: Schema.Number,
    /** The rows its work has been woken with so far, by key (a watch's). */
    rows: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
)

/** A watch on the log, its turn over, watches again: each new event it matches wakes its work. */
export const ExpectationWatching = defineEvent(
  "expectation.watching",
  1,
  Schema.Struct({ id: Schema.String }),
)

/** Judged not kept after its wake. */
export const ExpectationBroken = defineEvent(
  "expectation.broken",
  1,
  Schema.Struct({ id: Schema.String, why: Schema.String }),
)

export type ExpectationStatus = "open" | "met" | "lapsed" | "dropped" | "broken"

export interface Expectation {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly what: string
  readonly by: number | null
  readonly source: string | null
  readonly otherwise: string
  readonly check: Query | null
  readonly when: Query | null
  readonly promise: boolean
  readonly status: ExpectationStatus
  /** Set when its work woke for it. */
  readonly wokeAt: number | null
  /** The rows its work has been woken with, by key (rowKey). */
  readonly wokeRows: readonly string[]
  readonly judgeAt: number | null
  readonly setAt: number
  /** The log's seq when it was set: a watch on the log looks only after it. */
  readonly setSeq: number
  readonly closedAt: number | null
  /** The seq of the agent's message it was read from, for one promises.ts wrote. */
  readonly said: number | null
}

interface Row {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly what: string
  readonly by: number | null
  readonly source: string | null
  readonly otherwise: string
  readonly check_q: string | null
  readonly when_q: string | null
  readonly promise: number
  readonly status: ExpectationStatus
  readonly woke_at: number | null
  readonly woke_rows: string | null
  readonly judge_at: number | null
  readonly set_at: number
  readonly set_seq: number
  readonly closed_at: number | null
  readonly said: number | null
}

const decodeQuery = Schema.decodeUnknownSync(Schema.fromJsonString(Query))
const decodeKeys = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))

const toExpectation = (r: Row): Expectation => ({
  id: r.id,
  space: r.space,
  thread: r.thread,
  what: r.what,
  by: r.by,
  source: r.source,
  otherwise: r.otherwise,
  check: r.check_q === null ? null : decodeQuery(r.check_q),
  when: r.when_q === null ? null : decodeQuery(r.when_q),
  promise: r.promise === 1,
  status: r.status,
  wokeAt: r.woke_at,
  wokeRows: r.woke_rows === null ? [] : decodeKeys(r.woke_rows),
  judgeAt: r.judge_at,
  setAt: r.set_at,
  setSeq: r.set_seq,
  closedAt: r.closed_at,
  said: r.said,
})

const close = (status: ExpectationStatus) => (db: Database, id: string, time: number) => {
  db.query(
    "UPDATE expectations SET status = ?, closed_at = ? WHERE id = ? AND status = 'open'",
  ).run(status, time, id)
}

export const expectations: Projection = {
  name: "expectations",
  version: 6,
  tables: ["expectations"],
  create: `
    CREATE TABLE expectations (id TEXT PRIMARY KEY, space TEXT NOT NULL, thread TEXT,
      what TEXT NOT NULL, by INTEGER, source TEXT, otherwise TEXT NOT NULL, check_q TEXT,
      when_q TEXT, promise INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open',
      woke_at INTEGER, woke_rows TEXT, judge_at INTEGER, set_at INTEGER NOT NULL,
      set_seq INTEGER NOT NULL, closed_at INTEGER, said INTEGER);
    CREATE INDEX expectations_open ON expectations (status, by);`,
  on: [
    on(ExpectationSet, (db, p, e) => {
      // Setting one again moves it: a new time or wording replaces the old, and it waits anew.
      db.query(
        `INSERT INTO expectations (id, space, thread, what, by, source, otherwise, check_q, when_q,
           promise, set_at, set_seq, said) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET space = excluded.space, thread = excluded.thread,
           what = excluded.what, by = excluded.by, source = excluded.source,
           otherwise = excluded.otherwise, check_q = excluded.check_q, when_q = excluded.when_q,
           promise = excluded.promise, status = 'open', woke_at = NULL, woke_rows = NULL,
           judge_at = NULL, set_at = excluded.set_at, set_seq = excluded.set_seq, closed_at = NULL,
           said = excluded.said`,
      ).run(
        p.id,
        p.space,
        p.thread ?? null,
        p.what,
        p.by ?? null,
        p.source ?? null,
        p.otherwise,
        p.check === undefined ? null : JSON.stringify(p.check),
        p.when === undefined ? null : JSON.stringify(p.when),
        p.promise === true ? 1 : 0,
        e.time,
        e.seq,
        p.said ?? null,
      )
    }),
    on(ExpectationWoke, (db, p, e) => {
      db.query(
        "UPDATE expectations SET woke_at = ?, judge_at = ?, woke_rows = ? WHERE id = ? AND status = 'open'",
      ).run(e.time, p.judgeAt, p.rows === undefined ? null : JSON.stringify(p.rows), p.id)
    }),
    // The rows it woke its work with stay, so none wakes it twice.
    on(ExpectationWatching, (db, p) => {
      db.query(
        "UPDATE expectations SET woke_at = NULL, judge_at = NULL WHERE id = ? AND status = 'open'",
      ).run(p.id)
    }),
    on(ExpectationMet, (db, p, e) => {
      close("met")(db, p.id, e.time)
    }),
    on(ExpectationLapsed, (db, p, e) => {
      close("lapsed")(db, p.id, e.time)
    }),
    on(ExpectationDropped, (db, p, e) => {
      close("dropped")(db, p.id, e.time)
    }),
    on(ExpectationBroken, (db, p, e) => {
      close("broken")(db, p.id, e.time)
    }),
  ],
  snapshot: (db) => openExpectations(db),
  sources: [
    {
      name: "expectations",
      description:
        "id, space, thread (the work it wakes), what, by (ms; none for a watch), source (where by comes from), status (open, met, lapsed, dropped, broken), woke_at, closed_at.",
      select:
        "SELECT id, space, thread, what, by, source, otherwise, promise, status, woke_at, set_at, closed_at, rowid AS n FROM expectations",
      columns: [
        "id",
        "space",
        "thread",
        "what",
        "by",
        "source",
        "otherwise",
        "promise",
        "status",
        "woke_at",
        "set_at",
        "closed_at",
        "n",
      ],
      time: "set_at",
      order: "n",
      depends: ["expectation."],
    },
  ],
}

/** Open ones, soonest first, watches with no time last; in `spaces` when given. */
export const openExpectations = (db: Database, spaces?: readonly string[]): Expectation[] => {
  const rows = db
    .query<Row, []>("SELECT * FROM expectations WHERE status = 'open' ORDER BY by IS NULL, by")
    .all()
    .map(toExpectation)
  return spaces === undefined ? rows : rows.filter((x) => spaces.includes(x.space))
}

export const getExpectation = (db: Database, id: string) => {
  const row = db.query<Row, [string]>("SELECT * FROM expectations WHERE id = ?").get(id)
  return row ? toExpectation(row) : null
}

/**
 * Watches on a state, broken, whose surprise is still open: what `sweep` looks at again. A promise
 * or one with a check is its work's to answer.
 */
const brokenWatches = (db: Database): Expectation[] =>
  db
    .query<Row, []>(
      `SELECT e.* FROM expectations e JOIN surprises s ON s.id = 'broken:' || e.id
       WHERE s.status = 'open' AND e.status = 'broken' AND e.when_q IS NOT NULL
         AND e.check_q IS NULL`,
    )
    .all()
    .map(toExpectation)
    .filter((x) => x.when !== null && !onLog(x.when))

/** The tasks a watch on a state names: a work's thread or parent it waits on. */
export const tasksOf = (q: Query) =>
  (q.where ?? []).flatMap((c) =>
    (c.field === "thread" || c.field === "parent") &&
    c.op === "==" &&
    typeof c.value === "string" &&
    c.value.startsWith("task-")
      ? [c.value]
      : [],
  )

const droppedTask = (db: Database, task: string) =>
  db
    .query(
      "SELECT 1 FROM events WHERE type = 'task.dropped' AND json_extract(payload, '$.task') = ? LIMIT 1",
    )
    .get(task) !== null

/** One triage may mark met: no query or judge of its own decides it. A promise has its judge. */
export const plain = (x: Expectation) => x.check === null && x.when === null && !x.promise

export const Expect = defineCommand({
  type: "expectation.set",
  payload: ExpectationSet.payload,
  load: (db, p) => db.query("SELECT id FROM spaces WHERE id = ?").get(p.space) !== null,
  decide: (exists, p) =>
    exists ? { events: [ExpectationSet.make(p)] } : { reject: "No such space" },
})

export const DropExpectation = defineCommand({
  type: "expectation.drop",
  payload: ExpectationDropped.payload,
  load: (db, p) => getExpectation(db, p.id),
  decide: (x, p) => {
    if (!x) {
      return { reject: "No such expectation" }
    }
    return { events: x.status === "open" ? [ExpectationDropped.make(p)] : [] }
  },
})

export const expectConfig = {
  events: [
    ExpectationSet,
    ExpectationMet,
    ExpectationLapsed,
    ExpectationDropped,
    ExpectationWoke,
    ExpectationWatching,
    ExpectationBroken,
  ],
  projections: [expectations],
  commands: [Expect, DropExpectation],
}

const at = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })

/** What a lapsed expectation wakes its work with, at its time. */
export const lapseText = (x: Expectation, by: number) =>
  `Expected by ${at(by)}: ${x.what}. It hasn't happened. ${x.otherwise}`.trim()

/** A row a watch found, by what names it: its id, else its place in the log, else all of it. */
export const rowKey = (row: Readonly<Record<string, unknown>>) => {
  const named = row.id ?? row.seq ?? row.n
  if (typeof named !== "string" && typeof named !== "number") {
    return JSON.stringify(row)
  }
  // A work's row is the same thread through each of its turns: a later turn is news.
  return row.id === undefined && row.seq === undefined && typeof row.turn === "string"
    ? `${named}:${row.turn}`
    : String(named)
}

const onLog = (q: Query) => (q.from ?? "events") === "events"

/** A watch as the passes keep where they read it through: moved, it's another. */
const lookedKey = (x: Expectation) => `${x.id}:${x.setSeq}`

/** A watch on the log looks only at what came after it was set. */
export const scoped = (q: Query, after: number): Query =>
  onLog(q) ? { ...q, where: [...(q.where ?? []), { field: "seq", op: ">", value: after }] } : q

/** A watch on the log: it stays open after its wake, for each new event it matches. */
export const standing = (x: Pick<Expectation, "when">) => x.when !== null && onLog(x.when)

/**
 * When it's next due: its time until it wakes, its judging after. A standing watch that went back
 * to watching has none: its time was for the first of what it found, which came.
 */
const dueAt = (x: Expectation) => {
  if (x.wokeAt !== null) {
    return x.judgeAt
  }
  return x.wokeRows.length === 0 ? x.by : null
}

/**
 * Why a watch or check can't be kept, or null. One with no condition finds every row: on the log,
 * every event after it was set. Keys a query doesn't have are dropped when it's read, so a query
 * string (`{query: "entities | where …"}`) arrives as `{}` (Nov 22: watches set that way woke on
 * their own tool results).
 */
export const unconditioned = (q: Query) =>
  [...(q.where ?? []), ...(q.having ?? [])].length === 0 && q.since === undefined
    ? `${JSON.stringify(q)} has no condition, so it finds every row. Give a structured query as brain_query takes it, {"from": …, "where": [{"field": …, "op": …, "value": …}]}, not a query string.`
    : null

/** A few rows, for a wake or a tool's answer. */
export const brief = (found: Found) => {
  const n = found.rows.length
  const shown = JSON.stringify(found.rows.slice(0, 3))
  return `${n} row${n === 1 ? "" : "s"}: ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}`
}

const MINUTE = 60_000
const MAX_SLEEP = MINUTE
/** How often a broken watch's open surprise is looked at again. */
const SWEEP_MS = 5 * MINUTE
/** How often watches look at what landed. */
const WATCH_MS = 3000
/** The watches' cursor, kept at least this often while events land. */
const KEEP_MS = 10 * 60_000
const WATCHES = "expect-watches"
/** After a wake: a watch is judged once its turn is over, a promise or check ten minutes on. */
const AFTER_WATCH = 2 * MINUTE
const AFTER_DEADLINE = 10 * MINUTE
/** Judged anyway this long after its time, even with a turn still running in its work. */
const JUDGE_ANYWAY = 30 * MINUTE
/**
 * How long past its time a promise waits for a turn running in its work to end before it's judged
 * anyway (Switchboard's watch.rs:32-34, PROMISE_WAITS_MS).
 */
const PROMISE_WAITS_MS = 6 * 60 * MINUTE
/**
 * How long a promise still waiting on something (the user's answer, say) rests before it's judged
 * again, the first time: a deadline guessed for something that comes minutes later is judged again
 * soon after, and each rest is twice the last, up to `WAITING_RESTS_MS`, so one waiting days on an
 * answer is judged a few times a day (watch.rs:35-42, FIRST_REST_MS and WAITING_RESTS_MS).
 */
const FIRST_REST_MS = 10 * MINUTE
const WAITING_RESTS_MS = 3 * 60 * MINUTE

/** Text on one line, at most `n` characters (Switchboard's words.rs `one_line`). */
/** Whose words a line in a space is, as this check reads them. */
const SAID_BY = { agent: "Agent", peer: "Another agent", user: "User" } as const

const clip = (s: string, n: number) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** How long ago something was, the way people say it: "12 min ago" (words.rs `ago`). */
export const ago = (time: number, now: number) => {
  const minutes = Math.floor(Math.max(0, now - time) / MINUTE)
  if (minutes < 60) {
    return `${minutes} min ago`
  }
  return minutes < 2880
    ? `${Math.floor(minutes / 60)} h ago`
    : `${Math.floor(minutes / 1440)} days ago`
}

/** A moment as "Sun Nov 22 03:15", in `zone` (Switchboard's "%a %b %-d %H:%M"). */
export const moment = (ms: number, zone: string) => {
  const t = Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
  const name = (o: Intl.DateTimeFormatOptions) => t.toLocaleString("en-US", o)
  const hm = `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`
  return `${name({ weekday: "short" })} ${name({ month: "short" })} ${t.day} ${hm}`
}

/** Words that say how, not what: a promise isn't found by them (promises.rs:80-87, COMMON). */
const COMMON = new Set(
  `about after again also back because been before being both could does doing done each either every
  first from going gone have here into just know last later like make more most much need next once
  only other over said same since some soon still such sure than that their them then there these
  they this those through today tomorrow tonight under until using very want were what when where
  whether which while will with within without would your`.split(/\s+/u),
)

const parseJson: (json: string) => unknown = JSON.parse

const QUOTE = /['’]/u

/**
 * The words in a text, lowercased and without a possessive's 's. Contractions ("doesn't", "I'd")
 * say how, so they're left out (promises.rs:416-427, `tokens`).
 */
const tokens = (s: string) =>
  s
    .split(/[^\p{L}\p{N}'’]+/u)
    .map((w) => {
      const word = w.replaceAll(/^['’]+|['’]+$/gu, "").toLowerCase()
      return word.endsWith("'s") || word.endsWith("’s") ? word.slice(0, -2) : word
    })
    .filter((w) => w !== "" && !QUOTE.test(w))

const DIGIT = /[0-9]/u

/**
 * The words of a promise that name what it's about: a number or a code, or a word of four letters
 * or more that isn't how anything is said; each once (promises.rs:402-414, `distinctive`).
 */
const distinctive = (statement: string) => [
  ...new Set(
    tokens(statement).filter((w) =>
      DIGIT.test(w) ? w.length >= 2 : w.length >= 4 && !COMMON.has(w),
    ),
  ),
]

/** Open items from other work listed for a promise, at most (promises.rs:73, NAMING). */
const NAMING = 3

/**
 * Which of the open items (their words, in order) name what a promise is about, best first. A word
 * tells when at most two of them have it: one every reply card says ("reply", "send") names
 * nothing. An item names the promise when it shares two telling words, or one with a number or a
 * code in it (which counts as two), and at least half as many as the item that shares the most,
 * since a promise is about one thing (promises.rs:606-620, `naming`).
 */
const naming = (words: readonly string[], asks: readonly string[]) => {
  const held = asks.map((t) => new Set(tokens(t)))
  const telling = words.filter((w) => {
    const n = held.filter((h) => h.has(w)).length
    return n >= 1 && n <= 2
  })
  const named = held
    .map((h, i) => ({
      i,
      score: telling.filter((w) => h.has(w)).reduce((sum, w) => sum + (DIGIT.test(w) ? 2 : 1), 0),
    }))
    .filter((n) => n.score >= 2)
    .toSorted((a, b) => b.score - a.score || a.i - b.i)
  const best = named[0]?.score ?? 0
  return named.filter((n) => n.score * 2 >= best).map((n) => n.i)
}

interface OpenItem {
  readonly id: string
  readonly space: string
  readonly said: string
  readonly followers: string
}

/**
 * What a promise's work still waits on in the user's queue: the items its space put there, and
 * those it follows, still open; and open items from other spaces that name what it promised, since
 * a promise can wait on another work's card. A promise made for once one of these is answered isn't
 * broken while it's open. And what the work still expects itself (not promises read from its words):
 * a promise made for once a merge, a deploy or a print comes waits on the work's wake for it as on
 * an item (promises.rs:542-604, `waits_on`; Nov 17, 17:32: "once #332 is live" was judged broken
 * while the work's own expectation still waited on its merge).
 */
const waitsOn = (
  db: Database,
  x: Expectation,
  work: ThreadId,
  workOf: (y: Expectation) => ThreadId,
) => {
  const open = db
    .query<OpenItem, []>(
      `SELECT id, space, followers, trim(coalesce(json_extract(data, '$.title'), '') || ' ' ||
         coalesce(json_extract(data, '$.body'), '')) AS said
       FROM action_items WHERE status = 'open' ORDER BY opened_at ASC`,
    )
    .all()
  const line = (a: OpenItem) => `- ${clip(a.said, 300)}`
  const own = open.filter(
    (a) => a.space === x.space || list(parseJson(a.followers)).includes(x.space),
  )
  // Not the user, whom nearly everything names (promises.rs:383-388, `words`).
  const person = new Set(tokens(userOf(db)?.name ?? ""))
  const words = distinctive(x.what).filter((w) => !person.has(w))
  const named = naming(
    words,
    open.map((a) => a.said),
  )
    .flatMap((i) => open[i] ?? [])
    .filter((a) => !own.some((o) => o.id === a.id))
    .slice(0, NAMING)
    .map((a) => `${line(a)} (asked in ${a.space})`)
  // Not its own promises, read from its words: what it expects itself.
  const expects = openExpectations(db)
    .filter((y) => y.id !== x.id && y.said === null && workOf(y) === work)
    .map(
      (y) =>
        `- ${ago(y.setAt, Date.now())}${y.when === null ? "" : ", a wake for when it happens"}: ${clip(y.what, 300)}`,
    )
  return [
    own.length === 0
      ? `Nothing ${work} asked or follows is open in your person's queue now.`
      : `Still open in your person's queue, asked or followed by ${work}:\n${own.map(line).join("\n")}`,
    named.length === 0
      ? " No open ask from other work names what was promised."
      : `\n\nOpen in your person's queue from other work, naming what was promised (it may be what this waits on):\n${named.join("\n")}`,
    expects.length === 0
      ? ` Nothing ${work} expects itself is still waiting.`
      : `\n\nStill expected by ${work} itself, not yet come out (it may be what this waits on):\n${expects.join("\n")}`,
  ].join("")
}

/** Switchboard's promise judge, word for word but a store's name in an example (watch.rs:217, PROMISE_JUDGE). */
const PROMISE_JUDGE = `This is a promise you made. Decide whether it held, from what's known now, by what it was for: held is true when that came about, as your steps or your words show, in this work or another (you needn't have announced it, it may have been done just before you said it, and a step that only makes sense once an earlier part happened shows that part too), and when it's no longer wanted (your person declined it, or the plan changed). When it has a check, that ran just now and what it returned is listed: it shows whether what was promised was done, or, for one made on a condition, whether the condition came about. One made on a condition ("if it hasn't replied by Tuesday, I'll call", "if the build fails, I'll fix it") holds when the condition never came about (they replied, the build passed), since nothing was owed; never take the condition as met on a guess: when nothing known shows whether it came about, held is false and the note says it couldn't be told. When it was to happen once something else did (your person's approval or answer, a merge, a deploy, a build, a delivery) and that hasn't happened yet, while the work still waits on it (an ask still open in their queue, or something it still expects itself, listed, like a wake for that merge), it isn't broken: it's waiting, so held is false and waiting is true. It's broken only when what's known shows what it was for didn't happen though it could have. When it didn't hold, headline says what didn't happen in at most six plain words (under 40 characters), past tense, leading with the verb, like "Didn't send the pickup push" or "Printer jobs never started" (no quotes, no "I said"); otherwise it's empty. Reply with JSON only: {"held": true|false, "waiting": true|false, "note": "<one sentence>", "headline": "<a few words>"}`

/** What a promise's work did since it was said (from its message, when it was read from one), for the judge. */
const didSince = (db: Database, x: Expectation, thread: ThreadId) => {
  const from = x.said ?? x.setSeq
  const steps = db
    .query<{ body: string }, [string, number]>(
      "SELECT body FROM thread_items WHERE thread = ? AND seq > ? ORDER BY seq DESC LIMIT 40",
    )
    .all(thread, from)
    .toReversed()
    .map((r) => {
      const b: unknown = JSON.parse(r.body)
      const kind = text(field(b, "kind"))
      if (kind === "tool") {
        return `- called ${text(field(b, "name"))} ${clip(JSON.stringify(field(b, "input")), 200)}`
      }
      if (kind === "result") {
        return `  → ${clip(text(field(b, "output")), 200)}`
      }
      return `- ${kind}: ${clip(text(field(b, "text")), 300)}`
    })
  const said = db
    .query<{ source: string; text: string }, [string, number]>(
      "SELECT source, text FROM messages WHERE space = ? AND seq > ? ORDER BY seq DESC LIMIT 10",
    )
    .all(x.space, from)
    .toReversed()
    .map((m) => `- ${SAID_BY[whoOf(m.source)]}: ${clip(m.text, 300)}`)
  return [
    steps.length > 0 ? `Its work since:\n${steps.join("\n")}` : "Its work has done nothing since.",
    said.length > 0 ? `Said in its space since:\n${said.join("\n")}` : "",
  ]
    .filter((s) => s !== "")
    .join("\n\n")
    .slice(-8000)
}

const running = (db: Database, thread: ThreadId) =>
  db.query<{ status: string }, [string]>("SELECT status FROM threads WHERE thread = ?").get(thread)
    ?.status === "running"

/** The work an expectation wakes: the thread that made it, else its space's. */
const workOfIn = (config: ExpectConfig, x: Expectation) => x.thread ?? config.threadOf(x.space)

/** One held back, by what it is now: a new time or a wake makes it another. */
const keyOf = (x: Expectation) => `${x.id}:${x.setSeq}:${x.wokeAt ?? 0}`

/** Judged by the promise judge, as Switchboard's `for_the_judge`: a promise without a `when`. */
const forTheJudge = (x: Expectation) => x.promise && x.when === null

export interface ExpectConfig {
  /** A space's master thread. */
  readonly threadOf: (space: SpaceId) => ThreadId
  /**
   * Starts what waits for a thread in the record: between tool calls of its running turn, or a turn
   * of its own. A wake waits there from the write that says it woke, so a restart can't lose it.
   */
  readonly kick: (thread: ThreadId) => Effect.Effect<void>
}

class Unread extends Schema.TaggedError<Unread>()("Unread", { reason: Schema.String }) {}

/** Watches, deadlines and judging, and retiring what dropped work made. */
export const expectationWorker = (config: ExpectConfig) =>
  Effect.gen(function* working() {
    const brain = yield* Brain
    const models = yield* Models
    const ingest = (type: string, key: string, payload: unknown) =>
      Effect.orDie(brain.ingest([{ id: EventId.make(key), type, source: "autonomy", payload }]))
    // A record and the wake it owes its work, in one write, then the work started.
    const ingestWaking = (
      type: string,
      key: string,
      payload: unknown,
      x: Expectation,
      say: string,
    ) =>
      Effect.gen(function* waking() {
        const thread = workOfIn(config, x)
        yield* Effect.orDie(
          brain.ingest([
            { id: EventId.make(key), type, source: "autonomy", payload },
            waitingEvent(`${key}:wake`, { thread, text: "", note: say, from: "steer" }),
          ]),
        )
        yield* config.kick(thread)
      })

    const holds = (q: Query, x: Expectation, after = x.setSeq) =>
      Effect.map(Effect.option(brain.query(scoped(q, after))), (found) =>
        Option.isSome(found) && found.value.rows.length > 0 ? found.value : null,
      )

    // When each one held back is looked at again: one still waiting rests, one whose work is
    // running is looked at each minute (watch.rs:76-79, `resting` and `rested`).
    const later = new Map<string, number>()
    const rested = new Map<string, number>()
    const rest = (x: Expectation) =>
      Effect.sync(() => {
        const n = rested.get(keyOf(x)) ?? 0
        later.set(
          keyOf(x),
          Date.now() + Math.min(FIRST_REST_MS * 2 ** Math.min(n, 8), WAITING_RESTS_MS),
        )
        rested.set(keyOf(x), n + 1)
      })

    /** The verdict on a promise from what's known now (watch.rs:219-226, 347-374). */
    const verdictOn = (x: Expectation) =>
      Effect.gen(function* judging() {
        const now = Date.now()
        const work = workOfIn(config, x)
        const checked =
          x.check === null
            ? ""
            : yield* Effect.match(brain.query(scoped(x.check, x.said ?? x.setSeq)), {
                onFailure: (e) =>
                  `Its check (${JSON.stringify(x.check)}) couldn't run: ${e.reason}\n`,
                onSuccess: (found) =>
                  `Its check (${JSON.stringify(x.check)}) returned: ${JSON.stringify(found.rows).slice(0, 3000)}\n`,
              })
        const evidence = yield* brain.read(
          (db) =>
            `${checked}${didSince(db, x, work)}\n${waitsOn(db, x, work, (y) => workOfIn(config, y))}\n`,
        )
        // One its work was woken to keep is due once that turn has had its go (watch.rs:422-441).
        const due = moment(x.judgeAt ?? x.by ?? now, "UTC")
        const input = `Expectation (due ${due} UTC; it's now ${moment(now, "UTC")} UTC): ${x.what}\n\nWhat's known now:\n${evidence}`
        const reply = jsonOf((yield* models.complete("gate", PROMISE_JUDGE, input)).text)
        const held = field(reply, "held")
        if (typeof held !== "boolean") {
          return yield* new Unread({ reason: "The judge's reply had no verdict" })
        }
        return { held, waiting: field(reply, "waiting") === true, note: text(field(reply, "note")) }
      })

    const evaluate = (x: Expectation) =>
      Effect.map(
        holds(x.check ?? x.when ?? {}, x),
        (found) => (x.check ?? x.when) !== null && found !== null,
      )

    const woke = (
      x: Expectation,
      found: string,
      judgeAt: number,
      say: string,
      rows: readonly string[] = [],
    ) =>
      Effect.gen(function* waking() {
        // Each wake its own: a watch that wakes again for new rows counts them.
        const again = x.wokeRows.length === 0 ? "" : `:${rows.length}`
        yield* ingestWaking(
          ExpectationWoke.type,
          `woke:${x.id}:${x.setSeq}${again}`,
          { id: x.id, found, judgeAt, ...(rows.length > 0 && { rows }) },
          x,
          say,
        )
      })

    // Met, a surprise its earlier setting raised (the same id, moved) is over too.
    const met = (x: Expectation) =>
      Effect.andThen(
        ingest(ExpectationMet.type, `met:${x.id}:${x.setSeq}`, { id: x.id, seq: 0 }),
        resolve(`broken:${x.id}`),
      )

    const broken = (x: Expectation, why: string) =>
      Effect.gen(function* breaking() {
        yield* ingestWaking(
          ExpectationBroken.type,
          `broken:${x.id}:${x.setSeq}`,
          { id: x.id, why },
          x,
          `${why} Do it now, or say why it can't be.`,
        )
        yield* raise({
          id: `broken:${x.id}`,
          space: x.space,
          thread: workOfIn(config, x),
          kind: "broken",
          text: why,
        })
      })

    // A promise at its time, or ten minutes after the turn it woke (watch.rs:347-407): kept, it's
    // met; still waiting on something, it rests; not kept yet, its work wakes to keep it; not kept
    // after that, it's broken. A call that failed is tried again the same way (watch.rs:320-324).
    const judgePromise = (x: Expectation) =>
      Effect.gen(function* judging() {
        const v = yield* verdictOn(x)
        // Its statement ends where the line goes on (watch.rs:433).
        const said = x.what.trim().replace(/\.+$/u, "")
        if (v.held) {
          yield* met(x)
        } else if (v.waiting) {
          yield* rest(x)
        } else if (x.wokeAt === null) {
          yield* woke(
            x,
            "deadline",
            Date.now() + AFTER_DEADLINE,
            `It's time to keep what you promised${x.by === null ? "" : ` (due ${at(x.by)})`}: ${said}. ${x.otherwise}`.trim(),
          )
        } else {
          yield* broken(
            x,
            `You promised: ${said}. It isn't done${v.note === "" ? "." : `: ${v.note}`}`,
          )
        }
      }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning(`Couldn't judge promise ${x.id}: ${cause.reason}`),
        ),
        Effect.catch(() => rest(x)),
      )

    // At its time, still waiting.
    const due = (x: Expectation, by: number) =>
      Effect.gen(function* deadline() {
        if (x.when !== null) {
          yield* ingestWaking(
            ExpectationLapsed.type,
            `lapsed:${x.id}:${x.setSeq}`,
            { id: x.id },
            x,
            `What you waited for hasn't come by ${at(by)}: ${x.what}. Find out why. ${x.otherwise}`.trim(),
          )
          return
        }
        if (x.check === null) {
          yield* ingestWaking(
            ExpectationLapsed.type,
            `lapsed:${x.id}:${by}`,
            { id: x.id },
            x,
            lapseText(x, by),
          )
          return
        }
        if (yield* evaluate(x)) {
          yield* met(x)
          return
        }
        yield* woke(
          x,
          "deadline",
          Date.now() + AFTER_DEADLINE,
          `Expected by ${at(by)}: ${x.what}. Its check finds nothing. ${x.otherwise}`.trim(),
        )
      })

    /** Whether a watch on the log matches the event at `seq`. */
    const matches = (x: Expectation, seq: number) => {
      const q = x.when ?? {}
      return Effect.map(
        holds({ ...q, where: [...(q.where ?? []), { field: "seq", op: "==", value: seq }] }, x),
        (found) => found !== null,
      )
    }

    // What a watch finds that's news: on the log, an entity's first record, not one that only says
    // it changed (read, delivered, edited), unless the watch asks for its changes (`asksForChanges`).
    const firsts = new Map<string, number>()
    const findNews = (x: Expectation, after = x.setSeq) =>
      Effect.gen(function* finding() {
        const found = yield* holds(x.when ?? {}, x, after)
        if (found === null) {
          return null
        }
        const rows = yield* brain.read((db) => news(db, x, found.rows, firsts))
        return rows.length > 0 ? { rows } : null
      })

    // A watch that woke its work IDLE_WAKES times in a row with nothing done about any of them is
    // closed rather than woken again, and its work hears why in its next turn: each wake is a turn.
    const closeIdle = (x: Expectation) =>
      Effect.gen(function* closing() {
        yield* ingest(ExpectationDropped.type, `idle:${x.id}:${x.setSeq}`, { id: x.id })
        yield* raise({
          id: `idle:${x.id}:${x.setSeq}`,
          space: x.space,
          thread: workOfIn(config, x),
          kind: "other",
          text: `Watch ${x.id} (${clip(x.what, 120)}) is closed: it woke you ${IDLE_WAKES} times in a row and you acted on none of them. It watched ${JSON.stringify(x.when)}. If it's still wanted, set a narrower one that finds only what you'd act on.`,
        })
      })

    // A watch found something: its work does what it said, with each row it hasn't been woken with.
    const fire = (x: Expectation, found: Found) =>
      Effect.gen(function* firing() {
        if (
          standing(x) &&
          x.wokeRows.length > 0 &&
          (yield* brain.read((db) => ignored(db, x, workOfIn(config, x))))
        ) {
          yield* closeIdle(x)
          return
        }
        yield* wake(x, found)
      })

    const wake = (x: Expectation, found: Found) => {
      const keys = found.rows.map(rowKey)
      const fresh = { rows: found.rows.filter((_, i) => !x.wokeRows.includes(keys[i] ?? "")) }
      const what =
        x.wokeRows.length === 0
          ? `What you were waiting for happened (${brief(fresh)})`
          : `More of what you were waiting for happened since (${brief(fresh)}; you were woken with ${x.wokeRows.length} before)`
      // How it stands once this turn is over, so the work knows whether it still watches.
      const after = standing(x)
        ? `Watch ${x.id} stays open${scriptsOf(x).length === 0 ? "" : " while its script runs"}: each new event it matches wakes you again${x.check === null ? "" : ", until its check holds"}. Drop it (expect, drop) once nothing more is coming.`
        : `Watch ${x.id} is met once this turn is over: for more of it, set another.`
      return woke(x, brief(fresh), Date.now() + AFTER_WATCH, `${what}. Now: ${x.what}\n${after}`, [
        ...new Set([...x.wokeRows, ...keys]),
      ])
    }

    // Where the passes have read each watch on the log through. One reads what landed since, never
    // the whole log back to when it was set: a broad one (a payload containing a name) read every
    // event since then on each pass, a second of the disk on the core's thread every few seconds,
    // and tens of seconds when memory was short. A move (a new set seq) starts it again.
    const looked = new Map<string, number>()

    const watchAgain = (x: Expectation) =>
      ingest(ExpectationWatching.type, `watching:${x.id}:${x.setSeq}:${x.wokeAt ?? 0}`, {
        id: x.id,
      })

    // After its wake: kept now, or a surprise its work hears. A watch's rows that its work wasn't
    // woken with wake it again with them. A standing one then watches again, unless its check
    // holds; any other is met once nothing new turns up.
    const judge = (x: Expectation) =>
      Effect.gen(function* judging() {
        // One woken before its rows were kept (none listed) is judged as it was.
        if (x.when !== null && x.wokeRows.length > 0) {
          // What landed since the pass that woke it: the rows before were all looked at.
          const found = yield* findNews(x, looked.get(lookedKey(x)) ?? x.setSeq)
          if (found !== null && found.rows.some((r) => !x.wokeRows.includes(rowKey(r)))) {
            yield* fire(x, found)
            return
          }
        }
        if (standing(x)) {
          const gone = yield* brain.read((db) => scriptGone(db, x))
          const over = gone || (x.check !== null && (yield* evaluate(x)))
          yield* over ? met(x) : watchAgain(x)
          return
        }
        if (yield* evaluate(x)) {
          yield* met(x)
          return
        }
        // A watch on a state whose find has gone (its task carried on after a usage limit, or was
        // steered back to work) watches again: it wakes its work once it holds again.
        if (x.when?.from === "work" && x.check === null) {
          yield* watchAgain(x)
          return
        }
        yield* broken(
          x,
          `${x.what}: ${x.check === null ? "what the watch found" : "its check"} doesn't hold after the turn it woke.`,
        )
      })

    // A surprise a watch on a state raised once it broke is over when what it waited for holds now
    // (the task it watched ended after all) or the task it watched was dropped: looked at every few
    // minutes, so none stays open after what it was about came out.
    let swept = 0
    const sweep = Effect.gen(function* sweeping() {
      if (Date.now() - swept < SWEEP_MS) {
        return
      }
      swept = Date.now()
      const stale = yield* brain.read((db) => brokenWatches(db))
      for (const x of stale) {
        const when = x.when ?? {}
        const dropped = yield* brain.read((db) => tasksOf(when).some((t) => droppedTask(db, t)))
        if (dropped || (yield* evaluate(x))) {
          yield* resolve(`broken:${x.id}`)
        }
      }
    })

    const tick = Effect.gen(function* ticking() {
      yield* Effect.ignore(sweep, { log: "Warn" })
      const now = Date.now()
      const open = yield* brain.read((db) => openExpectations(db))
      const keys = new Set(open.map(keyOf))
      for (const key of later.keys()) {
        if (!keys.has(key)) {
          later.delete(key)
          rested.delete(key)
        }
      }
      for (const x of open) {
        const time = dueAt(x)
        if (time === null || time > now || (later.get(keyOf(x)) ?? 0) > now) {
          continue
        }
        const busy = yield* brain.read((db) => running(db, workOfIn(config, x)))
        // A promise waits for the turn running in its work to end (a few hours at most), so it's
        // judged on all it did (watch.rs:307-310); a watch or check after its wake, half an hour.
        const waits = forTheJudge(x) || x.wokeAt !== null
        if (busy && waits && now - time < (forTheJudge(x) ? PROMISE_WAITS_MS : JUDGE_ANYWAY)) {
          later.set(keyOf(x), now + MINUTE)
        } else if (forTheJudge(x)) {
          yield* judgePromise(x)
        } else if (x.wokeAt === null && x.by !== null) {
          yield* due(x, x.by)
        } else {
          yield* judge(x)
        }
      }
    })
    // Watches run again when what landed can change them, from where they left off: what landed as
    // the core stopped is read once it's back. Their cursor is kept each time one fires, and every
    // ten minutes; read again, an event fires nothing twice, as one woken isn't watched any more.
    let seen = yield* startOf(WATCHES)
    // The last core read every watch open then through its cursor, at least.
    const start = seen
    const kept = { seq: seen, at: Date.now() }
    const keep = Effect.suspend(() => {
      kept.seq = seen
      kept.at = Date.now()
      return passed(WATCHES, seen)
    })
    // One open watch over what landed up to `through`, of `types`: whether it fired.
    const lookOver = (x: Expectation, types: readonly string[], through: number) =>
      Effect.gen(function* looking() {
        let fired = false
        // One set before these were refused never fires.
        if (
          x.when !== null &&
          unconditioned(x.when) === null &&
          types.some((t) => touches(dependsOf(brain.sources, x.when ?? {}), t))
        ) {
          const from = Math.max(x.setSeq, looked.get(lookedKey(x)) ?? start)
          const found = yield* findNews(x, from)
          // One watching again wakes only for what it hasn't woken its work with.
          if (found !== null && found.rows.some((r) => !x.wokeRows.includes(rowKey(r)))) {
            yield* fire(x, found)
            fired = true
          }
        }
        looked.set(lookedKey(x), through)
        return fired
      })
    const watch = Effect.gen(function* watching() {
      const through = yield* brain.read(head)
      if (through === seen) {
        return
      }
      const types = yield* brain.read((db) => typesBetween(db, seen, through))
      const recorded = yield* brain.read((db) => scriptRecords(db, seen, through))
      seen = through
      let fired = false
      const open = yield* brain.read((db) =>
        openExpectations(db).filter((x) => x.when !== null && x.wokeAt === null),
      )
      for (const x of open) {
        fired = (yield* lookOver(x, types, through)) || fired
      }
      // What a script records for its work is that work's to hear: one no open watch of the work
      // matches wakes it anyway.
      if (recorded.length > 0) {
        const watches = yield* brain.read((db) =>
          openExpectations(db).filter((x) => standing(x) && unconditioned(x.when ?? {}) === null),
        )
        for (const r of recorded) {
          let heard = false
          for (const x of watches.filter((w) => workOfIn(config, w) === r.thread)) {
            if (yield* matches(x, r.seq)) {
              heard = true
              break
            }
          }
          // A watch on a script's events ends with it, unless its end is one of them: nothing more
          // comes.
          if (r.type === SCRIPT_ENDED) {
            for (const w of watches.filter(
              (x) => x.wokeAt === null && x.space === r.space && scriptsOf(x).includes(r.script),
            )) {
              if (!(yield* matches(w, r.seq))) {
                yield* met(w)
              }
            }
          }
          if (!heard) {
            yield* Effect.orDie(
              brain.ingest([
                waitingEvent(`script-heard:${r.seq}`, {
                  thread: r.thread,
                  text: "",
                  note: `Your script ${r.script} recorded ${r.type}${r.data === "" ? "" : `: ${r.data}`}. No watch of yours is open for it.`,
                  from: "steer",
                }),
              ]),
            )
            yield* config.kick(r.thread)
            fired = true
          }
        }
      }
      if (fired || (seen > kept.seq && Date.now() - kept.at >= KEEP_MS)) {
        yield* keep
      }
    })

    // Work dropped: its expectations go with it. An item it took out of the user's queue to
    // rework comes back as it is when its work ends, dropped or not, so it's never stranded.
    // From its cursor, so work dropped as the core stopped still takes its expectations with it.
    const retire = react(
      "expect-retire",
      (e) => e.type === "task.dropped" || e.type === "task.ended" || e.type === "space.archived",
      (e) =>
        Effect.gen(function* retiring() {
          const task = text(field(e.payload, "task"))
          const space = text(field(e.payload, "id"))
          const archived = e.type === "space.archived"
          const { gone, reworked } = yield* brain.read((db) => ({
            // What it made, and a watch on it ending: dropped, it won't end any other way.
            gone:
              e.type === "task.ended"
                ? []
                : openExpectations(db).filter((x) =>
                    archived
                      ? x.space === space
                      : x.thread === task ||
                        (x.when !== null && !onLog(x.when) && tasksOf(x.when).includes(task)),
                  ),
            reworked: items(db, { status: "open" }).filter(
              (i) =>
                i.revising !== undefined &&
                (archived ? i.space === space : i.revising.thread === task),
            ),
          }))
          for (const x of gone) {
            yield* ingest(ExpectationDropped.type, `retired:${x.id}:${e.seq}`, { id: x.id })
            yield* resolve(`broken:${x.id}`)
          }
          for (const i of reworked) {
            const back = { ...fieldsOf(i) }
            delete back.revising
            yield* Effect.ignore(
              brain.dispatch({
                id: `back:${i.id}:${e.seq}`,
                type: ReviseItem.type,
                source: "autonomy",
                payload: back,
              }),
              { log: "Warn" },
            )
          }
        }),
    )
    yield* Effect.forkScoped(retire)

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(Effect.ignore(watch, { log: "Warn" }), Effect.sleep(`${WATCH_MS} millis`)),
      ),
    )

    // A change to any expectation cuts the sleep short.
    const changed = (after: number) =>
      brain.changes(after).pipe(
        Stream.filter((e) => e.type.startsWith("expectation.")),
        Stream.take(1),
        Stream.runDrain,
      )
    yield* Effect.forever(
      Effect.gen(function* timing() {
        const from = yield* brain.read(head)
        yield* Effect.ignore(tick, { log: "Warn" })
        // One held back is next looked at when its rest or minute is up, not at its passed time.
        const next = yield* brain.read((db) => {
          let soonest: number | null = null
          for (const x of openExpectations(db)) {
            const own = dueAt(x)
            const t = own === null ? null : Math.max(own, later.get(keyOf(x)) ?? 0)
            if (t !== null && (soonest === null || t < soonest)) {
              soonest = t
            }
          }
          return soonest
        })
        const wait = next === null ? MAX_SLEEP : Math.min(MAX_SLEEP, Math.max(0, next - Date.now()))
        yield* Effect.raceFirst(Effect.sleep(wait), changed(from))
      }),
    )
  })

/**
 * Whether a watch asks for an entity's changes, not just what's new: it names one of its facts, the
 * one entity it's about, or keeps the newest record per key. A print's state, a PR's checks.
 */
const asksForChanges = (q: Query) =>
  q.latest !== undefined ||
  [...(q.where ?? []), ...(q.having ?? [])].some(
    (c) =>
      c.field.startsWith("payload.data.facts.") ||
      (c.field === "payload.data.entity" && (c.op === "==" || c.op === "in")),
  )

const entityOf = (row: Readonly<Record<string, unknown>>) => {
  const { payload } = row
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    return null
  }
  const { data } = payload
  return typeof data === "object" &&
    data !== null &&
    "entity" in data &&
    typeof data.entity === "string"
    ? data.entity
    : null
}

/**
 * The rows that are news to a watch on the log: each a record of something new, or the first about
 * its entity. A later record about one (read, delivered, edited, its state said again) only says it
 * changed (triage's `firstAbout`, Switchboard's `wakes.first`). The user, Nov 23: a watch for mail
 * from someone woke a full turn on each read receipt of his texts.
 */
const news = (
  db: Database,
  x: Expectation,
  rows: readonly Readonly<Record<string, unknown>>[],
  firsts: Map<string, number>,
) => {
  if (x.when === null || !onLog(x.when) || asksForChanges(x.when)) {
    return rows
  }
  const first = db.query<{ seq: number | null }, [string, string]>(
    "SELECT min(seq) AS seq FROM events WHERE type = ? AND json_extract(payload, '$.data.entity') = ?",
  )
  return rows.filter((row) => {
    const entity = entityOf(row)
    const { seq, type } = row
    if (entity === null || typeof seq !== "number" || typeof type !== "string") {
      return true
    }
    const key = `${type}\n${entity}`
    let earliest = firsts.get(key)
    if (earliest === undefined) {
      earliest = first.get(type, entity)?.seq ?? seq
      firsts.set(key, earliest)
    }
    return earliest === seq
  })
}

/**
 * How many wakes in a row a watch's work may let pass without acting before it's closed. On the 77
 * wakes log watches gave Nov 21-23, the work acted after 0 idle wakes in a row 58 times, after 1
 * twice, after 2 once, and never after 3 or more; the one watch that went 3 and on (mail from
 * someone, waking on his texts' read receipts) went 8 with nothing done.
 */
const IDLE_WAKES = 3

/** Tools that only read, or choose nothing: a turn that called only these didn't act. */
const READS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "search_tools",
  "autonomy_nothing",
  "wait",
  "task_status",
  "skills_read",
])
const ACTS_IN_BRAIN = new Set(["brain_react", "brain_show_widget"])

/** A call's tool as the agent named it: through the gateway's `call_tool`, or its own name. */
const toolOf = (name: string, input: string | null) => {
  if (!name.endsWith("call_tool")) {
    return name.split("__").at(-1) ?? name
  }
  const given: unknown = input === null ? null : JSON.parse(input)
  return typeof given === "object" &&
    given !== null &&
    "name" in given &&
    typeof given.name === "string"
    ? given.name
    : ""
}

const acts = (tool: string) =>
  ACTS_IN_BRAIN.has(tool) || !(READS.has(tool) || tool.startsWith("brain_"))

/**
 * Whether the work let the last IDLE_WAKES wakes this watch gave it pass without acting on any: the
 * turn that took each (the first after it in the work) is over and called nothing but reads.
 */
const ignored = (db: Database, x: Expectation, work: ThreadId) => {
  const wakes = db
    .query<{ seq: number }, [number, string, number]>(
      `SELECT seq FROM events WHERE type = 'expectation.woke' AND seq > ?
         AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(x.setSeq, x.id, IDLE_WAKES)
  if (wakes.length < IDLE_WAKES) {
    return false
  }
  const taker = db.query<{ turn: string }, [string, number]>(
    "SELECT turn FROM thread_items WHERE thread = ? AND seq > ? ORDER BY seq LIMIT 1",
  )
  const now = db
    .query<{ status: string; turn: string | null }, [string]>(
      "SELECT status, turn FROM threads WHERE thread = ?",
    )
    .get(work)
  const tools = db.query<{ name: string; input: string | null }, [string, number, string]>(
    `SELECT json_extract(body, '$.name') AS name, json_extract(body, '$.input') AS input
       FROM thread_items WHERE thread = ? AND seq > ? AND turn = ? AND json_extract(body, '$.kind') = 'tool'`,
  )
  return wakes.every((w) => {
    const turn = taker.get(work, w.seq)?.turn
    if (turn === undefined || (now?.status === "running" && now.turn === turn)) {
      return false
    }
    return !tools.all(work, w.seq, turn).some((t) => acts(toolOf(t.name, t.input)))
  })
}

/** A script's end on its own (core's scripts.ts `ScriptEnded`). */
const SCRIPT_ENDED = "script.ended"

/** The scripts whose events a watch is on: those its conditions name. */
const scriptsOf = (x: Pick<Expectation, "when">) =>
  (x.when?.where ?? []).flatMap((c) =>
    c.field === "payload.script" && c.op === "==" && typeof c.value === "string" ? [c.value] : [],
  )

/** Whether every script a watch is on was set in its space and runs no more. */
const scriptGone = (db: Database, x: Expectation) => {
  const names = scriptsOf(x)
  const status = db.query<{ status: string }, [string, string]>(
    "SELECT status FROM scripts WHERE space = ? AND name = ?",
  )
  return (
    names.length > 0 &&
    names.every((name) => {
      const s = status.get(x.space, name)
      return s !== null && s.status !== "running"
    })
  )
}

interface Recorded {
  readonly seq: number
  readonly type: string
  readonly space: SpaceId
  readonly thread: ThreadId
  readonly script: string
  readonly data: string
}

/** What scripts recorded for a work between two points of the log: their events and their ends. */
const scriptRecords = (db: Database, after: number, through: number) =>
  db
    .query<Recorded, [number, number]>(
      `SELECT seq, type, json_extract(payload, '$.space') AS space,
         json_extract(payload, '$.thread') AS thread,
         json_extract(payload, '$.script') AS script,
         coalesce(json_extract(payload, '$.data') || '', '') AS data
       FROM events WHERE seq > ? AND seq <= ? AND source = 'script'
         AND json_extract(payload, '$.thread') IS NOT NULL ORDER BY seq`,
    )
    .all(after, through)
    .map((r) => ({ ...r, data: clip(r.data, 600) }))

const typesBetween = (db: Database, after: number, through: number) =>
  db
    .query<{ type: string }, [number, number]>(
      "SELECT DISTINCT type FROM events WHERE seq > ? AND seq <= ?",
    )
    .all(after, through)
    .map((r) => r.type)

const head = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0
