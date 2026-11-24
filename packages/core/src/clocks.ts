// A clock whose work has ended is settled by the core, not left to the agent's memory: `like` when
// all of it ended done, taken back when any failed or was dropped (agent's clocks.ts). It looks at
// start, for what ended while the core was down, then after each end.
// And a thread whose last turn ended done while its work went on (its `going` end) is settled once
// none of it goes on, its watches closed and its scripts ended: clients and clocks read it as
// waiting until then.
import type { Database } from "bun:sqlite"
import { settledClocks, stillGoing, TaskDropped, ThreadSettled, TurnEnded } from "@switch/agent"
import { Brain, CLOCK, EventId, react, ReactToMessage, ThreadId } from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { Effect, Layer, Stream } from "effect"
import { isJson } from "switch-ext-kit"

/** Swaps each settled clock: `like` when its work is done, none when it failed. */
export const settleClocks = Effect.gen(function* settling() {
  const brain = yield* Brain
  for (const c of yield* brain.read(settledClocks)) {
    yield* brain
      .dispatch({
        id: `clock:${String(c.seq)}:${crypto.randomUUID()}`,
        type: ReactToMessage.type,
        source: "agent",
        payload: { seq: c.seq, reaction: c.state === "done" ? "like" : null, was: CLOCK },
      })
      .pipe(Effect.catchTag("Rejected", (r) => Effect.logWarning(r.reason)))
  }
})

const ENDS = new Set<string>([TurnEnded.type, TaskDropped.type, ThreadSettled.type])

/** What can end what a thread left going: a watch of its closing, a script of its stopping. */
const CLOSING = new Set([
  "expectation.met",
  "expectation.lapsed",
  "expectation.dropped",
  "expectation.broken",
  "script.ended",
  "script.retired",
])

/** The thread whose watch or script an event closed, or null. */
const threadOf = (db: Database, e: StoredEvent) => {
  if (!isJson(e.payload)) {
    return null
  }
  const { id, thread } = e.payload
  if (typeof thread === "string") {
    return ThreadId.make(thread)
  }
  if (typeof id !== "string") {
    return null
  }
  const table = e.type.startsWith("script.") ? "scripts" : "expectations"
  const row = db
    .query<{ thread: string | null }, [string]>(`SELECT thread FROM ${table} WHERE id = ?`)
    .get(id)
  const owner = row?.thread
  return typeof owner === "string" ? ThreadId.make(owner) : null
}

/**
 * The turn a thread last ended done with, once none of its work goes on. Once per turn, so it also
 * settles a thread whose end came before ends said whether its work went on.
 */
const settledTurn = (db: Database, thread: ThreadId) => {
  const t = db
    .query<{ status: string; turn: string | null }, [string]>(
      "SELECT status, turn FROM threads WHERE thread = ?",
    )
    .get(thread)
  return t?.status === "done" && t.turn !== null && !stillGoing(db, thread) ? t.turn : null
}

const settleWork = react(
  "work-settled",
  (e) => CLOSING.has(e.type),
  (e) =>
    Effect.gen(function* settling() {
      const brain = yield* Brain
      const settled = yield* brain.read((db) => {
        const thread = threadOf(db, e)
        const turn = thread === null ? null : settledTurn(db, thread)
        return thread === null || turn === null ? null : { thread, turn }
      })
      if (settled !== null) {
        yield* brain.ingest([
          {
            id: EventId.make(`settled:${settled.turn}`),
            type: ThreadSettled.type,
            source: "runtime",
            payload: settled,
          },
        ])
      }
    }),
)

export const clocksWorker = Layer.effectDiscard(
  Effect.gen(function* clocking() {
    const brain = yield* Brain
    const head = yield* brain.read(
      (db) =>
        db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
    )
    yield* settleClocks
    yield* Effect.forkScoped(settleWork)
    yield* Effect.forkScoped(
      brain.changes(head).pipe(
        Stream.filter((e) => ENDS.has(e.type)),
        Stream.runForEach(() => settleClocks),
      ),
    )
  }),
)
