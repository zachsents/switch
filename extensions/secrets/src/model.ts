// What the vault holds: items of a kind, each a title, a name the agent refers to it by, and
// fields. An item is sealed whole (crypto.ts); what's said of one outside the vault is its outline,
// which leaves out every concealed value. Shared with the apps (app/view, ios/ mirrors it).
import { Schema } from "effect"

export const KINDS = [
  "login",
  "password",
  "api-key",
  "card",
  "note",
  "ssh-key",
  "identity",
  "file",
] as const
export type Kind = (typeof KINDS)[number]

export const FIELD_TYPES = [
  "text",
  "email",
  "url",
  "phone",
  "date",
  "month",
  "year",
  "password",
  "concealed",
  "totp",
  "card-number",
  "cvc",
  "pin",
  "ssn",
  "private-key",
] as const
export type FieldType = (typeof FIELD_TYPES)[number]

/** Field types whose values never leave the vault but sealed. */
export const CONCEALED: ReadonlySet<FieldType> = new Set([
  "password",
  "concealed",
  "totp",
  "card-number",
  "cvc",
  "pin",
  "ssn",
  "private-key",
])

export const ItemId = Schema.String.pipe(Schema.brand("ItemId"))
export type ItemId = typeof ItemId.Type

export const Field = Schema.Struct({
  /** Stable within its item: `password`, `number`, or a custom field's own. */
  id: Schema.String,
  label: Schema.String,
  type: Schema.Literals(FIELD_TYPES),
  value: Schema.String,
})
export type Field = typeof Field.Type

/** Where a login is filled and an API key may be sent. */
export const Url = Schema.Struct({
  url: Schema.String,
  /** `domain`: the site and its subdomains (the default); `host`: that host only; `exact`: that page. */
  match: Schema.optionalKey(Schema.Literals(["domain", "host", "exact"])),
})
export type Url = typeof Url.Type

export const Item = Schema.Struct({
  id: ItemId,
  kind: Schema.Literals(KINDS),
  /** How the agent refers to it: lowercase, unique in the vault. */
  name: Schema.String,
  title: Schema.String,
  fields: Schema.Array(Field),
  urls: Schema.Array(Url),
  notes: Schema.String,
  tags: Schema.Array(Schema.String),
  /** One folder, its levels joined by "/". Empty: none. */
  folder: Schema.String,
  /** Switch spaces it belongs to; none: every space. */
  spaces: Schema.Array(Schema.String),
  favorite: Schema.Boolean,
  /** Where it came from: "user", "agent", "ask", "import:chrome", "extension:browser". */
  source: Schema.String,
  /** ms since 1970. */
  created: Schema.Finite,
  updated: Schema.Finite,
  /** Trashed at, or 0. */
  trashed: Schema.Finite,
})
export type Item = typeof Item.Type

/** An item as an extension deposits it or an import reads it: the vault fills in the rest. */
export const Draft = Schema.Struct({
  kind: Schema.Literals(KINDS),
  name: Schema.optionalKey(Schema.String),
  title: Schema.String,
  fields: Schema.Array(Field),
  urls: Schema.optionalKey(Schema.Array(Url)),
  notes: Schema.optionalKey(Schema.String),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  folder: Schema.optionalKey(Schema.String),
  /** An item it changes, rather than one it adds. */
  into: Schema.optionalKey(Schema.String),
})
export type Draft = typeof Draft.Type

/** The fields each kind starts with, and the one a bare reference means (first). */
export const TEMPLATES: Record<Kind, readonly (readonly [string, string, FieldType])[]> = {
  login: [
    ["password", "Password", "password"],
    ["username", "Username", "text"],
    ["totp", "One-time code", "totp"],
  ],
  password: [["password", "Password", "password"]],
  "api-key": [
    ["credential", "Credential", "concealed"],
    ["username", "Username", "text"],
  ],
  card: [
    ["number", "Number", "card-number"],
    ["holder", "Name on card", "text"],
    ["cvc", "Security code", "cvc"],
    ["month", "Expiry month", "month"],
    ["year", "Expiry year", "year"],
    ["expiry", "Expiry", "text"],
    ["pin", "PIN", "pin"],
  ],
  note: [],
  "ssh-key": [
    ["private_key", "Private key", "private-key"],
    ["public_key", "Public key", "text"],
    ["passphrase", "Passphrase", "password"],
  ],
  identity: [
    ["name", "Name", "text"],
    ["email", "Email", "email"],
    ["phone", "Phone", "phone"],
    ["address", "Address", "text"],
    ["ssn", "Social security number", "ssn"],
    ["passport", "Passport", "concealed"],
    ["license", "Driver's license", "concealed"],
  ],
  file: [],
}

/** The field a bare reference to an item means: its kind's main secret, else its first concealed one. */
export const mainField = (item: Item): Field | undefined => {
  const first = TEMPLATES[item.kind][0]?.[0]
  return (
    item.fields.find((f) => f.id === first && f.value !== "") ??
    item.fields.find((f) => CONCEALED.has(f.type) && f.value !== "")
  )
}

const NAME = /^[a-z0-9](?:[a-z0-9._/@-]{0,62}[a-z0-9])?$/u

/** Whether `name` is one an item can have: lowercase letters, digits and . _ / @ -, at most 64. */
export const isName = (name: string): boolean =>
  NAME.test(name) && !name.includes("..") && !name.includes("//")

/** A name made from a title: "GitHub (work)" is github-work. */
export const slug = (title: string): string =>
  title
    .toLowerCase()
    .normalize("NFKD")
    .replaceAll(/[^a-z0-9._/@-]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^[-./_@]+|[-./_@]+$/gu, "")
    .slice(0, 64) || "item"

/** What's said of an item outside the vault: every field, concealed ones by label and type only. */
export const outline = (item: Item) => ({
  id: item.id,
  name: item.name,
  kind: item.kind,
  title: item.title,
  fields: item.fields.map((f) =>
    CONCEALED.has(f.type)
      ? { id: f.id, label: f.label, type: f.type, set: f.value !== "" }
      : { id: f.id, label: f.label, type: f.type, value: f.value },
  ),
  urls: item.urls.map((u) => u.url),
  tags: item.tags,
  folder: item.folder,
  spaces: item.spaces,
  favorite: item.favorite,
  source: item.source,
  created: item.created,
  updated: item.updated,
  ...(item.trashed > 0 && { trashed: item.trashed }),
  ...(item.notes !== "" && { notes: true }),
})
