// The vault on disk: one SQLite file of sealed items, their history, the devices and extensions
// that may open them, the grants and the audit; the vault key in this Mac's Keychain. Every item is
// opened into memory when the extension starts and sealed again on every write. Each write bumps
// the vault's sequence, which is how devices sync (`since`).
import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { Option, Schema } from "effect"

import {
  b64,
  keysOf,
  newKeyPair,
  newVaultKey,
  openItem,
  sealItem,
  sealTo,
  unb64,
} from "./crypto.ts"
import type { Keys } from "./crypto.ts"
import { keychainRead, keychainWrite } from "./keychain.ts"
import { Item } from "./model.ts"
import type { ItemId } from "./model.ts"

export const dir = (): string =>
  process.env.SWITCH_SECRETS_DIR ??
  path.join(process.env.SWITCH_DIR ?? path.join(homedir(), ".switch"), "secrets")

const SERVICE = "Switch secrets"

const keyFields = {
  version: Schema.Finite,
  key: Schema.String,
  /** The key before a rotation that may not have finished. */
  previous: Schema.optionalKey(Schema.Struct({ version: Schema.Finite, key: Schema.String })),
}
const Kept = Schema.Struct({
  ...keyFields,
  extensionKey: Schema.String,
  extensionSecret: Schema.String,
})
/** The key pair's names before extensions were renamed: read, never written. */
const LegacyKept = Schema.Struct({
  ...keyFields,
  spurKey: Schema.String,
  spurSecret: Schema.String,
})
const decodeKept = Schema.decodeUnknownOption(Kept)
const decodeLegacyKept = Schema.decodeUnknownSync(LegacyKept)
type Kept = typeof Kept.Type

const decodeItem = Schema.decodeUnknownSync(Schema.fromJsonString(Item))

export interface Device {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly key: string
  readonly code: string
  readonly status: "pending" | "active" | "revoked"
  readonly created: number
  readonly approved: number
  readonly seen: number
}

export interface Extension {
  readonly name: string
  readonly key: string
  readonly code: string
  readonly status: "pending" | "active" | "revoked"
  readonly created: number
  readonly approved: number
}

export interface Grant {
  readonly id: string
  readonly subject: string
  readonly scope: string
  readonly uses: readonly string[]
  readonly created: number
}

export interface Use {
  readonly item: string
  readonly name: string
  readonly field: string
  readonly use: string
  readonly who: string
  readonly space: string
  readonly why: string
  readonly target: string
  readonly ok: boolean
  readonly reason: string
}

export interface Entry extends Use {
  readonly id: number
  readonly at: number
}

const SCHEMA = `
create table if not exists meta (key text primary key, value text not null);
create table if not exists items (id text primary key, seq integer not null, blob text not null, purged integer not null default 0);
create index if not exists items_seq on items (seq);
create table if not exists history (id text not null, at integer not null, blob text not null);
create index if not exists history_id on history (id);
create table if not exists devices (id text primary key, name text not null, kind text not null, key text not null, code text not null, status text not null, created integer not null, approved integer not null default 0, seen integer not null default 0, sealed text not null default '');
create table if not exists extensions (name text primary key, key text not null, code text not null, status text not null, created integer not null, approved integer not null default 0);
create table if not exists grants (id text primary key, subject text not null, scope text not null, uses text not null, created integer not null);
create table if not exists audit (id integer primary key autoincrement, at integer not null, item text not null, name text not null, field text not null, use text not null, who text not null, space text not null, why text not null, target text not null, ok integer not null, reason text not null);
create index if not exists audit_item on audit (item, at);
create table if not exists asks (id text primary key, blob text not null, created integer not null);
`

/** The vault as this process holds it: its file, its keys, and every item opened. */
export interface Vault {
  readonly db: Database
  keys: Keys
  readonly extensionKey: string
  readonly extensionSecret: string
  readonly items: Map<ItemId, Item>
}

const meta = (db: Database, key: string) =>
  db.query<{ value: string }, [string]>("select value from meta where key = ?").get(key)?.value

const setMeta = (db: Database, key: string, value: string) => {
  db.run(
    "insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value",
    [key, value],
  )
}

export const seqOf = (v: Vault): number => Number(meta(v.db, "seq") ?? "0")

const bump = (v: Vault) => {
  const next = seqOf(v) + 1
  setMeta(v.db, "seq", String(next))
  return next
}

const keptOf = async (vault: string): Promise<Kept | null> => {
  const raw = await keychainRead(SERVICE, `vault:${vault}`)
  if (raw === null) {
    return null
  }
  return Option.getOrElse(decodeKept(raw), () => {
    const { spurKey, spurSecret, ...rest } = decodeLegacyKept(raw)
    return { ...rest, extensionKey: spurKey, extensionSecret: spurSecret }
  })
}

const hasTable = (db: Database, name: string) =>
  db.query("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !== null

/** The vault's file, without its key: what's in it that isn't sealed. */
export const openDb = (at = dir()): Database => {
  mkdirSync(at, { recursive: true, mode: 0o700 })
  const file = path.join(at, "vault.db")
  const db = new Database(file, { create: true, strict: true })
  chmodSync(file, 0o600)
  db.run("pragma journal_mode = wal")
  db.run("pragma busy_timeout = 5000")
  // The extensions table was `spurs` before extensions were renamed: renamed in place, once.
  if (hasTable(db, "spurs") && !hasTable(db, "extensions")) {
    db.run("alter table spurs rename to extensions")
  }
  db.run(SCHEMA)
  return db
}

/** Opens the vault in `at`, making it (and its key) the first time. */
export const openVault = async (at = dir()): Promise<Vault> => {
  const db = openDb(at)
  const vault = meta(db, "vault") ?? crypto.randomUUID()
  setMeta(db, "vault", vault)
  let kept = await keptOf(vault)
  const count = db.query<{ n: number }, []>("select count(*) as n from items").get()?.n ?? 0
  if (kept === null) {
    if (count > 0) {
      throw new Error("This Mac's Keychain has no key for the vault here: it can't be opened")
    }
    const pair = await newKeyPair()
    kept = {
      version: 1,
      key: b64(newVaultKey()),
      extensionKey: pair.key,
      extensionSecret: pair.secretKey,
    }
    await keychainWrite(SERVICE, `vault:${vault}`, kept, true)
  }
  const keys = await keysOf(vault, kept.version, unb64(kept.key))
  const v: Vault = {
    db,
    keys,
    extensionKey: kept.extensionKey,
    extensionSecret: kept.extensionSecret,
    items: new Map(),
  }
  // Grants to an extension were `spur:<name>` before extensions were renamed: moved, once.
  const moved = db.run(
    "update grants set subject = 'extension:' || substr(subject, 6) where subject like 'spur:%'",
  )
  if (moved.changes > 0) {
    bump(v)
  }
  const previous =
    kept.previous === undefined
      ? null
      : await keysOf(vault, kept.previous.version, unb64(kept.previous.key))
  const rows = db
    .query<{ id: string; blob: string }, []>("select id, blob from items where purged = 0")
    .all()
  for (const row of rows) {
    const item = await openEither(v, previous, row.id, row.blob)
    v.items.set(item.id, item)
  }
  if (previous !== null) {
    // A rotation stopped short: finish sealing under the new key, then forget the old one.
    await reseal(v, previous)
    const { previous: _, ...rest } = kept
    await keychainWrite(SERVICE, `vault:${vault}`, rest)
  }
  return v
}

const openEither = async (v: Vault, previous: Keys | null, id: string, blob: string) => {
  try {
    return decodeItem(await openItem(v.keys, id, blob))
  } catch (error) {
    if (previous === null) {
      throw error
    }
    return decodeItem(await openItem(previous, id, blob))
  }
}

/** Every blob sealed again under the vault's current key; `from` opens the ones that aren't. */
const reseal = async (v: Vault, from: Keys) => {
  const rows = v.db
    .query<{ id: string; blob: string }, []>("select id, blob from items where purged = 0")
    .all()
  const old = v.db
    .query<{ rowid: number; id: string; blob: string }, []>("select rowid, id, blob from history")
    .all()
  const open = async (id: string, blob: string) => {
    try {
      return await openItem(v.keys, id, blob)
    } catch {
      return await openItem(from, id, blob)
    }
  }
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      blob: await sealItem(v.keys, r.id, await open(r.id, r.blob)),
    })),
  )
  const history = await Promise.all(
    old.map(async (r) => ({
      rowid: r.rowid,
      blob: await sealItem(v.keys, r.id, await open(r.id, r.blob)),
    })),
  )
  v.db.transaction(() => {
    for (const r of items) {
      v.db.run("update items set blob = ?, seq = ? where id = ?", [r.blob, bump(v), r.id])
    }
    for (const r of history) {
      v.db.run("update history set blob = ? where rowid = ?", [r.blob, r.rowid])
    }
  })()
}

/** Seals an item and keeps it, what it was before going to its history. Returns the new seq. */
export const writeItem = async (v: Vault, item: Item): Promise<number> => {
  const blob = await sealItem(v.keys, item.id, JSON.stringify(item))
  return writeBlob(v, item, blob)
}

/** Keeps an item already sealed (a device's), once it's been opened and checked. */
export const writeBlob = (v: Vault, item: Item, blob: string): number => {
  const seq = v.db.transaction(() => {
    const before = v.db
      .query<{ blob: string }, [string]>("select blob from items where id = ? and purged = 0")
      .get(item.id)
    if (before) {
      v.db.run("insert into history (id, at, blob) values (?, ?, ?)", [
        item.id,
        Date.now(),
        before.blob,
      ])
    }
    const next = bump(v)
    v.db.run(
      "insert into items (id, seq, blob, purged) values (?, ?, ?, 0) on conflict (id) do update set seq = excluded.seq, blob = excluded.blob, purged = 0",
      [item.id, next, blob],
    )
    return next
  })()
  v.items.set(item.id, item)
  return seq
}

/** Removes an item and its history for good; devices learn it from its tombstone. */
export const purge = (v: Vault, id: ItemId): number => {
  const seq = v.db.transaction(() => {
    v.db.run("delete from history where id = ?", [id])
    const next = bump(v)
    v.db.run("update items set blob = '', purged = 1, seq = ? where id = ?", [next, id])
    return next
  })()
  v.items.delete(id)
  return seq
}

export const history = (v: Vault, id: string): { at: number; blob: string }[] =>
  v.db
    .query<{ at: number; blob: string }, [string]>(
      "select at, blob from history where id = ? order by at desc",
    )
    .all(id)

/** An item's earlier versions, opened. */
export const historyItems = async (v: Vault, id: ItemId): Promise<{ at: number; item: Item }[]> =>
  await Promise.all(
    history(v, id).map(async (h) => ({
      at: h.at,
      item: decodeItem(await openItem(v.keys, id, h.blob)),
    })),
  )

export const changedSince = (v: Vault, since: number) =>
  v.db
    .query<{ id: string; seq: number; blob: string; purged: number }, [number]>(
      "select id, seq, blob, purged from items where seq > ? order by seq",
    )
    .all(since)
    .map((r) => ({ id: r.id, seq: r.seq, deleted: r.purged === 1, blob: r.blob }))

// Devices and extensions.

export const devices = (v: Pick<Vault, "db">): Device[] =>
  v.db
    .query<Device, []>(
      "select id, name, kind, key, code, status, created, approved, seen from devices order by created",
    )
    .all()

export const device = (v: Vault, id: string): Device | null =>
  v.db
    .query<Device, [string]>(
      "select id, name, kind, key, code, status, created, approved, seen from devices where id = ?",
    )
    .get(id)

export const addDevice = (v: Vault, d: Device) => {
  v.db.run(
    "insert into devices (id, name, kind, key, code, status, created) values (?, ?, ?, ?, ?, ?, ?)",
    [d.id, d.name, d.kind, d.key, d.code, d.status, d.created],
  )
}

export const sawDevice = (v: Vault, id: string) => {
  v.db.run("update devices set seen = ? where id = ?", [Date.now(), id])
}

/** The vault key sealed to a device, for the key version now. */
export const sealedKeyFor = (
  v: Vault,
  id: string,
): { enc: string; ct: string; version: number } | null => {
  const row = v.db
    .query<{ sealed: string }, [string]>("select sealed from devices where id = ?")
    .get(id)
  if (!row || row.sealed === "") {
    return null
  }
  const parsed: unknown = JSON.parse(row.sealed)
  return Schema.decodeUnknownSync(
    Schema.Struct({ enc: Schema.String, ct: Schema.String, version: Schema.Finite }),
  )(parsed)
}

const sealKeyTo = async (v: Vault, d: Device) => {
  const sealed = await sealTo(
    d.key,
    `device:${d.id}`,
    `vault-key:${v.keys.vault}:${v.keys.version}`,
    b64(v.keys.raw),
  )
  return JSON.stringify({ ...sealed, version: v.keys.version })
}

export const approveDevice = async (v: Vault, d: Device) => {
  const sealed = await sealKeyTo(v, d)
  v.db.run("update devices set status = 'active', approved = ?, sealed = ? where id = ?", [
    Date.now(),
    sealed,
    d.id,
  ])
  bump(v)
}

/** Revokes a device and rotates the vault key, sealing the new one to every device left. */
export const revokeDevice = async (v: Vault, id: string) => {
  v.db.run("update devices set status = 'revoked', sealed = '' where id = ?", [id])
  await rotate(v)
}

export const rotate = async (v: Vault) => {
  const from = v.keys
  const raw = newVaultKey()
  const version = from.version + 1
  const account = `vault:${from.vault}`
  const kept = await keptOf(from.vault)
  if (kept === null) {
    throw new Error("The vault's key is gone from this Mac's Keychain")
  }
  await keychainWrite(SERVICE, account, {
    ...kept,
    version,
    key: b64(raw),
    previous: { version: from.version, key: b64(from.raw) },
  })
  v.keys = await keysOf(from.vault, version, raw)
  await reseal(v, from)
  for (const d of devices(v).filter((x) => x.status === "active")) {
    v.db.run("update devices set sealed = ? where id = ?", [await sealKeyTo(v, d), d.id])
  }
  await keychainWrite(SERVICE, account, { ...kept, version, key: b64(raw) })
}

export const extensions = (v: Pick<Vault, "db">): Extension[] =>
  v.db
    .query<Extension, []>(
      "select name, key, code, status, created, approved from extensions order by created",
    )
    .all()

export const extension = (v: Vault, name: string): Extension | null =>
  v.db
    .query<Extension, [string]>(
      "select name, key, code, status, created, approved from extensions where name = ?",
    )
    .get(name)

export const putExtension = (v: Vault, s: Extension) => {
  v.db.run(
    "insert into extensions (name, key, code, status, created, approved) values (?, ?, ?, ?, ?, ?) on conflict (name) do update set key = excluded.key, code = excluded.code, status = excluded.status, approved = excluded.approved",
    [s.name, s.key, s.code, s.status, s.created, s.approved],
  )
  bump(v)
  if (s.status === "active") {
    allowFill(v, s.name)
  }
}

/**
 * What allowing an extension means ("Let … use your secrets?"): a grant to fill with any of them,
 * as the browser's from the start. Its grants stay the user's to change.
 */
export const allowFill = (v: Vault, name: string) => {
  const subject = `extension:${name}`
  if (!grants(v).some((g) => g.subject === subject)) {
    addGrant(v, { subject, scope: "all", uses: ["fill"] })
  }
}

// Grants.

export const grants = (v: Vault): Grant[] =>
  v.db
    .query<{ id: string; subject: string; scope: string; uses: string; created: number }, []>(
      "select id, subject, scope, uses, created from grants order by created",
    )
    .all()
    .map((g) => ({ ...g, uses: g.uses.split(",").filter(Boolean) }))

export const addGrant = (v: Vault, g: Omit<Grant, "id" | "created">): Grant => {
  const made = { ...g, id: crypto.randomUUID(), created: Date.now() }
  v.db.run("insert into grants (id, subject, scope, uses, created) values (?, ?, ?, ?, ?)", [
    made.id,
    made.subject,
    made.scope,
    made.uses.join(","),
    made.created,
  ])
  bump(v)
  return made
}

export const removeGrant = (v: Vault, id: string) => {
  v.db.run("delete from grants where id = ?", [id])
  bump(v)
}

/** The grants a new vault starts with: the agent and the browser may use everything. */
export const seedGrants = (v: Vault) => {
  if (meta(v.db, "seeded") !== undefined) {
    return
  }
  addGrant(v, { subject: "agent", scope: "all", uses: ["fill", "env", "file", "http"] })
  addGrant(v, { subject: "extension:browser", scope: "all", uses: ["fill"] })
  setMeta(v.db, "seeded", "1")
}

/** Once: extensions allowed before allowing one granted it fill get that grant. */
export const grantAllowed = (v: Vault) => {
  if (meta(v.db, "allowed-fill") !== undefined) {
    return
  }
  for (const s of extensions(v).filter((x) => x.status === "active")) {
    allowFill(v, s.name)
  }
  setMeta(v.db, "allowed-fill", "1")
}

// The audit.

export const record = (v: Vault, u: Use) => {
  v.db.run(
    "insert into audit (at, item, name, field, use, who, space, why, target, ok, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      Date.now(),
      u.item,
      u.name,
      u.field,
      u.use,
      u.who,
      u.space,
      u.why,
      u.target,
      u.ok ? 1 : 0,
      u.reason,
    ],
  )
}

export const audit = (v: Vault, item: string | null, limit: number): Entry[] =>
  v.db
    .query<Omit<Entry, "ok"> & { ok: number }, [string | null, string | null, number]>(
      "select * from audit where (? is null or item = ?) order by id desc limit ?",
    )
    .all(item, item, limit)
    .map((e) => ({ ...e, ok: e.ok === 1 }))

/** When each item was last used, for its outline. */
export const lastUsed = (v: Vault): Map<string, number> =>
  new Map(
    v.db
      .query<{ item: string; at: number }, []>(
        "select item, max(at) as at from audit where ok = 1 and use in ('fill', 'env', 'file', 'http', 'reveal', 'copy', 'autofill') group by item",
      )
      .all()
      .map((r) => [r.item, r.at]),
  )

// Sealed asks waiting for their answer: each one's secret key and what it fills, sealed too.

export const keepAsk = async (v: Vault, id: string, what: unknown) => {
  const blob = await sealItem(v.keys, `ask:${id}`, JSON.stringify(what))
  v.db.run("insert or replace into asks (id, blob, created) values (?, ?, ?)", [
    id,
    blob,
    Date.now(),
  ])
}

/** The asks waiting for their answer, oldest first. */
export const askIds = (v: Vault) =>
  v.db
    .query<{ id: string }, []>("select id from asks order by created")
    .all()
    .map((r) => r.id)

export const askOf = async (v: Vault, id: string): Promise<unknown> => {
  const row = v.db.query<{ blob: string }, [string]>("select blob from asks where id = ?").get(id)
  if (!row) {
    return null
  }
  const parsed: unknown = JSON.parse(await openItem(v.keys, `ask:${id}`, row.blob))
  return parsed
}

export const dropAsk = (v: Vault, id: string) => {
  v.db.run("delete from asks where id = ?", [id])
}
