// Every document read into one form: its title, language and sections of Markdown. A web page's
// article (Readability's), a PDF's pages (pdf.js, its lines joined into paragraphs and headings by
// their type's size), an EPUB's spine, a DOCX (mammoth), Markdown and plain words as they are, a
// table's rows, code in its block, and what macOS's textutil reads (RTF, DOC, ODT, web archives).
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readability } from "@mozilla/readability"
import { strFromU8, unzipSync } from "fflate"
import { parseHTML } from "linkedom"
import mammoth from "mammoth"
import { getDocumentProxy } from "unpdf"

import { htmlToMarkdown, textToMarkdown } from "./markdown.ts"

export const FORMATS = [
  "page",
  "web",
  "html",
  "pdf",
  "epub",
  "docx",
  "markdown",
  "text",
  "table",
  "code",
  "rtf",
  "odt",
  "doc",
] as const

export type Format = (typeof FORMATS)[number]

export interface Section {
  /** What it's called where a reader would cite it: a PDF's page, an EPUB's chapter. */
  readonly label?: string
  readonly markdown: string
}

/** A table of contents' entry: its words, its level (2 or 3, as a page's h2 and h3), its section. */
export interface Heading {
  readonly title: string
  readonly level: 2 | 3
  readonly section: number
}

export interface Parsed {
  readonly title: string
  readonly format: Format
  /** The language its words are in (a BCP 47 tag's first part), for its dictionary and Wikipedia. */
  readonly lang: string
  readonly author?: string
  readonly sections: readonly Section[]
  /** Its own table of contents: a PDF's outline, an EPUB's. */
  readonly outline?: readonly Heading[]
}

interface Node {
  readonly title: string
  readonly section: number | null
  readonly items: readonly Node[]
}

/** A table of contents' top two levels, in order, past a lone entry over the rest (the book's title). */
const headingsOf = (nodes: readonly Node[]): Heading[] => {
  const only = nodes.length === 1 ? nodes[0] : undefined
  const top = only !== undefined && only.items.length > 1 ? only.items : nodes
  const out: Heading[] = []
  for (const n of top) {
    if (n.section !== null && n.title !== "") {
      out.push({ title: n.title, level: 2, section: n.section })
    }
    for (const c of n.items) {
      if (c.section !== null && c.title !== "") {
        out.push({ title: c.title, level: 3, section: c.section })
      }
    }
  }
  return out
}

const CODE: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  sh: "sh",
  zsh: "sh",
  bash: "sh",
  sql: "sql",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  css: "css",
  scss: "scss",
  tex: "tex",
  lua: "lua",
  php: "php",
  r: "r",
}

const langOf = (tag: string | null | undefined) => {
  const first = (tag ?? "").trim().toLowerCase().split(/[-_]/u)[0] ?? ""
  return first === "" ? "en" : first
}

const stem = (name: string) => path.basename(name).replace(/\.[^.]+$/u, "")

/** The first of `titles` that says something, else `fallback`. */
const firstTitle = (titles: readonly (string | null | undefined)[], fallback: string) => {
  for (const t of titles) {
    if (t !== null && t !== undefined && t !== "") {
      return t
    }
  }
  return fallback
}

const FENCE = /^\s*(?:```|~~~)/u

/** A long run of Markdown cut at its top headings into sections, so a book scrolls in parts. */
export const sectioned = (markdown: string): Section[] => {
  if (markdown.length < 12_000) {
    return [{ markdown }]
  }
  const out: Section[] = []
  let fence = false
  let current: string[] = []
  const flush = () => {
    const text = current.join("\n").trim()
    if (text !== "") {
      out.push({ markdown: text })
    }
    current = []
  }
  for (const line of markdown.split("\n")) {
    if (FENCE.test(line)) {
      fence = !fence
    }
    if (!fence && /^#{1,2}\s/u.test(line) && current.join("\n").length > 2000) {
      flush()
    }
    current.push(line)
  }
  flush()
  return out
}

// --- PDF ---

interface Item {
  readonly str: string
  readonly transform: readonly number[]
  readonly height: number
  readonly hasEOL?: boolean
}

interface Line {
  text: string
  y: number
  size: number
}

type Pdf = Awaited<ReturnType<typeof getDocumentProxy>>

const median = (xs: readonly number[]) => {
  const s = [...xs].toSorted((a, b) => a - b)
  return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] ?? 0)
}

const linesOf = (items: readonly Item[]) => {
  const lines: Line[] = []
  let line: Line | null = null
  for (const it of items) {
    const y = it.transform[5] ?? 0
    const size = Math.abs(it.transform[3] ?? it.height) || it.height
    if (line === null || Math.abs(line.y - y) > Math.max(2, size * 0.4)) {
      if (line !== null) {
        lines.push(line)
      }
      line = { text: "", y, size: 0 }
    }
    line.text += it.str
    if (it.str.trim() !== "") {
      line.size = Math.max(line.size, size)
    }
    if (it.hasEOL === true) {
      lines.push(line)
      line = null
    }
  }
  if (line !== null) {
    lines.push(line)
  }
  return lines
    .map((l) => ({ ...l, text: l.text.replaceAll(/\s+/gu, " ").trim() }))
    .filter((l) => l.text !== "")
}

const escapeLine = (text: string) => textToMarkdown(text)

/** A heading's mark by its size against the body's. */
const levelOf = (size: number, body: number) => {
  if (size >= body * 1.7) {
    return "#"
  }
  if (size >= body * 1.35) {
    return "##"
  }
  return "###"
}

/** The usual gap between a page's lines of one size. */
const stepOf = (lines: readonly Line[], body: number) => {
  const gaps: number[] = []
  for (let i = 1; i < lines.length; i += 1) {
    const a = lines[i - 1]
    const b = lines[i]
    if (a && b && Math.abs(a.size - b.size) < 0.5) {
      gaps.push(Math.abs(a.y - b.y))
    }
  }
  return median(gaps) || body * 1.2
}

/** A heading's line added to the blocks: a heading over two lines is one. */
const addHeading = (blocks: string[], l: Line, prev: Line | undefined, body: number) => {
  const level = levelOf(l.size, body)
  const last = blocks.at(-1)
  const gap = prev ? Math.abs(prev.y - l.y) : 0
  if (
    prev &&
    last?.startsWith(`${level} `) === true &&
    prev.size === l.size &&
    gap < l.size * 1.6
  ) {
    blocks[blocks.length - 1] = `${last} ${escapeLine(l.text)}`
  } else {
    blocks.push(`${level} ${escapeLine(l.text)}`)
  }
}

/** A page's lines as paragraphs: a wider gap or another size starts one; a bigger size is a heading. */
const pageMarkdown = (lines: readonly Line[], body: number) => {
  const step = stepOf(lines, body)
  const blocks: string[] = []
  let para = ""
  const flush = () => {
    if (para.trim() !== "") {
      blocks.push(escapeLine(para.trim()))
    }
    para = ""
  }
  for (const [i, l] of lines.entries()) {
    // A page's number alone at its head or foot.
    if (/^\d{1,4}$/u.test(l.text) && (i === 0 || i === lines.length - 1)) {
      continue
    }
    const heading = l.size >= body * 1.15 && l.text.length < 120
    const prev = lines[i - 1]
    const gap = prev ? Math.abs(prev.y - l.y) : 0
    if (heading) {
      flush()
      addHeading(blocks, l, prev, body)
      continue
    }
    if (prev && (gap > step * 1.45 || prev.size >= body * 1.15)) {
      flush()
    }
    // A word broken over the line is one again; a compound's own hyphen ("English-to-German",
    // "well-known") stays.
    const compound = /^[\p{L}\d]+-/u.test(l.text) || /-[\p{L}\d]+-$/u.test(para)
    if (para.endsWith("-") && /^[a-z]/u.test(l.text) && !compound) {
      para = `${para.slice(0, -1)}${l.text}`
    } else if (para.endsWith("-") && /^[a-z]/u.test(l.text)) {
      para = `${para}${l.text}`
    } else {
      para = para === "" ? l.text : `${para} ${l.text}`
    }
  }
  flush()
  return blocks.join("\n\n")
}

/** A page's lines. Words set sideways (a margin's stamp) aren't the page's lines. */
const pageLines = async (doc: Pdf, n: number) => {
  const page = await doc.getPage(n)
  const content = await page.getTextContent()
  const upright = content.items.flatMap((it) => {
    if (!("str" in it)) {
      return []
    }
    const b: unknown = it.transform[1]
    const c: unknown = it.transform[2]
    return b === 0 && c === 0 ? [it] : []
  })
  return linesOf(upright)
}

/** A PDF's bookmark, as pdf.js reads it. */
interface Bookmark {
  readonly title: string
  readonly dest: string | readonly unknown[] | null
  readonly items: readonly Bookmark[]
}

/** The page a bookmark goes to, from 0. */
const pageOf = async (doc: Pdf, dest: Bookmark["dest"]) => {
  const explicit: readonly unknown[] | null =
    typeof dest === "string" ? await doc.getDestination(dest) : dest
  const ref = explicit?.[0]
  if (typeof ref === "number") {
    return ref
  }
  if (typeof ref === "object" && ref !== null && "num" in ref && "gen" in ref) {
    return await doc.getPageIndex({ num: Number(ref.num), gen: Number(ref.gen) })
  }
  return null
}

/** A PDF's bookmarks, two levels deep. */
const pdfOutline = async (doc: Pdf) => {
  const outline: readonly Bookmark[] = (await doc.getOutline().catch(() => null)) ?? []
  const nodes = async (items: readonly Bookmark[], depth: number): Promise<Node[]> =>
    await Promise.all(
      items.map(async (it) => ({
        title: it.title.replaceAll(/\s+/gu, " ").trim(),
        section: await pageOf(doc, it.dest).catch(() => null),
        items: depth < 2 ? await nodes(it.items, depth + 1) : [],
      })),
    )
  return headingsOf(await nodes(outline, 0))
}

const pdf = async (bytes: Uint8Array, name: string): Promise<Parsed> => {
  const doc = await getDocumentProxy(new Uint8Array(bytes))
  const numbers = Array.from({ length: doc.numPages }, (_, i) => i + 1)
  const pages = await Promise.all(numbers.map(async (n) => await pageLines(doc, n)))
  const sizes = pages.flatMap((p) =>
    p.flatMap((l) => Array.from({ length: Math.ceil(l.text.length / 20) }, () => l.size)),
  )
  const body = median(sizes) || 10
  const meta = await doc.getMetadata().catch(() => null)
  const info: unknown = meta?.info
  const field = (k: string) => {
    const v: unknown =
      typeof info === "object" && info !== null && k in info ? Reflect.get(info, k) : ""
    return typeof v === "string" ? v.trim() : ""
  }
  const firstHeading = pages
    .flat()
    .slice(0, 40)
    .find((l) => l.size >= body * 1.4)?.text
  const author = field("Author")
  return {
    title: firstTitle([field("Title"), firstHeading], stem(name)),
    format: "pdf",
    lang: langOf(field("Language")),
    ...(author !== "" && { author }),
    sections: pages.map((p, i) => ({ label: `${i + 1}`, markdown: pageMarkdown(p, body) })),
    outline: await pdfOutline(doc),
  }
}

// --- EPUB ---

// linkedom's parser, through its window, where it has DOM's own types.
const { DOMParser } = parseHTML("")
const xml = (text: string) => new DOMParser().parseFromString(text, "text/xml")

const resolveIn = (from: string, href: string) => {
  const clean = decodeURIComponent(href.split("#")[0] ?? "")
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), clean))
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

/** Pictures past this stay out: a data address that size would bloat every read of the book. */
const PICTURE_MAX = 1_500_000

type Files = Record<string, Uint8Array>

interface Entry {
  readonly href: string
  readonly type: string
  readonly props: string
}

const fileText = (files: Files, p: string) => {
  const f = files[p]
  return f === undefined ? "" : strFromU8(f)
}

/** A Dublin Core field: its names keep their prefix in the parsed XML. */
const dublin = (opf: Document, name: string) =>
  (opf.querySelector(`dc\\:${name}`) ?? opf.querySelector(name))?.textContent?.trim() ?? ""

const manifestOf = (opf: Document, opfPath: string) => {
  const manifest = new Map<string, Entry>()
  for (const item of opf.querySelectorAll("manifest > item")) {
    manifest.set(item.getAttribute("id") ?? "", {
      href: resolveIn(opfPath, item.getAttribute("href") ?? ""),
      type: item.getAttribute("media-type") ?? "",
      props: item.getAttribute("properties") ?? "",
    })
  }
  return manifest
}

/** Chapter names from the table of contents: EPUB 3's nav, else EPUB 2's NCX. */
const labelsOf = (files: Files, manifest: ReadonlyMap<string, Entry>) => {
  const labels = new Map<string, string>()
  const nav = [...manifest.values()].find((m) => m.props.split(" ").includes("nav"))
  if (nav) {
    const { document } = parseHTML(fileText(files, nav.href))
    for (const a of document.querySelectorAll("nav a")) {
      const target = resolveIn(nav.href, a.getAttribute("href") ?? "")
      if (!labels.has(target)) {
        labels.set(target, a.textContent?.trim() ?? "")
      }
    }
  }
  const ncx = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml")
  if (ncx && labels.size === 0) {
    for (const point of xml(fileText(files, ncx.href)).querySelectorAll("navPoint")) {
      const src = point.querySelector("content")?.getAttribute("src") ?? ""
      const target = resolveIn(ncx.href, src)
      if (!labels.has(target)) {
        labels.set(target, point.querySelector("navLabel text")?.textContent?.trim() ?? "")
      }
    }
  }
  return labels
}

interface Point {
  readonly title: string
  readonly target: string
  readonly items: readonly Point[]
}

const childrenNamed = (e: Element, name: string) =>
  [...e.children].filter((c) => c.tagName.toLowerCase() === name.toLowerCase())

const squashed = (s: string | null | undefined) => (s ?? "").replaceAll(/\s+/gu, " ").trim()

/** The table of contents as a tree: EPUB 3's nav, else EPUB 2's NCX. */
const contentsOf = (files: Files, manifest: ReadonlyMap<string, Entry>): Point[] => {
  const nav = [...manifest.values()].find((m) => m.props.split(" ").includes("nav"))
  if (nav) {
    const { document } = parseHTML(fileText(files, nav.href))
    const navs = [...document.querySelectorAll("nav")]
    const toc =
      navs.find((n) => (n.getAttribute("epub:type") ?? "").split(" ").includes("toc")) ?? navs[0]
    const list = (ol: Element | undefined): Point[] =>
      ol === undefined
        ? []
        : childrenNamed(ol, "li").map((li) => {
            const a = [...li.children].find((c) => ["a", "span"].includes(c.tagName.toLowerCase()))
            const href = a?.getAttribute("href") ?? ""
            return {
              title: squashed(a?.textContent),
              target: href === "" ? "" : resolveIn(nav.href, href),
              items: list(childrenNamed(li, "ol")[0]),
            }
          })
    const points = toc === undefined ? [] : list(childrenNamed(toc, "ol")[0])
    if (points.length > 0) {
      return points
    }
  }
  const ncx = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml")
  if (!ncx) {
    return []
  }
  const doc = xml(fileText(files, ncx.href))
  const walk = (parent: Element): Point[] =>
    childrenNamed(parent, "navPoint").map((point) => ({
      title: squashed(childrenNamed(point, "navLabel")[0]?.textContent),
      target: resolveIn(ncx.href, childrenNamed(point, "content")[0]?.getAttribute("src") ?? ""),
      items: walk(point),
    }))
  const map = doc.querySelector("navMap")
  return map === null ? [] : walk(map)
}

/** A chapter's pictures as data addresses, those too big or missing taken out. */
const inlinePictures = (document: Document, files: Files, href: string) => {
  for (const img of document.querySelectorAll("img, image")) {
    const attr = img.hasAttribute("src") ? "src" : "xlink:href"
    const src = img.getAttribute(attr) ?? img.getAttribute("href") ?? ""
    const file = files[resolveIn(href, src)]
    const type = MIME[src.split(".").pop()?.toLowerCase() ?? ""]
    if (file && type !== undefined && type !== "" && file.length < PICTURE_MAX) {
      img.setAttribute("src", `data:${type};base64,${Buffer.from(file).toString("base64")}`)
    } else {
      img.remove()
    }
  }
}

/** The spine's chapters, in order, each as Markdown with its name from the contents. */
const chaptersOf = (files: Files, opf: Document, manifest: ReadonlyMap<string, Entry>) => {
  const labels = labelsOf(files, manifest)
  const sections: Section[] = []
  const at = new Map<string, number>()
  for (const ref of opf.querySelectorAll("spine > itemref")) {
    const item = manifest.get(ref.getAttribute("idref") ?? "")
    if (!item || ref.getAttribute("linear") === "no") {
      continue
    }
    const { document } = parseHTML(fileText(files, item.href))
    inlinePictures(document, files, item.href)
    const markdown = htmlToMarkdown(document.body?.innerHTML ?? "")
    if (markdown.trim() === "") {
      continue
    }
    const label = labels.get(item.href)
    at.set(item.href, sections.length)
    sections.push(label === undefined || label === "" ? { markdown } : { label, markdown })
  }
  const tree = (points: readonly Point[]): Node[] =>
    points.map((p) => ({ title: p.title, section: at.get(p.target) ?? null, items: tree(p.items) }))
  return { sections, outline: headingsOf(tree(contentsOf(files, manifest))) }
}

const epub = (bytes: Uint8Array, name: string): Parsed => {
  const files = unzipSync(bytes)
  const container = xml(fileText(files, "META-INF/container.xml"))
  const opfPath = container.querySelector("rootfile")?.getAttribute("full-path") ?? ""
  const opf = xml(fileText(files, opfPath))
  const author = dublin(opf, "creator")
  return {
    title: firstTitle([dublin(opf, "title")], stem(name)),
    format: "epub",
    lang: langOf(dublin(opf, "language")),
    ...(author !== "" && { author }),
    ...chaptersOf(files, opf, manifestOf(opf, opfPath)),
  }
}

// --- HTML ---

/** A page's article, as Readability finds it; the whole body when it finds none. */
export const article = (
  html: string,
  base: string | undefined,
  format: Format,
  name: string,
): Parsed => {
  const { document } = parseHTML(html)
  const lang = langOf(document.documentElement?.getAttribute("lang"))
  const fallbackTitle = firstTitle(
    [document.querySelector("title")?.textContent?.trim()],
    stem(name),
  )
  // Readability's own copy, since it changes the page it reads.
  const read = new Readability(parseHTML(html).document, { keepClasses: true }).parse()
  const content = read?.content ?? document.body?.innerHTML ?? ""
  let markdown = htmlToMarkdown(content, base)
  const title = firstTitle([read?.title?.trim()], fallbackTitle)
  // Its title once: Readability's article often opens on it again.
  const lead = /^#{1,2}\s+(?<title>.+)\n/u.exec(markdown)
  if (lead !== null && lead.groups?.title?.trim() === title) {
    markdown = markdown.slice(lead[0].length).trimStart()
  }
  const byline = read?.byline ?? ""
  return {
    title,
    format,
    lang: langOf(read?.lang ?? lang),
    ...(byline !== "" && { author: byline }),
    sections: sectioned(markdown),
  }
}

/** A PDF a page says is its full text (scholarly pages' `citation_pdf_url`). */
export const pdfOf = (html: string, base: string) => {
  const { document } = parseHTML(html)
  const href =
    document.querySelector('meta[name="citation_pdf_url"]')?.getAttribute("content") ?? ""
  if (href === "") {
    return null
  }
  try {
    return new URL(href, base).href
  } catch {
    return null
  }
}

export const words = (p: Parsed) =>
  p.sections.reduce((n, s) => n + (s.markdown.match(/\p{L}[\p{L}'’-]*/gu)?.length ?? 0), 0)

// --- The rest ---

const table = (text: string, sep: string): string => {
  const rows = text
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .filter((r) => r.trim() !== "")
    .slice(0, 2000)
    .map((r) =>
      r.split(sep).map((c) =>
        c
          .trim()
          .replace(/^"(?<cell>.*)"$/u, "$<cell>")
          .replaceAll("|", "\\|"),
      ),
    )
  const [head, ...body] = rows
  if (!head) {
    return ""
  }
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array.from({ length: width - r.length }, () => "")]
  return [pad(head), Array.from({ length: width }, () => "---"), ...body.map(pad)]
    .map((r) => `| ${r.join(" | ")} |`)
    .join("\n")
}

/** What macOS's textutil turns into HTML: RTF, Word's old files, ODT, web archives. */
const textutil = (bytes: Uint8Array, ext: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), "reader-"))
  try {
    const file = path.join(dir, `in.${ext}`)
    writeFileSync(file, bytes)
    const out = spawnSync("textutil", ["-convert", "html", "-stdout", file], {
      maxBuffer: 64 * 1024 * 1024,
    })
    if (out.error || out.status !== 0) {
      throw new Error(`Can't read .${ext} files on this machine`)
    }
    return out.stdout.toString("utf-8")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What a zip holds: a DOCX, an EPUB or an OpenDocument, by its own marks. */
const sniffZip = (bytes: Uint8Array) => {
  const files = unzipSync(bytes, {
    filter: (f) => f.name === "mimetype" || f.name === "word/document.xml",
  })
  if (files["word/document.xml"]) {
    return "docx"
  }
  const mime = files.mimetype ? strFromU8(files.mimetype).trim() : ""
  if (mime === "application/epub+zip") {
    return "epub"
  }
  if (mime.startsWith("application/vnd.oasis.opendocument")) {
    return "odt"
  }
  return ""
}

const sniff = (bytes: Uint8Array) => {
  const head = strFromU8(bytes.slice(0, 512), true)
  if (head.startsWith("%PDF")) {
    return "pdf"
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const zipped = sniffZip(bytes)
    if (zipped !== "") {
      return zipped
    }
  }
  if (head.startsWith("{\\rtf")) {
    return "rtf"
  }
  if (/^\s*(?:<!doctype html|<html|<head|<body)/iu.test(head)) {
    return "html"
  }
  return ""
}

const extOf = (name: string) => path.extname(name).slice(1).toLowerCase()

const docx = async (bytes: Uint8Array, name: string): Promise<Parsed> => {
  const { value } = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
  const files = unzipSync(bytes, { filter: (f) => f.name === "docProps/core.xml" })
  const coreFile = files["docProps/core.xml"]
  const core = coreFile ? xml(strFromU8(coreFile)) : null
  const said = core?.querySelector("title")?.textContent?.trim()
  const markdown = htmlToMarkdown(value)
  const heading = /^#\s+(?<title>.+)$/mu.exec(markdown)?.groups?.title
  return {
    title: firstTitle([said, heading], stem(name)),
    format: "docx",
    lang: "en",
    sections: sectioned(markdown),
  }
}

const html = (
  bytes: Uint8Array,
  name: string,
  base: string | undefined,
  format: Format | undefined,
) => {
  const web = base !== undefined && base !== ""
  return article(strFromU8(bytes), base, format ?? (web ? "web" : "html"), name)
}

const textutilFormat = (kind: string): Format => {
  if (kind === "odt") {
    return "odt"
  }
  if (kind === "doc") {
    return "doc"
  }
  return "rtf"
}

const viaTextutil = (bytes: Uint8Array, kind: string, name: string): Parsed => {
  const read = article(textutil(bytes, kind), undefined, textutilFormat(kind), name)
  return { ...read, title: read.title === "" || read.title === "in" ? stem(name) : read.title }
}

/** Words as they are: Markdown, a table, code, or plain text. */
const plain = (bytes: Uint8Array, name: string, ext: string, mime: string): Parsed => {
  const text = () => strFromU8(bytes)
  if (["md", "markdown", "mdx", "mdown"].includes(ext) || mime === "text/markdown") {
    const markdown = text()
    const heading = /^#\s+(?<title>.+)$/mu.exec(markdown)?.groups?.title?.trim()
    return {
      title: firstTitle([heading], stem(name)),
      format: "markdown",
      lang: "en",
      sections: sectioned(markdown),
    }
  }
  if (ext === "csv" || ext === "tsv" || mime === "text/csv") {
    const sep = ext === "tsv" ? "\t" : ","
    return {
      title: stem(name),
      format: "table",
      lang: "en",
      sections: [{ markdown: table(text(), sep) }],
    }
  }
  const code = CODE[ext]
  if (code !== undefined) {
    return {
      title: path.basename(name),
      format: "code",
      lang: "en",
      sections: [{ markdown: `\`\`\`${code}\n${text()}\n\`\`\`` }],
    }
  }
  if (mime.startsWith("text/") || mime === "" || ext === "txt") {
    const body = text()
    if (body.includes("\u0000")) {
      throw new Error(`Can't read ${path.basename(name)}: not a document`)
    }
    return {
      title: stem(name),
      format: "text",
      lang: "en",
      sections: sectioned(textToMarkdown(body)),
    }
  }
  throw new Error(`Can't read ${mime || ext || "this file"}`)
}

/** A file's bytes read as a document, by what they are, then by their name and type. */
export const parse = async (
  bytes: Uint8Array,
  name: string,
  type: string | null,
  base?: string,
  format?: Format,
): Promise<Parsed> => {
  const ext = extOf(name)
  const kind = sniff(bytes) || ext
  const mime = (type ?? "").split(";")[0]?.trim() ?? ""
  if (kind === "pdf" || mime === "application/pdf") {
    return await pdf(bytes, name)
  }
  if (kind === "epub" || mime === "application/epub+zip") {
    return epub(bytes, name)
  }
  if (kind === "docx") {
    return await docx(bytes, name)
  }
  if (
    ["html", "htm", "xhtml"].includes(kind) ||
    mime === "text/html" ||
    mime === "application/xhtml+xml"
  ) {
    return html(bytes, name, base, format)
  }
  if (["rtf", "doc", "odt", "webarchive", "wordml"].includes(kind)) {
    return viaTextutil(bytes, kind, name)
  }
  return plain(bytes, name, ext, mime)
}
