// Extensions' side threads (brain's ids.ts `sideThread`): an extension asks Switch in a thread of
// its own in a space (switch-ext-kit's `Switch.ask`). It's a real turn of the agent's, the space's
// memory and context in it, and what it says (say) goes back to the extension, never into the
// space's chat; the space's own turns see these threads (`sideLines`), and history_search finds
// them. An extension also delivers words into a live session (`steer`): its own side threads, or
// the work its manifest reaches (`reaches.steers`).
import type { Database } from "bun:sqlite"
import {
  carriedOn,
  getThread,
  itemsAfter,
  sayWords,
  Sessions,
  TurnDelta,
  TurnEnded,
  TurnInjected,
  TurnResult,
  TurnStarted,
  TurnText,
  TurnTool,
} from "@switch/agent"
import type { Item } from "@switch/agent"
import { Brain, defineRead, sideOfThread, sideThread, spaceFor, ThreadId } from "@switch/brain"
import type { SpaceId, StoredEvent } from "@switch/brain"
import type { Agent, SideAnswer, SideAsk } from "@switch/gateway"
import { Effect, Option, Schema, Stream } from "effect"

const clip = (text: string, n: number) => {
  const flat = text.replaceAll(/\s+/gu, " ").trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })

/** The user's words in a stretch of a side thread, and what was said back, each with its time. */
const exchangeLines = (rows: readonly (Item & { readonly time: number })[]) => {
  const failed = new Set(rows.flatMap((r) => (r.kind === "result" && r.error ? [r.id] : [])))
  return rows.flatMap((r) => {
    if ((r.kind === "user" || r.kind === "steer") && r.text.trim() !== "") {
      return [`${hhmm(r.time)} User: ${clip(r.text, 240)}`]
    }
    const said = r.kind === "tool" && !failed.has(r.id) ? sayWords(r.name, r.input) : ""
    if (said !== "") {
      return [`${hhmm(r.time)} Switch: ${clip(said, 400)}`]
    }
    return []
  })
}

const SHOWN_THREADS = 4
const SHOWN_LINES = 6

/**
 * The space's side threads that moved since `after`, each with its latest words: what its own
 * turns see of what was asked in extensions, read from the threads' record as it stands.
 */
export const sideLines = (db: Database, space: SpaceId, after: number, except: string) => {
  const threads = db
    .query<{ thread: string; title: string }, [number]>(
      "SELECT thread, title FROM threads WHERE thread LIKE 'side:%' AND (seen > ? OR status = 'running') ORDER BY seen DESC",
    )
    .all(after)
    .filter((t) => t.thread !== except && sideOfThread(t.thread)?.space === space)
    .slice(0, SHOWN_THREADS)
  return threads.flatMap((t) => {
    const lines = exchangeLines(itemsAfter(db, t.thread, after)).slice(-SHOWN_LINES)
    const app = sideOfThread(t.thread)?.app ?? ""
    return lines.length === 0
      ? []
      : [`- ${app} · ${clip(t.title, 120)} (${t.thread})`, ...lines.map((l) => `  - ${l}`)]
  })
}

/**
 * An extension's call to wake Switch: its event `<name>.wake` (or `<name>.<part>.wake`), with the
 * words the turn gets and the space it's in (else Home). Every one wakes a turn, not left to triage.
 */
export const isWake = (e: StoredEvent) =>
  e.type.endsWith(".wake") && e.type.startsWith(`${e.source}.`)
export const WakeAsked = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)),
  space: Schema.optionalKey(Schema.String),
})

/** What a side thread's own turns are told of where they are, once, at launch. */
export const sideStable = (thread: ThreadId) => {
  const side = sideOfThread(thread)
  return side === null
    ? ""
    : `This session is a side thread of the ${side.app} extension in this space: the user talks to you in ${side.app}, not in the space's chat. What you say (say) goes back to ${side.app}, where they asked, and never to the chat; there's no message of theirs to react to. You're the same agent with the same tools: do what they ask here as you would in the chat.`
}

/** The seq of the event with this id, else null. */
const seqOfRead = defineRead(
  "core/side/seq-of",
  (db, id: string) =>
    db.query<{ seq: number }, [string]>("SELECT seq FROM events WHERE id = ?").get(id)?.seq ?? null,
)
const headRead = defineRead(
  "core/side/head",
  (db) =>
    db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
)
const spaceForRead = defineRead("core/side/space-for", (db, given: string | undefined) =>
  spaceFor(db, given, null),
)
const threadRead = defineRead("core/side/thread", (db, thread: ThreadId) => getThread(db, thread))

const decode = <A>(schema: Schema.Codec<A, unknown>) => {
  const d = Schema.decodeUnknownOption(schema)
  return (e: StoredEvent) => Option.getOrNull(d(e.payload))
}
const started = decode(TurnStarted.payload)
const injected = decode(TurnInjected.payload)
const delta = decode(TurnDelta.payload)
const text = decode(TurnText.payload)
const tooled = decode(TurnTool.payload)
const resulted = decode(TurnResult.payload)
const ended = decode(TurnEnded.payload)

/** Where an answer stands as the thread's events come: its turn, the step's words, what it said. */
interface Hearing {
  turn: string | null
  step: string
  readonly said: string[]
  readonly saying: Map<string, string>
  answer: SideAnswer | null
}

/** Which turn answers: the first to start after the words were recorded, or one they joined. */
const take = (h: Hearing, e: StoredEvent, asked: number) => {
  const s = started(e)
  if (s !== null && e.seq > asked) {
    h.turn = s.turn
    h.step = ""
  }
  const i = injected(e)
  if (i?.took?.includes(asked) === true) {
    h.turn = i.turn
  }
}

/** Its words as they stream, and each say that went through. */
const hear = (h: Hearing, e: StoredEvent, progress: (t: string) => void) => {
  const d = delta(e)
  if (d?.turn === h.turn && d !== null) {
    h.step += d.text
    progress(h.step)
  }
  if (text(e)?.turn === h.turn) {
    h.step = ""
  }
  const t = tooled(e)
  const said = t?.turn === h.turn && t !== null ? sayWords(t.name, t.input) : ""
  if (t !== null && said !== "") {
    h.saying.set(t.id, said)
  }
  const r = resulted(e)
  const pending = r === null ? undefined : h.saying.get(r.id)
  if (r?.turn === h.turn && r !== null && pending !== undefined) {
    h.saying.delete(r.id)
    if (!r.error) {
      h.said.push(pending)
      progress(h.said.join("\n\n"))
    }
  }
}

/** Its end: the answer, unless the turn only paused and the next carries it on. */
const end = (h: Hearing, e: StoredEvent, thread: ThreadId) => {
  const over = ended(e)
  if (over?.turn !== h.turn || over === null) {
    return
  }
  if (carriedOn(over)) {
    h.turn = null
    return
  }
  h.answer = { thread, turn: over.turn, said: h.said, status: over.status, result: over.result }
}

/**
 * What the turn that took in the words recorded at `asked` said, once it ends: from the record,
 * so asking again after a restart reads the same answer. Its streamed words go to `progress` as
 * they come; a turn paused for an update is carried on by the next, and both count.
 */
const answerOf = (thread: ThreadId, from: number, asked: number, progress: (t: string) => void) =>
  Effect.gen(function* answering() {
    const brain = yield* Brain
    const h: Hearing = { turn: null, step: "", said: [], saying: new Map(), answer: null }
    const mine = (e: StoredEvent) =>
      typeof e.payload === "object" &&
      e.payload !== null &&
      "thread" in e.payload &&
      e.payload.thread === thread
    yield* Stream.runForEachWhile(Stream.filter(brain.changes(from), mine), (e) =>
      Effect.sync(() => {
        take(h, e, asked)
        hear(h, e, progress)
        end(h, e, thread)
        return h.answer === null
      }),
    )
    return h.answer ?? { thread, turn: h.turn, said: h.said, status: "interrupted", result: "" }
  })

/** The agent as the gateway offers it to extensions. */
export const makeAgent = Effect.gen(function* making() {
  const brain = yield* Brain
  const sessions = yield* Sessions
  const run = async <A>(effect: Effect.Effect<A, unknown, Brain>, signal?: AbortSignal) =>
    await Effect.runPromise(
      Effect.provideService(effect, Brain, brain),
      signal === undefined ? undefined : { signal },
    )

  const ask = async (
    app: string,
    a: SideAsk,
    progress: (t: string) => void,
    signal: AbortSignal,
  ): Promise<SideAnswer> =>
    await run(
      Effect.gen(function* asking() {
        const space = yield* brain.read(spaceForRead, a.space)
        const thread = sideThread(app, space, a.key)
        if (thread === null) {
          return yield* Effect.fail(new Error(`A thread's key is 1 to 64 letters, digits, _ . -`))
        }
        // The same ask again (after a restart on either side) is the same words, answered once.
        const id = `side:${app}:${a.id}`
        const before = yield* brain.read(seqOfRead, id)
        const from = before === null ? yield* brain.read(headRead) : before - 1
        if (before === null) {
          yield* sessions
            .send(thread, a.text, {
              title: a.title ?? `${app}: ${clip(a.text, 60)}`,
              id,
              ...(a.note !== undefined && a.note !== "" && { note: a.note }),
            })
            .pipe(Effect.catchTag("NoHost", () => Effect.void))
        }
        const asked = yield* brain.read(seqOfRead, id)
        if (asked === null) {
          return yield* Effect.fail(new Error("Not taken in"))
        }
        return yield* answerOf(thread, from, asked, progress)
      }),
      signal,
    )

  const steer = async (app: string, thread: string, said: string, id: string) => {
    await run(
      Effect.gen(function* steering() {
        const t = ThreadId.make(thread)
        if ((yield* brain.read(threadRead, t)) === null) {
          return yield* Effect.fail(new Error(`No thread ${thread}`))
        }
        return yield* sessions.wake(
          t,
          `${app}, an extension (not the user), says:\n\n${said}`,
          "steer",
          `steer:${app}:${id}`,
        )
      }),
    )
  }

  return { ask, steer } satisfies Agent
})
