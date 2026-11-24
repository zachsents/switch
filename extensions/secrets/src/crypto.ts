// The vault's cryptography, as README.md says it: the vault key's subkeys (HKDF-SHA256), items
// sealed with AES-256-GCM, proofs (HMAC-SHA256 under the approval key), and switch-ext-kit's HPKE
// for everything sealed to a key (a device, an extension, a sealed ask). WebCrypto only, so the Mac
// app's view and bun process use this file as it is.
import { openSealed, seal, sealedKey } from "switch-ext-kit"
import type { SealedAnswer } from "switch-ext-kit"

const subtle = (): SubtleCrypto => globalThis.crypto.subtle
const utf8 = new TextEncoder()

export const b64 = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte)
  }
  return btoa(binary)
}
export const unb64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.codePointAt(0) ?? 0)

/** NUL-joined words: what's bound into a seal or signed by a proof. */
export const statement = (...words: readonly string[]): string => words.join("\0")

/** A new vault key: 32 random bytes. */
export const newVaultKey = (): Uint8Array<ArrayBuffer> =>
  globalThis.crypto.getRandomValues(new Uint8Array(32))

const derive = async (vaultKey: Uint8Array<ArrayBuffer>, purpose: string) => {
  const base = await subtle().importKey("raw", vaultKey, "HKDF", false, ["deriveBits"])
  const bits = await subtle().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: utf8.encode(`switch-secrets-v1 ${purpose}`),
    },
    base,
    256,
  )
  return new Uint8Array(bits)
}

/** What the vault key opens: items, and proofs. */
export interface Keys {
  readonly vault: string
  readonly version: number
  readonly raw: Uint8Array<ArrayBuffer>
  readonly items: CryptoKey
  readonly approve: CryptoKey
}

export const keysOf = async (
  vault: string,
  version: number,
  raw: Uint8Array<ArrayBuffer>,
): Promise<Keys> => {
  const [items, approve] = await Promise.all([derive(raw, "items"), derive(raw, "approve")])
  return {
    vault,
    version,
    raw,
    items: await subtle().importKey("raw", items, "AES-GCM", false, ["encrypt", "decrypt"]),
    approve: await subtle().importKey("raw", approve, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]),
  }
}

const aad = (keys: Keys, id: string) =>
  utf8.encode(statement("switch-secrets-v1", keys.vault, id, String(keys.version)))

/** An item's JSON, sealed under the item key, bound to its id. */
export const sealItem = async (keys: Keys, id: string, json: string): Promise<string> => {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad(keys, id) },
    keys.items,
    utf8.encode(json),
  )
  const out = new Uint8Array(12 + ct.byteLength)
  out.set(nonce)
  out.set(new Uint8Array(ct), 12)
  return b64(out)
}

/** An item's JSON from its blob; throws if it isn't this item's under this key. */
export const openItem = async (keys: Keys, id: string, blob: string): Promise<string> => {
  const bytes = unb64(blob)
  const plain = await subtle().decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(keys, id) },
    keys.items,
    bytes.slice(12),
  )
  return new TextDecoder().decode(plain)
}

/** A proof over a statement, as an enrolled device makes it. */
export const prove = async (keys: Keys, words: string): Promise<string> =>
  b64(new Uint8Array(await subtle().sign("HMAC", keys.approve, utf8.encode(words))))

export const verify = async (keys: Keys, words: string, proof: string): Promise<boolean> =>
  await subtle().verify("HMAC", keys.approve, unb64(proof), utf8.encode(words))

/** A device's or extension's key pair: `key` is public, `secretKey` stays where it was made. */
export const newKeyPair: () => Promise<{ key: string; secretKey: string }> = sealedKey

export const sealTo = async (
  key: string,
  item: string,
  use: string,
  secret: string,
): Promise<SealedAnswer> => await seal(key, item, use, secret)

export const openFrom = async (
  secretKey: string,
  item: string,
  use: string,
  sealed: SealedAnswer,
): Promise<string> => await openSealed(secretKey, item, use, sealed)

/** The 6 digits a device or extension shows for its key, to match on the approving screen. */
export const codeOf = async (key: string): Promise<string> => {
  const hash = new Uint8Array(await subtle().digest("SHA-256", unb64(key)))
  const n = ((hash[0] ?? 0) * 65_536 + (hash[1] ?? 0) * 256 + (hash[2] ?? 0)) % 1_000_000
  return String(n).padStart(6, "0")
}
