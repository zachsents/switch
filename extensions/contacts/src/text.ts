// What the extension and its app both need, with nothing to run: matching a query to a person, and
// a field written the way people read it. No Bun, no log, so the app's view can import it.
import { parsePhoneNumberFromString } from "libphonenumber-js"
import type { CountryCode } from "libphonenumber-js"

/** A field as far as matching and showing go. */
export interface Fact {
  readonly kind: string
  readonly value: string
  readonly service?: string
}

/** A phone as its last ten digits when North American, else all its digits; "" for a short code. */
export const phoneKey = (raw: string) => {
  const d = raw.replaceAll(/\D/gu, "")
  if (d.length === 11 && d.startsWith("1")) {
    return d.slice(1)
  }
  if (d.length < 10) {
    return ""
  }
  return d
}

/**
 * A phone in E.164 (`+15550100000`), read in `region` when it has no country code; an extension
 * kept after `;ext=`. A number that can't be one (a short code) keeps its digits, anything else
 * stays as written.
 */
export const e164 = (raw: string, region: CountryCode = "US") => {
  const v = raw.trim().replace(/^00(?=[1-9])/u, "+")
  const p = parsePhoneNumberFromString(v, region)
  if (p?.isPossible() === true) {
    return p.ext === undefined ? p.number : `${p.number};ext=${p.ext}`
  }
  const digits = v.replaceAll(/\D/gu, "")
  return /^[\d\s().+-]+$/u.test(v) && digits !== "" ? digits : v
}

/** A phone as people read it: national within North America, else international. */
export const prettyPhone = (value: string) => {
  const p = parsePhoneNumberFromString(value.replace(";ext=", " ext. "), "US")
  if (p === undefined) {
    return value
  }
  return p.countryCallingCode === "1" ? p.formatNational() : p.formatInternational()
}

export const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .split(/[^a-z0-9@.+_-]+/u)
    .filter((t) => t !== "")

/** One typo: a letter off, in or out. */
const editsWithin = (a: string, b: string) => {
  if (Math.abs(a.length - b.length) > 1) {
    return false
  }
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
    } else {
      edits += 1
      if (edits > 1) {
        return false
      }
      if (a.length > b.length) {
        i += 1
      } else if (b.length > a.length) {
        j += 1
      } else {
        i += 1
        j += 1
      }
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

const NAMES = new Set(["name", "given", "family", "nickname"])

/** How well `q` fits someone's fields: every word must land in some field, prefix or digits. */
export const score = (fields: readonly Fact[], q: string) => {
  const words = tokens(q)
  if (words.length === 0) {
    return 0
  }
  const digits = q.replaceAll(/\D/gu, "")
  let total = 0
  const hay = fields.filter((f) => f.kind !== "ref" && f.kind !== "last_contact")
  if (
    digits.length >= 4 &&
    hay.some((f) => f.kind === "phone" && phoneKey(f.value).includes(digits))
  ) {
    return 10
  }
  for (const w of words) {
    let bestHit = 0
    for (const f of hay) {
      for (const t of tokens(f.value)) {
        const weight = NAMES.has(f.kind) ? 3 : 1
        if (t === w) {
          bestHit = Math.max(bestHit, 2 * weight)
        } else if (t.startsWith(w)) {
          bestHit = Math.max(bestHit, 1.5 * weight)
        } else if (w.length >= 4 && (t.includes(w) || editsWithin(t, w))) {
          bestHit = Math.max(bestHit, 0.8 * weight)
        }
      }
    }
    if (bestHit === 0) {
      return 0
    }
    total += bestHit
  }
  return total
}

export const LABELS: Readonly<Record<string, string>> = {
  name: "Name",
  given: "Given",
  family: "Family",
  initial: "Initial",
  nickname: "Nickname",
  type: "Type",
  group: "Label",
  relationship: "Relationship",
  phone: "Phone",
  email: "Email",
  handle: "Handle",
  company: "Company",
  role: "Role",
  location: "Location",
  birthday: "Birthday",
  relation: "Related",
  space: "Space",
  url: "Link",
  note: "Note",
  ref: "Record",
  last_contact: "Last",
}

export const SERVICES: Readonly<Record<string, string>> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  telegram: "Telegram",
  imessage: "iMessage",
  x: "X",
  facebook: "Facebook",
  github: "GitHub",
  tiktok: "TikTok",
  threads: "Threads",
  apple: "Apple",
  google: "Google",
}

/** Where a profile on each service lives, before the handle. */
export const SITES: Readonly<Record<string, string>> = {
  instagram: "https://www.instagram.com/",
  linkedin: "https://www.linkedin.com/in/",
  telegram: "https://t.me/",
  x: "https://x.com/",
  facebook: "https://www.facebook.com/",
  github: "https://github.com/",
  tiktok: "https://www.tiktok.com/@",
  threads: "https://www.threads.net/@",
}

/** A handle's profile page, when its service has one. */
export const profileUrl = (f: Fact & { readonly url?: string }) => {
  const site = SITES[f.service ?? ""]
  if (f.kind !== "handle" || site === undefined) {
    return null
  }
  return f.url ?? `${site}${f.value}`
}

/** A field's label: its kind's, or for a handle its service's. */
export const labelOf = (f: Fact) =>
  f.kind === "handle"
    ? (SERVICES[f.service ?? ""] ?? f.service ?? "Handle")
    : (LABELS[f.kind] ?? f.kind)

/** A day as people write it: Nov 20, 2026. */
export const day = (ms: number) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(Temporal.Now.timeZoneId())
    .toPlainDate()
    .toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" })

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** `1990-07-22` as Jul 22, 1990; `--07-22` as Jul 22. */
const birthday = (v: string) => {
  const m = /^(?<year>\d{4}|-)-(?<month>\d{2})-(?<day>\d{2})$/u.exec(v)
  const month = MONTHS[Number(m?.groups?.month) - 1]
  if (m?.groups === undefined || month === undefined) {
    return v
  }
  const md = `${month} ${Number(m.groups.day)}`
  return m.groups.year === "-" ? md : `${md}, ${m.groups.year}`
}

/** A field's value as people read it: a phone grouped, a time as its day. */
export const pretty = (f: Fact) => {
  if (f.kind === "phone") {
    return prettyPhone(f.value)
  }
  if (f.kind === "initial") {
    return `${f.value}.`
  }
  if (f.kind === "last_contact") {
    return day(Number(f.value))
  }
  if (f.kind === "birthday") {
    return birthday(f.value)
  }
  return f.value
}
