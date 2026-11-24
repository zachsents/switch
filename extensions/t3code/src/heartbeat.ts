// Whether the sense works: `t3code.heartbeat`, beaten by the watch loop itself after each look, so
// it stops when that loop does. Every five minutes, and at once when what's failing changes.
import { Cause, Effect, Schema } from "effect"
import { defineEvent } from "switch-ext-kit"
import type { AppEventsShape } from "switch-ext-kit"

const EVERY = 5 * 60_000
const LINE = 300

export const Heartbeat = defineEvent(
  "t3code.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:t3code"),
    summary: Schema.String,
    facts: Schema.Struct({
      /** What's wrong now, in one line; null when nothing is. */
      failing: Schema.NullOr(Schema.String),
      /** T3 Code answered the last look. */
      reachable: Schema.Boolean,
      threads: Schema.Finite,
      underWay: Schema.Finite,
      /** Ended turns not told yet, each tried again every look. */
      untold: Schema.Finite,
      /** Projects and threads the last look couldn't read, and waits it couldn't tell. */
      skipped: Schema.Finite,
    }),
  }),
)

type Facts = Omit<(typeof Heartbeat.payload.Type)["facts"], "failing">

export const oneLine = (s: string) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > LINE ? `${flat.slice(0, LINE - 1)}…` : flat
}

/** What failed, as one line. */
export const why = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause)
  if (typeof e === "object" && e !== null && "reason" in e && typeof e.reason === "string") {
    return oneLine(e.reason)
  }
  return oneLine(e instanceof Error ? e.message : String(e))
}

/** Runs `effect`, defects and all: null when it worked, else its error as one line. */
export const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => (exit._tag === "Success" ? null : why(exit.cause)))

/** Items that failed, as one line: the first, and how many. */
export const some = (failed: readonly (readonly [string, string])[]) => {
  const [first] = failed
  if (first === undefined) {
    return null
  }
  const line = `${first[0]}: ${first[1]}`
  return failed.length === 1 ? line : `${failed.length} skipped; ${line}`
}

/** Each part's trouble, and the beat. */
export const makeHeart = (events: AppEventsShape) => {
  const parts = new Map<string, string>()
  let told: string | null | undefined
  let at = 0

  const failing = () =>
    parts.size === 0 ? null : [...parts].map(([part, error]) => `${part}: ${error}`).join("; ")

  /** A part's trouble now; null: it works. */
  const set = (part: string, error: string | null) => {
    if (error === null) {
      parts.delete(part)
    } else {
      parts.set(part, oneLine(error))
    }
  }

  /** Beats when one is due or what's failing changed. */
  const beat = (facts: Facts) =>
    Effect.gen(function* beating() {
      const now = Date.now()
      const f = failing()
      if (f === told && now - at < EVERY) {
        return
      }
      let summary = `failing: ${[...parts.keys()].join(", ")}`
      if (f === null) {
        summary = facts.reachable
          ? `${facts.threads} open threads, ${facts.underWay} under way`
          : "T3 Code off"
      }
      yield* events.emit(
        Heartbeat.make({ entity: "sense:t3code", summary, facts: { failing: f, ...facts } }),
      )
      told = f
      at = now
    }).pipe(Effect.ignore({ log: "Warn" }))

  return { set, beat }
}
