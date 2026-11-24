// What the extension's tools do with the vault: items made and changed (never a concealed value
// from the agent), secrets released sealed to an extension or put into a command, a file or a
// request, deposits from extensions, devices enrolled and synced, sealed asks raised and answered.
// Every write goes through `serial`, one at a time, and says the vault changed.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import { Schema } from "effect"

import { codeOf, openFrom, openItem, sealTo, statement, verify } from "./crypto.ts"
import {
  CONCEALED,
  Draft,
  FIELD_TYPES,
  Item as ItemSchema,
  ItemId,
  isName,
  KINDS,
  mainField,
  outline,
  slug,
  TEMPLATES,
} from "./model.ts"
import type { Field, Item, Kind, Url } from "./model.ts"
import * as store from "./store.ts"
import type { Vault } from "./store.ts"
import {
  fill,
  find,
  hostOf,
  redact,
  redactions,
  refsIn,
  refusal,
  resolve,
  secure,
  urlAllowed,
  valueOf,
} from "./use.ts"
import type { Caller, UseKind } from "./use.ts"
import { expiry, generate, normalize } from "./values.ts"
import type { Generate } from "./values.ts"

let queue: Promise<unknown> = Promise.resolve()

/** Runs `work` after every write before it has finished. */
export const serial = async <A>(work: () => Promise<A>): Promise<A> => {
  const next = queue.catch(() => null).then(work)
  queue = next.catch(() => null)
  return await next
}

const listeners: ((seq: number) => void)[] = []

/** Calls `f` with the vault's seq after each change. */
export const onChange = (f: (seq: number) => void) => {
  listeners.push(f)
}

const changed = (seq: number) => {
  for (const f of listeners) {
    f(seq)
  }
}

/** Says the vault changed, after a write made outside these. */
export const touched = (v: Vault) => {
  changed(store.seqOf(v))
}

const now = () => Date.now()

/** A name no other item has: `name`, else `name-2`, `name-3`. */
const uniqueName = (v: Vault, wanted: string, except?: string) => {
  const taken = new Set([...v.items.values()].filter((i) => i.id !== except).map((i) => i.name))
  const base = isName(wanted) ? wanted : slug(wanted)
  let name = base
  for (let n = 2; taken.has(name); n += 1) {
    name = `${base.slice(0, 60)}-${n}`
  }
  return name
}

const templateFields = (kind: Kind): Field[] =>
  TEMPLATES[kind].map(([id, label, type]) => ({ id, label, type, value: "" }))

/** A field's value normalized for its type; `strict` false keeps what can't be (an import's). */
const kept = (f: Field, strict: boolean): Field => {
  if (f.value === "") {
    return f
  }
  try {
    return { ...f, value: normalize(f.type, f.value) }
  } catch (error) {
    if (strict) {
      throw new Error(`${f.label}: ${error instanceof Error ? error.message : "it doesn't read"}`, {
        cause: error,
      })
    }
    return { ...f, type: CONCEALED.has(f.type) ? "concealed" : "text" }
  }
}

/** Fields with `more` in: each replacing the one with its id, the rest added. */
const merged = (fields: readonly Field[], more: readonly Field[]): Field[] => {
  const out = [...fields]
  for (const f of more) {
    const at = out.findIndex((x) => x.id === f.id)
    if (at === -1) {
      out.push(f)
    } else {
      out[at] = { ...f, label: out[at]?.label ?? f.label }
    }
  }
  const month = out.find((f) => f.id === "month")?.value ?? ""
  const year = out.find((f) => f.id === "year")?.value ?? ""
  const exp = out.findIndex((f) => f.id === "expiry")
  const target = out[exp]
  if (target && month !== "" && year !== "" && target.value === "") {
    out[exp] = { ...target, value: expiry(month, year) }
  }
  return out
}

const urlsOf = (given: readonly (string | Url)[]): Url[] =>
  given
    .map((u) => (typeof u === "string" ? { url: u.trim() } : u))
    .filter((u) => u.url !== "")
    .map((u) => (u.url.includes("://") ? u : { ...u, url: `https://${u.url}` }))

/** A new item from a draft, or the one it goes `into` changed by it. */
export const fromDraft = (v: Vault, d: Draft, source: string, strict: boolean): Item => {
  const fields = d.fields.map((f) => kept(f, strict))
  if (d.into !== undefined) {
    const into = find(v, d.into)
    return {
      ...into,
      title: d.title === "" ? into.title : d.title,
      fields: merged(into.fields, fields),
      urls: [
        ...into.urls,
        ...urlsOf(d.urls ?? []).filter((u) => !into.urls.some((x) => x.url === u.url)),
      ],
      notes: d.notes ?? into.notes,
      tags: [...new Set([...into.tags, ...(d.tags ?? [])])],
      folder: d.folder ?? into.folder,
      updated: now(),
    }
  }
  const t = now()
  return {
    id: ItemId.make(crypto.randomUUID()),
    kind: d.kind,
    name: uniqueName(v, d.name ?? d.title),
    title: d.title,
    fields: merged(templateFields(d.kind), fields),
    urls: urlsOf(d.urls ?? []),
    notes: d.notes ?? "",
    tags: [...(d.tags ?? [])],
    folder: d.folder ?? "",
    spaces: [],
    favorite: false,
    source,
    created: t,
    updated: t,
    trashed: 0,
  }
}

const write = async (v: Vault, item: Item) => {
  const seq = await store.writeItem(v, item)
  changed(seq)
  return seq
}

const note = (v: Vault, u: Partial<store.Use> & { item: string; use: string; who: string }) => {
  store.record(v, {
    name: v.items.get(ItemId.make(u.item))?.name ?? "",
    field: "",
    space: "",
    why: "",
    target: "",
    ok: true,
    reason: "",
    ...u,
  })
}

// The agent's view: outlines only.

export interface Listing {
  readonly query?: string
  readonly kind?: string
  readonly tag?: string
  readonly folder?: string
  readonly space?: string
  readonly url?: string
  readonly trashed?: boolean
}

export const list = (v: Vault, l: Listing) => {
  const used = store.lastUsed(v)
  const words = (l.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean)
  const items = [...v.items.values()].filter((i) => {
    const haystack = [
      i.name,
      i.title,
      i.folder,
      ...i.tags,
      ...i.urls.map((u) => u.url),
      ...i.fields.filter((f) => !CONCEALED.has(f.type)).map((f) => f.value),
    ]
      .join(" ")
      .toLowerCase()
    return (
      (l.trashed === true) === i.trashed > 0 &&
      words.every((w) => haystack.includes(w)) &&
      (l.kind === undefined || i.kind === l.kind) &&
      (l.tag === undefined || i.tags.includes(l.tag)) &&
      (l.folder === undefined || i.folder === l.folder || i.folder.startsWith(`${l.folder}/`)) &&
      (l.space === undefined || i.spaces.length === 0 || i.spaces.includes(l.space)) &&
      (l.url === undefined || urlAllowed(i.urls, l.url))
    )
  })
  return items
    .toSorted((a, b) => (used.get(b.id) ?? b.updated) - (used.get(a.id) ?? a.updated))
    .map((i) => ({ ...outline(i), ...(used.has(i.id) && { used: used.get(i.id) }) }))
}

export const get = async (v: Vault, ref: string) => {
  const item = find(v, ref)
  const old = await store.historyItems(v, item.id)
  return {
    ...outline(item),
    history: old.length,
    uses: store.audit(v, item.id, 10).map((e) => ({
      at: e.at,
      use: e.use,
      who: e.who,
      field: e.field,
      target: e.target,
      ok: e.ok,
    })),
  }
}

// Saving from the agent: plain parts, generated secrets, values from a file.

const plainField = Schema.Struct({
  id: Schema.String,
  label: Schema.optionalKey(Schema.String),
  type: Schema.optionalKey(Schema.Literals(FIELD_TYPES)),
  value: Schema.String,
})

export const SaveInput = Schema.Struct({
  item: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(KINDS)),
  title: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  username: Schema.optionalKey(Schema.String),
  urls: Schema.optionalKey(Schema.Array(Schema.String)),
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  folder: Schema.optionalKey(Schema.String),
  spaces: Schema.optionalKey(Schema.Array(Schema.String)),
  favorite: Schema.optionalKey(Schema.Boolean),
  fields: Schema.optionalKey(Schema.Array(plainField)),
  generate: Schema.optionalKey(
    Schema.Struct({
      field: Schema.optionalKey(Schema.String),
      style: Schema.optionalKey(Schema.Literals(["random", "apple", "pin"])),
      length: Schema.optionalKey(Schema.Finite),
      digits: Schema.optionalKey(Schema.Boolean),
      symbols: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  from_file: Schema.optionalKey(
    Schema.Struct({
      field: Schema.String,
      path: Schema.String,
    }),
  ),
  restore: Schema.optionalKey(Schema.Boolean),
})
export type SaveInput = typeof SaveInput.Type

const expand = (p: string) => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p)

export const save = async (v: Vault, input: SaveInput, who: string) => {
  const existing = input.item === undefined ? null : find(v, input.item)
  const kind = input.kind ?? existing?.kind ?? "login"
  if (existing === null && input.title === undefined) {
    throw new Error("A new item needs a title")
  }
  const t = now()
  const base: Item = existing ?? {
    id: ItemId.make(crypto.randomUUID()),
    kind,
    name: uniqueName(v, input.name ?? input.title ?? "item"),
    title: input.title ?? "",
    fields: templateFields(kind),
    urls: [],
    notes: "",
    tags: [],
    folder: "",
    spaces: [],
    favorite: false,
    source: who,
    created: t,
    updated: t,
    trashed: 0,
  }
  const plain = (input.fields ?? []).map((f): Field => {
    const known = base.fields.find((x) => x.id === f.id)
    const type = known?.type ?? f.type ?? "text"
    if (CONCEALED.has(type)) {
      throw new Error(
        `${f.id} is concealed: its value comes from the user (ask), a generated one (generate) or a file (from_file), never from you`,
      )
    }
    return kept({ id: f.id, label: f.label ?? known?.label ?? f.id, type, value: f.value }, true)
  })
  const secret: Field[] = []
  let made = ""
  if (input.generate !== undefined) {
    const id = input.generate.field ?? TEMPLATES[kind][0]?.[0] ?? "password"
    const known = base.fields.find((x) => x.id === id)
    const g: Generate = {
      ...(input.generate.style !== undefined && { style: input.generate.style }),
      ...(input.generate.length !== undefined && { length: input.generate.length }),
      ...(input.generate.digits !== undefined && { digits: input.generate.digits }),
      ...(input.generate.symbols !== undefined && { symbols: input.generate.symbols }),
    }
    const value = generate(g)
    secret.push({ id, label: known?.label ?? "Password", type: known?.type ?? "password", value })
    made = `generated ${id} (${value.length} characters)`
  }
  if (input.from_file !== undefined) {
    const file = expand(input.from_file.path)
    if (!existsSync(file) || statSync(file).size > 1_000_000) {
      throw new Error(
        `There's no file ${input.from_file.path} on the vault's Mac to read (or it's over 1 MB)`,
      )
    }
    const id = input.from_file.field
    const known = base.fields.find((x) => x.id === id)
    const type = known?.type ?? (id === "totp" ? "totp" : "concealed")
    const raw = readFileSync(file, "utf-8")
    secret.push(
      kept(
        { id, label: known?.label ?? id, type, value: type === "private-key" ? raw : raw.trim() },
        true,
      ),
    )
    made = `${made === "" ? "" : `${made}; `}kept ${id} from ${input.from_file.path}`
  }
  const username =
    input.username === undefined
      ? []
      : [kept({ id: "username", label: "Username", type: "text", value: input.username }, true)]
  const item: Item = {
    ...base,
    ...(input.title !== undefined && { title: input.title }),
    ...(input.name !== undefined &&
      existing !== null && { name: uniqueName(v, input.name, existing.id) }),
    fields: merged(base.fields, [...username, ...plain, ...secret]),
    urls: input.urls === undefined ? base.urls : urlsOf(input.urls),
    tags: input.tags === undefined ? base.tags : [...input.tags],
    folder: input.folder ?? base.folder,
    spaces: input.spaces === undefined ? base.spaces : [...input.spaces],
    favorite: input.favorite ?? base.favorite,
    trashed: input.restore === true ? 0 : base.trashed,
    updated: t,
  }
  await write(v, item)
  note(v, { item: item.id, use: "save", who, why: made })
  return { saved: outline(item), ...(made !== "" && { did: made }) }
}

export const trash = async (v: Vault, ref: string, who: string) => {
  const item = find(v, ref)
  await write(v, { ...item, trashed: now(), updated: now() })
  note(v, { item: item.id, use: "delete", who })
  return { trashed: item.name }
}

// Releasing to extensions, and their deposits.

export const ReleaseInput = Schema.Struct({
  extension: Schema.String,
  /** An item's name or id; or `ref`, a reference (name.field) naming the field too. */
  item: Schema.optionalKey(Schema.String),
  ref: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  url: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.Literals(["fill", "env", "file", "http"])),
  why: Schema.optionalKey(Schema.String),
  space: Schema.optionalKey(Schema.String),
})

const activeExtension = (v: Vault, name: string) => {
  const s = store.extension(v, name)
  if (!s || s.status !== "active") {
    throw new Error(`The vault hasn't allowed ${name} yet`)
  }
  return s
}

export const release = async (v: Vault, input: typeof ReleaseInput.Type) => {
  const s = activeExtension(v, input.extension)
  const named = input.ref === undefined ? null : resolve(v, input.ref)
  const item = named?.item ?? find(v, input.item ?? "")
  const use: UseKind = input.use ?? "fill"
  const who = `extension:${s.name}`
  const target = input.url === undefined ? "" : hostOf(input.url)
  const base = { item: item.id, use, who, space: input.space ?? "", why: input.why ?? "", target }
  const refuse = (reason: string): never => {
    note(v, { ...base, ok: false, reason })
    throw new Error(reason)
  }
  const why = refusal(store.grants(v), item, { who, space: input.space ?? "" }, use)
  if (why !== null) {
    refuse(why)
  }
  if (input.url !== undefined && !secure(input.url)) {
    refuse(`${target} isn't a secure page: a secret only goes into one`)
  }
  if (item.urls.length > 0 && (input.url === undefined || !urlAllowed(item.urls, input.url))) {
    refuse(
      `${item.name} is kept for ${item.urls.map((u) => hostOf(u.url)).join(", ")}, not ${target || "that page"}`,
    )
  }
  const wanted = input.fields ?? [named?.field.id ?? mainField(item)?.id ?? ""]
  const values: Record<string, string> = {}
  for (const id of wanted) {
    const f = item.fields.find((x) => x.id === id)
    if (f && f.value !== "") {
      values[id] = await valueOf(f)
    }
  }
  if (Object.keys(values).length === 0) {
    refuse(`${item.name} holds none of ${wanted.join(", ")}`)
  }
  const id = crypto.randomUUID()
  const sealed = await sealTo(
    s.key,
    `release:${id}`,
    `${s.name}:${item.id}`,
    JSON.stringify(values),
  )
  note(v, { ...base, field: Object.keys(values).join(","), target: target || use })
  const labels = Object.fromEntries(
    Object.keys(values).map((f) => [f, item.fields.find((x) => x.id === f)?.label ?? f]),
  )
  return {
    id,
    item: item.id,
    name: item.name,
    title: item.title,
    labels,
    fields: Object.keys(values),
    ...sealed,
  }
}

export const DepositInput = Schema.Struct({
  extension: Schema.String,
  id: Schema.String,
  enc: Schema.String,
  ct: Schema.String,
})

const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Draft))

export const deposit = async (v: Vault, input: typeof DepositInput.Type) => {
  const s = activeExtension(v, input.extension)
  const json = await openFrom(v.extensionSecret, `deposit:${input.id}`, s.name, {
    enc: input.enc,
    ct: input.ct,
  })
  const draft = decodeDraft(json)
  const named =
    draft.into === undefined && draft.name !== undefined
      ? [...v.items.values()].find((i) => i.name === draft.name && i.trashed === 0)
      : undefined
  const item = fromDraft(
    v,
    named ? { ...draft, into: named.id } : draft,
    `extension:${s.name}`,
    true,
  )
  await write(v, item)
  note(v, {
    item: item.id,
    use: "save",
    who: `extension:${s.name}`,
    field: draft.fields.map((f) => f.id).join(","),
  })
  return { saved: outline(item) }
}

export const registerExtension = async (v: Vault, name: string, key: string) => {
  const had = store.extension(v, name)
  if (had && had.key === key && had.status === "active") {
    return { extension: name, status: "active" as const, key: v.extensionKey }
  }
  const code = await codeOf(key)
  store.putExtension(v, {
    name,
    key,
    code,
    status: "pending",
    created: had?.created ?? now(),
    approved: 0,
  })
  changed(store.seqOf(v))
  return { extension: name, status: "pending" as const, code, key: v.extensionKey }
}

// Using secrets for the agent: a command's environment and files, a request, a file kept.

const agentCaller = (space: string | undefined): Caller => ({ who: "agent", space: space ?? "" })

/** The values some references name, after the grants allow each this use. */
const values = async (
  v: Vault,
  refs: readonly { ref: string; use: UseKind }[],
  caller: Caller,
  why: string,
  target: string,
  check?: (item: Item) => string | null,
) => {
  const out = new Map<string, string>()
  const grants = store.grants(v)
  for (const { ref, use } of refs) {
    const { item, field } = resolve(v, ref)
    const reason = refusal(grants, item, caller, use) ?? check?.(item) ?? null
    store.record(v, {
      item: item.id,
      name: item.name,
      field: field.id,
      use,
      who: caller.who,
      space: caller.space,
      why,
      target,
      ok: reason === null,
      reason: reason ?? "",
    })
    if (reason !== null) {
      throw new Error(reason)
    }
    out.set(ref, await valueOf(field))
  }
  return out
}

export const RunInput = Schema.Struct({
  command: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  files: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.String })),
  ),
  stdin: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  timeout: Schema.optionalKey(Schema.Finite),
  why: Schema.String,
  space: Schema.optionalKey(Schema.String),
})

const CAP = 200_000

const capped = (text: string) =>
  text.length > CAP ? `${text.slice(0, CAP)}\n[cut: ${text.length - CAP} more characters]` : text

const envRef = (value: string) => (value.includes("{{") ? refsIn([value]) : [value.trim()])

export const run = async (v: Vault, input: typeof RunInput.Type) => {
  const argv =
    typeof input.command === "string" ? ["/bin/sh", "-c", input.command] : [...input.command]
  if (refsIn(argv).length > 0) {
    throw new Error(
      "A command line shows in the process list: put the secret in env, a file or stdin",
    )
  }
  const env = input.env ?? {}
  const files = input.files ?? []
  for (const f of files) {
    if (f.name.includes("/") || f.name.startsWith(".") || f.name === "") {
      throw new Error(`A run's file is a plain name, not ${JSON.stringify(f.name)}`)
    }
  }
  const refs = [
    ...Object.values(env).flatMap((x) => envRef(x).map((ref) => ({ ref, use: "env" as const }))),
    ...refsIn(files.map((f) => f.content)).map((ref) => ({ ref, use: "file" as const })),
    ...refsIn([input.stdin ?? ""]).map((ref) => ({ ref, use: "env" as const })),
  ]
  const target = (argv[0] === "/bin/sh" ? (argv[2] ?? "") : argv.join(" ")).split(/\s+/u)[0] ?? ""
  const got = await values(v, refs, agentCaller(input.space), input.why, path.basename(target))
  const folder = files.length > 0 ? mkdtempSync(path.join(tmpdir(), "secrets-")) : ""
  try {
    for (const f of files) {
      await Bun.write(path.join(folder, f.name), fill(f.content, got), { mode: 0o600 })
    }
    const injected = Object.fromEntries(
      Object.entries(env).map(([k, x]) => [
        k,
        x.includes("{{") ? fill(x, got) : (got.get(x.trim()) ?? ""),
      ]),
    )
    const started = now()
    const proc = Bun.spawn(argv, {
      cwd: expand(input.cwd ?? homedir()),
      env: { ...process.env, ...injected, ...(folder !== "" && { SECRETS_FILES: folder }) },
      stdin:
        input.stdin === undefined ? "ignore" : new TextEncoder().encode(fill(input.stdin, got)),
      stdout: "pipe",
      stderr: "pipe",
      timeout: Math.min(input.timeout ?? 120, 600) * 1000,
    })
    const [code, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const hide = redactions(v, got)
    return {
      exit: code,
      ...(proc.signalCode !== null && { signal: proc.signalCode }),
      seconds: Math.round((now() - started) / 100) / 10,
      stdout: capped(redact(out, hide)),
      stderr: capped(redact(err, hide)),
    }
  } finally {
    if (folder !== "") {
      rmSync(folder, { recursive: true, force: true })
    }
  }
}

export const HttpInput = Schema.Struct({
  url: Schema.String,
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  body: Schema.optionalKey(Schema.String),
  why: Schema.String,
  space: Schema.optionalKey(Schema.String),
})

export const http = async (v: Vault, input: typeof HttpInput.Type) => {
  const headers = input.headers ?? {}
  const refs = refsIn([input.url, ...Object.values(headers), input.body ?? ""]).map((ref) => ({
    ref,
    use: "http" as const,
  }))
  // The host is checked on the URL as written, before any value is in it.
  const literal = input.url.replaceAll(/\{\{[^{}]*\}\}/gu, "x")
  const host = hostOf(literal)
  if (!secure(literal) || host === "") {
    throw new Error("A secret is only sent over HTTPS (or to this Mac)")
  }
  if (hostOf(input.url.split("{{")[0] ?? "") !== host) {
    throw new Error("A secret can't be part of the host")
  }
  const got = await values(v, refs, agentCaller(input.space), input.why, host, (item) =>
    urlAllowed(item.urls, literal)
      ? null
      : `${item.name} is sent only to ${item.urls.length === 0 ? "the hosts in its urls, and it has none: add one with save" : item.urls.map((u) => hostOf(u.url)).join(", ")}`,
  )
  const response = await fetch(fill(input.url, got), {
    method: input.method ?? "GET",
    headers: Object.fromEntries(Object.entries(headers).map(([k, x]) => [k, fill(x, got)])),
    ...(input.body !== undefined && { body: fill(input.body, got) }),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  })
  const hide = redactions(v, got)
  const text = await response.text()
  return {
    status: response.status,
    headers: Object.fromEntries([...response.headers].map(([k, x]) => [k, redact(x, hide)])),
    body: capped(redact(text, hide)),
  }
}

export const WriteFileInput = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  mode: Schema.optionalKey(Schema.Finite),
  why: Schema.String,
  space: Schema.optionalKey(Schema.String),
})

export const writeFile = async (v: Vault, input: typeof WriteFileInput.Type) => {
  const file = expand(input.path)
  if (!path.isAbsolute(file)) {
    throw new Error("Give the file's whole path (or ~/…)")
  }
  const got = await values(
    v,
    refsIn([input.content]).map((ref) => ({ ref, use: "file" as const })),
    agentCaller(input.space),
    input.why,
    input.path,
  )
  await Bun.write(file, fill(input.content, got), { mode: input.mode ?? 0o600 })
  return { wrote: input.path, references: [...got.keys()] }
}

// Devices and sync.

export const enroll = async (v: Vault, name: string, kind: string, key: string) => {
  const id = crypto.randomUUID()
  const code = await codeOf(key)
  store.addDevice(v, {
    id,
    name,
    kind,
    key,
    code,
    status: "pending",
    created: now(),
    approved: 0,
    seen: 0,
  })
  changed(store.seqOf(v))
  return { device: id, code }
}

const proven = async (v: Vault, words: string, proof: string | undefined) => {
  if (proof === undefined || !(await verify(v.keys, words, proof))) {
    throw new Error("That proof isn't from a device of this vault")
  }
}

export const approveDevice = async (v: Vault, id: string, proof: string | undefined) => {
  const d = store.device(v, id)
  if (!d || d.status !== "pending") {
    throw new Error("No device waits for that")
  }
  await proven(v, statement("approve-device", d.id, d.key), proof)
  await store.approveDevice(v, d)
  changed(store.seqOf(v))
  return { device: d.id, status: "active" }
}

export const revokeDevice = async (v: Vault, id: string, proof: string | undefined) => {
  const d = store.device(v, id)
  if (!d) {
    throw new Error("No such device")
  }
  await proven(v, statement("revoke-device", d.id), proof)
  await store.revokeDevice(v, d.id)
  changed(store.seqOf(v))
  return { device: d.id, status: "revoked", keyVersion: v.keys.version }
}

export const approveExtension = async (v: Vault, name: string, proof: string | undefined) => {
  const s = store.extension(v, name)
  if (!s || s.status !== "pending") {
    throw new Error(`${name} isn't waiting to be allowed`)
  }
  await proven(v, statement("approve-extension", s.name, s.key), proof)
  store.putExtension(v, { ...s, status: "active", approved: now() })
  changed(store.seqOf(v))
  return { extension: s.name, status: "active" }
}

export const revokeExtension = async (v: Vault, name: string, proof: string | undefined) => {
  const s = store.extension(v, name)
  if (!s) {
    throw new Error(`No extension ${name}`)
  }
  await proven(v, statement("revoke-extension", s.name), proof)
  store.putExtension(v, { ...s, status: "revoked" })
  changed(store.seqOf(v))
  return { extension: s.name, status: "revoked" }
}

/** Approves the device or extension showing `code`, from the vault Mac's own terminal. */
export const approveCode = async (v: Vault, code: string) => {
  const d = store.devices(v).find((x) => x.status === "pending" && x.code === code)
  if (d) {
    await store.approveDevice(v, d)
    return `Approved ${d.name}`
  }
  const s = store.extensions(v).find((x) => x.status === "pending" && x.code === code)
  if (s) {
    store.putExtension(v, { ...s, status: "active", approved: now() })
    return `Allowed ${s.name}`
  }
  throw new Error(`Nothing waits with the code ${code}`)
}

const activeDevice = (v: Vault, id: string) => {
  const d = store.device(v, id)
  if (!d || d.status !== "active") {
    throw new Error(d?.status === "pending" ? "Not approved yet" : "Not a device of this vault")
  }
  store.sawDevice(v, d.id)
  return d
}

export const sync = (v: Vault, device: string, since: number, version: number | undefined) => {
  const d = store.device(v, device)
  if (!d || d.status === "revoked") {
    throw new Error("Not a device of this vault")
  }
  const base = {
    vault: v.keys.vault,
    status: d.status,
    seq: store.seqOf(v),
    devices: store.devices(v),
    extensions: store.extensions(v),
  }
  if (d.status === "pending") {
    return { ...base, code: d.code, items: [] }
  }
  store.sawDevice(v, d.id)
  const key = since === 0 || version !== v.keys.version ? store.sealedKeyFor(v, d.id) : null
  return {
    ...base,
    keyVersion: v.keys.version,
    ...(key && { key: { enc: key.enc, ct: key.ct } }),
    // A new key version seals every item again: a device behind it takes them all.
    items: store.changedSince(v, version !== undefined && version !== v.keys.version ? 0 : since),
    grants: store.grants(v),
  }
}

const decodeItem = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
)

export const put = async (v: Vault, device: string, id: string, blob: string) => {
  const d = activeDevice(v, device)
  const json = await openItem(v.keys, id, blob).catch(() => {
    throw new Error("That doesn't open under the vault's key: sync, then seal it again")
  })
  if (decodeItem(json).id !== id) {
    throw new Error("That item is sealed under another id")
  }
  const item = Schema.decodeUnknownSync(Schema.fromJsonString(ItemSchema))(json)
  const clash = [...v.items.values()].find(
    (i) => i.name === item.name && i.id !== item.id && i.trashed === 0,
  )
  if (clash) {
    throw new Error(`Another item is named ${item.name}`)
  }
  const before = v.items.get(item.id)
  const seq = store.writeBlob(v, item, blob)
  changed(seq)
  note(v, { item: item.id, use: before ? "save" : "add", who: `device:${d.id}` })
  return { seq }
}

export const remove = async (v: Vault, device: string, id: string, proof: string | undefined) => {
  activeDevice(v, device)
  await proven(v, statement("purge", id), proof)
  note(v, { item: id, use: "purge", who: `device:${device}` })
  const seq = store.purge(v, ItemId.make(id))
  changed(seq)
  return { seq }
}

export const changeGrant = async (
  v: Vault,
  device: string,
  proof: string | undefined,
  op: "add" | "remove",
  g: { id?: string; subject?: string; scope?: string; uses?: readonly string[] },
) => {
  activeDevice(v, device)
  if (op === "remove") {
    await proven(v, statement("grant", "remove", g.id ?? ""), proof)
    store.removeGrant(v, g.id ?? "")
    changed(store.seqOf(v))
    return { removed: g.id }
  }
  const uses = [...(g.uses ?? [])]
  await proven(v, statement("grant", "add", g.subject ?? "", g.scope ?? "", uses.join(",")), proof)
  const made = store.addGrant(v, { subject: g.subject ?? "", scope: g.scope ?? "", uses })
  changed(store.seqOf(v))
  return { grant: made }
}

export const history = (v: Vault, device: string, id: string) => {
  activeDevice(v, device)
  return { id, history: store.history(v, id) }
}

export const used = (v: Vault, device: string, item: string, field: string, use: string) => {
  activeDevice(v, device)
  note(v, { item, field, use, who: `device:${device}` })
  return { ok: true }
}
