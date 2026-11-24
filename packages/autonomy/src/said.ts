// Whether a say repeats what the conversation said lately, as Switchboard's gate weighed it
// (protocol/src/said.rs): its words, links left out, filler gone, a plural or past ending off; a
// repeat says the same words, or almost every pair of words it says in a row (90%) was said in a
// row in one earlier message in the last five minutes.

/** How far back a say is weighed against what was said (said.rs:36 `REPEAT_MS`). */
export const REPEAT_MS = 5 * 60_000

/** said.rs:40 `SAID_ALREADY`. */
const SAID_ALREADY = 0.9

/** said.rs:43-49 `FILLER`. */
const FILLER = new Set([
  "a",
  "about",
  "after",
  "again",
  "all",
  "already",
  "also",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "before",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "done",
  "for",
  "from",
  "got",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "ll",
  "me",
  "my",
  "no",
  "nothing",
  "now",
  "of",
  "on",
  "one",
  "or",
  "our",
  "out",
  "s",
  "she",
  "so",
  "t",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "up",
  "ve",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "will",
  "with",
  "would",
  "you",
  "your",
  "re",
  "d",
  "m",
])

/** said.rs:73-85 `stem`: a word with a plural or past ending off. */
const stem = (word: string) => {
  const chars = word.match(/./gsu) ?? []
  if (chars.length > 4 && !/^\d+$/u.test(word)) {
    for (const ending of ["ing", "ed", "es", "s"]) {
      if (word.endsWith(ending)) {
        const root = word.slice(0, -ending.length)
        if ((root.match(/./gsu) ?? []).length >= 3) {
          return root
        }
      }
    }
  }
  return word
}

/** said.rs:55-71 `words`. */
export const words = (text: string) => {
  const out: string[] = []
  for (const raw of text.split(/\s+/u).filter(Boolean)) {
    const chunk = raw.split("](")[0] ?? raw
    if (chunk.includes("://")) {
      continue
    }
    for (const word of chunk.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
      const lower = word.toLowerCase()
      if (!FILLER.has(lower)) {
        out.push(stem(lower))
      }
    }
  }
  return out
}

/** Each pair of words said in a row. */
const pairs = (w: readonly string[]) => new Set(w.slice(1).map((x, i) => `${w[i] ?? ""} ${x}`))

/** said.rs:94-112 `repeats`: whether `fresh` says nothing `earlier` didn't. */
export const repeats = (fresh: string, earlier: string) => {
  const a = words(fresh)
  const b = words(earlier)
  if (a.length === 0) {
    return false
  }
  if (a.join(" ") === b.join(" ")) {
    return true
  }
  if (a.length < 4) {
    return false
  }
  const meant = pairs(a)
  const said = pairs(b)
  return [...meant].filter((p) => said.has(p)).length / meant.size >= SAID_ALREADY
}

/** said.rs:151-159 `dropped`: what the say that repeats is answered. */
export const dropped = (agoMs: number, said: string) => {
  const secs = Math.floor(Math.max(0, agoMs) / 1000)
  const ago = secs < 90 ? `${String(secs)} s ago` : `${String(Math.floor(secs / 60))} min ago`
  const chars = said.match(/./gsu) ?? []
  const quoted = chars.slice(0, 200).join("")
  const cut = chars.length > 200 ? "…" : ""
  return `Not said: it repeats what this conversation said ${ago} (“${quoted}${cut}”), so the user has it. Say only what's new, if anything is.`
}
