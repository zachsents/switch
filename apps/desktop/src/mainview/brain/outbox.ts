// What the user did or typed that must reach the core even if the app goes first (an update
// relaunching it, a crash, its window closed), kept on this Mac per core: each command until the
// core answers it, sent again by another window or the next start, and each box's draft as it's
// typed. One held for Undo is kept with when it's due. Each keeps its id, so one sent twice is a
// no-op in the brain; one the core said no to stays, to show "Not sent" and give its words back.
// A file's bytes wait in outbox-files.ts until they're up. The iPhone's Outbox.swift keeps the same
// document.
import { Option, Schema } from "effect"

import { coreKey } from "./auth.ts"
import { dropFile } from "./outbox-files.ts"

export const KEY = "switch.outbox"

/** A test copy run beside the live app (`?quiet=1`): it keeps what it does, and sends none of it. */
export const QUIET = new URLSearchParams(location.search).get("quiet") === "1"

/** A file on a message or a draft: its bytes kept here under `id` until `blob` says it's up. */
const KeptFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
  size: Schema.Number,
  blob: Schema.optionalKey(Schema.String),
})
export type KeptFile = typeof KeptFile.Type

const Entry = Schema.Struct({
  id: Schema.String,
  /** A command, an event, or a widget's tool (`call`, the iPhone's). */
  kind: Schema.Literals(["command", "emit", "call"]),
  name: Schema.String,
  payload: Schema.Unknown,
  /** Held until then (ms): not sent before. */
  due: Schema.optionalKey(Schema.Number),
  /** Still to upload before it goes, as its payload's attachments. */
  files: Schema.optionalKey(Schema.Array(KeptFile)),
  /** What the core said when it said no: never sent again. */
  rejected: Schema.optionalKey(Schema.String),
  /** When it was given (ms). */
  time: Schema.optionalKey(Schema.Number),
  /** What this client shows of it while it waits. */
  view: Schema.optionalKey(Schema.Unknown),
})
export type Entry = typeof Entry.Type

const Draft = Schema.Struct({
  text: Schema.String,
  dictated: Schema.optionalKey(Schema.Unknown),
  files: Schema.optionalKey(Schema.Array(KeptFile)),
  replyTo: Schema.optionalKey(Schema.Unknown),
})
export type Draft = typeof Draft.Type

const Core = Schema.Struct({
  entries: Schema.Array(Entry),
  drafts: Schema.Record(Schema.String, Draft),
})
type Core = typeof Core.Type

const Doc = Schema.Struct({ v: Schema.Literal(2), cores: Schema.Record(Schema.String, Core) })
type Doc = typeof Doc.Type

/** What builds before cores were told apart kept: commands alone, for whichever core. */
const Legacy = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    command: Schema.String,
    payload: Schema.Unknown,
    due: Schema.optionalKey(Schema.Number),
  }),
)

const decodeDoc = Schema.decodeUnknownOption(Schema.fromJsonString(Doc))
const decodeLegacy = Schema.decodeUnknownOption(Schema.fromJsonString(Legacy))

const EMPTY: Core = { entries: [], drafts: {} }

const listeners = new Set<(other: boolean) => void>()
const told = (other: boolean) => {
  for (const l of listeners) {
    l(other)
  }
}

const write = (doc: Doc) => {
  localStorage.setItem(KEY, JSON.stringify(doc))
  told(false)
}

/** What's kept before a core is known (and an older build's list) goes under "", then to the
 * first core this window reaches. */
const UNKNOWN = ""

const coreNow = () => coreKey() ?? UNKNOWN

const parse = (): Doc => {
  const raw = localStorage.getItem(KEY) ?? ""
  const doc = decodeDoc(raw)
  if (Option.isSome(doc)) {
    return doc.value
  }
  const legacy = Option.getOrNull(decodeLegacy(raw)) ?? []
  const entries = legacy.map((k) => ({
    id: k.id,
    kind: "command" as const,
    name: k.command,
    payload: k.payload,
    ...(k.due !== undefined && { due: k.due }),
  }))
  return { v: 2, cores: entries.length > 0 ? { [UNKNOWN]: { entries, drafts: {} } } : {} }
}

/** The whole document, what waited for a core moved under the one reached now. */
const read = (): Doc => {
  const doc = parse()
  const core = coreNow()
  const waited = doc.cores[UNKNOWN]
  if (core === UNKNOWN || waited === undefined) {
    return doc
  }
  const { [UNKNOWN]: _, [core]: had = EMPTY, ...rest } = doc.cores
  const moved: Doc = {
    v: 2,
    cores: {
      ...rest,
      [core]: {
        entries: [...had.entries, ...waited.entries],
        drafts: { ...waited.drafts, ...had.drafts },
      },
    },
  }
  localStorage.setItem(KEY, JSON.stringify(moved))
  return moved
}

/** What's kept for the core this window reaches. */
const here = (): Core => read().cores[coreNow()] ?? EMPTY

const change = (f: (c: Core) => Core) => {
  const core = coreNow()
  const doc = read()
  const next = f(doc.cores[core] ?? EMPTY)
  const { [core]: _, ...rest } = doc.cores
  const empty = next.entries.length === 0 && Object.keys(next.drafts).length === 0
  write({ v: 2, cores: empty ? rest : { ...rest, [core]: next } })
}

/** Told of every change, this window's and another's (`other`). */
export const subscribe = (l: (other: boolean) => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

window.addEventListener("storage", (e) => {
  if (e.key === KEY) {
    told(true)
  }
})

/** Changes with each write: a snapshot for `useSyncExternalStore`. */
export const version = () => localStorage.getItem(KEY) ?? ""

export const kept = (): readonly Entry[] => here().entries

export const find = (id: string) => kept().find((e) => e.id === id)

export const isKept = (id: string) => find(id) !== undefined

export const keep = (e: Entry) => {
  change((c) => ({ ...c, entries: [...c.entries.filter((o) => o.id !== e.id), e] }))
}

/** Changes a kept one in place, if it's still kept. */
export const update = (id: string, f: (e: Entry) => Entry) => {
  if (isKept(id)) {
    change((c) => ({ ...c, entries: c.entries.map((e) => (e.id === id ? f(e) : e)) }))
  }
}

/** Drops it, and its files' bytes unless they go on elsewhere (`keepFiles`). */
export const drop = (id: string, keepFiles = false) => {
  const e = find(id)
  if (e === undefined) {
    return
  }
  change((c) => ({ ...c, entries: c.entries.filter((o) => o.id !== id) }))
  if (!keepFiles) {
    for (const f of e.files ?? []) {
      void dropFile(f.id)
    }
  }
}

/** The newest kept `name` whose payload `matches`. */
export const latest = (name: string, matches: (payload: unknown) => boolean) =>
  kept().findLast((o) => o.name === name && matches(o.payload))

/** A box's draft: `space:<id>` or `thread:<id>`. */
export const draft = (place: string): Draft | undefined => here().drafts[place]

/** Keeps a box's draft, or drops it when there's nothing in it. */
export const setDraft = (place: string, d: Draft) => {
  const empty =
    d.text === "" &&
    (d.files ?? []).length === 0 &&
    (!Array.isArray(d.replyTo) || d.replyTo.length === 0)
  if (empty && draft(place) === undefined) {
    return
  }
  change((c) => {
    const { [place]: _, ...rest } = c.drafts
    return { ...c, drafts: empty ? rest : { ...rest, [place]: d } }
  })
}

const restoring = new Set<(place: string) => void>()

/** Told when words come back to a box from outside it (a message the core said no to). */
export const onRestore = (l: (place: string) => void) => {
  restoring.add(l)
  return () => {
    restoring.delete(l)
  }
}

/** A message the core said no to, back in its box (after what's there) and out of the chat. */
export const restore = (id: string, place: string) => {
  const e = find(id)
  if (e === undefined) {
    return
  }
  const p = e.payload
  const text = typeof p === "object" && p !== null && "text" in p ? String(p.text) : ""
  const had = draft(place) ?? { text: "" }
  setDraft(place, {
    ...had,
    text: had.text === "" ? text : `${had.text}\n${text}`,
    files: [...(had.files ?? []), ...(e.files ?? [])],
  })
  drop(id, true)
  for (const l of restoring) {
    l(place)
  }
}
