// What a pass skipped, kept in its own file until a later try works: a source's record that
// wouldn't take, or an event of the log the brain's side refused. One that fails never stops the
// rest; it waits here, with why.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync } from "node:fs"
import path from "node:path"
import { writeFileAtomic } from "switch-ext-kit"
import { Schema } from "effect"

import type { Matching, SourceRecord } from "./merge.ts"
import { KINDS } from "./model.ts"
import { DIR } from "./store.ts"

const FILE = path.join(DIR, "contacts-skipped.json")

const optional = Schema.optionalKey

const KeptRecord = Schema.Struct({
  kind: Schema.Literal("record"),
  key: Schema.String,
  source: Schema.String,
  matching: Schema.Literals(["model", "keys", "exact"]),
  record: Schema.Struct({
    source: Schema.String,
    ref: optional(Schema.Struct({ service: Schema.String, value: Schema.String })),
    fields: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(KINDS),
        value: Schema.String,
        label: optional(Schema.String),
        service: optional(Schema.String),
        url: optional(Schema.String),
        confidence: optional(Schema.Finite),
        suggested: optional(Schema.Boolean),
      }),
    ),
    user: Schema.Boolean,
    create: Schema.Boolean,
    lastContact: optional(Schema.Finite),
    messaged: optional(Schema.Boolean),
  }),
  error: Schema.String,
  at: Schema.Finite,
})

const KeptEvent = Schema.Struct({
  kind: Schema.Literal("event"),
  key: Schema.String,
  id: Schema.String,
  type: Schema.String,
  payload: Schema.Unknown,
  error: Schema.String,
  at: Schema.Finite,
})

const Kept = Schema.Union([KeptRecord, KeptEvent])
export type Kept = typeof Kept.Type

const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Kept)))

let cache: Map<string, Kept> | null = null

const all = () => {
  if (cache === null) {
    cache = new Map()
    if (existsSync(FILE)) {
      try {
        for (const k of decode(readFileSync(FILE, "utf-8"))) {
          cache.set(k.key, k)
        }
      } catch {
        // Unreadable: set aside, not written over.
        renameSync(FILE, `${FILE}.unreadable`)
      }
    }
  }
  return cache
}

const write = () => {
  writeFileAtomic(FILE, JSON.stringify([...all().values()]))
}

const recordKey = (source: string, record: SourceRecord) =>
  `record:${createHash("sha256")
    .update(`${source}\n${JSON.stringify(record)}`)
    .digest("hex")}`

/** What's kept, oldest first. */
export const kept = (): readonly Kept[] => [...all().values()].toSorted((a, b) => a.at - b.at)

/** A record that wouldn't take, with why; kept again it's the same one, with the newer why. */
export const keepRecord = (
  source: string,
  matching: Matching,
  record: SourceRecord,
  error: string,
) => {
  const key = recordKey(source, record)
  const had = all().get(key)
  all().set(key, {
    kind: "record",
    key,
    source,
    matching,
    record,
    error,
    at: had?.at ?? Date.now(),
  })
  write()
}

/** A record that took after all. */
export const tookRecord = (source: string, record: SourceRecord) => {
  if (all().delete(recordKey(source, record))) {
    write()
  }
}

/** An event the brain's side refused, with why. */
export const keepEvent = (e: { id: string; type: string; payload: unknown }, error: string) => {
  const key = `event:${e.id}`
  const had = all().get(key)
  all().set(key, { kind: "event", key, ...e, error, at: had?.at ?? Date.now() })
  write()
}

/** Tried again: gone when it worked, else kept with the newer why. */
export const tried = (key: string, error: string | null) => {
  const k = all().get(key)
  if (k === undefined) {
    return
  }
  if (error === null) {
    all().delete(key)
  } else {
    all().set(key, { ...k, error })
  }
  write()
}

/** What's kept as one line: how many, and the oldest with its why. */
export const keptLine = () => {
  const list = kept()
  const [first] = list
  if (first === undefined) {
    return null
  }
  const what =
    first.kind === "record"
      ? `${first.source} ${first.record.fields[0]?.value ?? first.record.ref?.value ?? "record"}`
      : `${first.type} ${first.id}`
  const line = `${what}: ${first.error}`
  return list.length === 1 ? line : `${list.length} skipped; ${line}`
}
