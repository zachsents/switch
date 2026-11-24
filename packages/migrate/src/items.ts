// The old queue is a read model, like memories and watches: copying its records as observations
// preserves words but loses the user's pending work. Carry open items once; a local answer wins.
import type { SpaceId } from "@switch/brain"
import { Blobs, Brain, EventId, hashOf, ItemId } from "@switch/brain"
import { ItemClosed, ItemOpened } from "@switch/autonomy"
import { Effect, Option, Schema } from "effect"

import { obj, str, strs, num, Switchboard } from "./source.ts"
import type { Body } from "./source.ts"
import type { Work } from "./convert.ts"

const decodeItem = Schema.decodeUnknownOption(ItemOpened.payload)
const attachmentsOf = (body: Body) => [
  ...(Array.isArray(body.attachments) ? body.attachments : []).map(obj).map((a) => {
    const hash = hashOf(str(a.blob))
    return {
      name: str(a.name),
      type: str(a.type),
      ...(typeof a.bytes === "number" && { size: a.bytes }),
      ...(hash === null ? {} : { blob: hash }),
      ...(typeof a.url === "string" && { url: a.url }),
    }
  }),
  ...(Array.isArray(body.assists) ? body.assists : [])
    .map(obj)
    .filter((assist) => typeof assist.url === "string")
    .map((assist) => ({
      name: str(assist.label) || str(assist.url),
      type: "text/html",
      url: str(assist.url),
    })),
]

const copyAttachments = (attachments: NonNullable<typeof ItemOpened.payload.Type.attachments>) =>
  Effect.gen(function* copying() {
    const sb = yield* Switchboard
    const blobs = yield* Blobs
    for (const attachment of attachments) {
      const hash = hashOf(attachment.blob ?? "")
      if (hash !== null && (yield* blobs.path(hash)) === null) {
        const bytes = yield* sb.blob(`sha256:${hash}`)
        yield* blobs.put(new Response(bytes).body ?? new Blob([]).stream())
      }
    }
  })

export const carryItems = (
  works: ReadonlyMap<string, Work>,
  spaceOfWs: (workspace: string) => SpaceId,
) =>
  Effect.gen(function* carrying() {
    const sb = yield* Switchboard
    const brain = yield* Brain
    const rows = yield* sb.query("asks")
    const known = yield* brain.read(
      (db) =>
        new Map(
          db
            .query<{ id: string; status: string }, []>(
              "SELECT id, status FROM action_items WHERE id LIKE 'sb:item:%'",
            )
            .all()
            .map((r) => [r.id, r.status]),
        ),
    )
    let changed = 0
    for (const row of rows) {
      const id = ItemId.make(`sb:item:${str(row.id)}`)
      const previous = known.get(id)
      if (previous !== undefined) {
        if (previous === "open" && (row.open === false || row.open === 0)) {
          yield* brain.ingest([
            {
              id: EventId.make(`sb:item:closed:${str(row.id)}`),
              type: ItemClosed.type,
              source: "switchboard",
              time: num(row.closed_at),
              payload: { id, status: "resolved", why: "Closed in Switchboard" },
            },
          ])
          changed += 1
        }
        continue
      }
      if (
        (row.open !== true && row.open !== 1) ||
        !["task", "question", "approval"].includes(str(row.type))
      ) {
        continue
      }
      const body = obj(row.body)
      const kind = str(row.type)
      const space = works.get(str(row.work))?.space ?? spaceOfWs(strs(row.about)[0] ?? "")
      // Old assists are callbacks into the old runtime, not interchangeable with new tools.
      // Its approval still wakes this space with the complete instructions, using current tools.
      const item = decodeItem({
        id,
        space,
        title: str(body.title) || str(row.text).split("\n")[0],
        body: str(row.text),
        kind,
        decision: "",
        notify: false,
        attachments: attachmentsOf(body),
        ...(Array.isArray(body.options) && { options: body.options }),
        ...(Array.isArray(body.drafts) && { drafts: body.drafts }),
        // What closes it by itself there (Switchboard's resolve_when) closes it here too.
        ...(typeof body.resolve_when === "string" && { resolveWhen: body.resolve_when }),
      })
      if (Option.isNone(item)) {
        return yield* Effect.fail(new Error(`Invalid Switchboard item ${str(row.id)}`))
      }
      yield* copyAttachments(item.value.attachments ?? [])
      yield* brain.ingest([
        {
          id: EventId.make(`sb:item:opened:${str(row.id)}`),
          type: ItemOpened.type,
          source: "switchboard",
          time: num(row.at),
          payload: item.value,
        },
      ])
      changed += 1
    }
    return changed
  })
