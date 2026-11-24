// The side list's lines: worked out from the extension's answers on every render (the compiler
// keeps them while nothing changes), searched in the view with the extension's own scoring, so
// typing never waits on the network.
import { useQuery } from "@tanstack/react-query"

import { score } from "../../src/text.ts"
import type { Listed } from "./answers.ts"
import type { KindFilter } from "./forms.ts"
import { peopleQuery } from "./queries.ts"

export type Line =
  | {
      readonly kind: "head"
      readonly key: string
      readonly label: string
      readonly count: number
    }
  | { readonly kind: "empty"; readonly key: string; readonly label: string }
  | {
      readonly kind: "person"
      readonly key: string
      readonly id: string
      readonly name: string
      readonly detail?: string
    }

/** Names before numbers and addresses, then as a book sorts them. */
const byName = (a: Listed, b: Listed) => {
  const la = /^\p{L}/u.test(a.name)
  const lb = /^\p{L}/u.test(b.name)
  if (la !== lb) {
    return la ? -1 : 1
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
}

const person = (section: string, p: { id: string; name: string }, detail?: string): Line =>
  detail === undefined
    ? { kind: "person", key: `${section}:${p.id}`, id: p.id, name: p.name }
    : { kind: "person", key: `${section}:${p.id}`, id: p.id, name: p.name, detail }

/** Every label anyone has, as first written, in order. */
export const labelsIn = (everyone: readonly Listed[]) => {
  const seen = new Map<string, string>()
  for (const p of everyone) {
    for (const l of p.labels ?? []) {
      if (!seen.has(l.toLowerCase())) {
        seen.set(l.toLowerCase(), l)
      }
    }
  }
  return [...seen.values()].toSorted((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  )
}

const fits = (p: Listed, label: string, type: KindFilter) =>
  (label === "" || (p.labels ?? []).some((l) => l.toLowerCase() === label.toLowerCase())) &&
  (type === "" || (p.type ?? "none") === type)

export const useListing = ({
  query,
  label,
  type,
}: {
  query: string
  label: string
  type: KindFilter
}) => {
  const people = useQuery(peopleQuery)
  const all = people.data ?? []
  const labels = labelsIn(all)
  const filtered = label !== "" || type !== ""
  const everyone = filtered ? all.filter((p) => fits(p, label, type)) : all
  const lines: Line[] = []
  if (query.trim() === "") {
    lines.push({ kind: "head", key: "h:people", label: "People", count: everyone.length })
    for (const p of everyone.toSorted(byName)) {
      lines.push(person("people", p))
    }
  } else {
    const hits = everyone
      .map((p) => ({ p, s: score(p.fields, query) }))
      .filter((h) => h.s > 0)
      .toSorted((a, b) => b.s - a.s || byName(a.p, b.p))
    lines.push({ kind: "head", key: "h:people", label: "People", count: hits.length })
    for (const h of hits) {
      lines.push(person("people", h.p))
    }
  }
  if (people.isSuccess && lines.at(-1)?.kind === "head") {
    lines.push({ kind: "empty", key: "empty", label: "Nobody" })
  }
  const order = new Set<string>()
  for (const l of lines) {
    if (l.kind === "person") {
      order.add(l.id)
    }
  }
  const { error } = people
  return { lines, labels, order: [...order], error: error === null ? null : error.message }
}
