// Publishing: the brain app's `publish` and `pages` tools, Switchboard's `object` op with
// `link: true` (crates/core/src/docs.md, Objects). What the agent makes to show (a surface, an HTML
// page) or a markdown document goes up at a link of its own, checked there as a stranger sees it
// before the tool answers.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import {
  Blobs,
  Brain,
  BYPASS,
  Bypass,
  bypassOf,
  defineRead,
  emDashRefusal,
  EventId,
  foldersOf,
  SpaceId,
  spaceNamed,
  stringsIn,
  unlessBypassed,
} from "@switch/brain"
import { Effect, Option, Schema } from "effect"
import { Caller, Rejected, tool } from "switch-ext-kit"

import { PAGE_MAX } from "../page.ts"
import { Preview } from "../preview.ts"
import { surfaceOf } from "../views.ts"
import { changedLines, imagesIn, lineWords, open, shows, wordsOf } from "./check.ts"
import { datedOf } from "./events.ts"
import { Pages } from "./pages.ts"
import {
  allPages,
  PageBody,
  PageEvent,
  PagePublished,
  PageRetired,
  PageShell,
  pageOf,
} from "./records.ts"
import type { PageRow } from "./records.ts"
import { imageAt, markdownHtml } from "./render.ts"

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(PageBody))
const decodeEvents = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(PageEvent)))

const reject = (reason: string) => Effect.fail(new Rejected({ reason }))

const expand = (p: string) => (p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p)

const HEADING = /^(?<marks>#{1,6})\s+(?<words>.+?)\s*#*\s*$/u

/** Words as a heading is matched by: lower case, letters and digits. */
const plain = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "")

/**
 * The text with the section under the heading `named` replaced by `text`, up to the next heading
 * of its level or above: named by its words, its first words, or any of its words in order when
 * only one heading has them. Its heading stays unless `text` starts with one, and the `---` that
 * closed it stays. One it lacks is added at the end.
 */
const replaceSection = (doc: string, named: string, text: string) => {
  const lines = doc.split("\n")
  const want = plain(named).join(" ")
  const headings = lines.flatMap((line, at) => {
    const m = HEADING.exec(line)
    return m?.groups
      ? [{ at, level: m.groups.marks?.length ?? 1, words: plain(m.groups.words ?? "").join(" ") }]
      : []
  })
  const inOrder = (words: string) => {
    let from = 0
    for (const w of want.split(" ")) {
      const i = words.split(" ").indexOf(w, from)
      if (i === -1) {
        return false
      }
      from = i + 1
    }
    return true
  }
  const exact = headings.filter((h) => h.words === want)
  const first = headings.filter((h) => h.words.startsWith(want))
  const loose = headings.filter((h) => inOrder(h.words))
  const found = [exact, first, loose].find((list) => list.length === 1)?.[0]
  const startsWithHeading = HEADING.test(text.trimStart().split("\n")[0] ?? "")
  if (found === undefined) {
    const added = startsWithHeading ? text.trim() : `## ${named.trim()}\n\n${text.trim()}`
    return `${doc.trimEnd()}\n\n${added}\n`
  }
  const next = headings.find((h) => h.at > found.at && h.level <= found.level)
  let end = next === undefined ? lines.length : next.at
  // The `---` that closed it stays.
  let last = end - 1
  while (last > found.at && (lines[last] ?? "").trim() === "") {
    last -= 1
  }
  const closing = /^(?:-{3,}|\*{3,}|_{3,})$/u.test((lines[last] ?? "").trim()) && last > found.at
  if (closing) {
    end = last
  }
  const kept = startsWithHeading ? [] : [lines[found.at] ?? "", ""]
  const replaced = [...kept, ...text.trim().split("\n"), ""]
  return [...lines.slice(0, found.at), ...replaced, ...lines.slice(end)].join("\n")
}

/** Exact changes, each `old` found exactly once, or which wasn't. */
const applyEdits = (
  doc: string,
  edits: readonly { readonly old: string; readonly new: string }[],
) => {
  let out = doc
  for (const e of edits) {
    const count = out.split(e.old).length - 1
    if (count !== 1) {
      return { wrong: `"${e.old.slice(0, 80)}" is in it ${count} times, not once` } as const
    }
    out = out.replace(e.old, () => e.new)
  }
  return { text: out } as const
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".gif": "gif",
  ".webp": "webp",
  ".svg": "svg",
}

/**
 * A document's images named by a path, each put in a blob and named by it in its place, so a
 * markdown file and its diagrams publish in one step; an SVG drawn as a PNG first, since a page
 * draws none. Paths are read on the core's machine: from the file's folder, the space's folders,
 * or outright. What can't go on the page is said, and nothing changes.
 */
const imagesToBlobs = (text: string, folders: readonly string[]) =>
  Effect.gen(function* putting() {
    const blobs = yield* Blobs
    const preview = yield* Preview
    const wrong: string[] = []
    const named = new Map<string, string>()
    for (const m of text.matchAll(/!\[[^\]]*\]\((?<src>[^)\s]+)(?:\s+"[^"]*")?\)/gu)) {
      const src = m.groups?.src ?? ""
      if (/^(?:https?:|sha256:|blob:|data:|\/blobs\/)/u.test(src) || named.has(src)) {
        continue
      }
      const given = expand(decodeURIComponent(src.replace(/^file:\/\//u, "")))
      const at = path.isAbsolute(given)
        ? given
        : folders.map((f) => path.join(f, given)).find((p) => existsSync(p))
      const kind = IMAGE_TYPES[path.extname(given).toLowerCase()]
      if (at === undefined || !existsSync(at)) {
        wrong.push(`${src}: not there`)
        continue
      }
      if (kind === undefined) {
        wrong.push(`${src}: a page shows PNG, JPEG, GIF, WebP or SVG`)
        continue
      }
      const bytes =
        kind === "svg"
          ? yield* preview.rasterize(readFileSync(at, "utf-8")).pipe(
              Effect.mapError((why) => `${src}: ${why}`),
              Effect.result,
            )
          : { _tag: "Success" as const, success: new Uint8Array(readFileSync(at)) }
      if (bytes._tag === "Failure") {
        wrong.push(bytes.failure)
        continue
      }
      const stored = yield* blobs
        .put(new Response(bytes.success).body ?? new ReadableStream())
        .pipe(Effect.result)
      if (stored._tag === "Failure") {
        wrong.push(`${src}: ${stored.failure}`)
        continue
      }
      named.set(src, `sha256:${stored.success.hash}`)
    }
    if (wrong.length > 0) {
      return yield* reject(
        `Nothing changed. These images can't go on the page:\n${wrong.join("\n")}`,
      )
    }
    return text.replaceAll(
      /(?<open>!\[[^\]]*\]\()(?<src>[^)\s]+)/gu,
      (whole, lead: string, src: string) => {
        const blob = named.get(src)
        return blob === undefined ? whole : `${lead}${blob}`
      },
    )
  })

const bodyOf = (row: PageRow) =>
  Effect.gen(function* reading() {
    const blobs = yield* Blobs
    const at = yield* blobs.path(row.body)
    return at === null ? Option.none() : decodeBody(readFileSync(at, "utf-8"))
  })

const keep = (body: PageBody) =>
  Effect.gen(function* keeping() {
    const blobs = yield* Blobs
    const stored = yield* blobs
      .put(Response.json(body).body ?? new ReadableStream())
      .pipe(Effect.mapError((reason) => new Rejected({ reason })))
    return stored.hash
  })

const Edit = Schema.Struct({ old: Schema.String, new: Schema.String })

const Input = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  space: Schema.optionalKey(SpaceId),
  text: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  section: Schema.optionalKey(Schema.String),
  edits: Schema.optionalKey(Schema.Array(Edit)),
  components: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  html: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(PAGE_MAX))),
  shell: Schema.optionalKey(PageShell),
  events: Schema.optionalKey(Schema.Array(PageEvent)),
  retired: Schema.optionalKey(Schema.Boolean),
  pdf: Schema.optionalKey(Schema.Boolean),
  bypass: Bypass,
})
type Input = typeof Input.Type

const ingest = (type: string, payload: unknown) =>
  Effect.gen(function* ingesting() {
    const brain = yield* Brain
    yield* brain
      .ingest([
        { id: EventId.make(`${type}:${crypto.randomUUID()}`), type, source: "agent", payload },
      ])
      .pipe(Effect.mapError((e) => new Rejected({ reason: e.reason })))
  })

/** Takes a page down, and checks its link says so. */
const retire = (was: PageRow) =>
  Effect.gen(function* retiring() {
    const pages = yield* Pages
    yield* ingest(PageRetired.type, { id: was.id })
    const link = pages.linkOf(was.id)
    const status = yield* Effect.promise(
      async () =>
        await open(link)
          .then((o) => String(o.status))
          .catch(String),
    )
    return {
      id: was.id,
      retired: true,
      checked: status === "410" ? "its link answers that it's gone" : `its link answers ${status}`,
    }
  })

/** The text of a document's version before. */
const textOf = (before: Option.Option<PageBody>) =>
  Option.match(before, {
    onNone: () => null,
    onSome: (b) => (b.kind === "document" ? b.text : null),
  })

const eventsOf = (was: PageRow | null) =>
  was === null ? [] : Option.getOrElse(decodeEvents(was.events), () => [])

// The pages tools' reads of the brain, by name (reads.ts), so they run in a reader thread.
const spaceNamedRead = defineRead("gateway/pages-tool/space-named", (db, given: string) =>
  spaceNamed(db, given),
)
const foldersRead = defineRead("gateway/pages-tool/folders", (db, space: SpaceId) =>
  foldersOf(db, space),
)
const pageRead = defineRead("gateway/pages-tool/page", (db, id: string) => pageOf(db, id))
const pagesRead = defineRead("gateway/pages-tool/pages", (db) => allPages(db))

/** The space a page is about (the one given, else the calling work's, else its own), and its folders. */
const placeOf = (given: SpaceId | undefined, was: PageRow | null) =>
  Effect.gen(function* placing() {
    const brain = yield* Brain
    const caller = yield* Caller
    const named = given === undefined ? null : yield* brain.read(spaceNamedRead, given)
    const space =
      named ?? (caller.space === null ? null : SpaceId.make(caller.space)) ?? was?.space ?? null
    const folders = space === null ? [] : [...(yield* brain.read(foldersRead, space)).values()]
    return { space, folders }
  })

/** A document's markdown from what's given and what it had, or what's wrong. */
const documentText = (input: Input, before: string | null) => {
  let text = before ?? ""
  if (input.file !== undefined) {
    const at = expand(input.file)
    if (!existsSync(at)) {
      return { wrong: `No file ${input.file} on the core's machine` } as const
    }
    text = readFileSync(at, "utf-8")
  }
  if (input.text !== undefined && input.section !== undefined) {
    if (before === null) {
      return { wrong: "A section is replaced in a document published before: give its id" } as const
    }
    text = replaceSection(text, input.section, input.text)
  } else if (input.text !== undefined) {
    ;({ text } = input)
  }
  if (input.edits === undefined) {
    return { text } as const
  }
  const edited = applyEdits(text, input.edits)
  return "wrong" in edited ? ({ wrong: `Nothing changed: ${edited.wrong}` } as const) : edited
}

/** A leading `# ` heading is the title (unless one's given), left out of the text below it. */
const titled = (text: string, title: string) => {
  const lead = /^\s*#\s+(?<words>.+?)\s*\n/u.exec(text)
  const heading = lead?.groups?.words
  if (lead === null || heading === undefined) {
    return { text, title }
  }
  if (title !== "" && plain(heading).join(" ") !== plain(title).join(" ")) {
    return { text, title }
  }
  return { text: text.slice(lead[0].length), title: title === "" ? heading : title }
}

/** An article's leading <h1> is the title (unless another's given), left out of the HTML after it. */
const titledHtml = (html: string, title: string) => {
  const lead = /^\s*<h1(?:\s[^>]*)?>(?<words>[\s\S]*?)<\/h1\s*>/iu.exec(html)
  const heading = lead?.groups?.words?.replaceAll(/<[^>]*>/gu, "").trim()
  if (lead === null || heading === undefined || heading === "") {
    return { html, title }
  }
  if (title !== "" && plain(heading).join(" ") !== plain(title).join(" ")) {
    return { html, title }
  }
  return { html: html.slice(lead[0].length), title: title === "" ? heading : title }
}

/** HTML as the shell asks: an article's inner HTML, or a blank page's whole document; or what's wrong. */
const htmlBody = (html: string, shell: PageShell, title: string) => {
  if (shell === "blank") {
    return { title, body: { kind: "html", html, shell } satisfies PageBody }
  }
  if (/<(?:html|head|body)[\s>]/iu.test(html)) {
    return {
      wrong:
        "An article is the inner HTML of its body, without html, head or body: the shell brings the rest. A whole page of its own is shell blank",
    }
  }
  const named = titledHtml(html, title)
  return { title: named.title, body: { kind: "html", html: named.html, shell } satisfies PageBody }
}

/** HTML's new version, from what's given and what it had; null when it's no HTML. */
const htmlFrom = (input: Input, was: PageBody | null, title: string) => {
  const had = was?.kind === "html" ? was : null
  const html = input.html ?? had?.html
  if (html === undefined) {
    return null
  }
  const edited = input.edits === undefined ? { text: html } : applyEdits(html, input.edits)
  if ("wrong" in edited) {
    return { wrong: `Nothing changed: ${edited.wrong}` }
  }
  return htmlBody(edited.text, input.shell ?? had?.shell ?? "article", title)
}

/** What the new version shows, and its title. */
const bodyFrom = (
  input: Input,
  before: Option.Option<PageBody>,
  title: string,
  folders: readonly string[],
) =>
  Effect.gen(function* making() {
    const was = Option.getOrNull(before)
    const document = [input.text, input.file, input.section].some((x) => x !== undefined)
    const given = [input.components, input.html, document ? true : undefined].filter(
      (x) => x !== undefined,
    )
    if (given.length > 1) {
      return yield* reject(
        "Give one: a document (text, file, section or edits), components, or html",
      )
    }
    if (input.components !== undefined) {
      const made = surfaceOf(input.components, input.data)
      return "wrong" in made
        ? yield* reject(made.wrong)
        : { title, body: { kind: "surface", surface: made.surface } satisfies PageBody }
    }
    const html = document ? null : htmlFrom(input, was, title)
    if (html !== null) {
      return "wrong" in html ? yield* reject(html.wrong) : html
    }
    if (input.shell === "blank") {
      return yield* reject("Markdown is always an article: a blank page is html")
    }
    if (!document && input.edits === undefined) {
      return Option.isSome(before)
        ? { title, body: before.value }
        : yield* reject("Give what it shows: text, file, components or html")
    }
    const made = documentText(input, textOf(before))
    if ("wrong" in made) {
      return yield* reject(made.wrong)
    }
    const from = input.file === undefined ? folders : [path.dirname(expand(input.file)), ...folders]
    const named = titled(made.text, title)
    const text = yield* imagesToBlobs(named.text, from)
    return { title: named.title, body: { kind: "document", text } satisfies PageBody }
  })

const PUBLISH = `Publish at a link of its own, for what the user reads once or now and then (a plan, an itinerary, a report, a guide): it opens in any browser, their phone's too, without signing in; the token in the link lets it in, so it's theirs to share or keep. Say the link it returns. Every page is a PDF too, at \`<link>/pdf\`: when the user asks for a PDF, publish what they want and hand them that.
- What: \`html\`, with \`shell\`:
  - "article" (the default), for a document: only the inner HTML of its body, plain semantic HTML (h2 and h3 for sections, p, ul and ol, table, figure with figcaption, pre and code, blockquote) and no classes. The shell brings the title as its h1 (a leading <h1> is taken as the title), the stylesheet in the system's light or dark, an outline of its h2 and h3, print and the calendar. Add a <style> only for what the sheet lacks, a <script> only for an interactive part; it runs sandboxed. Images from blobs as \`<img src="sha256:…">\`, or https.
  - "blank", only for full-screen interactive work (a tool, a game, a visualization): the whole page, \`<!doctype html>\` on, drawn as it is with nothing of Switch's, sandboxed.
  - Or a markdown \`text\` (GitHub's: headings, lists, tables, links; images as \`![what](sha256:…)\`, by a path, or https) or a markdown \`file\` on the core's machine (its leading \`# \` heading is the title unless you give one): a shortcut drawn as the same article. Or \`components\` and \`data\`, as show_widget takes them.
- Images named by a path in markdown (from the file's folder, the space's, or absolute) go in blobs for you, an SVG drawn as a PNG, so a document and its diagrams publish in one step.
- \`events\`: dated plans, [{title, start, end?, location?, notes?}], each start a day (2026-11-08) or a time with its UTC offset (2026-11-07T15:00-08:00), an end the same kind (for days, the last day; a time without one lasts an hour). An article lists them with buttons to subscribe (Apple Calendar, and Google Calendar when the link is public) or download them; \`<link>/calendar.ics\` follows the page as it changes.
- \`id\` (from an earlier publish or the pages tool) makes a new version at the same link: what you give replaces what it had, the rest stays. A page changes without being sent whole: \`edits\` [{old, new}] makes exact changes in its markdown or HTML, each old found once; in markdown, \`section\` (a heading's words) with \`text\` replaces that section, keeping its heading unless the text starts with one (one it lacks is added at the end). \`retired: true\` takes it down; its link then answers that it's gone.
- Each version is opened at its link as a stranger would (no credential, public DNS) before this answers, and says which changed lines or images a reader doesn't see. \`pdf: true\` prints its PDF there too.`

/**
 * The words this version gives, read for em dashes (brain's dashes.ts): its title, what it's given
 * now (a file as it reads), and its events; what an earlier version had stays as it was.
 */
const givenWords = (input: Input, title: string, body: PageBody) => [
  title,
  input.text ?? "",
  input.html ?? "",
  ...(input.edits ?? []).map((e) => e.new),
  ...stringsIn(input.components ?? []),
  input.file !== undefined && body.kind === "document" ? body.text : "",
  ...(input.events ?? []).flatMap((e) => [e.title, e.location ?? "", e.notes ?? ""]),
]

const noDashes = (words: readonly string[], bypass: string | undefined, space: string | null) =>
  Effect.gen(function* reading() {
    const dashed = yield* unlessBypassed(emDashRefusal(words), bypassOf(bypass), {
      check: "publish",
      objections: ["dash"],
      work: (yield* Caller).thread ?? "nowhere",
      ...(space !== null && { space }),
    })
    return dashed === null ? undefined : yield* reject(`Not published. ${dashed} ${BYPASS}`)
  })

export const publish = tool("publish", { description: PUBLISH, input: Input }, (input) =>
  Effect.gen(function* publishing() {
    const brain = yield* Brain
    const pages = yield* Pages
    const was = input.id === undefined ? null : yield* brain.read(pageRead, input.id)
    if (input.id !== undefined && was === null) {
      return yield* reject(`No page ${input.id}`)
    }
    if (input.retired === true) {
      return was === null
        ? yield* reject("Give the id of the page to take down")
        : yield* retire(was)
    }
    const before = was === null ? Option.none<PageBody>() : yield* bodyOf(was)
    const { space, folders } = yield* placeOf(input.space, was)
    const { title, body } = yield* bodyFrom(
      input,
      before,
      input.title?.trim() ?? was?.title ?? "",
      folders,
    )
    if (title === "") {
      return yield* reject("Give it a title")
    }
    yield* noDashes(givenWords(input, title, body), input.bypass, space)
    const events = input.events ?? eventsOf(was)
    const dated = datedOf(events)
    if ("wrong" in dated) {
      return yield* reject(dated.wrong)
    }
    const id = was?.id ?? `page-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    const thread = (yield* Caller).thread ?? was?.thread ?? null
    yield* ingest(PagePublished.type, {
      id,
      title,
      kind: body.kind,
      body: yield* keep(body),
      events,
      space,
      thread,
    })
    const link = pages.linkOf(id)
    const checked = yield* Effect.promise(
      async () => await checkAt(link, title, body, textOf(before), input.pdf === true),
    )
    return {
      id,
      link,
      pdf: `${link}/pdf`,
      ...(events.length > 0 && { calendar: `${link}/calendar.ics` }),
      checked,
    }
  }),
)

/** What a document's changed lines a reader doesn't see at the link, and which of their images don't load. */
const documentGaps = async (
  link: string,
  page: readonly string[],
  text: string,
  before: string | null,
) => {
  const lines = changedLines(before, text)
  const missing = lines.filter((line) => !lineWords(line).every((words) => shows(page, words)))
  const shown = markdownHtml(
    imagesIn(lines)
      .map((src) => `![](${src})`)
      .join("\n\n"),
    imageAt((hash) => `${link}/blobs/${hash}`),
  )
  const sources = [...shown.matchAll(/<img src="(?<src>[^"]+)"/gu)].map((m) =>
    (m.groups?.src ?? "").replaceAll("&amp;", "&"),
  )
  const loaded = await Promise.all(
    sources.map(async (src) => {
      const image = await open(src).catch(() => null)
      return image?.status === 200 && image.type.startsWith("image/")
        ? null
        : src.replace(/\/p\/[0-9a-f]{32}\//u, "/p/…/")
    }),
  )
  return { missing, brokenImages: loaded.filter((src) => src !== null) }
}

/** Its PDF, printed at the link, in words. */
const pdfAt = async (link: string) => {
  const got = await open(`${link}/pdf`).catch(() => null)
  if (got?.status !== 200 || new TextDecoder().decode(got.body.slice(0, 5)) !== "%PDF-") {
    return `its PDF didn't print (${got?.status ?? "no answer"})`
  }
  const sheets = (new TextDecoder("latin1").decode(got.body).match(/\/Type\s*\/Page\b/gu) ?? [])
    .length
  return `its PDF prints: ${sheets} page${sheets === 1 ? "" : "s"}, ${Math.round(got.body.byteLength / 1024)} KB`
}

/** The page opened at its link as a stranger would: what a reader doesn't see of what changed. */
const checkAt = async (
  link: string,
  title: string,
  body: PageBody,
  before: string | null,
  pdf: boolean,
) => {
  const opened = await open(link).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  )
  if (opened instanceof Error) {
    return { ok: false, said: opened.message }
  }
  if (opened.status !== 200) {
    return { ok: false, way: opened.way, said: `its link answered ${opened.status}` }
  }
  const page = wordsOf(new TextDecoder().decode(opened.body))
  const gaps =
    body.kind === "document"
      ? await documentGaps(link, page, body.text, before)
      : { missing: [], brokenImages: [] }
  // A blank page is the agent's whole page, titled only in its tab.
  const named = (body.kind === "html" && body.shell === "blank") || shows(page, wordsOf(title))
  const missing = named ? gaps.missing : [title, ...gaps.missing]
  const printed = pdf ? await pdfAt(link) : undefined
  return {
    ok: missing.length === 0 && gaps.brokenImages.length === 0,
    way: opened.way,
    ...(missing.length > 0 && { missing }),
    ...(gaps.brokenImages.length > 0 && { brokenImages: gaps.brokenImages }),
    ...(printed !== undefined && { pdf: printed }),
  }
}

export const pagesTool = tool(
  "pages",
  {
    description:
      "Published pages, newest first: id, title, kind, space, link, updated (ms); taken-down ones only with `retired`.",
    readOnly: true,
    input: Schema.Struct({ retired: Schema.optionalKey(Schema.Boolean) }),
  },
  (input) =>
    Effect.gen(function* listing() {
      const brain = yield* Brain
      const pages = yield* Pages
      const rows = yield* brain.read(pagesRead)
      return {
        pages: rows
          .filter((r) => (r.retired === 1) === (input.retired === true))
          .map((r) => ({
            id: r.id,
            title: r.title,
            kind: r.kind,
            space: r.space,
            link: pages.linkOf(r.id),
            updated: r.updated,
          })),
      }
    }),
)
