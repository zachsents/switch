// Whether the sense works: `contacts.heartbeat`, beaten by the senders loop itself, so it stops
// when that loop does. Every five minutes, and at once when what's failing changes or it falls
// behind the brain's messages or catches up.
import { AppEvents, defineEvent } from "switch-ext-kit"
import { Cause, Effect, Schema } from "effect"

const EVERY = 5 * 60_000
/** A round's own time: a beat due within this is beaten now. */
const SLACK = 30_000
const LINE = 300

export const Heartbeat = defineEvent(
  "contacts.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:contacts"),
    summary: Schema.String,
    facts: Schema.Struct({
      /** What's wrong now, in one line; null when nothing is. */
      failing: Schema.NullOr(Schema.String),
      people: Schema.Finite,
      /** Records and events not taken in or sent on, each tried again the next round. */
      skipped: Schema.Finite,
      /** 0 when its last look found every message read, else how long since one did. */
      behind_ms: Schema.Finite,
    }),
  }),
)

export type Facts = Omit<(typeof Heartbeat.payload.Type)["facts"], "failing">

export const oneLine = (s: string) => {
  const flat = s.replaceAll(/\s+/gu, " ").trim()
  return flat.length > LINE ? `${flat.slice(0, LINE - 1)}…` : flat
}

/** What failed, as one line. */
export const why = (cause: Cause.Cause<unknown>) => {
  const e = Cause.squash(cause)
  return oneLine(e instanceof Error ? e.message : String(e))
}

/** Runs `effect`, defects and all: null when it worked, else its error as one line. */
export const attempt = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => (exit._tag === "Success" ? null : why(exit.cause)))

/** Several failures as one line: how many, and the first. */
export const several = (errors: readonly string[]) => {
  const [first] = errors
  if (first === undefined) {
    return null
  }
  return errors.length === 1 ? first : `${errors.length} failed; ${first}`
}

const parts = new Map<string, string>()
let told: string | null | undefined
let toldBehind = false
let at = 0

const failing = () =>
  parts.size === 0 ? null : [...parts].map(([part, error]) => `${part}: ${error}`).join("; ")

/** A part's trouble now; null: it works. */
export const setFailing = (part: string, error: string | null) => {
  if (error === null) {
    parts.delete(part)
  } else {
    parts.set(part, oneLine(error))
  }
}

/** Beats when one is due (`round`: the senders loop calling) or what's failing changed. */
export const beat = <E, R>(round: boolean, facts: Effect.Effect<Facts, E, R>) =>
  Effect.gen(function* beating() {
    const now = Date.now()
    const f = failing()
    const known = yield* facts
    const late = known.behind_ms > 0
    if (f === told && late === toldBehind && !(round && now - at >= EVERY - SLACK)) {
      return
    }
    const events = yield* AppEvents
    const summary =
      parts.size === 0 ? `${known.people} people` : `failing: ${[...parts.keys()].join(", ")}`
    yield* events.emit(
      Heartbeat.make({ entity: "sense:contacts", summary, facts: { failing: f, ...known } }),
    )
    told = f
    toldBehind = late
    // Only the senders loop's own beats set when the next is due, so one on a change never
    // pushes it back.
    if (round) {
      at = now
    }
  }).pipe(Effect.ignore({ log: "Warn" }))
