// The user's vault (the secrets extension), which keeps every password, key and card the browser
// fills. The browser keeps none: it has one key pair (its secret half in this Mac's Keychain),
// allowed once by the user, and the vault seals each secret to it for one fill (`release`); what
// the browser learns from a page it seals to the vault's key (`deposit`). Calls go through the
// core, as the user's clients make them.
import { seal, sealedKey, openSealed } from "switch-ext-kit"

import { isJson } from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { keychainRead, keychainWrite } from "./vault.ts"

const core = () => process.env.SWITCH_URL ?? "http://127.0.0.1:4871"

/** The vault isn't there: the browser's own saved passwords still sign in. */
export class VaultMissingError extends Error {
  override name = "VaultMissingError"
}

/** One of the vault's tools: its structured result, or its words as an error. */
const call = async (tool: string, args: Json): Promise<Json> => {
  let r: Response
  try {
    r = await fetch(`${core()}/widgets/secrets/${tool}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // The extension's own credential, when its host gives it one.
        ...(process.env.SWITCH_TOKEN !== undefined && {
          authorization: `Bearer ${process.env.SWITCH_TOKEN}`,
        }),
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new VaultMissingError("Can't reach the core for the vault")
  }
  const body: unknown = await r.json().catch(() => null)
  const result = isJson(body) ? body : {}
  const content = Array.isArray(result.content) ? result.content : []
  const first: unknown = content[0]
  const text = isJson(first) && typeof first.text === "string" ? first.text : ""
  if (result.isError === true) {
    if (text.startsWith("No app")) {
      throw new VaultMissingError("The vault (the secrets extension) isn't running")
    }
    throw new Error(text === "" ? `The vault's ${tool} failed` : text)
  }
  if (isJson(result.structuredContent)) {
    return result.structuredContent
  }
  throw new Error(`The vault's ${tool} said nothing`)
}

const SERVICE = "Switch browser"
const ACCOUNT = "secrets-key"

let mine: Promise<{ key: string; secretKey: string }> | null = null

const ownKey = async () => {
  const kept = await keychainRead(SERVICE, ACCOUNT).catch(() => null)
  if (isJson(kept) && typeof kept.key === "string" && typeof kept.secretKey === "string") {
    return { key: kept.key, secretKey: kept.secretKey }
  }
  const made = await sealedKey()
  await keychainWrite(SERVICE, ACCOUNT, made)
  return made
}

/** The browser's key, allowed by the vault; and the vault's key, for deposits. */
const allowed = async () => {
  mine ??= ownKey()
  const own = await mine.catch((error: unknown) => {
    mine = null
    throw error
  })
  const r = await call("extension_register", { extension: "browser", key: own.key })
  if (r.status !== "active") {
    throw new Error(
      `The vault hasn't allowed the browser yet: the user approves it (code ${String(r.code)}) in the Secrets app or the queue`,
    )
  }
  return { own, vault: String(r.key) }
}

/** Says the browser is here, so the user can allow it before it's needed. */
export const register = async () => {
  await allowed().catch(() => null)
}

/** An item's outline: its fields, concealed ones only by whether they're set. */
export interface Outline {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly title: string
  readonly fields: readonly {
    id: string
    label: string
    type: string
    value?: string
    set?: boolean
  }[]
  readonly urls: readonly string[]
  readonly updated: number
  readonly used?: number
}

const outlineOf = (v: unknown): Outline => {
  if (!isJson(v) || typeof v.name !== "string") {
    throw new Error("The vault's answer didn't read")
  }
  return {
    id: String(v.id),
    name: v.name,
    kind: String(v.kind),
    title: String(v.title),
    fields: Array.isArray(v.fields)
      ? v.fields.filter(isJson).map((f) => ({
          id: String(f.id),
          label: String(f.label),
          type: String(f.type),
          ...(typeof f.value === "string" && { value: f.value }),
          ...(typeof f.set === "boolean" && { set: f.set }),
        }))
      : [],
    urls: Array.isArray(v.urls) ? v.urls.map(String) : [],
    updated: Number(v.updated ?? 0),
    ...(typeof v.used === "number" && { used: v.used }),
  }
}

/** Whether an item holds a field: a plain one with a value, a concealed one that's set. */
export const holds = (o: Outline, id: string): boolean => {
  const f = o.fields.find((x) => x.id === id)
  return f !== undefined && (f.set === true || (f.value !== undefined && f.value !== ""))
}

export const plain = (o: Outline, id: string): string | undefined => {
  const value = o.fields.find((x) => x.id === id)?.value
  return value === undefined || value === "" ? undefined : value
}

export const list = async (args: Json): Promise<Outline[]> => {
  const r = await call("list", args)
  return Array.isArray(r.items) ? r.items.map(outlineOf) : []
}

/**
 * One item by id, name or title (as the vault's own get finds it), or null if it has none. Looked
 * up in the list, not by get: a name that isn't the vault's (a username for the browser's saved
 * passwords) is an answer here, not a failed call against the vault.
 */
export const item = async (name: string): Promise<Outline | null> => {
  const key = name.trim()
  const all = await list({})
  return (
    all.find((i) => i.id === key) ??
    all.find((i) => i.name === key.toLowerCase()) ??
    all.find((i) => i.title.toLowerCase() === key.toLowerCase()) ??
    null
  )
}

export const save = async (args: Json): Promise<Outline> => {
  const r = await call("save", args)
  return outlineOf(r.saved)
}

export const remove = async (name: string) => {
  await call("delete", { item: name })
}

/** Fields of an item (or the one a reference names) for one fill on the page at `url`. */
export const release = async (
  which: { readonly item: string } | { readonly ref: string },
  url: string,
  fields?: readonly string[],
): Promise<{
  values: Record<string, string>
  name: string
  title: string
  labels: Record<string, string>
}> => {
  const { own } = await allowed()
  const r = await call("release", {
    extension: "browser",
    ...which,
    url,
    use: "fill",
    ...(fields !== undefined && { fields: [...fields] }),
  })
  const opened = await openSealed(
    own.secretKey,
    `release:${String(r.id)}`,
    `browser:${String(r.item)}`,
    {
      enc: String(r.enc),
      ct: String(r.ct),
    },
  )
  const parsed: unknown = JSON.parse(opened)
  const values = isJson(parsed)
    ? Object.fromEntries(Object.entries(parsed).map(([k, x]) => [k, String(x)]))
    : {}
  const labels = isJson(r.labels)
    ? Object.fromEntries(Object.entries(r.labels).map(([k, x]) => [k, String(x)]))
    : {}
  return { values, name: String(r.name), title: String(r.title), labels }
}

/** A field of a draft, as the vault takes it. */
export interface DraftField {
  readonly id: string
  readonly label: string
  readonly type: string
  readonly value: string
}

/** Keeps an item (or changes the one `into` names) with what the browser learned, sealed to the vault. */
export const deposit = async (draft: {
  readonly kind: string
  readonly name?: string
  readonly title: string
  readonly fields: readonly DraftField[]
  readonly urls?: readonly { url: string }[]
  readonly into?: string
}): Promise<Outline> => {
  const { vault } = await allowed()
  const id = crypto.randomUUID()
  const sealed = await seal(vault, `deposit:${id}`, "browser", JSON.stringify(draft))
  const r = await call("deposit", { extension: "browser", id, ...sealed })
  return outlineOf(r.saved)
}
