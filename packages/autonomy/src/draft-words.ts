// The user's own version of a card's drafts, and what he changed: Switchboard's draft changes
// (protocol/src/asks.rs `draft_changes`), the sentences he cut and the ones he wrote. The user, Nov 23:
// "if I edit a draft either in Gmail or in the little editor in the task, I want the agent to be aware
// of it. Then if I edit the draft and then follow up in the chat to look up something to add more
// details or something, it should kind of still try to maintain my edit before."

/**
 * His edit of one draft, saved as he makes it (not an approval): `text` is his version, `base` the
 * agent's it was made from, `wrote` what he wrote before the agent's last revision that it kept.
 */
export interface Edit {
  readonly base: string
  readonly text: string
  readonly wrote: readonly string[]
}

/**
 * A draft's sentences, each on one line: split at the end of each line and after a sentence's
 * closing mark, spaces run together, blanks dropped.
 */
export const sentences = (text: string) =>
  text
    .split("\n")
    .flatMap((line) => line.split(/(?<=[.!?])(?=\s)/u))
    .map((s) => s.trim().replaceAll(/\s+/gu, " "))
    .filter((s) => s !== "")

/**
 * What of `before` isn't in `after` (cut) and what of `after` isn't in `before` (wrote), each in
 * order, around the longest run they share.
 */
export const changed = (before: readonly string[], after: readonly string[]) => {
  const n = before.length
  const m = after.length
  // shared[i][j]: how many sentences before[i..] and after[j..] share, in order.
  const shared = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0))
  const at = (i: number, j: number) => shared[i]?.[j] ?? 0
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = shared[i]
      if (row) {
        row[j] =
          before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
      }
    }
  }
  const cut: string[] = []
  const wrote: string[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      cut.push(before[i] ?? "")
      i += 1
    } else {
      wrote.push(after[j] ?? "")
      j += 1
    }
  }
  return { cut: [...cut, ...before.slice(i)], wrote: [...wrote, ...after.slice(j)] }
}

/** At most `max` characters, a cut one ending in an ellipsis. */
const clip = (text: string, max: number) => {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max).trimEnd()}…`
}

const listed = (said: readonly string[]) => {
  const quoted = said.slice(0, 6).map((s) => `“${clip(s, 200)}”`)
  return [...quoted, ...(said.length > 6 ? [`and ${said.length - 6} more`] : [])].join(", ")
}

/** What he changed in a draft, a line: `name: cut “…”; wrote “…”` (asks.rs `draft_changes`). */
export const changesLine = (name: string, before: string, after: string) => {
  const { cut, wrote } = changed(sentences(before), sentences(after))
  if (cut.length === 0 && wrote.length === 0) {
    return `${name}: only its spacing or line breaks`
  }
  if (wrote.length === 0) {
    return `${name}: cut ${listed(cut)}`
  }
  if (cut.length === 0) {
    return `${name}: wrote ${listed(wrote)}`
  }
  return `${name}: cut ${listed(cut)}; wrote ${listed(wrote)}`
}

/** The sentences he wrote that his version still has. */
export const his = (e: Edit) => {
  const now = sentences(e.text)
  const written = changed(sentences(e.base), now).wrote
  return [...new Set([...e.wrote, ...written])].filter((s) => now.includes(s))
}

/** What of his a revision's `next` text would lose. */
export const lost = (e: Edit, next: string) => {
  const kept = sentences(next)
  return his(e).filter((s) => !kept.includes(s))
}

/**
 * His edit once the agent revises the draft from `was` to `next`: as it was when the draft didn't
 * change; else what he wrote that the revision kept, on top of the revision; null when nothing of
 * his is left.
 */
export const rebased = (e: Edit, was: string | undefined, next: string | undefined) => {
  if (next === undefined) {
    return null
  }
  if (next === was) {
    return e
  }
  const kept = sentences(next)
  const wrote = his(e).filter((s) => kept.includes(s))
  return wrote.length === 0 ? null : { base: next, text: next, wrote }
}

/** The same words, however they're wrapped or spaced. */
export const sameWords = (a: string, b: string) =>
  a.replaceAll(/\s+/gu, " ").trim() === b.replaceAll(/\s+/gu, " ").trim()
