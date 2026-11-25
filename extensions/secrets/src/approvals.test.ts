// A locked item's value goes into nothing until a passkey the vault keeps signs that use's challenge:
// an authenticator simulated with WebCrypto, against the vault in a folder of its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { lock, options, verify, WaitingError } from "./approvals.ts"
import type { Gate } from "./approvals.ts"
import { keysOf, newKeyPair, newVaultKey } from "./crypto.ts"
import { ItemId } from "./model.ts"
import type { Item } from "./model.ts"
import { run, unlockItem } from "./ops.ts"
import { b64u, unb64u, verifyGet } from "./passkeys.ts"
import { openDb, seedGrants, writeItem } from "./store.ts"
import type { Vault } from "./store.ts"

const RP = "vault.example.ts.net"
const ORIGIN = `https://${RP}`
const SECRET = "prod-deploy-key-5f2c9a1e"

/** A passkey on a phone: a P-256 key pair and the id it goes by. */
const authenticator = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  return { pair, spki, id: b64u(crypto.getRandomValues(new Uint8Array(16))) }
}
type Authenticator = Awaited<ReturnType<typeof authenticator>>

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

const clientData = (type: string, challenge: string, origin = ORIGIN) =>
  new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

const authData = async (flags: number, count: number, rp = RP, more = new Uint8Array(0)) => {
  const out = new Uint8Array(37 + more.length)
  out.set(await sha256(new TextEncoder().encode(rp)), 0)
  out[32] = flags
  new DataView(out.buffer).setUint32(33, count)
  out.set(more, 37)
  return out
}

/** A DER INTEGER's bytes: no leading zeros, but one before a high bit. */
const int = (b: Uint8Array) => {
  let x = b
  while (x.length > 1 && x[0] === 0 && (x[1] ?? 0) < 0x80) {
    x = x.slice(1)
  }
  return (x[0] ?? 0) >= 0x80 ? Uint8Array.from([0, ...x]) : x
}

/** Raw r‖s to DER, as an authenticator signs. */
const der = (raw: Uint8Array) => {
  const r = int(raw.slice(0, 32))
  const s = int(raw.slice(32))
  return Uint8Array.from([0x30, r.length + s.length + 4, 2, r.length, ...r, 2, s.length, ...s])
}

const created = async (a: Authenticator, challenge: string) => {
  const id = unb64u(a.id)
  const attested = new Uint8Array(18 + id.length)
  new DataView(attested.buffer).setUint16(16, id.length)
  attested.set(id, 18)
  return {
    type: "create" as const,
    id: a.id,
    clientData: b64u(clientData("webauthn.create", challenge)),
    authData: b64u(await authData(0x45, 0, RP, attested)),
    key: b64u(a.spki),
    alg: -7,
  }
}

const asserted = async (
  a: Authenticator,
  challenge: string,
  o: { id?: string; origin?: string; rp?: string; flags?: number } = {},
) => {
  const client = clientData("webauthn.get", challenge, o.origin)
  const auth = await authData(o.flags ?? 0x05, 0, o.rp)
  const signed = new Uint8Array(auth.length + 32)
  signed.set(auth, 0)
  signed.set(await sha256(client), auth.length)
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, a.pair.privateKey, signed),
  )
  return {
    type: "get" as const,
    id: o.id ?? a.id,
    clientData: b64u(client),
    authData: b64u(auth),
    signature: b64u(der(raw)),
  }
}

let folder = ""
let v: Vault
const asked: string[] = []
const gate: Gate = {
  open: async () => {
    const id = `ask-${asked.length + 1}`
    asked.push(id)
    return await Promise.resolve(id)
  },
}

const deployKey: Item = {
  id: ItemId.make("item-deploy"),
  kind: "api-key",
  name: "deploy/prod",
  title: "Production deploy key",
  fields: [{ id: "credential", label: "Credential", type: "concealed", value: SECRET }],
  urls: [],
  notes: "",
  tags: [],
  folder: "",
  spaces: [],
  favorite: false,
  source: "user",
  created: 0,
  updated: 0,
  trashed: 0,
}

/** Uses the key in a command that only says whether it got it. */
const deploy = async () =>
  await run(
    v,
    {
      command: 'test "$KEY" = "$EXPECT" && echo got-it',
      env: { KEY: "deploy/prod", EXPECT: "deploy/prod" },
      why: "deploy",
    },
    gate,
  )

const waitingItem = async () => {
  try {
    await deploy()
  } catch (error) {
    expect(error).toBeInstanceOf(WaitingError)
    return error instanceof WaitingError ? error.item : ""
  }
  throw new Error("It ran without an approval")
}

const challengeOf = (o: ReturnType<typeof options>) => o.challenge

/** What the deploy said, once it ran. */
const deployed = async () => {
  const done = await deploy()
  return done.stdout.trim()
}

/** Whether the vault took this answer as approving the item. */
const approves = async (item: string, credential: unknown, window = false) => {
  const answer = await verify(v, item, credential, window, ORIGIN, RP)
  return answer.ok
}

beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), "secrets-test-"))
  const pair = await newKeyPair()
  v = {
    db: openDb(folder),
    keys: await keysOf("vault-test", 1, newVaultKey()),
    extensionKey: pair.key,
    extensionSecret: pair.secretKey,
    items: new Map(),
  }
  seedGrants(v)
  await writeItem(v, deployKey)
  v.items.set(deployKey.id, deployKey)
  lock(v, deployKey.id, "user")
})

afterAll(() => {
  v.db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe("a locked secret", () => {
  const phone = { a: null as Authenticator | null }

  test("isn't used before the user approves, and the first approval makes the vault's passkey", async () => {
    phone.a = await authenticator()
    const first = await waitingItem()
    const o = options(v, first, RP)
    expect(o.mode).toBe("create")
    expect(
      await verify(v, first, await created(phone.a, challengeOf(o)), false, ORIGIN, RP),
    ).toEqual({
      ok: true,
    })
    const done = await deploy()
    expect(done.stdout.trim()).toBe("got-it")
    expect(done.stdout).not.toContain(SECRET)
  })

  test("can't be read without a valid assertion from that passkey", async () => {
    const { a } = phone
    if (!a) {
      throw new Error("No passkey")
    }
    // One approval was one use.
    const item = await waitingItem()
    const thief = await authenticator()

    const tries = [
      // Another key claiming the vault's passkey's id.
      async (c: string) => await asserted(thief, c, { id: a.id }),
      // A second passkey made now that the vault has one.
      async (c: string) => await created(thief, c),
      // The real passkey, but for another challenge (a replay).
      async () => await asserted(a, b64u(new Uint8Array(32))),
      // From another page, for another site, or without Face ID.
      async (c: string) => await asserted(a, c, { origin: "https://evil.example" }),
      async (c: string) => await asserted(a, c, { rp: "evil.example" }),
      async (c: string) => await asserted(a, c, { flags: 0x01 }),
    ]
    for (const make of tries) {
      const o = options(v, item, RP)
      expect(o.mode).toBe("get")
      const answer = await verify(v, item, await make(challengeOf(o)), false, ORIGIN, RP)
      expect(answer.ok).toBe(false)
      // Each try spends its challenge.
      expect(await approves(item, await asserted(a, challengeOf(o)))).toBe(false)
      expect(await waitingItem()).toBe(item)
    }

    const o = options(v, item, RP)
    expect(await approves(item, await asserted(a, challengeOf(o)))).toBe(true)
    expect(await deployed()).toBe("got-it")
    expect(asked).toHaveLength(2)
  })

  test("approved for a window, is used again within it", async () => {
    const { a } = phone
    if (!a) {
      throw new Error("No passkey")
    }
    const item = await waitingItem()
    const o = options(v, item, RP)
    expect(await approves(item, await asserted(a, challengeOf(o)), true)).toBe(true)
    expect(await deployed()).toBe("got-it")
    expect(await deployed()).toBe("got-it")
  })

  test("keeps its lock until taking it off is approved", async () => {
    const { a } = phone
    if (!a) {
      throw new Error("No passkey")
    }
    const failed = await unlockItem(v, "deploy/prod", gate, "agent", "").catch(
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(WaitingError)
    const item = failed instanceof WaitingError ? failed.item : ""
    const o = options(v, item, RP)
    expect(o.window).toBe(false)
    expect(await approves(item, await asserted(a, challengeOf(o)))).toBe(true)
    await unlockItem(v, "deploy/prod", gate, "agent", "")
    expect(await deployed()).toBe("got-it")
  })
})

test("a signature over other data isn't the passkey's", async () => {
  const a = await authenticator()
  const key = { id: a.id, key: b64u(a.spki), alg: -7, rp: RP, count: 0, created: 0 }
  const good = await asserted(a, "challenge-1")
  expect(await verifyGet(good, key, { challenge: "challenge-1", origin: ORIGIN, rp: RP })).toBe(0)
  const other = await asserted(a, "challenge-2")
  const spliced = { ...good, signature: other.signature }
  const refused = await verifyGet(spliced, key, {
    challenge: "challenge-1",
    origin: ORIGIN,
    rp: RP,
  }).catch((error: unknown) => error)
  expect(String(refused)).toContain("isn't that passkey's")
})
