// No em dashes in anything the agent writes for a person to read. The user, Nov 23: "we need a new
// checker forbidding em dashes in anything. communications, messages, etc." A plain rule: it
// refuses every time unless bypassed (bypass.ts), and never rewrites: a blind swap reads badly.
//
// Words that aren't the agent's keep theirs when they're marked as a quote: inside quotation marks
// ("…" or “…”) on a paragraph, a `>` quoted line (Markdown's, an email's), code (`…`, ```…```), or
// HTML's blockquote, q, pre and code.

const DASH = /—|&mdash;|&#8212;|&#x2014;/giu

const QUOTED = [
  /```[\s\S]*?```/gu,
  /`[^`\n]*`/gu,
  /^[ \t]*>.*$/gmu,
  /<(?<tag>blockquote|q|pre|code)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>/giu,
  // Quotation marks close within the paragraph they open in.
  /"(?:[^"\n]|\n(?![ \t]*\n))*"/gu,
  /“(?:[^”\n]|\n(?![ \t]*\n))*”/gu,
]

/** The text with what's quoted blanked, the same length, so places in it are places in the text. */
const unquoted = (text: string) => {
  let out = text
  for (const quote of QUOTED) {
    out = out.replaceAll(quote, (q) => " ".repeat(q.length))
  }
  return out
}

const WORDS = 4

/** A few words either side of the dash at `at`. */
const around = (text: string, at: number, length: number) => {
  const before = text
    .slice(0, at)
    .split(/\s+/u)
    .filter((w) => w !== "")
    .slice(-WORDS)
  const after = text
    .slice(at + length)
    .split(/\s+/u)
    .filter((w) => w !== "")
    .slice(0, WORDS)
  return `…${[...before, "—", ...after].join(" ")}…`
}

/** Where each em dash outside a quote is, as a few words around it. */
export const emDashes = (texts: readonly string[]) =>
  texts.flatMap((text) =>
    [...unquoted(text).matchAll(DASH)].map((m) => around(text, m.index, m[0].length)),
  )

/** Why the texts can't go, naming each em dash, or null when they have none. */
export const emDashRefusal = (texts: readonly string[]) => {
  const found = emDashes(texts)
  if (found.length === 0) {
    return null
  }
  const where = found
    .slice(0, 8)
    .map((w) => `"${w}"`)
    .join(", ")
  return `No em dashes: it has ${found.length === 1 ? "one" : found.length} (${where}). Rewrite each sentence with a comma, colon, period or parentheses. Someone else's words keep theirs inside quotation marks or a > quote.`
}

/** Every string in a value, however deep: what a call's args or a widget's parts say. */
export const stringsIn = (v: unknown): string[] => {
  if (typeof v === "string") {
    return [v]
  }
  if (typeof v === "object" && v !== null) {
    return Object.values(v).flatMap(stringsIn)
  }
  return []
}
