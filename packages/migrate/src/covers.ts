// Workspaces' covers become their spaces' covers: the print and its day and night printings, copied
// into the blob store byte for byte (so their hashes stay), each cover once. A space whose cover
// Switch drew keeps it.
import { Blobs, Brain, EventId, hashOf, HOME, SpaceCovered } from "@switch/brain"
import type { Incoming, SpaceId } from "@switch/brain"
import { Effect } from "effect"

import { num, obj, str, Switchboard } from "./source.ts"

/** Each workspace's cover, carried to its space. */
export const carryCovers = (ids: ReadonlyMap<string, SpaceId>) =>
  Effect.gen(function* carrying() {
    const sb = yield* Switchboard
    const brain = yield* Brain
    const blobs = yield* Blobs
    const rows = yield* sb.query(
      'entities | where id startswith "ws:" | project id, cover = facts.cover',
    )
    const covered = yield* brain.read((db) =>
      db
        .query<{ id: string; source: string; space: string }, []>(
          "SELECT id, source, json_extract(payload, '$.id') AS space FROM events WHERE type = 'space.covered'",
        )
        .all(),
    )
    const known = new Set(covered.map((r) => r.id))
    const ours = new Set(covered.filter((r) => r.source !== "switchboard").map((r) => r.space))
    const events: Incoming[] = []
    for (const r of rows) {
      const space = ids.get(str(r.id))
      const c = obj(r.cover)
      const print = hashOf(str(c.print))
      const light = hashOf(str(c.light))
      const dark = hashOf(str(c.night))
      if (
        space === undefined ||
        space === HOME ||
        ours.has(space) ||
        print === null ||
        light === null ||
        dark === null
      ) {
        continue
      }
      const id = EventId.make(`sb:space:${space}:cover:${print}`)
      if (known.has(id)) {
        continue
      }
      for (const blob of [print, light, dark]) {
        const bytes = yield* sb.blob(`sha256:${blob}`)
        yield* blobs.put(new Response(bytes).body ?? new Blob([]).stream())
      }
      const p: typeof SpaceCovered.payload.Type = {
        id: space,
        print,
        light,
        dark,
        ink: str(c.ink),
        name: str(c.name),
        lettered: c.lettered === true,
        photo: hashOf(str(c.photo)),
        subject: str(c.subject),
        cost: 0,
      }
      const drawn = num(c.drawn_at)
      events.push({
        id,
        type: SpaceCovered.type,
        source: "switchboard",
        payload: p,
        ...(drawn > 0 && { time: drawn }),
      })
    }
    yield* brain.ingest(events)
    return events.length
  })
