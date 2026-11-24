// What reaches the user unasked, old Switchboard's way (its docs §Notifications): a new item in
// their queue; a reply, or a finished task's report, still unread a few minutes on (the user's
// `notify.after` dial; its space's read mark short of it) with nothing of theirs since; and an
// activity they follow ending or failing, once each way. Their rules and preferences may hold an
// item, reply or report back ("normal replies don't push"): each is read against them first. An
// app's own notification (a Switchboard appendage's notification record, like a printer stopped on
// a problem) and a followed activity's end go as they did there, unread by any model. It goes to
// where they are (presence.ts): the Mac they're at, through its desktop extension, which holds it
// back while that space is in front; else their iPhones; else the Mac they used last.
//
// What waits to go is kept in the brain as due times (`notify.queued`, `notify.ready`,
// `notify.done`), so a deploy inside a reply's few minutes, or a burst's seconds, loses no push.
import type { Database } from "bun:sqlite"
import { dialNumber, rulesAt } from "@switch/autonomy"
import {
  Brain,
  defineEvent,
  EventId,
  HOME,
  on,
  PEER,
  react,
  readThrough,
  SpaceId,
} from "@switch/brain"
import type { Incoming, Projection, StoredEvent } from "@switch/brain"
import { Activity, Gateway } from "@switch/gateway"
import type { Note } from "@switch/gateway"
import { Models } from "@switch/models"
import type { Question } from "@switch/models"
import { Effect, Layer, Option, Schema } from "effect"

import { spaceAbout } from "./asks.ts"
import { threadOf } from "./context.ts"
import { here, macs } from "./presence.ts"
import { pushFailed, pushWorks } from "./trouble.ts"

const CLIP = 240

const NoteSchema = Schema.Struct({
  kind: Schema.Literals(["item", "reply", "report", "alert"]),
  space: SpaceId,
  title: Schema.String,
  body: Schema.String,
  item: Schema.optionalKey(Schema.String),
  seq: Schema.optionalKey(Schema.Number),
  urgent: Schema.optionalKey(Schema.Boolean),
  itemKind: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  portal: Schema.optionalKey(Schema.Boolean),
})

/**
 * News to tell the user, due at `due`: a reply once it's still unread then (a newer reply in the
 * space stands for it, due when the first was), anything else at once. `since`: what of the user's
 * after it means they've seen it. `direct`: it goes as it is, unread by their rules and in no burst.
 */
export const NotifyQueued = defineEvent(
  "notify.queued",
  1,
  Schema.Struct({
    key: Schema.String,
    note: NoteSchema,
    due: Schema.Number,
    since: Schema.Number,
    direct: Schema.optionalKey(Schema.Boolean),
  }),
)

/** It passed its checks and joined the burst at `at`. */
export const NotifyReady = defineEvent(
  "notify.ready",
  1,
  Schema.Struct({ key: Schema.String, at: Schema.Number }),
)

/** It went, or was held back or read: it's no longer waiting. */
export const NotifyDone = defineEvent("notify.done", 1, Schema.Struct({ key: Schema.String }))

const notifyQueue: Projection = {
  name: "notify_queue",
  version: 1,
  tables: ["notify_queue"],
  create: `CREATE TABLE notify_queue (key TEXT PRIMARY KEY, kind TEXT NOT NULL, space TEXT NOT NULL,
    note TEXT NOT NULL, due INTEGER NOT NULL, since INTEGER NOT NULL, direct INTEGER NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0);`,
  on: [
    on(NotifyQueued, (db, p) => {
      db.query(
        `INSERT INTO notify_queue (key, kind, space, note, due, since, direct) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET note = excluded.note WHERE ready = 0`,
      ).run(
        p.key,
        p.note.kind,
        p.note.space,
        JSON.stringify(p.note),
        p.due,
        p.since,
        p.direct === true ? 1 : 0,
      )
    }),
    on(NotifyReady, (db, p) => {
      db.query("UPDATE notify_queue SET ready = 1, due = ? WHERE key = ?").run(p.at, p.key)
    }),
    on(NotifyDone, (db, p) => {
      db.query("DELETE FROM notify_queue WHERE key = ?").run(p.key)
    }),
  ],
  snapshot: () => null,
}

export const notifyConfig = {
  events: [NotifyQueued, NotifyReady, NotifyDone],
  projections: [notifyQueue],
  commands: [],
}

interface Queued {
  readonly key: string
  readonly note: Note
  readonly due: number
  readonly since: number
  readonly direct: boolean
  readonly ready: boolean
}

const decodeNote = Schema.decodeUnknownSync(Schema.fromJsonString(NoteSchema))

const done = (key: string): Incoming => ({
  id: EventId.make(`notify-done:${key}`),
  type: NotifyDone.type,
  source: "core",
  payload: { key },
})

const queued = (db: Database): Queued[] =>
  db
    .query<
      { key: string; note: string; due: number; since: number; direct: number; ready: number },
      []
    >("SELECT key, note, due, since, direct, ready FROM notify_queue ORDER BY due")
    .all()
    .map((r) => ({
      key: r.key,
      note: decodeNote(r.note),
      due: r.due,
      since: r.since,
      direct: r.direct === 1,
      ready: r.ready === 1,
    }))

/** The space's reply still waiting to be due, which a newer one stands in for. */
const replyWaiting = (db: Database, space: string) =>
  db
    .query<{ key: string }, [string]>(
      "SELECT key FROM notify_queue WHERE space = ? AND kind IN ('reply', 'report') AND ready = 0",
    )
    .get(space)?.key ?? null

// Each kind is asked about on its own: read together, a rule about replies held items back too.
const STABLE = {
  reply:
    "Switch, the user's agent, just replied in one of their chats, and they haven't read it. You decide whether the reply also notifies them now, or waits in the chat until they next look. Their rules and preferences decide; when none speaks to it, it notifies.",
  item: "Switch, the user's agent, just put an action item in their queue: something for them to do or decide. You decide whether the item also notifies them now, or waits until they next look. Their rules and preferences decide; when none speaks to it, it notifies.",
  report:
    "Switch, the user's agent, just said a finished task's report in one of their chats, and they haven't read it. You decide whether the report also notifies them now, or waits in the chat until they next look. Their rules and preferences decide; when none speaks to it, it notifies.",
}
const WHAT = { reply: "unread reply", item: "new action item", report: "task's report" }

/** What the user's rules are read against. */
const saidOf = (n: Note) => {
  if (n.kind === "item") {
    return `The item: ${n.title}\n${n.body}`
  }
  if (n.kind === "report") {
    return `The task: ${n.title}\n${n.body}`
  }
  return `The reply: ${n.body}`
}

const push = (what: string): Question => ({
  instructions: `By the user's rules and preferences, should this ${what} notify them now?`,
  choices: [
    { value: "push", description: "Notify: their rules call for this kind, or none speaks to it." },
    { value: "hold", description: "Wait: their rules say this kind shouldn't notify them." },
  ],
})

const Opened = Schema.Struct({
  id: Schema.String,
  space: SpaceId,
  title: Schema.String,
  body: Schema.String,
  urgent: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(Schema.String),
  options: Schema.optionalKey(Schema.Array(Schema.String)),
  notify: Schema.optionalKey(Schema.Boolean),
  portal: Schema.optionalKey(Schema.Unknown),
})
const Posted = Schema.Struct({
  space: SpaceId,
  text: Schema.String,
  /** A turn's reply to the user's words has its turn; what the brain's post tool said has none. */
  turn: Schema.optionalKey(Schema.String),
  widget: Schema.optionalKey(Schema.Unknown),
})
// A Switchboard appendage's notification record, as its shim carries it (switch-ext-kit/shim).
const Alerted = Schema.Struct({
  kind: Schema.Literal("notification"),
  stream: Schema.Literal("notifications"),
  data: Schema.Struct({
    title: Schema.optionalKey(Schema.String),
    summary: Schema.optionalKey(Schema.String),
    text: Schema.String,
  }),
  about: Schema.optionalKey(Schema.Array(Schema.String)),
})
const decodeOpened = Schema.decodeUnknownOption(Opened)
const decodePosted = Schema.decodeUnknownOption(Posted)
const decodeAlerted = Schema.decodeUnknownOption(Alerted)
/** An extension's alert; what came over from Switchboard's own log it delivered there. */
const alertOf = (e: StoredEvent) =>
  e.source.startsWith("sb:") ? null : Option.getOrNull(decodeAlerted(e.payload))

const Shown = Schema.Struct({ shown: Schema.Boolean })
const decodeShown = Schema.decodeUnknownOption(Shown)
const decodeActivity = Schema.decodeUnknownOption(Activity.payload)

/**
 * The title of the finished task's report a line said in a space's chat, if it said one
 * (Switchboard's report: claude turn.rs `report`, monologue notify.rs `holds`): a task the space's
 * own thread started, a conversation of theirs (a task's report to the task that started it
 * isn't), that finished or failed since the chat's line before `seq`. A usage limit isn't an end:
 * the task carries on. A quiet report is one nothing said in their chat: it stays with the task and
 * the work that started it. Titled as there (notify.rs:424, 458): the task's own, "I didn't
 * finish" when it failed, a count for several.
 */
const reportIn = (db: Database, space: SpaceId, seq: number) => {
  const ended = db
    .query<{ title: string; status: string }, [string, string, number]>(
      `SELECT json_extract(payload, '$.title') AS title, json_extract(payload, '$.status') AS status
       FROM events WHERE type = 'task.ended' AND id NOT LIKE 'sb:%'
         AND json_extract(payload, '$.parent') = ?1
         AND json_extract(payload, '$.status') IN ('done', 'failed')
         AND seq > (SELECT coalesce(max(seq), 0) FROM messages WHERE space = ?2 AND seq < ?3)`,
    )
    .all(threadOf(space), space, seq)
  const [one] = ended
  if (one === undefined) {
    return null
  }
  if (ended.length > 1) {
    return `${ended.length} tasks reported`
  }
  return one.status === "failed" ? `${one.title}: I didn't finish` : one.title
}

/**
 * The end of an activity they've already heard of since it last ran: its last followed done or
 * failed before `seq` (Switchboard's `Told`, which it kept beside its cursor; here the log keeps
 * it, across restarts too).
 */
const toldOf = (db: Database, id: string, seq: number) =>
  db
    .query<{ state: string }, [string, number]>(
      `SELECT json_extract(payload, '$.state') AS state FROM events
       WHERE type = 'iphone.activity' AND json_extract(payload, '$.id') = ?1 AND seq < ?2
         AND json_extract(payload, '$.follow') = 1
         AND json_extract(payload, '$.state') IN ('done', 'failed')
         AND seq > (SELECT coalesce(max(seq), 0) FROM events WHERE type = 'iphone.activity'
           AND json_extract(payload, '$.id') = ?1 AND seq < ?2
           AND json_extract(payload, '$.state') = 'running')
       ORDER BY seq DESC LIMIT 1`,
    )
    .get(id, seq)?.state ?? null

/**
 * Something of the user's in Switchboard since `seq`: a message of theirs, or something read on any
 * device (a space's read mark), as Switchboard asked its log (monologue/src/notify.rs:266-272: their
 * messages and `seen` records). An app opening or a screen shown isn't: a desktop app relaunching
 * after a deploy would be "theirs".
 */
const touched = (db: Database, seq: number) =>
  db
    .query(
      `SELECT seq FROM events WHERE seq > ? AND (
         (type = 'message.posted' AND source NOT IN ('agent', 'peer')) OR type = 'space.read')
       LIMIT 1`,
    )
    .get(seq) !== null

/** Whether the last words before `seq` in a space that weren't the agent's are a peer's. */
const answersPeer = (db: Database, space: string, seq: number) =>
  db
    .query<{ source: string }, [string, number]>(
      "SELECT source FROM messages WHERE space = ? AND seq < ? AND source != 'agent' ORDER BY seq DESC LIMIT 1",
    )
    .get(space, seq)?.source === PEER

const clipTo = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const clip = (s: string) => clipTo(s, CLIP)

const spaceName = (db: Database, id: string) =>
  db.query<{ name: string }, [string]>("SELECT name FROM spaces WHERE id = ?").get(id)?.name ??
  "Home"

const SETTLE_MS = 5000
const LONGEST_MS = 20_000

const counted = (n: number, one: string, many: string) => {
  if (n === 0) {
    return null
  }
  return n === 1 ? one : many.replace("#", String(n))
}

const lineOfNote = (n: Note) => {
  if (n.kind === "item") {
    return n.title
  }
  return n.kind === "reply" ? n.body : `${n.title}: ${n.body}`
}

const capital = (s: string) => `${s.slice(0, 1).toUpperCase()}${s.slice(1)}`

/**
 * A burst's news as one notification (notify.rs:445-491): what came, counted; each one's line; and
 * one space's replies and reports open it, anything else Home, where the queue is.
 */
const together = (news: readonly Note[]): Note => {
  const of = (kind: Note["kind"]) => news.filter((n) => n.kind === kind).length
  const parts = [
    counted(of("item"), "1 thing in your queue", "# things in your queue"),
    counted(of("report"), "a task reported", "# tasks reported"),
    counted(of("reply"), "an answer came", "# answers came"),
    counted(of("alert"), "something you follow ended", "# things you follow ended"),
  ].filter((p): p is string => p !== null)
  const last = parts.at(-1) ?? ""
  const title = capital(parts.length > 1 ? `${parts.slice(0, -1).join(", ")}, and ${last}` : last)
  const worked = news.filter((n) => n.kind === "reply" || n.kind === "report")
  const [first] = worked
  const one =
    first !== undefined &&
    worked.length === news.length &&
    worked.every((n) => n.space === first.space)
  return {
    kind: "reply",
    space: one ? first.space : HOME,
    title,
    body: clip(news.map((n) => clipTo(lineOfNote(n), 70)).join(" · ")),
  }
}

export interface Phone {
  readonly alert: (
    n: Note,
  ) => Effect.Effect<{ readonly sent: number; readonly reason: string }, never, Brain>
  readonly reachable: Effect.Effect<boolean, never, Brain>
}

export const notifier = (phone: Phone) =>
  Layer.effectDiscard(
    Effect.gen(function* notifying() {
      const brain = yield* Brain
      const gateway = yield* Gateway
      const models = yield* Models

      /** Whether the user's rules let it notify: yes when they have none, or the call fails. */
      const wanted = (n: Note) =>
        Effect.gen(function* reading() {
          const kind = n.kind === "item" || n.kind === "report" ? n.kind : "reply"
          const said = saidOf(n)
          const rules = yield* brain.read((db) => rulesAt(db, [n.space], said))
          if (rules === "") {
            return true
          }
          const d = yield* models.decide(
            { stable: STABLE[kind], item: `${rules}\n\n${said}` },
            { push: push(WHAT[kind]) },
          )
          return (d.answers.push?.probabilities.hold ?? 0) < 0.5
        }).pipe(Effect.orElseSucceed(() => true))

      /** Through the desktop extension on `machine`: true if it took it, shown or held back. */
      const onMac = (machine: string, n: Note) =>
        Effect.gen(function* mac() {
          const name = yield* brain.read((db) => spaceName(db, n.space))
          const result = yield* Effect.tryPromise(
            async () =>
              await gateway.call(`desktop-${machine}_notify`, {
                title: n.kind === "reply" ? name : n.title,
                body: n.body,
                ...(n.kind !== "reply" && { subtitle: name }),
                space: n.space,
                ...(n.item !== undefined && { item: n.item }),
              }),
          ).pipe(Effect.option)
          return Option.match(result, {
            onNone: () => false,
            onSome: (r) => r.isError !== true && Option.isSome(decodeShown(r.structuredContent)),
          })
        })

      /** Where they are: the Mac they're at, else their iPhones, else the Mac they used last. */
      const send = (n: Note) =>
        Effect.gen(function* sending() {
          const now = Date.now()
          const at = yield* brain.read((db) => here(db, now))
          if (at !== null && (yield* onMac(at.machine, n))) {
            return
          }
          // An urgent item has a deadline: its push is tried even to no phone, and a miss goes to
          // the agent (trouble.ts) before the last Mac is tried. What it was about stays in the queue.
          if (n.urgent === true) {
            const pushed = yield* phone.alert(n)
            if (pushed.sent > 0) {
              yield* pushWorks
              return
            }
            yield* pushFailed(n.space, clipTo(lineOfNote(n), 70), pushed.reason)
          } else if (yield* phone.reachable) {
            const pushed = yield* phone.alert(n)
            yield* pushed.sent > 0
              ? pushWorks
              : pushFailed(n.space, clipTo(lineOfNote(n), 70), pushed.reason)
            return
          }
          const [last] = yield* brain.read((db) => macs(db, now))
          if (last !== undefined && last.machine !== at?.machine) {
            yield* onMac(last.machine, n)
          }
        }).pipe(Effect.ignore({ log: "Warn", message: "A notification didn't go out" }))

      const record = (events: readonly Incoming[]) => Effect.orDie(brain.ingest(events))

      // News waits in the record from the event that brought it, by a key derived from it.
      const queue = (e: StoredEvent, note: Note, due: number, direct = false, key = `${e.seq}`) =>
        record([
          {
            id: EventId.make(`notify:${String(e.seq)}`),
            type: NotifyQueued.type,
            source: "core",
            payload: { key, note, due, since: e.seq, ...(direct && { direct: true }) },
          },
        ])

      // Once due: a reply read meanwhile, or one their rules hold back, is done; an urgent item or
      // an app's own alert goes at once; the rest joins the burst.
      const check = (q: Queued) =>
        Effect.gen(function* checking() {
          const n = q.note
          if (n.kind === "reply" || n.kind === "report") {
            const read = yield* brain.read(
              (db) => readThrough(db, n.space) >= (n.seq ?? 0) || touched(db, q.since),
            )
            if (read) {
              yield* record([done(q.key)])
              return
            }
          }
          if (!q.direct && n.kind !== "alert" && !(yield* wanted(n))) {
            yield* record([done(q.key)])
            return
          }
          if (q.direct || n.urgent === true) {
            yield* send(n)
            yield* record([done(q.key)])
            return
          }
          yield* record([
            {
              id: EventId.make(`notify-ready:${q.key}`),
              type: NotifyReady.type,
              source: "core",
              payload: { key: q.key, at: Date.now() },
            },
          ])
        })

      // A burst comes as one: what joins within 5 s of the last waits for the rest, 20 s at the
      // most (monologue/src/notify.rs:41-44, 135-176), by the times each joined.
      const flush = (ready: readonly Queued[]) =>
        Effect.gen(function* flushing() {
          const now = Date.now()
          const first = Math.min(...ready.map((q) => q.due))
          const last = Math.max(...ready.map((q) => q.due))
          if (ready.length === 0 || now < Math.min(last + SETTLE_MS, first + LONGEST_MS)) {
            return
          }
          const news = ready.map((q) => q.note)
          const [only] = news
          yield* send(news.length === 1 && only !== undefined ? only : together(news))
          yield* record(ready.map((q) => done(q.key)))
        })

      yield* Effect.forkScoped(
        Effect.forever(
          Effect.gen(function* ticking() {
            yield* Effect.sleep("1 second")
            const now = Date.now()
            const all = yield* brain.read(queued)
            yield* Effect.forEach(
              all.filter((q) => !q.ready && q.due <= now),
              (q) => Effect.ignore(check(q), { log: "Warn" }),
              { concurrency: "unbounded", discard: true },
            )
            yield* flush(all.filter((q) => q.ready))
          }).pipe(Effect.ignore({ log: "Warn", message: "Notifications" })),
        ),
      )

      // An activity they follow ending or failing, once each way until it runs again
      // (Switchboard's monologue notify.rs `holds`, `runs_again`, `settle`): a click opens its space.
      const ended = (e: StoredEvent) =>
        Effect.gen(function* ending() {
          const a = Option.getOrNull(decodeActivity(e.payload))
          if (a?.follow !== true || (a.state !== "done" && a.state !== "failed")) {
            return
          }
          const told = yield* brain.read((db) => toldOf(db, a.id, e.seq))
          if (told === a.state) {
            return
          }
          yield* queue(
            e,
            {
              kind: "alert",
              space: a.space,
              title: a.state === "failed" ? `${a.title}: failed` : a.title,
              body: clip(a.line ?? ""),
            },
            Date.now(),
          )
        })

      const one = (e: StoredEvent) =>
        Effect.gen(function* handling() {
          const alerted = alertOf(e)
          if (alerted !== null) {
            const space = yield* brain.read((db) => spaceAbout(db, alerted.about ?? []))
            const { data } = alerted
            // An app's own notification goes as `sb notify` sent it, at once.
            yield* queue(
              e,
              {
                kind: "alert",
                space,
                title: data.title ?? data.summary ?? "",
                body: clip(data.text),
              },
              Date.now(),
              true,
            )
            return
          }
          // A reopened item is back as it was, quietly (Switchboard's revive: notify false).
          if (e.type === "item.opened") {
            const item = Option.getOrNull(decodeOpened(e.payload))
            // `notify: false` asks for none.
            if (item !== null && item.notify !== false) {
              yield* queue(
                e,
                {
                  kind: "item",
                  space: item.space,
                  title: item.title,
                  body: item.body,
                  item: item.id,
                  ...(item.urgent === true && { urgent: true }),
                  ...(item.kind !== undefined && { itemKind: item.kind }),
                  ...(item.options !== undefined && { options: item.options }),
                  // Its notification opens its live view (Switchboard's portal asks).
                  ...(item.portal !== undefined && { portal: true }),
                },
                Date.now(),
              )
            }
            return
          }
          if (e.type === Activity.type) {
            yield* ended(e)
            return
          }
          const posted = Option.getOrNull(decodePosted(e.payload))
          if (posted !== null && e.source === "agent" && posted.widget === undefined) {
            yield* replied(e, posted)
          }
        })

      const replied = (e: StoredEvent, posted: typeof Posted.Type) =>
        Effect.gen(function* replying() {
          const { space } = posted
          // A reply is news only when it answers their words: a turn's step that did has its turn
          // (notify.rs:262-266, 277-280). What the post tool said is news only as a task's report,
          // said once a task the space's thread started finished (notify.rs:212-227, 422-430).
          const report =
            posted.turn === undefined ? yield* brain.read((db) => reportIn(db, space, e.seq)) : null
          if (posted.turn === undefined && report === null) {
            return
          }
          // An answer to another agent is between agents: what needs the user from it goes in their
          // queue.
          if (yield* brain.read((db) => answersPeer(db, space, e.seq))) {
            return
          }
          // A reply waiting to be read, by space: a newer one stands for the one before it
          // (notify.rs:178-185 `replaces`), due when the first was.
          const { minutes, waiting } = yield* brain.read((db) => ({
            minutes: dialNumber(db, "notify.after"),
            waiting: replyWaiting(db, space),
          }))
          yield* queue(
            e,
            {
              kind: report === null ? "reply" : "report",
              space,
              title: report ?? "",
              body: clip(posted.text),
              seq: e.seq,
            },
            e.time + minutes * 60_000,
            false,
            waiting ?? String(e.seq),
          )
        })

      // From its cursor: what came as the core stopped is queued once it's back.
      yield* Effect.forkScoped(
        react(
          "notify",
          (e) =>
            e.type === "item.opened" ||
            e.type === "message.posted" ||
            e.type === Activity.type ||
            alertOf(e) !== null,
          one,
        ),
      )
    }),
  )
