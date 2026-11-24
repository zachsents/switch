// Switchboard's query language (crates/core/src/query; docs.md, Queries) over the records its
// appendages keep in the log in its envelope (the shim's `kind`, `stream`, and `data` as the
// record's body): what an item's `resolveWhen` is written in, as an ask's `resolve_when` was there
// (sb/mcp.rs `ask`, core/watches.rs). A source, then operators, each feeding the next:
//
//   query  := source ('|' op)*
//   source := stream("pattern", …) | records | entities | print item, …
//   op     := where expr | project item, … | extend name = expr, … | latest by expr, …
//           | summarize item, … [by item, …] | sort by order, … | take n | top n by order
//   expr   := ==, !=, <, <=, >, >=, contains, startswith, in (…), !in (…), between (a .. b);
//             and, or, not; + - * /; calls; fields (at, body.status); strings, numbers,
//             durations (5m, 1h), true, false, null
//
// `stream(…)` and `records` have a row per record, its envelope with `body`; `entities` a row per
// thing observed, its observations' facts merged in, the newest last, and a `gone` taking it out.
// Switchboard's other read models and `search` aren't here: naming one is an error that says so.
import type { Database } from "bun:sqlite"
import type { StoredEvent } from "@switch/brain"

import { isRecord } from "./json.ts"

export class QueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QueryError"
  }
}

const quoted = (s: string) => JSON.stringify(s)

/** A text's characters, as Switchboard's `chars()` reads them. */
const charsOf = (text: string) => {
  const out: string[] = []
  for (const c of text) {
    out.push(c)
  }
  return out
}

// ——— Grammar (query/parse.rs) ———

type Expr =
  | { readonly t: "value"; readonly v: unknown }
  | { readonly t: "field"; readonly path: readonly string[] }
  | { readonly t: "call"; readonly name: string; readonly args: readonly Expr[] }
  | { readonly t: "unary"; readonly op: string; readonly e: Expr }
  | { readonly t: "binary"; readonly op: string; readonly a: Expr; readonly b: Expr }
  | { readonly t: "list"; readonly items: readonly Expr[] }

interface Item {
  readonly name: string | null
  readonly expr: Expr
}

interface Order {
  readonly expr: Expr
  readonly descending: boolean
}

type Op =
  | { readonly op: "where"; readonly e: Expr }
  | { readonly op: "project" | "extend"; readonly items: readonly Item[] }
  | { readonly op: "latest"; readonly keys: readonly Expr[] }
  | { readonly op: "summarize"; readonly aggregates: readonly Item[]; readonly by: readonly Item[] }
  | { readonly op: "sort"; readonly orders: readonly Order[] }
  | { readonly op: "take"; readonly n: number }
  | { readonly op: "top"; readonly n: number; readonly orders: readonly Order[] }

interface Query {
  readonly source: string
  readonly args: readonly Expr[]
  readonly ops: readonly Op[]
}

type Token =
  | { readonly k: "word" | "text" | "symbol"; readonly s: string }
  | { readonly k: "number" | "duration"; readonly n: number }

const SYMBOLS = [
  "..",
  "==",
  "!=",
  "<=",
  ">=",
  "|",
  ",",
  "(",
  ")",
  "=",
  "<",
  ">",
  "+",
  "-",
  "*",
  "/",
  "!",
]
const DURATIONS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c)
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9"
const isWordPart = (c: string | undefined) => c !== undefined && /[\p{Alphabetic}\p{N}_@:]/u.test(c)
/** A `.` inside a word or number, not a range's `..`. */
const isDot = (chars: readonly string[], i: number) => chars[i] === "." && chars[i + 1] !== "."

const show = (t: Token | undefined) => {
  if (t === undefined) {
    return "nothing"
  }
  return "s" in t ? quoted(t.s) : String(t.n)
}

/** Whether the tokens so far end in a call that takes a time's text: `datetime(2026-11-13 18:00)`. */
const rawTime = (tokens: readonly Token[], chars: readonly string[], i: number) => {
  const last = tokens.at(-1)
  return (
    chars[i] === "(" &&
    last?.k === "word" &&
    ["datetime", "todatetime"].includes(last.s.toLowerCase()) &&
    isDigit(chars.slice(i + 1).find((c) => !isSpace(c)))
  )
}

interface Read {
  readonly tokens: readonly Token[]
  /** Where the next token starts. */
  readonly next: number
}

const readText = (chars: readonly string[], start: number): Read => {
  const quote = chars[start]
  let s = ""
  let i = start + 1
  while (i < chars.length && chars[i] !== quote) {
    if (chars[i] === "\\" && i + 1 < chars.length) {
      i += 1
    }
    s += chars[i] ?? ""
    i += 1
  }
  if (i >= chars.length) {
    throw new QueryError("a string is missing its closing quote")
  }
  return { tokens: [{ k: "text", s }], next: i + 1 }
}

const readRawTime = (chars: readonly string[], start: number): Read => {
  let i = start + 1
  while (i < chars.length && chars[i] !== ")" && chars[i] !== ",") {
    i += 1
  }
  const s = chars
    .slice(start + 1, i)
    .join("")
    .trim()
  return {
    tokens: [
      { k: "symbol", s: "(" },
      { k: "text", s },
    ],
    next: i,
  }
}

const readNumber = (chars: readonly string[], start: number): Read => {
  let i = start
  while (isDigit(chars[i]) || isDot(chars, i) || chars[i] === "_") {
    i += 1
  }
  const written = chars.slice(start, i).join("").replaceAll("_", "")
  const n = Number(written)
  if (Number.isNaN(n)) {
    throw new QueryError(`${written} isn't a number`)
  }
  const unitStart = i
  while (/[A-Za-z]/u.test(chars[i] ?? "")) {
    i += 1
  }
  const unit = chars.slice(unitStart, i).join("")
  if (unit === "") {
    return { tokens: [{ k: "number", n }], next: i }
  }
  const ms = DURATIONS[unit]
  if (ms === undefined) {
    throw new QueryError(`${written}${unit}: durations end in ms, s, m, h or d`)
  }
  return { tokens: [{ k: "duration", n: n * ms }], next: i }
}

const readWord = (chars: readonly string[], start: number): Read => {
  let i = start
  while (isWordPart(chars[i]) || isDot(chars, i)) {
    i += 1
  }
  return { tokens: [{ k: "word", s: chars.slice(start, i).join("") }], next: i }
}

const readSymbol = (chars: readonly string[], start: number): Read => {
  const rest = chars.slice(start, start + 2).join("")
  const symbol = SYMBOLS.find((s) => rest.startsWith(s))
  if (symbol === undefined) {
    throw new QueryError(`unexpected ${quoted(chars[start] ?? "")}`)
  }
  return { tokens: [{ k: "symbol", s: symbol }], next: start + symbol.length }
}

const readToken = (chars: readonly string[], i: number, tokens: readonly Token[]) => {
  const c = chars[i] ?? ""
  if (c === '"' || c === "'") {
    return readText(chars, i)
  }
  if (rawTime(tokens, chars, i)) {
    return readRawTime(chars, i)
  }
  if (isDigit(c)) {
    return readNumber(chars, i)
  }
  if (c === "_" || /\p{Alphabetic}/u.test(c)) {
    return readWord(chars, i)
  }
  return readSymbol(chars, i)
}

const tokenize = (text: string) => {
  const chars = charsOf(text)
  const tokens: Token[] = []
  let i = 0
  while (i < chars.length) {
    if (isSpace(chars[i])) {
      i += 1
    } else {
      const read = readToken(chars, i, tokens)
      tokens.push(...read.tokens)
      i = read.next
    }
  }
  return tokens
}

const value = (v: unknown): Expr => ({ t: "value", v })
const binary = (op: string, a: Expr, b: Expr): Expr => ({ t: "binary", op, a, b })
const COMPARISONS = ["==", "!=", "<=", ">=", "<", ">"]

/** A query's tokens, read one way through, as Switchboard's `Parser`. */
class Parser {
  readonly tokens: readonly Token[]
  at = 0

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens
  }

  peek() {
    return this.tokens[this.at]
  }

  take() {
    const t = this.tokens[this.at]
    this.at += 1
    return t
  }

  eatWord(word: string) {
    const t = this.peek()
    if (t?.k === "word" && t.s.toLowerCase() === word) {
      this.at += 1
      return true
    }
    return false
  }

  eat(symbol: string) {
    const t = this.peek()
    if (t?.k === "symbol" && t.s === symbol) {
      this.at += 1
      return true
    }
    return false
  }

  here() {
    return this.peek() === undefined ? "at the end" : `before ${show(this.peek())}`
  }

  expect(symbol: string) {
    if (!this.eat(symbol)) {
      throw new QueryError(`expected ${quoted(symbol)} ${this.here()}`)
    }
  }

  name() {
    const t = this.take()
    if (t?.k !== "word") {
      throw new QueryError(`expected a name, found ${show(t)}`)
    }
    return t.s
  }

  count() {
    const t = this.take()
    if (t?.k !== "number" || t.n < 0) {
      throw new QueryError(`expected a count, found ${show(t)}`)
    }
    return Math.floor(t.n)
  }

  query(): Query {
    let source = this.name()
    const ops: Op[] = []
    let args: Expr[] = []
    if (source.toLowerCase() === "print") {
      // `print a = expr, …`: one row of what it computes.
      source = "print"
      const t = this.peek()
      if (t !== undefined && !(t.k === "symbol" && t.s === "|")) {
        ops.push({ op: "project", items: this.items() })
      }
    } else if (this.eat("(")) {
      args = this.args()
    }
    while (this.eat("|")) {
      ops.push(this.op())
    }
    if (this.peek() !== undefined) {
      throw new QueryError(`unexpected ${show(this.peek())}; operators start with |`)
    }
    return { source, args, ops }
  }

  /** Comma-separated expressions up to a closing parenthesis. */
  args() {
    const out: Expr[] = []
    if (this.eat(")")) {
      return out
    }
    for (;;) {
      out.push(this.expr())
      if (this.eat(")")) {
        return out
      }
      this.expect(",")
    }
  }

  items() {
    const out = [this.item()]
    while (this.eat(",")) {
      out.push(this.item())
    }
    return out
  }

  item(): Item {
    const [first, second] = [this.tokens[this.at], this.tokens[this.at + 1]]
    if (first?.k === "word" && second?.k === "symbol" && second.s === "=") {
      this.at += 2
      return { name: first.s, expr: this.expr() }
    }
    return { name: null, expr: this.expr() }
  }

  orders() {
    const out: Order[] = []
    do {
      const expr = this.expr()
      // Descending unless asked otherwise, as in Kusto.
      const descending = !this.eatWord("asc")
      if (descending) {
        this.eatWord("desc")
      }
      out.push({ expr, descending })
    } while (this.eat(","))
    return out
  }

  by(what: string, example: string) {
    if (!this.eatWord("by")) {
      throw new QueryError(`${what} takes by: ${example}`)
    }
  }

  op(): Op {
    const word = this.name().toLowerCase()
    switch (word) {
      case "where": {
        return { op: "where", e: this.expr() }
      }
      case "project":
      case "extend": {
        return { op: word, items: this.items() }
      }
      case "latest": {
        this.by("latest", "latest by body.order_id")
        const keys = [this.expr()]
        while (this.eat(",")) {
          keys.push(this.expr())
        }
        return { op: "latest", keys }
      }
      case "summarize": {
        const aggregates = this.items()
        return { op: "summarize", aggregates, by: this.eatWord("by") ? this.items() : [] }
      }
      case "sort":
      case "order": {
        this.by(word, "sort by at desc")
        return { op: "sort", orders: this.orders() }
      }
      case "take":
      case "limit": {
        return { op: "take", n: this.count() }
      }
      case "top": {
        const n = this.count()
        this.by("top", "top 10 by at desc")
        return { op: "top", n, orders: this.orders() }
      }
      default: {
        throw new QueryError(
          `no operator ${quoted(word)}; use where, project, extend, latest by, summarize, sort by, take or top`,
        )
      }
    }
  }

  expr(): Expr {
    let left = this.and()
    while (this.eatWord("or")) {
      left = binary("or", left, this.and())
    }
    return left
  }

  and(): Expr {
    let left = this.not()
    while (this.eatWord("and")) {
      left = binary("and", left, this.not())
    }
    return left
  }

  not(): Expr {
    return this.eatWord("not") ? { t: "unary", op: "not", e: this.not() } : this.comparison()
  }

  list(): Expr {
    this.expect("(")
    return { t: "list", items: this.args() }
  }

  comparison(): Expr {
    const left = this.sum()
    const symbol = COMPARISONS.find((s) => this.eat(s))
    if (symbol !== undefined) {
      return binary(symbol, left, this.sum())
    }
    if (this.eat("!")) {
      if (!this.eatWord("in")) {
        throw new QueryError(`expected in after ! ${this.here()}`)
      }
      return { t: "unary", op: "not", e: binary("in", left, this.list()) }
    }
    const word = ["contains", "startswith"].find((w) => this.eatWord(w))
    if (word !== undefined) {
      return binary(word, left, this.sum())
    }
    if (this.eatWord("in")) {
      return binary("in", left, this.list())
    }
    return this.eatWord("between") ? this.between(left) : left
  }

  /** Both ends count: `at between (datetime("18:00") .. datetime("19:00"))`. */
  between(left: Expr): Expr {
    this.expect("(")
    const low = this.sum()
    if (!this.eat("..")) {
      this.expect(",")
    }
    const high = this.sum()
    this.expect(")")
    return binary("and", binary(">=", left, low), binary("<=", left, high))
  }

  sum(): Expr {
    let left = this.product()
    for (let op = this.symbolOf(["+", "-"]); op !== null; op = this.symbolOf(["+", "-"])) {
      left = binary(op, left, this.product())
    }
    return left
  }

  product(): Expr {
    let left = this.unary()
    for (let op = this.symbolOf(["*", "/"]); op !== null; op = this.symbolOf(["*", "/"])) {
      left = binary(op, left, this.unary())
    }
    return left
  }

  symbolOf(symbols: readonly string[]) {
    return symbols.find((s) => this.eat(s)) ?? null
  }

  unary(): Expr {
    return this.eat("-") ? { t: "unary", op: "-", e: this.unary() } : this.primary()
  }

  primary(): Expr {
    const t = this.take()
    if (t?.k === "number" || t?.k === "duration") {
      return value(t.n)
    }
    if (t?.k === "text") {
      return value(t.s)
    }
    if (t?.k === "symbol" && t.s === "(") {
      const inner = this.expr()
      this.expect(")")
      return inner
    }
    if (t?.k !== "word") {
      throw new QueryError(`expected a value, found ${show(t)}`)
    }
    if (t.s === "true" || t.s === "false") {
      return value(t.s === "true")
    }
    if (t.s === "null") {
      return value(null)
    }
    if (this.eat("(")) {
      return { t: "call", name: t.s.toLowerCase(), args: this.args() }
    }
    return { t: "field", path: t.s.split(".") }
  }
}

const parse = (text: string) => new Parser(tokenize(text)).query()

// ——— Times (query/time.rs): `2026-11-13 18:00`, `Fri Nov 13 19:34`, `today 18:00`, `next Sat
// 9am`, `2h ago`, read in the core's zone unless the text names one ———

const FORMS =
  "like 2026-11-13 18:00, today 18:00, yesterday 6pm, Fri Nov 13 19:34, last Wed 05:00, next Sat 9am, 2h ago or in 30m, with a zone if it isn't the core's (Z, UTC, -08:00, PT, America/Los_Angeles)"
/** Numbers from here up (1973 on) are epoch milliseconds. */
const EPOCH_MS = 1e11
const DAY_MS = 86_400_000
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu

const FIXED: Readonly<Record<string, string>> = {
  z: "UTC",
  utc: "UTC",
  gmt: "UTC",
  pst: "-08:00",
  pdt: "-07:00",
  mst: "-07:00",
  mdt: "-06:00",
  cst: "-06:00",
  cdt: "-05:00",
  est: "-05:00",
  edt: "-04:00",
  akst: "-09:00",
  akdt: "-08:00",
  hst: "-10:00",
  bst: "+01:00",
  cet: "+01:00",
  cest: "+02:00",
  jst: "+09:00",
  kst: "+09:00",
  aest: "+10:00",
  aedt: "+11:00",
  pt: "America/Los_Angeles",
  mt: "America/Denver",
  ct: "America/Chicago",
  et: "America/New_York",
}

const ianaZone = (zone: string) => {
  try {
    return Temporal.Now.zonedDateTimeISO(zone).timeZoneId
  } catch {
    return null
  }
}

/** `+08:00`, `-0800`, `+08` (or `+8` after `UTC`) as `±HH:MM`. */
const offsetOf = (text: string, short: boolean) => {
  const rest = text.slice(1)
  const digits = rest.replaceAll(":", "")
  let hours: string | null = null
  let minutes = "0"
  if (digits.length === 2 || (digits.length === 1 && short)) {
    hours = digits
  } else if (digits.length === 4) {
    hours = digits.slice(0, 2)
    minutes = digits.slice(2)
  }
  const fits =
    hours !== null &&
    /^\d+$/u.test(digits) &&
    rest.split(":").length <= 2 &&
    Number(hours) <= 14 &&
    Number(minutes) <= 59
  return fits ? `${text.slice(0, 1)}${hours?.padStart(2, "0")}:${minutes.padStart(2, "0")}` : null
}

/** A zone by name, in any case: Z, UTC, an offset, a common abbreviation, an IANA name, `local`. */
const zoneNamed = (text: string, local: string) => {
  const lower = text.trim().toLowerCase()
  if (lower === "local") {
    return local
  }
  const fixed = FIXED[lower]
  if (fixed !== undefined) {
    return fixed
  }
  const offset = lower.replace(/^(?:utc|gmt)/u, "")
  if (offset.startsWith("+") || offset.startsWith("-")) {
    return offsetOf(offset, offset.length < lower.length)
  }
  return lower.includes("/") ? ianaZone(text.trim()) : null
}

type Piece =
  | { readonly p: "date"; readonly date: Temporal.PlainDate }
  | { readonly p: "month" | "number" | "day" | "amount" | "unit"; readonly n: number }
  | { readonly p: "time"; readonly time: Temporal.PlainTime }
  | { readonly p: "meridiem"; readonly pm: boolean }
  | { readonly p: "weekday"; readonly day: number }
  | { readonly p: "last" | "next" | "this" | "now" | "ago" | "in" }
  | { readonly p: "zone"; readonly zone: string }

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]
const WEEKDAYS: readonly (readonly string[])[] = [
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
  ["sunday", "sun"],
]
const UNITS: readonly (readonly [number, readonly string[]])[] = [
  [1, ["ms", "msec", "msecs", "millisecond", "milliseconds"]],
  [1000, ["s", "sec", "secs", "second", "seconds"]],
  [60_000, ["m", "min", "mins", "minute", "minutes"]],
  [3_600_000, ["h", "hr", "hrs", "hour", "hours"]],
  [DAY_MS, ["d", "day", "days"]],
  [7 * DAY_MS, ["w", "wk", "wks", "week", "weeks"]],
]
const WORDS: Readonly<Record<string, Piece>> = {
  now: { p: "now" },
  today: { p: "day", n: 0 },
  tonight: { p: "day", n: 0 },
  yesterday: { p: "day", n: -1 },
  tomorrow: { p: "day", n: 1 },
  noon: { p: "time", time: Temporal.PlainTime.from("12:00") },
  midnight: { p: "time", time: Temporal.PlainTime.from("00:00") },
  ago: { p: "ago" },
  in: { p: "in" },
  last: { p: "last" },
  next: { p: "next" },
  this: { p: "this" },
  am: { p: "meridiem", pm: false },
  "a.m.": { p: "meridiem", pm: false },
  pm: { p: "meridiem", pm: true },
  "p.m.": { p: "meridiem", pm: true },
}

const monthOf = (word: string) => {
  const w = word.replace(/\.+$/u, "")
  const i = MONTHS.findIndex(
    (m) => w.length >= 3 && m.startsWith(w) && (w.length === 3 || w === "sept" || m === w),
  )
  return i === -1 ? null : i + 1
}

/** ISO weekday, Monday 1. */
const weekdayOf = (word: string) => {
  const w = word.replace(/\.+$/u, "")
  const i = WEEKDAYS.findIndex((names) => names.includes(w))
  return i === -1 ? null : i + 1
}

const unitOf = (word: string) => UNITS.find(([, names]) => names.includes(word))?.[0] ?? null

/** `2h`, `90s`, `1h30m`: a length of time in one word. */
const amountOf = (word: string) => {
  if (!/^(?:\d+[a-z]+)+$/u.test(word)) {
    return null
  }
  let total = 0
  for (const m of word.matchAll(/(?<n>\d+)(?<unit>[a-z]+)/gu)) {
    const ms = unitOf(m.groups?.unit ?? "")
    if (ms === null) {
      return null
    }
    total += Number(m.groups?.n) * ms
  }
  return total > 0 ? total : null
}

const meridiemOf = (suffix: string): Piece | null => {
  if (suffix === "am" || suffix === "a.m.") {
    return { p: "meridiem", pm: false }
  }
  return suffix === "pm" || suffix === "p.m." ? { p: "meridiem", pm: true } : null
}

/** What's written onto a time: nothing (null), its meridiem or zone, or what's neither (undefined). */
const suffixOf = (suffix: string, local: string): Piece | null | undefined => {
  if (suffix === "") {
    return null
  }
  const half = meridiemOf(suffix)
  if (half !== null) {
    return half
  }
  const zone = zoneNamed(suffix, local)
  return zone === null ? undefined : { p: "zone", zone }
}

const plainTime = (hours: string, minutes: string, seconds: string) => {
  const [whole = "", frac = ""] = seconds.split(".")
  if (whole.length !== 2 || !/^\d+$/u.test(hours)) {
    return null
  }
  try {
    return Temporal.PlainTime.from(
      {
        hour: Number(hours),
        minute: Number(minutes),
        second: Number(whole),
        millisecond: Number(frac.padEnd(3, "0").slice(0, 3)),
      },
      { overflow: "reject" },
    )
  } catch {
    return null
  }
}

/** `18:00`, `18:00:30.5`, `6pm`, `6:30pm`, `19:34z`, `18:00-08:00`: a time of day and what's written onto it. */
const clockOf = (word: string, local: string): Piece[] | null => {
  const m = /^(?<time>\d[\d:.]*)(?<suffix>.*)$/u.exec(word)
  const { time = "", suffix = "" } = m?.groups ?? {}
  const [hours = "", minutes, seconds = "00", ...more] = time.split(":")
  const extra = suffixOf(suffix, local)
  if (m === null || more.length > 0 || extra === undefined) {
    return null
  }
  // A bare hour is a time only with its meridiem: `6pm`.
  if (minutes === undefined ? extra?.p !== "meridiem" : minutes.length !== 2) {
    return null
  }
  const at = plainTime(hours, minutes ?? "00", seconds)
  return at === null ? null : [{ p: "time", time: at }, ...(extra === null ? [] : [extra])]
}

/** `2026-11-13`, `2026/11/13`, or the US's `11/13/2026` and `11/13`. */
const dateOf = (word: string): Piece[] | null => {
  const parts = word.split(/[-/]/u)
  if (!parts.every((p) => /^\d+$/u.test(p))) {
    return null
  }
  const [a = "", b = "", c = ""] = parts
  const on = (year: string, month: string, day: string) => {
    try {
      const date = Temporal.PlainDate.from(
        { year: Number(year), month: Number(month), day: Number(day) },
        { overflow: "reject" },
      )
      return [{ p: "date", date } satisfies Piece]
    } catch {
      return null
    }
  }
  if (parts.length === 3 && a.length === 4) {
    return on(a, b, c)
  }
  if (parts.length === 3 && c.length === 4 && word.includes("/")) {
    return on(c, a, b)
  }
  return parts.length === 2 && word.includes("/")
    ? [
        { p: "month", n: Number(a) },
        { p: "number", n: Number(b) },
      ]
    : null
}

/** 2026-11-13T18:00:00Z. */
const isoOf = (word: string, local: string) => {
  const m = /^(?<day>.{10})t(?<time>.+)$/u.exec(word)
  const day = dateOf(m?.groups?.day ?? "")
  if (m === null || day?.[0]?.p !== "date") {
    return null
  }
  const at = clockOf(m.groups?.time ?? "", local)
  if (at === null) {
    throw new QueryError(`can't read the time in ${quoted(word)}`)
  }
  return [...day, ...at]
}

/** What one word of a time says, read as Switchboard read each in turn. */
const pieceOf = (word: string, original: string, local: string): Piece[] | null => {
  const known = WORDS[word]
  if (known !== undefined) {
    return [known]
  }
  const day = weekdayOf(word)
  if (day !== null) {
    return [{ p: "weekday", day }]
  }
  const month = monthOf(word)
  if (month !== null) {
    return [{ p: "month", n: month }]
  }
  const unit = word.length > 1 ? unitOf(word) : null
  if (unit !== null) {
    return [{ p: "unit", n: unit }]
  }
  const written = isoOf(word, local) ?? dateOf(word) ?? clockOf(word, local)
  if (written !== null) {
    return written
  }
  if (/^\d+(?:st|nd|rd|th)?$/u.test(word)) {
    return [{ p: "number", n: Math.trunc(Number(word)) }]
  }
  const amount = amountOf(word)
  if (amount !== null) {
    return [{ p: "amount", n: amount }]
  }
  const zone = zoneNamed(original, local)
  return zone === null ? null : [{ p: "zone", zone }]
}

const piecesOf = (text: string, local: string) => {
  const out: Piece[] = []
  for (const original of text.split(/[\s,]+/u).filter((w) => w !== "")) {
    const word = original.toLowerCase()
    if (!["at", "on", "the", "of"].includes(word)) {
      const read = pieceOf(word, original, local)
      if (read === null) {
        throw new QueryError(
          `can't read ${quoted(original)} in ${quoted(text)} as part of a time; write it ${FORMS}`,
        )
      }
      out.push(...read)
    }
  }
  return out
}

const withMeridiem = (time: Temporal.PlainTime | null, pm: boolean, text: string) => {
  if (time === null || time.hour < 1 || time.hour > 12) {
    throw new QueryError(`am and pm go with hours 1 to 12: ${quoted(text)}`)
  }
  let hour = time.hour + (pm ? 12 : 0)
  if (time.hour === 12) {
    hour = pm ? 12 : 0
  }
  return time.with({ hour })
}

/** A number and a meridiem make a time (`6 pm`); a meridiem after a time sets its half of the day. */
const withMeridiems = (pieces: readonly Piece[], text: string) => {
  const out: Piece[] = []
  for (const piece of pieces) {
    const last = out.at(-1)
    if (piece.p !== "meridiem") {
      out.push(piece)
    } else if (last?.p === "number" || last?.p === "time") {
      let time: Temporal.PlainTime | null = null
      if (last.p === "time") {
        ;({ time } = last)
      } else if (last.n <= 23) {
        time = Temporal.PlainTime.from({ hour: last.n })
      }
      out.pop()
      out.push({ p: "time", time: withMeridiem(time, piece.pm, text) })
    } else {
      throw new QueryError(`am or pm in ${quoted(text)} follows no hour`)
    }
  }
  return out
}

/** `2h ago`, `3 days ago`, `in 30m`. */
const relativeMs = (pieces: readonly Piece[], text: string, now: number) => {
  let total = 0
  let sign = 0
  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i]
    const after = pieces[i + 1]
    if (piece?.p === "amount") {
      total += piece.n
    } else if (piece?.p === "number" && after?.p === "unit") {
      total += piece.n * after.n
      i += 1
    } else if (piece?.p === "ago" && sign === 0 && i === pieces.length - 1) {
      sign = -1
    } else if (piece?.p === "in" && sign === 0 && i === 0) {
      sign = 1
    } else {
      throw new QueryError(
        `can't read ${quoted(text)} as a time: a relative one is like 2h ago, 3 days ago or in 30m`,
      )
    }
  }
  if (sign === 0 || total === 0) {
    throw new QueryError(`can't read ${quoted(text)} as a time: say 2h ago or in 2h`)
  }
  return now + sign * total
}

/** What the pieces of an absolute time say: its day, time, month and numbers, and a weekday. */
interface Written {
  day: Temporal.PlainDate | null
  time: Temporal.PlainTime | null
  month: number | null
  readonly numbers: number[]
  weekday: { readonly modifier: Piece["p"] | null; readonly day: number } | null
  modifier: Piece["p"] | null
}

const writtenOf = (pieces: readonly Piece[], today: Temporal.PlainDate, text: string) => {
  const w: Written = {
    day: null,
    time: null,
    month: null,
    numbers: [],
    weekday: null,
    modifier: null,
  }
  const once = (slot: unknown, what: string) => {
    if (slot !== null) {
      throw new QueryError(`${quoted(text)} names ${what} twice`)
    }
  }
  for (const piece of pieces) {
    if (piece.p === "date" || piece.p === "day") {
      once(w.day, "its day")
      w.day = piece.p === "date" ? piece.date : today.add({ days: piece.n })
    } else if (piece.p === "time") {
      once(w.time, "its time")
      w.time = piece.time
    } else if (piece.p === "month") {
      once(w.month, "a month")
      w.month = piece.n
    } else if (piece.p === "number") {
      w.numbers.push(piece.n)
    } else if (["last", "next", "this"].includes(piece.p) && w.modifier === null) {
      w.modifier = piece.p
    } else if (piece.p === "weekday") {
      w.weekday = { modifier: w.modifier, day: piece.day }
      w.modifier = null
    } else {
      throw new QueryError(`can't read ${quoted(text)} as a time; write it ${FORMS}`)
    }
  }
  if (w.modifier !== null) {
    throw new QueryError("last, next and this go before a weekday: next Sat 9am")
  }
  return w
}

/** A month and its day: the year it names, else the one that puts it nearest today. */
const monthDay = (w: Written, today: Temporal.PlainDate, text: string) => {
  const days = w.numbers.filter((n) => n <= 31)
  const years = w.numbers.filter((n) => n > 31)
  const [d] = days
  if (days.length !== 1 || d === undefined) {
    throw new QueryError(`${quoted(text)} needs one day of the month, like Nov 13`)
  }
  const on = (year: number) => {
    try {
      return [
        Temporal.PlainDate.from({ year, month: w.month ?? 0, day: d }, { overflow: "reject" }),
      ]
    } catch {
      return []
    }
  }
  const candidates = years.length === 0 ? [today.year - 1, today.year, today.year + 1] : years
  const away = (date: Temporal.PlainDate) => Math.abs(date.since(today).total("days"))
  const [near] = (years.length > 1 ? [] : candidates.flatMap(on)).toSorted(
    (a, b) => away(a) - away(b),
  )
  if (near === undefined) {
    throw new QueryError(`${quoted(text)} isn't a day on the calendar`)
  }
  return near
}

/** The day a weekday names from `today`, with its last, next or this; with a date, only checked. */
const weekdayDay = (w: Written, today: Temporal.PlainDate, text: string) => {
  const { day, modifier } = w.weekday ?? { day: 1, modifier: null }
  const name = WEEKDAYS[day - 1]?.[0] ?? ""
  if (w.day !== null && modifier !== null) {
    throw new QueryError(`${quoted(text)} names its day twice`)
  }
  if (w.day !== null && w.day.dayOfWeek !== day) {
    throw new QueryError(`${w.day.toString()} isn't a ${name}`)
  }
  const back = (today.dayOfWeek - day + 7) % 7
  const ahead = (7 - back) % 7
  if (w.day !== null) {
    return w.day
  }
  if (modifier === "last") {
    return today.subtract({ days: back === 0 ? 7 : back })
  }
  if (modifier === "next") {
    return today.add({ days: ahead === 0 ? 7 : ahead })
  }
  if (modifier === "this" || back === 0) {
    return today.add({ days: ahead })
  }
  throw new QueryError(
    `${name} alone could be last ${name} or next ${name}: say which, in ${quoted(text)}`,
  )
}

/** The instant an absolute time names in `zone`. */
const absoluteMs = (pieces: readonly Piece[], text: string, now: number, zone: string) => {
  const today = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate()
  const w = writtenOf(pieces, today, text)
  if (w.month !== null && w.day !== null) {
    throw new QueryError(`${quoted(text)} names its day twice`)
  }
  if (w.month !== null) {
    w.day = monthDay(w, today, text)
  } else if (w.numbers.length > 0) {
    throw new QueryError(
      `can't read ${quoted(text)} as a time: a number alone is no day or hour; write it ${FORMS}`,
    )
  }
  if (w.weekday !== null) {
    w.day = weekdayDay(w, today, text)
  }
  const wall = (w.day ?? today).toPlainDateTime(w.time ?? undefined)
  return wall.toZonedDateTime(zone, { disambiguation: "compatible" }).epochMilliseconds
}

/** Epoch milliseconds from a time's text, read in `given` unless it names a zone, `now` for what's relative. */
const timeOf = (written: string, now: number, local: string, given: string) => {
  const text = written.trim()
  if (text === "") {
    throw new QueryError(`an empty text isn't a time; write it ${FORMS}`)
  }
  if (NUMBER.test(text)) {
    const n = Number(text)
    if (Math.abs(n) < EPOCH_MS) {
      throw new QueryError(
        `${text} is too small for epoch milliseconds (like 1794594012898); write a time ${FORMS}`,
      )
    }
    return Math.trunc(n)
  }
  const all = piecesOf(text, local)
  const zones = [...new Set(all.flatMap((x) => (x.p === "zone" ? [x.zone] : [])))]
  if (zones.length > 1) {
    throw new QueryError(`${quoted(text)} names two zones`)
  }
  const pieces = withMeridiems(
    all.filter((x) => x.p !== "zone"),
    text,
  )
  if (pieces.some((x) => ["ago", "in", "amount", "unit"].includes(x.p))) {
    return relativeMs(pieces, text, now)
  }
  const [only] = pieces
  if (pieces.length === 1 && only?.p === "now") {
    return now
  }
  return absoluteMs(pieces, text, now, zones[0] ?? given)
}

/** Whether a time's text moves with the clock (`today 18:00`, `2h ago`). */
const relative = (text: string, local: string) => {
  const at = (t: number) => {
    try {
      return timeOf(text, t, local, local)
    } catch {
      return null
    }
  }
  const now = Date.now()
  return at(now) !== at(now + 8 * DAY_MS)
}

// ——— Running a query (query/eval.rs) ———

type Row = Readonly<Record<string, unknown>>

interface Table {
  readonly columns: readonly string[]
  readonly rows: readonly Row[]
}

interface Scope {
  readonly now: number
  /** The core's zone, for times written without one. */
  readonly zone: string
}

const own = (o: Readonly<Record<string, unknown>>, key: string) =>
  Object.hasOwn(o, key) ? (o[key] ?? null) : null

const parsed = (text: string): unknown => {
  try {
    const read: unknown = JSON.parse(text)
    return read
  } catch {
    return null
  }
}

const truthy = (v: unknown) => {
  if (v === null || v === undefined) {
    return false
  }
  if (typeof v === "boolean") {
    return v
  }
  if (typeof v === "number" || typeof v === "string") {
    return v !== 0 && v !== ""
  }
  return Array.isArray(v) ? v.length > 0 : isRecord(v) && Object.keys(v).length > 0
}

const RANKS = ["boolean", "number", "string"]

const rank = (v: unknown) => {
  if (v === null || v === undefined) {
    return 0
  }
  const i = RANKS.indexOf(typeof v)
  if (i !== -1) {
    return i + 1
  }
  return Array.isArray(v) ? 4 : 5
}

const json = (v: unknown) => JSON.stringify(v) ?? "null"

const order = <T extends string | number>(a: T, b: T) => {
  if (a < b) {
    return -1
  }
  return a > b ? 1 : 0
}

const compare = (a: unknown, b: unknown): number => {
  if (typeof a === "number" && typeof b === "number") {
    return order(a, b)
  }
  if (typeof a === "string" && typeof b === "string") {
    return order(a, b)
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return order(Number(a), Number(b))
  }
  return order(rank(a), rank(b)) || order(json(a), json(b))
}

const numberOf = (v: unknown) => {
  if (typeof v === "number") {
    return v
  }
  if (typeof v === "boolean") {
    return Number(v)
  }
  return typeof v === "string" && NUMBER.test(v) ? Number(v) : null
}

const textOf = (v: unknown) => {
  if (typeof v === "string") {
    return v
  }
  return v === null || v === undefined ? "" : json(v)
}

const fieldOf = (row: Row, path: readonly string[]) => {
  const [first = "", ...rest] = path
  let v = own(row, first)
  for (const part of rest) {
    // A column that holds JSON as text still opens.
    const opened = typeof v === "string" ? parsed(v) : v
    v = isRecord(opened) ? own(opened, part) : null
  }
  return v
}

const both = (a: unknown, b: unknown) => a !== null && b !== null

const COMPARE: Readonly<Record<string, (a: unknown, b: unknown) => boolean>> = {
  "==": (a, b) => compare(a, b) === 0,
  "!=": (a, b) => compare(a, b) !== 0,
  "<": (a, b) => both(a, b) && compare(a, b) < 0,
  "<=": (a, b) => both(a, b) && compare(a, b) <= 0,
  ">": (a, b) => both(a, b) && compare(a, b) > 0,
  ">=": (a, b) => both(a, b) && compare(a, b) >= 0,
  contains: (a, b) =>
    Array.isArray(a)
      ? a.some((x) => compare(x, b) === 0)
      : textOf(a).toLowerCase().includes(textOf(b).toLowerCase()),
  startswith: (a, b) => textOf(a).toLowerCase().startsWith(textOf(b).toLowerCase()),
  in: (a, b) => Array.isArray(b) && b.some((x) => compare(x, a) === 0),
}

const ARITHMETIC: Readonly<Record<string, (x: number, y: number) => number | null>> = {
  "+": (x, y) => x + y,
  "-": (x, y) => x - y,
  "*": (x, y) => x * y,
  "/": (x, y) => (y === 0 ? null : x / y),
}

const arithmetic = (op: string, a: unknown, b: unknown) => {
  if (op === "+" && typeof a === "string") {
    return `${a}${textOf(b)}`
  }
  const x = numberOf(a)
  const y = numberOf(b)
  return x === null || y === null ? null : (ARITHMETIC[op]?.(x, y) ?? null)
}

/** A function's arguments, each evaluated when it's read. */
interface Call {
  readonly arg: (i: number) => unknown
  readonly args: readonly Expr[]
  readonly row: Row
  readonly scope: Scope
}

const zoneArg = (v: unknown, scope: Scope) => {
  if (v === null) {
    return scope.zone
  }
  const zone = zoneNamed(textOf(v), scope.zone)
  if (zone === null) {
    throw new QueryError(
      `no zone ${textOf(v)}; use UTC, an offset like -08:00, PT, or a name like America/Los_Angeles`,
    )
  }
  return zone
}

const datetime = (c: Call) => {
  const v = c.arg(0)
  if (v === null || typeof v === "number") {
    return v
  }
  const zone = zoneArg(c.arg(1), c.scope)
  try {
    return timeOf(textOf(v), c.scope.now, c.scope.zone, zone)
  } catch (error) {
    // A time written in the query is wrong; one in a record is only missing.
    if (c.args[0]?.t === "value") {
      throw error
    }
    return null
  }
}

const length = (v: unknown) => (Array.isArray(v) ? v.length : charsOf(textOf(v)).length)

const coalesce = (c: Call) => {
  for (let i = 0; i < c.args.length; i += 1) {
    const v = c.arg(i)
    if (v !== null) {
      return v
    }
  }
  return null
}

const bin = (c: Call) => {
  const x = numberOf(c.arg(0))
  const size = numberOf(c.arg(1))
  return x !== null && size !== null && size > 0 ? Math.floor(x / size) * size : null
}

const about = (c: Call) => {
  const entity = c.arg(0)
  const list = own(c.row, "about")
  return Array.isArray(list) && list.some((a) => compare(a, entity) === 0)
}

const iif = (c: Call) => (truthy(c.arg(0)) ? c.arg(1) : c.arg(2))

const FUNCTIONS: Readonly<Record<string, (c: Call) => unknown>> = {
  now: (c) => c.scope.now,
  ago: (c) => c.scope.now - (numberOf(c.arg(0)) ?? 0),
  bin,
  about,
  tostring: (c) => textOf(c.arg(0)),
  tonumber: (c) => numberOf(c.arg(0)),
  toint: (c) => numberOf(c.arg(0)),
  todouble: (c) => numberOf(c.arg(0)),
  lower: (c) => textOf(c.arg(0)).toLowerCase(),
  upper: (c) => textOf(c.arg(0)).toUpperCase(),
  strlen: (c) => length(c.arg(0)),
  len: (c) => length(c.arg(0)),
  isnull: (c) => c.arg(0) === null,
  isnotnull: (c) => c.arg(0) !== null,
  iif,
  iff: iif,
  datetime,
  todatetime: datetime,
  coalesce,
}

const numbersIn = (values: readonly unknown[]) => values.flatMap((v) => numberOf(v) ?? [])
const present = (values: readonly unknown[]) => values.filter((v) => v !== null)

const percentile = (values: readonly unknown[], p: number) => {
  const n = numbersIn(values).toSorted((x, y) => x - y)
  const i = Math.min(Math.round((p / 100) * (n.length - 1)), n.length - 1)
  return n.length === 0 ? null : (n[i] ?? null)
}

const AGGREGATE: Readonly<Record<string, (values: readonly unknown[], p: number) => unknown>> = {
  sum: (values) => numbersIn(values).reduce((s, n) => s + n, 0),
  avg: (values) => {
    const n = numbersIn(values)
    return n.length === 0 ? null : n.reduce((s, x) => s + x, 0) / n.length
  },
  min: (values) => present(values).toSorted(compare)[0] ?? null,
  max: (values) => present(values).toSorted(compare).at(-1) ?? null,
  dcount: (values) => new Set(values.map(json)).size,
  first: (values) => values[0] ?? null,
  last: (values) => values.at(-1) ?? null,
  percentile,
}

const unary = (op: string, v: unknown) => {
  if (op === "not") {
    return !truthy(v)
  }
  const n = numberOf(v)
  return n === null ? null : -n
}

/** Expressions worked out against a row, at one moment. */
class Evaluator {
  readonly scope: Scope

  constructor(scope: Scope) {
    this.scope = scope
  }

  of(e: Expr, row: Row): unknown {
    switch (e.t) {
      case "value": {
        return e.v
      }
      case "field": {
        return fieldOf(row, e.path)
      }
      case "list": {
        return e.items.map((x) => this.of(x, row))
      }
      case "unary": {
        return unary(e.op, this.of(e.e, row))
      }
      case "binary": {
        return this.binary(e.op, e.a, e.b, row)
      }
      case "call": {
        return this.call(e.name, e.args, row)
      }
      default: {
        return e satisfies never
      }
    }
  }

  binary(op: string, left: Expr, right: Expr, row: Row) {
    if (op === "and") {
      return truthy(this.of(left, row)) && truthy(this.of(right, row))
    }
    if (op === "or") {
      return truthy(this.of(left, row)) || truthy(this.of(right, row))
    }
    const a = this.of(left, row)
    const b = this.of(right, row)
    const compared = COMPARE[op]
    if (compared !== undefined) {
      return compared(a, b)
    }
    if (ARITHMETIC[op] === undefined) {
      throw new QueryError(`no operator ${op}`)
    }
    return arithmetic(op, a, b)
  }

  call(name: string, args: readonly Expr[], row: Row) {
    const f = FUNCTIONS[name]
    if (f === undefined) {
      const aggregate = name === "count" || AGGREGATE[name] !== undefined
      throw new QueryError(
        aggregate ? `${name}() works only in summarize` : `no function ${name}()`,
      )
    }
    const arg = (i: number) => {
      const a = args[i]
      return a === undefined ? null : this.of(a, row)
    }
    return f({ arg, args, row, scope: this.scope })
  }

  aggregate(item: Item, rows: readonly Row[]): unknown {
    const e = item.expr
    if (e.t !== "call") {
      throw new QueryError("summarize takes aggregates, like count() or avg(body.cpu)")
    }
    if (e.name === "count") {
      return rows.length
    }
    const of = AGGREGATE[e.name]
    const [first, second] = e.args
    if (of === undefined) {
      throw new QueryError(`no aggregate ${e.name}()`)
    }
    if (first === undefined) {
      throw new QueryError(`${e.name}() needs an argument`)
    }
    const p = numberOf(second === undefined ? null : this.of(second, {})) ?? 50
    return of(
      rows.map((row) => this.of(first, row)),
      p,
    )
  }
}

/** A column's name: given, or from what it computes (`body.total` → `total`, `avg(body.cpu)` → `avg_cpu`). */
const derived = (e: Expr): string | null => {
  if (e.t === "field") {
    return e.path.at(-1) ?? null
  }
  if (e.t !== "call") {
    return null
  }
  const [first] = e.args
  const inner = first === undefined ? null : derived(first)
  if (e.name === "bin" || e.name === "format_datetime") {
    return inner
  }
  return inner === null ? e.name : `${e.name}_${inner}`
}

const nameOf = (item: Item, index: number) =>
  item.name ?? derived(item.expr) ?? `column${index + 1}`

const sorted = (rows: readonly Row[], orders: readonly Order[], ev: Evaluator) =>
  rows
    .map((row) => ({ row, keys: orders.map((o) => ev.of(o.expr, row)) }))
    .toSorted((x, y) => {
      for (const [i, o] of orders.entries()) {
        const c = o.descending ? compare(y.keys[i], x.keys[i]) : compare(x.keys[i], y.keys[i])
        if (c !== 0) {
          return c
        }
      }
      return 0
    })
    .map((k) => k.row)

/** Whether `a` came no later than `b`, by `at` then `seq`. */
const noLater = (a: Row, b: Row) => {
  const at = (r: Row) => numberOf(own(r, "at")) ?? 0
  const seq = (r: Row) => numberOf(own(r, "seq")) ?? 0
  return at(a) < at(b) || (at(a) === at(b) && seq(a) <= seq(b))
}

/** The newest row per key, in the order the keys first came. */
const newest = (rows: readonly Row[], keys: readonly Expr[], ev: Evaluator) => {
  const kept = new Map<string, Row>()
  for (const row of rows) {
    const key = json(keys.map((k) => ev.of(k, row)))
    const old = kept.get(key)
    if (old === undefined || noLater(old, row)) {
      kept.set(key, row)
    }
  }
  return [...kept.values()]
}

const summarized = (
  table: Table,
  aggregates: readonly Item[],
  by: readonly Item[],
  ev: Evaluator,
): Table => {
  const byNames = by.map((item, i) => nameOf(item, i))
  const names = aggregates.map((item, i) => nameOf(item, i + by.length))
  const groups = new Map<string, { key: unknown[]; members: Row[] }>()
  for (const row of table.rows) {
    const key = by.map((item) => ev.of(item.expr, row))
    const k = json(key)
    const group = groups.get(k) ?? { key, members: [] }
    group.members.push(row)
    groups.set(k, group)
  }
  if (groups.size === 0 && by.length === 0) {
    groups.set("", { key: [], members: [] })
  }
  const rows = [...groups.entries()]
    .toSorted(([a], [b]) => order(a, b))
    .map(([, g]) => {
      const row: Record<string, unknown> = {}
      for (const [i, n] of byNames.entries()) {
        row[n] = g.key[i] ?? null
      }
      for (const [i, item] of aggregates.entries()) {
        row[names[i] ?? ""] = ev.aggregate(item, g.members)
      }
      return row
    })
  const byOrders = byNames.map((n) => ({
    expr: { t: "field", path: [n] } satisfies Expr,
    descending: false,
  }))
  return { columns: [...byNames, ...names], rows: sorted(rows, byOrders, ev) }
}

const projected = (table: Table, items: readonly Item[], ev: Evaluator, extend: boolean): Table => {
  const names = items.map((item, i) => nameOf(item, i))
  const rows = table.rows.map((row) => {
    const out: Record<string, unknown> = extend ? { ...row } : {}
    for (const [i, item] of items.entries()) {
      // Each sees the ones before it, as it runs.
      out[names[i] ?? ""] = ev.of(item.expr, extend ? out : row)
    }
    return out
  })
  return { columns: extend ? [...new Set([...table.columns, ...names])] : names, rows }
}

const applied = (table: Table, op: Op, ev: Evaluator): Table => {
  switch (op.op) {
    case "where": {
      return { ...table, rows: table.rows.filter((row) => truthy(ev.of(op.e, row))) }
    }
    case "project":
    case "extend": {
      return projected(table, op.items, ev, op.op === "extend")
    }
    case "latest": {
      return { ...table, rows: newest(table.rows, op.keys, ev) }
    }
    case "summarize": {
      return summarized(table, op.aggregates, op.by, ev)
    }
    case "sort": {
      return { ...table, rows: sorted(table.rows, op.orders, ev) }
    }
    case "take": {
      return { ...table, rows: table.rows.slice(0, op.n) }
    }
    case "top": {
      return { ...table, rows: sorted(table.rows, op.orders, ev).slice(0, op.n) }
    }
    default: {
      return op satisfies never
    }
  }
}

// ——— Sources, columns and what can change a query's rows (query/mod.rs, columns.rs) ———

const RECORD_COLUMNS = [
  "id",
  "seq",
  "at",
  "recorded",
  "source",
  "stream",
  "kind",
  "about",
  "refs",
  "importance",
  "ephemeral",
  "body",
]
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  stream: RECORD_COLUMNS,
  records: RECORD_COLUMNS,
  entities: ["id", "kind", "name", "summary", "facts", "stream", "source", "observed_at", "seq"],
  print: [],
}

/** The columns an expression reads: each field's first part, and `about` for `about(…)`. */
const reads = (e: Expr): { readonly column: string; readonly call: boolean }[] => {
  switch (e.t) {
    case "field": {
      return [{ column: e.path[0] ?? "", call: false }]
    }
    case "call": {
      const itself = e.name === "about" ? [{ column: "about", call: true }] : []
      return [...itself, ...e.args.flatMap(reads)]
    }
    case "unary": {
      return reads(e.e)
    }
    case "binary": {
      return [...reads(e.a), ...reads(e.b)]
    }
    case "list": {
      return e.items.flatMap(reads)
    }
    case "value": {
      return []
    }
    default: {
      return e satisfies never
    }
  }
}

/** The expressions an operator reads, and the columns its rows have after it (null: the same). */
const opReads = (op: Op): { readonly exprs: readonly Expr[]; readonly makes: string[] | null } => {
  switch (op.op) {
    case "where": {
      return { exprs: [op.e], makes: null }
    }
    case "latest": {
      return { exprs: op.keys, makes: null }
    }
    case "sort":
    case "top": {
      return { exprs: op.orders.map((o) => o.expr), makes: null }
    }
    case "project": {
      return {
        exprs: op.items.map((i) => i.expr),
        makes: op.items.map((item, i) => nameOf(item, i)),
      }
    }
    case "summarize": {
      const makes = [
        ...op.by.map((item, i) => nameOf(item, i)),
        ...op.aggregates.map((item, i) => nameOf(item, i + op.by.length)),
      ]
      return { exprs: [...op.aggregates, ...op.by].map((i) => i.expr), makes }
    }
    case "extend": {
      return { exprs: op.items.map((i) => i.expr), makes: null }
    }
    case "take": {
      return { exprs: [], makes: null }
    }
    default: {
      return op satisfies never
    }
  }
}

/** That every column a query names is one its rows have where it names it. */
const check = (q: Query) => {
  let columns = [...(SOURCES[q.source] ?? [])]
  let madeBy: string | null = null
  const missing = (e: Expr) => {
    const gone = reads(e).find((r) => !columns.includes(r.column))
    if (gone === undefined) {
      return
    }
    const has = columns.length === 0 ? "none" : columns.join(", ")
    const how = gone.call ? ", which about(…) reads" : ""
    if (madeBy !== null) {
      throw new QueryError(
        `after its \`${madeBy}\`, rows have no column \`${gone.column}\`${how}; they have ${has}`,
      )
    }
    const what = q.source === "stream" ? "stream(…)" : q.source
    throw new QueryError(`${what} has no column \`${gone.column}\`${how}; it has ${has}`)
  }
  for (const op of q.ops) {
    if (op.op === "extend") {
      // Each sees the ones before it, as it runs.
      for (const [i, item] of op.items.entries()) {
        missing(item.expr)
        const made = nameOf(item, i)
        if (!columns.includes(made)) {
          columns.push(made)
        }
      }
    } else {
      const { exprs, makes } = opReads(op)
      for (const e of exprs) {
        missing(e)
      }
      if (makes !== null) {
        columns = makes
        madeBy = op.op
      }
    }
  }
}

const textValue = (e: Expr) => (e.t === "value" && typeof e.v === "string" ? e.v : null)

/** Whether a call is a `datetime()` of a time that moves with the clock. */
const relativeCall = (name: string, args: readonly Expr[], local: string) => {
  const [first] = args
  const text = first === undefined ? null : textValue(first)
  return (name === "datetime" || name === "todatetime") && text !== null && relative(text, local)
}

/** Whether an expression depends on the time: `now()`, `ago()`, or a relative `datetime()`. */
const mentionsTime = (e: Expr, local: string): boolean => {
  if (e.t === "call") {
    return (
      e.name === "ago" ||
      e.name === "now" ||
      relativeCall(e.name, e.args, local) ||
      e.args.some((a) => mentionsTime(a, local))
    )
  }
  if (e.t === "unary") {
    return mentionsTime(e.e, local)
  }
  if (e.t === "binary") {
    return mentionsTime(e.a, local) || mentionsTime(e.b, local)
  }
  return e.t === "list" && e.items.some((a) => mentionsTime(a, local))
}

/** Whether a query's rows change with the time alone. */
const timelyOf = (q: Query, local: string) =>
  q.ops.some((op) => opReads(op).exprs.some((e) => mentionsTime(e, local)))

/** The conditions joined by `and` in a query's leading `where`s, which filter rows one by one. */
const leading = (q: Query) => {
  const out: Expr[] = []
  const take = (e: Expr) => {
    if (e.t === "binary" && e.op === "and") {
      take(e.a)
      take(e.b)
    } else {
      out.push(e)
    }
  }
  for (const op of q.ops) {
    if (op.op !== "where") {
      break
    }
    take(op.e)
  }
  return out
}

const isField = (e: Expr, name: string) =>
  e.t === "field" && e.path.length === 1 && e.path[0] === name

/** The texts a value or a list of them holds. */
const textsOf = (e: Expr) => {
  const items = e.t === "list" ? e.items : [e]
  const texts = items.flatMap((i) => textValue(i) ?? [])
  return texts.length === items.length ? texts : []
}

const globOf = (part: string) =>
  new RegExp(
    `^${part
      .split("*")
      .map((x) => x.replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`))
      .join(".*")}$`,
    "u",
  )

/** A stream pattern, as Switchboard's are written: `*` within a part, `**` any parts. */
const streamMatches = (pattern: string, stream: string) => {
  const match = (p: readonly string[], s: readonly string[]): boolean => {
    const [head, ...rest] = p
    if (head === undefined) {
      return s.length === 0
    }
    if (head === "**") {
      return match(rest, s) || (s.length > 0 && match(p, s.slice(1)))
    }
    const [name, ...names] = s
    return name !== undefined && globOf(head).test(name) && match(rest, names)
  }
  return match(pattern.split("/"), stream.split("/"))
}

/** The records that can change what a query finds, as Switchboard's `Filter`. */
interface Filter {
  readonly streams: readonly string[]
  readonly kinds: readonly string[]
  readonly about: readonly string[]
  readonly none: boolean
}

const patternsOf = (q: Query) => {
  const patterns = q.args.map((a) => {
    const text = textValue(a)
    if (text === null) {
      throw new QueryError(`${q.source}(…) takes stream patterns in quotes`)
    }
    return text
  })
  if (patterns.length === 0) {
    throw new QueryError(`${q.source}(…) needs a stream pattern, like ${q.source}("vitals/**")`)
  }
  return patterns
}

/** A leading condition's narrowing of a log source's filter: `kind ==`, `stream ==` or `about(…)`. */
const narrowed = (f: Filter, c: Expr): Filter => {
  if (c.t === "call" && c.name === "about" && f.about.length === 0) {
    const [entity] = c.args
    const text = c.args.length === 1 && entity !== undefined ? textValue(entity) : null
    return text === null ? f : { ...f, about: [text] }
  }
  if (c.t !== "binary" || (c.op !== "==" && c.op !== "in")) {
    return f
  }
  const values = textsOf(c.b)
  if (values.length > 0 && isField(c.a, "kind") && f.kinds.length === 0) {
    return { ...f, kinds: values }
  }
  if (values.length > 0 && isField(c.a, "stream") && !values.some((v) => v.includes("*"))) {
    // Only names in the source's own streams: the rest can't arrive in any row.
    const inside = values.filter((v) => f.streams.some((p) => streamMatches(p, v)))
    return { ...f, streams: inside.length === 0 ? [""] : inside }
  }
  return f
}

/** Which entities a query on `entities` can find, when its leading `where` says. */
type EntityId =
  | { readonly by: "exact"; readonly id: string }
  | { readonly by: "prefix"; readonly prefix: string }
  | { readonly by: "kind"; readonly kind: string }

/** One condition's say on which entities a query can find: an id, the start of a type, or kinds. */
const entityNarrowing = (e: Expr): EntityId[] | null => {
  if (e.t !== "binary") {
    return null
  }
  const text = textValue(e.b)
  if (e.op === "==" && isField(e.a, "id") && text !== null) {
    return [{ by: "exact", id: text }]
  }
  if ((e.op === "==" || e.op === "in") && isField(e.a, "kind")) {
    const kinds = textsOf(e.b)
    return kinds.length === 0 ? null : kinds.map((kind) => ({ by: "kind" as const, kind }))
  }
  // A whole entity type (`print-job:`), or part of one, which ignores case the same in SQL.
  const typed = text !== null && /^[a-z0-9_-]+:?$/u.test(text)
  return e.op === "startswith" && isField(e.a, "id") && typed
    ? [{ by: "prefix", prefix: text }]
    : null
}

const entityIds = (e: Expr): EntityId[] | null => {
  if (e.t === "binary" && e.op === "or") {
    const a = entityIds(e.a)
    const b = entityIds(e.b)
    return a === null || b === null ? null : [...a, ...b]
  }
  return entityNarrowing(e)
}

const entityMatches = (q: Query) => {
  const [first] = q.ops
  if (first?.op !== "where") {
    return null
  }
  const conditions: Expr[] = [first.e]
  for (let c = conditions.pop(); c !== undefined; c = conditions.pop()) {
    if (c.t === "binary" && c.op === "and") {
      conditions.push(c.a, c.b)
    } else {
      const found = entityIds(c)
      if (found !== null) {
        return found
      }
    }
  }
  return null
}

const startsOf = (e: Expr): string[] | null => {
  if (e.t !== "binary") {
    return null
  }
  if (e.op === "or") {
    const a = startsOf(e.a)
    const b = startsOf(e.b)
    return a === null || b === null ? null : [...a, ...b]
  }
  const text = textValue(e.b)
  return e.op === "startswith" && isField(e.a, "stream") && text !== null
    ? [text.toLowerCase()]
    : null
}

/** What its leading `where` requires a record's stream to start with (`stream startswith "…"`). */
const streamStarts = (q: Query) => {
  for (const c of leading(q).toReversed()) {
    const found = startsOf(c)
    if (found !== null) {
      return found
    }
  }
  return null
}

/** A query read once, with what can change what it finds, to run again and again. */
export interface Prepared {
  readonly text: string
  readonly query: Query
  readonly filter: Filter
  /** For one on `entities`, the entities it can find, when its leading `where` says. */
  readonly entities: readonly EntityId[] | null
  readonly starts: readonly string[] | null
  /** Whether its rows change with the time alone. */
  readonly timely: boolean
  /**
   * For one on `entities` narrowed by kind, the ids its last run read, which a record about one can
   * take out of them; null before a run, when any can.
   */
  members: Set<string> | null
}

const filterOf = (q: Query): Filter => {
  const all: Filter = { streams: [], kinds: [], about: [], none: false }
  if (q.source === "entities") {
    return { ...all, kinds: ["observation", "gone"] }
  }
  if (q.source === "print") {
    return { ...all, none: true }
  }
  let filter: Filter = { ...all, streams: q.source === "stream" ? patternsOf(q) : ["**"] }
  // As Switchboard read them: the last condition first.
  for (const c of leading(q).toReversed()) {
    filter = narrowed(filter, c)
  }
  return filter
}

/** Reads a query; what's wrong with it, when it can't run, as a `QueryError`. */
export const prepare = (text: string, zone: string): Prepared => {
  const query = parse(text)
  if (SOURCES[query.source] === undefined) {
    throw new QueryError(
      `no source ${quoted(query.source)}; use stream("…"), records, entities or print`,
    )
  }
  check(query)
  const logged = query.source === "stream" || query.source === "records"
  return {
    text,
    query,
    filter: filterOf(query),
    entities: query.source === "entities" ? entityMatches(query) : null,
    starts: logged ? streamStarts(query) : null,
    timely: timelyOf(query, zone),
    members: null,
  }
}

/** Whether `text` is a query here (it reads, names a source here and only its columns). */
export const isQuery = (text: string) => {
  try {
    prepare(text, Temporal.Now.timeZoneId())
    return true
  } catch {
    return false
  }
}

// ——— The records in Switch's log ———

/** A record in the log in Switchboard's envelope, as the shim writes one; not a copy of Switchboard's own log. */
interface Envelope {
  readonly kind: string
  readonly stream: string
  readonly data: unknown
  readonly about: unknown
  readonly refs: unknown
  readonly importance: unknown
}

const envelopeOf = (source: string, payload: unknown): Envelope | null => {
  if (source.startsWith("sb:") || !isRecord(payload) || !Object.hasOwn(payload, "data")) {
    return null
  }
  const { kind, stream, data, refs, importance } = payload
  return typeof kind === "string" && typeof stream === "string"
    ? { kind, stream, data, about: payload.about, refs, importance }
    : null
}

const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0

/** A record's row: its envelope, with `body`, as Switchboard serialized it (empty lists left out). */
const recordRow = (r: EventRow, env: Envelope): Row => ({
  id: r.id,
  seq: r.seq,
  at: r.time,
  recorded: r.time,
  source: r.source,
  stream: env.stream,
  kind: env.kind,
  ...(nonEmpty(env.about) && { about: env.about }),
  ...(nonEmpty(env.refs) && { refs: env.refs }),
  ...(typeof env.importance === "number" && { importance: env.importance }),
  body: env.data ?? null,
})

/**
 * The event types the shim's records come in (`<extension>.<name>`), by each type's newest event:
 * what a query here reads, rather than the whole log. A type first seen later is added by
 * `noteType`.
 */
const types: { known: Set<string> | null } = { known: null }

const typesOf = (db: Database) => {
  if (types.known === null) {
    // One seek per type through the log's type index, rather than reading all of it.
    const after = db.query<{ type: string }, [string]>(
      "SELECT type FROM events INDEXED BY events_type WHERE type > ? ORDER BY type LIMIT 1",
    )
    const latest = db.query<{ source: string; payload: string }, [string]>(
      "SELECT source, payload FROM events INDEXED BY events_type WHERE type = ? ORDER BY seq DESC LIMIT 1",
    )
    const known = new Set<string>()
    for (let type = after.get("")?.type; type !== undefined; type = after.get(type)?.type) {
      const e = latest.get(type)
      if (e && envelopeOf(e.source, parsed(e.payload)) !== null) {
        known.add(type)
      }
    }
    types.known = known
  }
  return types.known
}

/** Keeps a record's type among those queries read, once the types are known. */
export const noteType = (e: StoredEvent) => {
  if (types.known?.has(e.type) === false && envelopeOf(e.source, e.payload) !== null) {
    types.known.add(e.type)
  }
}

interface EventRow {
  readonly seq: number
  readonly id: string
  readonly time: number
  readonly source: string
  readonly payload: string
}

type Arg = string | number

/** What an expression that reads no column comes to, or null when it can't be worked out. */
const constantOf = (e: Expr, ev: Evaluator) => {
  try {
    return ev.of(e, {})
  } catch {
    return null
  }
}

/** A leading condition SQL can narrow the log by, through its indexes: time, seq or id. */
const boundOf = (c: Expr, ev: Evaluator): { readonly sql: string; readonly arg: Arg } | null => {
  if (c.t !== "binary" || c.a.t !== "field" || c.a.path.length !== 1 || reads(c.b).length > 0) {
    return null
  }
  const [column] = c.a.path
  const v = constantOf(c.b, ev)
  if (
    typeof v === "number" &&
    [">", ">=", "<", "<="].includes(c.op) &&
    (column === "at" || column === "seq")
  ) {
    return { sql: `${column === "at" ? "time" : "seq"} ${c.op} ?`, arg: v }
  }
  return column === "id" && c.op === "==" && typeof v === "string"
    ? { sql: "id = ?", arg: v }
    : null
}

/** The records' types, the shim's own: where every query here starts. */
const inTypes = (known: ReadonlySet<string>) => {
  const args: Arg[] = [...known]
  const sql = [`type IN (${args.map(() => "?").join(", ")})`, "source NOT LIKE 'sb:%'"]
  return { sql, args }
}

const select = (db: Database, sql: readonly string[], args: readonly Arg[]) =>
  db
    .query<EventRow, Arg[]>(
      `SELECT seq, id, time, source, payload FROM events WHERE ${sql.join(" AND ")} ORDER BY seq`,
    )
    .all(...args)

/** The log's records a query on `stream(…)` or `records` reads, oldest first. */
const recordRows = (db: Database, p: Prepared, ev: Evaluator, known: ReadonlySet<string>) => {
  const { sql, args } = inTypes(known)
  const patterns = p.query.source === "stream" ? patternsOf(p.query) : ["**"]
  const prefixes = patterns.map((x) => x.split("*")[0] ?? "")
  if (!prefixes.includes("")) {
    const each =
      "(json_extract(payload, '$.stream') >= ? AND json_extract(payload, '$.stream') < ?)"
    sql.push(`(${prefixes.map(() => each).join(" OR ")})`)
    args.push(...prefixes.flatMap((x) => [x, `${x}\u{10FFFF}`]))
  }
  for (const bound of leading(p.query).flatMap((c) => boundOf(c, ev) ?? [])) {
    sql.push(bound.sql)
    args.push(bound.arg)
  }
  return select(db, sql, args).flatMap((r) => {
    const env = envelopeOf(r.source, parsed(r.payload))
    return env !== null && patterns.some((x) => streamMatches(x, env.stream))
      ? [recordRow(r, env)]
      : []
  })
}

/** One observation merged into what was known of its entity, as Switchboard's entities projection did. */
const observed = (old: Row | undefined, r: EventRow, env: Envelope, body: Row, id: string) => {
  const facts: Record<string, unknown> = {
    ...(isRecord(old?.facts) ? old.facts : {}),
    ...(isRecord(body.facts) ? body.facts : {}),
  }
  const named = typeof body.name === "string" && body.name !== "" ? body.name : old?.name
  return {
    id,
    kind: typeof body.kind === "string" ? body.kind : (id.split(":")[0] ?? "thing"),
    name: typeof named === "string" && named !== "" ? named : id,
    summary: typeof body.summary === "string" ? body.summary : (old?.summary ?? ""),
    facts,
    stream: env.stream,
    source: r.source,
    observed_at: r.time,
    seq: r.seq,
  }
}

/** Every entity the observations read are about, the newest observed last; a `gone` takes one out. */
const merged = (rows: readonly EventRow[]) => {
  const entities = new Map<string, Row>()
  for (const r of rows) {
    const env = envelopeOf(r.source, parsed(r.payload))
    const body = isRecord(env?.data) ? env.data : {}
    const id = body.entity
    if (env !== null && typeof id === "string" && env.kind === "gone") {
      entities.delete(id)
    } else if (env !== null && typeof id === "string") {
      entities.set(id, observed(entities.get(id), r, env, body, id))
    }
  }
  return [...entities.values()].toSorted((a, b) =>
    order(Number(a.observed_at), Number(b.observed_at)),
  )
}

/** The entities a query on `entities` reads: those its leading `where` names, else all of them. */
const entityRows = (db: Database, p: Prepared, known: ReadonlySet<string>) => {
  const { sql, args } = inTypes(known)
  sql.push("json_extract(payload, '$.kind') IN ('observation', 'gone')")
  // A kind is the latest observation's, so only all of an entity's records tell it.
  const ids = p.entities === null || p.entities.some((e) => e.by === "kind") ? [] : p.entities
  const parts: string[] = []
  for (const e of ids) {
    if (e.by === "exact") {
      parts.push("json_extract(payload, '$.data.entity') = ?")
      args.push(e.id)
    } else if (e.by === "prefix") {
      parts.push("lower(substr(json_extract(payload, '$.data.entity'), 1, ?)) = ?")
      args.push(e.prefix.length, e.prefix.toLowerCase())
    }
  }
  if (parts.length > 0) {
    sql.push(`(${parts.join(" OR ")})`)
  }
  return merged(select(db, sql, args))
}

/** Runs a prepared query over the log as it is now. */
export const run = (db: Database, p: Prepared, now: number, zone: string): Table => {
  const ev = new Evaluator({ now, zone })
  const known = typesOf(db)
  let rows: readonly Row[] = [{}]
  if (p.query.source === "entities") {
    rows = entityRows(db, p, known)
    if (p.entities?.some((e) => e.by === "kind") === true) {
      p.members = new Set(rows.map((r) => String(r.id)))
    }
  } else if (p.query.source !== "print") {
    rows = recordRows(db, p, ev, known)
  }
  let table: Table = { columns: Object.keys(rows[0] ?? {}), rows }
  for (const op of p.query.ops) {
    table = applied(table, op, ev)
  }
  return table
}

const passes = (f: Filter, env: Envelope) =>
  !f.none &&
  (f.streams.length === 0 || f.streams.some((x) => streamMatches(x, env.stream))) &&
  (f.kinds.length === 0 || f.kinds.includes(env.kind)) &&
  (f.about.length === 0 ||
    (Array.isArray(env.about) && env.about.some((a) => f.about.includes(String(a)))))

/** Whether an observation or `gone` about `entity` can change which entities a query finds. */
const holds = (p: Prepared, id: EntityId, entity: string, env: Envelope, body: Row) => {
  if (id.by === "exact") {
    return entity === id.id
  }
  if (id.by === "prefix") {
    return entity.toLowerCase().startsWith(id.prefix.toLowerCase())
  }
  // A kind can take an entity in (its observation gives it that kind) or let one out (one it had).
  const kind = typeof body.kind === "string" ? body.kind : entity.split(":")[0]
  return (env.kind === "observation" && kind === id.kind) || p.members?.has(entity) !== false
}

/** Whether a record arriving can change what a prepared query finds, so it runs again for it. */
export const wakes = (p: Prepared, e: StoredEvent) => {
  const env = envelopeOf(e.source, e.payload)
  if (env === null || !passes(p.filter, env)) {
    return false
  }
  const stream = env.stream.toLowerCase()
  if (p.starts !== null && !p.starts.some((s) => stream.startsWith(s))) {
    return false
  }
  if (p.query.source !== "entities") {
    return true
  }
  const body = isRecord(env.data) ? env.data : {}
  const { entity } = body
  return (
    typeof entity === "string" &&
    (p.entities === null || p.entities.some((id) => holds(p, id, entity, env, body)))
  )
}
