// What reacts to events after they commit: a reactor reads the log from its cursor, kept in the brain,
// so what landed while the core was down, or as it stopped, is read once it's back. What it does
// carries ids derived from the event it reacts to (`<reactor>:<seq>`), so reading an event again
// after a restart does nothing twice. A new reactor starts at the head: old history isn't news.
import type { Database } from "bun:sqlite"
import { Effect, Schema, Stream } from "effect"

import { Brain } from "./brain.ts"
import { defineEvent, on } from "./defs.ts"
import type { Projection, StoredEvent } from "./defs.ts"
import { EventId } from "./ids.ts"
import { defineRead } from "./reads.ts"
import type { Read } from "./reads.ts"

/** A reactor has read and handled every event through `through`. */
export const ReactorPassed = defineEvent(
  "reactor.passed",
  1,
  Schema.Struct({ reactor: Schema.String, through: Schema.Number }),
)

export const reactorCursors: Projection = {
  name: "reactors",
  version: 1,
  tables: ["reactor_cursors"],
  create: "CREATE TABLE reactor_cursors (name TEXT PRIMARY KEY, through INTEGER NOT NULL);",
  on: [
    on(ReactorPassed, (db, p) => {
      db.query(
        "INSERT INTO reactor_cursors (name, through) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET through = max(through, excluded.through)",
      ).run(p.reactor, p.through)
    }),
  ],
  snapshot: () => null,
}

export const reactorsConfig = {
  events: [ReactorPassed],
  projections: [reactorCursors],
  commands: [],
}

const headRead = defineRead(
  "brain/reactors/head",
  (db) =>
    db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
)

/** Where a reactor's cursor stands; null before it first ran. */
export const cursorOf = (db: Database, name: string) =>
  db
    .query<{ through: number }, [string]>("SELECT through FROM reactor_cursors WHERE name = ?")
    .get(name)?.through ?? null

const cursorRead = defineRead("brain/reactors/cursor", cursorOf)

/** Moves a reactor's cursor to `through`. */
export const passed = (name: string, through: number) =>
  Effect.gen(function* passing() {
    const brain = yield* Brain
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`reactor:${name}:${String(through)}`),
          type: ReactorPassed.type,
          source: "core",
          payload: { reactor: name, through },
        },
      ]),
    )
  })

/**
 * A reactor's cursor, or on its first run where it starts (the head, unless `seed` says), saved as
 * its cursor so the next start knows it ran.
 */
export const startOf = (name: string, seed: Read<[], number> = headRead) =>
  Effect.gen(function* starting() {
    const brain = yield* Brain
    const saved = yield* brain.read(cursorRead, name)
    if (saved !== null) {
      return saved
    }
    const from = yield* brain.read(seed)
    yield* passed(name, from)
    return from
  })

/** Saved at least this often while it handles events, and this often while it only passes them. */
const HANDLED_MS = 2000
const PASSED_MS = 10 * 60_000

export interface ReactOptions {
  /** Where it starts on its first run, a read (reads.ts): the head unless given. */
  readonly seed?: Read<[], number>
  /** Starts at the head every time and keeps no cursor (a canary's copy of the brain). */
  readonly fresh?: boolean
  /** Where it reads from at the latest, when that's before its cursor: work it left unfinished. */
  readonly rewind?: Read<[], number | null>
}

/**
 * Hands every event `wanted` picks to `handle`, one at a time and in order, from the reactor's
 * cursor on. A handler must be safe to run again on the same event: one under way as the core
 * stops is read again on the next start.
 */
export const react = <R>(
  name: string,
  wanted: (e: StoredEvent) => boolean,
  handle: (e: StoredEvent) => Effect.Effect<void, unknown, R>,
  options: ReactOptions = {},
) =>
  Effect.gen(function* reacting() {
    const brain = yield* Brain
    const saved =
      options.fresh === true ? yield* brain.read(headRead) : yield* startOf(name, options.seed)
    const { rewind } = options
    const back = rewind === undefined || options.fresh === true ? null : yield* brain.read(rewind)
    const from = back === null ? saved : Math.min(saved, back)
    const at = { read: from, saved: from, savedAt: Date.now(), handled: false }
    const save = Effect.suspend(() => {
      const now = Date.now()
      const due = at.handled || now - at.savedAt >= PASSED_MS
      if (options.fresh === true || at.read <= at.saved || !due) {
        return Effect.void
      }
      const through = at.read
      at.saved = through
      at.savedAt = now
      at.handled = false
      return passed(name, through)
    })
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(HANDLED_MS), save)))
    return yield* brain.changes(from).pipe(
      Stream.runForEach((e) =>
        Effect.gen(function* one() {
          if (wanted(e)) {
            yield* Effect.ignoreCause(handle(e), {
              log: "Warn",
              message: `${name} ${String(e.seq)}`,
            })
            at.handled = true
          }
          at.read = e.seq
        }),
      ),
    )
  })
