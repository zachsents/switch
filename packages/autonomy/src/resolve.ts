// Items that close themselves (Switchboard's `resolve_when`; core/watches.rs, `Origin::Resolve`): an
// open item's `resolveWhen` query (records-query.ts) runs again whenever a record arrives that can
// change what it finds, at most every 3 s (a slow one less often), and each minute when it depends
// on the time. The first row it finds closes the item as resolved, with what it found, and whoever
// waits on it hears (core/asks.ts). Nothing here asks a model; an item whose `resolveWhen` isn't a
// query is left to triage, which reads it as words.
import type { Database } from "bun:sqlite"
import { Brain } from "@switch/brain"
import type { StoredEvent } from "@switch/brain"
import { Effect, Stream } from "effect"

import { CloseItem, getItem, items } from "./items.ts"
import type { ActionItem } from "./items.ts"
import { field } from "./json.ts"
import { noteType, prepare, run, wakes } from "./records-query.ts"
import type { Prepared } from "./records-query.ts"

/** How often a query runs, at the most. */
const EVERY_MS = 3000
/** A query slow to answer runs this many times its answer's time apart, at the least. */
const SPACING = 20
/** How often one that depends on the time runs with nothing arriving. */
const TIMELY_MS = 60_000
/** How much of what it found is kept with why it closed. */
const FOUND_CHARS = 600

interface Watch {
  readonly item: ActionItem
  readonly prepared: Prepared
  dirty: boolean
  next: number
  ran: number | null
  failing: string | null
}

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`)

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The watch an open item that closes itself is, when its `resolveWhen` is a query. */
const watchOf = (i: ActionItem | null, zone: string): Watch | null => {
  const when = i?.resolveWhen?.trim() ?? ""
  if (i?.status !== "open" || i.completion === "owner" || when === "") {
    return null
  }
  try {
    return {
      item: i,
      prepared: prepare(when, zone),
      dirty: true,
      next: 0,
      ran: null,
      failing: null,
    }
  } catch {
    return null
  }
}

/** Its first row now, or why it can't run. */
const firstRow = (db: Database, p: Prepared, zone: string) => {
  try {
    return { row: run(db, p, Date.now(), zone).rows[0] ?? null }
  } catch (error) {
    return { error: messageOf(error) }
  }
}

const head = (db: Database) =>
  db.query<{ seq: number | null }, []>("SELECT max(seq) AS seq FROM events").get()?.seq ?? 0

export const resolveWatch = Effect.gen(function* watching() {
  const brain = yield* Brain
  const zone = Temporal.Now.timeZoneId()
  const watches = new Map<string, Watch>()
  const keep = (id: string, i: ActionItem | null) => {
    const watch = watchOf(i, zone)
    if (watch === null) {
      watches.delete(id)
    } else {
      watches.set(id, watch)
    }
  }

  // Listening from before reading, so nothing between slips by.
  const from = yield* brain.read(head)
  for (const i of yield* brain.read((db) => items(db, { status: "open" }))) {
    keep(i.id, i)
  }
  const arrived = (e: StoredEvent) =>
    Effect.gen(function* arriving() {
      noteType(e)
      const id = field(e.payload, "id")
      if (e.type.startsWith("item.") && typeof id === "string") {
        keep(id, yield* brain.read((db) => getItem(db, id)))
        return
      }
      for (const watch of watches.values()) {
        if (!watch.dirty && wakes(watch.prepared, e)) {
          watch.dirty = true
        }
      }
    })
  yield* Effect.forkScoped(
    brain.changes(from).pipe(Stream.runForEach((e) => Effect.ignore(arrived(e), { log: "Warn" }))),
  )

  const close = (watch: Watch, row: unknown) =>
    brain.dispatch({
      id: `resolved:${watch.item.id}:${watch.item.openedAt}`,
      type: CloseItem.type,
      source: "autonomy",
      payload: {
        id: watch.item.id,
        status: "resolved",
        why: `My senses confirmed it: \`${watch.prepared.text}\` found ${clip(JSON.stringify(row), FOUND_CHARS)}`,
      },
    })

  // Runs what's due, one at a time, and closes what found something.
  const step = Effect.gen(function* stepping() {
    for (const [id, watch] of watches) {
      const now = Date.now()
      const timely = watch.prepared.timely && (watch.ran === null || now - watch.ran >= TIMELY_MS)
      if (!((watch.dirty && now >= watch.next) || timely)) {
        continue
      }
      const started = performance.now()
      const found = yield* brain.read((db) => firstRow(db, watch.prepared, zone))
      const took = performance.now() - started
      watch.ran = Date.now()
      watch.dirty = false
      watch.next = watch.ran + Math.max(EVERY_MS, took * SPACING)
      if ("error" in found) {
        if (watch.failing !== found.error) {
          yield* Effect.logWarning(`item ${id}'s resolve_when fails (${found.error})`)
        }
        watch.failing = found.error
      } else if (found.row !== null && watches.get(id) === watch) {
        watches.delete(id)
        yield* Effect.ignore(close(watch, found.row), { log: "Warn" })
      } else {
        watch.failing = null
      }
    }
  })
  yield* Effect.forever(
    Effect.andThen(Effect.ignore(step, { log: "Warn" }), Effect.sleep("1 second")),
  )
})
