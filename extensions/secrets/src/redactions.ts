// The vault's secrets as fingerprints for Switch's redaction (the core's `redactions/set`, its
// brain's redact.ts): every event, log line, tool result and send is matched against them there,
// and a match shows the secret's name ("[Chase password]", "[card ••5269]"), while the values never
// leave this process. Sent at start and after each change, in place of the last.
import { createHash, randomBytes, randomInt } from "node:crypto"

import { Effect, Queue, Schema } from "effect"
import { Host } from "switch-ext-kit"

import type { Field, Item } from "./model.ts"
import { CONCEALED } from "./model.ts"
import * as ops from "./ops.ts"
import { parseTotp } from "./otp.ts"
import { historyItems } from "./store.ts"
import type { Vault } from "./store.ts"

// The core's fingerprints, as its redact.ts reads them: a form's `p` is Σ cᵢ·base^(WINDOW−1−i) mod
// MOD over the code points at its first WINDOW UTF-16 indexes, mod BUCKETS; `n` its length in UTF-16
// units; `h` the first 32 hex digits of SHA-256(salt ‖ its UTF-8). A number's digits alone go in
// `digits`.
const WINDOW = 6
const MOD = 2_147_483_647
const BUCKETS = 2 ** 20
/** Digits alone shorter than this are any number's (a PIN, a security code): known only by label. */
const DIGITS_ALONE = 9
/** Notes shorter than this are ordinary words. */
const NOTES_MIN = 12

const prefixOf = (form: string, base: number) => {
  let h = 0
  for (let i = 0; i < WINDOW; i += 1) {
    h = (h * base + (form.codePointAt(i) ?? 0)) % MOD
  }
  return h % BUCKETS
}

const hashOf = (salt: Buffer, text: string) =>
  createHash("sha256").update(salt).update(text, "utf-8").digest("hex").slice(0, 32)

/** The forms a value takes in text: as it is, base64, URL-encoded, JSON-escaped. */
const formsOf = (value: string) => [
  ...new Set([
    value,
    Buffer.from(value).toString("base64"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]),
]

const DIGIT_TYPES = new Set(["card-number", "ssn", "pin", "cvc"])

interface Secret {
  readonly value: string
  readonly label: string
  /** Kept as digits alone (a card number, an SSN): known written in groups too. */
  readonly digits: boolean
}

/** An authenticator field's key; one that won't read as a link is its value as it is. */
const keyOf = (value: string) => {
  try {
    return parseTotp(value).secret
  } catch {
    return value
  }
}

/** What a field's value is called where it's redacted: a card by its last four, else its item's. */
const labelOf = (item: Item, f: Field) =>
  f.type === "card-number"
    ? `card ••${f.value.slice(-4)}`
    : `${item.title} ${f.label.toLowerCase()}`.trim()

/** The values of an item, as it is or was, that count as secrets. */
const secretsOf = (item: Item): Secret[] => [
  ...item.fields
    .filter((f) => CONCEALED.has(f.type) && f.value !== "")
    .flatMap((f): Secret[] => {
      const label = labelOf(item, f)
      if (f.type === "totp") {
        // A key shows as base32, either case, often in fours.
        const key = keyOf(f.value)
        const grouped = key.match(/.{1,4}/gu)?.join(" ") ?? key
        return [...new Set([key, key.toLowerCase(), grouped, grouped.toLowerCase()])].map(
          (value) => ({ value, label, digits: false }),
        )
      }
      return [{ value: f.value, label, digits: DIGIT_TYPES.has(f.type) }]
    }),
  ...(item.notes.length >= NOTES_MIN
    ? [{ value: item.notes, label: `${item.title} notes`, digits: false }]
    : []),
]

/** Every secret the vault holds, its items' earlier versions' and the trash's too, as fingerprints. */
const fingerprints = async (v: Vault) => {
  const salt = randomBytes(16)
  const base = 65_536 + randomInt(2 ** 22 - 65_536)
  const items = await Promise.all(
    [...v.items.values()].map(async (i) => {
      const earlier = await historyItems(v, i.id)
      return [i, ...earlier.map((h) => h.item)]
    }),
  )
  const secrets = items.flat().flatMap(secretsOf)
  const entries = new Map<string, { p: number; n: number; h: string; label: string }>()
  const digits = new Map<string, { n: number; h: string; label: string }>()
  for (const s of secrets) {
    if (s.digits) {
      const h = hashOf(salt, s.value)
      digits.set(h, { n: s.value.length, h, label: s.label })
    }
    if (s.value.length >= (s.digits ? DIGITS_ALONE : WINDOW)) {
      for (const form of formsOf(s.value)) {
        const h = hashOf(salt, form)
        entries.set(h, { p: prefixOf(form, base), n: form.length, h, label: s.label })
      }
    }
  }
  return {
    salt: salt.toString("base64"),
    base,
    entries: [...entries.values()],
    digits: [...digits.values()],
  }
}

const give = (v: Vault) =>
  Effect.gen(function* giving() {
    const host = yield* Host
    const set = yield* Effect.promise(async () => await fingerprints(v))
    yield* host.request("redactions/set", set, Schema.Unknown)
  }).pipe(Effect.ignore({ log: "Warn", message: "The core didn't take the vault's fingerprints" }))

/** Gives the core the vault's fingerprints now and after each change, a burst as one. */
export const redactions = (v: Vault) =>
  Effect.gen(function* redacting() {
    const changes = yield* Queue.unbounded<number>()
    ops.onChange((seq) => {
      Queue.offerUnsafe(changes, seq)
    })
    yield* give(v)
    for (;;) {
      yield* Queue.take(changes)
      yield* Effect.sleep("200 millis")
      yield* Queue.clear(changes)
      yield* give(v)
    }
  })
