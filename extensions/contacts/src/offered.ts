// Other sources, such as a business's CRM: any extension publishes the people it knows as
// `<extension>.contact` events in Switch's brain, and they come in here like an address book's
// cards, each under its extension's name. An extension publishes a record again whenever it
// changes.
import { Effect, Schema } from "effect"

import { brainEvents } from "./core.ts"
import type { SourceRecord } from "./merge.ts"
import type { Stated } from "./store.ts"

const strings = Schema.optionalKey(Schema.Array(Schema.String))
const one = Schema.optionalKey(Schema.String)

/** The payload of an `<extension>.contact` event. */
export const Offered = Schema.Struct({
  /** Its id in that source. */
  ref: Schema.String,
  name: one,
  aliases: strings,
  emails: strings,
  phones: strings,
  handles: Schema.optionalKey(
    Schema.Array(Schema.Struct({ service: Schema.String, value: Schema.String })),
  ),
  company: one,
  role: one,
  note: one,
  /** Switch spaces they belong in. */
  spaces: strings,
})
export type Offer = typeof Offered.Type

const decode = Schema.decodeUnknownOption(Offered)

const PHONE_ONLY = /^[+\d\s().-]+$/u

export const toRecord = (source: string, o: Offer): SourceRecord => {
  const fields: Stated[] = []
  const name = (o.name ?? "").trim()
  if (name !== "" && !PHONE_ONLY.test(name)) {
    fields.push({ kind: "name", value: name })
  }
  for (const a of o.aliases ?? []) {
    fields.push({ kind: "name", value: a, label: "alias", confidence: 0.7 })
  }
  for (const value of o.emails ?? []) {
    fields.push({ kind: "email", value })
  }
  for (const value of o.phones ?? []) {
    fields.push({ kind: "phone", value })
  }
  for (const h of o.handles ?? []) {
    fields.push({ kind: "handle", value: h.value, service: h.service })
  }
  if (o.company !== undefined) {
    fields.push({ kind: "company", value: o.company })
  }
  if (o.role !== undefined) {
    fields.push({ kind: "role", value: o.role })
  }
  if (o.note !== undefined) {
    fields.push({ kind: "note", value: o.note })
  }
  for (const value of o.spaces ?? []) {
    fields.push({ kind: "space", value })
  }
  return { source, ref: { service: source, value: o.ref }, fields, user: false, create: true }
}

/** Every source's records as last published, by source; fails when the core can't be reached. */
export const offered = Effect.gen(function* reading() {
  const { events, whole } = yield* brainEvents(
    [{ field: "type", op: "contains", value: ".contact" }],
    0,
  )
  if (!whole) {
    return yield* Effect.fail(new Error("Can't reach the core"))
  }
  const latest = new Map<string, { source: string; o: Offer }>()
  for (const e of events) {
    if (!e.type.endsWith(".contact") || e.type.startsWith("contacts.")) {
      continue
    }
    const o = decode(e.payload)
    if (o._tag === "Some") {
      latest.set(`${e.source}\n${o.value.ref}`, { source: e.source, o: o.value })
    }
  }
  const by = new Map<string, SourceRecord[]>()
  for (const { source, o } of latest.values()) {
    const list = by.get(source) ?? []
    list.push(toRecord(source, o))
    by.set(source, list)
  }
  return by
})
