// Where a quoted passage is in a document now (W3C's text quote, as a note or a thread keeps it):
// its exact words where they are, else wherever the words around them match its prefix and suffix
// best, so it survives an edit around it; and a term's first mention, quoted with its context.
import { plainOf } from "./links.ts"
import type { Passage, Stored } from "./store.ts"

/** How much of what's around a passage its quote keeps either side. */
const CONTEXT = 40

const squash = (t: string) => t.replaceAll(/[^\S\n]+/gu, " ")

const texts = new Map<string, readonly string[]>()

/** Each section's words, as a match reads them, for the document as it is now. */
export const textsOf = (s: Stored): readonly string[] => {
  const key = `${s.doc}:${s.version}`
  const had = texts.get(key)
  if (had !== undefined) {
    return had
  }
  const made = s.sections.map((sec) => squash(plainOf(sec.markdown)))
  texts.set(key, made)
  if (texts.size > 16) {
    const first = texts.keys().next().value
    if (first !== undefined) {
      texts.delete(first)
    }
  }
  return made
}

const sharedEnd = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n += 1
  }
  return n
}

const sharedStart = (a: string, b: string) => {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n += 1
  }
  return n
}

/** Where `exact` is in `text` with the words around it most like the quote's; null if nowhere. */
const bestIn = (text: string, exact: string, q: Passage) => {
  const before = squash(q.prefix ?? "")
  const after = squash(q.suffix ?? "")
  let best: { at: number; score: number } | null = null
  for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
    const score =
      sharedEnd(text.slice(Math.max(0, at - CONTEXT), at), before) +
      sharedStart(text.slice(at + exact.length, at + exact.length + CONTEXT), after)
    if (best === null || score > best.score) {
      best = { at, score }
    }
  }
  return best
}

/** The quote as it stands now: its section, if its words moved to another. */
export const anchor = (all: readonly string[], q: Passage): Passage => {
  const exact = squash(q.exact).trim()
  if (exact === "" || (all[q.section] ?? "").includes(exact)) {
    return q
  }
  let hit: { section: number; score: number } | null = null
  for (const [i, text] of all.entries()) {
    const b = bestIn(text, exact, q)
    if (b !== null && (hit === null || b.score > hit.score)) {
      hit = { section: i, score: b.score }
    }
  }
  return hit === null ? q : { ...q, section: hit.section }
}

/** The words before and after a match, within its line. */
const quoteAt = (text: string, section: number, at: number, end: number): Passage => {
  const line = text.lastIndexOf("\n", at) + 1
  const stop = text.indexOf("\n", end)
  return {
    section,
    exact: text.slice(at, end),
    prefix: text.slice(Math.max(line, at - CONTEXT), at),
    suffix: text.slice(end, Math.min(stop === -1 ? text.length : stop, end + CONTEXT)),
  }
}

/** `words` quoted where they are, in section `near` first; null when the document hasn't them. */
export const passage = (all: readonly string[], words: string, near: number): Passage | null => {
  const exact = squash(words).trim()
  if (exact === "") {
    return null
  }
  const order = [near, ...all.keys()].filter((i) => i >= 0 && i < all.length)
  for (const i of order) {
    const text = all[i] ?? ""
    const at = text.indexOf(exact)
    if (at !== -1) {
      return quoteAt(text, i, at, at + exact.length)
    }
  }
  return null
}

const escapeRe = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** A term's first mention, as a word (its plural too), any case; null when it has none. */
export const mention = (all: readonly string[], term: string): Passage | null => {
  const t = term.trim()
  if (t.length < 3) {
    return null
  }
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?:e?s)?(?![\\p{L}\\p{N}])`, "iu")
  for (const [i, text] of all.entries()) {
    const m = re.exec(text)
    if (m !== null) {
      return quoteAt(text, i, m.index, m.index + m[0].length)
    }
  }
  return null
}

/** `words` quoted inside the passage `q`, their context running on into the passage's own; null if not in it. */
export const within = (q: Passage, words: string): Passage | null => {
  const exact = words.trim()
  const at = exact === "" ? -1 : q.exact.indexOf(exact)
  if (at === -1) {
    return null
  }
  const before = `${q.prefix ?? ""}${q.exact.slice(0, at)}`
  const after = `${q.exact.slice(at + exact.length)}${q.suffix ?? ""}`
  return {
    section: q.section,
    exact,
    prefix: before.slice(-CONTEXT),
    suffix: after.slice(0, CONTEXT),
  }
}
