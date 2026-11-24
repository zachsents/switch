// Google Contacts, through the People API, on the account the user connected in Switch: the core
// holds the grant and hands out short-lived tokens.
import { Effect } from "effect"

import { handleOfUrl } from "./apple.ts"
import { accessToken, askForGoogle, googleAccount } from "./core.ts"
import { isJson, parse, rec, recs, str, text } from "./json.ts"
import type { Json } from "./json.ts"
import type { SourceRecord } from "./merge.ts"
import type { Stated } from "./store.ts"

export const SCOPE = "https://www.googleapis.com/auth/contacts"
const PEOPLE = "https://people.googleapis.com/v1"
export const FIELDS =
  "names,nicknames,emailAddresses,phoneNumbers,organizations,urls,addresses,biographies,relations,birthdays,imClients,memberships,metadata"

let account: string | null = null

/** Whether a Google account with contacts access is connected, without asking for one. */
export const googleConnected = Effect.map(googleAccount(SCOPE), (a) => {
  account ??= a
  return a !== null
})

/** The user's connected Google account, or an action item asking for one. */
const bearer = async () => {
  account ??= await Effect.runPromise(googleAccount(SCOPE))
  if (account === null) {
    await Effect.runPromise(askForGoogle)
    throw new Error("No Google account connected for contacts")
  }
  return await accessToken(account)
}

/** One call, tried again after a rate limit, up to five times. */
const call = async (
  token: string,
  method: string,
  path: string,
  body: unknown,
  attempt: number,
): Promise<unknown> => {
  const res = await fetch(`${PEOPLE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 429 && attempt < 5) {
    await Bun.sleep(2000 * (attempt + 1))
    return await call(token, method, path, body, attempt + 1)
  }
  const out = await res.text()
  if (!res.ok) {
    const [bare] = path.split("?")
    throw new Error(`People API ${method} ${bare}: ${res.status} ${out.slice(0, 200)}`)
  }
  return out === "" ? {} : parse(out)
}

const api = async (method: string, path: string, body?: unknown): Promise<unknown> =>
  await call(await bearer(), method, path, body, 0)

const s = str

export interface GooglePerson extends Json {
  readonly resourceName: string
  readonly etag: string
}

const personOf = (v: unknown): GooglePerson | null => {
  if (!isJson(v) || typeof v.resourceName !== "string") {
    return null
  }
  return { ...v, resourceName: v.resourceName, etag: text(v.etag) }
}

const onePerson = (v: unknown) => {
  const p = personOf(v)
  if (p === null) {
    throw new Error("People API sent no contact")
  }
  return p
}

/** One page of saved contacts, and the pages after it, one after another. */
const pages = async (token: string, out: GooglePerson[]): Promise<GooglePerson[]> => {
  const raw = await api(
    "GET",
    `/people/me/connections?personFields=${FIELDS}&pageSize=1000${token === "" ? "" : `&pageToken=${token}`}`,
  )
  const r = rec(raw)
  const connections = Array.isArray(r.connections) ? r.connections : []
  for (const c of connections) {
    const p = personOf(c)
    if (p !== null) {
      out.push(p)
    }
  }
  if (typeof r.nextPageToken !== "string") {
    return out
  }
  return await pages(r.nextPageToken, out)
}

/** Every saved contact (My Contacts), raw. */
export const googlePeople = Effect.tryPromise({
  try: async () => await pages("", []),
  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
})

const nameFields = (g: GooglePerson): Stated[] => {
  const fields: Stated[] = []
  const [name] = recs(g.names)
  const full = s(name?.displayName)
  const [org] = recs(g.organizations)
  if (full !== "") {
    fields.push({ kind: "name", value: full })
  } else if (s(org?.name) !== "") {
    fields.push({ kind: "name", value: s(org?.name) })
  }
  if (s(name?.givenName) !== "") {
    fields.push({ kind: "given", value: s(name?.givenName) })
  }
  if (s(name?.familyName) !== "") {
    fields.push({ kind: "family", value: s(name?.familyName) })
  }
  for (const n of recs(g.nicknames)) {
    if (s(n.value) !== "") {
      fields.push({ kind: "nickname", value: s(n.value) })
    }
  }
  if (s(org?.name) !== "") {
    fields.push({ kind: "company", value: s(org?.name) })
  }
  if (s(org?.title) !== "") {
    fields.push({ kind: "role", value: s(org?.title) })
  }
  return fields
}

const reachFields = (g: GooglePerson): Stated[] => {
  const fields: Stated[] = []
  for (const p of recs(g.phoneNumbers)) {
    fields.push({ kind: "phone", value: s(p.canonicalForm) || s(p.value), label: s(p.type) })
  }
  for (const e of recs(g.emailAddresses)) {
    fields.push({ kind: "email", value: s(e.value), label: s(e.type) })
  }
  for (const u of recs(g.urls)) {
    fields.push(handleOfUrl(s(u.value)) ?? { kind: "url", value: s(u.value), label: s(u.type) })
  }
  for (const im of recs(g.imClients)) {
    fields.push({
      kind: "handle",
      value: s(im.username),
      service: s(im.protocol).toLowerCase() || "im",
    })
  }
  return fields
}

const birthday = (g: GooglePerson): Stated[] => {
  const [first] = recs(g.birthdays)
  const bd = rec(first?.date)
  if (typeof bd.month !== "number" || typeof bd.day !== "number") {
    return []
  }
  const mm = String(bd.month).padStart(2, "0")
  const dd = String(bd.day).padStart(2, "0")
  return [
    {
      kind: "birthday",
      value: typeof bd.year === "number" ? `${bd.year}-${mm}-${dd}` : `--${mm}-${dd}`,
    },
  ]
}

const otherFields = (g: GooglePerson): Stated[] => {
  const fields: Stated[] = []
  const [addr] = recs(g.addresses)
  const where = [s(addr?.city), s(addr?.region)].filter((x) => x !== "").join(", ")
  if (where !== "") {
    fields.push({ kind: "location", value: where })
  }
  for (const r of recs(g.relations)) {
    fields.push({ kind: "relation", value: s(r.person), label: s(r.type) })
  }
  for (const b of recs(g.biographies)) {
    if (s(b.value) !== "") {
      fields.push({ kind: "note", value: s(b.value) })
    }
  }
  return [...fields, ...birthday(g)]
}

/** The labels a contact is under, by their names: the user's own groups, not Google's. */
const groupFields = (g: GooglePerson, names: ReadonlyMap<string, string>): Stated[] =>
  recs(g.memberships).flatMap((m) => {
    const name = names.get(s(rec(m.contactGroupMembership).contactGroupResourceName))
    return name === undefined || name === SWITCH_LABEL
      ? []
      : [{ kind: "group" as const, value: name }]
  })

export const toRecord = (g: GooglePerson, groups: ReadonlyMap<string, string>): SourceRecord => ({
  source: "google",
  ref: { service: "google", value: g.resourceName },
  fields: [...nameFields(g), ...reachFields(g), ...otherFields(g), ...groupFields(g, groups)],
  user: true,
  create: true,
})

/** The label Switch puts the contacts it makes under. */
export const SWITCH_LABEL = "Switch"

/** The user's own labels: resource name → name. */
export const googleGroups = Effect.tryPromise({
  try: async () => {
    const r = rec(await api("GET", "/contactGroups?pageSize=1000"))
    const out = new Map<string, string>()
    for (const g of recs(r.contactGroups)) {
      if (g.groupType === "USER_CONTACT_GROUP" && s(g.name) !== "") {
        out.set(s(g.resourceName), s(g.name))
      }
    }
    return out
  },
  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
})

/** Every saved contact, as records, with their labels. */
export const googleBook = Effect.gen(function* reading() {
  const people = yield* googlePeople
  const groups = yield* googleGroups
  return people.map((g) => toRecord(g, groups))
})

/** A label's resource name, made if there isn't one. */
export const googleGroupNamed = (name: string) =>
  Effect.tryPromise({
    try: async () => {
      const r = rec(await api("GET", "/contactGroups?pageSize=1000"))
      const found = recs(r.contactGroups).find(
        (g) => g.groupType === "USER_CONTACT_GROUP" && s(g.name) === name,
      )
      if (found !== undefined) {
        return s(found.resourceName)
      }
      const made = rec(await api("POST", "/contactGroups", { contactGroup: { name } }))
      return s(made.resourceName)
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

/** Puts contacts under a label, or takes them out. */
export const googleGroupMembers = (
  group: string,
  add: readonly string[],
  remove: readonly string[],
) =>
  Effect.tryPromise({
    try: async () => {
      await api("POST", `/${group}/members:modify`, {
        resourceNamesToAdd: add,
        resourceNamesToRemove: remove,
      })
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

export const googleGet = (resource: string) =>
  Effect.tryPromise({
    try: async () => onePerson(await api("GET", `/${resource}?personFields=${FIELDS}`)),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

/** Replaces the named fields of a contact, given its etag: callers pass the old values plus ours. */
export const googleUpdate = (g: GooglePerson, fields: readonly string[], body: Json) =>
  Effect.tryPromise({
    try: async () =>
      onePerson(
        await api(
          "PATCH",
          `/${g.resourceName}:updateContact?updatePersonFields=${fields.join(",")}&personFields=${FIELDS}`,
          { ...body, etag: g.etag, resourceName: g.resourceName },
        ),
      ),
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

let switchGroup: string | null = null

const groupOf = async () => {
  if (switchGroup !== null) {
    return switchGroup
  }
  switchGroup = await Effect.runPromise(googleGroupNamed(SWITCH_LABEL))
  return switchGroup
}

/** A new contact, in the Switch label. */
export const googleCreate = (body: Json) =>
  Effect.tryPromise({
    try: async () => {
      const group = await groupOf()
      return onePerson(
        await api("POST", `/people:createContact?personFields=${FIELDS}`, {
          ...body,
          memberships: [{ contactGroupMembership: { contactGroupResourceName: group } }],
        }),
      )
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

/** A deleted contact made again from the copy kept when it went, under the labels it had. */
export const googleRestore = (copy: Json) =>
  Effect.tryPromise({
    try: async () => {
      const body: Json = {}
      for (const [k, v] of Object.entries(copy)) {
        if (!["resourceName", "etag", "metadata", "photos", "coverPhotos"].includes(k)) {
          body[k] = v
        }
      }
      body.memberships = recs(copy.memberships).filter((m) => isJson(m.contactGroupMembership))
      return onePerson(await api("POST", `/people:createContact?personFields=${FIELDS}`, body))
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

export const googleDelete = (resource: string) =>
  Effect.tryPromise({
    try: async () => {
      await api("DELETE", `/${resource}:deleteContact`)
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })
