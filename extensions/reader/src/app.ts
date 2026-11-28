// Reader: documents of any common kind, read in Switch's own reader, with a word's definition and
// a name's Wikipedia article a selection away, and follow-up questions each in a thread of its own,
// anchored to its passage: asked of Switch itself (switch-ext-kit's `Switch.ask`), a real turn in a
// side thread of the document's space, which the space's chat knows of but never shows. What a
// thread settles, that turn pins to the passage as a note (`annotate`), shown in the margin and
// found again wherever another document mentions its term.
import { Effect, Schema } from "effect"
import {
  AppEvents,
  Caller,
  defineApp,
  defineEvent,
  Host,
  Models,
  Progress,
  sideOfThread,
  sideThread,
  Switch,
  SWITCH_CATALOG,
  tool,
} from "switch-ext-kit"
import type {
  AppEventsService,
  Draft,
  HostService,
  LogService,
  ModelsService,
  SwitchService,
} from "switch-ext-kit"

import { anchor, mention, passage, textsOf, within } from "./anchor.ts"
import { words } from "./formats.ts"
import type { Parsed } from "./formats.ts"
import { link, linkable, names, plainOf } from "./links.ts"
import { define as dictionary, wikiTitle, wikipedia } from "./lookup.ts"
import { docId, fromText, isUrl, readSource } from "./source.ts"
import {
  Answered,
  ArticleSummary,
  Asked,
  DictionaryEntry,
  Highlighted,
  Linked,
  LookedUp,
  Noted,
  NoteKind,
  Opened,
  Quote,
  Unhighlighted,
  Unnoted,
  load,
  logged,
  read,
  record,
  save,
} from "./store.ts"
import type {
  DocRow,
  HighlightRow,
  LookupRow,
  MessageRow,
  NoteRow,
  Passage,
  Stored,
  ThreadRow,
} from "./store.ts"

const BEAT = 5 * 60_000

export const Heartbeat = defineEvent(
  "reader.heartbeat",
  1,
  Schema.Struct({
    entity: Schema.Literal("sense:reader"),
    summary: Schema.String,
    facts: Schema.Struct({ failing: Schema.NullOr(Schema.String), documents: Schema.Finite }),
  }),
)

const id = (prefix: string) => `${prefix}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`

/** Recorded in the reader's log and sent to the brain. */
const happen = (draft: Draft) =>
  Effect.gen(function* happening() {
    yield* record(id("e"), draft)
    const events = yield* AppEvents
    yield* Effect.ignore(events.emit(draft), { log: "Warn" })
  })

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const plural = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`

/** What a document is, in a few words: its pages or words. */
const detailOf = (format: string, sections: number, wordCount: number) =>
  format === "pdf" ? plural(sections, "page") : plural(wordCount, "word")

const decodeQuote = Schema.decodeUnknownSync(Schema.fromJsonString(Quote))

const quoteOf = (s: string | null) => (s === null ? null : decodeQuote(s))

// --- Opening ---

/** Its notable terms linked to Wikipedia, once, after it opens. */
const linkTerms = (stored: Stored) =>
  Effect.gen(function* linking() {
    const models = yield* Models
    const text = plainOf(stored.sections.map((s) => s.markdown).join("\n\n"))
    const sample = text.slice(0, 24_000)
    const asked = yield* Effect.option(
      models.complete(
        "triage",
        "You pick what a reader might look up on Wikipedia in a text: notable real people, places, organizations, works, events, and scientific or technical concepts, each only when its Wikipedia article would be about that very thing. Never common words, and never a story's characters or anyone known only from the text. Answer with a JSON array of strings only: each exactly as it is written in the text, at most 60.",
        sample,
      ),
    )
    const named =
      asked._tag === "Some" ? (/\[[\s\S]*\]/u.exec(asked.value.text)?.[0] ?? "[]") : "[]"
    const parsed: unknown = yield* Effect.try((): unknown => JSON.parse(named)).pipe(
      Effect.orElseSucceed(() => []),
    )
    const said = Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === "string" && text.includes(t))
      : []
    const candidates = [...said, ...names(text).slice(0, 80)]
    const terms = yield* attempt(async () => await linkable(candidates, stored.lang, stored.words))
    const latest = load(stored.doc) ?? stored
    const next: Stored = {
      ...latest,
      sections: link(latest.sections, terms, latest.lang),
      version: latest.version + 1,
      linked: true,
    }
    save(next)
    yield* happen(Linked.make({ doc: next.doc, version: next.version, links: terms.size }))
  })

const viewOf = (doc: string, thread?: string) => ({
  app: "reader",
  name: "document",
  input: thread === undefined ? { doc } : { doc, thread },
})

const field = (p: unknown, k: string) => {
  const v: unknown = typeof p === "object" && p !== null ? Reflect.get(p, k) : undefined
  return typeof v === "string" ? v : ""
}

/** A page by its id or title, as `brain_pages` lists them: its link. */
const pageLink = (wanted: string) =>
  Effect.gen(function* finding() {
    const host = yield* Host
    const got = yield* host.call("brain_pages", {})
    // The tool's result: its structured content holds the list.
    const structured: unknown = Reflect.get(got, "structuredContent")
    const pages: unknown =
      typeof structured === "object" && structured !== null
        ? Reflect.get(structured, "pages")
        : undefined
    const list: readonly unknown[] = Array.isArray(pages) ? pages : []
    const key = wanted
      .replace(/^page:/u, "")
      .trim()
      .toLowerCase()
    const hit =
      list.find((p) => field(p, "id").toLowerCase() === key) ??
      list.find((p) => field(p, "title").toLowerCase() === key)
    return hit === undefined ? null : field(hit, "link")
  })

const OpenInput = Schema.Struct({
  source: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
})

const open = tool(
  "open",
  {
    description:
      "Opens a document in the reader: `source` is a file path on this machine, a web address (an article, a PDF, an EPUB…), or a published page's link, id or title (`page:<id>`); or give `text` (Markdown or HTML) with a `title`. PDF, EPUB, HTML, Markdown, plain text, DOCX, RTF, DOC, ODT, CSV and code. Returns the document and its `view` (show it with brain_show_widget, or a desktop's open_view).",
    closed: true,
    input: OpenInput,
  },
  (input) =>
    Effect.gen(function* opening() {
      let source = input.source?.trim() ?? ""
      let parsed: Parsed
      if (input.text === undefined) {
        if (source === "") {
          return yield* Effect.fail(new Error("Give a source or text"))
        }
        if (
          !isUrl(source) &&
          !source.startsWith("/") &&
          !source.startsWith("~") &&
          !source.startsWith("file:")
        ) {
          const page = yield* pageLink(source)
          if (page === null) {
            return yield* Effect.fail(new Error(`No file, address or page ${source}`))
          }
          source = page
        }
        const from = source
        parsed = yield* attempt(async () => await readSource(from))
      } else {
        const title = input.title ?? "Untitled"
        source ||= `text:${docId(input.text)}`
        parsed = fromText(input.text, title, /^\s*</u.test(input.text))
      }
      const doc = docId(source)
      const before = load(doc)
      const caller = yield* Caller
      const stored: Stored = {
        doc,
        source,
        title: input.title ?? parsed.title,
        format: parsed.format,
        lang: parsed.lang,
        ...(parsed.author !== undefined && { author: parsed.author }),
        words: words(parsed),
        sections: parsed.sections,
        ...(parsed.outline !== undefined &&
          parsed.outline.length > 0 && { outline: parsed.outline }),
        version: (before?.version ?? 0) + 1,
        linked: false,
      }
      save(stored)
      yield* happen(
        Opened.make({
          doc,
          title: stored.title,
          format: stored.format,
          source,
          words: stored.words,
          sections: stored.sections.length,
          ...(caller.space !== null && { space: caller.space }),
        }),
      )
      yield* Effect.forkDetach(Effect.ignore(linkTerms(stored), { log: "Warn" }))
      return {
        doc,
        title: stored.title,
        format: stored.format,
        words: stored.words,
        sections: stored.sections.length,
        view: viewOf(doc),
      }
    }),
)

// --- Reading ---

const docRows = read((db) => db.query<DocRow, []>("SELECT * FROM docs ORDER BY opened DESC").all())

const counts = read((db) => {
  const rows = db
    .query<{ doc: string; threads: number }, []>(
      "SELECT doc, COUNT(*) AS threads FROM threads GROUP BY doc",
    )
    .all()
  return new Map(rows.map((r) => [r.doc, r.threads]))
})

const documents = tool(
  "documents",
  {
    description:
      "Documents opened in the reader, the latest first, with how many threads each has.",
    readOnly: true,
  },
  () =>
    Effect.gen(function* listing() {
      const rows = yield* docRows
      const threads = yield* counts
      return {
        docs: rows.map((r) => ({
          doc: r.doc,
          title: r.title,
          format: r.format,
          source: r.source,
          detail: detailOf(r.format, r.sections, r.words),
          threads: threads.get(r.doc) ?? 0,
          opened: r.opened,
        })),
      }
    }),
)

const Doc = Schema.Struct({ doc: Schema.String })

const stored = (doc: string) =>
  Effect.gen(function* finding() {
    const s = load(doc)
    if (s === null) {
      return yield* Effect.fail(new Error(`No document ${doc}`))
    }
    return s
  })

/** The space a document was opened from, else null. */
const spaceOfDoc = (doc: string) =>
  read(
    (db) =>
      db.query<{ space: string | null }, [string]>("SELECT space FROM docs WHERE doc = ?").get(doc)
        ?.space ?? null,
  )

/**
 * Questions whose answer never came (the reader or Switch restarted while it was coming): asked
 * again with the same id, so Switch's answer is read from the turn that took them in.
 */
export const resume = Effect.gen(function* resuming() {
  const waiting = yield* read((db) =>
    db
      .query<
        {
          thread: string
          doc: string
          quote: string | null
          space: string | null
          message: string
          text: string
        },
        []
      >(
        `SELECT t.id AS thread, t.doc, t.quote, t.space, m.id AS message, m.text FROM threads t
         JOIN messages m ON m.id = (SELECT id FROM messages WHERE thread = t.id ORDER BY time DESC, rowid DESC LIMIT 1)
         WHERE m.role = 'user'`,
      )
      .all(),
  )
  yield* Effect.forEach(
    waiting,
    (w) =>
      Effect.gen(function* again() {
        const s = load(w.doc)
        if (s !== null) {
          yield* askSwitch(s, w.thread, w.message, w.text, quoteOf(w.quote), w.space)
        }
      }),
    { concurrency: 4, discard: true },
  )
})

const threadsOf = (doc: string | null, only?: string) =>
  read((db) => {
    const threads =
      only === undefined
        ? db
            .query<ThreadRow, [string]>("SELECT * FROM threads WHERE doc = ? ORDER BY started")
            .all(doc ?? "")
        : db.query<ThreadRow, [string]>("SELECT * FROM threads WHERE id = ?").all(only)
    const messages = db.query<MessageRow, [string]>(
      "SELECT * FROM messages WHERE thread = ? ORDER BY time, rowid",
    )
    return threads.map((t) => {
      const all = messages.all(t.id)
      return {
        id: t.id,
        doc: t.doc,
        quote: quoteOf(t.quote),
        space: t.space,
        started: t.started,
        updated: t.updated,
        waiting: all.at(-1)?.role === "user",
        messages: all.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          ...(m.failed !== null && { failed: m.failed }),
        })),
      }
    })
  })

const highlightsOf = (doc: string) =>
  read((db) =>
    db
      .query<HighlightRow, [string]>("SELECT * FROM highlights WHERE doc = ? ORDER BY time")
      .all(doc)
      .map((h) => ({ id: h.id, ...decodeQuote(h.quote) })),
  )

const document = tool(
  "document",
  {
    description:
      "A document's title, kind and size, its highlights, its threads with every message, its notes, and the notes from other documents whose term it mentions (`seen`), by `doc`; `thread` names one to show open.",
    readOnly: true,
    input: Schema.Struct({ doc: Schema.String, thread: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const s = yield* stored(input.doc)
      const all = textsOf(s)
      return {
        doc: s.doc,
        title: s.title,
        format: s.format,
        source: s.source,
        ...(s.author !== undefined && { author: s.author }),
        lang: s.lang,
        detail: detailOf(s.format, s.sections.length, s.words),
        version: s.version,
        open: input.thread ?? "",
        highlights: yield* highlightsOf(s.doc),
        threads: (yield* threadsOf(s.doc)).map((t) => ({
          ...t,
          quote: t.quote === null ? null : anchor(all, t.quote),
        })),
        notes: (yield* noteRows(s.doc)).map((n) => noteOut(n, all)),
        seen: yield* seenIn(s),
      }
    }),
)

const content = tool(
  "content",
  {
    description:
      "A document's words as Markdown, section by section (a PDF's pages, an EPUB's chapters), its notable terms linked to Wikipedia, and its own outline when it has one (a PDF's bookmarks, an EPUB's contents); `from` and `count` take a part.",
    readOnly: true,
    input: Schema.Struct({
      doc: Schema.String,
      from: Schema.optionalKey(Schema.Finite),
      count: Schema.optionalKey(Schema.Finite),
    }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const s = yield* stored(input.doc)
      const from = Math.max(0, input.from ?? 0)
      const to = input.count === undefined ? s.sections.length : from + input.count
      return {
        doc: s.doc,
        version: s.version,
        total: s.sections.length,
        sections: s.sections.slice(from, to).map((sec, i) => ({ index: from + i, ...sec })),
        ...(s.outline !== undefined && { outline: s.outline }),
      }
    }),
)

// --- Looking up ---

/** A selection a dictionary could have: a few words, no sentence. */
const wordish = (s: string) =>
  s.length <= 48 && s.split(/\s+/u).length <= 4 && !/[.!?;:]\s/u.test(s)

const decodeDictionary = Schema.decodeUnknownSync(Schema.fromJsonString(DictionaryEntry))
const decodeArticle = Schema.decodeUnknownSync(Schema.fromJsonString(ArticleSummary))

/** A lookup's kept answer by its key: this document's, else any document's; null if never asked. */
const lookedUp = (key: string, doc: string) =>
  read(
    (db) =>
      db
        .query<LookupRow, [string, string]>(
          "SELECT * FROM lookups WHERE key = ? ORDER BY doc = ? DESC, time DESC LIMIT 1",
        )
        .get(key, doc) ?? null,
  )

/**
 * A term's lookup, kept: this document's, else another's (kept with this one too), else fetched
 * once and kept. `article` when it's a Wikipedia link's, no dictionary asked.
 */
const lookUp = (term: string, lang: string, article: boolean, doc: string) =>
  Effect.gen(function* lookingUp() {
    const key = `${article ? "w" : "t"}:${lang}:${term}`
    const kept = yield* lookedUp(key, doc)
    if (kept !== null) {
      const found = {
        term,
        dictionary: kept.dictionary === null ? null : decodeDictionary(kept.dictionary),
        wikipedia: kept.wikipedia === null ? null : decodeArticle(kept.wikipedia),
      }
      if (kept.doc !== doc) {
        yield* happen(LookedUp.make({ key, ...found, ...(doc !== "" && { doc }) }))
      }
      return found
    }
    const [dict, summary] = yield* Effect.all(
      [
        article ? Effect.succeed(null) : attempt(async () => await dictionary(term, lang)),
        attempt(async () => await wikipedia(term, lang)),
      ],
      { concurrency: 2 },
    )
    // A plain lowercase word the dictionary knows means that, not a show or a band of its name.
    const plainWord =
      !article && dict !== null && !term.includes(" ") && term === term.toLowerCase()
    const found = { term, dictionary: dict, wikipedia: plainWord ? null : summary }
    yield* happen(LookedUp.make({ key, ...found, ...(doc !== "" && { doc }) }))
    return found
  })

const define = tool(
  "define",
  {
    description:
      "What a word or name is: its dictionary senses (Wiktionary) and its Wikipedia article's summary, each when there is a real entry. `term`, or a Wikipedia `url`; `doc` gives the language. Each answer is kept with its document and never fetched twice.",
    readOnly: true,
    input: Schema.Struct({
      term: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
      doc: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* defining() {
      const lang = (input.doc === undefined ? null : load(input.doc))?.lang ?? "en"
      const wiki = input.url === undefined ? null : wikiTitle(input.url)
      const term = (wiki?.title ?? input.term ?? "")
        .trim()
        .replaceAll(/^[\s"'“”‘’([{]+|[\s"'“”‘’)\]},.;:!?]+$/gu, "")
      if (term === "") {
        return yield* Effect.fail(new Error("Give a term or url"))
      }
      if (wiki === null && !wordish(term)) {
        return { term, dictionary: null, wikipedia: null }
      }
      return yield* lookUp(term, wiki?.lang ?? lang, wiki !== null, input.doc ?? "")
    }),
)

// --- Highlights ---

const highlight = tool(
  "highlight",
  {
    description:
      "Highlights a passage of a document: `quote` is its section, its exact words, and a little before and after.",
    closed: true,
    input: Schema.Struct({ doc: Schema.String, quote: Quote }),
  },
  (input) =>
    Effect.gen(function* marking() {
      yield* stored(input.doc)
      const made = id("hl")
      yield* happen(Highlighted.make({ doc: input.doc, highlight: made, quote: input.quote }))
      return { highlight: made }
    }),
)

const unhighlight = tool(
  "unhighlight",
  {
    description: "Removes a highlight.",
    closed: true,
    input: Schema.Struct({ doc: Schema.String, highlight: Schema.String }),
  },
  (input) =>
    Effect.gen(function* unmarking() {
      yield* happen(Unhighlighted.make(input))
      return { removed: input.highlight }
    }),
)

const highlights = tool(
  "highlights",
  {
    description: "A document's highlights, in the order they were made.",
    readOnly: true,
    input: Doc,
  },
  (input) =>
    Effect.gen(function* listing() {
      return { highlights: yield* highlightsOf(input.doc) }
    }),
)

// --- Threads ---

/** About how much of the document goes beside a question: the passage's section and its neighbours. */
const AROUND = 12_000

/** The document around `section`: that section, then those either side while they fit. */
const aroundOf = (s: Stored, section: number) => {
  const all = s.sections.map((sec) => {
    const label = sec.label ?? ""
    return label === ""
      ? sec.markdown
      : `[${s.format === "pdf" ? "Page " : ""}${label}]\n${sec.markdown}`
  })
  const at = Math.min(Math.max(section, 0), all.length - 1)
  const picked = new Set<number>([at])
  let size = all[at]?.length ?? 0
  for (let d = 1; d < all.length && size < AROUND; d += 1) {
    for (const i of [at - d, at + d]) {
      const part = all[i]
      if (part !== undefined && !picked.has(i) && size + part.length <= AROUND) {
        picked.add(i)
        size += part.length
      }
    }
  }
  return [...picked]
    .toSorted((x, y) => x - y)
    .map((i) => all[i])
    .join("\n\n[…]\n\n")
}

/** The passage a thread is about, as Switch reads it. */
const passageOf = (s: Stored, quote: Passage) => {
  const label = s.sections[quote.section]?.label ?? ""
  const where = label === "" ? "" : ` (${s.format === "pdf" ? "page " : ""}${label})`
  return `The passage this thread is about${where}:\n<passage>\n${quote.prefix ?? ""}[[${quote.exact}]]${quote.suffix ?? ""}\n</passage>\n(The words in [[ ]] are what they selected.)`
}

/**
 * What goes beside the user's question for Switch: the document, the passage and the words around
 * it. The whole document is a call away (reader_content), so a long one isn't sent with every
 * question.
 */
/** A note, a line of what Switch reads. */
const lineOf = (n: { term: string; text: string }) =>
  `- ${n.term}: ${n.text.replaceAll(/\s+/gu, " ")}`

const contextOf = (
  s: Stored,
  threadId: string,
  quote: Passage | null | undefined,
  noted: readonly NoteRow[],
  seen: readonly { term: string; text: string; source: string }[],
) => {
  const author = s.author ?? ""
  return [
    `They're reading "${s.title}"${author === "" ? "" : ` by ${author}`} (${s.format}, doc ${s.doc}) in the reader, and ask about it there, in reader thread ${threadId}. All of it: reader_content with doc ${s.doc}.`,
    quote === null || quote === undefined ? "" : passageOf(s, quote),
    `<document-excerpt>\n${aroundOf(s, quote?.section ?? 0)}\n</document-excerpt>`,
    "Answer in Markdown (math as $…$ or $$…$$), as briefly as the question allows.",
    "When your answer settles something worth keeping beside the passage (what a term means, an idea explained, where to read more), also pin it there as one note with reader_annotate: kind `definition`, `callout` or `link`, `term` as the text writes it, `text` one plain, specific sentence of at most 25 words (no preamble, no restating the question). When nothing is settled, no note.",
    noted.length === 0
      ? ""
      : `This thread's notes (reader_edit_note to change one rather than add another):\n${noted.map((n) => `${lineOf(n)} (${n.id})`).join("\n")}`,
    seen.length === 0
      ? ""
      : `Noted before, in other documents they read:\n${seen.map((n) => `${lineOf(n)} (in "${n.source}")`).join("\n")}`,
  ]
    .filter((p) => p !== "")
    .join("\n\n")
}

/** What a thread's answer says once Switch's turn is over, or why there's none. */
const answered = (said: readonly string[], status: string, result: string) => {
  const answer = said.join("\n\n").trim()
  if (answer !== "") {
    return { answer }
  }
  return { answer: "", failed: status === "done" ? "No answer" : result || "Can't answer now" }
}

/** A reader thread's side thread with Switch, in its space (else Home). */
const sideOf = (thread: string, space: string | null) =>
  sideThread("reader", space ?? "home", thread)

/** A question asked of Switch about a thread's passage, answered (or failed) in the log. */
const askSwitch = (
  s: Stored,
  thread: string,
  message: string,
  question: string,
  quote: Passage | null | undefined,
  space: string | null,
) =>
  Effect.gen(function* asking() {
    const agent = yield* Switch
    const progress = yield* Progress
    const noted = (yield* noteRows(s.doc)).filter((n) => n.thread === thread)
    // Earlier notes on the terms the passage mentions.
    const seen =
      quote === null || quote === undefined
        ? []
        : (yield* seenIn(s)).filter((n) => mention([quote.exact], n.term) !== null)
    const got = yield* Effect.result(
      agent.ask(
        {
          key: thread,
          id: message,
          text: question,
          note: contextOf(s, thread, quote, noted, seen),
          title: `${s.title}${quote === null || quote === undefined ? "" : `: “${quote.exact.slice(0, 60)}”`}`,
          ...(space !== null && { space }),
        },
        (soFar) => progress(soFar),
      ),
    )
    const result =
      got._tag === "Success"
        ? answered(got.success.said, got.success.status, got.success.result)
        : { answer: "", failed: got.failure.message || "Can't answer now" }
    const side = sideOf(thread, space)
    yield* happen(
      Answered.make({
        doc: s.doc,
        thread,
        message: `${message}-answer`,
        answer: result.answer,
        ...(result.failed !== undefined && { failed: result.failed }),
        ...(side !== null && { side }),
      }),
    )
    return result
  })

/** A thread id a client made itself, so it can show the thread before its answer comes. */
const NEW_THREAD = /^th-[0-9a-z]{6,32}$/u

const ask = tool(
  "ask",
  {
    description:
      "Asks Switch a follow-up question about a document in a thread of its own, never in a space's chat: a new thread about `quote` (a passage), or the next question in `thread`; a new `thread` id (`th-` and 6 to 32 lowercase letters or digits) starts that thread. A real turn of Switch's in a side thread of `space` (else the space the document was opened from, else Home), with the document and the passage beside the question; waits for its answer.",
    closed: true,
    input: Schema.Struct({
      doc: Schema.String,
      question: Schema.String,
      thread: Schema.optionalKey(Schema.String),
      quote: Schema.optionalKey(Quote),
      space: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* asking() {
      const s = yield* stored(input.doc)
      const question = input.question.trim()
      if (question === "") {
        return yield* Effect.fail(new Error("Ask something"))
      }
      const thread = input.thread ?? id("th")
      const before = input.thread === undefined ? [] : yield* threadsOf(null, input.thread)
      const [existing] = before
      if (input.thread !== undefined && existing === undefined && !NEW_THREAD.test(input.thread)) {
        return yield* Effect.fail(new Error(`No thread ${input.thread}`))
      }
      const quote = existing?.quote ?? input.quote
      const message = id("m")
      // A thread stays in the space it started in: the asker's, else the document's.
      const caller = yield* Caller
      const space =
        existing === undefined
          ? (input.space ?? caller.space ?? (yield* spaceOfDoc(s.doc)))
          : existing.space
      const side = sideOf(thread, space)
      yield* happen(
        Asked.make({
          doc: s.doc,
          thread,
          message,
          question,
          ...(existing === undefined && quote !== undefined && quote !== null && { quote }),
          ...(existing === undefined && space !== null && { space }),
          ...(side !== null && { side }),
        }),
      )
      const result = yield* askSwitch(s, thread, message, question, quote, space)
      return { thread, ...result, view: viewOf(s.doc, thread) }
    }),
)

const threads = tool(
  "threads",
  {
    description: "A document's threads, each with its passage and every message.",
    readOnly: true,
    input: Doc,
  },
  (input) =>
    Effect.gen(function* listing() {
      return { threads: yield* threadsOf(input.doc) }
    }),
)

const thread = tool(
  "thread",
  {
    description: "One thread by its id: its document, passage and messages.",
    readOnly: true,
    input: Schema.Struct({ thread: Schema.String }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const [t] = yield* threadsOf(null, input.thread)
      if (t === undefined) {
        return yield* Effect.fail(new Error(`No thread ${input.thread}`))
      }
      return { ...t, view: viewOf(t.doc, t.id) }
    }),
)

// --- Notes ---

/** At most this many notes from other documents beside one. */
const SEEN = 24

const noteRows = (doc: string) =>
  read((db) =>
    db.query<NoteRow, [string]>("SELECT * FROM notes WHERE doc = ? ORDER BY made").all(doc),
  )

const noteRow = (note: string) =>
  read((db) => db.query<NoteRow, [string]>("SELECT * FROM notes WHERE id = ?").get(note) ?? null)

/** A note as its tools give it, its passage where it is now when the document's words are given. */
const noteOut = (n: NoteRow, all: readonly string[] | null) => {
  const quote = decodeQuote(n.quote)
  return {
    id: n.id,
    doc: n.doc,
    kind: n.kind,
    term: n.term,
    text: n.text,
    ...(n.url !== null && { url: n.url }),
    quote: all === null ? quote : anchor(all, quote),
    ...(n.thread !== null && { thread: n.thread }),
  }
}

/**
 * Notes from other documents whose term this one mentions, read from the notes as they are: each
 * term's first, at its first mention here, with the title of the document it's from. None for a
 * term this one has its own note on.
 */
const seenIn = (s: Stored) =>
  Effect.gen(function* finding() {
    const rows = yield* read((db) =>
      db
        .query<NoteRow & { title: string }, [string]>(
          "SELECT n.*, d.title FROM notes n JOIN docs d ON d.doc = n.doc WHERE n.doc != ? ORDER BY n.made",
        )
        .all(s.doc),
    )
    const taken = new Set((yield* noteRows(s.doc)).map((n) => n.term.toLowerCase()))
    const all = textsOf(s)
    const out: (ReturnType<typeof noteOut> & { source: string })[] = []
    for (const n of rows) {
      const term = n.term.toLowerCase()
      if (taken.has(term)) {
        continue
      }
      taken.add(term)
      const at = mention(all, n.term)
      if (at !== null) {
        out.push({ ...noteOut(n, null), quote: at, source: n.title })
      }
    }
    return out.toSorted((a, b) => a.quote.section - b.quote.section).slice(0, SEEN)
  })

/**
 * What a note is pinned from: the thread named, else the reader thread whose side thread the
 * calling turn is, else none; and its document.
 */
const noteSource = (named: string | undefined, docNamed: string | undefined) =>
  Effect.gen(function* finding() {
    const caller = yield* Caller
    const side = caller.thread === null ? null : sideOfThread(caller.thread)
    const from = named ?? (side?.app === "reader" ? side.key : null)
    const [t] = from === null ? [] : yield* threadsOf(null, from)
    if (from !== null && t === undefined) {
      return yield* Effect.fail(new Error(`No thread ${from}`))
    }
    const doc = t?.doc ?? docNamed
    if (doc === undefined) {
      return yield* Effect.fail(new Error("Give a thread, or a doc and a passage"))
    }
    if (t !== undefined && docNamed !== undefined && docNamed !== t.doc) {
      return yield* Effect.fail(new Error(`Thread ${t.id} is about ${t.doc}`))
    }
    return { t, s: yield* stored(doc) }
  })

/** A note's passage: `said` (words in the thread's passage, else the document), else the thread's. */
const passageFor = (s: Stored, own: Passage | null, said: string) => {
  const quote =
    said === ""
      ? own
      : ((own === null ? null : within(own, said)) ?? passage(textsOf(s), said, own?.section ?? 0))
  return quote === null
    ? Effect.fail(
        new Error(said === "" ? "Give a passage" : `No “${said.slice(0, 60)}” in ${s.title}`),
      )
    : Effect.succeed(quote)
}

const annotate = tool(
  "annotate",
  {
    description:
      "Pins a short note to a passage of a document, shown in its margin and beside the first mention of its `term` in other documents: `definition` (what a term means), `callout` (an idea explained) or `link` (where to read more, its `url`). Only for what the user asked: in a reader thread's turn, once the thread has settled something worth keeping (the thread is that turn's own unless `thread` names one; the passage is the thread's, or `passage`, words in it or in the document), or when the user asks for a note (`doc` and `passage`). Never on your own. `text` is one plain, specific sentence of Markdown, at most 25 words; `term` as the document writes it.",
    closed: true,
    input: Schema.Struct({
      kind: NoteKind,
      term: Schema.String,
      text: Schema.String,
      url: Schema.optionalKey(Schema.String),
      thread: Schema.optionalKey(Schema.String),
      doc: Schema.optionalKey(Schema.String),
      passage: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* noting() {
      const { t, s } = yield* noteSource(input.thread, input.doc)
      const { doc } = s
      const quote = yield* passageFor(s, t?.quote ?? null, input.passage?.trim() ?? "")
      const term = input.term.trim()
      const text = input.text.trim()
      if (term === "" || text === "") {
        return yield* Effect.fail(new Error("Give a term and its text"))
      }
      const same = (yield* noteRows(doc)).find((n) => n.term.toLowerCase() === term.toLowerCase())
      if (same !== undefined) {
        return yield* Effect.fail(new Error(`Already noted: ${same.id} (edit_note changes it)`))
      }
      const note = id("nt")
      const url = input.url?.trim() ?? ""
      yield* happen(
        Noted.make({
          doc,
          note,
          kind: input.kind,
          term,
          text,
          ...(url !== "" && { url }),
          quote,
          ...(t !== undefined && { thread: t.id }),
        }),
      )
      return { note, doc, term, view: viewOf(doc) }
    }),
)

const editNote = tool(
  "edit_note",
  {
    description:
      "Changes a note: its `text`, `term`, `kind` or `url` (an empty `url` takes it away).",
    closed: true,
    input: Schema.Struct({
      note: Schema.String,
      kind: Schema.optionalKey(NoteKind),
      term: Schema.optionalKey(Schema.String),
      text: Schema.optionalKey(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* editing() {
      const n = yield* noteRow(input.note)
      if (n === null) {
        return yield* Effect.fail(new Error(`No note ${input.note}`))
      }
      const term = input.term?.trim() ?? n.term
      const text = input.text?.trim() ?? n.text
      if (term === "" || text === "") {
        return yield* Effect.fail(new Error("A note needs a term and text"))
      }
      const url = input.url === undefined ? (n.url ?? "") : input.url.trim()
      yield* happen(
        Noted.make({
          doc: n.doc,
          note: n.id,
          kind: input.kind ?? n.kind,
          term,
          text,
          ...(url !== "" && { url }),
          quote: decodeQuote(n.quote),
          ...(n.thread !== null && { thread: n.thread }),
        }),
      )
      return { note: n.id, doc: n.doc, term, text }
    }),
)

const deleteNote = tool(
  "delete_note",
  {
    description: "Deletes a note.",
    closed: true,
    input: Schema.Struct({ note: Schema.String }),
  },
  (input) =>
    Effect.gen(function* deleting() {
      const n = yield* noteRow(input.note)
      if (n === null) {
        return yield* Effect.fail(new Error(`No note ${input.note}`))
      }
      yield* happen(Unnoted.make({ doc: n.doc, note: n.id }))
      return { deleted: n.id }
    }),
)

const notes = tool(
  "notes",
  {
    description:
      "Notes pinned to passages: a document's (`doc`), with the notes from other documents whose term it mentions (`seen`); every note about a `term`, in any document (or in `doc`); or, with neither, the latest notes everywhere.",
    readOnly: true,
    input: Schema.Struct({
      doc: Schema.optionalKey(Schema.String),
      term: Schema.optionalKey(Schema.String),
    }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const term = input.term?.trim().toLowerCase() ?? ""
      if (term === "" && input.doc !== undefined) {
        const s = yield* stored(input.doc)
        const all = textsOf(s)
        return {
          notes: (yield* noteRows(s.doc)).map((n) => noteOut(n, all)),
          seen: yield* seenIn(s),
        }
      }
      const rows = yield* read((db) =>
        db
          .query<NoteRow & { title: string }, [string, string]>(
            `SELECT n.*, d.title FROM notes n JOIN docs d ON d.doc = n.doc
             WHERE (?1 = '' OR instr(lower(n.term), ?1) > 0 OR instr(?1, lower(n.term)) > 0)
               AND (?2 = '' OR n.doc = ?2)
             ORDER BY n.made DESC LIMIT 200`,
          )
          .all(term, input.doc ?? ""),
      )
      return { notes: rows.map((n) => ({ ...noteOut(n, null), title: n.title })) }
    }),
)

// --- The heartbeat ---

export const beat = Effect.gen(function* beating() {
  const events = yield* AppEvents
  for (;;) {
    const n = (yield* docRows).length
    yield* Effect.ignore(
      events.emit(
        Heartbeat.make({
          entity: "sense:reader",
          summary: plural(n, "document"),
          facts: { failing: null, documents: n },
        }),
      ),
      { log: "Warn" },
    )
    yield* Effect.sleep(`${BEAT} millis`)
  }
})

// --- The app ---

const REFRESH = logged.filter((e) => e !== LookedUp).map((e) => e.type)

const tools = {
  content: "content",
  define: "define",
  ask: "ask",
  highlight: "highlight",
  unhighlight: "unhighlight",
  editNote: "edit_note",
  deleteNote: "delete_note",
}

/** What its tools run on: the kit's services, through the host. */
type Needs = AppEventsService | HostService | LogService | ModelsService | SwitchService

export const readerApp = defineApp<Needs>({
  name: "reader",
  version: "1",
  // A published page by its id or title.
  reaches: { calls: ["brain_pages"] },
  instructions:
    "A reader for documents of any common kind: open one (`open`), show it to the user (its `view`), and ask Switch about it in threads of their own, whose turns pin what they settle to the passage as notes (`annotate`).",
  tools: [
    open,
    documents,
    document,
    content,
    define,
    highlight,
    unhighlight,
    highlights,
    ask,
    threads,
    thread,
    annotate,
    notes,
    editNote,
    deleteNote,
  ],
  events: [...logged, Heartbeat],
  widgets: [
    {
      name: "document",
      title: "Document",
      surfaces: ["chat", "space"],
      resource: "ui://reader/document",
      tool: "document",
      refresh: REFRESH,
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "document", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "document",
            components: [
              {
                id: "root",
                component: "Document",
                doc: { "@path": "/doc" },
                title: { "@path": "/title" },
                detail: { "@path": "/detail" },
                format: { "@path": "/format" },
                version: { "@path": "/version" },
                highlights: { "@path": "/highlights" },
                threads: { "@path": "/threads" },
                notes: { "@path": "/notes" },
                seen: { "@path": "/seen" },
                open: { "@path": "/open" },
                widget: "document",
                tools,
              },
            ],
          },
        },
      ],
    },
    {
      name: "documents",
      title: "Reading",
      surfaces: ["space"],
      resource: "ui://reader/documents",
      tool: "documents",
      refresh: [Opened.type, Asked.type],
      a2ui: () => [
        { version: "1.0", createSurface: { surfaceId: "documents", catalogId: SWITCH_CATALOG } },
        {
          version: "1.0",
          updateComponents: {
            surfaceId: "documents",
            components: [
              { id: "root", component: "List", children: { componentId: "doc", path: "/docs" } },
              {
                id: "doc",
                component: "Document",
                doc: { "@path": "doc" },
                title: { "@path": "title" },
                detail: { "@path": "detail" },
                threadCount: { "@path": "threads" },
                widget: "document",
                tools,
              },
            ],
          },
        },
      ],
    },
  ],
})
