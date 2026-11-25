// After a run: what the brain holds of Switchboard, and real conversations read back through the
// master-thread query, each in its space and in order.
import { statSync } from "node:fs"
import { Brain, defineRead, EventId, HOME, thread } from "@switch/brain"
import type { SpaceId } from "@switch/brain"
import { Effect } from "effect"

import { num, str, Switchboard } from "./source.ts"

export const size = (path: string) =>
  statSync(path).size + (statSync(`${path}-wal`, { throwIfNoEntry: false })?.size ?? 0)

/** The events carried from Switchboard, counted by type. */
const typesRead = defineRead("migrate/verify/types", (db) =>
  db
    .query<{ type: string; n: number }, []>(
      `SELECT type, count(*) AS n FROM events
       WHERE id LIKE 'sb:%' OR id LIKE 'open:space:%' OR id LIKE 'tag:sb:%' OR id LIKE 'tag:open:%'
       GROUP BY type ORDER BY n DESC`,
    )
    .all(),
)

/** The space an event was filed in, else Home. */
const homeRead = defineRead(
  "migrate/verify/home",
  (db, id: string) =>
    db
      .query<{ home: SpaceId }, [string]>(
        "SELECT t.home FROM events e JOIN tags t ON t.seq = e.seq WHERE e.id = ?",
      )
      .get(id)?.home ?? HOME,
)

const threadRead = defineRead("migrate/verify/thread", (db, space: SpaceId) => thread(db, space))

export const typesOut = Effect.gen(function* typing() {
  const brain = yield* Brain
  return yield* brain.read(typesRead)
})

export interface Check {
  readonly space: string
  readonly work: string
  readonly title: string
  readonly expected: number
  readonly found: number
  readonly inOrder: boolean
  readonly sample: readonly string[]
}

/** `n` busy conversations, one per space where it can, read back and compared with Switchboard. */
export const spotChecks = (n: number) =>
  Effect.gen(function* checking() {
    const sb = yield* Switchboard
    const brain = yield* Brain
    const rows = yield* sb.query(
      'work | where role == "chat" and messages >= 4 | project stream, title, workspace, messages | sort by messages desc | take 60',
    )
    const seen = new Set<string>()
    const picked = rows.filter((r) => {
      const ws = str(r.workspace)
      if (seen.has(ws)) {
        return false
      }
      seen.add(ws)
      return true
    })
    const out: Check[] = []
    for (const w of picked.slice(0, n)) {
      const stream = str(w.stream)
      const said = yield* sb.query(
        `records | where stream == ${JSON.stringify(stream)} and kind in ("part", "message") | project id, seq, kind, text = body.text`,
      )
      const want = said
        .filter((r) => str(r.text) !== "")
        .toSorted((a, b) => num(a.seq) - num(b.seq))
        .map((r) => EventId.make(`sb:${str(r.id)}`))
      const space = yield* brain.read(homeRead, want[0] ?? "")
      const lines = yield* brain.read(threadRead, space)
      const wanted = new Set(want)
      const got = lines.filter((l) => wanted.has(l.event.id))
      const ids = got.map((l) => l.event.id)
      out.push({
        space,
        work: stream,
        title: str(w.title),
        expected: want.length,
        found: got.length,
        inOrder: ids.join(",") === want.filter((id) => ids.includes(id)).join(","),
        sample: got.slice(0, 3).map((l) => {
          const p = l.event.payload
          const text = typeof p === "object" && p !== null && "text" in p ? String(p.text) : ""
          const who = l.event.source === "agent" ? "Switch" : "User"
          return `${new Date(l.event.time).toISOString().slice(0, 16)} ${who}: ${text.replaceAll(/\s+/gu, " ").slice(0, 70)}`
        }),
      })
    }
    return out
  })
