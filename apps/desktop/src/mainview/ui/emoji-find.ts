// Emoji by what they mean: emojibase's data (CLDR's names and keywords), loaded once on first use.
// Each word typed must start a word of an emoji's name or keywords; the name's words weigh more
// than the keywords', a whole word more than its start, and a name typed whole most, so "confused"
// brings the confused faces and "fire" the fire first.
import { Emoji } from "@switch/brain/commands"
import { queryOptions } from "@tanstack/react-query"
import { Schema } from "effect"

interface Entry {
  readonly emoji: Emoji
  readonly name: readonly string[]
  readonly tags: readonly string[]
  readonly order: number
}

const isEmoji = Schema.is(Emoji)
const wordsOf = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "")

/** Components (skin tones, hair) and lone regional letters aren't reactions. */
const COMPONENT = 2

export const emojiQuery = queryOptions({
  queryKey: ["emoji"],
  queryFn: async (): Promise<readonly Entry[]> => {
    const { default: data } = await import("emojibase-data/en/compact.json")
    return data.flatMap((e) =>
      e.group === undefined || e.group === COMPONENT || !isEmoji(e.unicode)
        ? []
        : [
            {
              emoji: e.unicode,
              name: wordsOf(e.label),
              tags: (e.tags ?? []).flatMap(wordsOf),
              order: e.order ?? 0,
            },
          ],
    )
  },
  staleTime: Infinity,
  gcTime: Infinity,
})

/** 2 when a word of the list is the word typed, 1 when one starts with it. */
const fit = (list: readonly string[], w: string) => {
  if (list.includes(w)) {
    return 2
  }
  return list.some((x) => x.startsWith(w)) ? 1 : 0
}

const scoreOf = (e: Entry, words: readonly string[]) => {
  let total = 0
  for (const w of words) {
    const best = Math.max(fit(e.name, w) * 2, fit(e.tags, w))
    if (best === 0) {
      return 0
    }
    total += best
  }
  // Its whole name typed ("fire", "eyes") first.
  return e.name.every((n) => words.includes(n)) ? total + 6 : total
}

/** The emoji that fit what's typed, the closest first, then in the standard order. */
export const findEmoji = (all: readonly Entry[], typed: string, most: number) => {
  const words = wordsOf(typed)
  if (words.length === 0) {
    return []
  }
  return all
    .map((e) => ({ e, score: scoreOf(e, words) }))
    .filter((x) => x.score > 0)
    .toSorted((a, b) => b.score - a.score || a.e.order - b.e.order)
    .slice(0, most)
    .map((x) => x.e.emoji)
}
