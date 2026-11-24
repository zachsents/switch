// Apple Contacts, through Contacts.app's scripting (JXA): it works headless where the Contacts
// framework needs a prompt a CLI can't show, and it reads and writes notes, which the framework
// keeps from anything without Apple's entitlement. osascript runs as this extension's child, so the
// access asked for is the host's that launched the extension (Switch Host), not a terminal's. It
// sees every account Contacts holds (iCloud, On My Mac, Exchange, Google and others) as one list.
import { Effect } from "effect"

import { isJson, parse, rec, recs, strings, text } from "./json.ts"
import type { SourceRecord } from "./merge.ts"
import type { Stated } from "./store.ts"

/** Long enough for a few thousand cards; a Contacts.app that hangs is restarted once. */
const TIMEOUT_MS = 180_000

const run = async (args: readonly string[], input: unknown) => {
  const proc = Bun.spawn(["/usr/bin/osascript", ...args], {
    env: { ...process.env, SWITCH_INPUT: JSON.stringify(input) },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => {
    proc.kill()
  }, TIMEOUT_MS)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(timer)
  return { out, err, code, hung: proc.signalCode !== null }
}

/** A Contacts.app that stopped answering: quit hard, so the next call starts it fresh. */
const restartContacts = async () => {
  await Bun.spawn(["/usr/bin/pkill", "-x", "Contacts"]).exited
  await Bun.sleep(2000)
}

const script = (lang: "JavaScript", body: string) => ["-l", lang, "-e", body]

const jxa = (body: string, input: unknown = null) =>
  Effect.tryPromise({
    try: async () => {
      let r = await run(script("JavaScript", body), input)
      if (r.hung) {
        await restartContacts()
        r = await run(script("JavaScript", body), input)
      }
      if (r.hung) {
        throw new Error("Contacts didn't answer")
      }
      if (r.code !== 0) {
        throw new Error(`Contacts: ${r.err.trim().slice(0, 300)}`)
      }
      return parse(r.out)
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  })

const INPUT = `JSON.parse($.NSProcessInfo.processInfo.environment.objectForKey("SWITCH_INPUT").js)`

/** The group Switch puts the cards it makes in: its own, not one of the user's labels. */
export const SWITCH_GROUP = "Switch"

const READ = `
const C = Application("Contacts"); const p = C.people;
const pick = (f, d) => { try { return f() } catch (e) { return d } };
const groups = pick(() => C.groups().map((g) => ({ name: g.name(), ids: g.people.id() })), []);
const me = pick(() => { const m = C.myCard(); return { id: m.id(), related: m.relatedNames.value(), labels: m.relatedNames.label() } }, null);
JSON.stringify({
  ids: p.id(), first: p.firstName(), middle: p.middleName(), last: p.lastName(), nick: p.nickname(),
  org: p.organization(), title: p.jobTitle(), company: p.company(), note: p.note(),
  phones: p.phones.value(), phoneLabels: p.phones.label(), emails: p.emails.value(), emailLabels: p.emails.label(),
  urls: p.urls.value(), urlLabels: p.urls.label(), city: p.addresses.city(), state: p.addresses.state(),
  related: p.relatedNames.value(), relatedLabels: p.relatedNames.label(),
  socialUser: pick(() => p.socialProfiles.userName(), []), socialSvc: pick(() => p.socialProfiles.serviceName(), []),
  birth: p.birthDate(), groups, me,
})`

const nested = (v: unknown): (string | null)[][] =>
  Array.isArray(v) ? v.map((x: unknown) => strings(x)) : []

/** Contacts' columns, one entry per card. */
const dumpOf = (raw: unknown) => {
  const d = rec(raw)
  return {
    ids: strings(d.ids),
    first: strings(d.first),
    middle: strings(d.middle),
    last: strings(d.last),
    nick: strings(d.nick),
    org: strings(d.org),
    title: strings(d.title),
    company: Array.isArray(d.company) ? d.company.map((x: unknown) => x === true) : [],
    note: strings(d.note),
    phones: nested(d.phones),
    phoneLabels: nested(d.phoneLabels),
    emails: nested(d.emails),
    emailLabels: nested(d.emailLabels),
    urls: nested(d.urls),
    urlLabels: nested(d.urlLabels),
    city: nested(d.city),
    state: nested(d.state),
    related: nested(d.related),
    relatedLabels: nested(d.relatedLabels),
    socialUser: nested(d.socialUser),
    socialSvc: nested(d.socialSvc),
    birth: strings(d.birth),
  }
}
type Dump = ReturnType<typeof dumpOf>

/** Apple's labels come as `_$!<Mobile>!$_`. */
export const appleLabel = (raw: string | null | undefined) =>
  (raw ?? "")
    .replace(/^_\$!</u, "")
    .replace(/>!\$_$/u, "")
    .toLowerCase()

const SOCIAL: Readonly<Record<string, string>> = {
  instagram: "instagram",
  twitter: "x",
  facebook: "facebook",
  linkedin: "linkedin",
  telegram: "telegram",
  tiktok: "tiktok",
}

const PROFILE =
  /^(?:https?:\/\/)?(?:www\.)?(?<site>instagram\.com|linkedin\.com\/in|t\.me|x\.com|twitter\.com|facebook\.com|tiktok\.com\/@|threads\.net\/@|github\.com)\/?(?<user>[^/?#@]+)/iu

const serviceOf = (site: string) => {
  if (site.startsWith("instagram")) {
    return "instagram"
  }
  if (site.startsWith("linkedin")) {
    return "linkedin"
  }
  if (site === "t.me") {
    return "telegram"
  }
  if (site.startsWith("facebook")) {
    return "facebook"
  }
  if (site.startsWith("tiktok")) {
    return "tiktok"
  }
  if (site.startsWith("threads")) {
    return "threads"
  }
  if (site.startsWith("github")) {
    return "github"
  }
  return "x"
}

/** A profile URL as a handle on its service, if it's one we know. */
export const handleOfUrl = (url: string): Stated | null => {
  const m = PROFILE.exec(url)
  if (!m) {
    return null
  }
  const site = (m.groups?.site ?? "").toLowerCase()
  return { kind: "handle", value: m.groups?.user ?? "", service: serviceOf(site), url }
}

const clean = (s: string | null | undefined) => (s ?? "").trim()

const nameFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  const first = clean(d.first[i])
  const last = clean(d.last[i])
  const middle = clean(d.middle[i])
  const org = clean(d.org[i])
  const company = d.company[i] === true
  const full = [first, middle, last].filter((x) => x !== "").join(" ")
  if (company && org !== "") {
    fields.push({ kind: "name", value: org }, { kind: "type", value: "company" })
  } else if (full !== "") {
    fields.push({ kind: "name", value: full })
  }
  if (first !== "") {
    fields.push({ kind: "given", value: first })
  }
  if (last !== "") {
    fields.push({ kind: "family", value: last })
  }
  const nick = clean(d.nick[i])
  if (nick !== "") {
    fields.push({ kind: "nickname", value: nick })
  }
  if (org !== "") {
    fields.push({ kind: "company", value: org })
  }
  const title = clean(d.title[i])
  if (title !== "") {
    fields.push({ kind: "role", value: title })
  }
  return fields
}

/** Values Apple keeps several of, each with its label. */
const reachFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  for (const [j, v] of (d.phones[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "phone", value: v, label: appleLabel(d.phoneLabels[i]?.[j]) })
    }
  }
  for (const [j, v] of (d.emails[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "email", value: v, label: appleLabel(d.emailLabels[i]?.[j]) })
    }
  }
  for (const [j, v] of (d.urls[i] ?? []).entries()) {
    if (v !== null) {
      fields.push(
        handleOfUrl(v) ?? { kind: "url", value: v, label: appleLabel(d.urlLabels[i]?.[j]) },
      )
    }
  }
  return fields
}

const linkFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  for (const [j, v] of (d.socialUser[i] ?? []).entries()) {
    const svc = SOCIAL[appleLabel(d.socialSvc[i]?.[j])]
    if (v !== null && svc !== undefined) {
      fields.push({ kind: "handle", value: v, service: svc })
    }
  }
  for (const [j, v] of (d.related[i] ?? []).entries()) {
    if (v !== null) {
      fields.push({ kind: "relation", value: v, label: appleLabel(d.relatedLabels[i]?.[j]) })
    }
  }
  return fields
}

const otherFields = (d: Dump, i: number): Stated[] => {
  const fields: Stated[] = []
  const city = clean(d.city[i]?.[0])
  const state = clean(d.state[i]?.[0])
  if (city !== "" || state !== "") {
    fields.push({ kind: "location", value: [city, state].filter((x) => x !== "").join(", ") })
  }
  const note = clean(d.note[i])
  if (note !== "") {
    fields.push({ kind: "note", value: note })
  }
  const birth = d.birth[i]
  if (birth !== null && birth !== undefined) {
    // Apple keeps a birthday without a year as 1604.
    const date = birth.slice(0, 10)
    fields.push({ kind: "birthday", value: date.startsWith("1604-") ? `-${date.slice(4)}` : date })
  }
  return fields
}

/** Each group's name and the cards in it. */
const groupsOf = (raw: unknown) =>
  recs(rec(raw).groups).map((g) => ({
    name: text(g.name),
    ids: strings(g.ids).filter((x) => x !== null),
  }))

/** Who the Me card names, and how they're related to the user. */
export interface Related {
  readonly label: string
  readonly value: string
}

const meOf = (raw: unknown): { id: string; related: Related[] } | null => {
  const m = rec(raw).me
  if (!isJson(m) || typeof m.id !== "string") {
    return null
  }
  const labels = strings(m.labels)
  const related = strings(m.related).flatMap((v, i) =>
    v === null ? [] : [{ value: v, label: appleLabel(labels[i]) }],
  )
  return { id: m.id, related }
}

export interface AppleBook {
  readonly records: SourceRecord[]
  /** The user's own card, and the people it names as related to them. */
  readonly me: { id: string; related: Related[] } | null
}

export const appleBook = Effect.map(jxa(READ), (raw): AppleBook => {
  const d = dumpOf(raw)
  const labels = new Map<string, string[]>()
  for (const g of groupsOf(raw)) {
    if (g.name !== SWITCH_GROUP && g.name !== "") {
      for (const id of g.ids) {
        labels.set(id, [...(labels.get(id) ?? []), g.name])
      }
    }
  }
  const records = d.ids.flatMap((id, i): SourceRecord[] => {
    if (id === null) {
      return []
    }
    const other = otherFields(d, i)
    const links = linkFields(d, i)
    const fields = [
      ...nameFields(d, i),
      ...reachFields(d, i),
      ...links.filter((f) => f.kind !== "relation"),
      ...other.filter((f) => f.kind === "location"),
      ...links.filter((f) => f.kind === "relation"),
      ...other.filter((f) => f.kind !== "location"),
      ...(labels.get(id) ?? []).map((value): Stated => ({ kind: "group", value })),
    ]
    return [
      { source: "apple", ref: { service: "apple", value: id }, fields, user: true, create: true },
    ]
  })
  return { records, me: meOf(raw) }
})

/** Every card as a vCard, for the backup. */
export const appleVcards = Effect.map(
  jxa(`JSON.stringify(Application("Contacts").people.vcard())`),
  (raw) =>
    strings(raw)
      .filter((v) => v !== null)
      .join("\n"),
)

/** Every card as read for import, notes and groups included: the backup's other half. */
export const appleDump = jxa(READ)

/** A value Apple keeps several of, with its label. */
export interface Labelled {
  readonly value: string
  readonly label: string
}

/** One card's values now, to check before writing. */
export interface AppleCard {
  readonly id: string
  readonly first: string
  readonly last: string
  readonly nick: string
  readonly org: string
  readonly title: string
  readonly note: string
  readonly company: boolean
  readonly phones: Labelled[]
  readonly emails: Labelled[]
  readonly urls: Labelled[]
  readonly groups: string[]
}

// Every card at once, a column a call: far quicker than a card at a time.
const CARDS = `
const C = Application("Contacts"); const p = C.people;
const pick = (f, d) => { try { return f() } catch (e) { return d } };
JSON.stringify({ ids: p.id(), first: p.firstName(), last: p.lastName(), nick: p.nickname(), org: p.organization(),
  title: p.jobTitle(), note: p.note(), company: p.company(), phones: p.phones.value(), phoneLabels: p.phones.label(),
  emails: p.emails.value(), emailLabels: p.emails.label(), urls: p.urls.value(), urlLabels: p.urls.label(),
  groups: pick(() => C.groups().map((g) => ({ name: g.name(), ids: g.people.id() })), []) })`

const pairs = (values: (string | null)[] | undefined, labels: (string | null)[] | undefined) =>
  (values ?? []).flatMap((v, i): Labelled[] =>
    v === null ? [] : [{ value: v, label: appleLabel(labels?.[i]) }],
  )

/** The cards with these ids, as they are now. */
export const appleCards = (ids: readonly string[]) =>
  Effect.map(jxa(CARDS), (raw): AppleCard[] => {
    const d = dumpOf(raw)
    const wanted = new Set(ids)
    const groups = groupsOf(raw).filter((g) => g.name !== SWITCH_GROUP)
    return d.ids.flatMap((id, i): AppleCard[] =>
      id === null || !wanted.has(id)
        ? []
        : [
            {
              id,
              first: d.first[i] ?? "",
              last: d.last[i] ?? "",
              nick: d.nick[i] ?? "",
              org: d.org[i] ?? "",
              title: d.title[i] ?? "",
              note: d.note[i] ?? "",
              company: d.company[i] === true,
              phones: pairs(d.phones[i], d.phoneLabels[i]),
              emails: pairs(d.emails[i], d.emailLabels[i]),
              urls: pairs(d.urls[i], d.urlLabels[i]),
              groups: groups.filter((g) => g.ids.includes(id)).map((g) => g.name),
            },
          ],
    )
  })

export type AppleSingle = "first" | "last" | "nick" | "org" | "title" | "note"
export type AppleList = "phones" | "emails" | "urls"

/** What to do to one card. Values are matched as the card writes them. */
export interface AppleEdit {
  /** Absent: a new card, in the Switch group. */
  readonly id?: string
  /** Set these; "" clears. */
  readonly set?: Readonly<Partial<Record<AppleSingle, string>>>
  /** Clear these, if they still hold what Switch put there. */
  readonly clear?: Readonly<Partial<Record<AppleSingle, string>>>
  readonly company?: boolean
  readonly add?: Readonly<Partial<Record<AppleList, readonly Labelled[]>>>
  readonly replace?: Readonly<
    Partial<Record<AppleList, readonly { readonly from: string; readonly to: string }[]>>
  >
  readonly remove?: Readonly<Partial<Record<AppleList, readonly string[]>>>
  readonly groups?: { readonly add?: readonly string[]; readonly remove?: readonly string[] }
  /** Related names on this card (the Me card, for who people are to the user). */
  readonly related?: { readonly add?: readonly Related[]; readonly remove?: readonly Related[] }
  /** Delete the card. */
  readonly delete?: boolean
}

const EDIT = `
const C = Application("Contacts");
const edits = ${INPUT};
const props = { first: "firstName", last: "lastName", nick: "nickname", org: "organization", title: "jobTitle", note: "note" };
const kinds = { phones: ["phones", "Phone"], emails: ["emails", "Email"], urls: ["urls", "Url"] };
const groupNamed = (name) => {
  const found = C.groups.whose({ name })();
  if (found.length > 0) return found[0];
  C.groups.push(C.Group({ name })); C.save(); return C.groups.whose({ name })()[0];
};
const copyOf = (p) => { try { return JSON.stringify({ vcard: p.vcard(), note: p.note() || "",
  groups: C.groups().filter((g) => g.people.id().includes(p.id())).map((g) => g.name()) }) } catch (e) { return "" } };
const out = [];
for (const e of edits) {
  try {
    let p;
    if (e.id) { p = C.people.byId(e.id); p.id(); } else { p = C.Person({}); C.people.push(p); }
    if (e.delete) { const copy = copyOf(p); C.delete(p); C.save(); out.push({ id: e.id, ok: true, copy }); continue; }
    for (const [k, v] of Object.entries(e.set || {})) { p[props[k]] = v; }
    for (const [k, v] of Object.entries(e.clear || {})) { const cur = p[props[k]]() || ""; if (cur === v) p[props[k]] = ""; }
    if (e.company === true || e.company === false) p.company = e.company;
    for (const [k, list] of Object.entries(e.replace || {})) {
      const items = p[kinds[k][0]]();
      for (const r of list) { const hit = items.find((it) => it.value() === r.from); if (hit) hit.value = r.to; }
    }
    for (const [k, list] of Object.entries(e.remove || {})) {
      const items = p[kinds[k][0]]();
      for (let i = items.length - 1; i >= 0; i--) { if (list.includes(items[i].value())) C.delete(items[i]); }
    }
    for (const [k, list] of Object.entries(e.add || {})) {
      const [coll, make] = kinds[k];
      const have = p[coll].value();
      for (const item of list) { if (!have.includes(item.value)) p[coll].push(C[make]({ label: item.label, value: item.value })); }
    }
    if (e.related) {
      const items = p.relatedNames();
      for (const r of e.related.remove || []) {
        for (let i = items.length - 1; i >= 0; i--) { if (items[i].value() === r.value) C.delete(items[i]); }
      }
      const have = p.relatedNames.value();
      for (const r of e.related.add || []) { if (!have.includes(r.value)) p.relatedNames.push(C.RelatedName({ label: r.label, value: r.value })); }
    }
    C.save();
    if (!e.id) { C.add(p, { to: groupNamed("${SWITCH_GROUP}") }); C.save(); }
    for (const name of (e.groups && e.groups.add) || []) { C.add(p, { to: groupNamed(name) }); }
    for (const name of (e.groups && e.groups.remove) || []) { const g = C.groups.whose({ name })(); if (g.length > 0) C.remove(p, { from: g[0] }); }
    if (e.groups) C.save();
    out.push({ id: p.id(), ok: true });
  } catch (err) { out.push({ id: e.id || null, ok: false, error: String(err) }); }
}
JSON.stringify(out)`

export interface EditResult {
  readonly id: string | null
  readonly ok: boolean
  readonly error?: string
  /** A deleted card's vCard, note and groups, as JSON, to bring it back. */
  readonly copy?: string
}

export const appleEdit = (edits: readonly AppleEdit[]) =>
  Effect.map(jxa(EDIT, edits), (raw) =>
    recs(raw).map((r): EditResult => ({
      id: typeof r.id === "string" ? r.id : null,
      ok: r.ok === true,
      ...(typeof r.error === "string" ? { error: r.error } : {}),
      ...(typeof r.copy === "string" ? { copy: r.copy } : {}),
    })),
  )

/** The Me card's id, if there is one. */
export const appleMe = Effect.map(
  jxa(
    `(() => { try { return JSON.stringify(Application("Contacts").myCard().id()) } catch (e) { return "null" } })()`,
  ),
  (raw) => (typeof raw === "string" ? raw : null),
)

/** The related names on one card, as they are now. */
export const appleRelated = (id: string) =>
  Effect.map(
    jxa(
      `const p = Application("Contacts").people.byId(${INPUT}); JSON.stringify({ v: p.relatedNames.value(), l: p.relatedNames.label() })`,
      id,
    ),
    (raw): Related[] => {
      const r = rec(raw)
      const labels = strings(r.l)
      return strings(r.v).flatMap((v, i) =>
        v === null ? [] : [{ value: v, label: appleLabel(labels[i]) }],
      )
    },
  )

// A deleted card brought back: the Contacts framework reads its vCard into a new card (scripting
// can't), then scripting puts its note and groups back.
const RESTORE = `
ObjC.import("Contacts");
const input = ${INPUT};
const data = $(input.vcard).dataUsingEncoding($.NSUTF8StringEncoding);
const cards = $.CNContactVCardSerialization.contactsWithDataError(data, $());
const contact = cards.objectAtIndex(0).mutableCopy;
const store = $.CNContactStore.alloc.init;
const save = $.CNSaveRequest.alloc.init;
save.addContactToContainerWithIdentifier(contact, $());
const ok = store.executeSaveRequestError(save, $());
JSON.stringify(ok ? contact.identifier.js : null)`

/** Brings back a card from the copy taken when it was deleted; its new id. */
export const appleRestore = (copy: string) =>
  Effect.gen(function* restoring() {
    const c = rec(parse(copy))
    const vcard = text(c.vcard)
    const made = yield* jxa(RESTORE, { vcard })
    if (typeof made !== "string") {
      return yield* Effect.fail(new Error("Contacts didn't take the card back"))
    }
    const id = made.includes(":") ? made : `${made}:ABPerson`
    const note = text(c.note)
    const groups = strings(c.groups).filter((g) => g !== null)
    yield* appleEdit([{ id, ...(note === "" ? {} : { set: { note } }), groups: { add: groups } }])
    return id
  })
