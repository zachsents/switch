// Every field as it's kept, whatever wrote it: phones in E.164, names clean and cased, a full name
// split into given and family when that's all there is. Applied to each change before it's written.
import { isSupportedCountry } from "libphonenumber-js"
import type { CountryCode } from "libphonenumber-js"
import type { Draft } from "switch-ext-kit"

import { cleanName, cleanText, isInitial, normalName, splitName, splitTag } from "./names.ts"
import { PersonCreated, PersonMerged, PersonSplit, PersonUpdated, ranked, TYPES } from "./model.ts"
import type { Field, Kind, Person } from "./model.ts"
import { e164 } from "./text.ts"

/** Where a phone with no country code is read: `CONTACTS_REGION`, else the US. */
const REGION: CountryCode = (() => {
  const r = process.env.CONTACTS_REGION ?? "US"
  return isSupportedCountry(r) ? r : "US"
})()

const TYPE_WORDS: Readonly<Record<string, string>> = {
  organization: "company",
  organisation: "company",
  business: "company",
  bot: "system",
  automated: "system",
}

const typeOf = (v: string) => {
  const t = v.trim().toLowerCase()
  return TYPE_WORDS[t] ?? t
}

/** One value, its kind possibly changed: a nickname stated as a name, a one-letter family name. */
export const normalValue = (
  kind: Kind,
  value: string,
  label?: string,
): { kind: Kind; value: string } => {
  if (kind === "phone") {
    return { kind, value: e164(value, REGION) }
  }
  if (kind === "email") {
    const v = value.trim()
    const at = v.lastIndexOf("@")
    return { kind, value: at === -1 ? v : `${v.slice(0, at)}${v.slice(at).toLowerCase()}` }
  }
  if (kind === "name" && label === "nickname") {
    return { kind: "nickname", value: normalName(value) }
  }
  if (kind === "name" || kind === "given" || kind === "nickname") {
    return { kind, value: normalName(value) }
  }
  if (kind === "family") {
    const v = normalName(value)
    return isInitial(v)
      ? { kind: "initial", value: v.replace(".", "").toUpperCase() }
      : { kind, value: v }
  }
  if (kind === "initial") {
    return { kind, value: cleanName(value).replace(".", "").slice(0, 1).toUpperCase() }
  }
  if (kind === "company" || kind === "role" || kind === "relation") {
    return { kind, value: cleanName(value) }
  }
  if (kind === "type") {
    return { kind, value: typeOf(value) }
  }
  if (kind === "group" || kind === "relationship" || kind === "location") {
    return { kind, value: cleanText(value) }
  }
  if (kind === "handle") {
    return { kind, value: value.trim().replace(/^@/u, "") }
  }
  return { kind, value: value.trim() }
}

export const normalField = (f: Field): Field => {
  const n = normalValue(f.kind, f.value, f.label)
  if (n.kind === f.kind && n.value === f.value) {
    return f
  }
  const relabeled = n.kind === "nickname" && f.kind === "name"
  if (relabeled) {
    const { label: _, ...rest } = f
    return { ...rest, kind: n.kind, value: n.value }
  }
  return { ...f, kind: n.kind, value: n.value }
}

/** A field that holds nothing, or a type that isn't one. */
const empty = (f: Field) =>
  f.value === "" || (f.kind === "type" && !(TYPES as readonly string[]).includes(f.value))

const NAMED: ReadonlySet<Kind> = new Set(["name", "given", "family", "nickname"])

/** The labels tagged onto names ("Ann Lee · Acme"), as label fields, from the same source. */
export const tagsOf = (fs: readonly Field[], have: readonly Field[]): Field[] => {
  const seen = new Set(
    [...have, ...fs].filter((f) => f.kind === "group").map((f) => f.value.toLowerCase()),
  )
  const out: Field[] = []
  for (const f of fs.filter((x) => NAMED.has(x.kind))) {
    const { tag } = splitTag(cleanText(f.value))
    if (tag !== undefined && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase())
      out.push({ ...f, id: crypto.randomUUID(), kind: "group", value: tag })
    }
  }
  return out
}

const fieldsOf = (fs: readonly Field[], have: readonly Field[]) => [
  ...fs.map((f) => normalField(f)).filter((f) => !empty(f)),
  ...tagsOf(fs, have),
]

/** A change's events with every field it adds made normal; `read` is who holds what already. */
export const normalEvents = (
  events: readonly Draft[],
  read: (id: string) => readonly Field[],
): Draft[] =>
  events.map((e) => {
    if (e.type === PersonCreated.type) {
      const p = PersonCreated.decode(e.payload)
      return PersonCreated.make({ ...p, fields: fieldsOf(p.fields, []) })
    }
    if (e.type === PersonUpdated.type) {
      const p = PersonUpdated.decode(e.payload)
      return PersonUpdated.make({ ...p, added: fieldsOf(p.added, read(p.id)) })
    }
    return e
  })

const live = (f: Field) => f.suggested !== true

const same = (a: Field, b: Field) => a.kind === b.kind && a.value === b.value

/** Someone set this part (given, or family or initial) rather than it being worked out. */
const stated = (fields: readonly Field[], kinds: readonly Kind[]) =>
  fields.some((f) => kinds.includes(f.kind) && f.source !== "derived" && live(f))

const bestStated = (fields: readonly Field[], kinds: readonly Kind[]) =>
  fields.find((f) => kinds.includes(f.kind) && f.source !== "derived" && live(f))?.value

/**
 * The parts of a full name nobody set: all of them from a split when none was set, else only
 * what's left of the name around the part that was ("Ann Lee" with given Ann set leaves family
 * Lee; a name that is just the given leaves nothing).
 */
const partsLeft = (
  full: string,
  fields: readonly Field[],
  givenSet: boolean,
  lastSet: boolean,
): { given?: string; family?: string; initial?: string } | null => {
  if (!givenSet && !lastSet) {
    return splitName(full)
  }
  const name = normalName(full)
  const lower = name.toLowerCase()
  if (givenSet) {
    const given = normalName(bestStated(fields, ["given"]) ?? "").toLowerCase()
    const rest = lower.startsWith(`${given} `) ? name.slice(given.length + 1) : ""
    const last = rest === "" ? null : splitName(`${given} ${rest}`)
    return last === null
      ? null
      : {
          ...(last.family === undefined ? {} : { family: last.family }),
          ...(last.initial === undefined ? {} : { initial: last.initial }),
        }
  }
  const lastValue = bestStated(fields, ["family"]) ?? `${bestStated(fields, ["initial"]) ?? ""}.`
  const last = normalName(lastValue).toLowerCase()
  const rest = lower.endsWith(` ${last}`) ? name.slice(0, name.length - last.length - 1) : ""
  const given = rest === "" ? splitName(full)?.given : rest
  return given === undefined ? null : { given }
}

/**
 * Given, family or initial worked out from their name, each where nobody set that part (given;
 * family or initial), for a person (not a company or system).
 */
const wantedParts = (fields: readonly Field[], id: string): Field[] => {
  const p: Person = { id, created: 0, updated: 0, fields }
  const givenSet = stated(fields, ["given"])
  const lastSet = stated(fields, ["family", "initial"])
  if (givenSet && lastSet) {
    return []
  }
  const type = ranked(p, "type").find(live)?.value
  if (type === "company" || type === "system") {
    return []
  }
  const name = ranked(p, "name").find((f) => live(f) && f.label === undefined)
  const split = name === undefined ? null : partsLeft(name.value, fields, givenSet, lastSet)
  if (name === undefined || split === null) {
    return []
  }
  const out: Field[] = []
  const parts: readonly (readonly [Kind, string | undefined])[] = [
    ["given", givenSet ? undefined : split.given],
    ["family", lastSet ? undefined : split.family],
    ["initial", lastSet ? undefined : split.initial],
  ]
  for (const [kind, raw] of parts) {
    const value = raw === undefined ? "" : normalValue(kind, raw).value
    if (value !== "") {
      out.push({
        id: crypto.randomUUID(),
        kind,
        value,
        source: "derived",
        confidence: name.confidence,
        user: false,
        at: name.at,
      })
    }
  }
  return out
}

/** The derived parts a person should hold now, against those they hold: what to add and remove. */
export const partsChange = (fields: readonly Field[], id: string) => {
  const want = wantedParts(fields, id)
  const have = fields.filter((f) => f.source === "derived")
  return {
    added: want.filter((w) => !have.some((h) => same(h, w))),
    removed: have.filter((h) => !want.some((w) => same(h, w))),
  }
}

/** Who each event leaves holding which fields, starting from `read` for anyone not yet seen. */
export const afterEvents = (
  events: readonly Draft[],
  read: (id: string) => readonly Field[] | null,
) => {
  const state = new Map<string, Field[]>()
  const of = (id: string) => {
    const had = state.get(id)
    if (had !== undefined) {
      return had
    }
    const fresh = [...(read(id) ?? [])]
    state.set(id, fresh)
    return fresh
  }
  for (const e of events) {
    if (e.type === PersonCreated.type) {
      const p = PersonCreated.decode(e.payload)
      state.set(p.id, [...p.fields])
    } else if (e.type === PersonUpdated.type) {
      const p = PersonUpdated.decode(e.payload)
      const gone = new Set(p.removed.map((f) => f.id))
      state.set(p.id, [...of(p.id).filter((f) => !gone.has(f.id)), ...p.added])
    } else if (e.type === PersonMerged.type) {
      const p = PersonMerged.decode(e.payload)
      state.set(p.into, [...of(p.into), ...of(p.from)])
      state.set(p.from, [])
    } else if (e.type === PersonSplit.type) {
      const p = PersonSplit.decode(e.payload)
      const back = new Set(p.fields.map((f) => f.id))
      const into = of(p.into)
      state.set(
        p.into,
        into.filter((f) => !back.has(f.id)),
      )
      state.set(p.from, [...of(p.from), ...into.filter((f) => back.has(f.id))])
    }
  }
  return state
}
