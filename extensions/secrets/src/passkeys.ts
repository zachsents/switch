// WebAuthn, the part a relying party checks (W3C Web Authentication, §7.1 and §7.2): a passkey made
// on the user's phone or Mac (`create`) and its signature over a challenge (`get`), each answered
// through the page the core serves at the item's link. Only ES256 (Apple's passkeys) and RS256 keys;
// no attestation (Apple's give none), so trusting a new passkey is the caller's to decide.
import { b64 } from "./crypto.ts"

export interface Passkey {
  /** The credential's id, base64url. */
  readonly id: string
  /** Its public key, SubjectPublicKeyInfo DER, base64url. */
  readonly key: string
  /** COSE algorithm: -7 ES256, -257 RS256. */
  readonly alg: number
  /** The relying party it's for: the host the pages are served on. */
  readonly rp: string
  /** The authenticator's signature counter as last seen (0 for synced passkeys). */
  readonly count: number
  readonly created: number
}

/** What a page sends back from `navigator.credentials.create`. */
export interface Created {
  readonly type: "create"
  readonly id: string
  readonly clientData: string
  readonly authData: string
  readonly key: string
  readonly alg: number
}

/** What a page sends back from `navigator.credentials.get`. */
export interface Asserted {
  readonly type: "get"
  readonly id: string
  readonly clientData: string
  readonly authData: string
  readonly signature: string
}

export interface Expected {
  /** base64url, as issued. */
  readonly challenge: string
  readonly origin: string
  readonly rp: string
}

export const b64u = (bytes: Uint8Array): string =>
  b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/[=]+$/u, "")

export const unb64u = (text: string): Uint8Array<ArrayBuffer> => {
  const plain = text.replaceAll("-", "+").replaceAll("_", "/")
  return new Uint8Array(Buffer.from(plain, "base64"))
}

/** A new challenge: 32 random bytes, base64url. */
export const newChallenge = (): string => b64u(crypto.getRandomValues(new Uint8Array(32)))

const sha256 = async (bytes: Uint8Array<ArrayBuffer>) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i])

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_AT = 0x40

/** Whether a flag's bit is set in the authenticator data's flags byte. */
const has = (flags: number, bit: number) => Math.floor(flags / bit) % 2 === 1

/** The client data's checks: what it was for, the challenge issued, and the page it came from. */
const checkClient = (raw: Uint8Array<ArrayBuffer>, type: string, e: Expected) => {
  const data: unknown = JSON.parse(new TextDecoder().decode(raw))
  if (typeof data !== "object" || data === null) {
    throw new Error("The client data doesn't read")
  }
  const said = new Map(Object.entries(data))
  if (said.get("type") !== type) {
    throw new Error(`The client data is for ${String(said.get("type"))}, not ${type}`)
  }
  if (said.get("challenge") !== e.challenge) {
    throw new Error("It signed another challenge")
  }
  if (said.get("origin") !== e.origin) {
    throw new Error(`It came from ${String(said.get("origin"))}, not ${e.origin}`)
  }
}

/** The authenticator data's checks: the relying party, the user present and verified (Face ID, Touch ID). */
const checkAuth = async (auth: Uint8Array<ArrayBuffer>, e: Expected) => {
  if (auth.length < 37) {
    throw new Error("The authenticator data is short")
  }
  if (!same(auth.slice(0, 32), await sha256(new TextEncoder().encode(e.rp)))) {
    throw new Error(`It's a passkey for another site than ${e.rp}`)
  }
  const flags = auth[32] ?? 0
  if (!has(flags, FLAG_UP) || !has(flags, FLAG_UV)) {
    throw new Error("The user wasn't verified (Face ID, Touch ID or the passcode)")
  }
  return { flags, count: new DataView(auth.buffer, auth.byteOffset + 33, 4).getUint32(0) }
}

const importKey = async (alg: number, spki: Uint8Array<ArrayBuffer>) => {
  if (alg === -7) {
    return await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
  }
  if (alg === -257) {
    return await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
  }
  throw new Error(`A passkey with algorithm ${alg} isn't one this takes`)
}

/** An ECDSA signature as DER (what WebAuthn gives) to the raw r‖s WebCrypto checks. */
export const rawSignature = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
  const part = (at: number) => {
    if (der[at] !== 0x02) {
      throw new Error("The signature doesn't read")
    }
    const length = der[at + 1] ?? 0
    let bytes = der.slice(at + 2, at + 2 + length)
    while (bytes.length > 32 && bytes[0] === 0) {
      bytes = bytes.slice(1)
    }
    if (bytes.length > 32) {
      throw new Error("The signature doesn't read")
    }
    const out = new Uint8Array(32)
    out.set(bytes, 32 - bytes.length)
    return { out, next: at + 2 + length }
  }
  if (der[0] !== 0x30) {
    throw new Error("The signature doesn't read")
  }
  const r = part(2)
  const s = part(r.next)
  const raw = new Uint8Array(64)
  raw.set(r.out, 0)
  raw.set(s.out, 32)
  return raw
}

/** A new passkey, checked (§7.1, without attestation): what to keep of it. */
export const verifyCreate = async (c: Created, e: Expected): Promise<Passkey> => {
  checkClient(unb64u(c.clientData), "webauthn.create", e)
  const auth = unb64u(c.authData)
  const { flags, count } = await checkAuth(auth, e)
  if (!has(flags, FLAG_AT) || auth.length < 55) {
    throw new Error("It made no credential")
  }
  const length = new DataView(auth.buffer, auth.byteOffset + 53, 2).getUint16(0)
  const id = auth.slice(55, 55 + length)
  if (b64u(id) !== c.id) {
    throw new Error("The credential's id isn't the one it named")
  }
  await importKey(c.alg, unb64u(c.key))
  return { id: c.id, key: c.key, alg: c.alg, rp: e.rp, count, created: Date.now() }
}

/** A passkey's signature over the challenge, checked (§7.2): its counter now. */
export const verifyGet = async (a: Asserted, key: Passkey, e: Expected): Promise<number> => {
  if (a.id !== key.id) {
    throw new Error("It's signed by another passkey")
  }
  if (key.rp !== e.rp) {
    throw new Error(`That passkey is for ${key.rp}, not ${e.rp}`)
  }
  const client = unb64u(a.clientData)
  checkClient(client, "webauthn.get", e)
  const auth = unb64u(a.authData)
  const { count } = await checkAuth(auth, e)
  const signed = new Uint8Array(auth.length + 32)
  signed.set(auth, 0)
  signed.set(await sha256(client), auth.length)
  const pub = await importKey(key.alg, unb64u(key.key))
  const signature = unb64u(a.signature)
  const ok =
    key.alg === -7
      ? await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          pub,
          rawSignature(signature),
          signed,
        )
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, pub, signature, signed)
  if (!ok) {
    throw new Error("The signature isn't that passkey's")
  }
  if ((count !== 0 || key.count !== 0) && count <= key.count) {
    throw new Error("The passkey's counter went back: it may have been copied")
  }
  return count
}
