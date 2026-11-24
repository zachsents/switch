// Where the user is, from what each Mac's extension reports (an `attention` event: input in the
// last two minutes and the screen open, or not; locked or not). Old Switchboard's rule: the user is
// at a Mac while it's unlocked and their input there is under five minutes old; of several, the one
// with the latest input. Away from every Mac, they're on their phone.
import type { Database } from "bun:sqlite"
import { extensionsEvent } from "@switch/brain"
import { Option, Schema } from "effect"

const Attention = Schema.Struct({
  machine: Schema.String,
  active: Schema.Boolean,
  locked: Schema.Boolean,
  app: Schema.optionalKey(Schema.String),
})
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Attention))

/** `active` turns false two minutes after the last input; five is the rule. */
const INACTIVE_AFTER_MS = 2 * 60_000
const HERE_MS = 5 * 60_000
/** A Mac not heard from in this long is asleep or off. */
const SILENT_MS = 30 * 60_000

export interface Mac {
  readonly machine: string
  readonly locked: boolean
  /** When the user's input there was last known, in ms. */
  readonly input: number
  /** Whether the user is at it. */
  readonly here: boolean
  readonly app: string | null
}

export const macs = (db: Database, now: number): Mac[] =>
  db
    .query<{ payload: string; time: number }, [number]>(
      `SELECT payload, time FROM events WHERE seq IN (
         SELECT max(seq) FROM events WHERE type IN (${extensionsEvent("attention")}) AND time > ?
         GROUP BY json_extract(payload, '$.machine'))`,
    )
    .all(now - 7 * 24 * 3_600_000)
    .flatMap((r) =>
      Option.match(decode(r.payload), {
        onNone: () => [],
        onSome: (a) => {
          const input = a.active ? r.time : r.time - INACTIVE_AFTER_MS
          const fresh = now - r.time < SILENT_MS || a.active
          return [
            {
              machine: a.machine,
              locked: a.locked,
              input,
              here: fresh && !a.locked && (a.active || now - input < HERE_MS),
              app: a.app ?? null,
            },
          ]
        },
      }),
    )
    .toSorted((a, b) => b.input - a.input)

/** The Mac the user is at, if any: the one with their latest input. */
export const here = (db: Database, now: number) => macs(db, now).find((m) => m.here) ?? null

/** For the agent's context: each Mac's lock, and where the user is. */
export const macsLine = (db: Database, now: number) => {
  const all = macs(db, now)
  if (all.length === 0) {
    return ""
  }
  const at = all.find((m) => m.here)
  const each = all.map((m) => {
    const state = m.locked ? "locked" : "unlocked"
    const app = m.app === null ? "" : `, ${m.app} in front`
    return m === at ? `${m.machine} ${state}, the user is at it${app}` : `${m.machine} ${state}`
  })
  return `Macs: ${each.join("; ")}${at === undefined ? "; the user is away from every Mac" : ""}`
}
