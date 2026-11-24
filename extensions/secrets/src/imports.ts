// Other password managers' exports, read into drafts: Chrome's and Apple Passwords' CSV,
// Bitwarden's unencrypted JSON, 1Password's CSV, and any CSV with a header that names its columns.
// Logins with the same username and password on the same site come together as one, with each URL.
// Pure, so the Mac app reads a file on its own Mac with these, and the extension one on the
// vault's.
import type { Draft, Field, FieldType, Kind } from "./model.ts"
import { TEMPLATES } from "./model.ts"

export const SOURCES = ["chrome", "apple", "bitwarden", "1password", "csv"] as const
export type Source = (typeof SOURCES)[number]

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  const body = text.replace(/^﻿/u, "")
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] ?? ""
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (c === '"') {
        quoted = false
      } else {
        cell += c
      }
    } else if (c === '"') {
      quoted = true
    } else if (c === ",") {
      row.push(cell)
      cell = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") {
        i += 1
      }
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else {
      cell += c
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""))
}

/** Rows as objects by their header's lowercased names. */
const table = (text: string): Record<string, string>[] => {
  const [head = [], ...rows] = parseCsv(text)
  const names = head.map((h) => h.trim().toLowerCase())
  return rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])))
}

const field = (id: string, value: string, label?: string, type?: FieldType): Field => {
  const known = Object.values(TEMPLATES)
    .flat()
    .find(([fid]) => fid === id)
  return {
    id,
    label: label ?? known?.[1] ?? id,
    type: type ?? known?.[2] ?? "text",
    value,
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./u, "")
  } catch {
    return ""
  }
}

/** Chrome names Android apps' logins android://…@com.example: none of them are web pages. */
const webUrl = (url: string) => (/^https?:\/\//u.test(url.trim()) ? url.trim() : "")

const login = (r: {
  title: string
  url: string
  username: string
  password: string
  notes?: string
  totp?: string
  tags?: readonly string[]
  folder?: string
}): Draft => {
  const url = webUrl(r.url)
  return {
    kind: "login",
    title: r.title.trim() || hostOf(url) || r.username || "Login",
    fields: [
      field("username", r.username),
      field("password", r.password),
      ...(r.totp !== undefined && r.totp.trim() !== "" ? [field("totp", r.totp.trim())] : []),
    ],
    urls: url === "" ? [] : [{ url }],
    notes: r.notes?.trim() ?? "",
    tags: [...(r.tags ?? [])],
    folder: r.folder ?? "",
  }
}

const valueOf = (d: Draft, id: string) => d.fields.find((f) => f.id === id)?.value ?? ""

/** Logins with one username and password on one site, as one login with each of their URLs. */
export const together = (drafts: readonly Draft[]): Draft[] => {
  const out: Draft[] = []
  const seen = new Map<string, number>()
  for (const d of drafts) {
    const site = hostOf(d.urls?.[0]?.url ?? "")
      .split(".")
      .slice(-2)
      .join(".")
    const key =
      d.kind === "login" && site !== ""
        ? JSON.stringify([site, valueOf(d, "username"), valueOf(d, "password")])
        : ""
    const at = key === "" ? undefined : seen.get(key)
    const into = at === undefined ? undefined : out[at]
    if (into === undefined || at === undefined) {
      if (key !== "") {
        seen.set(key, out.length)
      }
      out.push(d)
      continue
    }
    const urls = [...(into.urls ?? [])]
    for (const u of d.urls ?? []) {
      if (!urls.some((x) => x.url === u.url)) {
        urls.push(u)
      }
    }
    out[at] = {
      ...into,
      urls,
      notes: [into.notes ?? "", d.notes ?? ""].filter((n) => n !== "").join("\n\n"),
    }
  }
  return out
}

const chrome = (text: string) =>
  table(text).map((r) =>
    login({
      title: r.name ?? "",
      url: r.url ?? "",
      username: r.username ?? "",
      password: r.password ?? "",
      notes: r.note ?? r.notes ?? "",
    }),
  )

const apple = (text: string) =>
  table(text).map((r) =>
    login({
      title: r.title ?? "",
      url: r.url ?? "",
      username: r.username ?? "",
      password: r.password ?? "",
      notes: r.notes ?? "",
      totp: r.otpauth ?? "",
    }),
  )

const onePassword = (text: string) =>
  table(text).map((r) =>
    login({
      title: r.title ?? "",
      url: r.url ?? r.website ?? "",
      username: r.username ?? "",
      password: r.password ?? "",
      notes: r.notes ?? "",
      totp: r.otpauth ?? "",
      tags: (r.tags ?? "")
        .split(/[;,]/u)
        .map((t) => t.trim())
        .filter(Boolean),
    }),
  )

/** Any CSV whose header names a URL, username and password column, in some words. */
const generic = (text: string) =>
  table(text).map((r) => {
    const pick = (...names: string[]) =>
      names.map((n) => r[n]).find((x) => x !== undefined && x !== "") ?? ""
    return login({
      title: pick("title", "name", "account"),
      url: pick("url", "website", "login_uri", "uri", "site"),
      username: pick("username", "login", "user", "email", "login_username"),
      password: pick("password", "pass", "login_password"),
      notes: pick("notes", "note", "extra", "comments"),
      totp: pick("otpauth", "totp", "login_totp", "otp"),
    })
  })

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const s = (v: unknown) => {
  if (typeof v === "number") {
    return String(v)
  }
  return typeof v === "string" ? v : ""
}
const objects = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isJson) : [])

const bitwarden = (text: string): Draft[] => {
  const parsed: unknown = JSON.parse(text)
  const data = isJson(parsed) ? parsed : {}
  if (data.encrypted === true) {
    throw new Error("That Bitwarden export is encrypted: export it as JSON, not encrypted")
  }
  const folders = new Map(objects(data.folders).map((f) => [s(f.id), s(f.name)]))
  return objects(data.items).map((it): Draft => {
    const base = {
      title: s(it.name) || "Item",
      notes: s(it.notes),
      folder: folders.get(s(it.folderId)) ?? "",
    }
    const custom = objects(it.fields).map((f, i) =>
      field(
        `field_${i + 1}`,
        s(f.value),
        s(f.name) || `Field ${i + 1}`,
        f.type === 1 ? "concealed" : "text",
      ),
    )
    const lg = isJson(it.login) ? it.login : null
    const card = isJson(it.card) ? it.card : null
    const id = isJson(it.identity) ? it.identity : null
    if (it.type === 1 && lg) {
      const urls = objects(lg.uris)
        .map((u) => webUrl(s(u.uri)))
        .filter(Boolean)
        .map((url) => ({ url }))
      return {
        kind: "login",
        ...base,
        fields: [
          field("username", s(lg.username)),
          field("password", s(lg.password)),
          ...(s(lg.totp) === "" ? [] : [field("totp", s(lg.totp))]),
          ...custom,
        ],
        urls,
      }
    }
    if (it.type === 3 && card) {
      const month = s(card.expMonth).padStart(2, "0")
      const year = s(card.expYear)
      return {
        kind: "card",
        ...base,
        fields: [
          field("number", s(card.number).replaceAll(/\D/gu, "")),
          field("holder", s(card.cardholderName)),
          field("cvc", s(card.code)),
          field("month", month === "00" ? "" : month),
          field("year", year),
          field("expiry", month !== "00" && year !== "" ? `${month}/${year.slice(-2)}` : ""),
          ...custom,
        ],
      }
    }
    if (it.type === 4 && id) {
      const name = [s(id.firstName), s(id.middleName), s(id.lastName)].filter(Boolean).join(" ")
      const address = [
        s(id.address1),
        s(id.address2),
        s(id.city),
        s(id.state),
        s(id.postalCode),
        s(id.country),
      ]
        .filter(Boolean)
        .join(", ")
      return {
        kind: "identity",
        ...base,
        fields: [
          field("name", name),
          field("email", s(id.email)),
          field("phone", s(id.phone)),
          field("address", address),
          field("ssn", s(id.ssn).replaceAll(/\D/gu, "")),
          field("passport", s(id.passportNumber)),
          field("license", s(id.licenseNumber)),
          ...custom,
        ],
      }
    }
    return { kind: "note", ...base, fields: custom }
  })
}

/** What an export holds, as drafts, with logins on one site together. */
export const read = (source: Source, text: string): Draft[] => {
  const parsers: Record<Source, (t: string) => Draft[]> = {
    chrome,
    apple,
    bitwarden,
    "1password": onePassword,
    csv: generic,
  }
  return together(parsers[source](text)).map((d) => ({
    ...d,
    fields: d.fields.filter((f) => f.value !== ""),
  }))
}

/** How many of each kind some drafts are. */
export const counts = (drafts: readonly Draft[]): Partial<Record<Kind, number>> => {
  const out: Partial<Record<Kind, number>> = {}
  for (const d of drafts) {
    out[d.kind] = (out[d.kind] ?? 0) + 1
  }
  return out
}
