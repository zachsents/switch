// Using a secret: finding what a reference names, whether the grants let this caller use it this
// way, whether a page or a host is one the item allows, filling templates, and redacting every vault
// value from whatever comes back.
import { CONCEALED, mainField } from "./model.ts"
import type { Field, Item, Url } from "./model.ts"
import { codeNow } from "./otp.ts"
import type { Grant, Vault } from "./store.ts"

/** Who's using it: the agent (from a space), or an extension. */
export interface Caller {
  readonly who: string
  readonly space: string
}

export const USES = ["fill", "env", "file", "http"] as const
export type UseKind = (typeof USES)[number]

/** The item an id or name names, or an error naming some that are close. */
export const find = (v: Vault, given: string): Item => {
  const key = given.trim()
  const live = [...v.items.values()].filter((i) => i.trashed === 0)
  const found =
    live.find((i) => i.id === key) ??
    live.find((i) => i.name === key.toLowerCase()) ??
    live.find((i) => i.title.toLowerCase() === key.toLowerCase())
  if (found) {
    return found
  }
  const close = live
    .filter((i) => i.name.includes(key.toLowerCase()) || key.toLowerCase().includes(i.name))
    .slice(0, 5)
    .map((i) => i.name)
  throw new Error(
    `The vault has no item ${JSON.stringify(key)}${close.length > 0 ? `; there's ${close.join(", ")}` : ""}`,
  )
}

/** What switch-ext-browser called a card's parts before the vault. */
const ALIASES: Record<string, string> = { name: "holder", "security-code": "cvc" }

/** What a reference names: `name` (its main secret) or `name.field`, the longest name that fits. */
export const resolve = (v: Vault, ref: string): { item: Item; field: Field } => {
  const r = ref.trim()
  const live = [...v.items.values()].filter((i) => i.trashed === 0)
  const byName = live
    .filter(
      (i) => r === i.name || r === i.id || r.startsWith(`${i.name}.`) || r.startsWith(`${i.id}.`),
    )
    .toSorted((a, b) => b.name.length - a.name.length)
  const [item] = byName
  if (item) {
    const rest =
      r === item.name || r === item.id
        ? ""
        : r.slice((r.startsWith(item.id) ? item.id : item.name).length + 1)
    if (rest === "") {
      const field = mainField(item)
      if (field) {
        return { item, field }
      }
      throw new Error(`${item.name} holds no secret yet`)
    }
    const id = ALIASES[rest] ?? rest
    const field = item.fields.find(
      (f) => f.id === id || f.label.toLowerCase() === rest.toLowerCase(),
    )
    if (field && field.value !== "") {
      return { item, field }
    }
    if (field) {
      throw new Error(`${item.name}'s ${field.label} is empty`)
    }
    if (rest === "notes" && item.notes !== "") {
      return { item, field: { id: "notes", label: "Notes", type: "concealed", value: item.notes } }
    }
    throw new Error(
      `${item.name} has no field ${JSON.stringify(rest)}; it has ${item.fields.map((f) => f.id).join(", ")}`,
    )
  }
  find(v, r.split(".")[0] ?? r)
  throw new Error(`Nothing in the vault is ${JSON.stringify(r)}`)
}

/** A field's value as it's used: an authenticator key gives its code now. */
export const valueOf = async (field: Field): Promise<string> =>
  field.type === "totp" ? await codeNow(field.value) : field.value

const matchesScope = (scope: string, item: Item) => {
  if (scope === "all") {
    return true
  }
  const [kind = "", ...rest] = scope.split(":")
  const value = rest.join(":")
  if (kind === "item") {
    return item.id === value || item.name === value
  }
  if (kind === "tag") {
    return item.tags.includes(value)
  }
  if (kind === "folder") {
    return item.folder === value || item.folder.startsWith(`${value}/`)
  }
  return kind === "kind" && item.kind === value
}

const matchesSubject = (subject: string, caller: Caller) =>
  subject === caller.who ||
  (subject === "agent" && caller.who === "agent") ||
  (subject.startsWith("space:") && caller.who === "agent" && subject.slice(6) === caller.space)

/** Why this caller may not use the item this way, or null if it may. */
export const refusal = (
  grants: readonly Grant[],
  item: Item,
  caller: Caller,
  use: UseKind,
): string | null => {
  if (caller.who === "agent" && item.spaces.length > 0 && !item.spaces.includes(caller.space)) {
    return `${item.name} belongs to other spaces than ${caller.space === "" ? "this one" : caller.space}`
  }
  const allowed = grants.some(
    (g) => g.uses.includes(use) && matchesSubject(g.subject, caller) && matchesScope(g.scope, item),
  )
  return allowed ? null : `No grant lets ${caller.who} use ${item.name} for ${use}`
}

/** The host of a URL, lowercase, without its port. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.toLowerCase()
  } catch {
    return ""
  }
}

const bare = (host: string) => host.replace(/^www\./u, "")

/** Whether the page or request at `url` is one of the item's. */
export const urlAllowed = (urls: readonly Url[], url: string): boolean => {
  const host = hostOf(url)
  return urls.some((u) => {
    const at = hostOf(u.url)
    if (at === "" || host === "") {
      return false
    }
    if (u.match === "exact") {
      return url === u.url || url.startsWith(u.url)
    }
    if (u.match === "host") {
      return host === at
    }
    return bare(host) === bare(at) || host.endsWith(`.${bare(at)}`)
  })
}

/** Whether a URL is a secure page (or this machine's own). */
export const secure = (url: string): boolean => {
  const host = hostOf(url)
  const local = host === "localhost" || host === "127.0.0.1"
  return url.startsWith("https://") || (local && url.startsWith("http://"))
}

const TEMPLATE = /\{\{\s*(?<ref>[^{}\s]+)\s*\}\}/gu

/** Every reference in some templates. */
export const refsIn = (texts: readonly string[]): string[] => [
  ...new Set(texts.flatMap((t) => [...t.matchAll(TEMPLATE)].map((m) => m.groups?.ref ?? ""))),
]

/** A template with its references' values in. */
export const fill = (text: string, values: ReadonlyMap<string, string>): string =>
  text.replaceAll(TEMPLATE, (_, ref: string) => values.get(ref) ?? "")

/** Secrets in formats with a recognizable shape, as switch-ext-browser masks them. */
const SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}/gu,
]

/** The forms a value takes in output: as it is, base64, URL-encoded, JSON-escaped. */
const forms = (value: string) => [
  ...new Set([
    value,
    Buffer.from(value).toString("base64"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]),
]

/**
 * What to hide in output: every concealed value in the vault long enough not to be ordinary text,
 * and every value this use put in, however short, each with what it's called.
 */
export const redactions = (v: Vault, used: ReadonlyMap<string, string>): [string, string][] => {
  const all: [string, string][] = [...v.items.values()].flatMap((i) =>
    [
      ...i.fields.filter((f) => CONCEALED.has(f.type) && f.type !== "totp" && f.value.length >= 6),
      ...(i.notes.length >= 12 ? [{ id: "notes", value: i.notes }] : []),
    ].map((f): [string, string] => [f.value, `${i.name}.${f.id}`]),
  )
  const these = [...used]
    .filter(([, value]) => value.length >= 3)
    .map(([ref, value]): [string, string] => [value, ref])
  return [...these, ...all]
    .flatMap(([value, ref]) => forms(value).map((f): [string, string] => [f, ref]))
    .filter(([f]) => f.length >= 3)
    .toSorted((a, b) => b[0].length - a[0].length)
}

/** `text` with every value it shows hidden. */
export const redact = (text: string, hide: readonly [string, string][]): string => {
  let out = text
  for (const [value, ref] of hide) {
    if (out.includes(value)) {
      out = out.replaceAll(value, `[secret ${ref}]`)
    }
  }
  for (const shape of SHAPES) {
    out = out.replaceAll(shape, "[secret]")
  }
  return out
}
