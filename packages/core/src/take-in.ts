// A space made under another takes in what bears on it, as Switchboard's did (sb-monologue
// drafts.rs `adopt`: "it takes in the conversations already about it ... from its parent's
// conversation"), and as the user put it, Nov 19: "when you create a workspace, previous relevant
// things go into that thread automatically ... those previous events exist in that thread already".
// The profile's turn model reads its parent's chat a stretch at a time, in order and with what came
// just before, and says which lines are about the new space's own subject (its person, their job,
// their project), so a vague follow-up goes with its conversation and a shared topic word doesn't
// pull a line in; then the same of its work, open items, expectations and widgets. It runs once per
// space, so it's the strong model: the tagger's decision model, asked line by line, took what only
// shared a word with a space's description (a space about an eBay shop took every eBay search).
// What's in moves by the brain's own moves (`message.moved`, a retag, `item.revise`,
// `expectation.set`, `widget.place`), leaving nothing behind; a line mainly about something else
// that reports on the new space's subject stays and shows there too, as a mention.
import type { Database } from "bun:sqlite"
import {
  Expect,
  fieldsOf,
  getExpectation,
  getItem,
  items,
  openExpectations,
  ReviseItem,
  rulesAt,
} from "@switch/autonomy"
import type { Expectation } from "@switch/autonomy"
import {
  allSpaces,
  Brain,
  cursorOf,
  EventId,
  MessageMoved,
  passed,
  PlaceWidget,
  placements,
  react,
  retagged,
  SpaceCreated,
  ThreadId,
  PEER,
} from "@switch/brain"
import type { Line, Rejected, SpaceId, StoredEvent } from "@switch/brain"
import { Models } from "@switch/models"
import { Effect, Layer, Option, Schema } from "effect"

import { line } from "./context.ts"

interface EventRow {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

const parse: (json: string) => unknown = JSON.parse
const stored = (r: EventRow): StoredEvent => ({ ...r, payload: parse(r.payload) })

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)

const eventAt = (db: Database, seq: number) => {
  const row = db.query<EventRow, [number]>("SELECT * FROM events WHERE seq = ?").get(seq)
  return row ? stored(row) : null
}

const when = (time: number) =>
  new Date(time).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })

/** One thing the parent holds: how the judge reads it, by `key`, and how it moves. */
export type Held = {
  readonly key: string
  readonly text: string
  readonly event: StoredEvent
  readonly line: Line
} & (
  | { readonly kind: "message" | "event" | "work" }
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "expectation"; readonly id: string }
  | { readonly kind: "widget"; readonly id: string; readonly app: string; readonly name: string }
)

/** Its chat, oldest first: what was said there and the other events shown in it. */
export const chatIn = (db: Database, parent: SpaceId): Held[] => {
  const said = db
    .query<{ seq: number; source: string; text: string }, [SpaceId]>(
      "SELECT seq, source, text FROM messages WHERE space = ? ORDER BY seq",
    )
    .all(parent)
    .flatMap((m) => {
      const event = eventAt(db, m.seq)
      const l = event === null ? null : line(event)
      if (event === null || l === null) {
        return []
      }
      const who = m.source === "agent" ? "Switch" : "User"
      const words = m.text.trim() === "" || m.source === PEER ? l.text : `${who}: ${m.text}`
      const text = `(${when(event.time)}) ${clip(words, 600)}`
      return [{ key: String(m.seq), text, event, line: l, kind: "message" as const }]
    })
  const shown = db
    .query<{ seq: number; note: string }, [SpaceId]>(
      "SELECT seq, note FROM chat_events WHERE space = ? ORDER BY seq",
    )
    .all(parent)
    .flatMap((r) => {
      const event = eventAt(db, r.seq)
      if (event === null) {
        return []
      }
      const text = `(${when(event.time)}) Event: ${clip(r.note, 400)}`
      const l = line(event) ?? { text: r.note }
      return [{ key: String(r.seq), text, event, line: l, kind: "event" as const }]
    })
  return [...said, ...shown].toSorted((a, b) => a.event.seq - b.event.seq)
}

const decodeText = Schema.decodeUnknownOption(Schema.Struct({ text: Schema.String }))
const taskText = (payload: unknown) => Option.getOrNull(decodeText(payload))?.text ?? ""

/**
 * Its work: each task filed in it, or started from its chat and filed nowhere, by what it was asked
 * and what it came to. A task's own tasks go with it unless they're filed somewhere themselves.
 */
export const workIn = (db: Database, parent: SpaceId): Held[] =>
  db
    .query<{ thread: string; title: string; result: string; opened: number }, [SpaceId, string]>(
      `SELECT t.thread, t.title, t.result, s.opened FROM threads t JOIN thread_spaces s ON s.thread = t.thread
       WHERE t.thread NOT LIKE 'space:%' AND (s.home = ?1 OR (s.home IS NULL AND t.parent = ?2))`,
    )
    .all(parent, `space:${parent}`)
    .flatMap((t) => {
      const event = eventAt(db, t.opened)
      if (event === null) {
        return []
      }
      const first = db
        .query<{ first: number }, [string]>(
          "SELECT first FROM turn_spans WHERE thread = ? ORDER BY first LIMIT 1",
        )
        .get(t.thread)
      const asked = first === null ? "" : taskText(eventAt(db, first.first)?.payload)
      const text = [
        `Task "${t.title}"`,
        asked === "" ? "" : `asked: ${clip(asked, 600)}`,
        t.result.trim() === "" ? "" : `came to: ${clip(t.result, 300)}`,
      ]
        .filter((s) => s !== "")
        .join("; ")
      return [{ key: t.thread, text, event, line: { text }, kind: "work" as const }]
    })

/** The event a thing was made by. */
const madeBy = (db: Database, type: string, id: string) => {
  const row = db
    .query<EventRow, [string, string]>(
      "SELECT * FROM events WHERE type = ? AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(type, id)
  return row ? stored(row) : null
}

/** Its open items, open expectations and placed widgets. */
export const restIn = (db: Database, parent: SpaceId, made: StoredEvent): Held[] => {
  const asks = items(db, { space: parent, status: "open" }).flatMap((i) => {
    const event = madeBy(db, "item.opened", i.id)
    const text = `Action item "${i.title}": ${clip(i.body, 500)}`
    return event === null
      ? []
      : [{ key: i.id, text, event, line: { text }, kind: "item" as const, id: i.id }]
  })
  const expected = openExpectations(db, [parent]).flatMap((x) => {
    const event = madeBy(db, "expectation.set", x.id)
    const text = `Expectation: ${clip(x.what, 500)}`
    return event === null
      ? []
      : [{ key: x.id, text, event, line: { text }, kind: "expectation" as const, id: x.id }]
  })
  const widgets = placements(db)
    .filter((w) => w.space === parent)
    .map((w) => {
      const text = `Widget ${w.id} ${JSON.stringify(w.input ?? {})}`
      const key = w.id
      return { key, text, event: made, line: { text }, kind: "widget" as const, ...w }
    })
  return [...asks, ...expected, ...widgets]
}

/** The new space and the others beside it, as the judge reads them. */
export interface Subject {
  readonly id: SpaceId
  readonly name: string
  readonly about: string
  readonly parent: SpaceId
  /** The other spaces in the parent and inside it, by name and what each is for. */
  readonly others: readonly string[]
  /** The user's rules for the new space and its parent. */
  readonly rules: string
}

export const subjectOf = (db: Database, id: SpaceId, parent: SpaceId): Subject => {
  const all = allSpaces(db).filter((s) => !s.archived)
  const s = all.find((x) => x.id === id)
  const name = s?.name ?? id
  const about = s?.about ?? ""
  const others = all
    .filter((x) => x.id !== id && (x.id === parent || x.parent === parent))
    .map((x) => `- ${x.name}${x.about === "" ? "" : `: ${x.about}`}`)
  return { id, name, about, parent, others, rules: rulesAt(db, [id, parent], `${name} ${about}`) }
}

export const SYSTEM =
  "You file things for Switch, the user's personal agent. The user just made a new space inside " +
  "another one, and everything already in the parent that is about the new space's subject moves " +
  "into it. You read what the parent holds and say which of it is about that subject.\n\n" +
  "A thing is the new space's when it's about the space's own subject: the person, company, job, " +
  "order or project the space is for, or part of a conversation that is. Judge a line by the " +
  'conversation it\'s in: a short follow-up ("ok", "what about the other one?") or the agent\'s ' +
  "reply belongs with the exchange it continues. Sharing a topic, a site, a marketplace, a tool, " +
  "a material or a word with the space's description is not enough: a space about someone's eBay " +
  "shop doesn't take every eBay search, and a space about one customer doesn't take another " +
  "customer's order. When a thing is mainly about something else but reports on or changes the " +
  "new space's subject (a list of several customers' follow-ups that includes them), it's `also`: " +
  "it stays and shows in both. Everything else stays where it is, which is the usual case.\n\n" +
  'Answer with JSON only: {"in": [keys], "also": [keys]}, keys as given, empty lists when none.'

/** The prompt for one stretch: what came before it for context, then the things to decide by key. */
export const promptOf = (s: Subject, before: readonly Held[], these: readonly Held[]) =>
  [
    `The new space: ${s.name}.${s.about === "" ? "" : ` ${s.about}`}`,
    s.others.length > 0 ? `The other spaces here:\n${s.others.join("\n")}` : "",
    s.rules,
    before.length > 0
      ? `Just before, for context only:\n${before.map((h) => h.text).join("\n")}`
      : "",
    `Decide each of these by its key:\n${these.map((h) => `[${h.key}] ${h.text}`).join("\n")}`,
  ]
    .filter((p) => p !== "")
    .join("\n\n")

const Verdict = Schema.Struct({
  in: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  also: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
})
const decodeVerdict = Schema.decodeUnknownOption(Schema.fromJsonString(Verdict))

/** What the judge said: the keys that are the new space's, and those that show in both. */
export const verdictOf = (reply: string) => {
  const json = /\{[\s\S]*\}/u.exec(reply)?.[0] ?? "{}"
  const v = Option.getOrNull(decodeVerdict(json))
  return {
    in: new Set((v?.in ?? []).map(String)),
    also: new Set((v?.also ?? []).map(String)),
  }
}

/** Lines a stretch of the chat holds, and how many before it it's read with. */
export const STRETCH = 60
export const CONTEXT = 15
/** Tasks, items and the rest, decided together this many at a time. */
export const BATCH = 30

/** The chat cut into stretches, each with the lines just before it. */
export const stretches = (chat: readonly Held[]) =>
  Array.from({ length: Math.ceil(chat.length / STRETCH) }, (_, i) => ({
    before: chat.slice(Math.max(0, i * STRETCH - CONTEXT), i * STRETCH),
    these: chat.slice(i * STRETCH, (i + 1) * STRETCH),
  }))

/** An expectation as set again in `space`: one its space's chat made wakes that space's chat. */
const setIn = (x: Expectation, from: SpaceId, space: SpaceId) => ({
  id: x.id,
  space,
  what: x.what,
  otherwise: x.otherwise,
  ...(x.by !== null && { by: x.by }),
  ...(x.source !== null && { source: x.source }),
  ...(x.thread !== null && {
    thread: x.thread === `space:${from}` ? ThreadId.make(`space:${space}`) : x.thread,
  }),
  ...(x.check !== null && { check: x.check }),
  ...(x.when !== null && { when: x.when }),
  ...(x.promise && { promise: true }),
  ...(x.said !== null && { said: x.said }),
})

/** A move the brain turns down (it went elsewhere meanwhile) leaves the rest to go on. */
const rejected = <A, R>(dispatched: Effect.Effect<A, Rejected, R>) =>
  Effect.catchTag(dispatched, "Rejected", (r) => Effect.logWarning(r.reason))

const decodeCreated = Schema.decodeUnknownOption(SpaceCreated.payload)

/** What `space`, just made under `parent` by `made`, takes in from it. */
const takeIn = (space: SpaceId, parent: SpaceId, made: StoredEvent) =>
  Effect.gen(function* taking() {
    const brain = yield* Brain
    const models = yield* Models
    const key = `taken-in:${space}`
    const { subject, chat, through } = yield* brain.read((db) => ({
      subject: subjectOf(db, space, parent),
      chat: chatIn(db, parent),
      through: cursorOf(db, key) ?? 0,
    }))
    const moved = new Map<string, number>()
    const count = (kind: string) => {
      moved.set(kind, (moved.get(kind) ?? 0) + 1)
    }
    const judge = (before: readonly Held[], these: readonly Held[]) =>
      models.complete("turn", SYSTEM, promptOf(subject, before, these)).pipe(
        Effect.map((c) => verdictOf(c.text)),
        Effect.retry({ times: 2 }),
        Effect.catch(() => Effect.succeed({ in: new Set<string>(), also: new Set<string>() })),
      )

    const move = (h: Held, verdict: { in: Set<string>; also: Set<string> }) =>
      Effect.gen(function* one() {
        const isIn = verdict.in.has(h.key)
        if (h.kind === "message" && isIn) {
          count("chat lines")
          yield* brain.ingest([
            {
              id: EventId.make(`${key}:line:${String(h.event.seq)}`),
              type: MessageMoved.type,
              source: "core",
              payload: { seq: h.event.seq, seqs: [h.event.seq], from: parent, to: space },
            },
          ])
        } else if (h.kind === "message" && verdict.also.has(h.key)) {
          count("chat lines shown in both")
          const mentions = yield* brain.read((db) =>
            db
              .query<{ space: SpaceId }, [number]>("SELECT space FROM mentions WHERE seq = ?")
              .all(h.event.seq)
              .map((m) => m.space),
          )
          const all = [...new Set([...mentions, space])]
          yield* brain.ingest([retagged(h.event, h.line, parent, all, `${key}:also`)])
        } else if (isIn && (h.kind === "event" || h.kind === "work")) {
          count(h.kind === "work" ? "tasks" : "event lines")
          yield* brain.ingest([retagged(h.event, h.line, space, [], key)])
        } else if (isIn && h.kind === "item") {
          const i = yield* brain.read((db) => getItem(db, h.id))
          if (i?.status === "open") {
            count("open items")
            yield* rejected(
              brain.dispatch({
                id: `${key}:${i.id}`,
                type: ReviseItem.type,
                source: "core",
                payload: { ...fieldsOf(i), space },
              }),
            )
          }
        } else if (isIn && h.kind === "expectation") {
          const x = yield* brain.read((db) => getExpectation(db, h.id))
          if (x?.status === "open") {
            count("expectations")
            yield* rejected(
              brain.dispatch({
                id: `${key}:${x.id}`,
                type: Expect.type,
                source: "core",
                payload: setIn(x, parent, space),
              }),
            )
          }
        } else if (isIn && h.kind === "widget") {
          count("widgets")
          yield* rejected(
            brain.dispatch({
              id: `${key}:${h.id}`,
              type: PlaceWidget.type,
              source: "core",
              payload: { app: h.app, name: h.name, id: h.id, space },
            }),
          )
        }
      })

    // The chat, three stretches at a time. How far it's come is kept as a cursor of its own: a
    // restart, as each deploy is, goes on from there.
    const left = stretches(chat).filter((s) => (s.these.at(-1)?.event.seq ?? 0) > through)
    for (let i = 0; i < left.length; i += 3) {
      const now = left.slice(i, i + 3)
      yield* Effect.forEach(
        now,
        (s) =>
          Effect.gen(function* stretch() {
            const verdict = yield* judge(s.before, s.these)
            yield* Effect.forEach(s.these, (h) => move(h, verdict), { discard: true })
          }),
        { concurrency: 3, discard: true },
      )
      yield* passed(key, now.at(-1)?.these.at(-1)?.event.seq ?? 0)
    }

    // Then work, items, expectations and widgets.
    const rest = yield* brain.read((db) => [...workIn(db, parent), ...restIn(db, parent, made)])
    const batches = Array.from({ length: Math.ceil(rest.length / BATCH) }, (_, i) =>
      rest.slice(i * BATCH, (i + 1) * BATCH),
    )
    yield* Effect.forEach(
      batches,
      (these) =>
        Effect.gen(function* batch() {
          const verdict = yield* judge([], these)
          yield* Effect.forEach(these, (h) => move(h, verdict), { discard: true })
        }),
      { concurrency: 3, discard: true },
    )
    const took = [...moved].map(([kind, n]) => `${String(n)} ${kind}`).join(", ")
    yield* Effect.logInfo(`${space} took in from ${parent}: ${took === "" ? "nothing" : took}`)
  })

/** Each space as it's made takes in what bears on it from the space it's made in. */
export const takeInLayer = Layer.effectDiscard(
  Effect.forkScoped(
    react(
      "take-in-by-subject",
      (e) => e.type === SpaceCreated.type,
      (e) => {
        const made = Option.getOrNull(decodeCreated(e.payload))
        return made === null ? Effect.void : takeIn(made.id, made.parent, e)
      },
    ),
  ),
)
