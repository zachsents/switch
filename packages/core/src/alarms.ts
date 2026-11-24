// Resource alarms: a machine's vitals past a line a wake rule draws (rules.ts `alarmsOf`) wake the
// work that's causing it. The user, Nov 18: "agents aren't always really great at considering time
// and resources… the agents will just completely bomb the memory on the Mac Mini I have connected
// and it halts all progress on everything." He chose alarms built in over a queue of jobs, which is
// too rigid. The lines, where each is over and whose processes count are the brain's (seeds.ts);
// the moment and the numbers are code's; what's done about it is the agent's, by the user's rules.
// - Each machine's every reading (an extension's `<name>.vitals`) is read against every alarm. One
//   past its line rings: a surprise, `alarm:<rule>:<machine>`, open until a reading is past where
//   it's over (`clear`), so it rings once an episode, and again only once it's been over.
// - It wakes the work whose processes are heaviest there, by the marks the runaway stopper knows
//   (runaway.ts), as the machine's extension's `load` tells it: the heaviest of the three heaviest
//   owners that's a work's. Else, or when `load` can't say, Switch's own space, Home. It never
//   reaches the user's chat: the agent puts an ask in their queue if only they can fix it.
// - What it carries: the reading's numbers and the heaviest owners, each with its heaviest process.
import {
  alarmsOf,
  openSurprises,
  resolveSurprise,
  spaceOfWork,
  troubledWith,
} from "@switch/autonomy"
import type { Alarm, AlarmLine } from "@switch/autonomy"
import { Sessions } from "@switch/agent"
import { Brain, HOME, ThreadId } from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { Gateway } from "@switch/gateway"
import { Effect, Layer, Schema, Stream } from "effect"

import { threadOf } from "./context.ts"

const PREFIX = "alarm:"
/** The owners an alarm says, and among which it looks for a work to wake. */
const SHOWN = 5
const BLAMED = 3

const Owner = Schema.Struct({
  owner: Schema.String,
  work: Schema.optionalKey(Schema.String),
  extension: Schema.optionalKey(Schema.String),
  cpuPct: Schema.Finite,
  memoryMb: Schema.Finite,
  processes: Schema.Finite,
  heaviest: Schema.optionalKey(Schema.Struct({ pid: Schema.Finite, command: Schema.String })),
})
type Owner = typeof Owner.Type
const decodeLoad = Schema.decodeUnknownOption(Schema.Struct({ owners: Schema.Array(Owner) }))

const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A dotted path into a reading (`temp.c`). */
const at = (reading: unknown, path: string) => {
  let v = reading
  for (const k of path.split(".")) {
    v = isRecord(v) ? v[k] : undefined
  }
  return v
}

/** What an alarm reads of a reading: a field, or one over another (`load5/cores`); null if absent. */
const valueOf = (reading: unknown, on: string): number | string | null => {
  const [top = "", under] = on.split("/")
  const v = at(reading, top.trim())
  if (under === undefined) {
    return typeof v === "number" || typeof v === "string" ? v : null
  }
  const by = at(reading, under.trim())
  return typeof v === "number" && typeof by === "number" && by !== 0 ? v / by : null
}

const rings = (a: AlarmLine, v: number | string) =>
  typeof v === "number"
    ? (a.above !== null && v > a.above) || (a.below !== null && v < a.below)
    : a.is.includes(v)

/** Back where it's over: past `clear`, or off its line. One the reading doesn't carry stays. */
const over = (a: AlarmLine, v: number | string | null) => {
  if (v === null) {
    return false
  }
  if (typeof a.clear === "number" && typeof v === "number") {
    return a.above === null ? v >= a.clear : v <= a.clear
  }
  if (Array.isArray(a.clear) && typeof v === "string") {
    return a.clear.includes(v)
  }
  return !rings(a, v)
}

const num = (v: unknown) => (typeof v === "number" ? v : null)
const fixed = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(0) : n.toFixed(1))

/** Its line in words: "under 5 (over at 10)". */
const lineOf = (a: AlarmLine) => {
  let line = `is ${a.is.join(" or ")}`
  if (a.above !== null) {
    line = `over ${String(a.above)}`
  } else if (a.below !== null) {
    line = `under ${String(a.below)}`
  }
  if (a.clear === null) {
    return line
  }
  return `${line} (over at ${typeof a.clear === "number" ? String(a.clear) : a.clear.join(" or ")})`
}

/** The reading's numbers, as a person reads them. */
const numbers = (r: unknown) => {
  const disk = num(at(r, "diskFreeGb"))
  const swap = num(at(r, "swapGb"))
  const grows = num(at(r, "swapGrowthGbPerHour"))
  const pressure = at(r, "pressure")
  const memory = num(at(r, "memoryPct"))
  const load = num(at(r, "load"))
  const load5 = num(at(r, "load5"))
  const cores = num(at(r, "cores"))
  const temp = num(at(r, "temp.c"))
  return [
    disk === null ? "" : `${fixed(disk)} GB free`,
    swap === null
      ? ""
      : `swap ${fixed(swap)} GB${grows === null ? "" : `, growing ${fixed(grows)} GB an hour`}`,
    typeof pressure === "string"
      ? `memory pressure ${pressure}${memory === null ? "" : `, ${String(memory)}% used`}`
      : "",
    load === null
      ? ""
      : `load ${fixed(load)}${load5 === null ? "" : `, ${fixed(load5)} over five minutes`}${cores === null ? "" : `, on ${String(cores)} cores`}`,
    temp === null ? "" : `CPU ${fixed(temp)}°C`,
  ]
    .filter((x) => x !== "")
    .join("; ")
}

/** The machine's heaviest owners now, by its extension's `load`; null when it can't say. */
const ownersOn = (source: string) =>
  Effect.gen(function* asking() {
    const gateway = yield* Gateway
    const result = yield* Effect.tryPromise(
      async () => await gateway.call(`${source}_load`, { top: 12 }),
    ).pipe(Effect.timeout("30 seconds"))
    if (result.isError === true) {
      return null
    }
    const said = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("")
    const body: unknown =
      result.structuredContent ?? (yield* Effect.try(() => JSON.parse(said) as unknown))
    const decoded = decodeLoad(body)
    return decoded._tag === "Some" ? decoded.value.owners : null
  }).pipe(Effect.orElseSucceed(() => null))

const heavier = (by: AlarmLine["by"]) => (a: Owner, b: Owner) =>
  by === "cpu" ? b.cpuPct - a.cpuPct : b.memoryMb - a.memoryMb

/** An owner as the alarm says it: its heaviest process, its weight, and its work's title. */
const ownerLine = (o: Owner, titles: ReadonlyMap<string, string>, woken: string | null) => {
  const what =
    o.heaviest === undefined
      ? o.owner
      : `${o.heaviest.command} (pid ${String(o.heaviest.pid)}${o.processes > 1 ? `, ${String(o.processes)} processes` : ""})`
  const weight = `${fixed(o.memoryMb / 1024)} GB, ${String(o.cpuPct)}% CPU`
  let whose = ""
  if (o.work !== undefined) {
    const title = titles.get(o.work)
    whose = `, for ${title === undefined ? o.work : `“${title}” (${o.work})`}${o.work === woken ? ", the work this wakes" : ""}`
  } else if (o.extension !== undefined) {
    whose = `, the extension ${o.extension}`
  }
  return `${what}: ${weight}${whose}`
}

/** One alarm rung on a machine: its text, carrying the numbers and the heaviest, to the work. */
const ring = (alarm: Alarm, id: string, machine: string, e: StoredEvent, v: number | string) =>
  Effect.gen(function* ringing() {
    const brain = yield* Brain
    const sessions = yield* Sessions
    const owners = ((yield* ownersOn(e.source)) ?? []).toSorted(heavier(alarm.alarm.by))
    const shown = owners.slice(0, SHOWN)
    const { titles, work, space } = yield* brain.read((db) => {
      const title = db.query<{ title: string }, [string]>(
        "SELECT title FROM threads WHERE thread = ?",
      )
      const named = new Map(
        shown.flatMap((o) => {
          const t = o.work === undefined ? null : title.get(o.work)
          return o.work === undefined || t === null ? [] : [[o.work, t.title] as const]
        }),
      )
      // A work the brain doesn't know (one long gone) is no one to wake.
      const blamed = owners
        .slice(0, BLAMED)
        .find((o) => o.work !== undefined && title.get(o.work) !== null)?.work
      const thread = blamed === undefined ? null : ThreadId.make(blamed)
      return {
        titles: named,
        work: thread,
        space: thread === null ? HOME : (spaceOfWork(db, thread) ?? HOME),
      }
    })
    const heaviest =
      shown.length === 0
        ? `Its heaviest processes couldn't be read from ${e.source}_load.`
        : `Heaviest by ${alarm.alarm.by}: ${shown.map((o) => ownerLine(o, titles, work)).join("; ")}.`
    const text = [
      `${alarm.title} on ${machine}: ${alarm.alarm.on} ${typeof v === "number" ? fixed(v) : v}, ${lineOf(alarm.alarm)}.`,
      `Now: ${numbers(e.payload)}.`,
      heaviest,
      `${alarm.question} ${alarm.goal}`.trim(),
      `${alarm.name} rings once until it's over.`,
    ].join(" ")
    yield* Effect.logWarning(`Alarm: ${alarm.title} on ${machine}`)
    yield* troubledWith(
      { id, space, ...(work !== null && { thread: work }), kind: "other", text },
      { threadOf, kick: sessions.kick },
      work ?? undefined,
    )
  })

/** A reading against every alarm: each past its line rings, once; each open one that's over ends. */
const read = (e: StoredEvent) =>
  Effect.gen(function* reading() {
    const brain = yield* Brain
    const machine = at(e.payload, "machine")
    if (typeof machine !== "string" || machine === "") {
      return
    }
    const { alarms, open } = yield* brain.read((db) => ({
      alarms: alarmsOf(db),
      open: new Set(
        openSurprises(db)
          .filter((s) => s.id.startsWith(PREFIX) && s.id.endsWith(`:${machine}`))
          .map((s) => s.id),
      ),
    }))
    const live = new Set<string>()
    for (const alarm of alarms) {
      const id = `${PREFIX}${alarm.name}:${machine}`
      live.add(id)
      const v = valueOf(e.payload, alarm.alarm.on)
      if (open.has(id)) {
        if (over(alarm.alarm, v)) {
          yield* resolveSurprise(id)
        }
      } else if (v !== null && rings(alarm.alarm, v)) {
        yield* ring(alarm, id, machine, e, v)
      }
    }
    // An alarm retired while it rang is over.
    for (const id of open) {
      if (!live.has(id)) {
        yield* resolveSurprise(id)
      }
    }
  })

export const alarmsWorker = Layer.effectDiscard(
  Effect.gen(function* alarming() {
    const brain = yield* Brain
    const head = yield* brain.read(
      (db) =>
        db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0,
    )
    yield* Effect.forkScoped(
      brain.changes(head).pipe(
        Stream.filter((e) => e.type.endsWith(".vitals")),
        Stream.runForEach((e) =>
          read(e).pipe(
            Effect.ignore({ log: "Warn", message: "A reading couldn't be read for alarms" }),
          ),
        ),
      ),
    )
  }),
)
