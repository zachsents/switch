// This Mac as a device of the vault. Its key pair is made once, the secret half kept in the login
// Keychain; it enrolls, and once approved, `sync` brings the vault key sealed to it and every item
// as a blob. Blobs are cached on disk so it opens offline; the vault key and the items opened from
// them live only in this process's memory while it's unlocked. Every write is an item sealed here.
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { Utils } from "electrobun/main"
import { Schema } from "effect"

import type { Keys } from "../../src/crypto.ts"
import {
  keysOf,
  newKeyPair,
  openFrom,
  openItem,
  prove,
  sealItem,
  statement,
  unb64,
} from "../../src/crypto.ts"
import { keychainDelete, keychainRead, keychainWrite, writePrivate } from "../../src/keychain.ts"
import { CONCEALED, isName, Item, slug } from "../../src/model.ts"
import type { Field } from "../../src/model.ts"
import { parseTotp, totpCode } from "../../src/otp.ts"
import { normalize } from "../../src/values.ts"
import type {
  Code,
  Entry,
  GrantRow,
  ItemDraft,
  Members,
  ShownField,
  ShownItem,
  Status,
  Version,
} from "../shared/rpc.ts"
import { NOTES } from "../shared/rpc.ts"
import { call } from "./core.ts"
import { clearClipboard, confirm, copyConcealed } from "./helper.ts"

/** A failure nothing more can be done about (the audit's note, the clipboard's clearing). */
const ignored = () => null

const SERVICE = "Switch secrets device"
const DIR = Utils.paths.userData
const DEVICE_FILE = path.join(DIR, "device.json")
const CACHE_FILE = path.join(DIR, "cache.json")
/** How long a reveal or copy goes without asking again. */
const CONFIRMED_FOR = 30_000
const CLIPBOARD_FOR = 90_000

const Me = Schema.Struct({
  id: Schema.String,
  key: Schema.String,
  name: Schema.String,
  code: Schema.String,
})
type Me = typeof Me.Type

const Sealed = Schema.Struct({ enc: Schema.String, ct: Schema.String })
const Blob = Schema.Struct({
  id: Schema.String,
  seq: Schema.Finite,
  deleted: Schema.Boolean,
  blob: Schema.String,
})
// `key` (public) is what an approval's proof is over.
const DeviceRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  key: Schema.String,
  code: Schema.String,
  status: Schema.String,
  created: Schema.Finite,
  seen: Schema.Finite,
})
const ExtensionRow = Schema.Struct({
  name: Schema.String,
  key: Schema.String,
  code: Schema.String,
  status: Schema.String,
  created: Schema.Finite,
})
const GrantRow = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  scope: Schema.String,
  uses: Schema.Array(Schema.String),
})
/** A pending device gets its status and code, and nothing else. */
const Synced = Schema.Struct({
  vault: Schema.String,
  status: Schema.String,
  seq: Schema.Finite,
  keyVersion: Schema.optionalKey(Schema.Finite),
  key: Schema.optionalKey(Sealed),
  items: Schema.Array(Blob),
  devices: Schema.Array(DeviceRow),
  extensions: Schema.Array(ExtensionRow),
  grants: Schema.optionalKey(Schema.Array(GrantRow)),
})
/** What's cached on disk: nothing but blobs and who's in the vault. */
const Cache = Schema.Struct({
  vault: Schema.String,
  keyVersion: Schema.Finite,
  seq: Schema.Finite,
  key: Schema.NullOr(Sealed),
  items: Schema.Array(Blob),
  devices: Schema.Array(DeviceRow),
  extensions: Schema.Array(ExtensionRow),
  grants: Schema.Array(GrantRow),
})
type Cache = typeof Cache.Type

const Enrolled = Schema.Struct({ device: Schema.String, code: Schema.String })
const Secret = Schema.Struct({ secretKey: Schema.String })
const History = Schema.Struct({
  history: Schema.Array(Schema.Struct({ at: Schema.Finite, blob: Schema.String })),
})
const Audit = Schema.Struct({
  uses: Schema.Array(
    Schema.Struct({
      id: Schema.Finite,
      at: Schema.Finite,
      item: Schema.String,
      name: Schema.String,
      field: Schema.String,
      use: Schema.String,
      who: Schema.String,
      space: Schema.String,
      why: Schema.String,
      target: Schema.String,
      ok: Schema.Boolean,
      reason: Schema.String,
    }),
  ),
})
const Any = Schema.Unknown

const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(Item))

const readFile = <A>(file: string, schema: Schema.Codec<A, unknown>): A | null => {
  if (!existsSync(file)) {
    return null
  }
  const read = Schema.decodeUnknownOption(Schema.fromJsonString(schema))(
    readFileSync(file, "utf-8"),
  )
  return read._tag === "Some" ? read.value : null
}

interface Opened {
  readonly keys: Keys
  readonly items: Map<string, Item>
  /** Versions fetched for items opened this session. */
  readonly history: Map<string, readonly { at: number; item: Item }[]>
}

let me = readFile(DEVICE_FILE, Me)
let cache = readFile(CACHE_FILE, Cache)
let opened: Opened | null = null
let status: Status = {
  stage: "starting",
  code: me?.code ?? "",
  error: "",
  online: false,
  device: me?.id ?? "",
}
let lastConfirmed = 0
let skipChecks = false
const listeners = new Set<() => void>()

const set = (next: Partial<Status>) => {
  status = { ...status, ...next }
  for (const l of listeners) {
    l()
  }
}

/** Calls `listener` whenever what the view shows may have changed. */
export const onChange = (listener: () => void) => {
  listeners.add(listener)
}

/** In a dev build only: skip the Mac's own check, for testing where nobody can pass it. */
export const skipChecksInDev = () => {
  skipChecks = true
}

export const currentStatus = () => status
export const isOpen = () => opened !== null

let checking: Promise<unknown> = Promise.resolve()

/** The Mac's own check, one at a time. */
const check = async (reason: string) => {
  const passed = async () => {
    await checking
    if (!skipChecks) {
      await confirm(reason)
    }
    lastConfirmed = Date.now()
  }
  const turn = passed()
  checking = turn.catch(ignored)
  await turn
}

/** The check again, unless it passed in the last half minute. */
const recent = async (reason: string) => {
  if (Date.now() - lastConfirmed > CONFIRMED_FOR) {
    await check(reason)
  }
}

const computerName = async () => {
  const proc = Bun.spawn(["scutil", "--get", "ComputerName"], { stdout: "pipe" })
  const said = await new Response(proc.stdout).text()
  return said.trim() || "Mac"
}

const enroll = async () => {
  const pair = await newKeyPair()
  const name = await computerName()
  const made = await call("device_enroll", { name, kind: "mac", key: pair.key }, Enrolled)
  await keychainWrite(SERVICE, `device:${made.device}`, { secretKey: pair.secretKey })
  const next: Me = { id: made.device, key: pair.key, name, code: made.code }
  writePrivate(DEVICE_FILE, JSON.stringify(next))
  me = next
  set({ stage: "pending", code: made.code, device: made.device, error: "" })
}

/** Forgets this device: its key, its cache, and what's open. */
const forget = async () => {
  if (me) {
    await keychainDelete(SERVICE, `device:${me.id}`)
  }
  rmSync(DEVICE_FILE, { force: true })
  rmSync(CACHE_FILE, { force: true })
  me = null
  cache = null
  opened = null
}

const stageOf = (): Status["stage"] => {
  if (opened) {
    return "open"
  }
  return cache?.key ? "locked" : "pending"
}

const offline = (message: string) =>
  message === "Can't reach the core" || message.endsWith("isn't running")

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Opens the vault key sealed to this device. */
const keysFrom = async (c: Cache, sealed: typeof Sealed.Type) => {
  if (!me) {
    throw new Error("Not enrolled")
  }
  const kept = Schema.decodeUnknownOption(Secret)(await keychainRead(SERVICE, `device:${me.id}`))
  if (kept._tag === "None") {
    throw new Error("This Mac's device key isn't in its Keychain")
  }
  const raw = await openFrom(
    kept.value.secretKey,
    `device:${me.id}`,
    `vault-key:${c.vault}:${c.keyVersion}`,
    sealed,
  )
  return await keysOf(c.vault, c.keyVersion, unb64(raw))
}

/** Every live blob opened; one that won't open under this key (mid-rotation) waits for the next sync. */
const openAll = async (keys: Keys, blobs: readonly (typeof Blob.Type)[]) => {
  const items = await Promise.all(
    blobs
      .filter((b) => !b.deleted && b.blob !== "")
      .map(async (b) => {
        const json = await openItem(keys, b.id, b.blob).catch(() => null)
        return json === null ? null : decodeItem(json)
      }),
  )
  return new Map(items.filter((i) => i !== null).map((i) => [i.id, i]))
}

let syncing: Promise<void> | null = null
let again = false

const syncOnce = async () => {
  if (!me) {
    return
  }
  const was = cache?.key ? cache : null
  const synced = await call(
    "sync",
    { device: me.id, since: was?.seq ?? 0, ...(was && { version: was.keyVersion }) },
    Synced,
  )
  if (synced.status === "pending" || synced.keyVersion === undefined) {
    set({ stage: "pending", online: true, error: "" })
    return
  }
  // A new key version brings every item again.
  const whole = !was || was.keyVersion !== synced.keyVersion
  const byId = new Map(whole ? [] : was.items.map((b) => [b.id, b]))
  for (const b of synced.items) {
    if (b.deleted) {
      byId.delete(b.id)
    } else {
      byId.set(b.id, b)
    }
  }
  const next: Cache = {
    vault: synced.vault,
    keyVersion: synced.keyVersion,
    seq: synced.seq,
    key: synced.key ?? was?.key ?? null,
    items: [...byId.values()],
    devices: synced.devices,
    extensions: synced.extensions,
    grants: synced.grants ?? [],
  }
  cache = next
  writePrivate(CACHE_FILE, JSON.stringify(next))
  if (next.devices.some((d) => d.id === me?.id && d.status === "revoked")) {
    opened = null
    set({ stage: "revoked", online: true, error: "" })
    return
  }
  if (opened && next.key && (opened.keys.version !== next.keyVersion || synced.items.length > 0)) {
    const keys =
      opened.keys.version === next.keyVersion ? opened.keys : await keysFrom(next, next.key)
    opened = { ...opened, keys, items: await openAll(keys, next.items) }
  }
  set({ stage: stageOf(), online: true, error: "" })
}

/** A sync, what went wrong said in the status. */
const syncSaying = async () => {
  try {
    await syncOnce()
  } catch (error) {
    const message = errorOf(error)
    if (offline(message)) {
      set({ online: false })
    } else if (/revoked|not a device/iu.test(message)) {
      set({ stage: "revoked", online: true })
    } else {
      set({ online: true, error: message })
    }
  }
}

/** Brings the cache up to date; one at a time, and once more if asked meanwhile. */
export const sync = async () => {
  if (syncing) {
    again = true
    await syncing
    return
  }
  syncing = syncSaying()
  await syncing
  syncing = null
  if (again) {
    again = false
    await sync()
  }
}

/** Starts: enrolls if this Mac never has, then syncs. */
export const start = async () => {
  try {
    if (!me) {
      await enroll()
    }
    set({ stage: stageOf(), code: me?.code ?? "", device: me?.id ?? "" })
  } catch (error) {
    set({ stage: "failed", error: errorOf(error) })
    return
  }
  await sync()
}

/** After a failure or a revocation: forgets this device and enrolls again. */
export const retry = async () => {
  if (status.stage === "revoked") {
    await forget()
  }
  await start()
}

let unlocking: Promise<void> | null = null

export const unlock = async () => {
  if (opened || !cache?.key) {
    return
  }
  const c = cache
  const sealed = cache.key
  unlocking ??= (async () => {
    await check("unlock your secrets")
    const keys = await keysFrom(c, sealed)
    opened = { keys, items: await openAll(keys, c.items), history: new Map() }
    set({ stage: "open", error: "" })
  })().finally(() => {
    unlocking = null
  })
  await unlocking
}

export const lock = () => {
  opened = null
  lastConfirmed = 0
  set({ stage: stageOf() })
}

const need = () => {
  if (!opened || !me) {
    throw new Error("Locked")
  }
  return { open: opened, device: me.id }
}

const shownField = (f: Field): ShownField => {
  const concealed = CONCEALED.has(f.type)
  return { ...f, concealed, value: concealed ? "" : f.value, set: f.value !== "" }
}

const shown = (item: Item): ShownItem => ({
  ...item,
  fields: item.fields.map(shownField),
  notes: item.notes !== "",
})

export const items = (): readonly ShownItem[] => [...need().open.items.values()].map(shown)

/** An item by id or name. */
export const find = (given: string): Item | undefined => {
  const all = opened?.items
  return all?.get(given) ?? [...(all?.values() ?? [])].find((i) => i.name === given)
}

export const itemOf = (id: string): ShownItem | null => {
  const found = need().open.items.get(id)
  return found ? shown(found) : null
}

const report = (device: string, id: string, field: string, use: string) => {
  void call("used", { device, item: id, field, use }, Any).catch(ignored)
}

/** The item as it is, or as it was at `at` (a version from its history). */
const versionOf = (open: Opened, id: string, at: number | undefined) => {
  const found =
    at === undefined ? open.items.get(id) : open.history.get(id)?.find((v) => v.at === at)?.item
  if (!found) {
    throw new Error("No such item")
  }
  return found
}

/** A field, or the notes as one. */
const fieldOf = (open: Opened, id: string, field: string, at: number | undefined): Field => {
  const item = versionOf(open, id, at)
  const f =
    field === NOTES
      ? { id: NOTES, label: "Notes", type: "concealed" as const, value: item.notes }
      : item.fields.find((x) => x.id === field)
  if (!f || f.value === "") {
    throw new Error("Nothing in that field")
  }
  return f
}

/** A concealed value, after the check. */
export const reveal = async (id: string, field: string, at?: number) => {
  const { open, device } = need()
  const f = fieldOf(open, id, field, at)
  await recent("reveal a secret")
  report(device, id, field, "reveal")
  return f.value
}

const codeOf = (value: string): Code => {
  const t = parseTotp(value)
  const now = Date.now()
  const period = t.period * 1000
  return { code: totpCode(t, now / 1000), period: t.period, left: period - (now % period) }
}

/** An authenticator field's code now. */
export const code = (id: string, field: string) =>
  codeOf(fieldOf(need().open, id, field, undefined).value)

/** Copies a value concealed, and clears it in 90 s if it's still there. */
export const copyText = async (text: string) => {
  const count = await copyConcealed(text)
  setTimeout(() => {
    void clearClipboard(count).catch(ignored)
  }, CLIPBOARD_FOR)
}

/** Copies a field (an authenticator's code, not its key), after the check. */
export const copy = async (id: string, field: string, at?: number) => {
  const { open, device } = need()
  const f = fieldOf(open, id, field, at)
  await recent("copy a secret")
  await copyText(f.type === "totp" ? codeOf(f.value).code : f.value)
  report(device, id, field, "copy")
}

const seal = async (item: Item) => {
  const { open, device } = need()
  const blob = await sealItem(open.keys, item.id, JSON.stringify(item))
  await call("put", { device, id: item.id, blob }, Any)
}

/** Keeps an item; if the vault key has moved on since the last sync, syncs and seals it again. */
const put = async (item: Item) => {
  try {
    await seal(item)
  } catch (error) {
    if (!errorOf(error).includes("seal it again")) {
      throw error
    }
    await sync()
    await seal(item)
  }
  const { open } = need()
  open.items.set(item.id, item)
  open.history.delete(item.id)
  set({})
  void sync()
}

const nameFor = (draft: ItemDraft, id: string) => {
  const taken = new Set(
    [...need().open.items.values()].filter((i) => i.id !== id).map((i) => i.name),
  )
  const given = draft.name.trim()
  if (given) {
    if (!isName(given)) {
      throw new Error("A name is lowercase letters, digits and . _ / @ -")
    }
    if (taken.has(given)) {
      throw new Error(`${given} is taken`)
    }
    return given
  }
  const base = slug(draft.title)
  let name = base
  let n = 2
  while (taken.has(name)) {
    name = `${base.slice(0, 60)}-${n}`
    n += 1
  }
  return name
}

/** Saves an item the view edited: its concealed values kept where the draft leaves them out. */
export const save = async (draft: ItemDraft, source = "user") => {
  const { open } = need()
  const was = draft.id === undefined ? undefined : open.items.get(draft.id)
  const id = was?.id ?? crypto.randomUUID()
  const now = Date.now()
  const fields = draft.fields.map((f) => {
    const value = f.value ?? was?.fields.find((x) => x.id === f.id)?.value ?? ""
    return {
      id: f.id,
      label: f.label.trim() || f.id,
      type: f.type,
      value: value && normalize(f.type, value),
    }
  })
  const next = Schema.decodeUnknownSync(Item)({
    id,
    kind: draft.kind,
    name: nameFor(draft, id),
    title: draft.title.trim(),
    fields,
    urls: draft.urls.filter((u) => u.url.trim() !== ""),
    notes: draft.notes ?? was?.notes ?? "",
    tags: [...new Set(draft.tags.map((t) => t.trim()).filter(Boolean))],
    folder: draft.folder.trim(),
    spaces: draft.spaces,
    favorite: draft.favorite,
    source: was?.source ?? source,
    created: was?.created ?? now,
    updated: now,
    trashed: was?.trashed ?? 0,
  })
  await put(next)
  return id
}

/** Drafts from an import, each a new item sealed here. */
export const add = async (drafts: readonly Omit<ItemDraft, "id">[], source: string) => {
  for (const d of drafts) {
    await save(d, source)
  }
}

/** Its versions, newest first, each with its fields as the view sees them. */
export const history = async (id: string): Promise<readonly Version[]> => {
  const { open, device } = need()
  const got = await call("history", { device, id }, History)
  const versions = await Promise.all(
    got.history.map(async (h) => ({
      at: h.at,
      item: decodeItem(await openItem(open.keys, id, h.blob)),
    })),
  )
  const sorted = versions.toSorted((a, b) => b.at - a.at)
  open.history.set(id, sorted)
  const current = open.items.get(id)
  // Each version by what it held that the one after it doesn't: its old values.
  return sorted.map((v, i) => {
    const after = i === 0 ? current : sorted[i - 1]?.item
    const changed = v.item.fields.filter(
      (f) => f.value !== "" && after?.fields.find((x) => x.id === f.id)?.value !== f.value,
    )
    const notes =
      v.item.notes !== "" && v.item.notes !== after?.notes
        ? [shownField({ id: NOTES, label: "Notes", type: "concealed", value: v.item.notes })]
        : []
    return { at: v.at, fields: [...changed.map(shownField), ...notes] }
  })
}

/** Puts one field's old value back. */
export const restore = async (id: string, at: number, field: string) => {
  const { open } = need()
  const now = versionOf(open, id, undefined)
  const old = fieldOf(open, id, field, at)
  if (field === NOTES) {
    await put({ ...now, notes: old.value, updated: Date.now() })
    return
  }
  const fields = now.fields.some((f) => f.id === field)
    ? now.fields.map((f) => (f.id === field ? old : f))
    : [...now.fields, old]
  await put({ ...now, fields, updated: Date.now() })
}

/** To the trash, or back: the item sealed again with when it was trashed. */
export const trash = async (id: string, restoring: boolean) => {
  const was = versionOf(need().open, id, undefined)
  const now = Date.now()
  await put({ ...was, trashed: restoring ? 0 : now, updated: now })
}

/** What only the user may do: after the check, with a proof over its statement. */
const proven = async (reason: string, ...words: string[]) => {
  const { open, device } = need()
  await recent(reason)
  return { device, proof: await prove(open.keys, statement(...words)) }
}

export const purge = async (id: string) => {
  const { device, proof } = await proven("delete a secret for good", "purge", id)
  await call("remove", { device, id, proof }, Any)
  need().open.items.delete(id)
  set({})
  void sync()
}

export const members = (): Members => ({
  devices: cache?.devices ?? [],
  extensions: cache?.extensions ?? [],
  grants: cache?.grants ?? [],
})

export const approveDevice = async (id: string) => {
  const d = cache?.devices.find((x) => x.id === id)
  if (!d) {
    throw new Error("No such device")
  }
  const { proof } = await proven("approve a device", "approve-device", d.id, d.key)
  await call("device_approve", { device: d.id, proof }, Any)
  await sync()
}

export const revokeDevice = async (id: string) => {
  const { proof } = await proven("revoke a device", "revoke-device", id)
  await call("device_revoke", { device: id, proof }, Any)
  if (id === me?.id) {
    await forget()
    set({ stage: "revoked" })
    return
  }
  await sync()
}

export const approveExtension = async (name: string) => {
  const s = cache?.extensions.find((x) => x.name === name)
  if (!s) {
    throw new Error("No such extension")
  }
  const { proof } = await proven("allow an extension", "approve-extension", s.name, s.key)
  await call("extension_approve", { extension: s.name, proof }, Any)
  await sync()
}

export const revokeExtension = async (name: string) => {
  const { proof } = await proven("stop an extension", "revoke-extension", name)
  await call("extension_revoke", { extension: name, proof }, Any)
  await sync()
}

/** Adds a grant, or removes one by its id. */
export const grant = async (op: "add" | "remove", g: GrantRow) => {
  const reason = "change what may use your secrets"
  if (op === "remove") {
    const { device, proof } = await proven(reason, "grant", "remove", g.id)
    await call("grant", { device, proof, op, id: g.id }, Any)
  } else {
    const words = ["grant", "add", g.subject, g.scope, g.uses.join(",")]
    const { device, proof } = await proven(reason, ...words)
    await call(
      "grant",
      { device, proof, op, subject: g.subject, scope: g.scope, uses: g.uses },
      Any,
    )
  }
  await sync()
}

export const audit = async (item: string | undefined): Promise<readonly Entry[]> => {
  need()
  const got = await call("audit", { ...(item !== undefined && { item }), limit: 200 }, Audit)
  return got.uses
}

/** Every item opened, after the check; each reported as exported. */
export const exportAll = async (reason: string) => {
  const { open, device } = need()
  await check(reason)
  const all = [...open.items.values()].filter((i) => i.trashed === 0)
  // A few at a time, so a big vault doesn't flood the core.
  for (let i = 0; i < all.length; i += 8) {
    await Promise.all(
      all.slice(i, i + 8).map(async (x) => {
        await call("used", { device, item: x.id, field: "*", use: "export" }, Any).catch(ignored)
      }),
    )
  }
  return all
}
