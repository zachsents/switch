// Notable names and terms linked to their Wikipedia articles, conservatively: the small model
// names what a reader might look up (its words exactly as written), with proper names found in the
// words besides, and only those with a real article (no disambiguation page) are linked, each once,
// at its first mention outside headings, code, math and links. A lowercase term links only to an
// article of its own name.
import { articles, articleUrl } from "./lookup.ts"
import type { Section } from "./formats.ts"

/** At most this many links in a document, and about one per this many words. */
const MOST = 80
const WORDS_PER_LINK = 120

/** Proper names: runs of two to four capitalized words, as they're written. */
const NAMES =
  /(?<![\p{L}\p{N}.])(?:\p{Lu}[\p{Ll}\p{M}'’-]+(?:\s+(?:of|the|de|von|van|and|la|le|du|der|da)\s+|\s+)){1,3}\p{Lu}[\p{Ll}\p{M}'’-]+(?![\p{L}\p{N}])/gu

const STOP = new Set([
  "The",
  "This",
  "That",
  "These",
  "Those",
  "In",
  "On",
  "At",
  "For",
  "And",
  "But",
  "If",
  "When",
  "While",
  "A",
  "An",
  "It",
  "We",
  "They",
  "He",
  "She",
  "I",
  "Figure",
  "Table",
  "Chapter",
  "Section",
  "Page",
])

/** The words of Markdown, roughly: what a model or a match reads. */
export const plainOf = (markdown: string) =>
  markdown
    .replaceAll(/```[\s\S]*?```/gu, " ")
    .replaceAll(/\$\$[\s\S]*?\$\$/gu, " ")
    .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replaceAll(/\[(?<words>[^\]]*)\]\([^)]*\)/gu, "$<words>")
    .replaceAll(/[`*_#>|\\]/gu, "")

/** Proper names in the words, the most mentioned first. */
export const names = (text: string) => {
  const counts = new Map<string, number>()
  for (const m of text.matchAll(NAMES)) {
    const words = m[0].replaceAll(/\s+/gu, " ").trim()
    const first = words.split(" ")[0] ?? ""
    if (STOP.has(first)) {
      continue
    }
    counts.set(words, (counts.get(words) ?? 0) + 1)
  }
  return [...counts.entries()].toSorted((a, b) => b[1] - a[1]).map(([w]) => w)
}

/** Spans of a line no link may go in: code, math, links and pictures, addresses, tags. */
const guarded = (line: string) => {
  const spans: [number, number][] = []
  const res = [
    /`[^`]*`/gu,
    /\$[^$]+\$/gu,
    /!?\[[^\]]*\]\([^)]*\)/gu,
    /<[^>]+>/gu,
    /https?:\/\/\S+/gu,
    /\\./gu,
  ]
  for (const re of res) {
    for (const m of line.matchAll(re)) {
      spans.push([m.index, m.index + m[0].length])
    }
  }
  return spans
}

const escapeRe = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** Links each term's first mention in the sections, in order. */
export const link = (
  sections: readonly Section[],
  terms: ReadonlyMap<string, string>,
  lang: string,
): Section[] => {
  const left = new Map(terms)
  return sections.map((s) => {
    if (left.size === 0) {
      return s
    }
    let fence = false
    const lines = s.markdown.split("\n").map((line) => {
      if (/^\s*(?:```|~~~)/u.test(line)) {
        fence = !fence
        return line
      }
      // Only prose is linked: a short line is a byline, an address, a caption or a list's label.
      const prose = line.trim().split(/\s+/u).length >= 12
      if (fence || !prose || /^\s*#/u.test(line) || /^\s{4,}\S/u.test(line) || left.size === 0) {
        return line
      }
      let out = line
      for (const [term, title] of [...left.entries()].toSorted(
        (a, b) => b[0].length - a[0].length,
      )) {
        const lower = term === term.toLowerCase()
        const re = new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`,
          lower ? "iu" : "u",
        )
        const spans = guarded(out)
        let found: RegExpExecArray | null = null
        let from = 0
        for (;;) {
          re.lastIndex = 0
          const m = re.exec(out.slice(from))
          if (!m) {
            break
          }
          const at = from + m.index
          const end = at + m[0].length
          if (!spans.some(([a, b]) => at < b && end > a)) {
            found = m
            found.index = at
            break
          }
          from = end
        }
        if (found) {
          const at = found.index
          const [said] = found
          out = `${out.slice(0, at)}[${said}](${articleUrl(title, lang)})${out.slice(at + said.length)}`
          left.delete(term)
        }
      }
      return out
    })
    return { ...s, markdown: lines.join("\n") }
  })
}

/** Which terms to link, and to which article: candidates checked against Wikipedia. */
export const linkable = async (
  candidates: readonly string[],
  lang: string,
  words: number,
): Promise<Map<string, string>> => {
  const most = Math.min(MOST, Math.max(4, Math.round(words / WORDS_PER_LINK)))
  const unique = [
    ...new Set(candidates.map((c) => c.trim()).filter((c) => c.length > 2 && c.length < 80)),
  ]
  const found = await articles(unique, lang)
  const chosen = new Map<string, string>()
  for (const term of unique) {
    const title = found.get(term)
    if (title === undefined) {
      continue
    }
    // A plain word only to its own article, never through a redirect elsewhere.
    if (term === term.toLowerCase() && title.toLowerCase() !== term.toLowerCase()) {
      continue
    }
    // A single word is too often something else (a character, a first name, a common word that
    // has an article): only an acronym is linked alone; any word is a selection away anyway.
    if (!term.includes(" ") && !/^\p{Lu}{2,}$/u.test(term)) {
      continue
    }
    chosen.set(term, title)
    if (chosen.size >= most) {
      break
    }
  }
  return chosen
}
