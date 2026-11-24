// The undo log is the event log: every change carries its batch, and undoing a batch writes the
// inverse of each of its events, newest first, then takes back what it sent to Apple or Google.
import { Log } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect } from "effect"

import {
  PersonCreated,
  PersonMerged,
  PersonRetired,
  PersonSplit,
  PersonUpdated,
  Pushed,
  Undone,
} from "./model.ts"
import { unpush } from "./push.ts"
import { batchId, commit } from "./store.ts"

interface Row {
  readonly type: string
  readonly payload: string
}

export const undo = (batch: string) =>
  Effect.gen(function* undoing() {
    const log = yield* Log
    const rows = yield* log.read((db) =>
      db
        .query<Row, [string]>(
          "SELECT type, payload FROM events WHERE json_extract(payload, '$.batch') = ? ORDER BY seq DESC",
        )
        .all(batch),
    )
    if (rows.length === 0) {
      return yield* Effect.fail(new Error(`No batch ${batch}`))
    }
    const done = yield* log.read(
      (db) =>
        db
          .query<{ undone: number }, [string]>("SELECT undone FROM batches WHERE batch = ?")
          .get(batch)?.undone === 1,
    )
    if (done) {
      return yield* Effect.fail(new Error(`Batch ${batch} already undone`))
    }
    const mine = batchId("undo")
    const reason = `undo ${batch}`
    const inverse: Draft[] = []
    let remote = 0
    for (const r of rows) {
      const raw: unknown = JSON.parse(r.payload)
      if (r.type === PersonCreated.type) {
        const p = PersonCreated.decode(raw)
        inverse.push(PersonRetired.make({ id: p.id, retired: true, batch: mine, reason }))
      } else if (r.type === PersonUpdated.type) {
        const p = PersonUpdated.decode(raw)
        inverse.push(
          PersonUpdated.make({ id: p.id, added: p.removed, removed: p.added, batch: mine, reason }),
        )
      } else if (r.type === PersonMerged.type) {
        const p = PersonMerged.decode(raw)
        inverse.push(
          PersonSplit.make({ into: p.into, from: p.from, fields: p.fields, batch: mine, reason }),
        )
      } else if (r.type === PersonSplit.type) {
        const p = PersonSplit.decode(raw)
        inverse.push(
          PersonMerged.make({
            into: p.into,
            from: p.from,
            fields: p.fields,
            confidence: 1,
            batch: mine,
            reason,
          }),
        )
      } else if (r.type === PersonRetired.type) {
        const p = PersonRetired.decode(raw)
        inverse.push(PersonRetired.make({ id: p.id, retired: !p.retired, batch: mine, reason }))
      } else if (r.type === Pushed.type) {
        const p = Pushed.decode(raw)
        if (!p.reverted) {
          remote += 1
          yield* unpush(p, mine)
        }
      }
    }
    // An undo restores what was; the user's own fields may come and go with it.
    yield* commit(mine, [...inverse, Undone.make({ batch, by: mine, events: rows.length })], true)
    return { undone: batch, batch: mine, events: inverse.length, remote }
  })
