// The user's dials: behavior a number or a choice decides, kept in the brain as settings. Code
// declares each one with its default and its rails; the agent moves them itself as it learns what
// the user wants, and each change shows in its space's chat as a "Remembered" line whose Undo puts
// the dial back.
import type { Database } from "bun:sqlite"
import { Brain, defineEvent, defineRead, EFFORTS, EventId, HOME, on, SpaceId } from "@switch/brain"
import type { Projection } from "@switch/brain"
import { Effect, Schema } from "effect"
import { Rejected } from "switch-ext-kit"

import { storedDial } from "./dial-values.ts"
import { GATE_BARS, GATE_DIALS, GateTuned } from "./gate.ts"
import { MemoryForgotten, quoted, said } from "./memory.ts"

interface Dial {
  /** Its name to the user, on its "Remembered" line. */
  readonly label: string
  /** What it decides, for the agent. */
  readonly what: string
  readonly default: number | string
  readonly min?: number
  readonly max?: number
  readonly choices?: readonly string[]
  /** Free text, not a number or a choice. */
  readonly text?: boolean
  readonly unit?: string
}

const bar = (label: string, at: number, what: string): Dial => ({
  label,
  what,
  default: at,
  min: 0.3,
  max: 0.95,
})

const GATE_WHAT: Readonly<Record<string, string>> = {
  "reply.long":
    "how sure the gate must be that a reply is longer than it needs to be to send it back to be cut",
  "reply.further":
    "how sure the gate must be that a reply stops short of what you could still do yourself to send it back",
  "item.self":
    "how sure the gate must be that you could do an action item yourself to send it back to you",
  "item.unprepared":
    "how sure the gate must be that an action item leaves the user work you could do first to send it back",
  "item.missing":
    "how sure the gate must be that an action item lacks what acting on it needs to send it back",
}

export const DIALS: Readonly<Record<string, Dial>> = {
  identity: {
    label: "Identity",
    what: 'who you are to the user, replacing the built-in identity at the top of every session; "" for the built-in one',
    default: "",
    text: true,
  },
  "effort.default": {
    label: "Default effort",
    what: "the effort a turn takes when nothing says otherwise",
    default: "medium",
    choices: EFFORTS,
  },
  "notify.after": {
    label: "Unread reply notifies after",
    what: "minutes a reply sits unread before it may notify the user",
    default: 3,
    min: 1,
    max: 240,
    unit: "min",
  },
  "wake.at": bar(
    "Wake bar",
    0.5,
    "how sure triage must be that an event needs acting on within minutes to wake its space at once; higher wakes less",
  ),
  ...Object.fromEntries(
    GATE_DIALS.map((d) => [
      d.key,
      bar(d.label, d.at, `${GATE_WHAT[d.criterion] ?? d.criterion}; higher bounces less`),
    ]),
  ),
}

export type DialKey = keyof typeof DIALS

const Value = Schema.Union([Schema.Number, Schema.String])

/** A dial moved: by the agent as it learned (with the space it learned it in), or put back. */
export const SettingSet = defineEvent(
  "setting.set",
  1,
  Schema.Struct({
    /** The change's id: a "Remembered" line's Undo forgets it. */
    id: Schema.String,
    key: Schema.String,
    value: Value,
    /** What it was; null at its default. */
    was: Schema.NullOr(Value),
    /** Its "Remembered" line. */
    description: Schema.String,
    why: Schema.String,
    /** The space whose work taught it: its chat shows the line. */
    space: Schema.optionalKey(SpaceId),
    /** The user's words it rests on. */
    said: Schema.optionalKey(said),
  }),
)

const json = (v: number | string | null) => JSON.stringify(v)

const put = (
  db: Database,
  key: string,
  value: number | string | null,
  change: string,
  time: number,
) => {
  if (value === null) {
    db.query("DELETE FROM settings WHERE key = ?").run(key)
    return
  }
  db.query(
    `INSERT INTO settings (key, value, change, time) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, change = excluded.change, time = excluded.time`,
  ).run(key, json(value), change, time)
}

const parse: (s: string) => unknown = JSON.parse

export const settings: Projection = {
  name: "settings",
  version: 2,
  tables: ["settings", "setting_changes"],
  create: `
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, change TEXT NOT NULL,
      time INTEGER NOT NULL);
    CREATE TABLE setting_changes (id TEXT PRIMARY KEY, key TEXT NOT NULL, was TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0);`,
  on: [
    on(SettingSet, (db, p, e) => {
      db.query("INSERT OR IGNORE INTO setting_changes (id, key, was) VALUES (?, ?, ?)").run(
        p.id,
        p.key,
        json(p.was),
      )
      put(db, p.key, p.value, p.id, e.time)
    }),
    // The gate's tuning, before it went: a threshold it moved stays where it put it until a change
    // like any other moves it.
    on(GateTuned, (db, p, e) => {
      put(db, `gate.${p.criterion}`, p.at, `tuned:${e.seq}`, e.time)
    }),
    // Undo: the dial goes back to what it was, unless it has moved again since.
    on(MemoryForgotten, (db, p, e) => {
      const change = db
        .query<{ key: string; was: string }, [string]>(
          "SELECT key, was FROM setting_changes WHERE id = ? AND undone = 0",
        )
        .get(p.id)
      if (!change) {
        return
      }
      db.query("UPDATE setting_changes SET undone = 1 WHERE id = ?").run(p.id)
      const now = db
        .query<{ change: string }, [string]>("SELECT change FROM settings WHERE key = ?")
        .get(change.key)
      if (now?.change === p.id) {
        const was = parse(change.was)
        put(
          db,
          change.key,
          typeof was === "number" || typeof was === "string" ? was : null,
          p.id,
          e.time,
        )
      }
    }),
  ],
  snapshot: (db) => db.query("SELECT key, value FROM settings").all(),
  sources: [
    {
      name: "settings",
      description:
        "The user's dials as set, the gate's thresholds among them (gate.<exit>.<criterion>); one not listed is at its default: key, value (JSON), change (the setting.set that set it, or tuned:<seq> for the gate's tuning before it went), time.",
      select: "SELECT key, value, change, time, rowid AS n FROM settings",
      columns: ["key", "value", "change", "time", "n"],
      time: "time",
      order: "n",
      depends: ["setting.", "gate.tuned", "memory.forgotten"],
    },
  ],
}

export const settingsConfig = {
  events: [SettingSet],
  projections: [settings],
  commands: [],
}

/** A dial's value now: as set, else its default. */
export const dialOf = (db: Database, key: DialKey) =>
  storedDial(db, key) ?? DIALS[key]?.default ?? 0

/** A numeric dial's value now. */
export const dialNumber = (db: Database, key: DialKey) => {
  const v = dialOf(db, key)
  return typeof v === "number" ? v : Number(DIALS[key]?.default ?? 0)
}

const shown = (d: Dial, v: number | string) => (d.unit === undefined ? String(v) : `${v} ${d.unit}`)

/** A change's "Remembered" line: from and to, or a text dial's new words. */
const lineOf = (d: Dial, was: number | string, value: number | string) => {
  if (d.text !== true) {
    return `${d.label}: ${shown(d, was)} → ${shown(d, value)}`
  }
  const words = String(value).replaceAll(/\s+/gu, " ").trim()
  if (words === "") {
    return `${d.label}: built-in`
  }
  return `${d.label}: ${words.length > 80 ? `${words.slice(0, 80)}…` : words}`
}

/** What values a dial takes, as the agent reads it. */
export const railsOf = (d: Dial) => {
  if (d.text === true) {
    return "text"
  }
  return d.choices === undefined ? `${d.min ?? ""} to ${d.max ?? ""}` : d.choices.join("|")
}

/** Each dial, its value now and its rails, for the agent. */
export const dialsNow = (db: Database) =>
  Object.entries(DIALS).map(([key, d]) => ({
    key,
    value: dialOf(db, key),
    default: d.default,
    takes: railsOf(d),
    what: d.what,
  }))

/** What's wrong with `value` for the dial, or "". */
const outside = (key: string, value: number | string) => {
  const d = DIALS[key]
  if (d === undefined) {
    return `No dial ${key}`
  }
  if (d.text === true) {
    return typeof value === "string" ? "" : `${key} is text`
  }
  if (d.choices !== undefined) {
    return typeof value === "string" && d.choices.includes(value)
      ? ""
      : `${key} is one of ${d.choices.join(", ")}`
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return `${key} is a number`
  }
  return value < (d.min ?? -Infinity) || value > (d.max ?? Infinity)
    ? `${key} goes from ${d.min ?? "-"} to ${d.max ?? "-"}`
    : ""
}

/** A dial as stored, and the message of the user's a quote of theirs comes from, if given. */
const adjustingRead = defineRead(
  "autonomy/settings/adjusting",
  (db, key: string, quote: string | undefined, space: SpaceId) => ({
    was: storedDial(db, key),
    found: quote === undefined || quote.trim() === "" ? null : quoted(db, quote.trim(), space),
  }),
)

/** The gate bars still where the tuner left it, each with what it is now. */
const tunedRead = defineRead("autonomy/settings/tuned", (db) =>
  GATE_BARS.flatMap((b) => {
    const row = db
      .query<{ change: string }, [string]>("SELECT change FROM settings WHERE key = ?")
      .get(b.key)
    const was = storedDial(db, b.key)
    return row?.change.startsWith("tuned:") === true && typeof was === "number"
      ? [{ ...b, was }]
      : []
  }),
)

/** The agent moves a dial: its space's chat shows it as a "Remembered" line with Undo. */
export const adjust = (input: {
  readonly space: SpaceId
  readonly key: string
  readonly value: number | string
  readonly why: string
  readonly quote?: string
}) =>
  Effect.gen(function* adjusting() {
    const brain = yield* Brain
    const wrong = outside(input.key, input.value)
    const d = DIALS[input.key]
    if (wrong !== "" || d === undefined) {
      return yield* new Rejected({ reason: wrong })
    }
    const { was, found } = yield* brain.read(adjustingRead, input.key, input.quote, input.space)
    if ((was ?? d.default) === input.value) {
      return yield* new Rejected({ reason: `${input.key} is ${String(input.value)} already` })
    }
    const id = `setting-${input.key}-${crypto.randomUUID().slice(0, 8)}`
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(id),
          type: SettingSet.type,
          source: "agent",
          payload: {
            id,
            key: input.key,
            value: input.value,
            was,
            description: lineOf(d, was ?? d.default, input.value),
            why: input.why,
            space: input.space,
            ...(found !== null &&
              input.quote !== undefined && {
                said: {
                  text: input.quote.trim().slice(0, 600),
                  seq: found.seq,
                  time: found.time,
                  space: found.space,
                },
              }),
          } satisfies typeof SettingSet.payload.Type,
        },
      ]),
    )
    return { id, key: input.key, value: input.value, was: was ?? d.default }
  })

// The user, Nov 23, letting the gate's tuner go ("as you wish"): every bar it left moved goes back
// to its default, once, each a change with Undo like any other. It had moved them on no real
// evidence: nearly every bounce came back changed, so it read every objection as heeded.

/** Puts back each gate bar still where the tuner left it; once, by its change's id. */
export const untune = Effect.gen(function* untuning() {
  const brain = yield* Brain
  const tuned = yield* brain.read(tunedRead)
  yield* Effect.orDie(
    brain.ingest(
      tuned.map(({ key, label, at, was }) => {
        const id = `setting-${key}-untuned`
        return {
          id: EventId.make(id),
          type: SettingSet.type,
          source: "autonomy",
          payload: {
            id,
            key,
            value: at,
            was,
            description: `${label}: ${was} → ${at}`,
            why: "The gate no longer lowers its own bars; this one goes back to its default.",
            space: SpaceId.make(HOME),
          } satisfies typeof SettingSet.payload.Type,
        }
      }),
    ),
  )
})
