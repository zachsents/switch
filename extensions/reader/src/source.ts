// Where a document comes from: a file on this machine, an address on the web, or one of Switch's
// published pages (by its link, its id or its title). Each source is one document, its id made from
// the source, so opening it again finds its highlights and threads.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { article, parse, pdfOf, words } from "./formats.ts"
import type { Parsed } from "./formats.ts"

const AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

/** Most bytes read from a file or a download. */
const MOST = 200 * 1024 * 1024

/** A published page's link: `<base>/p/<token>`. */
const PAGE = /\/p\/[0-9a-f]{32}\/?$/u

export const docId = (source: string) =>
  createHash("sha256").update(source).digest("hex").slice(0, 16)

export const isUrl = (s: string) => /^https?:\/\//iu.test(s)

export const filePath = (s: string) => {
  if (s.startsWith("file://")) {
    return decodeURIComponent(new URL(s).pathname)
  }
  if (s.startsWith("~/")) {
    return path.join(homedir(), s.slice(2))
  }
  return path.isAbsolute(s) ? s : null
}

const download = async (url: string) => {
  const res = await fetch(url, {
    headers: {
      "User-Agent": AGENT,
      Accept: "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    throw new Error(`${new URL(url).host} answered ${res.status}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > MOST) {
    throw new Error("Too big to read")
  }
  return { bytes, type: res.headers.get("content-type"), url: res.url || url }
}

const nameOf = (url: string) => {
  const u = new URL(url)
  const last = u.pathname.split("/").findLast((p) => p !== "") ?? u.hostname
  return decodeURIComponent(last)
}

/** A document read from the web: a page's article, or the file it is. */
const fromWeb = async (url: string): Promise<Parsed> => {
  const got = await download(url)
  const page = PAGE.test(new URL(got.url).pathname)
  const read = await parse(got.bytes, nameOf(got.url), got.type, got.url, page ? "page" : undefined)
  // A scholarly page's abstract leads to its paper.
  if (read.format === "web" && words(read) < 700) {
    const pdf = pdfOf(new TextDecoder().decode(got.bytes), got.url)
    if (pdf !== null) {
      const paper = await download(pdf).catch(() => null)
      if (paper) {
        return await parse(paper.bytes, nameOf(paper.url), paper.type, paper.url)
      }
    }
  }
  return read
}

const fromFile = async (file: string): Promise<Parsed> => {
  if (!existsSync(file)) {
    throw new Error(`No file at ${file}`)
  }
  const stat = statSync(file)
  if (stat.isDirectory()) {
    // A web archive folder's page, else nothing.
    throw new Error(`${file} is a folder`)
  }
  if (stat.size > MOST) {
    throw new Error("Too big to read")
  }
  return await parse(new Uint8Array(readFileSync(file)), file, null)
}

/** Reads a source: a path, an address (a published page's included). */
export const readSource = async (source: string): Promise<Parsed> => {
  const file = filePath(source)
  if (file !== null) {
    return await fromFile(file)
  }
  if (isUrl(source)) {
    return await fromWeb(source)
  }
  throw new Error(`Can't find ${source}`)
}

/** Words given straight (pasted, or the agent's), read as Markdown. */
export const fromText = (text: string, title: string, html: boolean): Parsed =>
  html
    ? article(text, undefined, "html", title)
    : { title, format: "markdown", lang: "en", sections: [{ markdown: text }] }
