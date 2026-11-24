// A page as a browser shows it and prints it, as Switchboard's links drew theirs
// (crates/core/src/links.rs): a clean, small page in the system's light or dark, its title, what it
// shows, and its dated plans with buttons to subscribe to them; on paper, tables at the paper's
// width with their headers on each page, pictures kept with their captions, page numbers, and
// nothing that's only for a screen; on a wide screen its outline beside it. A markdown document, a
// surface or an HTML article is drawn in this shell, its sheet and outline; an article runs
// sandboxed, as a blank page (the agent's whole page, in nothing of ours) does.
import { googleEvent, said } from "./events.ts"
import type { datedOf } from "./events.ts"
import { blankNonMarkup } from "../page.ts"
import type { PageBody } from "./records.ts"
import { SURFACE_CSS, surfaceHtml } from "./surface-html.ts"

type Dated = Extract<ReturnType<typeof datedOf>, { dated: unknown }>["dated"]

export const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")

/** Letter, 14 mm margins and 16 at the foot: a picture may be as tall as the 245 mm between. */
const STYLE = `
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--soft:#f5f5f7;--accent:#6d28d9;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--fg:#f5f5f7;--muted:#a1a1a6;--line:#3a3a3c;--soft:#1c1c1e;--accent:#a78bfa;--accent-fg:#111}body{background:#000}}
*{box-sizing:border-box}
body{margin:0;color:var(--fg);font:17px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:720px;margin:0 auto;padding:max(28px,env(safe-area-inset-top)) 20px 64px}
h1{font-size:1.75rem;line-height:1.2;margin:0 0 .5em}header h1{margin:0 0 6px}
.meta{color:var(--muted);font-size:.9rem;margin:0 0 24px}
.meta a{color:inherit}
h2{font-size:1.3rem;margin:1.8em 0 .5em}h3{font-size:1.1rem;margin:1.5em 0 .4em}
a{color:var(--accent)}
p,ul,ol{margin:.6em 0}li{margin:.2em 0}
img{max-width:100%;height:auto;border-radius:8px}figure{margin:1.2em 0}figcaption{font-size:.9rem;margin-top:.4em}
hr{border:0;border-top:1px solid var(--line);margin:2em 0}
blockquote{margin:1em 0;padding:.1em 1em;border-left:3px solid var(--line);color:var(--muted)}
code{font:.9em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);padding:.1em .3em;border-radius:4px}
pre{background:var(--soft);padding:12px;border-radius:8px;overflow-x:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;margin:1em 0;font-size:.95rem}
th,td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{font-weight:600;white-space:nowrap}
.outline{display:none}.contents{border-block:1px solid var(--line);margin:0 0 24px;padding:8px 0;font-size:.95rem}.contents summary{cursor:pointer;font-weight:600}
.outline ol,.contents ol{list-style:none;margin:0;padding:0}.outline li,.contents li{margin:0}.contents ol{padding-top:6px}.contents .toc-3{padding-left:12px}
.outline a,.contents a{display:block;color:var(--muted);text-decoration:none;padding:3px 0}.outline a:hover,.contents a:hover,.outline a[aria-current]{color:var(--fg)}
h2[id],h3[id]{scroll-margin-top:20px}
@media (min-width:1100px){.outline{display:block;position:fixed;top:28px;left:calc(50% - 480px);width:200px;max-height:calc(100vh - 56px);overflow-y:auto;border-left:1px solid var(--line);font-size:.9rem;line-height:1.35}
body:has(>.outline)>main{margin-left:calc(50% - 240px)}.contents{display:none}
.outline a{padding:4px 0 4px 12px;border-left:2px solid transparent;transition:color .12s,border-color .12s}.outline .toc-3 a{padding-left:24px}.outline a[aria-current]{border-left-color:var(--accent)}}
.task-list-item{list-style:none}.task-list-item input{margin:0 .5em 0 -1.3em}
.print{display:none}
@page{size:letter;margin:14mm 14mm 16mm;@bottom-right{content:counter(page) " / " counter(pages);font:8pt sans-serif;color:#888}}
@media print{
:root{--fg:#1d1d1f;--muted:#6e6e73;--line:#d9d9de;--soft:#f3f3f5;--accent:#5b21b6}
body{background:#fff;font-size:10.5pt;line-height:1.45}
main{max-width:none;padding:0}
header h1{font-size:20pt}.meta{margin-bottom:14pt}
h2{font-size:14pt;margin:1.2em 0 .4em}h3{font-size:12pt;margin:1em 0 .3em}h1,h2,h3{break-after:avoid}
table{display:table;width:100%;overflow:visible;font-size:9pt}thead{display:table-header-group}th{white-space:normal}
tr,img,pre,blockquote,li{break-inside:avoid}
img{display:block;max-height:245mm;width:auto;margin:2pt 0 3pt}p:has(>img){break-inside:avoid}
a{text-decoration:none}pre{white-space:pre-wrap}
.screen,.add,.outline,.contents{display:none}.print{display:inline}}`

/** The calendar's look, scoped to it, so it sits in an HTML page of the agent's too. */
const CALENDAR_STYLE = `
#calendar{margin-top:2.5em;padding-top:.5em;border-top:1px solid var(--line,#e3e3e8)}
#calendar .actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#calendar .button{display:inline-block;padding:9px 14px;border-radius:10px;background:var(--accent,#6d28d9);color:var(--accent-fg,#fff);text-decoration:none;font-weight:600;font-size:.95rem}
#calendar .button.quiet{background:var(--soft,#f5f5f7);color:var(--fg,#1d1d1f)}
#calendar .events{list-style:none;padding:0;margin:16px 0}
#calendar .events li{padding:12px 0;border-bottom:1px solid var(--line,#e3e3e8)}
#calendar .when{opacity:.7;font-size:.9rem}#calendar .what{font-weight:600}#calendar .where,#calendar .notes{font-size:.95rem}
#calendar .add{font-size:.9rem}
@media print{#calendar .screen,#calendar .add{display:none}}`

const HEAD = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">`

const inPage = (html: string) => html.replaceAll('<a href="#', '<a target="_self" href="#')

/**
 * Marks the outline's section the reader is in: the last heading scrolled past, or the last one at
 * the page's end. A document's policy runs this script alone, by its hash.
 */
const SPY = `const a=[...document.querySelectorAll(".outline a")],h=a.map(l=>document.getElementById(decodeURIComponent(l.hash.slice(1))));const spy=()=>{let at=0;h.forEach((e,i)=>{if(e&&e.getBoundingClientRect().top<=80)at=i});if(innerHeight+scrollY>=document.documentElement.scrollHeight-2)at=h.length-1;a.forEach((l,i)=>i===at?l.setAttribute("aria-current","location"):l.removeAttribute("aria-current"));const n=a[0]?.closest("nav"),c=a[at];if(n&&c&&(c.offsetTop<n.scrollTop||c.offsetTop+c.offsetHeight>n.scrollTop+n.clientHeight))n.scrollTop=c.offsetTop-n.clientHeight/3};addEventListener("scroll",spy,{passive:true});addEventListener("resize",spy);spy()`
export const SPY_HASH = `sha256-${new Bun.CryptoHasher("sha256").update(SPY).digest("base64")}`

const outlineNav = (outline: string) =>
  `<nav class="outline" aria-label="Contents">${outline}</nav>`
const contents = (outline: string) =>
  `<details class="contents"><summary>Contents</summary>${outline}</details>`

/**
 * The frame every page is in, and a link that leads nowhere too. Its links open in a new tab.
 * `outline`, the page's sections, sits beside it on a wide screen.
 */
export const shell = (title: string, main: string, outline = "") =>
  `<!doctype html>\n<html lang="en"><head>${HEAD}<base target="_blank"><title>${escape(title)}</title><style>${STYLE}${CALENDAR_STYLE}${SURFACE_CSS}</style></head><body>${outline === "" ? "" : outlineNav(outline)}<main>${inPage(main)}</main>${outline === "" ? "" : `<script>${SPY}</script>`}</body></html>\n`

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }
const HEADING =
  /<h(?<level>[23])(?<attrs>(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?)>(?<inner>[\s\S]*?)<\/h\k<level>\s*>/giu
const ID = /\sid\s*=\s*(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^\s>]+))/iu

/** A heading's words, as text in HTML. */
const wordsOf = (heading: string) =>
  heading
    .replace(/^<h[23][^>]*>/iu, "")
    .replace(/<\/h[23]\s*>$/iu, "")
    .replaceAll(/<[^>]*>/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()

/** An id of the words, not yet taken, now taken. */
const slug = (words: string, taken: Set<string>) => {
  const base =
    words
      .replaceAll(/&(?<name>amp|lt|gt|quot|#39);/gu, (_, name: string) => ENTITIES[name] ?? "")
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "") || "section"
  let id = base
  for (let n = 2; taken.has(id); n += 1) {
    id = `${base}-${n}`
  }
  taken.add(id)
  return id
}

const idIn = (attrs: string) => {
  const g = ID.exec(attrs)?.groups
  return g?.double ?? g?.single ?? g?.bare
}

/**
 * The HTML with each h2 and h3 given an id of its words where it has none, made unique, and the
 * outline that links them, when there are three or more; nothing else changes. Headings are found
 * in `scan`, the HTML with what isn't markup blanked at the same offsets.
 */
export const outlined = (html: string, scan = html) => {
  const taken = new Set(["calendar"])
  for (const m of scan.matchAll(new RegExp(ID.source, "giu"))) {
    taken.add(idIn(m[0]) ?? "")
  }
  const listed: string[] = []
  const parts: string[] = []
  let from = 0
  for (const m of scan.matchAll(HEADING)) {
    const attrs = m.groups?.attrs ?? ""
    const whole = html.slice(m.index, m.index + m[0].length)
    const words = wordsOf(whole)
    let id = idIn(attrs)
    if (id === undefined) {
      id = slug(words, taken)
      const open = 3 + attrs.length
      parts.push(html.slice(from, m.index), whole.slice(0, open), ` id="${id}"`)
      from = m.index + open
    }
    listed.push(
      `<li class="toc-${m.groups?.level}"><a target="_self" href="#${escape(encodeURIComponent(id))}">${words}</a></li>`,
    )
  }
  parts.push(html.slice(from))
  return { html: parts.join(""), outline: listed.length >= 3 ? `<ol>${listed.join("")}</ol>` : "" }
}

/** A link that leads to no page, or to one taken down. */
export const missing = (gone: boolean) => {
  const title = gone ? "Taken down" : "No such page"
  return shell(title, `<header><h1>${title}</h1></header>`)
}

/** GitHub's flavor, with raw HTML shown as text. */
export const MARKDOWN = { noHtmlBlocks: true, noHtmlSpans: true, autolinks: true }

const SAFE_HREF = /^(?:https?:|mailto:|tel:|#|\/p\/)/iu

/**
 * A document's markdown as HTML: GitHub's flavor, with raw HTML left out, links only to the web,
 * mail, phone or within the page, and images from blobs or the web (`image` says where each is
 * read from, or null to leave it out).
 */
export const markdownHtml = (text: string, image: (src: string) => string | null) =>
  Bun.markdown
    .html(text, MARKDOWN)
    .replaceAll(/<a href="(?<href>[^"]*)"/gu, (whole, href: string) =>
      SAFE_HREF.test(href) ? whole : "<a",
    )
    .replaceAll(/<img src="(?<src>[^"]*)"(?<rest>[^>]*)>/gu, (_, src: string, rest: string) => {
      const at = image(src.replaceAll("&amp;", "&"))
      return at === null ? "" : `<img src="${escape(at)}"${rest}>`
    })

/** Where a page's image is read from: a blob through the page's link, else the web as it is. */
export const imageAt =
  (blobAt: (hash: string) => string | null) =>
  (src: string): string | null => {
    const hash = /(?:^|\/|sha256:)(?<hash>[0-9a-f]{64})$/u.exec(src)?.groups?.hash
    if (hash !== undefined) {
      return blobAt(hash)
    }
    return src.startsWith("https://") ? src : null
  }

export interface Rendering {
  readonly title: string
  readonly body: Exclude<PageBody, { shell: "blank" }>
  readonly dated: Dated
  /** The page's own link. */
  readonly link: string
  readonly image: (src: string) => string | null
  /** Whether the link is on the public internet, so Google Calendar can subscribe to it. */
  readonly public: boolean
  /** Whether to offer its PDF. */
  readonly pdf: boolean
}

const calendarSection = (r: Rendering) => {
  const feed = `${r.link}/calendar.ics`
  const webcal = feed.replace(/^https?:\/\//u, "webcal://")
  const buttons = [
    // A calendar app takes it, which would leave a new tab blank.
    `<a class="button" target="_self" href="${escape(webcal)}">Apple Calendar</a>`,
    // Google fetches the calendar itself, so only one the internet reaches.
    r.public
      ? `<a class="button" href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}">Google Calendar</a>`
      : "",
    `<a class="button quiet" target="_self" href="${escape(feed)}">Download</a>`,
  ].join("")
  const items = r.dated
    .map((e) =>
      [
        `<li><div class="when">${escape(said(e))}</div><div class="what">${escape(e.title)}</div>`,
        e.location === undefined
          ? ""
          : `<div class="where"><a href="https://maps.apple.com/?q=${encodeURIComponent(e.location)}">${escape(e.location)}</a></div>`,
        e.notes === undefined ? "" : `<div class="notes">${escape(e.notes)}</div>`,
        `<div class="add"><a href="${escape(googleEvent(e, r.link))}">Add to Google Calendar</a></div></li>`,
      ].join(""),
    )
    .join("")
  return `<section id="calendar"><h2>Calendar</h2><div class="actions screen">${buttons}</div><ul class="events">${items}</ul></section>`
}

/** An article's HTML with its images from blobs read as `image` says; others as they are. */
const articleHtml = (html: string, image: (src: string) => string | null) =>
  html.replaceAll(
    /(?<lead><img\b[^>]*?\ssrc=")(?<src>(?:sha256:)?[0-9a-f]{64})"/giu,
    (whole, lead: string, src: string) => {
      const at = image(src)
      return at === null ? whole : `${lead}${escape(at)}"`
    },
  )

/** What a page shows, its sections given ids, and its outline. */
const shownOf = (body: Rendering["body"], image: (src: string) => string | null) => {
  if (body.kind === "html") {
    const html = articleHtml(body.html, image)
    return outlined(html, blankNonMarkup(html))
  }
  return outlined(
    body.kind === "document" ? markdownHtml(body.text, image) : surfaceHtml(body.surface, image),
  )
}

/** A document's, a surface's or an article's page. */
export const render = (r: Rendering) => {
  const jumps = [
    r.dated.length > 0 ? '<a href="#calendar">Calendar</a>' : "",
    r.pdf ? `<a target="_self" href="${escape(r.link)}/pdf">PDF</a>` : "",
  ].filter((j) => j !== "")
  const meta = jumps.length > 0 ? `<p class="meta screen">${jumps.join(" · ")}</p>` : ""
  const shown = shownOf(r.body, r.image)
  const calendar = r.dated.length > 0 ? calendarSection(r) : ""
  return shell(
    r.title,
    `<header><h1>${escape(r.title)}</h1>${meta}</header>${shown.outline === "" ? "" : contents(shown.outline)}<article>${shown.html}</article>${calendar}`,
    shown.outline,
  )
}

const HEAD_OPEN = /<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/iu

/** A blank page: the agent's whole page as it is, titled, and kept out of indexes and referrers. */
export const blankPage = (page: string, title: string) => {
  const head = `${/<title[\s>]/iu.test(page) ? "" : `<title>${escape(title)}</title>`}<meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer">`
  const opened = HEAD_OPEN.exec(blankNonMarkup(page))
  if (opened) {
    const at = opened.index + opened[0].length
    return page.slice(0, at) + head + page.slice(at)
  }
  return `<!doctype html><head>${head}</head>${page.replace(/^\s*<!doctype[^>]*>/iu, "")}`
}
