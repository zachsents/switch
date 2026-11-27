// Ghostty on this Mac: a window, tab or split with a command typed and run (or typed, waiting for
// ↵), text typed into a terminal, and its windows, tabs and terminals listed. Where Ghostty isn't
// installed (or is older than its AppleScript), `open` opens Terminal instead. `ghostty.heartbeat`
// says whether Ghostty is here and whether Switch may drive it.
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { AppEvents, defineApp, defineEvent, tool } from "switch-ext-kit"
import type { AppEventsService } from "switch-ext-kit"

import * as ghostty from "./ghostty.ts"
import * as terminal from "./terminal.ts"

/** Every this often, as its manifest's `heartbeat` promises. */
const BEAT = 5 * 60_000

export const Heartbeat = defineEvent(
  "ghostty.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:ghostty"),
    summary: Schema.String,
    facts: Schema.Struct({
      /** What's wrong now (Automation turned down); null when nothing is. */
      failing: Schema.NullOr(Schema.String),
      /** Ghostty's version here; null when it isn't installed. */
      version: Schema.NullOr(Schema.String),
    }),
  }),
)

/** How Ghostty answers here: what's failing, told in the heartbeat at once when it changes. */
export class Health extends Context.Service<
  Health,
  { readonly settle: (failing: string | null) => Effect.Effect<void> }
>()("ghostty/Health") {
  static readonly layer: Layer.Layer<Health, never, AppEventsService> = Layer.effect(
    Health,
    Effect.gen(function* making() {
      const events = yield* AppEvents
      const failing = yield* Ref.make<string | null>(null)
      const beat = Effect.gen(function* beating() {
        const found = yield* Effect.orElseSucceed(ghostty.installed, () => null)
        const f = yield* Ref.get(failing)
        let summary = "Ghostty not installed; Terminal instead"
        if (found) {
          summary = ghostty.scriptable(found.version)
            ? `Ghostty ${found.version}`
            : `Ghostty ${found.version}, before AppleScript; Terminal instead`
        }
        yield* events.emit(
          Heartbeat.make({
            entity: "sense:ghostty",
            summary: f ?? summary,
            facts: { failing: f, version: found?.version ?? null },
          }),
        )
      }).pipe(Effect.ignore({ log: "Warn" }))
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(beat, Effect.sleep(`${BEAT} millis`))))
      return {
        settle: (now) =>
          Effect.gen(function* settling() {
            const was = yield* Ref.getAndSet(failing, now)
            if (was !== now) {
              yield* beat
            }
          }),
      }
    }),
  )
}

/** Notes how a call to Ghostty went: only Automation turned down is the extension's trouble. */
const told = <A, R>(effect: Effect.Effect<A, string, R>) =>
  Effect.gen(function* telling() {
    const health = yield* Health
    return yield* effect.pipe(
      Effect.tap(() => health.settle(null)),
      Effect.tapError((e) => health.settle(e === ghostty.DENIED ? e : null)),
    )
  })

/** Whether Ghostty is here with its AppleScript. */
const usable = Effect.map(
  Effect.orElseSucceed(ghostty.installed, () => null),
  (found) => found !== null && ghostty.scriptable(found.version),
)

const Place = Schema.Literals(["window", "tab", "split"])
const Direction = Schema.Literals(["right", "left", "down", "up"])

const open = tool(
  "open",
  {
    description:
      "Opens a Ghostty window (place: window, the default), a tab (in `window`, else the front one) or a split (of `terminal`, else the front one's, toward `direction`, right by default) on this Mac, in front, in `cwd` (~ is home), with `command` typed at its prompt: run at once with run: true, else left for the user to read and press ↵ (a command they're to run themselves, or one that needs them). Where Ghostty isn't, Terminal opens instead, in a window. Answers the new terminal's id (for type), or app: Terminal.",
    input: Schema.Struct({
      command: Schema.optionalKey(Schema.String),
      run: Schema.optionalKey(Schema.Boolean),
      cwd: Schema.optionalKey(Schema.String),
      place: Schema.optionalKey(Place),
      window: Schema.optionalKey(Schema.String),
      terminal: Schema.optionalKey(Schema.String),
      direction: Schema.optionalKey(Direction),
    }),
  },
  (input) =>
    Effect.gen(function* opening() {
      if (!(yield* usable)) {
        return yield* terminal.open(input.command ?? "", input.cwd, input.run === true)
      }
      const made = yield* told(ghostty.open({ ...input, place: input.place ?? "window" }))
      return { ...made, app: "Ghostty" }
    }),
)

const type = tool(
  "type",
  {
    description:
      "Types text into a Ghostty terminal on this Mac (its id, from open or list), as pasted; enter: true presses ↵ after it.",
    input: Schema.Struct({
      terminal: Schema.String,
      text: Schema.String,
      enter: Schema.optionalKey(Schema.Boolean),
    }),
  },
  (input) =>
    Effect.as(told(ghostty.type(input.terminal, input.text, input.enter === true)), {
      typed: true,
    }),
)

const list = tool(
  "list",
  {
    description:
      "Ghostty's windows on this Mac, front first, each with its tabs and their terminals (id, title, working directory, which is focused). Ghostty offers no way to read what a terminal shows.",
    readOnly: true,
  },
  () => Effect.map(told(ghostty.list), (windows) => ({ windows })),
)

export const ghosttyApp = defineApp<Health>({
  name: "ghostty",
  version: "1",
  instructions:
    "Ghostty, the terminal, on this Mac: open a window, tab or split with a command typed (run, or waiting for the user's ↵), type into a terminal, list its windows. It can't read what a terminal shows.",
  tools: [open, type, list],
  events: [Heartbeat],
})
