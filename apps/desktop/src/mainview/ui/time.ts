// Times as the screen shows them, with Temporal: a day, a time of day, how long.
const zoned = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(Temporal.Now.timeZoneId())

/** "Friday, Nov 20". */
export const dayOf = (ms: number) =>
  zoned(ms).toLocaleString([], { weekday: "long", month: "short", day: "numeric" })

/** "2:00 PM". */
export const timeOf = (ms: number) =>
  zoned(ms).toLocaleString([], { hour: "numeric", minute: "2-digit" })

/** When a line was said: "2:00 PM" today, "Nov 12, 2:00 PM" before, with the year if not this one. */
export const whenOf = (ms: number) => {
  const at = zoned(ms)
  const today = Temporal.Now.plainDateISO()
  if (Temporal.PlainDate.compare(at.toPlainDate(), today) === 0) {
    return timeOf(ms)
  }
  return at.toLocaleString([], {
    month: "short",
    day: "numeric",
    ...(at.year !== today.year && { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  })
}

/** A line's stamp beside it, kept short: "2:00 PM" today, "Nov 12" before. */
export const stampOf = (ms: number) => {
  const at = zoned(ms)
  return Temporal.PlainDate.compare(at.toPlainDate(), Temporal.Now.plainDateISO()) === 0
    ? timeOf(ms)
    : at.toLocaleString([], { month: "short", day: "numeric" })
}

const two = (n: number) => String(n).padStart(2, "0")

/** A span as a clock: "4:05", or "1:04:05" past an hour; "1:05" to the minute. */
export const spanOf = (ms: number, to: "second" | "minute" = "second") => {
  const d = Temporal.Duration.from({ milliseconds: Math.max(0, Math.trunc(ms)) }).round({
    largestUnit: "hour",
    smallestUnit: to,
    roundingMode: to === "second" ? "trunc" : "halfExpand",
  })
  if (to === "minute") {
    return `${d.hours}:${two(d.minutes)}`
  }
  return d.hours > 0
    ? `${d.hours}:${two(d.minutes)}:${two(d.seconds)}`
    : `${d.minutes}:${two(d.seconds)}`
}

/** How long ago, as a sign says it: "4m", "6h", "3d". */
export const ageOf = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}
