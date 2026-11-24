// UI analytics: what the user did on a surface, felt like touch. Any app's UI emits these, under its
// app.
import { Schema } from "effect"

import type { AppEvent } from "./app.ts"
import { defineEvent } from "./events.ts"
import type { DefinedEvent, Draft } from "./events.ts"

/** `surface` is where (a screen, widget or window: "clock/timers"); `item` is what in it. */
export interface Seen {
  readonly surface: string
  readonly item?: string
}

/** Seen for a while: how long, in ms. */
export interface Stayed extends Seen {
  readonly ms: number
}

export interface Moved {
  readonly surface: string
  readonly from: string
  readonly to: string
}

const seen = { surface: Schema.String, item: Schema.optionalKey(Schema.String) }
const stayed = Schema.Struct({ ...seen, ms: Schema.Finite })

/** Came into view. */
export const Viewed: DefinedEvent<"ui.viewed", Seen> = defineEvent(
  "ui.viewed",
  1,
  Schema.Struct(seen),
)

/** Opened, then left within `BACKED_OUT_MS`. */
export const BackedOut: DefinedEvent<"ui.backed_out", Stayed> = defineEvent(
  "ui.backed_out",
  1,
  stayed,
)

/** Moved from one item to another on the same surface. */
export const Switched: DefinedEvent<"ui.switched", Moved> = defineEvent(
  "ui.switched",
  1,
  Schema.Struct({ surface: Schema.String, from: Schema.String, to: Schema.String }),
)

/** Stayed on it for `ms`, then left. */
export const Dwelled: DefinedEvent<"ui.dwelled", Stayed> = defineEvent("ui.dwelled", 1, stayed)

export const uiEvents: readonly AppEvent[] = [Viewed, BackedOut, Switched, Dwelled]

export const BACKED_OUT_MS = 2000

/** What leaving something opened at `opened` (ms) says: backed out if quick, else a dwell. */
export const left = (
  surface: string,
  item: string | undefined,
  opened: number,
  now: number = Date.now(),
): Draft => {
  const ms = Math.max(0, now - opened)
  const where = item === undefined ? { surface } : { surface, item }
  return ms < BACKED_OUT_MS ? BackedOut.make({ ...where, ms }) : Dwelled.make({ ...where, ms })
}
