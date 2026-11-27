// The reader as a stdio MCP server: `bun src/main.ts`.
import { Effect, Layer } from "effect"
import { AppEvents, Models, serveStdio } from "switch-ext-kit"

import { beat, readerApp } from "./app.ts"
import { logLayer } from "./store.ts"

// Its tools emit through the outbox serveStdio gives it.
const events = Layer.effect(
  AppEvents,
  Effect.gen(function* passing() {
    return yield* AppEvents
  }),
)
const services = Layer.mergeAll(logLayer(), Models.layer, events)
const beating = Layer.effectDiscard(Effect.forkScoped(beat)).pipe(Layer.provide(logLayer()))

await serveStdio(readerApp, Layer.provideMerge(beating, services))
