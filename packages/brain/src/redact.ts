// Secrets out of everything Switch keeps, shows or sends: the user's rule is that a secret is never
// in a log, a chat, a memory or a screenshot. A secret is replaced by its name ("[Chase password]",
// "[card ••5269]", "[github-pat]"), never by any part of its value but a card's last four. Two kinds:
// - Known values, as fingerprints, so a value stays in the process that holds it (the vault's own,
//   `redactions/set`; this process's credentials, `ownSecret`). A set is a multi-pattern Rabin–Karp
//   (Karp and Rabin, 1987): a rolling hash over every WINDOW characters, cut to BUCKETS so a prefix
//   names nothing, and each hit checked against SHA-256(salt ‖ the form). All-digit forms count
//   only between non-digits, numbers written in groups ("4111 1111 …", "123-45-6789") by their
//   digits, and a security code or PIN, too short to know alone, after its label.
// - Known shapes: gitleaks' ruleset (gitleaks.toml, github.com/gitleaks/gitleaks v8.30.1's
//   config/gitleaks.toml, MIT, Copyright (c) 2019 its author, as its LICENSE says), read as its
//   detector reads it: keywords first, the secret group, entropy and allowlists; and card numbers,
//   an issuer's prefix (regular-expressions.info's card pattern) that passes Luhn.
import { randomInt } from "node:crypto"
import { Schema } from "effect"

import gitleaks from "./gitleaks.toml"

/** The rolling hash's window: no known form is shorter. */
export const WINDOW = 6
/** A prefix's hash is kept mod this: enough to skip most windows, too little to name one. */
export const BUCKETS = 2 ** 20

/**
 * Known values, by fingerprint. For each form a value can take (itself, its base64, URL-encoded,
 * JSON-escaped): `p`, Σ cᵢ·base^(WINDOW−1−i) mod 2^32 over the code points at its first WINDOW
 * UTF-16 indexes (`codePointAt`), mod BUCKETS, never negative; `n`, its length in UTF-16 units; `h`,
 * the first 32 hex digits of SHA-256(salt ‖ its UTF-8). `digits`: a number written in groups, by its
 * digits alone (`n` of them, `h` the same way).
 */
export const Fingerprints = Schema.Struct({
  /** Base64, random for each set. */
  salt: Schema.String,
  /** Odd, random for each set, below 2^31. */
  base: Schema.Int,
  entries: Schema.Array(
    Schema.Struct({ p: Schema.Int, n: Schema.Int, h: Schema.String, label: Schema.String }),
  ),
  digits: Schema.Array(Schema.Struct({ n: Schema.Int, h: Schema.String, label: Schema.String })),
})
export type Fingerprints = typeof Fingerprints.Type

interface Entry {
  readonly n: number
  readonly h: string
  readonly label: string
}

interface Known {
  readonly salt: Uint8Array
  readonly base: number
  /** base^(WINDOW−1) mod 2^32: what the character leaving the window weighed. */
  readonly top: number
  /** 1 for each prefix an entry has: most windows end here. */
  readonly seen: Uint8Array
  /** Longest first. */
  readonly buckets: Map<number, Entry[]>
  readonly digits: Map<string, string>
  readonly digitLengths: Set<number>
}

const hashOf = (salt: Uint8Array, text: string) =>
  new Bun.CryptoHasher("sha256").update(salt).update(text).digest("hex").slice(0, 32)

const codeAt = (text: string, i: number) => text.codePointAt(i) ?? 0

/** `x` mod 2^32, as a signed 32-bit integer: the engine's own integer arithmetic, fast. */
const wrap = (x: number) => Math.imul(x, 1)

const bucketOf = (h: number) => ((h % BUCKETS) + BUCKETS) % BUCKETS

/** A form's prefix. */
const prefixOf = (form: string, base: number) => {
  let h = 0
  for (let i = 0; i < WINDOW; i += 1) {
    h = wrap(Math.imul(h, base) + codeAt(form, i))
  }
  return bucketOf(h)
}

const add = (known: Known, p: number, e: Entry) => {
  const list = known.buckets.get(p) ?? []
  if (!list.some((x) => x.h === e.h)) {
    list.push(e)
    list.sort((a, b) => b.n - a.n)
  }
  known.buckets.set(p, list)
  known.seen[p] = 1
}

/** A name safe wherever it lands: inside JSON, and in brackets. */
const named = (label: string) => label.replaceAll(/["\\[\]\p{Cc}]/gu, "").trim() || "secret"

const compile = (set: Fingerprints): Known => {
  let top = 1
  for (let i = 1; i < WINDOW; i += 1) {
    top = Math.imul(top, set.base)
  }
  const known: Known = {
    salt: Buffer.from(set.salt, "base64"),
    base: set.base,
    top,
    seen: new Uint8Array(BUCKETS),
    buckets: new Map(),
    digits: new Map(set.digits.map((d) => [d.h, named(d.label)])),
    digitLengths: new Set(set.digits.map((d) => d.n)),
  }
  for (const e of set.entries) {
    add(known, e.p, { n: e.n, h: e.h, label: named(e.label) })
  }
  return known
}

const sets = new Map<string, Known>()

/** The fingerprints `from` (an extension) knows its secrets by, in place of its last. */
export const knowSecrets = (from: string, set: Fingerprints) => {
  sets.set(from, compile(set))
}

/** The forms a value takes in text: as it is, base64, URL-encoded, JSON-escaped. */
const formsOf = (value: string) => [
  ...new Set([
    value,
    Buffer.from(value).toString("base64"),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]),
]

/** This process's own secrets, under its own salt and base. */
const own = compile({
  salt: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
  base: randomInt(2 ** 30) * 2 + 1,
  entries: [],
  digits: [],
})
sets.set("core", own)

/** One of this process's own secrets (a credential it holds), by its name: "Switch key". */
export const ownSecret = (value: string, label: string) => {
  if (value.length >= WINDOW) {
    for (const form of formsOf(value)) {
      add(own, prefixOf(form, own.base), {
        n: form.length,
        h: hashOf(own.salt, form),
        label: named(label),
      })
    }
  }
}

// ——— Shapes ———

interface Allow {
  readonly and: boolean
  readonly target: "secret" | "match" | "line"
  readonly regexes: readonly RegExp[]
  readonly stopwords: readonly string[]
  /** It names paths or commits, which text has none of: under AND, it never allows. */
  readonly elsewhere: boolean
}

interface Shape {
  readonly id: string
  readonly re: RegExp
  readonly keywords: readonly string[]
  readonly entropy: number
  readonly group: number
  readonly allow: readonly Allow[]
  readonly generic: boolean
  /** How far back its match reaches over name characters before what `re` finds (`opening`). */
  readonly back: number
}

const AllowToml = Schema.Struct({
  condition: Schema.optionalKey(Schema.String),
  regexTarget: Schema.optionalKey(Schema.String),
  regexes: Schema.optionalKey(Schema.Array(Schema.String)),
  stopwords: Schema.optionalKey(Schema.Array(Schema.String)),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
  commits: Schema.optionalKey(Schema.Array(Schema.String)),
})
const RulesToml = Schema.Struct({
  allowlist: AllowToml,
  rules: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      regex: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
      keywords: Schema.optionalKey(Schema.Array(Schema.String)),
      entropy: Schema.optionalKey(Schema.Number),
      secretGroup: Schema.optionalKey(Schema.Int),
      allowlists: Schema.optionalKey(Schema.Array(AllowToml)),
    }),
  ),
})

const POSIX: Readonly<Record<string, string>> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  space: "\\s",
  xdigit: "0-9a-fA-F",
  word: "\\w",
}

/** The end of the group open at `from` (its `)`), or the pattern's end; and its top-level `|`s. */
const groupEnd = (s: string, from: number) => {
  let depth = 0
  let inClass = false
  const bars: number[] = []
  for (let i = from; i < s.length; i += 1) {
    const c = s[i]
    if (c === "\\") {
      i += 1
    } else if (inClass) {
      if (c === "]") {
        inClass = false
      }
    } else if (c === "[") {
      inClass = true
      if (s[i + 1] === "]" || (s[i + 1] === "^" && s[i + 2] === "]")) {
        i += s[i + 1] === "^" ? 2 : 1
      }
    } else if (c === "(") {
      depth += 1
    } else if (c === ")") {
      if (depth === 0) {
        return { end: i, bars }
      }
      depth -= 1
    } else if (c === "|" && depth === 0) {
      bars.push(i)
    }
  }
  return { end: s.length, bars }
}

/**
 * A Go (RE2) pattern as JavaScript's: a leading `(?i)` is the `i` flag, one further in is `(?i:…)`
 * over the rest of its group (each alternative), `(?P<x>` is `(?<x>`, `\z` is `$`, `[:alnum:]` its
 * range. Lookarounds and the rest are the same in both.
 */
const fromGo = (pattern: string) => {
  let s = pattern
  let flags = ""
  if (s.startsWith("(?i)")) {
    s = s.slice(4)
    flags = "i"
  }
  s = s
    .replaceAll("(?P<", "(?<")
    .replaceAll("\\z", "$")
    .replaceAll(/\[:(?<name>\w+):\]/gu, (all, name: string) => POSIX[name] ?? all)
  for (let at = s.lastIndexOf("(?i)"); at > 0; at = s.lastIndexOf("(?i)", at - 1)) {
    s = caseless(s, at)
  }
  return { source: s, flags }
}

/** `s` with its `(?i)` at `at` as `(?i:…)` over each alternative left in its group. */
const caseless = (s: string, at: number) => {
  const rest = at + 4
  const { end, bars } = groupEnd(s, rest)
  const parts: string[] = []
  let from = rest
  for (const b of [...bars, end]) {
    parts.push(`(?i:${s.slice(from, b)})`)
    from = b + 1
  }
  return `${s.slice(0, at)}${parts.join("|")}${s.slice(end)}`
}

const regexOf = (pattern: string, extra = "") => {
  const { source, flags } = fromGo(pattern)
  return new RegExp(source, flags + extra)
}

const allowOf = (a: typeof AllowToml.Type): Allow => ({
  and: a.condition?.toUpperCase() === "AND",
  target: a.regexTarget === "match" || a.regexTarget === "line" ? a.regexTarget : "secret",
  regexes: (a.regexes ?? []).map((r) => regexOf(r)),
  stopwords: (a.stopwords ?? []).map((w) => w.toLowerCase()),
  elsewhere: (a.paths ?? []).length > 0 || (a.commits ?? []).length > 0,
})

const RUN = String.raw`[\w.-]{0,50}?`
const NAME_CHAR = /[\w.-]/u

/**
 * A rule that opens on gitleaks' lazy run of name characters (`[\w.-]{0,50}?`, twice in a few) is
 * run from what follows, and its match reaches back over that run after: the same match, without
 * a backtracking engine trying the run at every place, as RE2 never does.
 */
const opening = (regex: string) => {
  if (regex.startsWith(`(?i)${RUN}`)) {
    return { regex: `(?i)${regex.slice(4 + RUN.length)}`, back: 50 }
  }
  if (regex.startsWith(`${RUN}(?i:${RUN}`)) {
    return { regex: `(?i:${regex.slice(2 * RUN.length + 4)}`, back: 100 }
  }
  return { regex, back: 0 }
}

const loadShapes = () => {
  const toml = Schema.decodeUnknownSync(RulesToml)(gitleaks)
  const global = allowOf(toml.allowlist)
  const shapes: Shape[] = []
  for (const r of toml.rules) {
    // A rule bound to a file's path has nothing to read in text.
    if (r.regex !== undefined && r.path === undefined) {
      const { regex, back } = opening(r.regex)
      shapes.push({
        id: r.id,
        re: regexOf(regex, "gd"),
        back,
        keywords: (r.keywords ?? []).map((k) => k.toLowerCase()),
        entropy: r.entropy ?? 0,
        group: r.secretGroup ?? 0,
        allow: [global, ...(r.allowlists ?? []).map(allowOf)],
        generic: r.id.startsWith("generic"),
      })
    }
  }
  // A credential in a link (`?token=…&`), which the generic rule, ended by a quote, a space or the
  // line, misses: its words, entropy and allowlists, ended by `&` or `#` as well.
  const generic = shapes.find((s) => s.id === "generic-api-key")
  if (generic !== undefined) {
    shapes.push({
      ...generic,
      id: "link-token",
      re: regexOf(
        String.raw`(?i)[?&#;](?:[\w.-]{0,50}?(?:access|auth|(?-i:[Aa]pi|API)|credential|creds|key|passw(?:or)?d|secret|token)[\w.-]{0,20})=([\w.~%+/=-]{10,300})(?:[&#;\s'"\x60<>)\]]|$)`,
        "gd",
      ),
    })
  }
  // Which rules to run, as gitleaks picks them, in one pass: the longest keyword at each place, the
  // engine's own alternation (faster here than an Aho–Corasick in JavaScript), and those it begins with.
  const words = [...new Set(shapes.flatMap((s) => s.keywords))].toSorted(
    (a, b) => b.length - a.length,
  )
  const escaped = words.map((w) => w.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
  const keywords = new RegExp(`(?=(${escaped.join("|")}))`, "gu")
  const within = new Map(words.map((w) => [w, words.filter((x) => w.startsWith(x))]))
  return { shapes, keywords, within }
}

let loaded: ReturnType<typeof loadShapes> | null = null
const shapesNow = () => {
  loaded ??= loadShapes()
  return loaded
}

/** Shannon entropy in bits per character, as gitleaks measures a secret. */
const entropyOf = (s: string) => {
  const counts = new Map<string, number>()
  for (const c of s) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }
  let bits = 0
  for (const n of counts.values()) {
    const p = n / s.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const allowed = (a: Allow, secret: string, match: string, line: string) => {
  const target = { secret, match, line }[a.target]
  const lower = secret.toLowerCase()
  const regexHit = target !== "" && a.regexes.some((r) => r.test(target))
  const stopHit = secret !== "" && a.stopwords.some((w) => lower.includes(w))
  if (!a.and) {
    return regexHit || stopHit
  }
  const checks = [
    ...(a.elsewhere ? [false] : []),
    ...(a.regexes.length > 0 ? [regexHit] : []),
    ...(a.stopwords.length > 0 ? [stopHit] : []),
  ]
  return checks.length > 0 && checks.every(Boolean)
}

// regular-expressions.info's card numbers (Visa, Mastercard, Amex, Diners, Discover, JCB), on
// digits alone.
const ISSUER =
  /^(?:4[0-9]{12}(?:[0-9]{3})?|(?:5[1-5][0-9]{2}|222[1-9]|22[3-9][0-9]|2[3-6][0-9]{2}|27[01][0-9]|2720)[0-9]{12}|3[47][0-9]{13}|3(?:0[0-5]|[68][0-9])[0-9]{11}|6(?:011|5[0-9]{2})[0-9]{12}|(?:2131|1800|35\d{3})\d{11})$/u

/** Whether a run of digits passes the Luhn check, as card numbers do. */
const luhn = (digits: string) => {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) {
        d -= 9
      }
    }
    sum += d
  }
  return sum % 10 === 0
}

/** Digits in groups, or alone, never part of a word or a decimal. */
const NUMBER = /(?<![\w.])\d+(?:[ -]\d+)*(?![\w]|\.\d)/gu
/** A number after its label: how a known security code or PIN, too short to know alone, is written. */
const LABELLED =
  /(?<![\w/-])(?:cvc2?|cvv2?|security code|pin)(?:[ \t]*[:#=][ \t]*|[ \t]+)(?<value>\d{3,12})(?![\w]|\.\d)/giu

interface Span {
  readonly start: number
  readonly end: number
  readonly label: string
  /** Where two start together, the lower names them: a known value, a provider's shape, a generic one. */
  readonly rank: 0 | 1 | 2
}

const isDigits = (s: string) => /^\d+$/u.test(s)

const knownIn = (text: string, out: Span[]) => {
  for (const k of sets.values()) {
    if (k.buckets.size > 0 && text.length >= WINDOW) {
      let h = 0
      for (let i = 0; i < WINDOW - 1; i += 1) {
        h = wrap(Math.imul(h, k.base) + codeAt(text, i))
      }
      for (let i = 0; i + WINDOW <= text.length; i += 1) {
        if (i > 0) {
          h = wrap(h - Math.imul(codeAt(text, i - 1), k.top))
        }
        h = wrap(Math.imul(h, k.base) + codeAt(text, i + WINDOW - 1))
        const p = bucketOf(h)
        if (k.seen[p] === 1) {
          matchAt(k, text, i, k.buckets.get(p) ?? [], out)
        }
      }
    }
  }
}

/** The longest entry at `i` that's there, checked by its hash; all-digit ones only between non-digits. */
const matchAt = (k: Known, text: string, i: number, entries: readonly Entry[], out: Span[]) => {
  for (const e of entries) {
    const slice = text.slice(i, i + e.n)
    if (
      slice.length === e.n &&
      hashOf(k.salt, slice) === e.h &&
      !(isDigits(slice) && (isDigits(text[i - 1] ?? "") || isDigits(text[i + e.n] ?? "")))
    ) {
      out.push({ start: i, end: i + e.n, label: e.label, rank: 0 })
      return
    }
  }
}

/** The label a set knows a number by, from its digits alone. */
const knownNumber = (digits: string) => {
  for (const k of sets.values()) {
    if (k.digitLengths.has(digits.length)) {
      const label = k.digits.get(hashOf(k.salt, digits))
      if (label !== undefined) {
        return label
      }
    }
  }
  return null
}

/** How a card number is written in groups: fours (the last shorter), or Amex's and Diners' 4-6-5. */
const CARD_GROUPS = /^(?:(?:4 )+[1-4]|4 6 [45])$/u

/** Numbers: a known one written in groups, and a card number (alone, or grouped as cards are) by its issuer and Luhn. */
const numbersIn = (text: string, out: Span[]) => {
  for (const m of text.matchAll(NUMBER)) {
    if (m[0].length >= 9) {
      const groups = [...m[0].matchAll(/\d+/gu)].map((g) => ({
        start: m.index + g.index,
        digits: g[0],
      }))
      for (let a = 0; a < groups.length; a += 1) {
        let digits = ""
        const lengths: number[] = []
        for (let b = a; b < groups.length && digits.length <= 19; b += 1) {
          const first = groups[a]
          const last = groups[b]
          if (first === undefined || last === undefined || last.digits.length < 2) {
            break
          }
          digits += last.digits
          lengths.push(last.digits.length)
          const span = { start: first.start, end: last.start + last.digits.length }
          const known = b > a && digits.length >= 9 ? knownNumber(digits) : null
          if (known !== null) {
            out.push({ ...span, label: known, rank: 0 })
          } else if (
            digits.length >= 13 &&
            (b === a || CARD_GROUPS.test(lengths.join(" "))) &&
            ISSUER.test(digits) &&
            luhn(digits)
          ) {
            out.push({ ...span, label: `card ••${digits.slice(-4)}`, rank: 1 })
          }
        }
      }
    }
  }
}

/** A known security code or PIN after its label. */
const labelledIn = (text: string, out: Span[]) => {
  for (const m of text.matchAll(LABELLED)) {
    const value = m.groups?.value ?? ""
    const label = knownNumber(value)
    if (label !== null) {
      const at = m.index + m[0].length - value.length
      out.push({ start: at, end: at + value.length, label, rank: 0 })
    }
  }
}

/** The rules whose keywords `text` holds, as gitleaks picks them. */
const rulesFor = (text: string) => {
  const { shapes, keywords, within } = shapesNow()
  const present = new Set<string>()
  for (const m of text.toLowerCase().matchAll(keywords)) {
    for (const w of within.get(m[1] ?? "") ?? []) {
      present.add(w)
    }
  }
  return shapes.filter((s) => s.keywords.length === 0 || s.keywords.some((k) => present.has(k)))
}

/** Which group is a match's secret: the rule's, else its first that matched something, else all. */
const secretGroup = (s: Shape, m: RegExpExecArray) => {
  if (s.group > 0) {
    return s.group
  }
  for (let g = 1; g < m.length; g += 1) {
    if ((m[g] ?? "") !== "") {
      return g
    }
  }
  return 0
}

const shapesIn = (text: string, out: Span[]) => {
  for (const s of rulesFor(text)) {
    let floor = 0
    for (const m of text.matchAll(s.re)) {
      let start = m.index
      while (start > floor && m.index - start < s.back && NAME_CHAR.test(text[start - 1] ?? "")) {
        start -= 1
      }
      const end = m.index + m[0].length
      floor = end
      const index = secretGroup(s, m)
      const secret = m[index] ?? ""
      const at = m.indices?.[index]
      if (at !== undefined && secret !== "" && (s.entropy === 0 || entropyOf(secret) > s.entropy)) {
        const lineStart = text.lastIndexOf("\n", start) + 1
        const lineEnd = text.indexOf("\n", end)
        const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
        const match = text.slice(start, end)
        if (!s.allow.some((a) => allowed(a, secret, match, line))) {
          out.push({ start: at[0], end: at[1], label: s.id, rank: s.generic ? 2 : 1 })
        }
      }
    }
  }
}

const owned: { readonly label: string; readonly re: RegExp }[] = []

/** A shape this process's own credentials take (its tokens' format), by its name. Global (`g`). */
export const ownShape = (label: string, re: RegExp) => {
  owned.push({ label, re })
}

const spansIn = (text: string) => {
  const spans: Span[] = []
  if (text.length < WINDOW) {
    return spans
  }
  knownIn(text, spans)
  numbersIn(text, spans)
  labelledIn(text, spans)
  shapesIn(text, spans)
  for (const o of owned) {
    for (const m of text.matchAll(o.re)) {
      spans.push({ start: m.index, end: m.index + m[0].length, label: o.label, rank: 0 })
    }
  }
  // Overlapping ones are one, named by the first: none leaves a piece of the other out.
  spans.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end)
  const merged: Span[] = []
  for (const s of spans) {
    const last = merged.at(-1)
    if (last !== undefined && s.start < last.end) {
      merged[merged.length - 1] = { ...last, end: Math.max(last.end, s.end) }
    } else {
      merged.push(s)
    }
  }
  return merged
}

/** `text` with each secret in it replaced by its name, and those names. */
export const redacting = (text: string) => {
  const spans = spansIn(text)
  if (spans.length === 0) {
    return { text, found: [] }
  }
  let out = ""
  let at = 0
  for (const s of spans) {
    out += `${text.slice(at, s.start)}[${s.label}]`
    at = s.end
  }
  return { text: out + text.slice(at), found: spans.map((s) => s.label) }
}

/** `text` with each secret in it replaced by its name. */
export const redact = (text: string) => redacting(text).text

/**
 * Every string in a JSON value redacted, each alone: a key's name is no context, so what code keys
 * by (a push token) stays. The same value, untouched, when none held a secret; `found` gathers their
 * names.
 */
export const redactValue = (value: unknown, found: string[] = []): unknown => {
  if (typeof value === "string") {
    const r = redacting(value)
    found.push(...r.found)
    return r.text
  }
  if (Array.isArray(value)) {
    const list: readonly unknown[] = value
    let out: unknown[] | null = null
    for (let i = 0; i < list.length; i += 1) {
      const x = list[i]
      const y = redactValue(x, found)
      if (y !== x) {
        out ??= [...list]
        out[i] = y
      }
    }
    return out ?? value
  }
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    let out: Record<string, unknown> | null = null
    for (const [k, x] of Object.entries(value)) {
      const y = redactValue(x, found)
      if (y !== x) {
        out ??= { ...value }
        out[k] = y
      }
    }
    return out ?? value
  }
  return value
}

/** A record's values redacted, as `redactValue` does. */
export const redactRecord = (record: object, found: string[] = []): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).map(([k, v]) => [k, redactValue(v, found)]))
