// Extensions in trouble, with no model, each raised to the agent at once (`troubled`), never into the
// user's chat, and resolved by itself once it works again:
// - stopped: down on a machine that's there for a few minutes, with why its host says; on an
//   always-on machine, its host gone too, once for all it ran;
// - crashing: it went down by itself again and again (exits, stopped answering), however soon it's
//   back up;
// - failing: its heartbeat (an event it names `heartbeat`, as `<extension>.heartbeat` or
//   `<extension>.<part>.heartbeat`) says something's wrong now: `facts.failing`, else an error it
//   carries (`error`, `last_error`, `sync_error`, `blind`), `ok: false` or a `state` other than ok;
//   or that it's fallen behind its source (`facts.behind_ms`) for ten minutes;
// - quiet: one of its heartbeats missed three of the beats its manifest promises (`heartbeat`),
//   however long ago it stopped;
// - calls, link: its tools' calls keep failing, or its link to the gateway won't come up (the
//   gateway's `extension.failing`).
// Any other stream follows the world or the user, and its silence is no surprise.
import type { Database } from "bun:sqlite"
import { Brain, defineRead } from "@switch/brain"
import { Effect } from "effect"

import { openSurprises, resolve, SENSED, troubled } from "./surprise.ts"
import type { Raise, Waker } from "./surprise.ts"

const MINUTE = 60_000
const EVERY = MINUTE
/** Down this long is stopped, not a restart. */
const DOWN_MS = 3 * MINUTE
/** Down by itself this many times within CRASH_WINDOW is crashing; calm for CALM_MS, it's over. */
const CRASHES = 3
const CRASH_WINDOW = 30 * MINUTE
const CALM_MS = 10 * MINUTE
/** A heartbeat fine this long since it last said something was wrong is working again. */
const HEALTHY_MS = 30 * MINUTE
/** Quiet: this many of its promised beats missed (Switchboard's QUIET_INTERVALS, protocol/manifest.rs:209-212). */
const QUIET_INTERVALS = 3
/** Behind its source this long is trouble. */
const BEHIND_MS = 10 * MINUTE
/** The first look waits this long after start. */
const FIRST = 3 * MINUTE
/** Beats read per heartbeat. */
const KEEP = 120

/** Ends of a run that its host chose, not the extension: a stop, a machine gone. */
const HOST_GONE = "host gone"
const CHOSEN = ["Stopped", HOST_GONE]

interface Run {
  readonly type: string
  readonly extension: string
  readonly machine: string
  readonly time: number
  /** Why its latest run ended, when it's down. */
  readonly reason: string | null
  readonly live: number
  /** Its manifest's promise: a beat of each heartbeat at most this many ms apart. */
  readonly heartbeat: number | null
  /** It runs on every machine, as `<extension>-<machine>`. */
  readonly every: number
}

/**
 * Each extension and machine's newest up or down (`spur.up` and `spur.down`, with `spur` for
 * `extension`, before extensions were renamed), and whether it still counts: the extension installed, and
 * this machine where it runs (its placement, every machine for an `every` extension, any while unplaced).
 * An uninstalled or moved extension's last word is a down that never ends; it isn't a stop.
 */
const runs = (db: Database) =>
  db
    .query<Run, []>(
      `SELECT r.type, r.extension, r.machine, r.time, r.reason,
         s.extension IS NOT NULL AND (json_extract(s.body, '$.manifest.every') = 1 OR p.machine IS NULL
           OR p.machine = r.machine) AS live,
         json_extract(s.body, '$.manifest.heartbeat') AS heartbeat,
         coalesce(json_extract(s.body, '$.manifest.every'), 0) AS every
       FROM (SELECT replace(type, 'spur.', 'extension.') AS type,
           coalesce(json_extract(payload, '$.extension'), json_extract(payload, '$.spur')) AS extension,
           json_extract(payload, '$.machine') AS machine, json_extract(payload, '$.reason') AS reason,
           max(time) AS time
         FROM events WHERE type IN ('extension.up', 'extension.down', 'spur.up', 'spur.down')
         GROUP BY 2, 3) r
       LEFT JOIN extensions s ON s.extension = r.extension
       LEFT JOIN extension_placements p ON p.extension = r.extension`,
    )
    .all()

interface Crashes {
  readonly extension: string
  readonly machine: string
  readonly n: number
  readonly last: number
  readonly reason: string
}

/** Each extension's ends by itself on each machine since `since`: how many, the latest and why. */
const crashes = (db: Database, since: number) =>
  db
    .query<Crashes, [number, string, string]>(
      `SELECT json_extract(payload, '$.extension') AS extension, json_extract(payload, '$.machine') AS machine,
         count(*) AS n, max(time) AS last, coalesce(json_extract(payload, '$.reason'), 'no reason given') AS reason
       FROM events WHERE time > ? AND type = 'extension.down'
         AND coalesce(json_extract(payload, '$.reason'), '') NOT IN (?, ?)
       GROUP BY 1, 2`,
    )
    .all(since, CHOSEN[0] ?? "", CHOSEN[1] ?? "")

interface Failing {
  readonly extension: string
  readonly part: string
  readonly failing: string | null
}

/** What the gateway last said of each app's calls and link. */
const gatewayFailing = (db: Database) =>
  db
    .query<Failing, []>(
      `SELECT json_extract(payload, '$.extension') AS extension, json_extract(payload, '$.part') AS part,
         json_extract(payload, '$.failing') AS failing, max(seq) AS seq
       FROM events WHERE type = 'extension.failing' GROUP BY 1, 2`,
    )
    .all()

/**
 * Every heartbeat type in the log, a seek per type on the type index: never a scan of the log. The
 * core's own bookkeeping names no heartbeat.
 */
const beatTypes = (db: Database) => {
  const next = db.query<{ type: string }, [string]>(
    "SELECT type FROM events WHERE type > ? ORDER BY type LIMIT 1",
  )
  const out: string[] = []
  let at = next.get("")?.type ?? null
  while (at !== null) {
    if (at.endsWith(".heartbeat")) {
      out.push(at)
    }
    at = next.get(at)?.type ?? null
  }
  return out
}

interface Beat {
  readonly seq: number
  readonly source: string
  readonly time: number
}

/**
 * A heartbeat's latest beats by source and the sense they're about (its entity: one extension's
 * parts may share a heartbeat), newest first, with what the newest says and whether any since
 * `since` said something's wrong: a run's first beat often comes before its first try, so one fine
 * beat after a restart isn't it working again. `name` tells apart the senses of a source with
 * several.
 */
const beatsOf = (db: Database, type: string, since: number) => {
  const rows = db
    .query<Beat & { readonly entity: string | null }, [string, number]>(
      `SELECT seq, source, time,
         coalesce(json_extract(payload, '$.data.entity'), json_extract(payload, '$.entity')) AS entity
       FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?`,
    )
    .all(type, KEEP)
  const payload = db.query<{ payload: string }, [number]>(
    "SELECT payload FROM events WHERE seq = ?",
  )
  const keys = [...new Set(rows.map((r) => `${r.source}\n${r.entity ?? ""}`))]
  return keys.map((k) => {
    const [source = "", entity = ""] = k.split("\n")
    const mine = rows.filter((r) => r.source === source && (r.entity ?? "") === entity)
    const several = keys.filter((x) => x.startsWith(`${source}\n`)).length > 1
    const lately = mine
      .filter((r, i) => i > 0 && r.time > since)
      .some((r) => failureOf(payload.get(r.seq)?.payload ?? "") !== null)
    return {
      source,
      name: several && entity !== "" ? `${source} (${entity})` : source,
      times: mine.map((r) => r.time),
      payload: payload.get(mine[0]?.seq ?? 0)?.payload ?? "",
      lately,
    }
  })
}

/** Extensions installed now: an uninstalled extension's trouble ends with it. */
const installed = (db: Database) =>
  new Set(
    db
      .query<{ extension: string }, []>("SELECT extension FROM extensions")
      .all()
      .map((r) => r.extension),
  )

/** Machines that are always on (the core's, a server): a host gone there is trouble. */
const alwaysOn = (db: Database) =>
  new Set(
    db
      .query<{ machine: string }, []>(
        "SELECT machine FROM machines, json_each(machines.provides) WHERE json_each.value = 'always-on'",
      )
      .all()
      .map((r) => r.machine),
  )

/** When each extension's version now was installed: a part it beat for before is gone with it. */
const versions = (db: Database) =>
  new Map(
    db
      .query<{ extension: string; time: number }, []>(
        `SELECT coalesce(json_extract(payload, '$.extension'), json_extract(payload, '$.spur')) AS extension,
           max(time) AS time
         FROM events WHERE type IN ('extension.installed', 'extension.updated', 'spur.installed', 'spur.updated')
         GROUP BY 1`,
      )
      .all()
      .map((r) => [r.extension, r.time]),
  )

/** A source's latest beat of a heartbeat, or null. */
const lastBeat = (db: Database, type: string, source: string) =>
  db
    .query<{ time: number }, [string, string]>(
      "SELECT time FROM events WHERE type = ? AND source = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(type, source)?.time ?? null

type Json = Readonly<Record<string, unknown>>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const parse: (text: string) => unknown = JSON.parse
const said = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)
const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 300)}…` : s)

const ago = (ms: number) => {
  const m = Math.round(ms / MINUTE)
  if (m < 90) {
    return `${m}m`
  }
  return m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/**
 * What a heartbeat says is wrong now, or null: its `failing` when it says one (null too), else an
 * error it carries, `ok: false`, or a `state` other than ok; failing none, how far behind its
 * source it is, `since` ms after it beat. Read from its facts (a shimmed record's `data.facts`),
 * else the payload itself.
 */
const failureOf = (payload: string, since = 0): string | null => {
  let p: unknown = null
  try {
    p = parse(payload)
  } catch {
    return null
  }
  if (!isJson(p)) {
    return null
  }
  const data = isJson(p.data) ? p.data : null
  const facts = [data === null ? null : data.facts, p.facts, p].find(isJson)
  if (facts === undefined) {
    return null
  }
  return toldOf(facts, data, p) ?? behindOf(facts, since)
}

/**
 * How far behind its source a heartbeat said it was, `since` ms after it said so, when that's past
 * BEHIND_MS: a sense still behind when it beat is taken as behind since, until its next beat.
 */
const behindOf = (facts: Json, since: number) => {
  const behind = facts.behind_ms
  if (typeof behind !== "number" || !(behind > 0) || behind + since < BEHIND_MS) {
    return null
  }
  return `${ago(behind + since)} behind its source`
}

/** What a heartbeat's facts say is wrong, or null. */
const toldOf = (facts: Json, data: Json | null, p: Json): string | null => {
  if ("failing" in facts) {
    return said(facts.failing)
  }
  for (const key of ["error", "last_error", "sync_error", "blind"]) {
    const why = said(facts[key])
    if (why !== null) {
      return why
    }
  }
  const summary = said(data?.summary) ?? said(p.summary) ?? "no reason given"
  if (facts.ok === false) {
    return summary
  }
  if (typeof facts.state === "string" && facts.state !== "ok") {
    return `${facts.state}: ${summary}`
  }
  return null
}

/**
 * What a look finds: `raise`, each in trouble now; `hold`, ids open that aren't over yet (down for
 * less than DOWN_MS, not yet calm since its crashes).
 */
interface Found {
  readonly raise: Raise[]
  readonly hold: string[]
}

/**
 * Down on a machine that's there, longer than a restart. A machine that's gone (a laptop asleep) is
 * no surprise: Switchboard looked only at the appendages online (monologue/src/watch.rs:186-188).
 * An always-on machine is never meant to be gone, so its host gone is trouble, once for all its
 * extensions down with it.
 */
const stops = (all: readonly Run[], on: ReadonlySet<string>, now: number, found: Found) => {
  const hostless = new Map<string, Run[]>()
  for (const r of all) {
    if (r.live !== 1 || r.type !== "extension.down") {
      continue
    }
    if (r.reason === HOST_GONE) {
      if (on.has(r.machine)) {
        hostless.set(r.machine, [...(hostless.get(r.machine) ?? []), r])
      }
      continue
    }
    const id = `stopped:${r.extension}@${r.machine}`
    if (now - r.time > DOWN_MS) {
      found.raise.push({
        id,
        kind: "stopped",
        text: `${r.extension} stopped on ${r.machine} ${ago(now - r.time)} ago: ${clip(r.reason ?? "no reason given")}`,
      })
    } else {
      found.hold.push(id)
    }
  }
  for (const [machine, down] of hostless) {
    const id = `stopped:host@${machine}`
    const since = Math.min(...down.map((r) => r.time))
    if (now - since > DOWN_MS) {
      const names = down.map((r) => r.extension).toSorted()
      found.raise.push({
        id,
        kind: "stopped",
        text: `The host on ${machine} is gone ${ago(now - since)}, and ${names.length} extensions with it: ${clip(names.join(", "))}`,
      })
    } else {
      found.hold.push(id)
    }
  }
}

/** Down by itself again and again lately, however soon it's back. */
const crashing = (db: Database, all: readonly Run[], now: number, found: Found) => {
  for (const c of crashes(db, now - CRASH_WINDOW)) {
    const id = `crashing:${c.extension}@${c.machine}`
    const live = all.some(
      (r) => r.extension === c.extension && r.machine === c.machine && r.live === 1,
    )
    if (live && c.n >= CRASHES) {
      found.raise.push({
        id,
        kind: "stopped",
        text: `${c.extension} went down ${c.n} times on ${c.machine} in ${ago(CRASH_WINDOW)}, last ${ago(now - c.last)} ago: ${clip(c.reason)}`,
      })
    } else if (live && now - c.last < CALM_MS) {
      found.hold.push(id)
    }
  }
}

/**
 * Heartbeats that say something's wrong now, or that their sense is behind its source. One counts
 * while its extension is installed and up on a machine whose instance is its source (`<extension>`
 * or `<extension>-<machine>`): down, its stop says it.
 */
const heartbeats = (
  db: Database,
  all: readonly Run[],
  extensions: ReadonlySet<string>,
  types: readonly string[],
  now: number,
  found: Found,
) => {
  const up = (extension: string, source: string) =>
    all.some(
      (r) =>
        r.extension === extension &&
        r.live === 1 &&
        r.type === "extension.up" &&
        (source === extension || source === `${extension}-${r.machine}`),
    )
  for (const type of types) {
    const extension = type.split(".")[0] ?? type
    const beats = extensions.has(extension) ? beatsOf(db, type, now - HEALTHY_MS) : []
    for (const b of beats.filter((x) => up(extension, x.source))) {
      const key = `${type} from ${b.name}`
      const why = failureOf(b.payload, now - (b.times[0] ?? now))
      if (why !== null) {
        found.raise.push({
          id: `failing:${key}`,
          kind: "broken",
          text: `${key} says: ${clip(why)}`,
        })
      } else if (b.lately) {
        found.hold.push(`failing:${key}`)
      }
    }
  }
}

/**
 * Heartbeats that missed three of the beats their extension's manifest promises, as Switchboard's
 * watch raised an appendage online that had recorded nothing for three of its intervals
 * (monologue/src/watch.rs:185-199). Each part of an extension (`<extension>.<part>.heartbeat`) that
 * beat since its version was installed keeps the promise on its own; one with none yet, its own
 * `<extension>.heartbeat`. Silence counts from its latest beat, its run's start or its version's
 * install, whichever is latest.
 */
const quiet = (
  db: Database,
  all: readonly Run[],
  types: readonly string[],
  now: number,
  found: Found,
) => {
  const since = versions(db)
  for (const r of all) {
    const every = r.heartbeat
    if (r.live !== 1 || r.type !== "extension.up" || every === null || !(every > 0)) {
      continue
    }
    const source = r.every === 1 ? `${r.extension}-${r.machine}` : r.extension
    const version = since.get(r.extension) ?? 0
    const beats = types
      .filter((t) => t.split(".")[0] === r.extension)
      .map((type) => ({ type, at: lastBeat(db, type, source) }))
      .filter((b) => b.at !== null && b.at > version)
    const parts = beats.length > 0 ? beats : [{ type: `${r.extension}.heartbeat`, at: null }]
    for (const b of parts) {
      const silent = now - Math.max(b.at ?? 0, r.time, version)
      if (silent > QUIET_INTERVALS * every) {
        const key = `${b.type} from ${source}`
        found.raise.push({
          id: `quiet:${key}`,
          kind: "quiet",
          text: `${key} went quiet: nothing for ${ago(silent)}, though it promises a beat every ${ago(every)}`,
        })
      }
    }
  }
}

/** Apps whose calls keep failing or whose link won't come up, as the gateway last said. */
const gatewayTrouble = (
  db: Database,
  all: readonly Run[],
  extensions: ReadonlySet<string>,
  found: Found,
) => {
  // An app once run as an extension that's since uninstalled has no trouble left.
  const gone = (app: string) =>
    all.some(
      (r) =>
        (r.extension === app || app === `${r.extension}-${r.machine}`) &&
        !extensions.has(r.extension),
    )
  for (const f of gatewayFailing(db)) {
    if (f.failing !== null && !gone(f.extension)) {
      const what = f.part === "link" ? "its link won't come up" : "its tools keep failing"
      found.raise.push({
        id: `${f.part}:${f.extension}`,
        kind: "broken",
        text: `${f.extension}: ${what}: ${clip(f.failing)}`,
      })
    }
  }
}

const lookRead = defineRead("autonomy/senses/look", (db, now: number) => lookAt(db, now))
const openRead = defineRead("autonomy/senses/open", (db) => openSurprises(db))

/** Everything in trouble now, read in one go. */
const lookAt = (db: Database, now: number): Found => {
  const found: Found = { raise: [], hold: [] }
  const extensions = installed(db)
  const all = runs(db)
  const types = beatTypes(db)
  stops(all, alwaysOn(db), now, found)
  crashing(db, all, now, found)
  heartbeats(db, all, extensions, types, now, found)
  quiet(db, all, types, now, found)
  gatewayTrouble(db, all, extensions, found)
  return found
}

/**
 * Looks every minute, the first a few minutes after start, once the core is serving. Each look is
 * a few indexed reads: each extension's newest run, its ends lately, each heartbeat's latest beats,
 * the gateway's latest word on each app. `wake` sends a newly raised one to its space's work; one
 * of ours open that a look no longer finds came right.
 */
export const sensesWatch = (wake: Waker) =>
  Effect.gen(function* watching() {
    const brain = yield* Brain
    const look = Effect.gen(function* looking() {
      const found = yield* brain.read(lookRead, Date.now())
      for (const s of found.raise) {
        yield* troubled(s, wake)
      }
      const holds = new Set([...found.hold, ...found.raise.map((s) => s.id)])
      for (const s of yield* brain.read(openRead)) {
        if (SENSED.some((p) => s.id.startsWith(p)) && !holds.has(s.id)) {
          yield* resolve(s.id)
        }
      }
    })
    yield* Effect.sleep(`${FIRST} millis`)
    yield* Effect.forever(
      Effect.andThen(Effect.ignore(look, { log: "Warn" }), Effect.sleep(`${EVERY} millis`)),
    )
  })
