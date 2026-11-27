// Reader: documents of any common kind, read in Switch's own reader, with a word's definition and
// a name's Wikipedia article a selection away, and follow-up questions each in a thread of its own,
// anchored to its passage and answered with the document in mind, never in the space's chat.
import { Effect, Schema } from "effect"
import {
  AppEvents,
  defineApp,
  defineEvent,
  Host,
  Models,
  SWITCH_CATALOG,
  tool,
} from "switch-ext-kit"
import type { Draft } from "switch-ext-kit"

import { words } from "./formats.ts"
import type { Parsed } from "./formats.ts"
import { link, linkable, names, plainOf } from "./links.ts"
import { define as dictionary, wikiTitle, wikipedia } from "./lookup.ts"
import { docId, fromText, isUrl, readSource } from "./source.ts"
import {
  Answered,
  Asked,
  Highlighted,
  Linked,
  Opened,
  Quote,
  Unhighlighted,
  load,
  logged,
  read,
  record,
  save,
} from "./store.ts"
import type { DocRow, HighlightRow, MessageRow, Passage, Stored, ThreadRow } from "./store.ts"

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
      const stored: Stored = {
        doc,
        source,
        title: input.title ?? parsed.title,
        format: parsed.format,
        lang: parsed.lang,
        ...(parsed.author !== undefined && { author: parsed.author }),
        words: words(parsed),
        sections: parsed.sections,
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
      "A document's title, kind and size, its highlights, and its threads with every message, by `doc`; `thread` names one to show open.",
    readOnly: true,
    input: Schema.Struct({ doc: Schema.String, thread: Schema.optionalKey(Schema.String) }),
  },
  (input) =>
    Effect.gen(function* reading() {
      const s = yield* stored(input.doc)
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
        threads: yield* threadsOf(s.doc),
      }
    }),
)

const content = tool(
  "content",
  {
    description:
      "A document's words as Markdown, section by section (a PDF's pages, an EPUB's chapters), its notable terms linked to Wikipedia; `from` and `count` take a part.",
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
      }
    }),
)

// --- Looking up ---

/** A selection a dictionary could have: a few words, no sentence. */
const wordish = (s: string) =>
  s.length <= 48 && s.split(/\s+/u).length <= 4 && !/[.!?;:]\s/u.test(s)

const define = tool(
  "define",
  {
    description:
      "What a word or name is: its dictionary senses (Wiktionary) and its Wikipedia article's summary, each when there is a real entry. `term`, or a Wikipedia `url`; `doc` gives the language.",
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
      const looked = wiki !== null || wordish(term)
      const [dict, article] = looked
        ? yield* Effect.all(
            [
              wiki === null
                ? attempt(async () => await dictionary(term, lang)).pipe(
                    Effect.orElseSucceed(() => null),
                  )
                : Effect.succeed(null),
              attempt(async () => await wikipedia(term, wiki?.lang ?? lang)).pipe(
                Effect.orElseSucceed(() => null),
              ),
            ],
            { concurrency: 2 },
          )
        : [null, null]
      // A plain lowercase word the dictionary knows means that, not a show or a band of its name.
      const plainWord =
        wiki === null && dict !== null && !term.includes(" ") && term === term.toLowerCase()
      return { term, dictionary: dict, wikipedia: plainWord ? null : article }
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

/** Most of a document's words a thread's answer is given. */
const BUDGET = 90_000

/** The document as the answer reads it: all of it when it fits, else around the passage. */
const contextOf = (s: Stored, section: number | undefined) => {
  const all = s.sections.map((sec) => {
    const label = sec.label ?? ""
    if (label === "") {
      return sec.markdown
    }
    return `[${s.format === "pdf" ? "Page " : ""}${label}]\n${sec.markdown}`
  })
  const whole = all.join("\n\n")
  if (whole.length <= BUDGET) {
    return whole
  }
  const at = Math.min(Math.max(section ?? 0, 0), all.length - 1)
  const picked = new Set<number>([0, at])
  let size = (all[0]?.length ?? 0) + (all[at]?.length ?? 0)
  for (let d = 1; d < all.length && size < BUDGET; d += 1) {
    for (const i of [at - d, at + d]) {
      const part = all[i]
      if (part !== undefined && !picked.has(i) && size + part.length <= BUDGET) {
        picked.add(i)
        size += part.length
      }
    }
  }
  return [...picked]
    .toSorted((a, b) => a - b)
    .map((i) => all[i])
    .join("\n\n[…]\n\n")
}

type Thread = Effect.Success<ReturnType<typeof threadsOf>>[number]

/** The passage a thread is about, as the answer reads it. */
const passageOf = (s: Stored, quote: Passage) => {
  const label = s.sections[quote.section]?.label ?? ""
  const where = label === "" ? "" : ` (${s.format === "pdf" ? "page " : ""}${label})`
  return `The passage this thread is about${where}:\n<passage>\n${quote.prefix ?? ""}[[${quote.exact}]]${quote.suffix ?? ""}\n</passage>\n(The words in [[ ]] are what the reader selected.)`
}

/** What the answer is asked: the document, the passage, the thread so far and the question. */
const promptOf = (
  s: Stored,
  quote: Passage | null | undefined,
  existing: Thread | undefined,
  question: string,
) => {
  const history = (existing?.messages ?? [])
    .filter((m) => m.failed === undefined)
    .map((m) => `${m.role === "user" ? "Reader" : "You"}: ${m.text}`)
    .join("\n\n")
  const author = s.author ?? ""
  return [
    `Document: ${s.title}${author === "" ? "" : ` by ${author}`} (${s.format})`,
    `<document>\n${contextOf(s, quote?.section)}\n</document>`,
    quote === null || quote === undefined ? "" : passageOf(s, quote),
    history === "" ? "" : `The thread so far:\n${history}`,
    `Reader: ${question}`,
  ]
    .filter((p) => p !== "")
    .join("\n\n")
}

const SYSTEM = `You answer a reader's follow-up questions about a document they're reading, in a thread of its own about one passage. Answer the question directly and briefly, from the document where it speaks to it and from what you know where it doesn't, saying which when it matters. Write Markdown; math as $…$ or $$…$$. No preamble, no restating the question, no em dashes.`

/** A thread id a client made itself, so it can show the thread before its answer comes. */
const NEW_THREAD = /^th-[0-9a-z]{6,32}$/u

const ask = tool(
  "ask",
  {
    description:
      "Asks a follow-up question about a document in a thread of its own, never in a space's chat: a new thread about `quote` (a passage), or the next question in `thread`; a new `thread` id (`th-` and 6 to 32 lowercase letters or digits) starts that thread. Waits for the answer, written with the document and the passage in mind.",
    closed: true,
    input: Schema.Struct({
      doc: Schema.String,
      question: Schema.String,
      thread: Schema.optionalKey(Schema.String),
      quote: Schema.optionalKey(Quote),
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
      yield* happen(
        Asked.make({
          doc: s.doc,
          thread,
          message: id("m"),
          question,
          ...(existing === undefined && quote !== undefined && quote !== null && { quote }),
        }),
      )
      const prompt = promptOf(s, quote, existing, question)
      const models = yield* Models
      const got = yield* Effect.result(models.complete("turn", SYSTEM, prompt))
      const message = id("m")
      const answer = got._tag === "Success" ? got.success.text.trim() : ""
      const failed = got._tag === "Failure" ? got.failure.message || "Can't answer now" : undefined
      yield* happen(
        Answered.make({
          doc: s.doc,
          thread,
          message,
          answer,
          ...(failed !== undefined && { failed }),
        }),
      )
      return {
        thread,
        answer,
        ...(failed !== undefined && { failed }),
        view: viewOf(s.doc, thread),
      }
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

const REFRESH = logged.map((e) => e.type)

const tools = {
  content: "content",
  define: "define",
  ask: "ask",
  highlight: "highlight",
  unhighlight: "unhighlight",
}

export const readerApp = defineApp({
  name: "reader",
  version: "1",
  // A published page by its id or title.
  reaches: { calls: ["brain_pages"] },
  instructions:
    "A reader for documents of any common kind: open one (`open`), show it to the user (its `view`), and ask about it in threads of their own.",
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
