// A person's single fields as the page edits them: the one each kind shows, and what `set` is
// sent for a value typed in its cell.
import { TYPES } from "./answers.ts"
import type { Field, Person } from "./answers.ts"
import type { Settable } from "./mutations.ts"

/** Kinds the details grid holds, so the fields list leaves them out. */
export const DETAIL_KINDS = new Set([
  "given",
  "family",
  "initial",
  "nickname",
  "type",
  "group",
  "relationship",
  "note",
  "company",
  "role",
])

export const rank = (f: Field) => (f.user ? 2 : 0) + f.confidence + f.at / 1e15

/** The value a single kind shows: the user's own first, then the surest, then the newest. */
export const bestOf = (person: Person, kind: string) =>
  person.fields
    .filter((f) => f.kind === kind && f.suggested !== true)
    .toSorted((a, b) => rank(b) - rank(a))
    .at(0)?.value ?? ""

/** Their labels, as the extension answers them or, from an older one, their group fields. */
export const labelsOf = (person: Person) =>
  person.labels ?? [
    ...new Set(
      person.fields.filter((f) => f.kind === "group" && f.suggested !== true).map((f) => f.value),
    ),
  ]

/** The family cell: the family name, else the initial alone. */
export const familyOf = (person: Person) => {
  const family = bestOf(person, "family")
  const initial = bestOf(person, "initial")
  if (family === "" && initial !== "") {
    return { label: "Initial", value: `${initial}.` }
  }
  return { label: "Family", value: family }
}

/** One letter, with or without its dot, is an initial; anything longer a family name. */
export const familySet = (v: string | null): Partial<Record<Settable, string | null>> => {
  if (v === null) {
    return { family: null }
  }
  const one = /^(?<letter>\p{L})\.?$/u.exec(v)?.groups?.letter
  return one === undefined ? { family: v } : { initial: one }
}

/** What they are: as the extension answers it or, from an older one, their type field. */
export const typeOf = (person: Person) =>
  person.type === undefined
    ? (TYPES.find((t) => t === bestOf(person, "type")) ?? null)
    : person.type
