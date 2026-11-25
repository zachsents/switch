// A widget placed more than once, even twice in one space, is each placement its own: the core calls
// its tool with that placement's input, asked for by the placement's id, never by the widget's name
// (Nov 24: a second web preview drew the first one's page).
import { afterAll, expect, test } from "bun:test"
import { Brain, defineRead, spacesConfig, widgetsConfig, WidgetInput } from "@switch/brain"
import { Effect, ManagedRuntime, Option, Schema } from "effect"

import { widgetRouter } from "./gateway.ts"

type Input = typeof WidgetInput.Type

/** The widget's tool, as an extension's: its data model is the input it was called with. */
const called: string[] = []
const view = async (_app: string, name: string, input: Input) => {
  called.push(name)
  return await Promise.resolve([
    { version: "1.0", createSurface: { surfaceId: "preview" } },
    { version: "1.0", updateDataModel: { surfaceId: "preview", value: { shown: input } } },
  ])
}

const runtime = ManagedRuntime.make(
  Brain.layer({
    path: ":memory:",
    events: [...spacesConfig.events, ...widgetsConfig.events],
    projections: [...spacesConfig.projections, ...widgetsConfig.projections],
    commands: [...spacesConfig.commands, ...widgetsConfig.commands],
  }),
)
afterAll(async () => {
  await runtime.dispose()
})
const brain = await runtime.runPromise(
  Effect.gen(function* opened() {
    return yield* Brain
  }),
)

const route = widgetRouter({
  gateway: {
    widgets: () => [],
    view,
    call: async () => await Promise.resolve({ content: [] }),
  },
  brain,
  made: async () => await Promise.resolve(Option.none()),
})

let n = 0
const command = async (type: string, payload: unknown) =>
  await Effect.runPromise(brain.dispatch({ id: `c${(n += 1)}`, type, source: "test", payload }))

const Drawn = Schema.Array(
  Schema.Struct({
    updateDataModel: Schema.optionalKey(
      Schema.Struct({ value: Schema.Struct({ shown: WidgetInput }) }),
    ),
  }),
)

/** What a placement draws: the input its data model was made from, asked for as a client does. */
const drawn = async (placement: string) => {
  const res = await route(
    new Request(`http://core/widgets/browser/preview?placement=${encodeURIComponent(placement)}`),
  )
  expect(res.status).toBe(200)
  const messages = Schema.decodeUnknownSync(Drawn)(await res.json())
  return messages.find((m) => m.updateDataModel)?.updateDataModel?.value.shown
}

const placedRead = defineRead("gateway/placements-test/ids", (db) =>
  db.query("SELECT id FROM widgets").all(),
)
const placed = async () => await Effect.runPromise(brain.read(placedRead))

test("two placements of one widget in one space each render and refresh with their own input", async () => {
  await command("space.create", { id: "board", name: "Board", parent: null })
  await command("widget.place", {
    app: "browser",
    name: "preview",
    space: "board",
    input: { url: "https://switch.ax" },
  })
  await command("widget.place", {
    app: "browser",
    name: "preview",
    space: "board",
    another: true,
    input: { url: "https://example.com", every: "5m" },
  })
  expect(await placed()).toHaveLength(2)

  // Each renders with its own input.
  expect(await drawn("browser/preview")).toEqual({ url: "https://switch.ax" })
  expect(await drawn("browser/preview#2")).toEqual({ url: "https://example.com", every: "5m" })

  // A refresh (an event its widget names) asks each again by its id: still each its own.
  expect(await drawn("browser/preview#2")).toEqual({ url: "https://example.com", every: "5m" })
  expect(await drawn("browser/preview")).toEqual({ url: "https://switch.ax" })

  // One changed is that one alone, the other untouched.
  await command("widget.place", {
    app: "browser",
    name: "preview",
    space: "board",
    id: "browser/preview#2",
    input: { url: "https://example.org" },
  })
  expect(await drawn("browser/preview#2")).toEqual({ url: "https://example.org" })
  expect(await drawn("browser/preview")).toEqual({ url: "https://switch.ax" })

  // Another widget's placement is none of this one's: called with nothing.
  expect(await drawn("printers/camera")).toEqual({})
  expect(called.every((name) => name === "preview")).toBe(true)
})
