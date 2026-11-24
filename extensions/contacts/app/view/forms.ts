// What each form takes, as Effect Schema through Standard Schema (TanStack Form's validators).
import { Schema } from "effect"

import { TYPES } from "./answers.ts"

/** Kinds a person adds by hand, in the order the menu lists them. */
export const ADDABLE = ["phone", "email", "location", "birthday", "url", "name"] as const

const filled = Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty())

const addField = Schema.Struct({ kind: Schema.Literals(ADDABLE), value: filled })
export const addFieldForm = Schema.toStandardSchemaV1(addField)

/** A blank add-field line. */
export const BLANK_FIELD: { kind: (typeof ADDABLE)[number]; value: string } = {
  kind: "phone",
  value: "",
}

export const newPersonForm = Schema.toStandardSchemaV1(
  Schema.Struct({ name: filled, phone: Schema.String, email: Schema.String }),
)

/** The list's filters: a type, or none set ("none"), and a label; "" is any. */
export const KIND_FILTERS = ["", ...TYPES, "none"] as const
export type KindFilter = (typeof KIND_FILTERS)[number]

export const searchForm = Schema.toStandardSchemaV1(
  Schema.Struct({
    query: Schema.String,
    label: Schema.String,
    type: Schema.Literals(KIND_FILTERS),
  }),
)

/** The list's search and filters, cleared. */
export const NO_SEARCH: { query: string; label: string; type: KindFilter } = {
  query: "",
  label: "",
  type: "",
}

/** A single field edited in place: anything, since blank clears it. */
export const detailForm = Schema.toStandardSchemaV1(Schema.Struct({ value: Schema.String }))

export const labelForm = Schema.toStandardSchemaV1(Schema.Struct({ label: filled }))
