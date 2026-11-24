// A page's dated plans, as Switchboard's links served them (crates/core/src/links.rs): checked, said
// in each event's own zone, linked to Google Calendar's form for adding one, and served as a
// calendar a phone or Google subscribes to, which follows the page as it changes.
import type { PageEvent } from "./records.ts"

/** Events a page may carry, at most. */
const MAX_EVENTS = 200

type When = { readonly day: Temporal.PlainDate } | { readonly at: Temporal.ZonedDateTime }

interface Dated {
  readonly title: string
  readonly start: When
  /** Exclusive: for days, the day after the last. */
  readonly end: When
  readonly location?: string
  readonly notes?: string
}

const DAY = /^\d{4}-\d{2}-\d{2}$/u
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?<offset>[+-]\d{2}:\d{2}|Z)$/u

const whenOf = (text: string): When | null => {
  const said = text.trim()
  try {
    if (DAY.test(said)) {
      return { day: Temporal.PlainDate.from(said) }
    }
    const offset = MOMENT.exec(said)?.groups?.offset
    if (offset === undefined) {
      return null
    }
    const zone = offset === "Z" ? "UTC" : offset
    return { at: Temporal.Instant.from(said).toZonedDateTimeISO(zone) }
  } catch {
    return null
  }
}

const SHAPE = "a day (2026-10-31) or a time with its UTC offset (2026-10-31T18:00-07:00)"

/** An event's end, exclusive, from what was said: of its start's kind and after it, else null. */
const endOf = (start: When, said: string | undefined): When | null => {
  if (said === undefined || said.trim() === "") {
    return "day" in start ? { day: start.day.add({ days: 1 }) } : { at: start.at.add({ hours: 1 }) }
  }
  const last = whenOf(said)
  if (last === null) {
    return null
  }
  if ("day" in start && "day" in last) {
    return Temporal.PlainDate.compare(last.day, start.day) >= 0
      ? { day: last.day.add({ days: 1 }) }
      : null
  }
  if ("at" in start && "at" in last) {
    return Temporal.ZonedDateTime.compare(last.at, start.at) > 0 ? last : null
  }
  return null
}

const trimmed = (text: string | undefined) => {
  const t = text?.trim() ?? ""
  return t === "" ? undefined : t
}

const sortKey = (w: When) => ("day" in w ? w.day.toString() : w.at.toPlainDateTime().toString())

/** A page's events, checked and in order, or what's wrong with them. */
export const datedOf = (
  events: readonly PageEvent[],
): { readonly dated: readonly Dated[] } | { readonly wrong: string } => {
  if (events.length > MAX_EVENTS) {
    return { wrong: `A page carries at most ${MAX_EVENTS} events` }
  }
  const dated: Dated[] = []
  for (const [i, e] of events.entries()) {
    const title = e.title.trim()
    if (title === "") {
      return { wrong: `Event ${i} needs a title` }
    }
    const start = whenOf(e.start)
    if (start === null) {
      return { wrong: `Event ${i} ("${title}"): its start "${e.start}" isn't ${SHAPE}` }
    }
    const end = endOf(start, e.end)
    if (end === null) {
      return {
        wrong: `Event ${i} ("${title}"): its end "${e.end ?? ""}" has to be the same kind as its start and after it (for days, the last day)`,
      }
    }
    const location = trimmed(e.location)
    const notes = trimmed(e.notes)
    dated.push({
      title,
      start,
      end,
      ...(location !== undefined && { location }),
      ...(notes !== undefined && { notes }),
    })
  }
  return { dated: dated.toSorted((a, b) => sortKey(a.start).localeCompare(sortKey(b.start))) }
}

const DAY_SAID = { weekday: "short", month: "short", day: "numeric" } as const
const TIME_SAID = { hour: "numeric", minute: "2-digit" } as const

const dayOf = (at: Temporal.ZonedDateTime) => at.toPlainDate().toLocaleString("en-US", DAY_SAID)
const timeOf = (at: Temporal.ZonedDateTime) => at.toPlainTime().toLocaleString("en-US", TIME_SAID)

/** An event's time as the page says it, in the event's own zone. */
export const said = (e: Dated) => {
  if ("day" in e.start && "day" in e.end) {
    const first = e.start.day
    const last = e.end.day.subtract({ days: 1 })
    const from = first.toLocaleString("en-US", DAY_SAID)
    return first.equals(last) ? from : `${from} – ${last.toLocaleString("en-US", DAY_SAID)}`
  }
  if ("at" in e.start && "at" in e.end) {
    const from = e.start.at
    const to = e.end.at
    const start = `${dayOf(from)} · ${timeOf(from)}`
    return from.toPlainDate().equals(to.toPlainDate())
      ? `${start} – ${timeOf(to)}`
      : `${start} – ${dayOf(to)} · ${timeOf(to)}`
  }
  return ""
}

/** As calendars write it: UTC for a moment, the date for a day. */
const stamp = (w: When) =>
  "day" in w
    ? w.day.toString().replaceAll("-", "")
    : w.at.toInstant().toString({ smallestUnit: "second" }).replaceAll(/[-:]/gu, "")

/** Google Calendar's form for adding one event, filled in. */
export const googleEvent = (e: Dated, link: string) => {
  const details = e.notes === undefined ? link : `${e.notes}\n\n${link}`
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${stamp(e.start)}/${stamp(e.end)}`,
    details,
    ...(e.location !== undefined && { location: e.location }),
  })
  return `https://calendar.google.com/calendar/render?${params.toString()}`
}

/** Text as an iCalendar value. */
const icsText = (text: string) =>
  text
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/gu, "\\n")

/** One content line, folded at 75 octets. */
const fold = (line: string) => {
  let out = ""
  let width = 0
  for (const c of line) {
    const size = Buffer.byteLength(c)
    if (width + size > 75) {
      out += "\r\n "
      width = 1
    }
    out += c
    width += size
  }
  return `${out}\r\n`
}

/**
 * The events as a calendar. Each keeps its id across versions while its title and start stay, so
 * a subscribed calendar updates what changed.
 */
export const ics = (input: {
  readonly title: string
  readonly dated: readonly Dated[]
  readonly link: string
  readonly token: string
  readonly updated: number
}) => {
  const now = stamp({
    at: Temporal.Instant.fromEpochMilliseconds(input.updated).toZonedDateTimeISO("UTC"),
  })
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Switch//Pages//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText(input.title)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ]
  for (const e of input.dated) {
    const uid = new Bun.CryptoHasher("sha256")
      .update(input.token)
      .update(e.title)
      .update(stamp(e.start))
      .digest("hex")
      .slice(0, 24)
    const when = (name: string, w: When) =>
      "day" in w ? `${name};VALUE=DATE:${stamp(w)}` : `${name}:${stamp(w)}`
    const description = e.notes === undefined ? input.link : `${e.notes}\n\n${input.link}`
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@switch`,
      `DTSTAMP:${now}`,
      when("DTSTART", e.start),
      when("DTEND", e.end),
      `SUMMARY:${icsText(e.title)}`,
      `DESCRIPTION:${icsText(description)}`,
      `URL:${input.link}`,
    )
    if (e.location !== undefined) {
      lines.push(`LOCATION:${icsText(e.location)}`)
    }
    lines.push("END:VEVENT")
  }
  lines.push("END:VCALENDAR")
  return lines.map(fold).join("")
}
