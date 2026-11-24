// Credentials, the way old Switchboard paired appendages and T3 Code pairs clients: a device or a
// host asks with `POST /pair` and gets a code the user approves on a desktop; a desktop can offer a
// one-time QR instead, which pairs at once; the core mints for this machine. Each is per device or
// host, with scopes, and revocable. An extension's token is derived from the core's key, so nothing
// of it is stored but its generation and revocation: issuing one again (`/auth/rotate`) moves it to
// the next generation, and the last one's token stops working. Only token hashes ever reach the brain.
import { timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import type { Database } from "bun:sqlite"
import { defineCommand, defineEvent, on } from "@switch/brain"
import { createFileAtomic } from "@switch/brain/files"
import type { Projection } from "@switch/brain"
import { Schema } from "effect"

/**
 * - `client`: the sync socket, widgets and passes: a user's own app.
 * - `admin`: approving, offering, minting and revoking.
 * - `host`: a machine's extension host.
 * - `extension:<name>`: one extension, dialing in or calling the core's apps.
 * - `peer`: another agent (a Claude Code or T3 Code session), at `/peer` alone (peer.ts).
 */
export type Scope = "client" | "admin" | "host" | "peer" | `extension:${string}`

export const KINDS = ["device", "host", "extension", "tailnet", "peer"] as const
export type Kind = (typeof KINDS)[number]

const scopes = Schema.Array(Schema.String)
const kind = Schema.Literals(KINDS)

export const CredentialRequested = defineEvent(
  "credential.requested",
  1,
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind,
    scopes,
    hash: Schema.String,
    code: Schema.String,
  }),
)

export const CredentialIssued = defineEvent(
  "credential.issued",
  1,
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    kind,
    scopes,
    /** Empty for one that holds no token: the tailnet's, during the move to credentials. */
    hash: Schema.String,
    /** Good until then, in ms. */
    until: Schema.optionalKey(Schema.Number),
    /** The offer it redeemed. */
    offer: Schema.optionalKey(Schema.String),
  }),
)

export const CredentialApproved = defineEvent(
  "credential.approved",
  1,
  Schema.Struct({ id: Schema.String }),
)

export const CredentialDenied = defineEvent(
  "credential.denied",
  1,
  Schema.Struct({ id: Schema.String }),
)

export const CredentialRevoked = defineEvent(
  "credential.revoked",
  1,
  Schema.Struct({ id: Schema.String }),
)

export const CredentialOffered = defineEvent(
  "credential.offered",
  1,
  Schema.Struct({ id: Schema.String, hash: Schema.String, scopes, until: Schema.Number }),
)

export type Status = "pending" | "active" | "denied" | "revoked"

export interface Credential {
  readonly id: string
  readonly name: string
  readonly kind: Kind
  readonly scopes: readonly string[]
  readonly status: Status
  readonly code: string | null
  readonly at: number
  readonly until: number | null
}

interface Row {
  readonly id: string
  readonly name: string
  readonly kind: Kind
  readonly scopes: string
  readonly status: Status
  readonly code: string | null
  readonly at: number
  readonly until: number | null
}

const parseScopes: (json: string) => string[] = JSON.parse

/** An extension's scope or id from before extensions were renamed (`spur:<name>`), as it is now. */
const renamed = (s: string) => (s.startsWith("spur:") ? `extension:${s.slice("spur:".length)}` : s)
const scopesOf = (given: readonly string[]) => JSON.stringify(given.map(renamed))

const toCredential = (r: Row): Credential => ({ ...r, scopes: parseScopes(r.scopes) })

/** A pairing request lapses this long after it's made. */
export const PAIRING_MS = 10 * 60_000

export const credentials: Projection = {
  name: "credentials",
  // 2: extensions' scopes and ids read from their old `spur:` names. 3: extensions' generations.
  version: 3,
  tables: ["credentials", "credential_offers"],
  create: `
    CREATE TABLE credentials (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      scopes TEXT NOT NULL, hash TEXT, status TEXT NOT NULL, code TEXT, at INTEGER NOT NULL,
      until INTEGER, generation INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX credentials_hash ON credentials (hash);
    CREATE TABLE credential_offers (id TEXT PRIMARY KEY, hash TEXT NOT NULL, scopes TEXT NOT NULL,
      until INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);`,
  on: [
    on(CredentialRequested, (db, p, e) => {
      db.query(
        "INSERT OR IGNORE INTO credentials (id, name, kind, scopes, hash, status, code, at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      ).run(p.id, p.name, p.kind, scopesOf(p.scopes), p.hash, p.code, e.time)
    }),
    on(CredentialIssued, (db, p, e) => {
      // An extension's, issued again, is its next generation: a new token.
      db.query(
        `INSERT INTO credentials (id, name, kind, scopes, hash, status, at, until, generation)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, scopes = excluded.scopes,
           hash = excluded.hash, status = 'active', until = excluded.until,
           generation = credentials.generation + excluded.generation`,
      ).run(
        p.id,
        p.name,
        p.kind,
        scopesOf(p.scopes),
        p.hash === "" ? null : p.hash,
        e.time,
        p.until ?? null,
        p.kind === "extension" ? 1 : 0,
      )
      if (p.offer !== undefined) {
        db.query("UPDATE credential_offers SET used = 1 WHERE id = ?").run(p.offer)
      }
    }),
    on(CredentialApproved, (db, p) => {
      db.query(
        "UPDATE credentials SET status = 'active', code = NULL WHERE id = ? AND status = 'pending'",
      ).run(p.id)
    }),
    on(CredentialDenied, (db, p) => {
      db.query(
        "UPDATE credentials SET status = 'denied', code = NULL WHERE id = ? AND status = 'pending'",
      ).run(p.id)
    }),
    on(CredentialRevoked, (db, p, e) => {
      // An extension's has no row until it's revoked.
      const id = renamed(p.id)
      const extension = id.startsWith("extension:") ? id.slice("extension:".length) : null
      db.query(
        `INSERT INTO credentials (id, name, kind, scopes, status, at) VALUES (?, ?, 'extension', ?, 'revoked', ?)
         ON CONFLICT (id) DO UPDATE SET status = 'revoked', code = NULL`,
      ).run(id, extension ?? id, JSON.stringify(extension === null ? [] : [id]), e.time)
    }),
    on(CredentialOffered, (db, p) => {
      db.query(
        "INSERT OR IGNORE INTO credential_offers (id, hash, scopes, until) VALUES (?, ?, ?, ?)",
      ).run(p.id, p.hash, scopesOf(p.scopes), p.until)
    }),
  ],
  snapshot: () => null,
}

/** What clients list: everything but a lapsed or denied request. Never a hash. */
export const listed = (db: Database, now: number): Credential[] =>
  db
    .query<Row, [number]>(
      `SELECT id, name, kind, scopes, status, code, at, until FROM credentials
        WHERE status IN ('active', 'revoked') OR (status = 'pending' AND at > ?)
        ORDER BY at DESC`,
    )
    .all(now - PAIRING_MS)
    .map(toCredential)

export const byHash = (db: Database, hash: string) => {
  const row = db
    .query<Row, [string]>(
      "SELECT id, name, kind, scopes, status, code, at, until FROM credentials WHERE hash = ?",
    )
    .get(hash)
  return row ? toCredential(row) : null
}

export const byId = (db: Database, id: string) => {
  const row = db
    .query<Row, [string]>(
      "SELECT id, name, kind, scopes, status, code, at, until FROM credentials WHERE id = ?",
    )
    .get(id)
  return row ? toCredential(row) : null
}

export const offerByHash = (db: Database, hash: string) => {
  const row = db
    .query<{ id: string; scopes: string; until: number; used: number }, [string]>(
      "SELECT id, scopes, until, used FROM credential_offers WHERE hash = ?",
    )
    .get(hash)
  return row ? { ...row, scopes: parseScopes(row.scopes) } : null
}

/** Which generation an extension's token is in: 0 until it's first issued again. */
export const generationOf = (db: Database, name: string) =>
  db
    .query<{ generation: number }, [string]>("SELECT generation FROM credentials WHERE id = ?")
    .get(`extension:${name}`)?.generation ?? 0

/** Every extension's generation past the first, by name. */
export const generations = (db: Database) =>
  new Map(
    db
      .query<{ id: string; generation: number }, []>(
        "SELECT id, generation FROM credentials WHERE kind = 'extension' AND generation > 0",
      )
      .all()
      .map((r) => [r.id.slice("extension:".length), r.generation]),
  )

/** Whether a tailnet credential was ever made, live or revoked. */
export const tailnetMade = (db: Database) =>
  db.query("SELECT id FROM credentials WHERE kind = 'tailnet'").get() !== null

const pending = (db: Database, now: number) =>
  db
    .query<{ n: number }, [number]>(
      "SELECT count(*) AS n FROM credentials WHERE status = 'pending' AND at > ?",
    )
    .get(now - PAIRING_MS)?.n ?? 0

/** At most this many requests wait at once. */
const MAX_PENDING = 8

export const RequestCredential = defineCommand({
  type: "credential.request",
  payload: CredentialRequested.payload,
  load: (db) => pending(db, Date.now()),
  decide: (waiting, p) =>
    waiting >= MAX_PENDING
      ? { reject: "Too many pairings waiting" }
      : { events: [CredentialRequested.make(p)] },
})

const offerUsable = (db: Database, id: string) =>
  db
    .query("SELECT id FROM credential_offers WHERE id = ? AND used = 0 AND until > ?")
    .get(id, Date.now()) !== null

/** Issues one outright; one that redeems an offer only while the offer is good. */
export const IssueCredential = defineCommand({
  type: "credential.issue",
  payload: CredentialIssued.payload,
  load: (db, p) => p.offer === undefined || offerUsable(db, p.offer),
  decide: (usable, p) =>
    usable ? { events: [CredentialIssued.make(p)] } : { reject: "No such offer" },
})

const idOnly = Schema.Struct({ id: Schema.String })

export const ApproveCredential = defineCommand({
  type: "credential.approve",
  payload: idOnly,
  load: (db, p) => byId(db, p.id),
  decide: (c, p) =>
    c?.status === "pending"
      ? { events: [CredentialApproved.make(p)] }
      : { reject: "No such pairing" },
})

export const DenyCredential = defineCommand({
  type: "credential.deny",
  payload: idOnly,
  load: (db, p) => byId(db, p.id),
  decide: (c, p) =>
    c?.status === "pending"
      ? { events: [CredentialDenied.make(p)] }
      : { reject: "No such pairing" },
})

export const RevokeCredential = defineCommand({
  type: "credential.revoke",
  payload: idOnly,
  load: (db, p) => byId(db, p.id),
  decide: (c, p) => {
    if (c === null && !p.id.startsWith("extension:")) {
      return { reject: "No such credential" }
    }
    return { events: c?.status === "revoked" ? [] : [CredentialRevoked.make(p)] }
  },
})

export const OfferCredential = defineCommand({
  type: "credential.offer",
  payload: CredentialOffered.payload,
  load: () => null,
  decide: (_s, p) => ({ events: [CredentialOffered.make(p)] }),
})

export const credentialsConfig = {
  events: [
    CredentialRequested,
    CredentialIssued,
    CredentialApproved,
    CredentialDenied,
    CredentialRevoked,
    CredentialOffered,
  ],
  projections: [credentials],
  commands: [
    RequestCredential,
    IssueCredential,
    ApproveCredential,
    DenyCredential,
    RevokeCredential,
    OfferCredential,
  ],
}

// Tokens.

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

const random = (bytes: number) => {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return Buffer.from(b).toString("base64url")
}

export const newToken = () => `sw_${random(32)}`
export const newId = () => random(9)

/** A code a person reads off one screen and finds on another: `ABCD-EFGH`. */
export const newCode = () => {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  const chars = [...b].map((v) => ALPHABET[v % ALPHABET.length] ?? "2").join("")
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

export const hashOf = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex")

const KEY = /^[\w-]{43}$/u

/** The core's own secret, made once: extension tokens are derived from it. One that isn't whole is
 * an error, never a key: an empty one would let anyone make a token. */
const keyOf = (dir: string) => {
  const file = path.join(dir, "auth.key")
  if (!existsSync(file)) {
    createFileAtomic(file, random(32), { mode: 0o600 })
  }
  const key = readFileSync(file, "utf-8").trim()
  if (!KEY.test(key)) {
    throw new Error(`${file} is damaged`)
  }
  return key
}

const EXTENSION = /^sws_(?<name>[a-z0-9][a-z0-9-]{0,80})\.(?<sig>[\w-]{43})$/u

// The first generation signs the name alone, as every token did before generations; a name can't hold
// `@`, so no other name's signs the same.
const mac = (key: string, name: string, generation: number) =>
  new Bun.CryptoHasher("sha256", key)
    .update(generation === 0 ? `extension:${name}` : `extension:${name}@${generation}`)
    .digest("base64url")

/** The token an extension reaches the core with, the same every time it runs in a generation. */
export const extensionToken = (dir: string, name: string, generation: number) =>
  `sws_${name}.${mac(keyOf(dir), name, generation)}`

/** The extension a token is for, if it is one of this core's in its current generation. */
export const extensionOf = (dir: string, token: string, generation: (name: string) => number) => {
  const { name = "", sig = "" } = EXTENSION.exec(token)?.groups ?? {}
  if (name === "") {
    return null
  }
  const want = Buffer.from(mac(keyOf(dir), name, generation(name)))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got) ? name : null
}

const SCRIPT = /^sws-script_(?<id>[a-z0-9][a-z0-9-]{0,80})\.(?<sig>[\w-]{43})$/u

const scriptMac = (key: string, id: string) =>
  new Bun.CryptoHasher("sha256", key).update(`script:${id}`).digest("base64url")

/** The token a script reaches the core with (scripts.ts): it records the script's events, nothing else. */
export const scriptToken = (dir: string, id: string) =>
  `sws-script_${id}.${scriptMac(keyOf(dir), id)}`

/** The script a token is for, if it is one of this core's. */
export const scriptOf = (dir: string, token: string) => {
  const { id = "", sig = "" } = SCRIPT.exec(token)?.groups ?? {}
  if (id === "") {
    return null
  }
  const want = Buffer.from(scriptMac(keyOf(dir), id))
  const got = Buffer.from(sig)
  return want.length === got.length && timingSafeEqual(want, got) ? id : null
}
