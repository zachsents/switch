// What runs beyond single tool calls: the whole import, and the loops that keep senders and other
// sources coming in and changes going out.
import { readFileSync } from "node:fs"
import { AppEvents, Host, Log } from "switch-ext-kit"
import type { Followed } from "switch-ext-kit"
import { Effect, Layer, Schedule, Stream } from "effect"

import { importApple, importGoogle, importOffered, takeSenders } from "./ingest.ts"
import { askForGoogle, brainEvents } from "./core.ts"
import type { Where } from "./core.ts"
import { parse, rec } from "./json.ts"
import { FOLLOWS, seenOf } from "./senders.ts"
import { googleConnected } from "./google.ts"
import { attempt, beat, setFailing, several, why } from "./heartbeat.ts"
import { keepEvent, kept, keptLine, tried } from "./kept.ts"
import { take } from "./merge.ts"
import { contactEvents } from "./model.ts"
import { push } from "./push.ts"
import { load, markImported, save } from "./state.ts"
import { batchId } from "./store.ts"

const MINUTE = 60_000

const failed = (error: Error) => ({ error: error.message })

/** A book's import: its error is the part's trouble until one works. */
const tracked = (part: string) => ({
  ok: () =>
    Effect.sync(() => {
      setFailing(part, null)
    }),
  failed: (error: Error) =>
    Effect.sync(() => {
      setFailing(part, error.message)
      return failed(error)
    }),
})

/**
 * Apple and Google, each the first time it can be read (`again`: once more), merged only where a
 * card is surely someone already there. Google waits for its connection; `ask` asks for it.
 */
export const importBooks = (again: boolean, ask: boolean) =>
  Effect.gen(function* importing() {
    const { imported } = load()
    const appleImport = tracked("apple import")
    const apple =
      again || imported.apple === undefined
        ? yield* importApple.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("apple")
              }),
            ),
            Effect.tap(appleImport.ok),
            Effect.catch(appleImport.failed),
          )
        : null
    const connected = yield* googleConnected
    if (!connected && ask) {
      yield* askForGoogle
    }
    const googleImport = tracked("google import")
    const google =
      (again || imported.google === undefined) && connected
        ? yield* importGoogle.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                markImported("google")
              }),
            ),
            Effect.tap(googleImport.ok),
            Effect.catch(googleImport.failed),
          )
        : null
    return { apple, google: connected ? google : { error: "Google isn't connected" } }
  })

/** The books (each once) and other sources, with counts. */
export const importAll = (again: boolean) =>
  Effect.gen(function* importing() {
    const { apple, google } = yield* importBooks(again, true)
    const others = yield* importOffered().pipe(
      Effect.catch((error) => Effect.succeed(failed(error))),
    )
    return { apple, google, others }
  })

const published = new Set<string>(contactEvents.map((e) => e.type))

/**
 * The extension's own log, forwarded to whoever subscribed (Switch's brain), from where it left
 * off. An event refused is kept, with why, and the rest go on.
 */
const forward = Effect.gen(function* forwarding() {
  const log = yield* Log
  const events = yield* AppEvents
  yield* log.changes(load().forwarded).pipe(
    Stream.runForEach((e) =>
      Effect.gen(function* sending() {
        if (published.has(e.type)) {
          const sent = { id: e.id, type: e.type, payload: e.payload }
          const error = yield* attempt(events.emit(sent))
          if (error !== null) {
            keepEvent(sent, error)
          }
        }
        const s = load()
        s.forwarded = e.seq
        save(s)
      }),
    ),
  )
})

/** Forwarding for good: when it stops, that's its trouble, and it starts again a minute later. */
const forwarding = Effect.forever(
  Effect.gen(function* again() {
    setFailing("forwarding", (yield* attempt(forward)) ?? "stopped")
    yield* Effect.sleep("1 minute")
    setFailing("forwarding", null)
  }),
)

/** At most this many skipped are tried again a round. */
const RETRIES = 50

/** What earlier passes skipped, tried again, oldest first. */
const retry = Effect.gen(function* retrying() {
  const events = yield* AppEvents
  for (const k of kept().slice(0, RETRIES)) {
    tried(
      k.key,
      k.kind === "record"
        ? yield* attempt(
            take(k.record, batchId(`retry-${k.source}`), `retry ${k.source}`, k.matching),
          )
        : yield* attempt(events.emit({ id: k.id, type: k.type, payload: k.payload })),
    )
  }
})

/** The last message handled: the kit's follow.json (its folder's) until one is handled here. */
let handled = (() => {
  try {
    const { after } = rec(parse(readFileSync("follow.json", "utf-8")))
    return typeof after === "number" ? after : 0
  } catch {
    return 0
  }
})()

/** How long since a look last found every message read; 0 when the last one did. */
let behind = 0
const started = Date.now()

/** One message's senders taken in; what goes wrong is the trouble of following. */
const heard = (e: Followed) =>
  takeSenders(seenOf(e), e.id).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        handled = e.seq
        setFailing("following", null)
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        setFailing("following", why(cause))
      }),
    ),
  )

/**
 * The messages followed from the brain, each once in order, resuming after the last handled. Asked
 * before the host is there, or refused, the kit asks again when the host next connects.
 */
const following = Effect.gen(function* follow() {
  const host = yield* Host
  const context = yield* Effect.context<Effect.Services<ReturnType<typeof heard>>>()
  const handle = (e: Followed) => Effect.provideContext(heard(e), context)
  setFailing("following", yield* attempt(host.follow(FOLLOWS, handle)))
})

/** Every message in the brain: a record on a `comms/` stream with a sender, whatever its type. */
const MESSAGES: readonly Where[] = [
  { field: "payload.stream", op: "startsWith", value: "comms/" },
  { field: "payload.sender", op: "exists", value: true },
]

/**
 * How far behind the brain's messages it is: each one since the last look is read when it's of a
 * type followed and handled. One that isn't (a type no longer followed, a follow stalled) holds the
 * cursor, and `behind` grows from when a look last found them all read.
 */
const look = Effect.gen(function* looking() {
  const s = load()
  const { events, whole } = yield* brainEvents(MESSAGES, s.brain)
  let all = whole
  for (const e of events) {
    if (!(FOLLOWS as readonly string[]).includes(e.type) || e.seq > handled) {
      all = false
      break
    }
    s.brain = e.seq
  }
  const now = Date.now()
  if (all) {
    s.caughtUp = now
  }
  behind = all ? 0 : now - (s.caughtUp === 0 ? started : s.caughtUp)
  save(s)
  if (!whole) {
    yield* Effect.fail(new Error("Can't reach the core"))
  }
})

const sense = Effect.gen(function* sensing() {
  yield* retry
  yield* look
})

/** When a book whose push had errors is pushed again, though nothing changed. */
const pushAgain = new Map<"apple" | "google", number>()

const outward = Effect.gen(function* pushing() {
  const log = yield* Log
  const head = (yield* log.snapshot).seq
  const moved = head > load().pushedThrough
  const now = Date.now()
  for (const t of ["apple", "google"] as const) {
    if (moved || (pushAgain.get(t) ?? Infinity) <= now) {
      const exit = yield* Effect.exit(push(t, batchId(`push-${t}`)))
      let error: string | null = null
      if (exit._tag === "Failure") {
        error = why(exit.cause)
      } else if (load().imported[t] !== undefined) {
        error = several(exit.value.errors)
      }
      setFailing(`push to ${t}`, error)
      if (error === null) {
        pushAgain.delete(t)
      } else {
        pushAgain.set(t, now + 10 * MINUTE)
      }
    }
  }
  if (moved) {
    const s = load()
    s.pushedThrough = (yield* log.snapshot).seq
    save(s)
  }
})

const facts = Effect.gen(function* counting() {
  const log = yield* Log
  const people = yield* log.read(
    (db) =>
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM people WHERE merged_into IS NULL AND retired = 0",
        )
        .get()?.n ?? 0,
  )
  return { people, skipped: kept().length, behind_ms: behind }
})

/**
 * A loop: `task` every `interval`, its failure the part's trouble, and a beat if what's failing
 * changed (`round`: the senders loop, whose beat is due every five minutes).
 */
const every = <E, R>(
  part: string,
  task: Effect.Effect<unknown, E, R>,
  interval: Schedule.Schedule<unknown>,
  round = false,
) =>
  Effect.forkScoped(
    Effect.repeat(
      Effect.gen(function* running() {
        setFailing(part, yield* attempt(task))
        setFailing("skipped", keptLine())
        yield* beat(round, facts)
      }),
      interval,
    ),
  )

/**
 * The log forwarded, and, unless CONTACTS_LOOPS=0: senders as their messages come; what was skipped
 * and how far behind the messages it is every 5 minutes, with the heartbeat; other sources every
 * hour; a book not yet imported every 10 minutes (Google once it's connected); changes out every 2.
 */
export const background = Layer.effectDiscard(
  Effect.gen(function* starting() {
    yield* Effect.forkScoped(forwarding)
    if (process.env.CONTACTS_LOOPS === "0") {
      return
    }
    yield* Effect.forkScoped(following)
    yield* every("senders", sense, Schedule.spaced("5 minutes"), true)
    yield* every("other sources", importOffered("keys"), Schedule.spaced("1 hour"))
    yield* every("books", importBooks(false, false), Schedule.spaced("10 minutes"))
    yield* every("push", outward, Schedule.spaced("2 minutes"))
  }),
)
