// bun run bench: write throughput of the brain, on a file in tmp.
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, Schema, Stream } from "effect"

import { Brain } from "./src/brain.ts"
import type { Incoming } from "./src/brain.ts"
import { defineEvent } from "./src/defs.ts"
import { EventId } from "./src/ids.ts"
import { CreateSpace, spacesConfig } from "./src/spaces.ts"

// Shaped like a Switchboard record: about 856 bytes of body, as in Vercel Board's trial.
const Record = defineEvent(
  "bench.record",
  1,
  Schema.Struct({ stream: Schema.String, kind: Schema.String, body: Schema.Unknown }),
)
const filler = "x".repeat(780)
const counter = { next: 0 }
const record = (): Incoming => {
  counter.next += 1
  const n = counter.next
  return {
    id: EventId.make(`r${n}`),
    type: Record.type,
    source: "bench",
    payload: {
      stream: `device/mac${n % 3}`,
      kind: "state",
      body: { n, app: "Safari", title: `Tab ${n}`, text: filler },
    },
  }
}
const records = (n: number) => Array.from({ length: n }, record)
const perSec = (n: number, ms: number) => Math.round(n / (ms / 1000))
const timed = Effect.fnUntraced(function* timing<A, E, R>(effect: Effect.Effect<A, E, R>) {
  const start = performance.now()
  yield* effect
  return performance.now() - start
})

const file = path.join(mkdtempSync(path.join(tmpdir(), "brain-bench-")), "brain.db")

const bench = Effect.gen(function* benching() {
  const brain = yield* Brain
  const one = (r: Incoming) => brain.ingest([r])

  const single = yield* timed(Effect.forEach(records(5000), one, { discard: true }))
  const batch100 = yield* timed(
    Effect.forEach(
      Array.from({ length: 150 }, () => records(100)),
      (b) => brain.ingest(b),
      { discard: true },
    ),
  )
  // Many producers, one event each: the writer groups them.
  const flood = yield* timed(
    Effect.forEach(records(100_000), one, { concurrency: "unbounded", discard: true }),
  )
  const creates = Array.from({ length: 5000 }, (_, i) => ({
    id: `c${i}`,
    type: CreateSpace.type,
    source: "desktop",
    payload: { id: `s${i}`, name: `Space ${i}`, parent: null },
  }))
  const command = yield* timed(Effect.forEach(creates, (c) => brain.dispatch(c), { discard: true }))

  // Fill to a day of Switchboard (about 207k records), then a 1k burst of UI events.
  yield* Effect.forEach(
    Array.from({ length: 820 }, () => records(100)),
    (b) => brain.ingest(b),
    { discard: true },
  )
  const { seq } = yield* brain.snapshot
  const watcher = yield* Effect.forkChild(Stream.runDrain(Stream.take(brain.changes(seq), 1000)))
  const start = performance.now()
  yield* Effect.forEach(records(1000), one, { concurrency: "unbounded", discard: true })
  const burstCommitted = performance.now() - start
  yield* Fiber.join(watcher)
  const burstSeen = performance.now() - start
  const dayOldSingle = yield* timed(Effect.forEach(records(5000), one, { discard: true }))
  const bytes =
    statSync(file).size + (statSync(`${file}-wal`, { throwIfNoEntry: false })?.size ?? 0)

  return {
    singlePerSec: perSec(5000, single),
    batch100PerSec: perSec(15_000, batch100),
    floodPerSec: perSec(100_000, flood),
    commandPerSec: perSec(5000, command),
    dayOldEvents: seq,
    burst1kCommittedMs: Math.round(burstCommitted),
    burst1kSeenMs: Math.round(burstSeen),
    dayOldSinglePerSec: perSec(5000, dayOldSingle),
    bytesPerEvent: Math.round(bytes / (seq + 6000)),
  }
})

const config = { ...spacesConfig, path: file, events: [...spacesConfig.events, Record] }
console.log(
  JSON.stringify(await Effect.runPromise(bench.pipe(Effect.provide(Brain.layer(config)))), null, 2),
)
