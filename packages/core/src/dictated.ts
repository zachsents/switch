// What a message says about its words being dictated, for the agent and the pre-read: speech
// recognition mishears a word as one that sounds like it, names most of all ("Tessel" comes out
// "tassel"), so they're told which words to weigh by how they sound.
import type { Dictated } from "@switch/brain"

/** A text's code points, as a stretch's `start` counts them. */
const pointsOf = (text: string) => text.match(/./gsu) ?? []

/** Whether the stretches hold every letter and digit of `text`. */
const covers = (text: string, dictated: Dictated) => {
  const points = pointsOf(text)
  const held = points.map(() => false)
  for (const d of dictated) {
    const { length } = pointsOf(d.text)
    const at = points.slice(d.start, d.start + length).join("") === d.text ? d.start : -1
    if (at !== -1) {
      held.fill(true, at, at + length)
    }
  }
  return points.every((c, i) => held[i] === true || !/[\p{L}\p{N}]/u.test(c))
}

/** "Dictated: …", or "" when they typed it all. */
export const dictatedNote = (text: string, dictated: Dictated | undefined) => {
  const said = (dictated ?? []).filter((d) => d.text.trim() !== "")
  if (said.length === 0) {
    return ""
  }
  const which = covers(text, said) ? "all of it" : said.map((d) => `"${d.text}"`).join(", ")
  return `Dictated: ${which}. Speech recognition can mishear a word as one that sounds like it, names most of all.`
}
