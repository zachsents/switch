// Times as data: a moment in the user's own zone, short.
import { useSyncExternalStore } from "react"

export const when = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })

let now = Date.now()
const ticks = new Set<() => void>()
let clock: ReturnType<typeof setInterval> | undefined

const subscribe = (tick: () => void) => {
  ticks.add(tick)
  clock ??= setInterval(() => {
    now = Date.now()
    for (const t of ticks) {
      t()
    }
  }, 250)
  return () => {
    ticks.delete(tick)
    if (ticks.size === 0) {
      clearInterval(clock)
      clock = undefined
    }
  }
}

/** The time now, a few times a second, on one clock for every countdown. */
export const useNow = () => useSyncExternalStore(subscribe, () => now)
