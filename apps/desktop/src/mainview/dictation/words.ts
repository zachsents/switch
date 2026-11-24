// What's in a field: its text and which stretches of it were dictated, kept through every edit, so
// the message says which words may be misheard (`dictated` beside `text`). What they type over or
// add counts as typed, so a name they fixed by hand is their own. Places are UTF-16 units, as the
// textarea's; a message's record counts code points, as every other client does.
import type { Dictated } from "@switch/brain/commands"

/** A dictated stretch: `start` to `end` in the text. */
export interface Span {
  readonly start: number
  readonly end: number
}

/** In order, the ones that overlap or touch made one, empty ones dropped. */
const merged = (spans: readonly Span[]) => {
  const sorted = spans.filter((s) => s.end > s.start).toSorted((a, b) => a.start - b.start)
  const out: Span[] = []
  for (const s of sorted) {
    const last = out.at(-1)
    if (last && s.start <= last.end) {
      out[out.length - 1] = { start: last.start, end: Math.max(last.end, s.end) }
    } else {
      out.push(s)
    }
  }
  return out
}

/**
 * Where `before` and `after` differ, as one change: where it starts, and how much it took out and
 * put in there. `cursor`, the caret in `after`, settles where a change among repeated characters
 * was: typing leaves what follows the caret as it was.
 */
const change = (before: string, after: string, cursor: number | undefined) => {
  const shorter = Math.min(before.length, after.length)
  const prefix = (limit: number) => {
    let same = 0
    while (same < limit && before[same] === after[same]) {
      same += 1
    }
    return same
  }
  const suffix = (limit: number) => {
    let same = 0
    while (same < limit && before[before.length - 1 - same] === after[after.length - 1 - same]) {
      same += 1
    }
    return same
  }
  let head = 0
  let tail = 0
  if (cursor !== undefined && cursor >= 0 && cursor <= after.length) {
    tail = suffix(Math.min(after.length - cursor, shorter))
    head = prefix(shorter - tail)
  } else {
    head = prefix(shorter)
    tail = suffix(shorter - head)
  }
  return { start: head, removed: before.length - head - tail, inserted: after.length - head - tail }
}

/** Follows an edit from `before` to `after`: what it took out loses its mark, what it put in is typed. */
export const edit = (spans: readonly Span[], before: string, after: string, cursor?: number) => {
  if (before === after || spans.length === 0) {
    return spans
  }
  const { start, removed, inserted } = change(before, after, cursor)
  const end = start + removed
  const moved = (at: number) => at - removed + inserted
  return merged(
    spans.flatMap((s) => [
      { start: s.start, end: Math.min(s.end, start) },
      { start: moved(Math.max(s.start, end)), end: moved(Math.max(s.end, end)) },
    ]),
  )
}

/** Marks `span` dictated. */
export const add = (spans: readonly Span[], span: Span) => merged([...spans, span])

/** The text to send, trimmed, with its stretches as they fall in what's left, as a message has them. */
export const said = (text: string, spans: readonly Span[]) => {
  const lead = text.length - text.trimStart().length
  const kept = text.trim()
  const end = lead + kept.length
  const dictated: Dictated = spans.flatMap((s) => {
    const words = kept.slice(Math.max(s.start, lead) - lead, Math.min(s.end, end) - lead)
    const trimmed = words.trim()
    if (trimmed === "") {
      return []
    }
    const at = Math.max(s.start, lead) - lead + (words.length - words.trimStart().length)
    // In code points.
    return [{ start: kept.slice(0, at).match(/./gsu)?.length ?? 0, text: trimmed }]
  })
  return { text: kept, ...(dictated.length > 0 && { dictated }) }
}

/**
 * `words` carrying on a sentence. The recognizer capitalizes what it hears as if it started one,
 * so a first word capitalized only for that goes lowercase, while "I" and names in capitals like
 * "NASA" stay.
 */
const carryOn = (words: string) => {
  const word = words.split(/[\s,.?!;:)]/u)[0] ?? ""
  const first = words.charAt(0)
  const forASentence =
    first !== first.toLowerCase() && word.slice(1) === word.slice(1).toLowerCase()
  if (!forASentence || word === "I" || word.startsWith("I'") || word.startsWith("I’")) {
    return words
  }
  return first.toLowerCase() + words.slice(1)
}

/**
 * What goes after `text` for dictated `words`, spaced from it and carrying on any sentence it ends
 * in, and where the words sit then; null when nothing was said. Words go after the text, never over
 * it, so several dictations build one message.
 */
export const insertion = (text: string, words: string) => {
  const heard = words.trim()
  if (heard === "") {
    return null
  }
  const lead = /\S$/u.test(text) ? " " : ""
  const open = /[^.!?\n]$/u.test(text.replace(/[ \t]+$/u, ""))
  const put = open ? carryOn(heard) : heard
  const start = text.length + lead.length
  return { text: lead + put, span: { start, end: start + put.length } }
}
