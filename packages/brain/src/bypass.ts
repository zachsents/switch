// Every check gets one bypass. The user, Nov 23, on the em dash check bouncing an agent with no
// limit: "i think pretty much all checkers should have a bypass for situations like this, no?" A
// refused call sent again with `bypass`, a line on why the check is wrong this time, goes through,
// and each bypass is recorded, so which checks get bypassed, and how often, can be read. Two never
// go through: a secret in a memory (a secret's value is never kept), and a call in the user's name,
// whose bypass becomes an approval card for them past what only they can settle, and otherwise goes
// back to the agent to fix (autonomy gate.ts, core asks.ts).
// A bypass answers a refusal that happened: one given before anything refused it is refused itself,
// and that refusal is the one a bypass sent next answers. The user, Nov 23, on a reply the agent
// sent with `bypass` already set, so the reply check's objections were never raised: "A bypass must
// answer a refusal that actually happened."
import { Effect, Schema } from "effect"

import { Brain } from "./brain.ts"
import { defineEvent } from "./defs.ts"
import { EventId } from "./ids.ts"
import { defineRead } from "./reads.ts"

export const CheckBypassed = defineEvent(
  "check.bypassed",
  1,
  Schema.Struct({
    check: Schema.String,
    /** What it objected to, by name. */
    objections: Schema.Array(Schema.String),
    reason: Schema.String,
    /** The work that bypassed it: its thread, else what the check knows it by. */
    work: Schema.String,
    space: Schema.optionalKey(Schema.String),
  }),
)

/** A plain check refused something (`unlessBypassed`): what a bypass sent next answers. */
export const CheckRefused = defineEvent(
  "check.refused",
  1,
  Schema.Struct({
    check: Schema.String,
    objections: Schema.Array(Schema.String),
    work: Schema.String,
    space: Schema.optionalKey(Schema.String),
  }),
)

export const bypassConfig = { events: [CheckBypassed, CheckRefused], projections: [], commands: [] }

/** A bypass answers a refusal made this long ago at most. */
export const ANSWERS_MS = 3600 * 1000

/** What a bypass given before any refusal is told, after the check's own refusal. */
export const EARLY =
  "A bypass answers a refusal, and nothing had refused this yet: fix what the check says, or send it again with bypass only if the check is wrong."

/** The clause a refusal ends on. */
export const BYPASS = "If the check is wrong here, send it again with bypass: why."

/** A tool input's `bypass`. */
export const Bypass = Schema.optionalKey(Schema.String)

/** The reason given, or null for none. */
export const bypassOf = (given: unknown) =>
  typeof given === "string" && given.trim() !== "" ? given.trim() : null

/** The event a bypass is recorded as. */
export const bypassEvent = (p: typeof CheckBypassed.payload.Type) => ({
  id: EventId.make(`bypass:${crypto.randomUUID()}`),
  type: CheckBypassed.type,
  source: "agent",
  payload: p,
})

/** Records a bypass. */
export const recordBypass = (p: typeof CheckBypassed.payload.Type) =>
  Effect.gen(function* recording() {
    const brain = yield* Brain
    yield* Effect.orDie(brain.ingest([bypassEvent(p)]))
  })

/** Whether a refusal of the same check, work and objections was recorded in the last hour. */
const answersRead = defineRead(
  "brain/bypass/answers",
  (db, check: string, work: string, objections: string, now: number) =>
    db
      .query(
        `SELECT 1 FROM events WHERE type = ? AND time > ? AND json_extract(payload, '$.check') = ?
           AND json_extract(payload, '$.work') = ? AND json(json_extract(payload, '$.objections')) = json(?) LIMIT 1`,
      )
      .get(CheckRefused.type, now - ANSWERS_MS, check, work, objections) !== null,
)

/**
 * A plain check's refusal; null when there's none, or it's bypassed, and then the bypass is
 * recorded. A refusal is recorded, and a bypass goes only past one recorded for the same check and
 * work in the last hour.
 */
export const unlessBypassed = (
  refusal: string | null,
  bypass: string | null,
  at: Omit<typeof CheckBypassed.payload.Type, "reason">,
) =>
  Effect.gen(function* checking() {
    if (refusal === null) {
      return null
    }
    const brain = yield* Brain
    const objections = JSON.stringify(at.objections)
    const answers =
      bypass !== null && (yield* brain.read(answersRead, at.check, at.work, objections, Date.now()))
    if (bypass !== null && answers) {
      yield* recordBypass({ ...at, reason: bypass })
      return null
    }
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`refused:${crypto.randomUUID()}`),
          type: CheckRefused.type,
          source: "agent",
          payload: at,
        },
      ]),
    )
    return bypass === null ? refusal : `${refusal} ${EARLY}`
  })
