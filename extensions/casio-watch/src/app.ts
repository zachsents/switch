// An extension that is only a widget: a Casio Wave Ceptor face, live. Its drawing is an MCP App
// inside A2UI's `McpApp` component; it suggests Home.
import { Effect, Layer, Schema } from "effect"
import { AppEvents, defineApp, defineEvent, mcpApp } from "switch-ext-kit"
import type { AppEventsService } from "switch-ext-kit"

import { faceHtml } from "./build.ts"

// Built when the extension starts: Bun runs no macros from an installed package.
const html = faceHtml()

/** Every this often, as its manifest's `heartbeat` promises. */
const BEAT = 5 * 60_000

/** How it is, beaten by the face's layer, so it stops when that does. */
export const Heartbeat = defineEvent(
  "watch.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:watch"),
    summary: Schema.String,
    facts: Schema.Struct({ failing: Schema.NullOr(Schema.String), faceBytes: Schema.Finite }),
  }),
)

/** The face served: beats while it is. */
export const Face: Layer.Layer<never, never, AppEventsService> = Layer.effectDiscard(
  Effect.gen(function* serving() {
    const events = yield* AppEvents
    const beat = events.emit(
      Heartbeat.make({
        entity: "sense:watch",
        summary: `face ${Math.round(html.length / 1024)} KB`,
        facts: { failing: null, faceBytes: html.length },
      }),
    )
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.andThen(Effect.ignore(beat, { log: "Warn" }), Effect.sleep(`${BEAT} millis`)),
      ),
    )
  }),
)

export const watchApp = defineApp({
  name: "watch",
  version: "1",
  instructions: "A Casio Wave Ceptor (WVA-M630D) watch face, as a widget.",
  tools: [],
  events: [Heartbeat],
  widgets: [
    {
      name: "face",
      title: "Wave Ceptor",
      surfaces: ["space"],
      resource: "ui://watch/face",
      size: {
        aspect: "square",
        min: { cols: 2, rows: 2 },
        preferred: { cols: 3, rows: 3 },
        max: { cols: 3, rows: 3 },
        grows: true,
      },
      a2ui: () => mcpApp("face", { title: "Wave Ceptor", html }),
    },
  ],
})
