// A run: everything in Switchboard's log since the last run, in log order, into the brain. Each
// page is converted and ingested in one batch, then filed: tagged with its space (as the tagger
// would, so it never asks a model about history) and, for the user's words, read.
import type { Database } from "bun:sqlite"
import { TurnEnded } from "@switch/agent"
import type { TurnEnd } from "@switch/agent"
import { Brain, EventId, HOME, MessageRead, SpaceTagged } from "@switch/brain"
import type { BrainConfig, Incoming, StoredEvent, ThreadId, TurnId } from "@switch/brain"
import { brainParts, line } from "@switch/core"
import { Effect, Fiber } from "effect"

import { causeOf, keyOf, makeConverter } from "./convert.ts"
import type { Out, Work } from "./convert.ts"
import { ExpectationImported, MemoryImported, migrateEvents, MigrateSynced } from "./events.ts"
import { wanted } from "./rules.ts"
import type { SbRecord } from "./source.ts"
import { chunks, num, obj, quote, refOf, str, strs, Switchboard } from "./source.ts"
import { carryCovers } from "./covers.ts"
import { carryItems } from "./items.ts"
import { placeSpaces, workspacesOf } from "./spaces.ts"

export const brainConfig = (path: string): BrainConfig => ({
  path,
  events: [...brainParts.flatMap((p) => p.events), ...migrateEvents],
  projections: brainParts.flatMap((p) => p.projections),
  commands: brainParts.flatMap((p) => p.commands),
  upcasts: brainParts.flatMap((p) => p.upcasts ?? []),
})

/** Seq pages: about what the core reads of the busiest streams within its budget. */
const PAGE = 40_000
const CHUNK = 2000

export interface Counts {
  /** Records read, by stream group and kind. */
  readonly in: Map<string, number>
  /** Events written for them, by group and kind, then Switch type. */
  readonly out: Map<string, Map<string, number>>
}

const bump = <K>(m: Map<K, number>, k: K, n = 1) => {
  m.set(k, (m.get(k) ?? 0) + n)
}

const lastSynced = (db: Database) =>
  db
    .query<{ through: number | null }, [string]>(
      "SELECT json_extract(payload, '$.through') AS through FROM events WHERE type = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(MigrateSynced.type)?.through ?? 0

interface Row {
  readonly seq: number
  readonly id: EventId
  readonly time: number
  readonly type: string
  readonly v: number
  readonly source: string
  readonly payload: string
}

const parseJson: (json: string) => unknown = JSON.parse

/** Tags and reads for what's just been written, found by id. */
const filing = (db: Database, outs: readonly Out[]): Incoming[] => {
  const byId = new Map(outs.map((o) => [o.event.id, o]))
  const follow: Incoming[] = []
  for (const ids of chunks([...byId.keys()], 500)) {
    const rows = db
      .query<Row, string[]>(`SELECT * FROM events WHERE id IN (${ids.map(() => "?").join(", ")})`)
      .all(...ids)
    for (const row of rows) {
      const o = byId.get(row.id)
      if (o === undefined) {
        continue
      }
      const e: StoredEvent = { ...row, payload: parseJson(row.payload) }
      const l = line(e)
      if (l !== null) {
        const p: typeof SpaceTagged.payload.Type = {
          seq: e.seq,
          home: l.home ?? o.space,
          mentions: [],
          conversation: l.conversation ?? null,
          links: [],
        }
        follow.push({
          id: EventId.make(`tag:${e.id}`),
          type: SpaceTagged.type,
          source: "membership",
          time: e.time,
          payload: p,
        })
      }
      if (o.read !== undefined) {
        const p: typeof MessageRead.payload.Type = {
          seq: e.seq,
          text: str(obj(e.payload).text),
          title: o.read.title,
          parts: [],
          effort: o.read.effort,
          ms: 0,
          cost: 0,
        }
        follow.push({
          id: EventId.make(`${e.id}:read`),
          type: MessageRead.type,
          source: "core",
          time: e.time,
          payload: p,
        })
      }
    }
  }
  return follow
}

export interface RunResult {
  readonly from: number
  readonly through: number
  readonly records: number
  readonly events: number
  readonly ms: number
  readonly counts: Counts
}

/** `start`: read from this seq instead of where the last run ended, to bring over kinds it left. */
export const run = (start?: number) =>
  Effect.gen(function* running() {
    const started = performance.now()
    const sb = yield* Switchboard
    const brain = yield* Brain
    const db = yield* brain.read((d) => d)
    const counts: Counts = { in: new Map(), out: new Map() }
    let events = 0

    const write = Effect.fnUntraced(function* writing(outs: readonly Out[]) {
      for (const chunk of chunks(outs, CHUNK)) {
        yield* brain.ingest(chunk.map((o) => o.event))
        const follow = filing(db, chunk)
        for (const f of chunks(follow, CHUNK)) {
          yield* brain.ingest(f)
        }
        events += chunk.length + follow.length
      }
    })

    const from = start ?? lastSynced(db)
    // The head first: every work and workspace up to it is in the read models read after.
    const streams = yield* sb.streams
    const head = Math.max(0, ...streams.map((s) => s.lastSeq))

    const [workRows, wsRows, briefRows, wsSince, parts] = yield* Effect.all(
      [
        sb.query("work | project stream, role, title, parent, workspace, created_at"),
        sb.query("workspaces"),
        sb.query('entities | where id startswith "ws:" | project id, brief = facts.brief'),
        sb.query('records | where stream == "workspaces" | project at, about'),
        sb.query('records | where kind == "part" | project m = body.message'),
      ],
      { concurrency: 5 },
    )

    const since = new Map<string, number>()
    const early = (ws: string, at: number) => {
      if (ws !== "" && at > 0 && at < (since.get(ws) ?? Infinity)) {
        since.set(ws, at)
      }
    }
    for (const r of wsSince) {
      for (const ws of strs(r.about)) {
        early(ws, num(r.at))
      }
    }
    for (const w of workRows) {
      early(str(w.workspace), num(w.created_at))
    }
    const placed = placeSpaces(
      db,
      workspacesOf(wsRows, new Map(briefRows.map((b) => [str(b.id), obj(b.brief)])), since),
      Date.now(),
    )
    const spaceOfWs = (ws: string) => placed.ids.get(ws) ?? HOME
    yield* brain.ingest(placed.events)
    events += placed.events.length
    events += yield* carryCovers(placed.ids)

    const works = new Map<string, Work>(
      workRows.map((w) => [
        str(w.stream),
        {
          role: str(w.role),
          space: str(w.workspace) === "" ? HOME : spaceOfWs(str(w.workspace)),
          parent: str(w.parent) === "" ? null : str(w.parent),
          title: str(w.title),
        },
      ]),
    )
    events += yield* carryItems(works, spaceOfWs)
    const causes = new Map<string, ReturnType<typeof causeOf>>()
    const { convert } = makeConverter({
      db,
      works,
      spaceOfWs,
      names: placed.names,
      folders: placed.folders,
      filed: new Set(parts.map((p) => str(p.m))),
      causes,
    })

    const others = streams.filter((s) => wanted(s.stream)).map((s) => s.stream)
    const filters = [
      'stream startswith "work/"',
      // Memories and open expectations come from the read models (below).
      'stream == "memory" and kind !in ("memory", "attribution", "expectation")',
      ...chunks(others, 400).map((c) => `stream in (${c.map(quote).join(", ")})`),
    ]
    const page = (lo: number) =>
      Effect.map(
        Effect.forEach(filters, (f) => sb.records(f, lo, Math.min(head, lo + PAGE)), {
          concurrency: 3,
        }),
        (got) => got.flat().toSorted((a, b) => a.seq - b.seq),
      )

    // What turns and steers point at, from the page or, when it's older, from Switchboard.
    const learnCauses = Effect.fnUntraced(function* learning(records: readonly SbRecord[]) {
      for (const r of records) {
        if (["part", "steer", "woken", "work", "noticed"].includes(r.kind)) {
          causes.set(r.id, causeOf(r))
        }
      }
      const missing = [
        ...new Set(
          records
            .filter(
              (r) =>
                r.kind === "injected" || (r.kind === "turn" && refOf(r, "supersedes") === null),
            )
            .map((r) => refOf(r, "caused_by") ?? "")
            .filter((id) => id !== "" && !causes.has(id)),
        ),
      ]
      if (missing.length > 0) {
        for (const r of yield* sb.byId(missing)) {
          causes.set(r.id, causeOf(r))
        }
      }
    })

    let records = 0
    let next = from < head ? yield* Effect.forkChild(page(from)) : null
    for (let lo = from; lo < head && next !== null; lo += PAGE) {
      const got = yield* Fiber.join(next)
      next = lo + PAGE < head ? yield* Effect.forkChild(page(lo + PAGE)) : null
      yield* learnCauses(got)
      const outs: Out[] = []
      for (const r of got) {
        const key = keyOf(r)
        bump(counts.in, key)
        const made = convert(r)
        const by = counts.out.get(key) ?? new Map<string, number>()
        counts.out.set(key, by)
        for (const o of made) {
          bump(by, o.event.type)
        }
        outs.push(...made)
      }
      yield* write(outs)
      records += got.length
      yield* Effect.logInfo(
        `through ${Math.min(head, lo + PAGE)} of ${head}: ${records} records, ${events} events, ${Math.round((performance.now() - started) / 1000)}s`,
      )
    }

    // Memories and rules as they stand, and what's still open: staged for autonomy.
    const imported = (type: string) =>
      new Set(
        db
          .query<{ id: string }, [string]>("SELECT id FROM events WHERE type = ?")
          .all(type)
          .map((r) => r.id),
      )
    const memoryRows = yield* sb.query("memories")
    const haveMemories = imported(MemoryImported.type)
    const memories: Out[] = memoryRows
      .filter((m) => !haveMemories.has(`sb:${str(m.id)}`))
      .map((m) => {
        const scope = str(m.scope)
        const about = strs(m.about).find((a) => a.startsWith("ws:"))
        const space = spaceOfWs(scope === "" ? (about ?? "") : scope)
        const p: typeof MemoryImported.payload.Type = {
          space,
          type: str(m.type),
          statement: str(m.statement),
          memory: m,
        }
        return {
          event: {
            id: EventId.make(`sb:${str(m.id)}`),
            type: MemoryImported.type,
            source: `sb:${str(m.source)}`,
            time: num(m.at),
            payload: p,
          },
          space,
        }
      })
    bump(counts.in, "memories (read model)", memoryRows.length)
    counts.out.set("memories (read model)", new Map([[MemoryImported.type, memories.length]]))

    const watching = obj(yield* sb.view("watches")).watches
    const open = (Array.isArray(watching) ? watching : []).map(obj)
    const bodies = new Map(
      (yield* sb.byId(open.map((w) => str(w.id)))).map((r) => [r.id, r.body] as const),
    )
    const haveOpen = imported(ExpectationImported.type)
    const expectations: Out[] = open
      .filter((w) => !haveOpen.has(`sb:${str(w.id)}`))
      .map((w) => {
        const work = str(w.work)
        const about = strs(w.about).find((a) => a.startsWith("ws:"))
        const space = works.get(work)?.space ?? spaceOfWs(about ?? "")
        const body = obj(bodies.get(str(w.id)))
        const due = [w.at, w.by].find((t): t is number => typeof t === "number") ?? null
        const p: typeof ExpectationImported.payload.Type = {
          space,
          statement: str(w.then) || str(body.statement) || str(body.text),
          due,
          promise: body.promise === true,
          check: str(w.check) === "" ? null : str(w.check),
          when: str(w.when) === "" ? null : str(w.when),
          record: { ...w, body },
        }
        return {
          event: {
            id: EventId.make(`sb:${str(w.id)}`),
            type: ExpectationImported.type,
            source: "sb:core",
            time: num(w.made),
            payload: p,
          },
          space,
        }
      })
    bump(counts.in, "watches (open)", open.length)
    counts.out.set("watches (open)", new Map([[ExpectationImported.type, expectations.length]]))
    yield* write([...memories, ...expectations])

    // A turn still under way there isn't one here: on start, Switch would carry it on.
    const underWay = db
      .query<{ thread: ThreadId; turn: TurnId }, []>(
        "SELECT thread, turn FROM threads WHERE status = 'running' AND turn LIKE 'sb:%'",
      )
      .all()
    const cuts: Incoming[] = underWay.map((t) => {
      const p: TurnEnd = {
        thread: t.thread,
        turn: t.turn,
        status: "interrupted",
        result: "",
        resetAt: null,
        costUsd: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        context: 0,
        ms: 0,
      }
      return {
        id: EventId.make(`${t.turn}:cut`),
        type: TurnEnded.type,
        source: "agent",
        payload: p,
      }
    })
    const ms = Math.round(performance.now() - started)
    const synced: typeof MigrateSynced.payload.Type = { through: Math.max(from, head), records, ms }
    yield* brain.ingest([
      ...cuts,
      {
        id: EventId.make(`migrate:${Math.max(from, head)}:${Date.now()}`),
        type: MigrateSynced.type,
        source: "migrate",
        payload: synced,
      },
    ])
    events += cuts.length + 1
    return { from, through: Math.max(from, head), records, events, ms, counts } satisfies RunResult
  })
