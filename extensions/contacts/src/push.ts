// Outbound: Switch is the source of truth, and Apple and Google get what it holds, so caller ID and
// Gmail show it. A value the book holds that Switch once held too (it came from there, or Switch
// wrote it) gives way to Switch's; one Switch never saw is the user's edit in the book, left alone
// and recorded as a conflict. A person merged from several cards in one book keeps the first, which
// gets everything, and the others are deleted, each kept whole for undo. Nothing goes to a book
// before it's been imported, and nothing already there changes without a backup of both from the
// last hour.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Log } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect } from "effect"

import {
  appleCards,
  appleDump,
  appleEdit,
  appleMe,
  appleRelated,
  appleRestore,
  appleVcards,
} from "./apple.ts"
import type { AppleCard, AppleEdit, AppleList, AppleSingle, Labelled } from "./apple.ts"
import {
  googleConnected,
  googleCreate,
  googleDelete,
  googleGet,
  googleGroupMembers,
  googleGroupNamed,
  googleGroups,
  googlePeople,
  googleRestore,
  googleUpdate,
} from "./google.ts"
import type { GooglePerson } from "./google.ts"
import { why } from "./heartbeat.ts"
import { parse, rec, recs, text } from "./json.ts"
import type { Json } from "./json.ts"
import {
  best,
  Conflicted,
  everyone,
  nameOf,
  normOf,
  PersonCreated,
  PersonMerged,
  PersonUpdated,
  Pushed,
  ranked,
  resolve,
} from "./model.ts"
import type { Field, Kind, Person, Target } from "./model.ts"
import { normalValue } from "./normal.ts"
import { load } from "./state.ts"
import { books, commit, DIR, make } from "./store.ts"
import { phoneKey, profileUrl } from "./text.ts"

export const BACKUPS = path.join(DIR, "contacts-backup")

const stamp = () => new Date().toISOString().slice(0, 19).replaceAll(":", "-")

/** Both books, whole, as they are now: a folder per backup, by time. A book not reachable is left out. */
export const backup = Effect.gen(function* backingUp() {
  const dir = path.join(BACKUPS, stamp())
  mkdirSync(dir, { recursive: true })
  const out: { dir: string; apple?: number; google?: number; errors: string[] } = {
    dir,
    errors: [],
  }
  const apple = yield* Effect.result(Effect.all([appleVcards, appleDump]))
  if (apple._tag === "Success") {
    const [vcf, dump] = apple.success
    writeFileSync(path.join(dir, "apple.vcf"), vcf, { mode: 0o600 })
    writeFileSync(path.join(dir, "apple.json"), JSON.stringify(dump), { mode: 0o600 })
    out.apple = vcf.split("BEGIN:VCARD").length - 1
  } else {
    out.errors.push(`apple: ${apple.failure.message}`)
  }
  if (yield* googleConnected) {
    const google = yield* Effect.result(Effect.all([googlePeople, googleGroups]))
    if (google._tag === "Success") {
      const [people, groups] = google.success
      writeFileSync(path.join(dir, "google.json"), JSON.stringify(people, null, 1), {
        mode: 0o600,
      })
      writeFileSync(path.join(dir, "google-groups.json"), JSON.stringify([...groups]), {
        mode: 0o600,
      })
      out.google = people.length
    } else {
      out.errors.push(`google: ${google.failure.message}`)
    }
  } else {
    out.errors.push("google: not connected")
  }
  return out
})

const FRESH_MS = 3_600_000

const FILE: Readonly<Record<Target, string>> = { apple: "apple.vcf", google: "google.json" }

/** A backup of `target` from the last hour, else a new one: the folder, or a failure. */
const backedUp = (target: Target) =>
  Effect.gen(function* checking() {
    const recent = existsSync(BACKUPS)
      ? readdirSync(BACKUPS).find((d) => {
          const f = path.join(BACKUPS, d, FILE[target])
          return existsSync(f) && Date.now() - statSync(f).mtimeMs < FRESH_MS
        })
      : undefined
    if (recent !== undefined) {
      return path.join(BACKUPS, recent)
    }
    const made = yield* backup
    if (made[target] === undefined) {
      return yield* Effect.fail(new Error(`No backup of ${target}: ${made.errors.join("; ")}`))
    }
    return made.dir
  })

const OK = 0.8
const usable = (f: Field) => f.suggested !== true && f.confidence >= OK

/** Single values a card has one of. */
type Single = AppleSingle
const SINGLES: readonly Single[] = ["first", "last", "nick", "org", "title", "note"]
type ListKind = "phone" | "email" | "url"
const LISTS: readonly ListKind[] = ["phone", "email", "url"]
const LIST_OF: Readonly<Record<ListKind, AppleList>> = {
  phone: "phones",
  email: "emails",
  url: "urls",
}

/** The kinds of field each single comes from. */
const SINGLE_KINDS: Readonly<Record<Single, readonly Kind[]>> = {
  first: ["given"],
  last: ["family", "initial"],
  nick: ["nickname"],
  org: ["company"],
  title: ["role"],
  note: ["note"],
}

const singleValue = (f: Pick<Field, "kind" | "value">) =>
  f.kind === "initial" ? `${f.value}.` : f.value

/** How a single compares: names without case or decoration, the rest as trimmed text. */
const SINGLE_AS: Readonly<Record<Single, Kind>> = {
  first: "given",
  last: "family",
  nick: "nickname",
  org: "company",
  title: "role",
  note: "note",
}

/** How a single compares: made normal the way an import would, then without case or a last period. */
const singleNorm = (k: Single, v: string) => {
  if (k === "note") {
    return v.trim()
  }
  const n = normalValue(SINGLE_AS[k], v)
  return normOf("name", n.value).replace(/\.$/u, "")
}

const listKey = (kind: ListKind, value: string) => {
  if (kind === "phone") {
    const d = phoneKey(value)
    return d === "" ? "" : `phone:${d}`
  }
  if (kind === "email") {
    return `email:${value.trim().toLowerCase()}`
  }
  return `url:${value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(?:www\.)?/u, "")
    .replace(/\/$/u, "")}`
}

/** What Switch would have a card hold for a person. */
interface Want {
  readonly singles: Partial<Record<Single, string>>
  readonly company?: boolean
  readonly lists: Record<ListKind, Labelled[]>
  readonly groups: string[]
}

const bestOf = (p: Person, kinds: readonly Kind[]) => {
  const f = kinds.map((kind) => ranked(p, kind).find(usable)).find((x) => x !== undefined)
  return f === undefined ? undefined : singleValue(f)
}

const wanted = (p: Person, target: Target): Want => {
  const singles: Partial<Record<Single, string>> = {}
  for (const k of SINGLES) {
    const v = bestOf(p, SINGLE_KINDS[k])
    if (v !== undefined && v !== "") {
      singles[k] = v
    }
  }
  const type = bestOf(p, ["type"])
  if (type === "company" && singles.org === undefined && nameOf(p) !== "") {
    singles.org = nameOf(p)
  }
  const lists: Record<ListKind, Labelled[]> = { phone: [], email: [], url: [] }
  const seen = new Set<string>()
  const push = (kind: ListKind, value: string, label: string) => {
    const key = listKey(kind, value)
    if (key !== "" && !seen.has(key)) {
      seen.add(key)
      lists[kind].push({ value, label })
    }
  }
  for (const f of p.fields.filter(usable)) {
    if (f.kind === "phone") {
      push("phone", f.value, f.label ?? "mobile")
    } else if (f.kind === "email") {
      push("email", f.value, f.label ?? "other")
    } else if (f.kind === "url") {
      push("url", f.value, f.label ?? "homepage")
    } else if (f.kind === "handle") {
      const url = profileUrl(f)
      if (url !== null) {
        push("url", url, f.service ?? "")
      }
    }
  }
  const groups = [
    ...new Set(p.fields.filter((f) => f.kind === "group" && usable(f)).map((f) => f.value)),
  ]
  return {
    singles,
    ...(target === "apple" && (type === "company" || type === "person")
      ? { company: type === "company" }
      : {}),
    lists,
    groups,
  }
}

/** Everything Switch ever held for a person (and those merged into them), as card keys. */
interface Known {
  readonly singles: Record<Single, Set<string>>
  readonly lists: Set<string>
  readonly groups: Set<string>
}

const emptyKnown = (): Known => ({
  singles: {
    first: new Set(),
    last: new Set(),
    nick: new Set(),
    org: new Set(),
    title: new Set(),
    note: new Set(),
  },
  lists: new Set(),
  groups: new Set(),
})

const learn = (k: Known, f: Pick<Field, "kind" | "value" | "service" | "url">) => {
  for (const s of SINGLES) {
    if (SINGLE_KINDS[s].includes(f.kind)) {
      k.singles[s].add(singleNorm(s, singleValue(f)))
    }
  }
  if (f.kind === "phone" || f.kind === "email" || f.kind === "url") {
    k.lists.add(listKey(f.kind, f.value))
  }
  const url = profileUrl(f)
  if (url !== null) {
    k.lists.add(listKey("url", url))
  }
  if (f.kind === "group") {
    k.groups.add(f.value)
  }
}

/** A card as both books are read here. */
interface Remote {
  readonly singles: Record<Single, string>
  readonly company: boolean | null
  readonly lists: Record<ListKind, Labelled[]>
  readonly groups: readonly string[]
}

const appleRemote = (c: AppleCard): Remote => ({
  singles: { first: c.first, last: c.last, nick: c.nick, org: c.org, title: c.title, note: c.note },
  company: c.company,
  lists: { phone: c.phones, email: c.emails, url: c.urls },
  groups: c.groups,
})

const labelledOf = (v: unknown, key: string): Labelled[] =>
  recs(v).map((x) => ({ value: text(x[key]), label: text(x.type) }))

const googleRemote = (g: GooglePerson, groups: ReadonlyMap<string, string>): Remote => {
  const [name = {}] = recs(g.names)
  const [org = {}] = recs(g.organizations)
  const [nick = {}] = recs(g.nicknames)
  const [bio = {}] = recs(g.biographies)
  return {
    singles: {
      first: text(name.givenName),
      last: text(name.familyName),
      nick: text(nick.value),
      org: text(org.name),
      title: text(org.title),
      note: text(bio.value),
    },
    company: null,
    lists: {
      phone: labelledOf(g.phoneNumbers, "value"),
      email: labelledOf(g.emailAddresses, "value"),
      url: labelledOf(g.urls, "value"),
    },
    groups: recs(g.memberships).flatMap((m) => {
      const n = groups.get(text(rec(m.contactGroupMembership).contactGroupResourceName))
      return n === undefined ? [] : [n]
    }),
  }
}

/** One write, as recorded: `value` "" took it out; `was` what it replaced. */
interface Write {
  readonly key: string
  readonly value: string
  readonly was?: string
  readonly label?: string
}

export interface Plan {
  readonly person: Person
  readonly remote: string | null
  readonly writes: readonly Write[]
  readonly conflicts: readonly { key: string; ours: string; theirs: string }[]
}

const singlePlan = (
  k: Single,
  want: Want,
  r: Remote | null,
  known: Known,
  pushed: ReadonlyMap<string, string>,
  conflicted: ReadonlySet<string>,
) => {
  const d = want.singles[k]
  const c = (r?.singles[k] ?? "").trim()
  const norm = singleNorm(k, c)
  const knows = c !== "" && (norm === "" || known.singles[k].has(norm))
  if (d === undefined) {
    return c !== "" && knows && r !== null
      ? { write: { key: k, value: "", was: c } satisfies Write }
      : {}
  }
  if (c === d) {
    return {}
  }
  if (c === "") {
    return { write: { key: k, value: d } satisfies Write }
  }
  if (pushed.get(k) === c || knows) {
    return { write: { key: k, value: d, was: c } satisfies Write }
  }
  return conflicted.has(k) ? {} : { conflict: { key: k, ours: d, theirs: c } }
}

const listPlan = (kind: ListKind, want: Want, r: Remote | null, known: Known): Write[] => {
  const out: Write[] = []
  const have = r?.lists[kind] ?? []
  const wantKeys = new Set(want.lists[kind].map((w) => listKey(kind, w.value)))
  for (const w of want.lists[kind]) {
    const key = listKey(kind, w.value)
    const there = have.find((h) => listKey(kind, h.value) === key)
    if (there === undefined) {
      out.push({ key, value: w.value, label: w.label })
    } else if (there.value !== w.value) {
      out.push({ key, value: w.value, was: there.value })
    }
  }
  for (const h of have) {
    const key = listKey(kind, h.value)
    if (key !== "" && !wantKeys.has(key) && known.lists.has(key)) {
      out.push({ key, value: "", was: h.value })
    }
  }
  return out
}

/**
 * What to send one card: Switch's values where the card is blank or holds something Switch knew;
 * a single it never knew is a conflict, never rewritten.
 */
export const plan = (
  target: Target,
  p: Person,
  remoteId: string | null,
  r: Remote | null,
  known: Known,
  pushed: ReadonlyMap<string, string>,
  conflicted: ReadonlySet<string>,
): Plan => {
  const want = wanted(p, target)
  const writes: Write[] = []
  const conflicts: { key: string; ours: string; theirs: string }[] = []
  for (const k of SINGLES) {
    const s = singlePlan(k, want, r, known, pushed, conflicted)
    if (s.write !== undefined) {
      writes.push(s.write)
    }
    if (s.conflict !== undefined) {
      conflicts.push(s.conflict)
    }
  }
  if (want.company !== undefined && (r === null || r.company !== want.company)) {
    writes.push({
      key: "company",
      value: String(want.company),
      ...(r === null || r.company === null ? {} : { was: String(r.company) }),
    })
  }
  for (const kind of LISTS) {
    writes.push(...listPlan(kind, want, r, known))
  }
  const there = new Set(r?.groups)
  for (const g of want.groups) {
    if (!there.has(g)) {
      writes.push({ key: `group:${g}`, value: g })
    }
  }
  for (const g of there) {
    if (!want.groups.includes(g) && known.groups.has(g)) {
      writes.push({ key: `group:${g}`, value: "", was: g })
    }
  }
  return { person: p, remote: remoteId, writes, conflicts }
}

/** The person's records in one book, oldest link first, each once (a card linked twice is one card). */
const refsOf = (p: Person, target: Target) => [
  ...new Set(
    p.fields
      .filter((f) => f.kind === "ref" && f.service === target)
      .toSorted((a, b) => a.at - b.at)
      .map((f) => f.value),
  ),
]

/**
 * Who gets a new card: a person or company (not a system), named, with a number or an email, who
 * is in either book or has written to the user. Someone only another source knows stays in Switch,
 * and so does anyone whose number or email is already on a card in this book: likely the same
 * person under another name, for a merge to settle.
 */
const shouldCreate = (p: Person, taken: ReadonlySet<string>) => {
  const shared = p.fields.some(
    (f) => (f.kind === "phone" || f.kind === "email") && taken.has(listKey(f.kind, f.value)),
  )
  if (shared) {
    return false
  }
  const named = p.fields.some((f) => (f.kind === "name" || f.kind === "given") && usable(f))
  const reachable = p.fields.some((f) => (f.kind === "phone" || f.kind === "email") && usable(f))
  const inBook = refsOf(p, "apple").length > 0 || refsOf(p, "google").length > 0
  const messaged = p.fields.some((f) => f.kind === "last_contact" && f.label === "messaged")
  return named && reachable && (inBook || messaged) && best(p, "type") !== "system"
}

const listOf = (key: string): ListKind | null => {
  const head = key.split(":")[0] ?? ""
  return head === "phone" || head === "email" || head === "url" ? head : null
}

const isSingle = (k: string): k is Single => (SINGLES as readonly string[]).includes(k)

const appleEditOf = (pl: Plan): AppleEdit => {
  const set: Partial<Record<Single, string>> = {}
  const add: Partial<Record<AppleList, Labelled[]>> = {}
  const replace: Partial<Record<AppleList, { from: string; to: string }[]>> = {}
  const remove: Partial<Record<AppleList, string[]>> = {}
  const groups: { add: string[]; remove: string[] } = { add: [], remove: [] }
  let company: boolean | undefined
  for (const w of pl.writes) {
    const list = listOf(w.key)
    if (isSingle(w.key)) {
      set[w.key] = w.value
    } else if (w.key === "company") {
      company = w.value === "true"
    } else if (w.key.startsWith("group:")) {
      ;(w.value === "" ? groups.remove : groups.add).push(w.value || (w.was ?? ""))
    } else if (list !== null) {
      const name = LIST_OF[list]
      if (w.value === "") {
        remove[name] = [...(remove[name] ?? []), w.was ?? ""]
      } else if (w.was === undefined) {
        add[name] = [...(add[name] ?? []), { value: w.value, label: w.label ?? "" }]
      } else {
        replace[name] = [...(replace[name] ?? []), { from: w.was, to: w.value }]
      }
    }
  }
  return {
    ...(pl.remote === null ? {} : { id: pl.remote }),
    set,
    add,
    replace,
    remove,
    groups,
    ...(company === undefined ? {} : { company }),
  }
}

const GOOGLE_LISTS: Readonly<Record<ListKind, { field: string; value: string }>> = {
  phone: { field: "phoneNumbers", value: "value" },
  email: { field: "emailAddresses", value: "value" },
  url: { field: "urls", value: "value" },
}

/** One Google list with the plan's adds, replacements and removals applied. */
const googleList = (kind: ListKind, writes: readonly Write[], g: GooglePerson | null) => {
  const { field } = GOOGLE_LISTS[kind]
  let items: Json[] = [...recs(g?.[field])]
  let touched = false
  for (const w of writes.filter((x) => listOf(x.key) === kind)) {
    touched = true
    if (w.value === "") {
      items = items.filter((x) => text(x.value) !== w.was)
    } else if (w.was === undefined) {
      items.push({ value: w.value, type: w.label ?? "" })
    } else {
      items = items.map((x) => (text(x.value) === w.was ? { ...x, value: w.value } : x))
    }
  }
  return touched ? { field, items } : null
}

/** Google's name with the plan's given and family in it. */
const googleNames = (singles: ReadonlyMap<string, string>, g: GooglePerson | null) => {
  const [name = {}] = recs(g?.names)
  const named: Json = { ...name }
  delete named.displayName
  delete named.unstructuredName
  delete named.displayNameLastFirst
  if (singles.has("first")) {
    named.givenName = singles.get("first")
  }
  if (singles.has("last")) {
    named.familyName = singles.get("last")
  }
  return [named]
}

const googleOrg = (singles: ReadonlyMap<string, string>, g: GooglePerson | null) => {
  const [org = {}] = recs(g?.organizations)
  return [
    {
      ...org,
      ...(singles.has("org") ? { name: singles.get("org") } : {}),
      ...(singles.has("title") ? { title: singles.get("title") } : {}),
    },
  ]
}

/** A plan as a Google update: the changed fields, each sent whole. */
const googleBody = (pl: Plan, g: GooglePerson | null) => {
  const fields: string[] = []
  const body: Json = {}
  const singles = new Map(pl.writes.filter((w) => isSingle(w.key)).map((w) => [w.key, w.value]))
  if (singles.has("first") || singles.has("last")) {
    body.names = googleNames(singles, g)
    fields.push("names")
  }
  if (singles.has("org") || singles.has("title")) {
    body.organizations = googleOrg(singles, g)
    fields.push("organizations")
  }
  const nick = singles.get("nick")
  if (nick !== undefined) {
    body.nicknames = nick === "" ? [] : [{ value: nick }]
    fields.push("nicknames")
  }
  const note = singles.get("note")
  if (note !== undefined) {
    body.biographies = note === "" ? [] : [{ value: note, contentType: "TEXT_PLAIN" }]
    fields.push("biographies")
  }
  for (const kind of LISTS) {
    const l = googleList(kind, pl.writes, g)
    if (l !== null) {
      body[l.field] = l.items
      fields.push(l.field)
    }
  }
  return { body, fields }
}

export interface PushReport {
  readonly target: Target
  readonly people: number
  readonly created: number
  readonly values: number
  readonly deleted: number
  readonly conflicts: number
  readonly backup?: string
  readonly errors: readonly string[]
  /** With `dry`: each card's changes, by person. */
  readonly planned?: readonly {
    readonly person: string
    readonly name: string
    readonly record: string | null
    readonly writes: readonly Write[]
    readonly conflicts: readonly { key: string; ours: string; theirs: string }[]
  }[]
  readonly deleting?: readonly { person: string; record: string }[]
}

/** What Switch has written to one book, the conflicts it recorded, and all it ever knew of whom. */
const history = (target: Target) =>
  Effect.gen(function* reading() {
    const log = yield* Log
    const { all, pushed, conflicted, known } = yield* log.read((db) => {
      const pushedRows = db
        .query<{ person: string; remote: string; key: string; value: string }, [string]>(
          "SELECT person, remote, key, value FROM pushed WHERE target = ?",
        )
        .all(target)
      const conflictRows = db
        .query<{ person: string; key: string }, [string]>(
          "SELECT person, key FROM conflicts WHERE target = ?",
        )
        .all(target)
      const knownBy = new Map<string, Known>()
      const knowing = (id: string) => {
        const live = resolve(db, id) ?? id
        const k = knownBy.get(live) ?? emptyKnown()
        knownBy.set(live, k)
        return k
      }
      for (const r of db
        .query<{ type: string; payload: string }, []>(
          `SELECT type, payload FROM events WHERE type IN ('${PersonCreated.type}', '${PersonUpdated.type}', '${PersonMerged.type}')`,
        )
        .all()) {
        const raw: unknown = JSON.parse(r.payload)
        if (r.type === PersonCreated.type) {
          const e = PersonCreated.decode(raw)
          for (const f of e.fields) {
            learn(knowing(e.id), f)
          }
        } else if (r.type === PersonUpdated.type) {
          const e = PersonUpdated.decode(raw)
          for (const f of [...e.added, ...e.removed]) {
            learn(knowing(e.id), f)
          }
        } else {
          const e = PersonMerged.decode(raw)
          for (const f of e.fields) {
            learn(knowing(e.into), f)
          }
        }
      }
      return { all: everyone(db), pushed: pushedRows, conflicted: conflictRows, known: knownBy }
    })
    /** By person, then the record it went to: key → value. */
    const pushedBy = new Map<string, Map<string, Map<string, string>>>()
    for (const r of pushed) {
      const byRemote = pushedBy.get(r.person) ?? new Map<string, Map<string, string>>()
      const m = byRemote.get(r.remote) ?? new Map<string, string>()
      m.set(r.key, r.value)
      byRemote.set(r.remote, m)
      pushedBy.set(r.person, byRemote)
    }
    const conflictBy = new Map<string, Set<string>>()
    for (const c of conflicted) {
      const m = conflictBy.get(c.person) ?? new Set<string>()
      m.add(c.key)
      conflictBy.set(c.person, m)
    }
    return { all, pushedBy, conflictBy, known }
  })

/** Each linked card as it is now, by its id there. */
const remotesOf = (target: Target, ids: readonly string[]) =>
  Effect.gen(function* reading() {
    const remotes = new Map<string, Remote>()
    const googles = new Map<string, GooglePerson>()
    if (target === "apple") {
      for (const c of yield* appleCards(ids)) {
        remotes.set(c.id, appleRemote(c))
      }
    } else {
      const groups = yield* googleGroups
      for (const g of yield* googlePeople) {
        googles.set(g.resourceName, g)
        remotes.set(g.resourceName, googleRemote(g, groups))
      }
    }
    return { remotes, googles }
  })

const nameOrId = (pl: Plan) => nameOf(pl.person) || pl.person.id

/** A card's id there, as the person's `ref`: how the next push finds the card it made. */
const linked = (target: Target, batch: string, person: string, remote: string) =>
  PersonUpdated.make({
    id: person,
    added: [make({ kind: "ref", value: remote, service: target }, target, false)],
    removed: [],
    batch,
    reason: `linked to ${target}`,
  })

const recordedWrites = (ws: readonly Write[]) =>
  ws.map((w) => ({ key: w.key, value: w.value, ...(w.was === undefined ? {} : { was: w.was }) }))

/** What one write did: the values sent and, for a new card, the link to it. */
const recorded = (target: Target, batch: string, pl: Plan, remote: string): Draft[] => [
  ...(pl.remote === null ? [linked(target, batch, pl.person.id, remote)] : []),
  Pushed.make({
    id: pl.person.id,
    target,
    remote,
    created: pl.remote === null,
    written: recordedWrites(pl.writes),
    reverted: false,
    batch,
    reason: `pushed to ${target}`,
  }),
]

/** A card folded into another of the same person, deleted: kept whole in the event, for undo. */
const deletedRecord = (
  target: Target,
  batch: string,
  person: string,
  remote: string,
  copy: string,
) =>
  Pushed.make({
    id: person,
    target,
    remote,
    created: false,
    written: [],
    reverted: false,
    deleted: true,
    copy,
    batch,
    reason: `merged in ${target}`,
  })

/** Writes to Apple, 25 cards a script, each script's cards recorded as soon as it returns. */
const writeApple = (writing: readonly Plan[], batch: string) =>
  Effect.gen(function* sending() {
    const done: Plan[] = []
    const errors: string[] = []
    for (let i = 0; i < writing.length; i += 25) {
      const chunk = writing.slice(i, i + 25)
      // A chunk that fails is its cards' error, and the next chunk goes on.
      const exit = yield* Effect.exit(appleEdit(chunk.map((pl) => appleEditOf(pl))))
      if (exit._tag === "Failure") {
        const error = why(exit.cause)
        errors.push(...chunk.map((pl) => `${nameOrId(pl)}: ${error}`))
        continue
      }
      const results = exit.value
      const events: Draft[] = []
      for (const [j, r] of results.entries()) {
        const pl = chunk[j]
        if (pl !== undefined && r.ok && r.id !== null) {
          done.push(pl)
          events.push(...recorded("apple", batch, pl, r.id))
        } else if (pl !== undefined) {
          errors.push(`${nameOrId(pl)}: ${r.error ?? "failed"}`)
        }
      }
      yield* commit(batch, events)
    }
    return { done, errors }
  })

/** Labels a Google contact goes under or leaves, by name. */
const googleLabels = (pl: Plan, resource: string) =>
  Effect.gen(function* labelling() {
    for (const w of pl.writes.filter((x) => x.key.startsWith("group:"))) {
      const group = yield* googleGroupNamed(w.value || (w.was ?? ""))
      yield* w.value === ""
        ? googleGroupMembers(group, [], [resource])
        : googleGroupMembers(group, [resource], [])
    }
  })

/** Writes to Google a card at a time, each recorded as soon as it's written. */
const writeGoogle = (
  writing: readonly Plan[],
  googles: ReadonlyMap<string, GooglePerson>,
  batch: string,
) =>
  Effect.gen(function* sending() {
    const done: Plan[] = []
    const errors: string[] = []
    for (const pl of writing) {
      const g = pl.remote === null ? null : (googles.get(pl.remote) ?? null)
      const { body, fields } = googleBody(pl, g)
      const result = yield* Effect.result(
        Effect.gen(function* writing1() {
          let written = g
          if (written === null) {
            written = yield* googleCreate(body)
          } else if (fields.length > 0) {
            written = yield* googleUpdate(written, fields, body)
          }
          yield* googleLabels(pl, written.resourceName)
          return written
        }),
      )
      if (result._tag === "Success") {
        done.push(pl)
        yield* commit(batch, recorded("google", batch, pl, result.success.resourceName))
      } else {
        errors.push(`${nameOrId(pl)}: ${result.failure.message}`)
      }
    }
    return { done, errors }
  })

/** Deletes cards folded into another of the same person, once that one was written. */
const deleteExtras = (
  target: Target,
  extras: readonly { person: string; remote: string }[],
  googles: ReadonlyMap<string, GooglePerson>,
  batch: string,
) =>
  Effect.gen(function* deleting() {
    const errors: string[] = []
    let deleted = 0
    if (target === "apple") {
      const results =
        extras.length === 0
          ? []
          : yield* appleEdit(extras.map((x) => ({ id: x.remote, delete: true })))
      for (const [i, r] of results.entries()) {
        const x = extras[i]
        if (x !== undefined && r.ok) {
          deleted += 1
          yield* commit(batch, [deletedRecord(target, batch, x.person, x.remote, r.copy ?? "")])
        } else if (x !== undefined) {
          errors.push(`${x.remote}: ${r.error ?? "failed"}`)
        }
      }
      return { deleted, errors }
    }
    for (const x of extras) {
      const copy = JSON.stringify(googles.get(x.remote) ?? {})
      const r = yield* Effect.result(googleDelete(x.remote))
      if (r._tag === "Success") {
        deleted += 1
        yield* commit(batch, [deletedRecord(target, batch, x.person, x.remote, copy)])
      } else {
        errors.push(`${x.remote}: ${r.failure.message}`)
      }
    }
    return { deleted, errors }
  })

/** The Google cards there were before Switch first wrote, from the first backup. */
const googleBefore = () => {
  if (!existsSync(BACKUPS)) {
    return null
  }
  const [first] = readdirSync(BACKUPS)
    .filter((d) => existsSync(path.join(BACKUPS, d, "google.json")))
    .toSorted()
  if (first === undefined) {
    return null
  }
  const raw = parse(readFileSync(path.join(BACKUPS, first, "google.json"), "utf-8"))
  return new Set(recs(raw).map((g) => text(g.resourceName)))
}

/**
 * Cards in Google no one is linked to that hold a number or email of someone who'd get a new
 * card: a write that went out without being recorded. Linked instead of made again; one that
 * wasn't there before Switch first wrote counts as made by Switch, so an undo deletes it.
 */
const adopt = (
  candidates: readonly Person[],
  all: readonly Person[],
  googles: ReadonlyMap<string, GooglePerson>,
  remotes: ReadonlyMap<string, Remote>,
  batch: string,
) =>
  Effect.gen(function* adopting() {
    const taken = new Set(all.flatMap((p) => refsOf(p, "google")))
    const byKey = new Map<string, string>()
    for (const [id, r] of remotes) {
      if (taken.has(id)) {
        continue
      }
      for (const kind of ["phone", "email"] as const) {
        for (const x of r.lists[kind]) {
          const key = listKey(kind, x.value)
          if (key !== "") {
            byKey.set(key, id)
          }
        }
      }
    }
    const before = googleBefore()
    const adopted = new Map<string, string>()
    for (const p of candidates) {
      const want = wanted(p, "google")
      const keys = [
        ...want.lists.phone.map((x) => listKey("phone", x.value)),
        ...want.lists.email.map((x) => listKey("email", x.value)),
      ]
      const id = keys.map((k) => byKey.get(k)).find((x) => x !== undefined)
      if (id === undefined || [...adopted.values()].includes(id) || !googles.has(id)) {
        continue
      }
      adopted.set(p.id, id)
      yield* commit(batch, [
        linked("google", batch, p.id, id),
        Pushed.make({
          id: p.id,
          target: "google",
          remote: id,
          created: before !== null && !before.has(id),
          written: [],
          reverted: false,
          batch,
          reason: "found in google",
        }),
      ])
    }
    return adopted
  })

interface Related {
  readonly label: string
  readonly value: string
}

/** One person's line on the Me card: what to take off, what to put on, and the record of it. */
const relatedChange = (
  p: Person,
  me: string,
  there: readonly Related[],
  last: string,
  batch: string,
) => {
  const r = ranked(p, "relationship").find(usable)?.value
  const name = nameOf(p)
  const want = r === undefined || name === "" ? "" : `${r}\t${name}`
  const same = there.find(
    (x) => r !== undefined && normOf("name", x.value) === normOf("name", name) && x.label === r,
  )
  if (want === last || (last === "" && same?.value === name)) {
    return null
  }
  const [lastLabel = "", lastName = ""] = last.split("\t")
  const remove: Related[] = [
    ...(last === "" ? [] : [{ label: lastLabel, value: lastName }]),
    ...(same === undefined ? [] : [same]),
  ]
  const add: Related[] = want === "" || r === undefined ? [] : [{ label: r, value: name }]
  const event = Pushed.make({
    id: p.id,
    target: "apple",
    remote: me,
    created: false,
    written: [{ key: "related", value: want, ...(last === "" ? {} : { was: last }) }],
    reverted: false,
    batch,
    reason: "pushed to apple",
  })
  return { add, remove, event }
}

/** Who each person is to the user, on the Apple Me card's related names: what to change. */
const pushRelated = (
  all: readonly Person[],
  pushedBy: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>,
  batch: string,
  dry: boolean,
) =>
  Effect.gen(function* relating() {
    const me = yield* appleMe
    if (me === null) {
      return { values: 0, errors: [] as string[] }
    }
    const there = yield* appleRelated(me)
    const changes = all.flatMap((p) => {
      const c = relatedChange(
        p,
        me,
        there,
        pushedBy.get(p.id)?.get(me)?.get("related") ?? "",
        batch,
      )
      return c === null ? [] : [c]
    })
    if (dry || changes.length === 0) {
      return { values: changes.length, errors: [] as string[] }
    }
    const [result] = yield* appleEdit([
      {
        id: me,
        related: { add: changes.flatMap((c) => c.add), remove: changes.flatMap((c) => c.remove) },
      },
    ])
    if (result?.ok !== true) {
      return { values: 0, errors: [`me: ${result?.error ?? "failed"}`] }
    }
    yield* commit(
      batch,
      changes.map((c) => c.event),
    )
    return { values: changes.length, errors: [] as string[] }
  })

/** Sends what changed to one book. `only`: just these people. `dry`: says what it would send. */
export const push = (target: Target, batch: string, only?: ReadonlySet<string>, dry = false) =>
  books.withPermit(
    Effect.gen(function* pushing() {
      if (load().imported[target] === undefined) {
        return {
          target,
          people: 0,
          created: 0,
          values: 0,
          deleted: 0,
          conflicts: 0,
          errors: [`${target} not imported yet`],
        } satisfies PushReport
      }
      const { all, pushedBy, conflictBy, known } = yield* history(target)
      const taken = new Set(
        all
          .filter((p) => refsOf(p, target).length > 0)
          .flatMap((p) =>
            p.fields
              .filter((f) => f.kind === "phone" || f.kind === "email")
              .map((f) => listKey(f.kind === "phone" ? "phone" : "email", f.value)),
          ),
      )
      const people = all.filter(
        (p) =>
          (only === undefined || only.has(p.id)) &&
          (refsOf(p, target).length > 0 || shouldCreate(p, taken)),
      )
      const { remotes, googles } = yield* remotesOf(
        target,
        people.flatMap((p) => refsOf(p, target)),
      )
      const adopted =
        target === "google" && !dry
          ? yield* adopt(
              people.filter((p) => refsOf(p, target).length === 0),
              all,
              googles,
              remotes,
              batch,
            )
          : new Map<string, string>()
      const after = adopted.size > 0 ? yield* history(target) : null

      const extras: { person: string; remote: string }[] = []
      const plans = people.flatMap((p) => {
        const refs = refsOf(p, target)
        const live = refs.filter((id) => remotes.has(id))
        const adoptedId = adopted.get(p.id)
        if (refs.length > 0 && live.length === 0) {
          return []
        }
        const [id = adoptedId ?? null, ...rest] = live
        for (const x of rest) {
          extras.push({ person: p.id, remote: x })
        }
        const own =
          (after ?? { pushedBy }).pushedBy.get(p.id)?.get(id ?? "") ?? new Map<string, string>()
        const pl = plan(
          target,
          p,
          id,
          id === null ? null : (remotes.get(id) ?? null),
          known.get(p.id) ?? emptyKnown(),
          own,
          conflictBy.get(p.id) ?? new Set<string>(),
        )
        return pl.writes.length > 0 || pl.conflicts.length > 0 ? [pl] : []
      })
      const conflictEvents: Draft[] = plans.flatMap((pl) =>
        pl.conflicts.map((c) =>
          Conflicted.make({
            id: pl.person.id,
            target,
            remote: pl.remote ?? "",
            key: c.key,
            ours: c.ours,
            theirs: c.theirs,
          }),
        ),
      )
      const writing = plans.filter((pl) => pl.writes.length > 0)
      const relating =
        target === "apple" ? (yield* pushRelated(all, pushedBy, batch, true)).values : 0
      if (dry) {
        let planned = relating
        for (const pl of writing) {
          planned += pl.writes.length
        }
        return {
          target,
          people: writing.length,
          created: writing.filter((pl) => pl.remote === null).length,
          values: planned,
          deleted: extras.length,
          conflicts: conflictEvents.length,
          errors: [],
          planned: plans.map((pl) => ({
            person: pl.person.id,
            name: nameOf(pl.person),
            record: pl.remote,
            writes: pl.writes,
            conflicts: pl.conflicts,
          })),
          deleting: extras.map((x) => ({ person: x.person, record: x.remote })),
        } satisfies PushReport
      }
      const touches = writing.some((pl) => pl.remote !== null) || extras.length > 0 || relating > 0
      const saved = touches ? yield* backedUp(target) : undefined
      yield* commit(batch, conflictEvents)
      const { done, errors } =
        target === "apple"
          ? yield* writeApple(writing, batch)
          : yield* writeGoogle(writing, googles, batch)
      const doneIds = new Set(done.map((pl) => pl.person.id))
      const extrasNow = extras.filter(
        (x) => doneIds.has(x.person) || !writing.some((pl) => pl.person.id === x.person),
      )
      const gone = yield* deleteExtras(target, extrasNow, googles, batch)
      const related =
        relating > 0
          ? yield* pushRelated(all, pushedBy, batch, false)
          : { values: 0, errors: [] as string[] }
      let created = 0
      let { values } = related
      for (const pl of done) {
        values += pl.writes.length
        if (pl.remote === null) {
          created += 1
        }
      }
      return {
        target,
        people: writing.length,
        created,
        values,
        deleted: gone.deleted,
        conflicts: conflictEvents.length,
        ...(saved === undefined ? {} : { backup: saved }),
        errors: [...errors, ...gone.errors, ...related.errors],
      } satisfies PushReport
    }),
  )

interface Written {
  readonly id: string
  readonly target: Target
  readonly remote: string
  readonly created: boolean
  readonly written: readonly { key: string; value: string; was?: string }[]
  readonly deleted?: boolean
  readonly copy?: string
}

/** The inverse of what one push wrote: each value back to what it was. */
const inverse = (p: Written): Write[] =>
  p.written.map((w) => ({
    key: w.key,
    value: w.was ?? "",
    ...(w.value === "" ? {} : { was: w.value }),
  }))

const unpushApple = (p: Written) =>
  Effect.gen(function* undoing() {
    if (p.created) {
      yield* appleEdit([{ id: p.remote, delete: true }])
      return null
    }
    if (p.deleted === true) {
      return p.copy === undefined || p.copy === "" ? null : yield* appleRestore(p.copy)
    }
    const related = p.written.find((w) => w.key === "related")
    if (related !== undefined) {
      const [label = "", value = ""] = related.value.split("\t")
      const [wasLabel = "", wasValue = ""] = (related.was ?? "").split("\t")
      yield* appleEdit([
        {
          id: p.remote,
          related: {
            remove: related.value === "" ? [] : [{ label, value }],
            add: related.was === undefined ? [] : [{ label: wasLabel, value: wasValue }],
          },
        },
      ])
      return null
    }
    // Singles go back only where they still hold what Switch wrote; the rest as recorded.
    const back = inverse(p)
    const clear: Partial<Record<Single, string>> = {}
    for (const w of back.filter((x) => isSingle(x.key) && x.value === "")) {
      if (isSingle(w.key)) {
        clear[w.key] = w.was ?? ""
      }
    }
    const pl: Plan = {
      person: { id: p.id, created: 0, updated: 0, fields: [] },
      remote: p.remote,
      writes: back.filter((x) => !(isSingle(x.key) && x.value === "")),
      conflicts: [],
    }
    yield* appleEdit([{ ...appleEditOf(pl), clear }])
    return null
  })

const unpushGoogle = (p: Written) =>
  Effect.gen(function* undoing() {
    if (p.created) {
      yield* googleDelete(p.remote)
      return null
    }
    if (p.deleted === true) {
      const copy = rec(parse(p.copy ?? "{}"))
      const made = yield* googleRestore(copy)
      return made.resourceName
    }
    const g = yield* googleGet(p.remote)
    const pl: Plan = {
      person: { id: p.id, created: 0, updated: 0, fields: [] },
      remote: p.remote,
      writes: inverse(p),
      conflicts: [],
    }
    const { body, fields } = googleBody(pl, g)
    if (fields.length > 0) {
      yield* googleUpdate(g, fields, body)
    }
    yield* googleLabels(pl, p.remote)
    return null
  })

/** Takes back what one push wrote; a deleted card comes back, linked to its person again. */
export const unpush = (p: Written, batch: string) =>
  Effect.gen(function* undoing() {
    const back = yield* p.target === "apple" ? unpushApple(p) : unpushGoogle(p)
    yield* commit(batch, [
      ...(back === null ? [] : [linked(p.target, batch, p.id, back)]),
      Pushed.make({
        id: p.id,
        target: p.target,
        remote: p.remote,
        created: p.created,
        written: [...p.written],
        reverted: true,
        batch,
        reason: `undo push to ${p.target}`,
      }),
    ])
  })

/** For the tools: someone's records in each book. */
export const linksOf = (p: Person) => ({ apple: refsOf(p, "apple"), google: refsOf(p, "google") })
