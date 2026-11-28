// POST /draft/files: files shared from the iPhone's share sheet, already in the blobs, into the
// draft the user is writing on a Mac. The one they're at (presence.ts) takes them into the box in
// front; away from every Mac, the one used last takes them into Home's. Recorded as `draft.shared`,
// which goes to the desktops live; each takes only what names it.
import { Attachment, Brain, defineEvent, defineRead, EventId } from "@switch/brain"
import { Effect, Layer, Option, Schema } from "effect"
import { HttpRouter } from "effect/http"

import { macs } from "./presence.ts"
import { web } from "./web.ts"

export const DraftShared = defineEvent(
  "draft.shared",
  1,
  Schema.Struct({
    files: Schema.Array(Attachment),
    /** The Mac that takes them; none when no Mac has said where the user is. */
    machine: Schema.optionalKey(Schema.String),
    /** Into Home's box, the user being at no Mac. */
    home: Schema.optionalKey(Schema.Boolean),
  }),
)

export const draftConfig = { events: [DraftShared], projections: [], commands: [] }

const Asked = Schema.Struct({ files: Schema.Array(Attachment).check(Schema.isMinLength(1)) })
const decodeAsked = Schema.decodeUnknownOption(Schema.fromJsonString(Asked))

const macsRead = defineRead("core/draft/macs", (db, now: number) => macs(db, now))

export const draftRoute = Layer.unwrap(
  Effect.gen(function* routing() {
    const brain = yield* Brain
    return HttpRouter.add(
      "POST",
      "/draft/files",
      web(async (request) => {
        const asked = decodeAsked(await request.text())
        if (Option.isNone(asked)) {
          return Response.json({ error: "Bad files" }, { status: 400 })
        }
        const all = await Effect.runPromise(brain.read(macsRead, Date.now()))
        const at = all.find((m) => m.here) ?? all[0]
        await Effect.runPromise(
          brain.ingest([
            {
              id: EventId.make(`draft:${crypto.randomUUID()}`),
              type: DraftShared.type,
              source: "iphone",
              payload: {
                files: asked.value.files,
                ...(at !== undefined && { machine: at.machine }),
                ...(at?.here !== true && { home: true }),
              },
            },
          ]),
        )
        return Response.json({ to: at?.machine ?? null })
      }),
    )
  }),
)
