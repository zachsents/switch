// What a word or a name is: its dictionary senses (Wiktionary's, from its REST API) and its
// Wikipedia article's summary, each only when there's a real entry: a disambiguation page or a
// missing word is none. Both in the document's language; the reader keeps each answer (`define`).
import type { Article, Dictionary } from "./store.ts"

const AGENT = "SwitchReader/1 (https://github.com/zachsents/switch)"

interface Sense {
  readonly pos: string
  readonly text: string
  readonly example?: string
}

const json = async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { "User-Agent": AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw new Error(`${new URL(url).host} answered ${res.status}`)
  }
  return await res.json()
}

const get = (v: unknown, k: string): unknown =>
  typeof v === "object" && v !== null && k in v ? Reflect.get(v, k) : undefined
const str = (v: unknown) => (typeof v === "string" ? v : "")
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** HTML's words alone. */
const plain = (html: string) =>
  html
    .replaceAll(/<[^>]+>/gu, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll(/&#(?<code>\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replaceAll(/\s+/gu, " ")
    .trim()

const SKIPPED = new Set([
  "symbol",
  "letter",
  "abbreviation",
  "initialism",
  "acronym",
  "romanization",
  "suffix",
  "prefix",
])
const ORDER = [
  "noun",
  "verb",
  "adjective",
  "adverb",
  "proper noun",
  "pronoun",
  "preposition",
  "conjunction",
]
const rank = (pos: string) => {
  const at = ORDER.indexOf(pos.toLowerCase())
  return at === -1 ? ORDER.length : at
}

/** One spelling's senses in Wiktionary, its first few in each part of speech; none without an entry. */
const entryOf = async (w: string, lang: string): Promise<Dictionary | null> => {
  const got = await json(
    `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(w.replaceAll(" ", "_"))}`,
  )
  // A word's own parts of speech, the usual first; a code or a symbol it also spells isn't one.
  const entries = list(get(got, lang))
    .filter((e) => !SKIPPED.has(str(get(e, "partOfSpeech")).toLowerCase()))
    .toSorted((a, b) => rank(str(get(a, "partOfSpeech"))) - rank(str(get(b, "partOfSpeech"))))
  const senses: Sense[] = []
  // At most two senses a part of speech, over all its etymologies.
  const per = new Map<string, number>()
  for (const e of entries) {
    const pos = str(get(e, "partOfSpeech")).toLowerCase()
    for (const d of list(get(e, "definitions"))) {
      const text = plain(str(get(d, "definition")))
      const n = per.get(pos) ?? 0
      if (text === "" || n >= 2) {
        continue
      }
      per.set(pos, n + 1)
      const example = plain(str(list(get(d, "examples"))[0]))
      senses.push({ pos, text, ...(example !== "" && { example }) })
    }
  }
  if (senses.length === 0) {
    return null
  }
  return {
    word: w,
    senses: senses.slice(0, 4),
    url: `https://en.wiktionary.org/wiki/${encodeURIComponent(w.replaceAll(" ", "_"))}`,
  }
}

/** The first of `tries` with an entry, asked one at a time, in order. */
const firstEntry = async (tries: readonly string[], lang: string): Promise<Dictionary | null> => {
  const [w, ...rest] = tries
  if (w === undefined) {
    return null
  }
  const entry = await entryOf(w, lang)
  return entry ?? (await firstEntry(rest, lang))
}

/** An inflection's word ("simple past of couple"): the word whose senses say what it means. */
const FORM_OF = /\b(?:of|form of)\s+(?<lemma>[\p{L}'’-]+)\.?$/u

/** A form's entry with its word's senses after its own, when every sense only names that word. */
const withLemma = async (entry: Dictionary | null, lang: string): Promise<Dictionary | null> => {
  if (entry === null) {
    return null
  }
  const lemmas = new Set(entry.senses.map((s) => FORM_OF.exec(s.text)?.groups?.lemma))
  const [lemma] = lemmas
  const forms = entry.senses.every((s) =>
    /\b(?:participle|plural|tense|form|singular|comparative|superlative)\b/u.test(s.text),
  )
  if (
    lemmas.size !== 1 ||
    lemma === undefined ||
    !forms ||
    lemma.toLowerCase() === entry.word.toLowerCase()
  ) {
    return entry
  }
  const base = await entryOf(lemma, lang)
  if (base === null) {
    return entry
  }
  // The word's senses in the form's part of speech first.
  const pos = entry.senses[0]?.pos
  const same = base.senses.filter((s) => s.pos === pos)
  const rest = base.senses.filter((s) => s.pos !== pos)
  return { ...entry, senses: [...entry.senses.slice(0, 1), ...same, ...rest].slice(0, 4) }
}

/** A word's senses, its first few in each part of speech; none when Wiktionary has no entry. */
export const define = async (word: string, lang: string): Promise<Dictionary | null> =>
  await withLemma(await firstEntry([...new Set([word, word.toLowerCase()])], lang), lang)

/** A title's article summary (following redirects); none for a missing or disambiguation page. */
export const wikipedia = async (title: string, lang: string): Promise<Article | null> => {
  const got = await json(
    `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}?redirect=true`,
  )
  if (got === null || str(get(got, "type")) !== "standard") {
    return null
  }
  const extract = str(get(got, "extract"))
  if (extract === "") {
    return null
  }
  const description = str(get(got, "description"))
  const thumbnail = str(get(get(got, "thumbnail"), "source"))
  return {
    title: str(get(got, "title")),
    ...(description !== "" && { description }),
    extract,
    url: str(get(get(get(got, "content_urls"), "desktop"), "page")),
    ...(thumbnail !== "" && { thumbnail }),
  }
}

/** A Wikipedia link's language and title, when it is one. */
export const wikiTitle = (url: string): { lang: string; title: string } | null => {
  try {
    const u = new URL(url)
    const lang = /^(?<lang>[a-z-]+)\.(?:m\.)?wikipedia\.org$/u.exec(u.hostname)?.groups?.lang ?? ""
    if (lang === "" || !u.pathname.startsWith("/wiki/")) {
      return null
    }
    return { lang, title: decodeURIComponent(u.pathname.slice(6)).replaceAll("_", " ") }
  } catch {
    return null
  }
}

/**
 * Which of `titles` are real articles: each one's article title (after redirects), for those that
 * exist and aren't disambiguation pages. Fifty to a request, as the API takes them.
 */
export const articles = async (titles: readonly string[], lang: string) => {
  const found = new Map<string, string>()
  await checkFrom(titles, 0, lang, found)
  return found
}

/** Checks the titles from `i` on, a batch at a time, each after the last. */
const checkFrom = async (
  titles: readonly string[],
  i: number,
  lang: string,
  found: Map<string, string>,
) => {
  if (i >= titles.length) {
    return
  }
  await checkBatch(titles.slice(i, i + 50), lang, found)
  await checkFrom(titles, i + 50, lang, found)
}

const checkBatch = async (batch: readonly string[], lang: string, found: Map<string, string>) => {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    redirects: "1",
    prop: "pageprops",
    ppprop: "disambiguation",
    titles: batch.join("|"),
  })
  const got = await json(`https://${lang}.wikipedia.org/w/api.php?${params}`)
  const query = get(got, "query")
  const to = new Map<string, string>()
  for (const r of [...list(get(query, "normalized")), ...list(get(query, "redirects"))]) {
    to.set(str(get(r, "from")), str(get(r, "to")))
  }
  const real = new Set<string>()
  for (const p of list(get(query, "pages"))) {
    if (get(p, "missing") === true || get(p, "invalid") === true) {
      continue
    }
    if (get(get(p, "pageprops"), "disambiguation") !== undefined) {
      continue
    }
    real.add(str(get(p, "title")))
  }
  for (const t of batch) {
    let at = t
    for (let hop = 0; hop < 3 && to.has(at); hop += 1) {
      at = to.get(at) ?? at
    }
    if (real.has(at)) {
      found.set(t, at)
    }
  }
}

export const articleUrl = (title: string, lang: string) =>
  `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`
