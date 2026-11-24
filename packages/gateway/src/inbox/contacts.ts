// A sender linked to Contacts, read from Contacts' own tables (people, fields) by phone, email or
// handle, as its `normOf` keys them: in the brain, or in Contacts' own log (contacts.db, in its
// extension's folder, as Contacts keeps it). Contacts owns people; this only looks them up.
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { Sender } from "switch-ext-kit"

const phoneKey = (raw: string) => {
  const d = raw.replaceAll(/\D/gu, "")
  if (d.length === 11 && d.startsWith("1")) {
    return d.slice(1)
  }
  return d.length < 10 ? "" : d
}

const hasContacts = (db: Database) =>
  db
    .query<{ n: number }, []>(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('people', 'fields')",
    )
    .get()?.n === 2

const SWITCH = process.env.SWITCH_DIR ?? path.join(homedir(), ".switch")
/** Its log: where $SWITCH_CONTACTS_DIR says, else its extension's folder, else where it once was. */
const logAt = () =>
  [process.env.SWITCH_CONTACTS_DIR, path.join(SWITCH, "extensions", "contacts"), SWITCH]
    .filter((dir) => dir !== undefined)
    .map((dir) => path.join(dir, "contacts.db"))
    .find((file) => existsSync(file))
let own: Database | null = null

/** Where people are: the brain, when Contacts writes there, else its own log; null if neither. */
const peopleIn = (brain: Database): Database | null => {
  if (hasContacts(brain)) {
    return brain
  }
  const file = own === null ? logAt() : undefined
  if (file !== undefined) {
    own = new Database(file, { readonly: true })
  }
  return own !== null && hasContacts(own) ? own : null
}

const keyOf = (s: Pick<Sender, "handle" | "via">): readonly [string, string] | null => {
  if (s.via === "phone") {
    const k = phoneKey(s.handle)
    return k === "" ? null : ["phone", k]
  }
  if (s.via === "email") {
    return ["email", s.handle.trim().toLowerCase()]
  }
  return ["handle", `${s.via}:${s.handle.replace(/^@/u, "").toLowerCase()}`]
}

/** A sender's handle as one key, `phone:5550100000`, `email:a@b.co` or `handle:instagram:a`. */
export const keyString = (s: Pick<Sender, "handle" | "via">) => {
  const k = keyOf(s)
  return k === null ? null : `${k[0]}:${k[1]}`
}

/** The live person a Contacts id points to, following merges. */
const live = (db: Database, id: string) => {
  const q = db.query<{ merged_into: string | null; retired: number }, [string]>(
    "SELECT merged_into, retired FROM people WHERE id = ?",
  )
  let at: string | null = id
  for (let hops = 0; hops < 20 && at !== null; hops += 1) {
    const row = q.get(at)
    if (row === null) {
      return null
    }
    if (row.merged_into === null) {
      return row.retired === 1 ? null : at
    }
    at = row.merged_into
  }
  return null
}

/** Contacts' tables are its own: a shape this doesn't know finds no one rather than failing. */
const softly = <A>(read: () => A | null): A | null => {
  try {
    return read()
  } catch {
    return null
  }
}

/** The Contacts id of whoever `s` is, if Contacts knows them. */
export const personOf = (brain: Database, s: Sender): string | null =>
  softly(() => personIn(brain, s))

const personIn = (brain: Database, s: Sender): string | null => {
  const db = peopleIn(brain)
  if (s.me === true || db === null) {
    return null
  }
  const key = keyOf(s)
  if (key === null) {
    return null
  }
  const row = db
    .query<{ person: string }, [string, string]>(
      "SELECT person FROM fields WHERE kind = ? AND norm = ? AND suggested = 0 ORDER BY confidence DESC LIMIT 1",
    )
    .get(key[0], key[1])
  return row === null ? null : live(db, row.person)
}

/** A person's name as Contacts has it. */
export const nameOf = (brain: Database, person: string): string | null =>
  softly(() => nameIn(brain, person))

const nameIn = (brain: Database, person: string): string | null => {
  const db = peopleIn(brain)
  if (db === null) {
    return null
  }
  const id = live(db, person)
  if (id === null) {
    return null
  }
  return (
    db
      .query<{ value: string }, [string]>(
        "SELECT value FROM fields WHERE person = ? AND kind = 'name' AND suggested = 0 ORDER BY confidence DESC LIMIT 1",
      )
      .get(id)?.value ?? null
  )
}

/** The live Contacts id `id` is now, following merges. */
export const livePerson = (brain: Database, id: string): string | null =>
  softly(() => {
    const db = peopleIn(brain)
    return db === null ? null : live(db, id)
  })

/** Someone, with every handle Contacts has for them. */
export interface Person {
  /** Their Contacts id; empty for a handle Contacts doesn't know. */
  readonly id: string
  readonly name: string
  /** Their phones, emails and service handles, as Contacts has them. */
  readonly handles: readonly string[]
  /** The same as `keyString`, what a message of theirs carries. */
  readonly keys: readonly string[]
}

interface FieldRow {
  readonly kind: string
  readonly value: string
  readonly norm: string
  readonly service: string | null
}

const NAMEISH = "('name', 'given', 'family', 'nickname')"

const personAt = (db: Database, id: string): Person => {
  const fields = db
    .query<FieldRow, [string]>(
      `SELECT kind, value, norm, service FROM fields
       WHERE person = ? AND suggested = 0 AND kind IN ('phone', 'email', 'handle') ORDER BY confidence DESC`,
    )
    .all(id)
  const keys = new Set<string>()
  const handles = new Set<string>()
  for (const f of fields) {
    // Messages' own handle for someone is their phone or email: the same key.
    const bare = f.norm.slice(f.norm.indexOf(":") + 1)
    if (f.kind === "handle" && f.service === "imessage") {
      keys.add(bare.includes("@") ? `email:${bare}` : `phone:${phoneKey(bare)}`)
      continue
    }
    keys.add(`${f.kind}:${f.norm}`)
    handles.add(f.kind === "handle" ? `${f.service ?? ""} ${f.value}`.trim() : f.value)
  }
  return { id, name: nameIn(db, id) ?? "", handles: [...handles], keys: [...keys] }
}

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}'-]+/u)
    .filter((w) => w !== "")

/** Everyone whose names hold every word, each word starting one of theirs. */
const named = (db: Database, query: string) => {
  const want = words(query)
  const [first] = want
  if (first === undefined) {
    return []
  }
  const ids = db
    .query<{ person: string }, [string]>(
      `SELECT DISTINCT person FROM fields WHERE suggested = 0 AND kind IN ${NAMEISH} AND (' ' || norm) LIKE ?`,
    )
    .all(`% ${first}%`)
    .map((r) => live(db, r.person))
    .filter((id) => id !== null)
  const names = db.query<{ norm: string }, [string]>(
    `SELECT norm FROM fields WHERE person = ? AND suggested = 0 AND kind IN ${NAMEISH}`,
  )
  const whole = want.join(" ")
  const fits = [...new Set(ids)].flatMap((id) => {
    const norms = names.all(id).map((r) => r.norm)
    const theirs = norms.flatMap(words)
    return want.every((w) => theirs.some((t) => t.startsWith(w)))
      ? [{ id, exact: norms.includes(whole) }]
      : []
  })
  // One whose name is exactly that is who's meant.
  const exact = fits.filter((f) => f.exact)
  return (exact.length === 1 ? exact : fits).map((f) => f.id)
}

/** Everyone Contacts has with this phone, email, @handle or id, else whose names fit. */
const matching = (db: Database, who: string): string[] => {
  const q = who.trim()
  const by = (sql: string, ...args: string[]) =>
    db
      .query<{ person: string }, string[]>(
        `SELECT DISTINCT person FROM fields WHERE suggested = 0 AND (${sql})`,
      )
      .all(...args)
      .map((r) => live(db, r.person))
      .filter((id) => id !== null)
  if (q === "") {
    return []
  }
  if (live(db, q) !== null) {
    return [q]
  }
  if (q.startsWith("@")) {
    return by("kind = 'handle' AND norm LIKE ?", `%:${q.slice(1).toLowerCase()}`)
  }
  if (q.includes("@")) {
    const email = q.toLowerCase()
    return by(
      "(kind = 'email' AND norm = ?) OR (kind = 'handle' AND norm = ?)",
      email,
      `imessage:${email}`,
    )
  }
  const phone = /^[+\d\s().-]+$/u.test(q) ? phoneKey(q) : ""
  if (phone !== "") {
    return by(
      "(kind = 'phone' AND norm = ?) OR (kind = 'handle' AND norm = ?)",
      phone,
      `imessage:${phone}`,
    )
  }
  return named(db, q)
}

/** Who `who` is (a name, phone, email, @handle or Contacts id): one person, or every candidate. */
export const peopleFor = (brain: Database, who: string): readonly Person[] =>
  softly(() => {
    const db = peopleIn(brain)
    if (db === null) {
      return null
    }
    return [...new Set(matching(db, who))].slice(0, 8).map((id) => personAt(db, id))
  }) ?? []

/** Someone Contacts doesn't know, by the phone or email they write from. */
export const stranger = (handle: string): Person | null => {
  const h = handle.trim()
  const key = keyString({ handle: h, via: h.includes("@") ? "email" : "phone" })
  return key === null || !/^(?:[+\d\s().-]+|[^@\s]+@[^@\s]+)$/u.test(h)
    ? null
    : { id: "", name: h, handles: [h], keys: [key] }
}

/** A sender with its Contacts link, when there is one. */
export const linked = (db: Database, s: Sender): Sender => {
  const person = personOf(db, s)
  return person === null ? s : { ...s, person }
}
