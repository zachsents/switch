import type { Database } from "bun:sqlite"
import { JsonSchema, Result, Schema, SchemaRepresentation } from "effect"

import { checker } from "switch-ext-kit"
import type { Draft, EventDef, Payload } from "switch-ext-kit"

import { EventId } from "./ids.ts"
import type { QuerySource } from "./query.ts"

export { checker, defineEvent, Rejected } from "switch-ext-kit"
export type { Check, Draft, EventDef, Payload } from "switch-ext-kit"

export const storedEvent = Schema.Struct({
  seq: Schema.Number,
  id: EventId,
  time: Schema.Number,
  type: Schema.String,
  v: Schema.Number,
  source: Schema.String,
  payload: Schema.Unknown,
})
/** One row of the log. `payload` is the encoded JSON form. */
export type StoredEvent = typeof storedEvent.Type

/** An event type known only by its JSON Schema, as an app lists it. Throws if Effect can't import it. */
const isJsonSchema = (v: unknown): v is JsonSchema.JsonSchema =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const eventFromJsonSchema = (type: string, version: number, schema: unknown): EventDef => {
  const imported = SchemaRepresentation.fromJsonSchemaDocument(
    JsonSchema.fromSchemaDraft2020_12(isJsonSchema(schema) ? schema : {}),
  )
  return { type, version, check: checker(Schema.make<Payload<unknown>>(imported.ast)) }
}

/**
 * A type's stored payload at `from`, as version `from + 1` reads it. A type's version moves on only
 * with one for each step: the log keeps every event as it was written, and a rebuild reads them all.
 */
export interface Upcast {
  readonly type: string
  readonly from: number
  readonly up: (payload: unknown) => unknown
}

export type Decision = { readonly events: readonly Draft[] } | { readonly reject: string }

export interface CommandDef {
  readonly type: string
  readonly handle: (db: Database, payload: unknown) => Decision
}

/** `load` reads projections; `decide` is pure. Both run in the writer's turn, so nothing interleaves. */
export const defineCommand = <const T extends string, P, S>(def: {
  readonly type: T
  readonly payload: Payload<P>
  readonly load: (db: Database, payload: P) => S
  readonly decide: (state: S, payload: P) => Decision
}) => {
  const decode = Schema.decodeUnknownResult(def.payload)
  return {
    ...def,
    handle: (db: Database, raw: unknown): Decision => {
      const p = decode(raw)
      return Result.isSuccess(p)
        ? def.decide(def.load(db, p.success), p.success)
        : { reject: `${def.type}: ${p.failure.message}` }
    },
  }
}

export interface On {
  readonly type: string
  readonly apply: (db: Database, event: StoredEvent) => void
}

export const on = <P>(
  def: { readonly type: string; readonly decode: (encoded: unknown) => P },
  apply: (db: Database, payload: P, event: StoredEvent) => void,
): On => ({
  type: def.type,
  apply: (db, event) => {
    apply(db, def.decode(event.payload), event)
  },
})

/** A named read model, updated in the write transaction and rebuildable from the log. */
export interface Projection {
  readonly name: string
  /** Bump to rebuild on next open. */
  readonly version: number
  readonly tables: readonly string[]
  readonly create: string
  /** Indexes on its tables, each `CREATE INDEX IF NOT EXISTS`, made on every open: one added
   * later reaches a brain without a rebuild. */
  readonly indexes?: string
  readonly on: readonly On[]
  readonly snapshot: (db: Database) => unknown
  /** What it offers to queries. */
  readonly sources?: readonly QuerySource[]
}
