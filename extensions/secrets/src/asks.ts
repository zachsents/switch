// Asking the user. A sealed ask takes a secret straight from their device into the vault: the
// extension makes a one-time key, the user's client seals what they type to it, and the core hands
// the sealed bytes only to `answer` (switch-ext-kit's sealed asks). While no device is enrolled, a
// new device or extension is approved the same way, by an approval in the queue showing its code.
import { Effect, Schema } from "effect"
import { Asks } from "switch-ext-kit"

import { newKeyPair, openFrom } from "./crypto.ts"
import { ItemId, KINDS, mainField, TEMPLATES } from "./model.ts"
import type { Item } from "./model.ts"
import { save } from "./ops.ts"
import * as store from "./store.ts"
import type { Vault } from "./store.ts"
import { find } from "./use.ts"
import { normalize } from "./values.ts"

const TRIES = 3

const Waiting = Schema.Struct({
  kind: Schema.Literal("secret"),
  secretKey: Schema.String,
  use: Schema.String,
  item: Schema.String,
  field: Schema.String,
  tries: Schema.Finite,
  title: Schema.String,
  body: Schema.String,
  space: Schema.String,
})
const Approval = Schema.Struct({
  kind: Schema.Literal("approval"),
  device: Schema.optionalKey(Schema.String),
  extension: Schema.optionalKey(Schema.String),
  /** `extension` before extensions were renamed: read, never written. */
  spur: Schema.optionalKey(Schema.String),
})
const decodeWaiting = Schema.decodeUnknownOption(Schema.Union([Waiting, Approval]))

export const AskInput = Schema.Struct({
  title: Schema.String,
  why: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(KINDS)),
  item: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  field: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  urls: Schema.optionalKey(Schema.Array(Schema.String)),
  space: Schema.optionalKey(Schema.String),
})

const open = (title: string, body: string, space: string, key: string, use: string, id?: string) =>
  Effect.gen(function* opening() {
    const asks = yield* Asks
    return yield* asks.open(
      {
        title,
        body,
        kind: "sealed",
        ...(space !== "" && { space }),
        answerTo: "answer",
        sealed: { key, use },
      },
      id,
    )
  })

/** Raises a sealed ask for one field of an item, made first if it's new. */
export const ask = (v: Vault, input: typeof AskInput.Type) =>
  Effect.gen(function* asking() {
    const item: Item =
      input.item === undefined
        ? yield* Effect.promise(async () => {
            const made = await save(
              v,
              {
                kind: input.kind ?? "password",
                title: input.title,
                ...(input.name !== undefined && { name: input.name }),
                ...(input.username !== undefined && { username: input.username }),
                ...(input.urls !== undefined && { urls: input.urls }),
                ...(input.space !== undefined && { spaces: [input.space] }),
              },
              "ask",
            )
            return find(v, made.saved.id)
          })
        : find(v, input.item)
    const fieldId = input.field ?? mainField(item)?.id ?? TEMPLATES[item.kind][0]?.[0] ?? "password"
    const field = item.fields.find((f) => f.id === fieldId)
    if (!field) {
      return yield* Effect.fail(new Error(`${item.name} has no field ${fieldId}`))
    }
    const pair = yield* Effect.promise(newKeyPair)
    const use = `${item.name}.${field.id}`
    const { title } = input
    const space = input.space ?? ""
    const opened = yield* open(title, input.why, space, pair.key, use)
    yield* Effect.promise(async () => {
      await store.keepAsk(v, opened.id, {
        kind: "secret",
        secretKey: pair.secretKey,
        use,
        item: item.id,
        field: field.id,
        tries: 0,
        title,
        body: input.why,
        space,
      })
    })
    store.record(v, {
      item: item.id,
      name: item.name,
      field: field.id,
      use: "ask",
      who: "agent",
      space,
      why: input.why,
      target: opened.id,
      ok: true,
      reason: "",
    })
    return { asked: opened.id, item: item.name, field: field.id, reference: use }
  })

export const AnswerInput = Schema.Struct({
  item: Schema.String,
  status: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  enc: Schema.optionalKey(Schema.String),
  ct: Schema.optionalKey(Schema.String),
  answer: Schema.optionalKey(Schema.Unknown),
})

const approvedOf = Schema.decodeUnknownOption(Schema.Struct({ approved: Schema.Boolean }))

/** What the core hands back for an ask this extension raised: a sealed answer, or an approval's. */
export const answer = (
  v: Vault,
  input: typeof AnswerInput.Type,
  done: (device: string | undefined, extension: string | undefined) => Promise<void>,
) =>
  Effect.gen(function* answering() {
    const raw = yield* Effect.promise(async () => await store.askOf(v, input.item))
    const waiting = decodeWaiting(raw)
    if (waiting._tag === "None") {
      return { ok: false }
    }
    const w = waiting.value
    if (w.kind === "approval") {
      store.dropAsk(v, input.item)
      const yes = approvedOf(input.answer)
      if (
        yes._tag === "Some" &&
        yes.value.approved &&
        store.devices(v).every((d) => d.status !== "active")
      ) {
        yield* Effect.promise(async () => {
          await done(w.device, w.extension ?? w.spur)
        })
        return { ok: true }
      }
      return { ok: false }
    }
    if (input.enc === undefined || input.ct === undefined) {
      store.dropAsk(v, input.item)
      return { ok: false }
    }
    const sealed = { enc: input.enc, ct: input.ct }
    const item = v.items.get(ItemId.make(w.item))
    const field = item?.fields.find((f) => f.id === w.field)
    if (!item || !field) {
      store.dropAsk(v, input.item)
      return { ok: false }
    }
    const value = yield* Effect.promise(
      async () => await openFrom(w.secretKey, input.item, w.use, sealed),
    )
    const checked = (() => {
      try {
        return normalize(field.type, value)
      } catch {
        return null
      }
    })()
    if (checked === null) {
      store.dropAsk(v, input.item)
      if (w.tries + 1 >= TRIES) {
        return { ok: false }
      }
      const pair = yield* Effect.promise(newKeyPair)
      const again = yield* open(w.title, w.body, w.space, pair.key, w.use)
      yield* Effect.promise(async () => {
        await store.keepAsk(v, again.id, { ...w, secretKey: pair.secretKey, tries: w.tries + 1 })
      })
      return { ok: false, again: again.id }
    }
    const next: Item = {
      ...item,
      fields: item.fields.map((f) => (f.id === field.id ? { ...f, value: checked } : f)),
      updated: Date.now(),
    }
    yield* Effect.promise(async () => {
      await store.writeItem(v, next)
    })
    store.dropAsk(v, input.item)
    store.record(v, {
      item: item.id,
      name: item.name,
      field: field.id,
      use: "save",
      who: "ask",
      space: w.space,
      why: w.body,
      target: input.item,
      ok: true,
      reason: "",
    })
    return { ok: true }
  })

/**
 * While no device is enrolled: an approval in the queue for a new device or extension (`title`
 * names what's asked), with its code. One asked again revises its open approval instead of adding one.
 */
export const approval = (
  v: Vault,
  what: { device?: string; extension?: string },
  title: string,
  code: string,
) =>
  Effect.gen(function* approving() {
    if (store.devices(v).some((d) => d.status === "active")) {
      return
    }
    const waiting = yield* Effect.promise(async () => {
      let found: string | undefined
      for (const id of store.askIds(v)) {
        const kept = await store.askOf(v, id)
        if (
          Schema.is(Approval)(kept) &&
          kept.device === what.device &&
          kept.extension === what.extension
        ) {
          found = id
        }
      }
      return found
    })
    const asks = yield* Asks
    const opened = yield* asks.open(
      {
        title,
        body: `Code: ${code}`,
        kind: "approval",
        answerTo: "answer",
        notify: true,
      },
      waiting,
    )
    yield* Effect.promise(async () => {
      await store.keepAsk(v, opened.id, { kind: "approval", ...what })
    })
  }).pipe(Effect.ignore)
