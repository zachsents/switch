// Names as people write them: decoration taken out, cased with care, and a full name split into
// given and family. Pure, so the app's view can use it too.

/** Emoji and their joiners, selectors, flags and skin tones, and other symbols. */
const DECORATION =
  /\p{Extended_Pictographic}|\p{So}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u{200D}|\u{FE0E}|\u{FE0F}|\u{20E3}/gu

/** What may lead or trail a name: anything but a letter, a digit or a closing period or bracket. */
const EDGE_START = /^[^\p{L}\p{N}(]+/u
const EDGE_END = /[^\p{L}\p{N}.)]+$/u

/** What a broken export leaves where a name should be. */
const JUNK = /^(?:\(?(?:null|undefined)\)?\s*)+$/iu

/** A name's text with decoration out: styled letters made plain, emoji and symbols dropped. */
export const cleanText = (raw: string) =>
  raw
    .replace(JUNK, "")
    .normalize("NFKC")
    .replaceAll(DECORATION, "")
    .replaceAll(/\(\s*\)/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()

/** As `cleanText`, with stray punctuation off both ends too. */
export const cleanName = (raw: string) =>
  cleanText(raw).replace(EDGE_START, "").replace(EDGE_END, "").trim()

const PARTICLES = new Set([
  "al",
  "bin",
  "binti",
  "da",
  "das",
  "de",
  "del",
  "della",
  "den",
  "der",
  "di",
  "do",
  "dos",
  "du",
  "la",
  "le",
  "ten",
  "ter",
  "van",
  "von",
  "y",
])

const SUFFIXES: Readonly<Record<string, string>> = {
  jr: "Jr.",
  "jr.": "Jr.",
  sr: "Sr.",
  "sr.": "Sr.",
  ii: "II",
  iii: "III",
  iv: "IV",
}

/** Titles before a name, left out when it's split. */
const HONORIFICS = new Set(["dr", "mr", "mrs", "ms", "miss", "prof", "rev", "sir"])

const hasLower = (s: string) => /\p{Ll}/u.test(s)
const hasUpper = (s: string) => /\p{Lu}/u.test(s)

const capital = (s: string) => {
  const m = /^(?<first>.)(?<rest>.*)$/su.exec(s)
  return `${(m?.groups?.first ?? "").toLocaleUpperCase()}${(m?.groups?.rest ?? "").toLocaleLowerCase()}`
}

/** One part of a word, between hyphens: Mc and O' handled, else a capital then lower case. */
const casePart = (part: string) => {
  const lower = part.toLocaleLowerCase()
  if (/^mc\p{L}{2,}/u.test(lower)) {
    return `Mc${capital(lower.slice(2))}`
  }
  const quote = /^(?<head>\p{L})['’](?<tail>\p{L}+)$/u.exec(lower)
  if (quote?.groups !== undefined) {
    return `${capital(quote.groups.head ?? "")}'${capital(quote.groups.tail ?? "")}`
  }
  return capital(lower)
}

/** One word cased: a particle low inside a name, a suffix as written, else each part capitalised. */
const caseWord = (word: string, inside: boolean) => {
  const lower = word.toLocaleLowerCase()
  const suffix = SUFFIXES[lower]
  if (suffix !== undefined && inside) {
    return suffix
  }
  if (inside && PARTICLES.has(lower)) {
    return lower
  }
  return word
    .split("-")
    .map((p) => casePart(p))
    .join("-")
}

/**
 * A person's name cased with care, when it was written all in lower case or all in capitals:
 * "john o'brien" becomes "John O'Brien", "LUDWIG VAN BEETHOVEN" becomes "Ludwig van Beethoven".
 * Any other mix of cases was typed that way on purpose ("DeShawn", "AJ", "Supra door handle") and
 * stays, as does a name that doesn't read as a person's (a business, a number).
 */
export const caseName = (raw: string) => {
  const words = raw.split(" ").filter((w) => w !== "")
  const shouting = hasUpper(raw) && !hasLower(raw) && words.length > 1
  if (!personLike(raw) || (hasUpper(raw) && !shouting)) {
    return raw
  }
  return words
    .map((w, i) => {
      const letters = w.replaceAll(/[^\p{L}]/gu, "")
      if (letters === "") {
        return w
      }
      if (letters.length === 1) {
        return w.toLocaleUpperCase()
      }
      if (hasUpper(letters) && !(shouting && letters.length > 2)) {
        return w
      }
      return caseWord(w, i > 0)
    })
    .join(" ")
}

/** Reads as a person's name: no digits, addresses or business words, and not too long. */
const personLike = (name: string) =>
  !/[\d@|/·•–—:,;()[\]{}]/u.test(name) &&
  !/\.\p{L}{2,}\b/u.test(name) &&
  !/\p{L}['’]s\b/u.test(name) &&
  !NOT_A_PERSON.test(name) &&
  name.split(" ").length <= 4

/**
 * A name with a tag after a separator, such as where they're from: "Ann Lee · Acme" is Ann Lee,
 * tagged Acme. Only a short tag after what reads as a person's name.
 */
export const splitTag = (raw: string): { name: string; tag?: string } => {
  const m = /^(?<name>.*?)\s*[·•|]\s*(?<tag>[^·•|]+)$/u.exec(raw)
  const name = cleanName(m?.groups?.name ?? "")
  const tag = cleanName(m?.groups?.tag ?? "")
  const fits = name === "" || personLike(name)
  if (m === null || tag === "" || tag.split(" ").length > 3 || !fits) {
    return { name: raw }
  }
  return { name, tag }
}

/** A name as it should be kept: its tag off, clean, then cased. */
export const normalName = (raw: string) => caseName(cleanName(splitTag(cleanText(raw)).name))

/** A single letter, with or without its period: an initial. */
export const isInitial = (word: string) => /^\p{L}\.?$/u.test(word)

const NOT_A_PERSON =
  /\b(?:llc|inc|corp|co|ltd|company|bank|services?|pharmacy|clinic|team|support|store|shop|restaurant|the|and|of|for|through|via|at|by|with|from|no-?reply|notifications?|verification|api)\b|&/iu

/** A full name split in two; nothing when it doesn't read as a person's name. */
export const splitName = (
  full: string,
): { given?: string; family?: string; initial?: string } | null => {
  const name = normalName(full)
  if (name === "" || !personLike(name)) {
    return null
  }
  const words = name.split(" ")
  if (words.length > 4) {
    return null
  }
  while (words.length > 1 && HONORIFICS.has((words[0] ?? "").toLowerCase().replace(".", ""))) {
    words.shift()
  }
  const suffixes: string[] = []
  while (words.length > 2) {
    const suffix = SUFFIXES[(words.at(-1) ?? "").toLowerCase()]
    if (suffix === undefined) {
      break
    }
    words.pop()
    suffixes.unshift(suffix)
  }
  if (words.length === 1) {
    return { given: words[0] ?? "" }
  }
  let start = words.length - 1
  while (start > 1 && PARTICLES.has(words[start - 1] ?? "")) {
    start -= 1
  }
  const given = cleanName(words.slice(0, start).join(" "))
  const family = cleanName([...words.slice(start), ...suffixes].join(" "))
  if (isInitial(family)) {
    return { given, initial: family.replace(".", "").toLocaleUpperCase() }
  }
  return { given, family }
}

/** Given, family or initial, and nickname, put back together as a name to show. */
export const composeName = (parts: {
  readonly given?: string | undefined
  readonly family?: string | undefined
  readonly initial?: string | undefined
}) => {
  const last = parts.family ?? (parts.initial === undefined ? undefined : `${parts.initial}.`)
  return [parts.given, last].filter((x) => x !== undefined && x !== "").join(" ")
}
