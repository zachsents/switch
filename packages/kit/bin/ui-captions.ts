#!/usr/bin/env bun
// No UI copy that narrates the product. Its words are labels, data and a placeholder of a word or
// two, never a caption, hint, subtitle or empty-state line saying what the app does or how it
// works ("I find what bears on them…", "Here you can…", "This shows…", "Tap to…"), and no dimmed
// state word or age beside a name ("quiet 5m", "archived · Nov 12", "open", "new": a row's ring,
// name and live marks say how it stands).
//
//   ui-captions [--allow <file>] [--list] [path…]     (paths default to .)
//
// It reads TypeScript and TSX (JSX text, copy attributes, A2UI-style `text`/`label` properties,
// the ink each is drawn in from its elements' classes) and Swift (Text, prompts, labels, the
// foregroundStyle after them). The allowlist (default ./ui-captions.allow) is a line each: a path
// from here, a tab, words from the string; for real information such as a permission that's off,
// never for narration. `--list` prints every literal it reads.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import { parseSync, visitorKeys } from "oxc-parser"

interface Copy {
  readonly line: number
  readonly words: string
  /** It reaches the screen. */
  readonly sink: boolean
  /** Drawn in a dimmed ink. */
  readonly dim: boolean
  /** A tooltip (one word) or a placeholder (two); null for neither. */
  readonly most: 1 | 2 | null
  /** An age: the call that makes one, of a row's own time. */
  readonly age: boolean
}

const SKIP =
  /(?:^|\/)(?:node_modules|dist|build|\.git|tests?|__tests__|fixtures|UITests|Gallery)\/|\.(?:test|spec|d)\.tsx?$|(?:Demo|Samples)\.swift$/u
const CODE = /\.(?:tsx?|jsx?|mts|swift)$/u

const FIRST_PERSON = /\b(?:I|I'll|I'm|I've|I'd|we|We|we'll|We'll|we're|We're|our|Our|me)\b/u
const EXPLAINS =
  /here you can|\bthis (?:shows|lists|is where|page|view|card|box|closes|opens)|\byou can\b|\blets you\b|\btype (?:a few|anything|here)|one tap|\btap to\b|\bclick to\b|\bpress to\b|will appear|appears? here|\bwhat you (?:said|did|asked)\b|\bsends here\b|\bopens at once\b|\bin your own words\b|\bget started\b|\bto get\b|\bstart by\b/iu
const SENTENCES = /[.!?] +[A-Z][a-z]+ [a-z]/u
// How a row stands, said in words: its ring, name and live marks already say it.
const STATUS = new Set([
  "quiet",
  "open",
  "opened",
  "folded",
  "archived",
  "new",
  "idle",
  "active",
  "inactive",
  "stale",
  "recent",
  "recently",
  "fresh",
  "ago",
  "now",
  "just",
  "since",
  "last",
  "touched",
  "seen",
  "updated",
])
// Relative-time helpers, and a row's own times: an age beside a name decorates. Ages of asks,
// events and surprises are data and stay.
const AGE_CALL = /^(?:ago|agoOf|ageOf|since|sinceOf|relative\w*|fromNow)$/u
const ROW_TIME = /\b(?:lastAt|last_at|archivedAt|archived_at|touchedAt|seenAt|updatedAt)\b/u

// TSX: the classes that dim an element's text, and those that ink it plainly.
const DIM_CLASS = /\btext-(?:ink2|ink3|band-ink2|muted\S*)\b|\bopacity-[1-6]0\b/u
const INK_CLASS = /\btext-(?:ink|band-ink|white|black|red|orange|yellow)\b/u
// Attributes and properties whose string reaches the screen.
const SINK_ATTR = new Set([
  "placeholder",
  "title",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "alt",
  "label",
])
/** The most words each may have: a tooltip's one, a placeholder's two. */
const MOST = new Map<string, 1 | 2>([
  ["title", 1],
  ["aria-description", 1],
  ["placeholder", 2],
  ["aria-placeholder", 2],
  ["tooltip", 1],
  ["help", 1],
])
const UI_KEY = new Set([
  "text",
  "label",
  "placeholder",
  "caption",
  "hint",
  "subtitle",
  "empty",
  "tooltip",
  "help",
])
// What a literal passes through on its way to an element.
const THROUGH = new Set([
  "ConditionalExpression",
  "LogicalExpression",
  "BinaryExpression",
  "TemplateLiteral",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "ArrayExpression",
])

// Swift.
const SWIFT_SINK =
  /\.help\(|foregroundStyle|\bText\(|\bLabel\(|\bButton\(|prompt:|placeholder|accessibility(?:Label|Hint)\(|\.navigationTitle\(|message:|subtitle|caption|\bhint|\btitle:/u
const SWIFT_DIM = /\.meta\(|foregroundStyle\((?:SIS|Look)\.(?:ink2|ink3|bandInk2)\)|\.secondary\b/u
/** A literal's most words: a tooltip's (`.help("…")`), a placeholder's (`TextField("…"`, `prompt:`). */
const swiftMost = (line: string, at: number) => {
  const before = line.slice(0, at)
  if (/\.help\(\s*$/u.test(before)) {
    return 1
  }
  return /(?:TextField|SecureField)\(\s*$|prompt:\s*(?:Text\()?\s*$/u.test(before) ? 2 : null
}
const LITERAL = /"(?<words>(?:[^"\\\n]|\\.)*)"/gu
const WORDY = /[A-Za-z]{2}/u

/** Its fixed words (placeholders, interpolations and separators aside) all state words. */
const status = (words: string) => {
  const fixed = words
    .replaceAll(/\{[^}]*\}|\\\([^)]*\)|[^A-Za-z ]/gu, " ")
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean)
  return fixed.length > 0 && fixed.every((w) => STATUS.has(w))
}

const why = (c: Copy) => {
  if (c.age) {
    return c.dim && c.sink ? "a dimmed age beside a name decorates" : null
  }
  if (c.dim && c.sink && status(c.words)) {
    return "a dimmed state word decorates"
  }
  if (!c.words.includes(" ")) {
    return null
  }
  const count = c.words.trim().split(/\s+/u).length
  if (c.most === 1 && count > 1) {
    return "a tooltip says more than a control's one-word name"
  }
  if (c.most === 2 && count > 2) {
    return "a placeholder says more than a word or two"
  }
  const fixed = c.words
    .replaceAll(/\{[^}]*\}|\\\([^)]*\)|[^A-Za-z' ]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
  if (c.dim && c.sink && fixed.length >= 3) {
    return "a dimmed caption decorates"
  }
  if (FIRST_PERSON.test(c.words)) {
    return "speaks as the app (first person)"
  }
  if (EXPLAINS.test(c.words)) {
    return "explains the interface"
  }
  if (c.sink && (SENTENCES.test(c.words) || c.words.length > 90)) {
    return "runs to more than a sentence"
  }
  return null
}

// TypeScript, through oxc's ESTree.
interface Node {
  readonly type: string
  readonly start: number
  readonly end: number
}

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof Reflect.get(v, "type") === "string"

const field = (n: Node, key: string): unknown => Reflect.get(n, key)
const child = (n: Node, key: string) => {
  const v = field(n, key)
  return isNode(v) ? v : null
}
const text = (n: Node, key: string) => {
  const v = field(n, key)
  return typeof v === "string" ? v : ""
}

const nameOf = (n: Node | null): string => {
  if (n === null) {
    return ""
  }
  if (n.type === "Identifier" || n.type === "JSXIdentifier") {
    return text(n, "name")
  }
  if (n.type === "Literal") {
    return String(field(n, "value"))
  }
  if (n.type === "MemberExpression") {
    return nameOf(child(n, "property"))
  }
  if (n.type === "JSXNamespacedName") {
    return `${nameOf(child(n, "namespace"))}:${nameOf(child(n, "name"))}`
  }
  return ""
}

const walk = (node: Node, up: readonly Node[], visit: (n: Node, up: readonly Node[]) => void) => {
  visit(node, up)
  const inner = [...up, node]
  for (const key of visitorKeys[node.type] ?? []) {
    const v = field(node, key)
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isNode(item)) {
          walk(item, inner, visit)
        }
      }
    } else if (isNode(v)) {
      walk(v, inner, visit)
    }
  }
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  middot: "·",
}
/** JSX text as it reads. */
const entities = (raw: string) =>
  raw.replaceAll(/&(?<e>\w+);/gu, (m, e: string) => ENTITIES[e] ?? m)

/** A template element's text. */
const cooked = (q: Node) => {
  const value = field(q, "value")
  return typeof value === "object" && value !== null ? String(Reflect.get(value, "cooked")) : ""
}

/** A template's words, its expressions as `{}`. */
const templateWords = (n: Node) => {
  const quasis = field(n, "quasis")
  return Array.isArray(quasis) ? quasis.filter(isNode).map(cooked).join("{}") : ""
}

// Where a literal is code, not copy: a type, an import, a case.
const NOT_COPY = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "SwitchCase",
])

interface Reach {
  readonly sink: boolean
  readonly most: 1 | 2 | null
}
const PLAIN: Reach = { sink: false, most: null }

/** A JSX attribute's: copy when it's a copy attribute; a tooltip's limit only on an element. */
const attribute = (attr: Node, opening: Node | undefined): Reach | null => {
  const name = nameOf(child(attr, "name"))
  if (!SINK_ATTR.has(name)) {
    return null
  }
  // On a component (`<Row title=…>`) it's a prop, not a tooltip.
  const dom =
    opening?.type === "JSXOpeningElement" && /^[a-z]/u.test(nameOf(child(opening, "name")))
  return { sink: true, most: dom ? (MOST.get(name) ?? null) : null }
}

/** Whether it reaches the screen, and its most words; null for code (a class, a key, a type). */
const reach = (n: Node, up: readonly Node[]): Reach | null => {
  let at = n
  for (let i = up.length - 1; i >= 0; i -= 1) {
    const p = up[i]
    if (p === undefined) {
      break
    }
    if (p.type === "JSXAttribute") {
      return attribute(p, up[i - 1])
    }
    if (p.type === "Property") {
      const key = child(p, "key")
      return key === at
        ? null
        : { sink: UI_KEY.has(nameOf(key)), most: MOST.get(nameOf(key)) ?? null }
    }
    if (p.type === "JSXExpressionContainer") {
      const q = up[i - 1]?.type
      if (q === "JSXElement" || q === "JSXFragment") {
        return { sink: true, most: null }
      }
    } else if (NOT_COPY.has(p.type) || (p.type.startsWith("TS") && !THROUGH.has(p.type))) {
      return null
    } else if (
      !THROUGH.has(p.type) ||
      (p.type === "BinaryExpression" && text(p, "operator") !== "+")
    ) {
      return PLAIN
    }
    at = p
  }
  return PLAIN
}

const typescript = (file: string, source: string): Copy[] => {
  const { program } = parseSync(file, source, { lang: file.endsWith("x") ? "tsx" : "ts" })
  const tsx = file.endsWith("x")
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length

  // Module-level string constants, for classes kept in one (`const LINE = "… text-ink3"`).
  const consts = new Map<string, string>()
  walk(program, [], (n, up) => {
    if (n.type === "VariableDeclarator" && up.length <= 3) {
      const init = child(n, "init")
      if (init?.type === "Literal" && typeof field(init, "value") === "string") {
        consts.set(nameOf(child(n, "id")), text(init, "value"))
      } else if (init?.type === "TemplateLiteral") {
        consts.set(nameOf(child(n, "id")), templateWords(init))
      }
    }
  })

  const classOf = (element: Node) => {
    const opening = child(element, "openingElement")
    const attrs = opening === null ? [] : field(opening, "attributes")
    const out: string[] = []
    for (const a of Array.isArray(attrs) ? attrs.filter(isNode) : []) {
      if (a.type === "JSXAttribute" && nameOf(child(a, "name")) === "className") {
        const value = child(a, "value")
        if (value !== null) {
          walk(value, [], (v) => {
            if (v.type === "Literal") {
              out.push(String(field(v, "value")))
            } else if (v.type === "TemplateElement") {
              out.push(cooked(v))
            } else if (v.type === "Identifier") {
              out.push(consts.get(text(v, "name")) ?? "")
            }
          })
        }
      }
    }
    return out.join(" ")
  }

  /** The ink it's drawn in: the nearest element whose classes say. */
  const dimmed = (up: readonly Node[]) => {
    for (let i = up.length - 1; i >= 0; i -= 1) {
      const n = up[i]
      if (n?.type === "JSXElement") {
        const classes = classOf(n)
        if (DIM_CLASS.test(classes)) {
          return true
        }
        if (INK_CLASS.test(classes)) {
          return false
        }
      }
    }
    return false
  }

  const out: Copy[] = []
  const add = (n: Node, up: readonly Node[], words: string, age = false) => {
    const r = reach(n, up)
    if (r === null) {
      return
    }
    // In a .ts file only what's plainly copy counts; a .tsx is UI throughout.
    if (!r.sink && !tsx) {
      return
    }
    const glued = n.type === "TemplateLiteral" && status(words) && words.includes("{}")
    out.push({
      line: lineAt(n.start),
      words,
      sink: r.sink || glued,
      dim: (r.sink && dimmed(up)) || glued,
      most: r.most,
      age,
    })
  }
  const visit = (n: Node, up: readonly Node[]) => {
    const parent = up.at(-1)?.type
    if (n.type === "JSXText") {
      const words = entities(text(n, "value")).replaceAll(/\s+/gu, " ").trim()
      if (WORDY.test(words)) {
        out.push({
          line: lineAt(n.start),
          words,
          sink: true,
          dim: dimmed(up),
          most: null,
          age: false,
        })
      }
    } else if (n.type === "Literal" && typeof field(n, "value") === "string") {
      if (WORDY.test(text(n, "value")) && parent !== "TemplateLiteral") {
        add(n, up, text(n, "value"))
      }
    } else if (n.type === "TemplateLiteral" && parent !== "TaggedTemplateExpression") {
      if (WORDY.test(templateWords(n))) {
        add(n, up, templateWords(n))
      }
    } else if (n.type === "CallExpression" && AGE_CALL.test(nameOf(child(n, "callee")))) {
      const call = source.slice(n.start, n.end)
      if (ROW_TIME.test(call)) {
        add(n, up, call, true)
      }
    }
  }
  walk(program, [], visit)
  return out
}

// Swift: a line at a time, its modifiers on the lines after it.
const SWIFT_AGE = /\b(?:ago|since)\((?<of>[^()]*(?:\([^()]*\)[^()]*)*)\)/gu

/** A dimmed Text on this line, by its own modifiers or those on the lines after it. */
const swiftDim = (rows: readonly string[], k: number) => {
  const line = rows[k] ?? ""
  const after = rows
    .slice(k + 1, k + 5)
    .filter((r) => r.trim().startsWith("."))
    .join("")
  return (
    line.includes("Text(") &&
    !line.includes("prompt:") &&
    (SWIFT_DIM.test(line) || SWIFT_DIM.test(after.split("{")[0] ?? ""))
  )
}

/** One line's copy. */
const swiftLine = (rows: readonly string[], k: number): Copy[] => {
  const line = rows[k] ?? ""
  const code = line.trim()
  if (code.startsWith("//") || code.startsWith("*") || line.includes('"summary"')) {
    return []
  }
  const sink = SWIFT_SINK.test(line)
  const dim = swiftDim(rows, k)
  const out: Copy[] = dim
    ? [...line.matchAll(SWIFT_AGE)]
        .filter((m) => ROW_TIME.test(m[0]))
        .map((m) => ({ line: k + 1, words: m[0], sink: true, dim: true, most: null, age: true }))
    : []
  const glued = /"\s*\+|\+\s*"/u.test(line)
  for (const m of line.matchAll(LITERAL)) {
    const words = m.groups?.words ?? ""
    // A fragment between an interpolation's own quotes is code, not copy.
    if (words.split("(").length !== words.split(")").length || words.includes("$0")) {
      continue
    }
    if (glued && status(words)) {
      out.push({ line: k + 1, words, sink: true, dim: true, most: null, age: false })
    } else if (WORDY.test(words) && (words.includes(" ") || (sink && dim))) {
      out.push({ line: k + 1, words, sink, dim, most: swiftMost(line, m.index), age: false })
    }
  }
  return out
}

// Swift: a line at a time, its modifiers on the lines after it.
const swift = (source: string): Copy[] => {
  const rows = source.split("\n")
  return rows.flatMap((_, k) => swiftLine(rows, k))
}

const files = (at: string): string[] => {
  if (!existsSync(at)) {
    return []
  }
  if (statSync(at).isFile()) {
    return CODE.test(at) ? [at] : []
  }
  return readdirSync(at, { recursive: true, encoding: "utf-8" })
    .map((f) => path.join(at, f))
    .filter((f) => CODE.test(f) && !SKIP.test(`/${path.relative(".", f)}`) && statSync(f).isFile())
    .toSorted()
}

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? null : (args.splice(i, 2)[1] ?? "")
}
const listing = args.includes("--list")
const allowFile = flag("--allow") ?? "ui-captions.allow"
const roots = args.filter((a) => a !== "--list")

const allow = existsSync(allowFile)
  ? readFileSync(allowFile, "utf-8")
      .split("\n")
      .filter((l) => l !== "" && !l.startsWith("#") && l.includes("\t"))
      .map((l) => {
        const tab = l.indexOf("\t")
        return { file: l.slice(0, tab), words: l.slice(tab + 1) }
      })
  : []

const used = new Set<(typeof allow)[number]>()
const found: string[] = []
for (const file of (roots.length > 0 ? roots : ["."]).flatMap(files)) {
  const source = readFileSync(file, "utf-8")
  const rel = path.relative(".", file)
  for (const c of file.endsWith(".swift") ? swift(source) : typescript(file, source)) {
    if (listing) {
      console.log(`${rel}:${c.line}: ${c.words}`)
      continue
    }
    const reason = why(c)
    if (reason === null) {
      continue
    }
    const hit = allow.find((a) => a.file === rel && c.words.includes(a.words))
    if (hit) {
      used.add(hit)
    } else {
      found.push(`${rel}:${c.line}: ${reason}: "${c.words.slice(0, 160)}"`)
    }
  }
}
if (!listing) {
  for (const a of allow.filter((x) => !used.has(x))) {
    console.log(
      `${allowFile} names "${a.words}" in ${a.file}, which isn't there anymore: take its line out.`,
    )
  }
  for (const f of found) {
    console.log(f)
  }
  if (found.length > 0) {
    console.log(
      `UI copy is labels, data and a word-or-two placeholder; the interface explains itself. Cut these to a label or delete them. Only real information (a permission that's off, an error) may go in ${allowFile}.`,
    )
  }
  if (found.length > 0 || used.size < allow.length) {
    process.exit(1)
  }
}
