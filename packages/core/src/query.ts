// POST /query: the few queries in Switchboard's language old appendages still ask through `sb
// query`, answered from their own records in the log. An entity's facts are its latest
// observation's. Anything else is refused, so a caller never mistakes it for no rows.
import type { Database } from "bun:sqlite"
import { Brain, defineRead } from "@switch/brain"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"

import { web } from "./web.ts"

const Asked = Schema.Struct({ q: Schema.String, source: Schema.String })
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Asked))

const ENTITIES = /^entities \| where id (?<op>startswith|==) "(?<id>[^"]+)" \| project id, facts$/u
const STREAM =
  /^stream\("(?<stream>[^"]+)"\) \| where kind == "(?<kind>\w+)" \| latest by body\.entity \| project entity = body\.entity, facts = body\.facts$/u

interface Row {
  readonly entity: string
  readonly facts: string | null
}

const json: (text: string) => unknown = JSON.parse

const parsed = (rows: readonly Row[]) =>
  rows.map((r) => ({ id: r.entity, facts: r.facts === null ? null : json(r.facts) }))

// The latest of each entity among an extension's observations: SQLite takes a bare column from the
// max row. Its own records only, found by their types, which the shim prefixes with its name
// (`google.` up to `google/`): the log's type index reads those alone, where a scan by source read
// the whole log, seconds of a held event loop on every ask. Switchboard's queries narrowed the same
// way, through the log's indexes (docs.md, Queries).
const LATEST = `SELECT json_extract(payload, '$.data.entity') AS entity, json_extract(payload, '$.data.facts') AS facts, max(seq)
  FROM events INDEXED BY events_type
  WHERE type >= ? AND type < ? AND source = ? AND json_extract(payload, '$.kind') = ?`

/** The bounds of `source`'s event types, then itself. */
const own = (source: string) => [`${source}.`, `${source}/`, source]

const answer = (db: Database, q: string, source: string) => {
  const e = ENTITIES.exec(q.trim())?.groups
  if (e?.id !== undefined) {
    const match = e.op === "==" ? "= ?" : "LIKE ? ESCAPE '\\'"
    const id = e.op === "==" ? e.id : `${e.id.replaceAll(/[%_\\]/gu, "\\$&")}%`
    const rows = db
      .query<Row, string[]>(
        `${LATEST} AND json_extract(payload, '$.data.entity') ${match} GROUP BY entity`,
      )
      .all(...own(source), "observation", id)
    return { columns: ["id", "facts"], rows: parsed(rows) }
  }
  const s = STREAM.exec(q.trim())?.groups
  if (s?.stream !== undefined && s.kind !== undefined) {
    const rows = db
      .query<Row, string[]>(
        `${LATEST} AND json_extract(payload, '$.stream') = ? AND entity IS NOT NULL GROUP BY entity`,
      )
      .all(...own(source), s.kind, s.stream)
    return {
      columns: ["entity", "facts"],
      rows: parsed(rows).map((r) => ({ entity: r.id, facts: r.facts })),
    }
  }
  return null
}

/** `q` answered from `source`'s observations, or null when it isn't a query Switch knows. */
const answerRead = defineRead("core/query/answer", answer)

export const queryRoute = Layer.unwrap(
  Brain.pipe(
    Effect.map((brain) =>
      HttpRouter.add(
        "POST",
        "/query",
        web(async (request) => {
          const asked = decode(await request.text())
          if (asked._tag === "None") {
            return Response.json({ error: "Bad query" }, { status: 400 })
          }
          const { q, source } = asked.value
          const found = await Effect.runPromise(brain.read(answerRead, q, source))
          return found === null
            ? Response.json({ error: `Not in Switch: ${q}` }, { status: 400 })
            : Response.json(found)
        }),
      ),
    ),
  ),
)
