// Imports, run once with a look first: an export file another password manager made (imports.ts
// reads it), or what lived in this Mac's Keychain before the vault: switch-ext-browser's stored accounts
// and kept secrets, and old Switchboard's macOS appendage's. `preview` says what it would add,
// nothing secret; `apply` with its token adds it.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { Schema } from "effect"

import { read, SOURCES } from "./imports.ts"
import type { Source } from "./imports.ts"
import { keychainRead } from "./keychain.ts"
import type { Draft, Field } from "./model.ts"
import { otpauth } from "./otp.ts"
import type { Vault } from "./store.ts"
import { hostOf } from "./use.ts"

export const ALL_SOURCES = [...SOURCES, "browser", "switchboard"] as const
export type AnySource = (typeof ALL_SOURCES)[number]

const home = homedir()
const where = {
  browser: {
    dir: path.join(process.env.SWITCH_DIR ?? path.join(home, ".switch"), "browser"),
    account: "Switch account",
    secret: "Switch secret",
  },
  switchboard: {
    dir: path.join(home, "Library/Application Support/Switchboard/macos"),
    account: "Switchboard account",
    secret: "Switchboard secret",
  },
}

const Account = Schema.Struct({
  username: Schema.optionalKey(Schema.String),
  sites: Schema.Array(Schema.String),
  password: Schema.Boolean,
  totp: Schema.Boolean,
})
const Kept = Schema.Struct({
  label: Schema.String,
  kind: Schema.String,
  sites: Schema.optionalKey(Schema.Array(Schema.String)),
})
const Totp = Schema.Struct({
  secret: Schema.String,
  digits: Schema.Finite,
  period: Schema.Finite,
  algorithm: Schema.String,
})
const AccountSecrets = Schema.Struct({
  password: Schema.optionalKey(Schema.String),
  previous: Schema.optionalKey(Schema.String),
  totp: Schema.optionalKey(Totp),
})
const Value = Schema.Struct({ value: Schema.String })

const index = <A>(file: string, schema: Schema.Codec<A>): Record<string, A> => {
  if (!existsSync(file)) {
    return {}
  }
  const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"))
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, schema))(parsed)
}

/** What a kept secret's part is in a card or an identity. */
const PARTS: Record<string, readonly [string, string, Field["type"]]> = {
  number: ["number", "Number", "card-number"],
  cvc: ["cvc", "Security code", "cvc"],
  month: ["month", "Expiry month", "month"],
  year: ["year", "Expiry year", "year"],
  expiry: ["expiry", "Expiry", "text"],
  name: ["holder", "Name on card", "text"],
}
const KIND_FIELD: Record<string, readonly [string, string, Field["type"]]> = {
  "card-number": ["number", "Number", "card-number"],
  "security-code": ["cvc", "Security code", "cvc"],
  month: ["month", "Expiry month", "month"],
  year: ["year", "Expiry year", "year"],
  expiry: ["expiry", "Expiry", "text"],
  ssn: ["ssn", "Social security number", "ssn"],
  digits: ["password", "Number", "concealed"],
  text: ["password", "Value", "concealed"],
}

/** An old store's accounts and secrets as drafts; an account's previous password comes first. */
const keychainDrafts = async (
  from: (typeof where)["browser"],
): Promise<{ drafts: Draft[]; previous: Draft[]; missing: number }> => {
  const drafts: Draft[] = []
  const previous: Draft[] = []
  let missing = 0
  for (const [name, a] of Object.entries(index(path.join(from.dir, "accounts.json"), Account))) {
    const raw = a.password || a.totp ? await keychainRead(from.account, name).catch(() => null) : {}
    const s = Schema.decodeUnknownOption(AccountSecrets)(raw)
    if (s._tag === "None") {
      missing += 1
      continue
    }
    const secrets = s.value
    const urls = a.sites.map((site) => ({ url: `https://${site}` }))
    const fields = (password: string | undefined): Field[] => [
      ...(a.username === undefined
        ? []
        : [{ id: "username", label: "Username", type: "text" as const, value: a.username }]),
      ...(password === undefined
        ? []
        : [{ id: "password", label: "Password", type: "password" as const, value: password }]),
      ...(secrets.totp === undefined
        ? []
        : [
            {
              id: "totp",
              label: "One-time code",
              type: "totp" as const,
              value: otpauth(secrets.totp),
            },
          ]),
    ]
    const title = a.sites[0] === undefined ? name : hostOf(a.sites[0])
    if (secrets.previous !== undefined) {
      previous.push({ kind: "login", name, title, urls, fields: fields(secrets.previous) })
    }
    drafts.push({ kind: "login", name, title, urls, fields: fields(secrets.password) })
  }
  const groups = new Map<
    string,
    { label: string; sites: string[]; fields: Field[]; card: boolean }
  >()
  for (const [name, k] of Object.entries(index(path.join(from.dir, "secrets.json"), Kept))) {
    const raw = await keychainRead(from.secret, name).catch(() => null)
    const value = Schema.decodeUnknownOption(Value)(raw)
    if (value._tag === "None") {
      missing += 1
      continue
    }
    const dot = name.lastIndexOf(".")
    const part = dot === -1 ? "" : name.slice(dot + 1)
    const card =
      ["card-number", "security-code", "month", "year", "expiry"].includes(k.kind) ||
      (PARTS[part] !== undefined && name.startsWith("card"))
    const group = card && dot !== -1 ? name.slice(0, dot) : name
    const [id, label, type] = (card ? PARTS[part] : undefined) ??
      KIND_FIELD[k.kind] ?? ["password", "Value", "concealed"]
    const g = groups.get(group) ?? {
      label: k.label.split(",")[0] ?? group,
      sites: [...(k.sites ?? [])],
      fields: [],
      card,
    }
    g.fields.push({ id, label, type, value: value.value.value })
    groups.set(group, g)
  }
  for (const [name, g] of groups) {
    const plain = g.fields.some((f) => f.type === "ssn") ? "identity" : "password"
    drafts.push({
      kind: g.card ? "card" : plain,
      name,
      title: g.label,
      fields: g.fields,
      urls: g.sites.map((site) => ({ url: `https://${site}` })),
    })
  }
  return { drafts, previous, missing }
}

/** Where an export usually lands when no path is given: the newest of its name in Downloads. */
const DEFAULT_FILES: Partial<Record<Source, RegExp>> = {
  chrome: /^(?:Chrome|Google) Passwords.*\.csv$/u,
  apple: /^Passwords.*\.csv$/u,
}

const newest = (pattern: RegExp) => {
  const downloads = path.join(home, "Downloads")
  if (!existsSync(downloads)) {
    return null
  }
  const found = readdirSync(downloads)
    .filter((f) => pattern.test(f))
    .map((f) => path.join(downloads, f))
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return found[0] ?? null
}

export interface Pending {
  readonly source: AnySource
  readonly file: string
  readonly drafts: readonly Draft[]
  readonly previous: readonly Draft[]
  readonly skipped: number
}

const pending = new Map<string, Pending>()

const loginKey = (host: string, username: string) => `${host}\0${username.toLowerCase()}`

/** What an import would add, and the token that adds it. */
export const preview = async (v: Vault, source: AnySource, given: string | undefined) => {
  let file = ""
  let drafts: Draft[]
  let previous: Draft[] = []
  let missing = 0
  if (source === "browser" || source === "switchboard") {
    const got = await keychainDrafts(where[source])
    ;({ drafts, previous, missing } = got)
    file = where[source].dir
  } else {
    const at =
      given === undefined
        ? newest(DEFAULT_FILES[source] ?? /^$/u)
        : given.replace(/^~(?=\/)/u, home)
    if (at === null || !existsSync(at)) {
      throw new Error(
        given === undefined
          ? `No ${source} export in ~/Downloads on the vault's Mac: export one there, or give its path`
          : `There's no file ${given} on the vault's Mac`,
      )
    }
    file = at
    drafts = read(source, readFileSync(at, "utf-8"))
  }
  const names = new Set([...v.items.values()].map((i) => i.name))
  const logins = new Set(
    [...v.items.values()].flatMap((i) =>
      i.urls.map((u) =>
        loginKey(hostOf(u.url), i.fields.find((f) => f.id === "username")?.value ?? ""),
      ),
    ),
  )
  const fresh = drafts.filter((d) => {
    if (d.name !== undefined && names.has(d.name)) {
      return false
    }
    const username = d.fields.find((f) => f.id === "username")?.value ?? ""
    return !(
      d.kind === "login" &&
      (d.urls ?? []).some((u) => logins.has(loginKey(hostOf(u.url), username)))
    )
  })
  const token = createHash("sha256")
    .update(`${source}\0${file}\0${existsSync(file) ? statSync(file).mtimeMs : 0}\0${fresh.length}`)
    .digest("hex")
    .slice(0, 12)
  pending.set(token, {
    source,
    file,
    drafts: fresh,
    previous: previous.filter((p) => fresh.some((d) => d.name === p.name)),
    skipped: drafts.length - fresh.length,
  })
  const counts: Record<string, number> = {}
  for (const d of fresh) {
    counts[d.kind] = (counts[d.kind] ?? 0) + 1
  }
  return {
    source,
    from: file,
    adds: counts,
    already: drafts.length - fresh.length,
    ...(missing > 0 && { unreadable: missing }),
    titles: fresh.slice(0, 40).map((d) => d.title),
    confirm: token,
  }
}

export const taken = (token: string): Pending => {
  const p = pending.get(token)
  if (!p) {
    throw new Error("That import's look has lapsed: run it again without confirm first")
  }
  pending.delete(token)
  return p
}
