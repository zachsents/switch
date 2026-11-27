// Each account's usage limits over time, as a widget: a graph for its 5-hour window and one for its
// 7-day window, the share used along the window up to its reset, the limit across the top. Worked
// out of the `account.state` events as it's asked (each is a reading of the windows as a turn's
// limits arrive), nothing kept; refreshed by them.
import type { Database } from "bun:sqlite"
import { allAccounts } from "@switch/agent"
import type { Account } from "@switch/agent"
import { defineRead } from "@switch/brain"
import { BASIC_CATALOG, SWITCH_CATALOG } from "switch-ext-kit"
import { Schema } from "effect"

import { CatalogUpdated, profilesState } from "./profiles.ts"

/** An account's name, beside its figures. */
const NAME = 26

/** A name longer than a line holds, cut in its middle: an email keeps its start and its domain. */
const middle = (text: string, max = NAME) => {
  if (text.length <= max) {
    return text
  }
  const head = Math.ceil((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

/** Each login's email as the catalog has it, by its id and the ids found the same account. */
const emailsOf = (db: Database) => {
  const emails = new Map<string, string>()
  for (const a of profilesState(db).accounts) {
    if (a.email !== undefined && a.email !== null && a.email !== "") {
      for (const host of [a.host, ...(a.same ?? [])]) {
        emails.set(host, a.email)
      }
    }
  }
  return emails
}

/**
 * Each account's name, by its host: the email its login reports (with its provider when another
 * provider's login has it too), else its id.
 */
export const accountNames = (db: Database, listed: readonly Account[]) => {
  const emails = emailsOf(db)
  return new Map(
    listed.map((a) => {
      const email = emails.get(a.host)
      const shared =
        email !== undefined &&
        listed.some(
          (b) => b.host !== a.host && b.provider !== a.provider && emails.get(b.host) === email,
        )
      const [provider = a.host, ...rest] = a.host.split("-")
      const name = `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
      const id = a.host.includes(":") ? a.host : [name, ...rest].join(" ")
      return [a.host, email === undefined ? id : middle(shared ? `${name} ${email}` : email)]
    }),
  )
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The windows graphed: what each is called in a reading (Claude's, Codex's), and its length. */
const WINDOWS = [
  { label: "5h", names: ["five_hour", "5h"], length: 5 * HOUR },
  { label: "7d", names: ["seven_day", "7d"], length: 7 * DAY },
] as const
type Graphed = (typeof WINDOWS)[number]

/** How far back a graph reaches from its window's reset: the window, else a span, if longer. */
export const SPANS = ["window", "day", "week", "month"] as const
type Span = (typeof SPANS)[number]
const SPAN_MS: Readonly<Record<Span, number>> = {
  window: 0,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
}

/** A graph's points at most, and the steps they're taken at. */
const POINTS = 180
const STEPS = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440].map((m) => m * MINUTE)

export const UsageInput = Schema.Struct({
  /** Which accounts, by email or id; every one when none. */
  accounts: Schema.optionalKey(Schema.Array(Schema.String)),
  span: Schema.optionalKey(Schema.Literals(SPANS)),
})
export type UsageInput = typeof UsageInput.Type

interface Reading {
  readonly at: number
  readonly windows: readonly {
    readonly name: string
    readonly used: number
    readonly resetsAt: number
  }[]
}

const decodeReading = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      host: Schema.String,
      windows: Schema.Array(
        Schema.Struct({ name: Schema.String, used: Schema.Number, resetsAt: Schema.Number }),
      ),
    }),
  ),
)

/** Every account's readings since `since`, by host, oldest first. */
const readingsSince = (db: Database, since: number) => {
  const out = new Map<string, Reading[]>()
  const rows = db
    .query<{ time: number; payload: string }, [number]>(
      "SELECT time, payload FROM events INDEXED BY events_time_type WHERE time >= ? AND type = 'account.state' ORDER BY time",
    )
    .all(since)
  for (const r of rows) {
    const p = decodeReading(r.payload)
    if (p._tag === "Some") {
      const list = out.get(p.value.host) ?? []
      list.push({ at: r.time, windows: p.value.windows })
      out.set(p.value.host, list)
    }
  }
  return out
}

const windowOf = (r: Reading, w: Graphed) =>
  r.windows.find((x) => w.names.some((n) => n === x.name))

/**
 * The share of a window used at `t`, in percent, from the latest reading by then: none before the
 * first, or when that reading has no windows at all (it couldn't be read); 0 once its window has
 * reset or when it has none running.
 */
const usedAt = (readings: readonly Reading[], w: Graphed, t: number) => {
  let last: Reading | undefined
  for (const r of readings) {
    if (r.at > t) {
      break
    }
    last = r
  }
  if (last === undefined || last.windows.length === 0) {
    return null
  }
  const found = windowOf(last, w)
  return found === undefined || found.resetsAt <= t ? 0 : Math.round(found.used * 1000) / 10
}

const zone = () => Temporal.Now.timeZoneId()
const local = (t: number) => Temporal.Instant.fromEpochMilliseconds(t).toZonedDateTimeISO(zone())

/** A point's time, as its tooltip says it: the clock time, with its weekday past a day. */
const pointLabel = (t: number, long: boolean) =>
  local(t).toLocaleString(
    "en-US",
    long
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { hour: "numeric", minute: "2-digit" },
  )

/** The ticks along a graph of `span` ms: every hour or so for hours, days for a week, weeks past. */
const tickOf = (span: number) => {
  if (span <= 6 * HOUR) {
    return { hours: 1 }
  }
  if (span <= 12 * HOUR) {
    return { hours: 3 }
  }
  if (span <= 2 * DAY) {
    return { hours: 6 }
  }
  return span <= 10 * DAY ? { days: 1 } : { days: 7 }
}

const tickKey = (t: number, every: { hours: number } | { days: number }) => {
  const at = local(t)
  if ("hours" in every) {
    return `${at.toPlainDate().toString()} ${Math.floor(at.hour / every.hours)}`
  }
  return every.days === 1
    ? at.toPlainDate().toString()
    : String(Math.floor(at.toPlainDate().since("1970-01-05").days / 7))
}

const tickWords = (t: number, every: { hours: number } | { days: number }) => {
  const at = local(t)
  if ("hours" in every) {
    return at.toLocaleString("en-US", { hour: "numeric" })
  }
  return every.days === 1
    ? at.toLocaleString("en-US", { weekday: "short" })
    : at.toLocaleString("en-US", { month: "short", day: "numeric" })
}

/** When a window resets, as the user reads it: today's by the clock, else its weekday and hour. */
const resetWords = (at: number, now: number) => {
  const d = local(at)
  return d.toPlainDate().equals(local(now).toPlainDate())
    ? d.toLocaleString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString("en-US", { weekday: "short", hour: "numeric" })
}

/** One window's graph: from `span` (at least the window) before its reset to its reset. */
const graphOf = (readings: readonly Reading[], w: Graphed, span: Span, now: number) => {
  const latest = readings.at(-1)
  const current = latest && windowOf(latest, w)
  const resets = current !== undefined && current.resetsAt > now ? current.resetsAt : null
  if (!readings.some((r) => windowOf(r, w) !== undefined)) {
    return null
  }
  const reach = Math.max(w.length, SPAN_MS[span])
  // A window running ends at its reset; none running, the graph ends now.
  const end = resets ?? now
  const step = STEPS.find((s) => reach / s <= POINTS) ?? DAY
  const from = Math.ceil((end - reach) / step) * step
  const times: number[] = []
  for (let t = from; t <= end; t += step) {
    times.push(t)
  }
  const values = times.map((t) => (t > now ? null : usedAt(readings, w, t)))
  // The latest point holds what's used now, which a step's start may not have seen yet.
  const past = times.findLastIndex((t) => t <= now)
  if (past !== -1) {
    values[past] = usedAt(readings, w, now)
  }
  if (values.every((v) => v === null)) {
    return null
  }
  const every = tickOf(reach)
  const long = reach > DAY
  return {
    label: w.label,
    values: resets === null ? [] : [resetWords(resets, now)],
    labels: times.map((t) => pointLabel(t, long)),
    ticks: times.map((t, i) => {
      const prev = times[i - 1]
      return prev !== undefined && tickKey(prev, every) !== tickKey(t, every)
        ? tickWords(t, every)
        : ""
    }),
    series: [{ name: w.label, values }],
  }
}

/** Each login's other ids (its email's other logins), by its host. */
const sameOf = (db: Database) => {
  const out = new Map<string, readonly string[]>()
  for (const a of profilesState(db).accounts) {
    out.set(a.host, a.same ?? [])
  }
  return out
}

/** What's wrong with an account, said plainly: signed out, at a limit until, or down. */
const troubleOf = (a: Account, now: number) => {
  if (a.problem !== "") {
    return { mark: "stop", detail: a.problem, alert: true }
  }
  if (a.limitedUntil > now) {
    return { mark: "warn", detail: `Limited until ${resetWords(a.limitedUntil, now)}`, alert: true }
  }
  return a.up ? {} : { mark: "stop", detail: "Down", alert: true }
}

/** The accounts' graphs, as of `now`: one line each, its trouble said, its windows under it. */
const usageOf = (db: Database, input: UsageInput, now: number) => {
  const span = input.span ?? "window"
  const reach = Math.max(...WINDOWS.map((w) => w.length), SPAN_MS[span])
  // A reading before a graph's start carries on into it: one a window back is enough.
  const readings = readingsSince(db, now - reach - 7 * DAY)
  const same = sameOf(db)
  const chosen = input.accounts
  const listed = allAccounts(db)
  const names = accountNames(db, listed)
  const accounts = listed.flatMap((a) => {
    const label = names.get(a.host) ?? a.host
    if (
      chosen !== undefined &&
      chosen.length > 0 &&
      !chosen.some((c) => c === a.host || c === label || label.endsWith(` ${c}`))
    ) {
      return []
    }
    // Its own readings and those of the logins found to be it.
    const mine = [a.host, ...(same.get(a.host) ?? [])]
      .flatMap((h) => readings.get(h) ?? [])
      .toSorted((x, y) => x.at - y.at)
    const trouble = troubleOf(a, now)
    const signedOut = a.problem !== ""
    const graphs = signedOut ? [] : WINDOWS.flatMap((w) => graphOf(mine, w, span, now) ?? [])
    // A window at nothing all along is said beside the name, not drawn.
    const idle = (g: (typeof graphs)[number]) =>
      g.series.every((s) => s.values.every((v) => v === null || v === 0))
    const charts = graphs.filter((g) => !idle(g))
    // A window never seen in its readings has none running: at nothing too.
    const read = mine.some((r) => r.windows.length > 0)
    const values = signedOut
      ? []
      : WINDOWS.flatMap((w) => {
          const g = graphs.find((x) => x.label === w.label)
          return (g === undefined && read) || (g !== undefined && idle(g)) ? [`${w.label} 0%`] : []
        })
    if (graphs.length === 0 && !signedOut) {
      return []
    }
    // A signed-out account only if it was graphed before: one never read isn't missed.
    if (signedOut && !mine.some((r) => r.windows.length > 0)) {
      return []
    }
    return [{ label, ...trouble, values, charts }]
  })
  // The signed-out under the rest.
  return {
    accounts: accounts.toSorted(
      (a, b) => Number(a.charts.length === 0) - Number(b.charts.length === 0),
    ),
  }
}

/** The accounts' graphs, as of `now`. */
export const usageRead = defineRead("core/usage/usage", usageOf)

/** What changes the graphs: a reading, an account gone, the emails the catalog finds. */
export const USAGE_REFRESH = ["account.state", "account.removed", CatalogUpdated.type]

/** A line per account, its name and its trouble; under it a column per window, its name and when
 * it resets over its graph, the share used up to the limit. */
export const usageA2ui = () => [
  { version: "1.0", createSurface: { surfaceId: "usage", catalogId: SWITCH_CATALOG } },
  {
    version: "1.0",
    updateComponents: {
      surfaceId: "usage",
      components: [
        {
          id: "root",
          component: "List",
          catalogId: BASIC_CATALOG,
          children: { componentId: "account", path: "/accounts" },
        },
        {
          id: "account",
          component: "Row",
          label: { "@path": "label" },
          mark: { "@path": "mark" },
          detail: { "@path": "detail" },
          alert: { "@path": "alert" },
          values: { "@path": "values" },
          children: { componentId: "window", path: "charts" },
        },
        {
          id: "window",
          component: "Column",
          catalogId: BASIC_CATALOG,
          children: ["head", "graph"],
        },
        {
          id: "head",
          component: "Row",
          label: { "@path": "label" },
          values: { "@path": "values" },
        },
        {
          id: "graph",
          component: "AreaChart",
          labels: { "@path": "labels" },
          ticks: { "@path": "ticks" },
          series: { "@path": "series" },
          suffix: "%",
          max: 100,
          limit: 100,
          height: 96,
        },
      ],
    },
  },
]
