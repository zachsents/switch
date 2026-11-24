// The contacts log: the brain's write path on its own file, with the contacts projection.
import { existsSync, realpathSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { Log } from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"
import { Effect, Semaphore } from "effect"

import { Change, logEvents, keyOf, people, PersonUpdated, readPerson, resolve } from "./model.ts"
import type { Field, Kind, Person } from "./model.ts"
import { afterEvents, normalEvents, normalField, partsChange, tagsOf } from "./normal.ts"

/** Its own folder, where its host runs it, so its state moves with it. */
export const DIR = process.env.SWITCH_CONTACTS_DIR ?? process.cwd()
export const DB = path.join(DIR, "contacts.db")

/** Where its state used to live: Switch's folder. */
const LEGACY = process.env.SWITCH_DIR ?? path.join(homedir(), ".switch")
const LEGACY_FILES = [
  "contacts.db-wal",
  "contacts.db-shm",
  "contacts-state.json",
  "contacts-backup",
]

/**
 * Moves the state it kept in Switch's folder into its own, once: when its own holds no log yet and
 * the old one is there. Only into a folder inside Switch's, so a run from a checkout leaves it be.
 * Before the log opens; the previous run has always stopped.
 */
export const moveLegacy = () => {
  if (!existsSync(LEGACY) || !existsSync(DIR)) {
    return
  }
  const inside = path.relative(realpathSync(LEGACY), realpathSync(DIR))
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return
  }
  const old = path.join(LEGACY, "contacts.db")
  if (existsSync(DB) || !existsSync(old)) {
    return
  }
  // The log last, so a crash midway leaves it where the next start looks for it.
  for (const name of LEGACY_FILES) {
    const from = path.join(LEGACY, name)
    const to = path.join(DIR, name)
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to)
    }
  }
  renameSync(old, DB)
}

export const logLayer = (file = DB) =>
  Log.layer({ path: file, events: logEvents, projections: [people], commands: [Change] })

/**
 * One at a time: a push, a merge, a link. A merge landing mid-push could otherwise leave a card the
 * push just made linked to the person merged away, and the next push would make it again.
 */
export const books = Semaphore.makeUnsafe(1)

export const batchId = (what: string) =>
  `${what}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`

/** A field as a source states it; the rest is filled in. */
export interface Stated {
  readonly kind: Kind
  readonly value: string
  readonly label?: string
  readonly service?: string
  readonly url?: string
  readonly confidence?: number
  readonly suggested?: boolean
}

/** A field as a source states it, not yet made normal. */
const raw = (s: Stated, source: string, user: boolean, at: number): Field => ({
  id: crypto.randomUUID(),
  kind: s.kind,
  value: s.value.trim(),
  ...(s.label === undefined || s.label === "" ? {} : { label: s.label }),
  ...(s.service === undefined ? {} : { service: s.service }),
  source,
  ...(s.url === undefined ? {} : { url: s.url }),
  confidence: s.confidence ?? 1,
  user,
  ...(s.suggested === true ? { suggested: true } : {}),
  at,
})

/** A field from what a source states, made normal. */
export const make = (s: Stated, source: string, user: boolean, at = Date.now()): Field =>
  normalField(raw(s, source, user, at))

/** Fields from what a source states, made normal, with a tag on a name ("Ann Lee · Acme") as a label. */
export const makeAll = (
  stated: readonly Stated[],
  source: string,
  user: boolean,
  at = Date.now(),
): Field[] => {
  const fields = stated.map((s) => raw(s, source, user, at))
  return [...fields.map((f) => normalField(f)), ...tagsOf(fields, [])]
}

/** Given and family worked out again for everyone the events touch whose name they change. */
const derived = (batch: string, events: readonly Draft[]) =>
  Effect.gen(function* deriving() {
    const log = yield* Log
    return yield* log.read((db) => {
      const after = afterEvents(events, (id) => {
        const live = resolve(db, id)
        return live === id ? (readPerson(db, id)?.fields ?? null) : null
      })
      const out: Draft[] = []
      for (const [id, fields] of after) {
        const { added, removed } = partsChange(fields, id)
        if (added.length > 0 || removed.length > 0) {
          out.push(PersonUpdated.make({ id, added, removed, batch, reason: "name parts" }))
        }
      }
      return out
    })
  })

/**
 * Writes one change: its events made normal, name parts kept up, checked, in one transaction. `change`
 * names it: written again with the same one, it's a no-op.
 */
export const commit = (batch: string, given: readonly Draft[], byUser = false, change?: string) =>
  Effect.gen(function* committing() {
    if (given.length === 0) {
      return 0
    }
    const log = yield* Log
    const normal = yield* log.read((db) =>
      normalEvents(given, (id) => readPerson(db, id)?.fields ?? []),
    )
    const events = [...normal, ...(yield* derived(batch, normal))]
    const receipt = yield* log.dispatch({
      id: change ?? crypto.randomUUID(),
      type: Change.type,
      source: byUser ? "user" : "contacts",
      payload: { batch, byUser, events },
    })
    return receipt.seq
  })

export const getPerson = (id: string) =>
  Effect.gen(function* getting() {
    const log = yield* Log
    return yield* log.read((db) => readPerson(db, id))
  })

/** The fields of `incoming` the person doesn't hold yet, by kind and normal form. */
export const missing = (p: Person | null, incoming: readonly Field[]) => {
  const have = new Set((p?.fields ?? []).map((f) => keyOf(f)))
  const out: Field[] = []
  for (const f of incoming) {
    const k = keyOf(f)
    if (f.kind !== "last_contact" && !have.has(k) && f.value.trim() !== "") {
      have.add(k)
      out.push(f)
    }
  }
  return out
}
