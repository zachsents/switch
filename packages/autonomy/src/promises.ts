// What did I promise and not do? Switchboard's promises kernel (crates/monologue/src/kernels/bodies/
// promises.rs), fed as its ponderer fed it (kernels/ponder.rs), with the builtin kernel's question
// and threshold (kernels/builtin.rs:332-358). Each thing I say in my work (a turn's reply, or what a
// turn posted) is read for a promise: one decision probability, does it commit me to doing
// something later? What does is written down by the mid model as an expectation (expect.ts): what
// I said I'd do, when it's due, and how my senses would show it's done. A promise waits on a later
// time or on something that hasn't happened yet: saying what I'm doing now in the same stretch of
// work isn't one, and neither is one already held there when I said it, said again (a promise, or
// what the work expects itself, set with expect), even when it's been judged since: a message read
// late doesn't promise again what's been kept (Nov 17: restarts read hours-old messages again, and
// wrote eight promises already kept). Nor is one in a task's report relayed into the work that
// started it (the task said it in its own work): here a task's end reaches its parent as no
// message. One made on a condition ("if it hasn't replied by Tuesday, I'll call") carries the check
// that shows whether the condition came about, since nothing is owed when it doesn't. A check names
// the one thing it's about (the card, the pull request), and one that finds only what was there
// before I said it is dropped: it would read as done, or as come about, from the start (Nov 17,
// 19:22: a check for "once the user approves the fit-check card" found every ask its work had
// closed, the approval an hour before among them). One that changes a promise held there (a new
// time, a new condition) replaces it, so the old one isn't judged beside it; when the work expects
// the same thing itself, that holds it, and the old promise is retired instead (Nov 17, 20:02: an
// after-shots promise was rewritten beside the work's own wake for the same shots). Judging them at
// their time is expect.ts's, as it was Switchboard's watch.rs.
import type { Database } from "bun:sqlite"
import {
  Brain,
  defineEvent,
  defineRead,
  EventId,
  MessagePosted,
  Query,
  SpaceId,
  ThreadId,
} from "@switch/brain"
import type { Found, Incoming, Rejected } from "@switch/brain"
import { Models } from "@switch/models"
import { Cause, Effect, Exit, Option, Schema, Stream } from "effect"

import { inputFor } from "./caller.ts"
import { ago, ExpectationDropped, ExpectationSet, moment, scoped } from "./expect.ts"
import { field, jsonOf, list, text } from "./json.ts"
// A burst gathers two minutes (builtin.rs:342 `batch_s`), and one that couldn't be read is tried
// again in five, let go past six hours, as the ponderer's (ponder.rs:43-50).
import { BATCH_MS, GIVE_UP_MS, oneLine, RETRY_MS } from "./ponder.ts"

/** A decision reads at most this many messages at once (ponder.rs:45-46, AT_ONCE). */
const AT_ONCE = 40
/** What a message's probability must reach: the kernel's `wakes.at` (builtin.rs:343; ponder.rs:292-301). */
const AT = 0.6
/** A promise with no time to it is due this long after it was made, and none later than a week (promises.rs:51-54). */
const DEFAULT_DUE_MIN = 120
const LATEST_DUE_MIN = 7 * 24 * 60
/** How far back what a work still holds is read (promises.rs:55-57, HELD_FOR). */
const HELD_FOR_MS = 14 * 86_400_000

/** What every kernel's decision is told (ponder.rs:56-59, GUIDE). */
const GUIDE =
  "You decide whether one of the kernels of Switch, an AI assistant that works for one person, wakes for what just came in. A kernel owns one question, and what wakes it costs real work (a model call that writes, or a full agent turn), so a record wakes it only when it plainly bears on that question; when the kernel's words don't settle a record, let it go unless missing it would cost the person something, since nothing is lost by letting one go (it stays in the brain). Answer each question about the numbered records below."

/** The kernel, its question and its one criterion (builtin.rs:332-358). */
const KERNEL = "What I promised"
const QUESTION = "What did I promise to do later, and did I do it?"
const ASK =
  'Saying what I\'m doing now or next in the same stretch of work ("Checking…", "Now writing…", "Committing that, then…") isn\'t a promise, and neither is a report of what\'s done, an offer or a question. Does this message of mine commit me to doing something that waits on a later time or on something that hasn\'t happened yet, like checks passing, a reply or a Mac waking ("I\'ll send it once the build passes", "next I\'ll merge once it\'s green", "I\'ll check back tonight")?'

/** What the mid model is told (promises.rs:89-93), its check a query as brain_query takes it. */
const INSTRUCTIONS = `You're keeping track of your promises. Below are things you said in your work with your person, each with when you said it and the work it's in. For each, list every commitment you made to do something later that the same message doesn't already do: "I'll send it once the build passes", "I'll check back tonight", "Next I'll fix the tests". Only what waits on a later time or on something that hasn't happened yet. Not what you're doing now or next in the same stretch of work ("Checking…", "Now writing…", "Committing that, then clearing…"), which that work does as it goes; not offers waiting on an answer ("want me to…?"); not what you said someone else will do; and not one already held in that work (listed under Already held: a promise of yours, or something the work expects itself, which may say what it does if that doesn't come about) for the same thing, however differently it's worded (a wake set for when the screenshots land holds "I'll review them once they land"). One listed as judged holds only what you said before it was judged; said again after that, it's a new promise. When this message changes one of your promises held there (a new time, a new condition), list it, with that promise's id as replaces, so the old one isn't judged beside it. But when the work expects that same thing itself, that holds it, changed or not: give that expectation's id as held_by (with your promise's id as replaces, when you held one for it too), and nothing new is written; your old promise is retired.

For each promise: what you'll do, in a sentence starting "I said I'd" (naming the thing, the person or the order, so it reads on its own); due_minutes, how long after you said it it's due (when you named a time, by then; when you said "next" or "once X", a fair guess at how long that takes; when you said nothing, 120); and check, when a query would show it done, else leave it out. A promise made on a condition ("if it hasn't replied by Tuesday, I'll call", "if the build fails, I'll fix it") says the condition in its statement, and its check is the query that shows whether the condition came about (their reply, the build's result), when one would, since nothing is owed when it doesn't. A check names the one thing it's about by its id (a card listed under Open asks, the pull request, the order) and finds nothing until that's done or has come about: never a query that what's there already answers too, like every ask the work has closed or every report it has written.

Reply with JSON only: {"promises": [{"message": "<the id of the message it's in>", "statement": "I said I'd …", "due_minutes": 120, "check": <a query, or leave it out>, "replaces": "<the id of your promise it changes, or leave it out>", "held_by": "<the id of what the work expects itself that holds it, or leave it out>"}]}, an empty list when there are none.`

/** How a check is written (promises.rs:239), as brain_query takes a query. */
const QUERIES = `Queries (for check): a query as brain_query takes it, naming what it's about by its id, like {"from": "items", "where": [{"field": "id", "op": "==", "value": "…"}, {"field": "status", "op": "!=", "value": "open"}], "fields": ["id", "status"]}, or one on the log, like {"where": [{"field": "type", "op": "==", "value": "…"}, {"field": "payload.data.entity", "op": "==", "value": "…"}, {"field": "payload.data.facts.state", "op": "==", "value": "merged"}]}.`

/**
 * What the promises kernel read, as Switchboard's `decided` records (ponder.rs:337-345,
 * promises.rs:254-257): each message's probability, and what it wrote. `through` is the last
 * message it read or let go, where it takes up again after a restart.
 */
export const ExpectationRead = defineEvent(
  "expectation.read",
  1,
  Schema.Struct({
    through: Schema.Number,
    messages: Schema.Array(Schema.Struct({ seq: Schema.Number, p: Schema.Number })),
    promises: Schema.Number,
    retired: Schema.Number,
    checksDropped: Schema.Number,
    cost: Schema.Number,
  }),
)

export const promisesConfig = { events: [ExpectationRead] }

/** A thing a turn said in its work, as the kernel reads it. */
export interface Said {
  readonly seq: number
  readonly time: number
  readonly space: SpaceId
  readonly thread: ThreadId
  readonly title: string
  readonly text: string
}

/** An expectation held in a work when what's read was said: still open, or judged since. */
export interface Held {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId
  readonly what: string
  /** Null for a watch, which has no time. */
  readonly by: number | null
  readonly setAt: number
  readonly judged: number | null
  /** A promise read from my words (promises.rs:169-173, `mine`), not what its work expects itself. */
  readonly mine: boolean
}

/** An item open in the user's queue, as the writer reads it. */
export interface Ask {
  readonly id: string
  readonly space: string
  readonly said: string
}

const parse: (json: string) => unknown = JSON.parse

/** The thread of the call that posted a message: the nearest brain post to its space (caller.ts). */
const poster = (db: Database, seq: number, space: string) =>
  db
    .query<{ seq: number; thread: string; name: string; input: string }, [number, number]>(
      `SELECT seq, json_extract(payload, '$.thread') AS thread, json_extract(payload, '$.name') AS name,
         json_extract(payload, '$.input') AS input
       FROM events WHERE type = 'turn.tool' AND seq > ? AND seq < ?`,
    )
    .all(seq - 400, seq + 400)
    .filter((r) => text(field(inputFor("brain_post", r.name, parse(r.input)), "space")) === space)
    .toSorted((a, b) => Math.abs(a.seq - seq) - Math.abs(b.seq - seq))
    .map((r) => ThreadId.make(r.thread))
    .at(0) ?? null

/**
 * The thread that said a message: its say's turn's, or a post's caller's; "reply" for a reply,
 * whose thread is its space's (`threadOf`, the caller's to say).
 */
const threadOfSaid = (db: Database, id: string, seq: number, space: string, turn: string) => {
  const by =
    turn === ""
      ? null
      : (db
          .query<{ thread: string }, [string]>("SELECT thread FROM turn_spans WHERE turn = ?")
          .get(turn)?.thread ?? null)
  if (by !== null) {
    return ThreadId.make(by)
  }
  return id.startsWith("reply:") ? "reply" : poster(db, seq, space)
}

const titleOf = (db: Database, thread: ThreadId, space: string) =>
  db.query<{ title: string }, [string]>("SELECT title FROM threads WHERE thread = ?").get(thread)
    ?.title ??
  db.query<{ name: string }, [string]>("SELECT name FROM spaces WHERE id = ?").get(space)?.name ??
  thread

/** A message `saidRead` read: a reply's thread and title are left for `saidAfter` to fill. */
interface SaidRead extends Omit<Said, "thread" | "title"> {
  readonly thread: ThreadId | "reply"
  readonly title: string | null
}

/** The agent's messages after `after`, as `saidAfter` takes them; `through` is the last one looked at. */
const saidRead = defineRead("autonomy/promises/said", (db, after: number) => {
  const rows = db
    .query<{ seq: number; id: string; time: number; payload: string }, [number]>(
      `SELECT seq, id, time, payload FROM events
       WHERE type = 'message.posted' AND source = 'agent' AND seq > ? ORDER BY seq`,
    )
    .all(after)
  const said = rows.flatMap((r): SaidRead[] => {
    const p = parse(r.payload)
    const space = text(field(p, "space"))
    const words = text(field(p, "text"))
    // A say carries its turn; a reply posted before say did, its id; a post, its call nearby.
    const thread = threadOfSaid(db, r.id, r.seq, space, text(field(p, "turn")))
    if (space === "" || words === "" || thread === null) {
      return []
    }
    return [
      {
        seq: r.seq,
        time: r.time,
        space: SpaceId.make(space),
        thread,
        title: thread === "reply" ? null : titleOf(db, thread, space),
        text: words,
      },
    ]
  })
  return { said, through: rows.at(-1)?.seq ?? after }
})

/** Each thread's title, else its space's name, else the thread. */
const titlesRead = defineRead(
  "autonomy/promises/titles",
  (db, of: readonly { readonly thread: ThreadId; readonly space: string }[]) =>
    of.map((o) => titleOf(db, o.thread, o.space)),
)

/**
 * The agent's messages after `after`, each with the work that said it: a turn's reply (chat.ts
 * posts it as `reply:<turn>`, from its space's thread), or a post a turn's call made. What no turn
 * said (the reflection's report, a failed push's line) isn't read, as Switchboard's kernel read
 * no monologue's or app's words (builtin.rs:341, `not_from`). `through` is the last one looked at.
 */
export const saidAfter = (after: number, threadOf: (space: SpaceId) => ThreadId) =>
  Effect.gen(function* reading() {
    const brain = yield* Brain
    const read = yield* brain.read(saidRead, after)
    const replies = [
      ...new Set(read.said.flatMap((m) => (m.thread === "reply" ? [m.space] : []))),
    ].map((space) => ({ thread: threadOf(space), space }))
    const titles = replies.length === 0 ? [] : yield* brain.read(titlesRead, replies)
    const of = new Map(
      replies.map((r, i) => [r.space, { thread: r.thread, title: titles[i] ?? "" }]),
    )
    const said = read.said.map((m): Said =>
      m.thread === "reply"
        ? { ...m, thread: threadOf(m.space), title: of.get(m.space)?.title ?? "" }
        : { ...m, thread: m.thread, title: m.title ?? "" },
    )
    return { said, through: read.through }
  })

interface HeldRow {
  readonly id: string
  readonly space: SpaceId
  readonly thread: ThreadId | null
  readonly what: string
  readonly by: number | null
  readonly status: string
  readonly set_at: number
  readonly closed_at: number | null
  readonly said: number | null
}

/** The expectations `heldIn` reads, as of `now`, for what was said from `from`. */
const heldRows = (db: Database, from: number, now: number) =>
  db
    .query<HeldRow, [number, number, number]>(
      `SELECT id, space, thread, what, by, status, set_at, closed_at, said FROM expectations
       WHERE set_at <= ? AND set_at > ? AND (closed_at IS NULL OR closed_at > ?) ORDER BY set_at`,
    )
    .all(now, now - HELD_FOR_MS, from)

/**
 * What `works` held, written down, when the first of what's read was said (`from`): my promises
 * there, and what each expects itself. Those still open, and those judged since `from`, which hold
 * what was said before they were judged: a message read late (a restart, a burst read again after
 * a failed call) mustn't promise again what's been kept since. One retired (dropped) is gone
 * (promises.rs:261-297, `held`). As of `now`, so a replay reads what was held then.
 */
export const heldIn = (
  rows: readonly HeldRow[],
  works: readonly ThreadId[],
  now: number,
  threadOf: (space: SpaceId) => ThreadId,
): Held[] =>
  rows.flatMap((r) => {
    const closed = r.closed_at !== null && r.closed_at <= now
    const thread = r.thread ?? threadOf(r.space)
    if ((closed && r.status === "dropped") || !works.includes(thread)) {
      return []
    }
    return [
      {
        id: r.id,
        space: r.space,
        thread,
        what: r.what,
        by: r.by,
        setAt: r.set_at,
        judged: closed ? r.closed_at : null,
        mine: r.said !== null,
      },
    ]
  })

/** What `spaces` have open in the user's queue, by id, so a check can name the card a promise waits on (promises.rs:196-206). */
export const asksIn = (db: Database, spaces: readonly string[], now: number): Ask[] =>
  db
    .query<Ask & { space: string }, [number, number]>(
      `SELECT id, space, trim(coalesce(json_extract(data, '$.title'), '') || ' ' ||
         coalesce(json_extract(data, '$.body'), '')) AS said
       FROM action_items WHERE opened_at <= ? AND (status = 'open' OR closed_at > ?) ORDER BY opened_at`,
    )
    .all(now, now)
    .filter((a) => spaces.includes(a.space))

/** When a promise made at `time` is due (promises.rs:134-137). */
const dueOf = (time: number, minutes: number | null) =>
  time + Math.min(Math.max(minutes ?? DEFAULT_DUE_MIN, 10), LATEST_DUE_MIN) * 60_000

/** The latest time a row of a query's answer carries, if any (promises.rs:184-194, `latest`). */
const latest = (row: unknown) => {
  const times = [row, field(row, "facts")].flatMap((fields) =>
    Object.entries(typeof fields === "object" && fields !== null ? fields : {}).flatMap(
      ([key, value]) =>
        (key === "at" || key === "time" || key.endsWith("_at")) && typeof value === "number"
          ? [value]
          : [],
    ),
  )
  return times.length === 0 ? null : Math.max(...times)
}

/**
 * Whether a check can show what it's for: it runs, and what it finds now isn't all from before I
 * said it, like an item its work closed earlier, which would read as done or come about from the
 * start (promises.rs:175-182, `shows`).
 */
export const shows = (found: Found | Rejected, said: number) =>
  "rows" in found &&
  (found.rows.length === 0 ||
    found.rows.some((row) => {
      const at = latest(row)
      return at === null || at >= said
    }))

const decodeQuery = Schema.decodeUnknownOption(Query)

class Unread extends Schema.TaggedError<Unread>()("Unread", { reason: Schema.String }) {}

interface Written {
  readonly events: readonly Incoming[]
  readonly promises: number
  readonly retired: number
  readonly checksDropped: number
  readonly cost: number
}

/**
 * How likely each message is to commit me to something later, from one decision per AT_ONCE,
 * its question asked of each record (ponder.rs:355-366, `probabilities`; bodies/promises.rs:127-132,
 * `read`).
 */
export const probabilities = (said: readonly Said[]) =>
  Effect.gen(function* deciding() {
    const models = yield* Models
    const stable = `${GUIDE}\n\nThe kernel: ${KERNEL}. Its question: ${QUESTION}`
    const ps: number[] = []
    let cost = 0
    for (let at = 0; at < said.length; at += AT_ONCE) {
      const chunk = said.slice(at, at + AT_ONCE)
      const item = chunk
        .map((m, i) => `Record ${i + 1}:\nIn "${m.title}", I said: ${oneLine(m.text, 2000)}`)
        .join("\n\n")
      const d = yield* models.decide(
        { stable, item },
        Object.fromEntries(
          chunk.map((_, i) => [
            `r${i}`,
            {
              instructions: `About record ${i + 1}: ${ASK}`,
              choices: [{ value: "yes" }, { value: "no" }],
              predicate: true,
            },
          ]),
        ),
      )
      cost += d.cost
      ps.push(...chunk.map((_, i) => d.answers[`r${i}`]?.probabilities.yes ?? 0))
    }
    return { ps, cost }
  })

/**
 * What was promised, written down by the mid model: each promise an expectation citing its
 * message, superseding the promise of mine held open in its work that it changes. One its work
 * holds itself (`held_by`) becomes nothing new, and retires the promise of mine it changes, if any
 * (promises.rs:139-167, 208-259). `check` runs a check as it would stand, after the message.
 */
export const promised = (
  said: readonly Said[],
  held: readonly Held[],
  asks: readonly Ask[],
  now: number,
  zone: string,
  check: (q: Query, after: number) => Effect.Effect<Found | Rejected>,
) =>
  Effect.gen(function* writing() {
    const models = yield* Models
    const lines = [
      `What you said:\n${said
        .map(
          (m) =>
            `- message ${m.seq} in "${m.title}" (${m.thread}), ${ago(m.time, now)}: ${oneLine(m.text, 2000)}\n`,
        )
        .join("")}`,
      held.length === 0
        ? ""
        : `\nAlready held (written down by the time you said it: your promises, and what the work expects itself):\n${held
            .map(
              (h) =>
                `- ${h.mine ? "your promise" : "the work expects itself"} ${h.id}, in ${h.thread}, ${ago(h.setAt, now)}, ${h.by === null ? "watching" : `due ${moment(h.by, zone)}`}${h.judged === null ? "" : `, judged ${moment(h.judged, zone)}`}: ${oneLine(h.what, 600)}\n`,
            )
            .join("")}`,
      asks.length === 0
        ? ""
        : `\nOpen asks (in your person's queue, by the work that asked):\n${asks
            .map((a) => `- ask ${a.id} in ${a.space}: ${oneLine(a.said, 300)}\n`)
            .join("")}`,
      `\n${QUERIES}\n`,
      `\nIt's now ${moment(now, zone)}.`,
    ]
    const input = lines.join("")
    const ids = new Set(said.map((m) => String(m.seq)))
    const problem = (reply: unknown) => {
      if (!Array.isArray(field(reply, "promises"))) {
        return "it has no promises list"
      }
      const bad = list(field(reply, "promises")).find(
        (p) =>
          !ids.has(String(field(p, "message"))) ||
          !text(field(p, "statement")).startsWith("I said I'd"),
      )
      return bad === undefined
        ? null
        : `${JSON.stringify(text(field(bad, "statement")))} names no listed message, or doesn't start "I said I'd"`
    }
    // A reply that doesn't pass goes back with the problem for one more try (monologue llm.rs:285-317).
    const first = yield* models.complete("gate", INSTRUCTIONS, input)
    let reply = jsonOf(first.text)
    let { cost } = first
    const wrong = problem(reply)
    if (wrong !== null) {
      const again = yield* models.complete(
        "gate",
        INSTRUCTIONS,
        `${input}\n\nYour last reply didn't pass: ${wrong}\nReply again in full, with that fixed.`,
      )
      reply = jsonOf(again.text)
      cost += again.cost
      const still = problem(reply)
      if (still !== null) {
        return yield* new Unread({ reason: `The reply didn't pass twice: ${still}` })
      }
    }
    const inWork = (id: string, ours: boolean, thread: ThreadId) =>
      held.find((h) => h.id === id && h.mine === ours && h.thread === thread)
    const events: Incoming[] = []
    let retired = 0
    let checksDropped = 0
    for (const p of list(field(reply, "promises"))) {
      const message = said.find((m) => String(m.seq) === String(field(p, "message")))
      if (message === undefined) {
        continue
      }
      const replaced = inWork(text(field(p, "replaces")), true, message.thread)
      const old = replaced?.judged === null ? replaced : undefined
      if (inWork(text(field(p, "held_by")), false, message.thread) !== undefined) {
        if (old !== undefined) {
          retired += 1
          events.push({
            id: EventId.make(crypto.randomUUID()),
            type: ExpectationDropped.type,
            source: "autonomy",
            payload: { id: old.id },
          })
        }
        continue
      }
      const given = Option.getOrNull(decodeQuery(field(p, "check")))
      const kept =
        given !== null && shows(yield* check(given, message.seq), message.time) ? given : null
      if (given !== null && kept === null) {
        checksDropped += 1
      }
      const minutes = field(p, "due_minutes")
      events.push({
        id: EventId.make(crypto.randomUUID()),
        type: ExpectationSet.type,
        source: "autonomy",
        payload: {
          id: old?.id ?? `p-${crypto.randomUUID().slice(0, 10)}`,
          space: message.space,
          thread: message.thread,
          what: text(field(p, "statement")),
          by: dueOf(message.time, typeof minutes === "number" ? minutes : null),
          otherwise: "",
          promise: true,
          said: message.seq,
          ...(kept !== null && { check: kept }),
        },
      })
    }
    return {
      events,
      promises: events.length - retired,
      retired,
      checksDropped,
      cost,
    } satisfies Written
  })

const head = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

/** Where it read to: its last read's `through`; the first time, from now, since what came before isn't news (ponder.rs:120-124, 220-235). */
const readToOf = (db: Database) => {
  const last = db
    .query<{ payload: string }, []>(
      "SELECT payload FROM events WHERE type = 'expectation.read' ORDER BY seq DESC LIMIT 1",
    )
    .get()
  const through = last ? field(parse(last.payload), "through") : null
  return typeof through === "number" ? through : head(db)
}

const pending = (db: Database, after: number) =>
  db
    .query(
      "SELECT 1 FROM events WHERE type = 'message.posted' AND source = 'agent' AND seq > ? LIMIT 1",
    )
    .get(after) !== null

const readToRead = defineRead("autonomy/promises/read-to", readToOf)

/** The expectations held from `from` as of `now`, and what `spaces` have open in the queue. */
const knownRead = defineRead(
  "autonomy/promises/known",
  (db, from: number, now: number, spaces: readonly string[]) => ({
    rows: heldRows(db, from, now),
    asks: asksIn(db, spaces, now),
  }),
)

/** Whether the agent said anything after `after`, and the head. */
const readyRead = defineRead("autonomy/promises/ready", (db, after: number) => ({
  any: pending(db, after),
  head: head(db),
}))

/**
 * The kernel at work: a burst of what turns said gathers two minutes from its first message, then
 * one decision reads it, what passes is written down, and where it read to is kept. A burst that
 * couldn't be read is tried again in five minutes, its messages let go once six hours old
 * (ponder.rs:115-207). It keeps what's owed, so no budget holds it back (ponder.rs:94-101, `owed`).
 */
export const promisesKernel = (config: { readonly threadOf: (space: SpaceId) => ThreadId }) =>
  Effect.gen(function* kernel() {
    const brain = yield* Brain
    let readTo = yield* brain.read(readToRead)
    let retrying = false

    const burst = Effect.gen(function* reading() {
      const now = Date.now()
      const zone = Temporal.Now.timeZoneId()
      const { said, through } = yield* saidAfter(readTo, config.threadOf)
      const fresh = said.filter((m) => m.time > now - GIVE_UP_MS)
      if (fresh.length === 0) {
        return through
      }
      const decided = yield* probabilities(fresh)
      const passed = fresh.filter((_, i) => (decided.ps[i] ?? 0) >= AT)
      const works = [...new Set(passed.map((m) => m.thread))]
      const from = Math.min(...passed.map((m) => m.time))
      const read = yield* brain.read(
        knownRead,
        from,
        now,
        passed.map((m) => m.space),
      )
      const known = { held: heldIn(read.rows, works, now, config.threadOf), asks: read.asks }
      const wrote =
        passed.length === 0
          ? null
          : yield* promised(passed, known.held, known.asks, now, zone, (q, after) =>
              Effect.match(brain.query(scoped(q, after)), {
                onFailure: (rejected): Found | Rejected => rejected,
                onSuccess: (found) => found,
              }),
            )
      yield* brain.ingest([
        ...(wrote?.events ?? []),
        {
          id: EventId.make(crypto.randomUUID()),
          type: ExpectationRead.type,
          source: "autonomy",
          payload: {
            through,
            messages: fresh.map((m, i) => ({
              seq: m.seq,
              p: Math.round((decided.ps[i] ?? 0) * 1000) / 1000,
            })),
            promises: wrote?.promises ?? 0,
            retired: wrote?.retired ?? 0,
            checksDropped: wrote?.checksDropped ?? 0,
            cost: decided.cost + (wrote?.cost ?? 0),
          },
        },
      ])
      return through
    })

    yield* Effect.forever(
      Effect.gen(function* pass() {
        const ready = yield* brain.read(readyRead, readTo)
        if (!ready.any) {
          yield* brain.changes(ready.head).pipe(
            Stream.filter((e) => e.type === MessagePosted.type && e.source === "agent"),
            Stream.take(1),
            Stream.runDrain,
          )
        }
        if (!retrying) {
          yield* Effect.sleep(BATCH_MS)
        }
        const read = yield* Effect.exit(burst)
        retrying = Exit.isFailure(read)
        if (Exit.isSuccess(read)) {
          readTo = read.value
        } else {
          yield* Effect.logWarning(
            "The promises kernel couldn't read what was said; trying again soon",
            Cause.pretty(read.cause),
          )
          yield* Effect.sleep(RETRY_MS)
        }
      }),
    )
  })
