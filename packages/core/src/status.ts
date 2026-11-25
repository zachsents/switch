// Switch's own parts at a glance, as a widget: the core, each machine with its app and its
// extensions, the iPhone, the accounts, the backup and the app's feed, and what's wrong that none of
// them owns. Worked out from the brain (and the core's own folder) as it's asked, nothing kept;
// refreshed by the events that change it. A part that's well is its name and its figures; one that's
// broken has the red mark and what's wrong.
import type { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import path from "node:path"
import { allAccounts } from "@switch/agent"
import type { Account } from "@switch/agent"
import { openSurprises } from "@switch/autonomy"
import type { Surprise } from "@switch/autonomy"
import { Brain, defineRead, extensionsEvent, seqAt } from "@switch/brain"
import { BASIC_CATALOG, defineApp, SWITCH_CATALOG, tool } from "switch-ext-kit"
import { Effect } from "effect"

import { CoreConfig } from "./config.ts"
import { CatalogUpdated, profilesState } from "./profiles.ts"
import { RELEASE } from "./release.ts"
import { Runtime } from "./runtime.ts"
import type { MachineView } from "./runtime.ts"

const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Free disk under this is broken, as the Macs' vitals warn. */
const LOW_DISK_GB = 10
/** Memory used past this is worth showing. */
const HIGH_MEMORY_PCT = 80
/** A stall is news this long. */
const STALL_SHOWN_MS = 2 * HOUR
/** What's wrong, said beside a part's name: its first clause, the whole on hover. */
const GIST = 60
/** An account's name, beside its figures. */
const NAME = 26
/** The nightly backup missed once and a bit. */
const BACKUP_LATE_MS = 30 * HOUR
/** An iPhone build is the minute it was made since the epoch (scripts/ios.sh): one past 2020's.
 * A build run from Xcode is numbered 1: a development copy. */
const MINUTES_2020 = 26_300_000

type Mark = "stop" | "warn"

interface Line {
  readonly label: string
  readonly values?: readonly string[]
  readonly mark?: Mark
  readonly detail?: string
  /** The detail in full, while the pointer is over it, when it was said short. */
  readonly note?: string
  readonly alert?: boolean
}

const short = (sha: string) => sha.slice(0, 7)

/** Today's as a clock time, earlier days as a date. */
const when = (at: number, now: number) => {
  const d = new Date(at)
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** A time ahead: its clock time today, else its weekday and hour. */
const until = (at: number, now: number) => {
  const d = new Date(at)
  return d.toDateString() === new Date(now).toDateString()
    ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString("en-US", { weekday: "short", hour: "numeric" })
}

/** A part with what's wrong with it, or as it is. */
const broken = (line: Line, mark: Mark, detail: string | undefined): Line => {
  if (detail === undefined) {
    return line
  }
  const gist = clause(detail)
  return gist === detail
    ? { ...line, mark, detail, alert: true }
    : { ...line, mark, detail: gist, note: detail, alert: true }
}

/** A sentence's first clause (before a parenthesis, a semicolon or the next sentence), short. */
const clause = (text: string) => {
  const first = text.split(/ \(|; |\. |, so /u)[0] ?? text
  const words = first.replace(/[.,:]$/u, "")
  return words.length <= GIST ? words : `${words.slice(0, GIST - 1).trimEnd()}…`
}

interface Row {
  readonly payload: string
  readonly time: number
}
const parse: (json: string) => unknown = JSON.parse
const record = (json: string): Record<string, unknown> => {
  const v = parse(json)
  return typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v)) : {}
}
const str = (r: Record<string, unknown>, k: string) => {
  const v = r[k]
  return typeof v === "string" ? v : ""
}
const num = (r: Record<string, unknown>, k: string) => {
  const v = r[k]
  return typeof v === "number" ? v : null
}

/** Each key's latest of an event type's (or types') since `after`, by a payload field. */
const latestBy = (db: Database, types: string, field: string, after: number) => {
  const rows = db
    .query<Row & { key: string }, [number]>(
      `SELECT e.payload, e.time, k.key FROM events e JOIN (
         SELECT max(seq) AS seq, json_extract(payload, '$.${field}') AS key FROM events INDEXED BY events_type
          WHERE type IN (${types}) AND seq >= ? GROUP BY key) k ON e.seq = k.seq`,
    )
    .all(after)
  return new Map(rows.map((r) => [r.key, { ...record(r.payload), at: r.time }]))
}

const quoted = (...types: readonly string[]) => types.map((t) => `'${t}'`).join(", ")

/** What a surprise is about, by its id (the senses watch's, the backup's, an alarm's), if a part. */
type About =
  | { readonly on: "extension"; readonly extension: string; readonly machine: string | null }
  | { readonly on: "machine"; readonly machine: string }
  | { readonly on: "backup" }
  | { readonly on: "phone" }

/** The senses watch's: an extension's (or a host's) runs, heartbeats and calls. */
const sensed = (s: Surprise, extensions: readonly string[]): About | null => {
  const at = /^(?:stopped|crashing):(?<name>[^@]+)@(?<machine>.+)$/u.exec(s.id)?.groups
  if (at?.name !== undefined && at.machine !== undefined) {
    return at.name === "host"
      ? { on: "machine", machine: at.machine }
      : { on: "extension", extension: at.name, machine: at.machine }
  }
  // A heartbeat's: `<type> from <source>`, its source the extension or `<extension>-<machine>`.
  const beat = /^(?:failing|quiet):(?<name>[^.\s]+)\.\S* from (?<source>\S+)/u.exec(s.id)?.groups
  if (beat?.name !== undefined && beat.source !== undefined && extensions.includes(beat.name)) {
    const prefix = `${beat.name}-`
    const machine = beat.source.startsWith(prefix) ? beat.source.slice(prefix.length) : null
    return { on: "extension", extension: beat.name, machine }
  }
  const call = /^(?:calls|link):(?<name>.+)$/u.exec(s.id)?.groups
  if (call?.name !== undefined && extensions.includes(call.name)) {
    return { on: "extension", extension: call.name, machine: null }
  }
  return null
}

const aboutOf = (s: Surprise, extensions: readonly string[]): About | null => {
  const part = sensed(s, extensions)
  if (part !== null) {
    return part
  }
  const alarm = /^alarm:[^:]+:(?<machine>.+)$/u.exec(s.id)?.groups
  if (alarm?.machine !== undefined) {
    return { on: "machine", machine: alarm.machine }
  }
  if (s.id.startsWith("backup:")) {
    return { on: "backup" }
  }
  if (s.id.startsWith("push:")) {
    return { on: "phone" }
  }
  // One the agent named after an extension: `<extension>-…`, the longest that fits.
  const named = extensions
    .filter((e) => s.id.startsWith(`${e}-`))
    .toSorted((a, b) => b.length - a.length)
  return named[0] === undefined ? null : { on: "extension", extension: named[0], machine: null }
}

/** What a part's surprise says, without the part's own name before it ("slack.heartbeat from slack
 * says: ", "business-identity on the Mac mini answers "): the words beside its name. */
const said = (s: Surprise, name: string) => {
  const words = s.text.replace(/^\S+ from \S+(?: \([^)]*\))? says: /u, "")
  const rest = words.startsWith(`${name} `) ? words.slice(name.length + 1) : words
  const trimmed = rest.replace(/^on the [^,]+? (?=answers|is|has|says)/u, "")
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`
}

const markOf = (s: Surprise): Mark => (s.kind === "stopped" ? "stop" : "warn")

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

const accountLine = (
  a: Account,
  email: string | undefined,
  shared: boolean,
  now: number,
): Line | null => {
  const limited = a.limitedUntil > now
  const down = !a.up && !limited ? "Down" : undefined
  const fails = a.problem === "" ? down : a.problem
  if (a.windows.length === 0 && !limited && fails === undefined) {
    return null
  }
  const [provider = a.host, ...rest] = a.host.split("-")
  const name = `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`
  // By the email its login reports (with its provider when another's login has it too), else its id.
  const id = a.host.includes(":") ? a.host : [name, ...rest].join(" ")
  const label = email === undefined ? id : middle(shared ? `${name} ${email}` : email)
  const windows = a.windows.map((w) => {
    const span = w.name.replace("five_hour", "5h").replace("seven_day", "7d")
    return `${span} ${Math.round(w.used * 100)}%`
  })
  // Limited, it's only when it's back: its windows say nothing until then.
  const line: Line = limited
    ? { label, values: [`until ${until(a.limitedUntil, now)}`], mark: "warn" }
    : { label, values: windows }
  return broken(line, "stop", fails)
}

const readJson = (file: string) => {
  try {
    return record(readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

const readNumber = (file: string) => {
  try {
    const n = Number(readFileSync(file, "utf-8").trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** A stall's length, the latest if it's recent. */
const stallOf = (stall: Row | null): string[] => {
  const ms = stall === null ? null : num(record(stall.payload), "ms")
  return ms === null ? [] : [`stall ${(ms / 1000).toFixed(1)} s`]
}

/** A machine's free disk, and its memory only when it's high: well, it says nothing. */
const figures = (free: number | null, memory: number | null): string[] => [
  ...(free === null ? [] : [`${free < 10 ? free.toFixed(1) : Math.round(free)} GB free`]),
  ...(memory === null || memory < HIGH_MEMORY_PCT ? [] : [`${Math.round(memory)}% mem`]),
]

/** An iPhone build: the day it was made, or a development copy's. */
const buildOf = (build: number, now: number): string[] => {
  if (build > MINUTES_2020) {
    return [when(build * 60_000, now)]
  }
  return build > 0 ? ["dev"] : []
}

interface Group {
  readonly rows: readonly Line[]
}

/** The widget's data: its groups of lines, the broken first among each machine's extensions. */
export const statusOf = (
  db: Database,
  dir: string,
  machines: readonly MachineView[],
  now: number,
): { readonly groups: readonly Group[] } => {
  const installed = db
    .query<{ extension: string }, []>("SELECT extension FROM extensions ORDER BY extension")
    .all()
    .map((r) => r.extension)
  const surprises = openSurprises(db)
  const owned = new Map<Surprise, About>()
  for (const s of surprises) {
    const about = aboutOf(s, installed)
    if (about !== null) {
      owned.set(s, about)
    }
  }
  const wrong = (is: (a: About) => boolean) =>
    [...owned.entries()].find(([, a]) => is(a))?.[0] ?? null

  const week = seqAt(db, now - 7 * DAY)
  const day = seqAt(db, now - DAY)

  // The core: its commit, its last stall, the app's feed and the backup.
  const stall = db
    .query<Row, []>(
      "SELECT payload, time FROM events INDEXED BY events_type WHERE type = 'core.stalled' ORDER BY seq DESC LIMIT 1",
    )
    .get()
  const feed = readJson(path.join(dir, "updates-gpui", "update.json"))
  const feedHash = feed === null ? "" : str(feed, "hash")
  const held =
    readNumber(path.join(dir, "app-hold")) !== null || readJson(path.join(dir, "app-hold")) !== null
  const backup = readNumber(path.join(dir, "backup-last"))
  const backupWrong = wrong((a) => a.on === "backup")
  const late = backup === null || now - backup * 1000 > BACKUP_LATE_MS
  // The core on one line: its commit, a recent stall, the app's updates if held, a late backup.
  const recent = stall !== null && now - stall.time <= STALL_SHOWN_MS ? stall : null
  const core: Line[] = [
    broken(
      {
        label: "Core",
        values: [
          RELEASE === null ? "dev" : short(RELEASE),
          ...stallOf(recent),
          ...(held ? ["updates held"] : []),
          ...(backup !== null && late ? [`backup ${when(backup * 1000, now)}`] : []),
        ],
      },
      "warn",
      backupWrong?.text ?? (late ? "Backup late" : undefined),
    ),
  ]

  // Each machine: its disk and memory, its app, its extensions.
  const vitals = latestBy(db, extensionsEvent("vitals"), "machine", day)
  const names = latestBy(db, extensionsEvent("device"), "machine", week)
  const apps = latestBy(db, quoted("client.reported"), "device", 0)
  // The machine running the most first: the core's, as a rule.
  const byLoad = machines.toSorted((a, b) => b.extensions.length - a.extensions.length)
  const machineGroups = byLoad.map((m): Group => {
    const v = vitals.get(m.machine)
    const name = names.get(m.machine)
    const called = name ? str(name, "name") : ""
    const label = called === "" ? m.machine : called
    const free = v ? num(v, "diskFreeGb") : null
    const memory = v ? num(v, "memoryPct") : null
    const machineWrong = wrong((a) => a.on === "machine" && a.machine === m.machine)
    const critical = v !== undefined && str(v, "pressure") === "critical"
    let vitalsWrong = critical ? "Memory critical" : machineWrong?.text
    if (free !== null && free < LOW_DISK_GB) {
      vitalsWrong = `${free.toFixed(0)} GB free`
    }
    const head = m.online
      ? broken(
          {
            label,
            values: figures(free, memory),
          },
          "warn",
          vitalsWrong,
        )
      : broken({ label }, "stop", "Offline")
    const app = apps.get(m.machine)
    const appHash = app ? str(app, "hash") : ""
    // Its app only while it's behind the feed: the update it hasn't taken.
    const appLine: Line[] =
      appHash === "" || feedHash === "" || feedHash === appHash
        ? []
        : [{ label: "App", values: [`${short(appHash)} → ${short(feedHash)}`] }]
    const extensions = m.extensions
      .map((e): Line => {
        const s = wrong(
          (a) =>
            a.on === "extension" &&
            a.extension === e.name &&
            (a.machine === null || a.machine === m.machine),
        )
        const line: Line = { label: e.name }
        if (!e.running) {
          return broken(line, "stop", s ? said(s, e.name) : "Stopped")
        }
        return s === null ? line : broken(line, markOf(s), said(s, e.name))
      })
      .toSorted((a, b) => a.label.localeCompare(b.label))
    // The broken by name, under it; the rest, which are well, a count on its line.
    const bad = extensions.filter((e) => e.alert === true)
    const well = extensions.length - bad.length
    const counted = well === 0 ? head : { ...head, values: [...(head.values ?? []), `${well} ext`] }
    return { rows: [counted, ...appLine, ...bad] }
  })

  // The iPhone: its build, by when it was made. Each phone by its name, its latest install's.
  const phones = new Map<string, Record<string, unknown> & { readonly at: number }>()
  for (const p of latestBy(db, quoted("iphone.reported"), "device", week).values()) {
    const was = phones.get(str(p, "name"))
    if (was === undefined || was.at < p.at) {
      phones.set(str(p, "name"), p)
    }
  }
  const phoneWrong = wrong((a) => a.on === "phone")
  const phoneRows = [...phones.values()].map((p) => {
    const build = Number(str(p, "build"))
    const notifications = str(p, "notifications")
    const off = notifications !== "" && notifications !== "allowed"
    return broken(
      {
        label: str(p, "name") || "iPhone",
        values: buildOf(build, now),
      },
      "warn",
      off ? "Notifications off" : phoneWrong?.text,
    )
  })

  const emails = emailsOf(db)
  const listed = allAccounts(db)
  const accounts = listed.flatMap((a) => {
    const email = emails.get(a.host)
    const shared =
      email !== undefined &&
      listed.some(
        (b) => b.host !== a.host && b.provider !== a.provider && emails.get(b.host) === email,
      )
    return accountLine(a, email, shared, now) ?? []
  })

  // What's wrong that no part owns. A promise or a watch of the agent's (`broken:`) is its own
  // work, not a part of Switch, and isn't here.
  const loose = surprises
    .filter((s) => !owned.has(s) && !s.id.startsWith("broken:"))
    .map((s): Line => {
      const told = /^(?:The )?(?<who>.+?) (?:reports|says|answers) '(?<what>[^']+)'/u.exec(
        s.text,
      )?.groups
      if (told?.who !== undefined && told.what !== undefined && told.who.length <= 32) {
        return { label: told.who, mark: markOf(s), detail: told.what, note: s.text, alert: true }
      }
      const gist = clause(s.text)
      return { label: gist, mark: markOf(s), ...(gist === s.text ? {} : { note: s.text }) }
    })

  return {
    groups: [
      { rows: loose },
      { rows: core },
      ...machineGroups,
      { rows: phoneRows },
      { rows: accounts },
    ].filter((g) => g.rows.length > 0),
  }
}

/** What changes a part: its runs, its surprises, its readings, its reports. */
const REFRESH = [
  "extension.up",
  "extension.down",
  "extension.installed",
  "extension.removed",
  "extension.placed",
  "extension.updated",
  "machine.reported",
  "surprise.raised",
  "surprise.resolved",
  "surprise.dismissed",
  "account.state",
  "account.removed",
  CatalogUpdated.type,
  "core.stalled",
  "client.reported",
  "iphone.reported",
  "*.vitals",
]

/** Every part of Switch and how it stands, as of `now`. */
const statusRead = defineRead("core/status/status", statusOf)

const status = tool(
  "status",
  {
    description:
      "Every part of Switch and how it stands: the core's commit and last stall, the app's feed, the backup, each machine's disk and memory, its app and its extensions (running or not), the iPhone's build, the accounts' usage, and open surprises no part owns.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* reading() {
      const brain = yield* Brain
      const c = yield* CoreConfig
      const runtime = yield* Runtime
      const { machines } = yield* runtime.machines
      return yield* brain.read(statusRead, c.dir, machines, Date.now())
    }),
)

export const statusApp = defineApp<Brain | CoreConfig | Runtime>({
  name: "system",
  version: "1",
  instructions: "Switch's own parts and how each stands.",
  tools: [status],
  widgets: [
    {
      name: "status",
      title: "Status",
      surfaces: ["space"],
      resource: "ui://system/status",
      tool: "status",
      refresh: REFRESH,
      size: { aspect: "auto" },
      // A group per part (the switch's, each machine's, the phone's, the accounts'), a hairline
      // between; a line per part: the house's Row with its mark, name, what's wrong and figures.
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "status", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "status",
            components: [
              {
                id: "root",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "group", path: "/groups" },
              },
              { id: "group", component: "Card", catalogId: BASIC_CATALOG, child: "rows" },
              {
                id: "rows",
                component: "List",
                catalogId: BASIC_CATALOG,
                children: { componentId: "row", path: "rows" },
              },
              {
                id: "row",
                component: "Row",
                label: { "@path": "label" },
                mark: { "@path": "mark" },
                detail: { "@path": "detail" },
                note: { "@path": "note" },
                alert: { "@path": "alert" },
                values: { "@path": "values" },
              },
            ],
          },
        },
      ],
    },
  ],
})
