// Asks brought across from Switchboard whose original closed itself (`resolve_when`, a query its core
// ran again until its first row closed the ask: core/watches.rs:319) get that query back, as a
// revision appended to the log (`item.revised`, every field as it stands plus the query): nothing
// past is rewritten. One that can't run here, or already finds something, is said and left as it is.
import { Brain, EventId } from "@switch/brain"
import { fieldsOf, ItemRevised, items, prepareQuery, runQueryText } from "@switch/autonomy"
import { Effect } from "effect"

import { num, obj, str, Switchboard } from "./source.ts"

const PREFIX = "sb:item:"

export const resolveWhens = Effect.gen(function* restoring() {
  const sb = yield* Switchboard
  const brain = yield* Brain
  const open = yield* brain.read((db) =>
    items(db, { status: "open" }).filter(
      (i) => i.id.startsWith(PREFIX) && (i.resolveWhen ?? "").trim() === "",
    ),
  )
  if (open.length === 0) {
    return ["No open imported ask without its resolve_when"]
  }
  const ids = open.map((i) => JSON.stringify(i.id.slice(PREFIX.length))).join(", ")
  // The ask as it last stood: a revision (`replaces`) carries the query on.
  const found = yield* sb.query(
    `stream("asks") | where id in (${ids}) or body.replaces in (${ids}) | project id, seq, body`,
  )
  const zone = Temporal.Now.timeZoneId()
  const said: string[] = []
  for (const item of open) {
    const rust = item.id.slice(PREFIX.length)
    const [latest] = found
      .filter((r) => str(r.id) === rust || str(obj(r.body).replaces) === rust)
      .toSorted((a, b) => num(b.seq) - num(a.seq))
    const query = str(obj(latest?.body).resolve_when).trim()
    if (query === "") {
      said.push(`${item.id}: none there`)
      continue
    }
    const checked = yield* brain.read((db) => {
      try {
        return { rows: runQueryText(db, prepareQuery(query, zone), Date.now(), zone).rows.length }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
    if ("error" in checked) {
      said.push(`${item.id}: left as it is, its query doesn't run here (${checked.error})`)
      continue
    }
    if (checked.rows > 0) {
      said.push(`${item.id}: left as it is, its query already finds ${String(checked.rows)}`)
      continue
    }
    yield* Effect.orDie(
      brain.ingest([
        {
          id: EventId.make(`resolve-when:${item.id}`),
          type: ItemRevised.type,
          source: "migrate",
          payload: { ...fieldsOf(item), resolveWhen: query },
        },
      ]),
    )
    said.push(`${item.id}: resolve_when restored, runs, finds nothing yet`)
  }
  return said
})
