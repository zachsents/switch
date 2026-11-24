// Taking sources in. Apple and Google once, as the first import: after that Switch is the source of
// truth and only pushes out. Other sources' records and message senders keep flowing in.
import { Log } from "switch-ext-kit"
import { Effect } from "effect"

import { appleBook } from "./apple.ts"
import type { Related } from "./apple.ts"
import { googleBook } from "./google.ts"
import { take } from "./merge.ts"
import type { Matching, SourceRecord } from "./merge.ts"
import { Imported, normOf, PersonUpdated, readPerson, resolve, SenderUnknown } from "./model.ts"
import { phoneKey } from "./text.ts"
import { offered } from "./offered.ts"
import { attempt, why } from "./heartbeat.ts"
import { keepRecord, tookRecord } from "./kept.ts"
import { batchId, commit, make } from "./store.ts"
import { gather, toRecord as senderRecord } from "./senders.ts"
import type { Seen, Sender } from "./senders.ts"

export interface Tally {
  readonly source: string
  readonly records: number
  readonly created: number
  readonly merged: number
  /** Records that turned out to be someone already there: duplicates, merged. */
  readonly matched: number
  readonly asked: number
  readonly cost: number
  readonly batch: string
}

export const takeAll = (
  source: string,
  records: readonly SourceRecord[],
  matching: Matching = "model",
) =>
  Effect.gen(function* taking() {
    const batch = batchId(`import-${source}`)
    let created = 0
    let merged = 0
    let matched = 0
    let asked = 0
    let cost = 0
    // Each record on its own: one that won't take is kept, with why, and the rest go on.
    for (const r of records) {
      const exit = yield* Effect.exit(take(r, batch, `import ${source}`, matching))
      if (exit._tag === "Failure") {
        keepRecord(source, matching, r, why(exit.cause))
        continue
      }
      tookRecord(source, r)
      const o = exit.value
      created += o.created ? 1 : 0
      merged += o.merged
      matched += o.matched ? 1 : 0
      asked += o.asked
      cost += o.cost
    }
    yield* commit(batch, [
      Imported.make({ source, records: records.length, created, merged: merged + matched, batch }),
    ])
    return {
      source,
      records: records.length,
      created,
      merged,
      matched,
      asked,
      cost,
      batch,
    } satisfies Tally
  })

/**
 * Who the Me card names as related to the user, as each one's relationship: written where the
 * name is exactly one person's, among those the import just took in.
 */
const relationships = (me: { id: string; related: readonly Related[] } | null, batch: string) =>
  Effect.gen(function* relating() {
    const log = yield* Log
    let set = 0
    for (const r of me?.related ?? []) {
      const label = r.label.trim()
      const id = yield* log.read((db) => {
        const ids = new Set(
          db
            .query<{ person: string }, [string]>(
              "SELECT person FROM fields WHERE kind = 'name' AND norm = ?",
            )
            .all(normOf("name", r.value))
            .map((x) => resolve(db, x.person))
            .filter((x) => x !== null),
        )
        return ids.size === 1 ? [...ids][0] : undefined
      })
      if (label !== "" && id !== undefined) {
        const p = yield* log.read((db) => readPerson(db, id))
        const has = p?.fields.some((f) => f.kind === "relationship")
        if (p !== null && has !== true) {
          set += 1
          yield* commit(batch, [
            PersonUpdated.make({
              id,
              added: [make({ kind: "relationship", value: label }, "apple", true)],
              removed: [],
              batch,
              reason: "import apple",
            }),
          ])
        }
      }
    }
    return set
  })

/** Every card in Apple Contacts, merged only where a card is surely someone already there. */
export const importApple = Effect.gen(function* importing() {
  const book = yield* appleBook
  const tally = yield* takeAll("apple", book.records, "exact")
  const related = yield* relationships(book.me, tally.batch)
  return { ...tally, related }
})

/** Every saved Google contact, the same way. */
export const importGoogle = googleBook.pipe(Effect.flatMap((rs) => takeAll("google", rs, "exact")))

/** What other extensions publish, one tally per source. */
export const importOffered = (matching: Matching = "model") =>
  offered.pipe(
    Effect.flatMap((by) =>
      Effect.forEach([...by], ([source, rs]) => takeAll(source, rs, matching)),
    ),
  )

/** Phones that text the user one to one, with no name in Apple or Google. */
export const unknownSender = (s: Sender) =>
  s.kind === "phone" && s.fromThem > 0 && s.marketing < s.fromThem

/**
 * The senders of one message (`id`, the brain event's), folded in, and each phone no address book
 * names recorded as an unknown sender, once. Every change is named after `id` and the sender, so the
 * same message taken in again changes nothing. A record that won't take is kept, with why.
 */
export const takeSenders = (seen: Seen, id: string) =>
  Effect.gen(function* sensing() {
    const log = yield* Log
    const senders = gather([seen])
    const taking = batchId("import-senders")
    for (const [i, r] of senders.map(senderRecord).entries()) {
      const exit = yield* Effect.exit(take(r, taking, "import senders", "model", `${id}:${i}`))
      if (exit._tag === "Failure") {
        keepRecord("senders", "model", r, why(exit.cause))
      } else {
        tookRecord("senders", r)
      }
    }
    const batch = batchId("unknown")
    for (const [i, s] of senders.filter(unknownSender).entries()) {
      const error = yield* attempt(
        Effect.gen(function* unknownOne() {
          // Whoever already holds the number is who it is; a new person only for a number no one has.
          const holder = yield* log.read(
            (db) =>
              db
                .query<{ person: string }, [string]>(
                  "SELECT f.person FROM fields f JOIN people p ON p.id = f.person WHERE f.kind = 'phone' AND f.norm = ? AND p.merged_into IS NULL AND p.retired = 0 ORDER BY p.created LIMIT 1",
                )
                .get(phoneKey(s.handle))?.person ?? null,
          )
          const o =
            holder === null
              ? yield* take(
                  { ...senderRecord(s), create: true },
                  batch,
                  "senders",
                  "keys",
                  `${id}:unknown:${i}`,
                )
              : { person: holder }
          if (o.person === null) {
            return
          }
          const { person } = o
          const named = yield* log.read((db) => {
            const p = readPerson(db, person)
            const fromBook = p?.fields.some(
              (f) =>
                f.kind === "name" &&
                f.suggested !== true &&
                (f.user || ["apple", "google", "imessage", "fastpeoplesearch"].includes(f.source)),
            )
            const flagged =
              db
                .query<{ n: number }, [string]>(
                  "SELECT count(*) AS n FROM events WHERE type = 'contacts.sender_unknown' AND json_extract(payload, '$.id') = ?",
                )
                .get(person)?.n ?? 0
            return { fromBook: fromBook === true, flagged: flagged > 0 }
          })
          if (!named.fromBook && !named.flagged) {
            yield* commit(
              batch,
              [
                SenderUnknown.make({
                  id: person,
                  handle: s.handle,
                  channel: s.channel,
                  batch,
                  reason: "unknown sender",
                }),
              ],
              false,
              `${id}:flag:${i}`,
            )
          }
        }),
      )
      if (error !== null) {
        keepRecord("senders", "keys", { ...senderRecord(s), create: true }, error)
      }
    }
  })
