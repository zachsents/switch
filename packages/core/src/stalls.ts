// The core's thread held: each time something held the event loop past a second (a sync read, a
// long parse), it's logged and kept as `core.stalled`, for reflection's measures (measures.ts).
import { Brain, defineEvent, EventId } from "@switch/brain"
import { Effect, Layer, Schema } from "effect"

export const CoreStalled = defineEvent(
  "core.stalled",
  1,
  Schema.Struct({
    /** How long past its tick the loop came back. */
    ms: Schema.Number,
  }),
)

export const stallsConfig = { events: [CoreStalled], projections: [], commands: [] }

const TICK_MS = 250
const STALL_MS = 1000

export const stallsWatch = Layer.effectDiscard(
  Effect.gen(function* watching() {
    const brain = yield* Brain
    let last = performance.now()
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* tick() {
          yield* Effect.sleep(`${TICK_MS} millis`)
          const now = performance.now()
          const late = Math.round(now - last - TICK_MS)
          last = now
          if (late >= STALL_MS) {
            console.warn(`event loop stalled ${late} ms`)
            yield* Effect.ignore(
              brain.ingest([
                {
                  id: EventId.make(`stalled:${Date.now()}`),
                  type: CoreStalled.type,
                  source: "core",
                  payload: { ms: late },
                },
              ]),
            )
          }
        }),
      ),
    )
  }),
)
