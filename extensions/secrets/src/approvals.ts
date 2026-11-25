// Secrets that need the user's approval, each time. A locked item's value goes into nothing (a
// command, a request, a file, an extension's fill) until the user approves that one use with their
// passkey: an approval in their queue whose link opens a page on their phone or Mac, where Face ID
// or Touch ID signs a challenge this extension issued. It checks the signature against the passkey it
// keeps (passkeys.ts) before the value is used: the core, the agent and the page only carry it.
//
// An approval is for one request (its digest: what it runs or sends, with which secrets, from where)
// and is used once, within ONCE_MS of being given; or, when the user picks it, for every use of those
// items by the same caller from the same space for WINDOW_MS. Taking the lock off is approved the
// same way. The first passkey is made at the first approval, while the vault has none; after that,
// only a passkey it has signs.
import { Schema } from "effect"

import type { Item } from "./model.ts"
import { b64u, newChallenge, verifyCreate, verifyGet } from "./passkeys.ts"
import type { Passkey } from "./passkeys.ts"
import * as store from "./store.ts"
import type { Vault } from "./store.ts"

/** How long an approval for one use waits to be used. */
export const ONCE_MS = 15 * 60_000
/** How long "Approve 15 min" lasts. */
export const WINDOW_MS = 15 * 60_000
/** How long a challenge on the page stands. */
const CHALLENGE_MS = 10 * 60_000
/** How long a request waiting for its approval is the same one asked again. */
const PENDING_MS = 30 * 60_000
const POLL_MS = 500

/** What waiting for an approval needs of the extension's host: its asks, and saying how it goes. */
export interface Gate {
  readonly open: (ask: { title: string; body: string; space: string }) => Promise<string>
  readonly close: (id: string, status: "done" | "dismissed") => Promise<void>
  readonly progress: (message: string) => Promise<void>
  /** How long a call waits for the user before it answers that it's still waiting. */
  readonly waitMs: number
}

export interface Request {
  /** The locked items it uses. */
  readonly items: readonly Item[]
  readonly who: string
  readonly space: string
  /** What exactly it is: the same request asked again has the same digest. */
  readonly digest: string
  readonly what: "use" | "unlock"
  readonly title: string
  readonly body: string
}

interface Row {
  id: string
  digest: string
  items: string
  who: string
  space: string
  what: string
  status: string
  challenge: string
  issued: number
  created: number
  approved: number
  until: number
}

// Locks.

export const lockedIds = (v: Pick<Vault, "db">): Set<string> =>
  new Set(
    v.db
      .query<{ item: string }, []>("select item from locks")
      .all()
      .map((r) => r.item),
  )

export const isLocked = (v: Pick<Vault, "db">, item: string): boolean =>
  v.db.query("select 1 from locks where item = ?").get(item) !== null

export const lock = (v: Pick<Vault, "db">, item: string, who: string) => {
  v.db.run("insert or ignore into locks (item, since, who) values (?, ?, ?)", [
    item,
    Date.now(),
    who,
  ])
}

export const unlock = (v: Pick<Vault, "db">, item: string) => {
  v.db.run("delete from locks where item = ?", [item])
}

// Passkeys.

export const passkeys = (v: Pick<Vault, "db">, rp: string): Passkey[] =>
  v.db
    .query<Passkey, [string]>(
      "select id, key, alg, rp, count, created from passkeys where rp = ? order by created",
    )
    .all(rp)

const keepPasskey = (v: Pick<Vault, "db">, p: Passkey) => {
  v.db.run(
    "insert or replace into passkeys (id, key, alg, rp, count, created) values (?, ?, ?, ?, ?, ?)",
    [p.id, p.key, p.alg, p.rp, p.count, p.created],
  )
}

// Approvals.

const row = (v: Pick<Vault, "db">, id: string) =>
  v.db.query<Row, [string]>("select * from approvals where id = ?").get(id)

const setStatus = (v: Pick<Vault, "db">, id: string, status: string) => {
  v.db.run("update approvals set status = ? where id = ?", [status, id])
}

/** Whether an approval this extension raised is the item `id`. */
export const isApproval = (v: Pick<Vault, "db">, id: string): boolean => row(v, id) !== null

/** The user waved it off: whatever waits on it stops. */
export const dismissed = (v: Pick<Vault, "db">, id: string) => {
  v.db.run("update approvals set status = 'declined' where id = ? and status = 'pending'", [id])
}

/** An approval given for a window that covers these items, for this caller and space. */
const windowFor = (v: Pick<Vault, "db">, r: Request, now: number) =>
  v.db
    .query<Row, [string, string, number]>(
      "select * from approvals where status = 'approved' and what = 'use' and who = ? and space = ? and until > ?",
    )
    .all(r.who, r.space, now)
    .find((w) => {
      const covered = new Set(w.items.split(","))
      return r.items.every((i) => covered.has(i.id))
    })

const givenFor = (v: Pick<Vault, "db">, r: Request, now: number) =>
  v.db
    .query<Row, [string, string, string, number]>(
      "select * from approvals where digest = ? and who = ? and space = ? and status = 'approved' and until = 0 and approved > ? order by approved limit 1",
    )
    .get(r.digest, r.who, r.space, now - ONCE_MS)

const pendingFor = (v: Pick<Vault, "db">, r: Request, now: number) =>
  v.db
    .query<Row, [string, string, string, number]>(
      "select * from approvals where digest = ? and who = ? and space = ? and status = 'pending' and created > ? order by created desc limit 1",
    )
    .get(r.digest, r.who, r.space, now - PENDING_MS)

const note = (v: Vault, r: Request, id: string, ok: boolean, reason: string) => {
  for (const item of r.items) {
    store.record(v, {
      item: item.id,
      name: item.name,
      field: "",
      use: "approve",
      who: r.who,
      space: r.space,
      why: r.what,
      target: id,
      ok,
      reason,
    })
  }
}

/** Not approved (yet): what the caller is told. */
export class WaitingError extends Error {
  readonly item: string
  constructor(item: string, message: string) {
    super(message)
    this.name = "WaitingError"
    this.item = item
  }
}

/**
 * Resolves once the user has approved this request with their passkey: at once when an approval
 * stands for it, else after asking them, for up to `gate.waitMs`. Throws `WaitingError` (the item to
 * wait on) when they haven't by then, and an error when they declined.
 */
export const approved = async (v: Vault, gate: Gate, r: Request): Promise<void> => {
  const now = Date.now()
  if (r.what === "use" && windowFor(v, r, now)) {
    return
  }
  const given = givenFor(v, r, now)
  if (given) {
    setStatus(v, given.id, "used")
    return
  }
  let id = pendingFor(v, r, now)?.id
  if (id === undefined) {
    id = await gate.open({ title: r.title, body: r.body, space: r.space })
    v.db.run(
      "insert or replace into approvals (id, digest, items, who, space, what, status, created) values (?, ?, ?, ?, ?, ?, 'pending', ?)",
      [id, r.digest, r.items.map((i) => i.id).join(","), r.who, r.space, r.what, now],
    )
  }
  await gate.progress("Waiting for the user's passkey")
  const deadline = Date.now() + gate.waitMs
  for (;;) {
    const at = row(v, id)
    if (at?.status === "approved") {
      if (at.until === 0) {
        setStatus(v, id, "used")
      }
      return
    }
    if (at?.status === "declined" || !at) {
      throw new Error(`The user didn't approve it (item ${id})`)
    }
    if (Date.now() >= deadline) {
      throw new WaitingError(
        id,
        `Waiting for the user to approve it with their passkey (item ${id}). It stays approved for ${ONCE_MS / 60_000} minutes once they do: make the same call again then.`,
      )
    }
    await Bun.sleep(POLL_MS)
  }
}

// The page's two steps, through the core.

export const Credential = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("create"),
    id: Schema.String,
    clientData: Schema.String,
    authData: Schema.String,
    key: Schema.String,
    alg: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("get"),
    id: Schema.String,
    clientData: Schema.String,
    authData: Schema.String,
    signature: Schema.String,
  }),
])
const decodeCredential = Schema.decodeUnknownOption(Credential)

const waitingRow = (v: Pick<Vault, "db">, id: string) => {
  const r = row(v, id)
  if (r?.status !== "pending") {
    throw new Error("It's no longer waiting")
  }
  return r
}

/** The WebAuthn options for the page: sign with a passkey the vault has, or make the first one. */
export const options = (v: Vault, id: string, rp: string) => {
  const r = waitingRow(v, id)
  const challenge = newChallenge()
  v.db.run("update approvals set challenge = ?, issued = ? where id = ?", [
    challenge,
    Date.now(),
    id,
  ])
  const keys = passkeys(v, rp)
  const window = r.what === "use"
  if (keys.length > 0) {
    return { mode: "get" as const, challenge, rp, allow: keys.map((k) => k.id), window }
  }
  return {
    mode: "create" as const,
    challenge,
    rp,
    rpName: "Switch",
    user: { id: b64u(new TextEncoder().encode(v.keys.vault)), name: "Switch vault" },
    window,
  }
}

/**
 * The authenticator's answer, checked against the challenge issued (used once, whatever comes of
 * it) and the vault's passkey; a first passkey is kept only while the vault has none.
 */
export const verify = async (
  v: Vault,
  id: string,
  credential: unknown,
  window: boolean,
  origin: string,
  rp: string,
): Promise<{ ok: boolean; said?: string }> => {
  const r = waitingRow(v, id)
  v.db.run("update approvals set challenge = '' where id = ?", [id])
  const request: Request = {
    items: r.items.split(",").flatMap((i) => [...v.items.values()].filter((item) => item.id === i)),
    who: r.who,
    space: r.space,
    digest: r.digest,
    what: r.what === "unlock" ? "unlock" : "use",
    title: "",
    body: "",
  }
  const refuse = (said: string) => {
    note(v, request, id, false, said)
    return { ok: false, said }
  }
  if (r.challenge === "" || Date.now() - r.issued > CHALLENGE_MS) {
    return refuse("The page is out of date: open it again")
  }
  const given = decodeCredential(credential)
  if (given._tag === "None") {
    return refuse("Not a passkey's answer")
  }
  const expected = { challenge: r.challenge, origin, rp }
  const keys = passkeys(v, rp)
  try {
    if (given.value.type === "create") {
      if (keys.length > 0) {
        return refuse("The vault has a passkey already: sign with it")
      }
      keepPasskey(v, await verifyCreate(given.value, expected))
    } else {
      const { id: credentialId } = given.value
      const key = keys.find((k) => k.id === credentialId)
      if (!key) {
        return refuse("That passkey isn't the vault's")
      }
      const count = await verifyGet(given.value, key, expected)
      keepPasskey(v, { ...key, count })
    }
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error))
  }
  const now = Date.now()
  v.db.run("update approvals set status = 'approved', approved = ?, until = ? where id = ?", [
    now,
    window && r.what === "use" ? now + WINDOW_MS : 0,
    id,
  ])
  note(v, request, id, true, "")
  return { ok: true }
}
