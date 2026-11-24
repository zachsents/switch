// What the contacts extension's tools answer, as the view reads them.
import { Schema } from "effect"

const fact = Schema.Struct({
  kind: Schema.String,
  value: Schema.String,
  service: Schema.optionalKey(Schema.String),
})
export type Fact = typeof fact.Type

/** What a person is, when it's known. */
export const TYPES = ["person", "company", "system"] as const
export type PersonType = (typeof TYPES)[number]
const personType = Schema.Literals(TYPES)

export const People = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      type: Schema.optionalKey(personType),
      labels: Schema.optionalKey(Schema.Array(Schema.String)),
      fields: Schema.Array(fact),
    }),
  ),
})
export type Listed = (typeof People.Type)["people"][number]

const field = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  value: Schema.String,
  label: Schema.optionalKey(Schema.String),
  service: Schema.optionalKey(Schema.String),
  source: Schema.String,
  url: Schema.optionalKey(Schema.String),
  confidence: Schema.Finite,
  user: Schema.Boolean,
  suggested: Schema.optionalKey(Schema.Boolean),
  at: Schema.Finite,
})
export type Field = typeof field.Type

export const Person = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.optionalKey(Schema.NullOr(personType)),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  links: Schema.optionalKey(
    Schema.Struct({ apple: Schema.Array(Schema.String), google: Schema.Array(Schema.String) }),
  ),
  fields: Schema.Array(field),
  conflicts: Schema.Array(
    Schema.Struct({
      target: Schema.String,
      key: Schema.String,
      ours: Schema.String,
      theirs: Schema.String,
    }),
  ),
})
export type Person = typeof Person.Type

export const History = Schema.Struct({
  changes: Schema.Array(
    Schema.Struct({
      batch: Schema.String,
      reason: Schema.String,
      at: Schema.Finite,
      undone: Schema.Boolean,
      created: Schema.Boolean,
      added: Schema.Array(fact),
      removed: Schema.Array(fact),
      merged: Schema.Array(Schema.String),
      split: Schema.Array(Schema.String),
      sent: Schema.Array(Schema.String),
    }),
  ),
})
export type Change = (typeof History.Type)["changes"][number]

export const Log = Schema.Struct({
  batches: Schema.Array(
    Schema.Struct({
      batch: Schema.String,
      reason: Schema.String,
      at: Schema.Finite,
      events: Schema.Finite,
      undone: Schema.Boolean,
    }),
  ),
})

/** What a change answers: who, and its batch, for undo. */
export const Done = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  batch: Schema.optionalKey(Schema.String),
})
