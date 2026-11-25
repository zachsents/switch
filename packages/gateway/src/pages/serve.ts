// Pages as the world reads them, with no credential: the token in the link is what lets it in.
// `/p/<token>` is the page; `/pdf` it printed; `/calendar.ics` its dated plans as a calendar;
// `/blobs/<hash>` an image it shows, and only one it shows. A page taken down says so (410). These
// are all a pages-only listener serves, which is what a public proxy points at.
import { Blobs, Brain, hashOf } from "@switch/brain"
import { Effect, Option, Schema } from "effect"

import { Preview } from "../preview.ts"
import { datedOf, ics } from "./events.ts"
import { Pages } from "./pages.ts"
import { PageBody, PageEvent, allPages } from "./records.ts"
import type { PageRow } from "./records.ts"
import { SPY_HASH, blankPage, escape, imageAt, missing, render } from "./render.ts"

/** Every answer: the token never leaves in a referrer, and nothing indexes it. */
const PRIVATE = {
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache",
}
/** A document or a surface runs nothing but its outline's own script. */
const STATIC_POLICY = `default-src 'none'; script-src '${SPY_HASH}'; img-src 'self' https: data:; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
/** The agent's HTML, an article or a blank page, runs its own scripts, in an origin of its own, reaching nothing. */
const PAGE_POLICY =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' https: data: blob:; font-src data:; media-src 'self' https: data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(PageBody))
const decodeEvents = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(PageEvent)))

const answer = (
  status: number,
  type: string,
  body: string | Uint8Array,
  more: Record<string, string> = {},
) => new Response(body, { status, headers: { ...PRIVATE, "Content-Type": type, ...more } })

const gonePage = (gone: boolean) =>
  answer(gone ? 410 : 404, "text/html; charset=utf-8", missing(gone), {
    "Content-Security-Policy": STATIC_POLICY,
  })

/** What a file's bytes are, for the images a page shows. */
const imageType = (bytes: Uint8Array) => {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return "image/png"
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return "image/jpeg"
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return "image/gif"
  }
  if (at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return "image/webp"
  }
  return null
}

/** A title as a file name any system takes. */
const fileName = (title: string) =>
  title
    .replaceAll(/[–—]/gu, "-")
    .replaceAll(/[^\w .,()&+-]/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, 100) || "page"

/** The last few PDFs printed, by what they were printed from: a phone often fetches one twice. */
const printed = new Map<string, Uint8Array>()
const KEPT = 4
/** One print at a time: each takes a few seconds and a browser's memory. */
let printing: Promise<unknown> = Promise.resolve()

export const pagesRoute = Effect.gen(function* routing() {
  const brain = yield* Brain
  const blobs = yield* Blobs
  const preview = yield* Preview
  const pages = yield* Pages
  const byToken = new Map<string, string>()

  const find = async (token: string): Promise<PageRow | null> => {
    if (!/^[0-9a-f]{32}$/u.test(token)) {
      return null
    }
    const rows = await Effect.runPromise(brain.read(allPages))
    if (!byToken.has(token)) {
      for (const row of rows) {
        byToken.set(pages.tokenOf(row.id), row.id)
      }
    }
    const id = byToken.get(token)
    return rows.find((r) => r.id === id) ?? null
  }

  const bodyOf = async (row: PageRow) => {
    const at = await Effect.runPromise(blobs.path(row.body))
    return at === null ? Option.none() : decodeBody(await Bun.file(at).text())
  }

  /** The blobs a page shows, by hash, where they're kept: only those it names. */
  const shownBlobs = async (body: PageBody) => {
    const named = [...new Set(JSON.stringify(body).match(/[0-9a-f]{64}/gu))]
    const found = await Promise.all(
      named.map(async (hash) => {
        const blob = hashOf(hash)
        const at = blob === null ? null : await Effect.runPromise(blobs.path(blob))
        return [hash, at] as const
      }),
    )
    return new Map(found.flatMap(([hash, at]) => (at === null ? [] : [[hash, at] as const])))
  }

  /** The page's HTML; `files` reads its images from their files, as a print does. */
  const pageHtml = async (row: PageRow, body: PageBody, token: string, files: boolean) => {
    const link = `${pages.base}/p/${token}`
    const dated = Option.match(decodeEvents(row.events), {
      onNone: () => [],
      onSome: (events) => {
        const checked = datedOf(events)
        return "dated" in checked ? checked.dated : []
      },
    })
    const shared = { title: row.title, dated, link, public: pages.public, pdf: !files }
    if (body.kind === "html" && body.shell === "blank") {
      return blankPage(body.html, row.title)
    }
    const kept = files ? await shownBlobs(body) : new Map<string, string>()
    const blobAt = (hash: string) => {
      if (!files) {
        return `/p/${token}/blobs/${hash}`
      }
      const at = kept.get(hash)
      return at === undefined ? null : Bun.pathToFileURL(at).href
    }
    return render({ ...shared, body, image: imageAt(blobAt) })
  }

  const calendar = (row: PageRow, token: string) => {
    const events = Option.getOrElse(decodeEvents(row.events), () => [])
    const checked = datedOf(events)
    const dated = "dated" in checked ? checked.dated : []
    const link = `${pages.base}/p/${token}`
    return answer(
      200,
      "text/calendar; charset=utf-8",
      ics({ title: row.title, dated, link, token, updated: row.updated }),
      { "Content-Disposition": 'inline; filename="calendar.ics"' },
    )
  }

  const image = async (body: PageBody, blob: string) => {
    const shown = await shownBlobs(body)
    const at = shown.get(blob)
    const bytes = at === undefined ? null : new Uint8Array(await Bun.file(at).arrayBuffer())
    const type = bytes === null ? null : imageType(bytes)
    if (bytes === null || type === null) {
      return answer(404, "text/plain; charset=utf-8", "No such image")
    }
    return answer(200, type, bytes, { "Cache-Control": "private, max-age=86400" })
  }

  const pdfOf = async (row: PageRow, body: PageBody, token: string) => {
    const html = await pageHtml(row, body, token, true)
    const key = new Bun.CryptoHasher("sha256").update(html).digest("hex")
    let pdf = printed.get(key)
    if (pdf === undefined) {
      const turn = printing.then(
        async () => await Effect.runPromise(Effect.result(preview.print(html))),
      )
      printing = turn.catch(() => null)
      const done = await turn
      if (done._tag === "Failure") {
        return answer(500, "text/plain; charset=utf-8", `Couldn't print it: ${done.failure}`)
      }
      pdf = done.success
      printed.set(key, pdf)
      for (const old of [...printed.keys()].slice(0, Math.max(0, printed.size - KEPT))) {
        printed.delete(old)
      }
    }
    return answer(200, "application/pdf", pdf, {
      "Content-Disposition": `inline; filename="${escape(fileName(row.title))}.pdf"; filename*=UTF-8''${encodeURIComponent(row.title)}.pdf`,
    })
  }

  return async (request: Request): Promise<Response> => {
    const parts = new URL(request.url).pathname.split("/")
    const [, root, token = "", what = "", blob] = parts
    if (root !== "p" || request.method !== "GET" || parts.length > 5) {
      return answer(404, "text/plain; charset=utf-8", "Not found")
    }
    const row = await find(token)
    if (row === null || row.retired === 1) {
      return gonePage(row !== null)
    }
    const body = await bodyOf(row)
    if (Option.isNone(body)) {
      return answer(500, "text/plain; charset=utf-8", "This page's body is missing")
    }
    if (what === "") {
      const html = await pageHtml(row, body.value, token, false)
      const policy = body.value.kind === "html" ? PAGE_POLICY : STATIC_POLICY
      return answer(200, "text/html; charset=utf-8", html, { "Content-Security-Policy": policy })
    }
    if (what === "calendar.ics") {
      return calendar(row, token)
    }
    if (what === "blobs" && blob !== undefined) {
      return await image(body.value, blob)
    }
    if (what === "pdf") {
      return await pdfOf(row, body.value, token)
    }
    return answer(404, "text/plain; charset=utf-8", "Not found")
  }
})
