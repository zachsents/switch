// A page the agent makes: one self-contained HTML document, shown in the sandboxed frame McpApp
// uses. Prepared as T3 Code prepares an html_render page (packages/shared/src/htmlRender.ts and
// apps/server/src/htmlRender/HtmlRender.ts, MIT, Copyright (c) 2026 T3 Tools Inc.): a viewport
// height is refused, since the frame grows to fit the page, and a bootstrap goes in first: the
// theme's variables (Switch's tokens, which each client replaces with its own, in light and dark),
// a base sheet, the page's height told to the host as MCP Apps' `ui/notifications/size-changed`,
// and its links opened by the host (`ui/open-link`).

/** Most characters in a page, as T3's html_render takes. */
export const PAGE_MAX = 512_000
/** The least and most height a page may be given, as T3's; a client fits it to the page. */
export const PAGE_MIN_HEIGHT = 80
export const PAGE_MAX_HEIGHT = 2000

/** The style element a client fills with its own theme. */
export const THEME_ID = "switch-theme"

type Appearance = "light" | "dark"

const FONTS = {
  "--font-sans": '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif',
  "--font-mono": 'ui-monospace, "SF Mono", Menlo, monospace',
  "--font-sign": '"DIN Condensed", "DINCondensed-Bold", "Barlow Condensed", sans-serif',
}

/** Switch's default theme as a page's variables (apps/desktop/src/mainview/index.css). */
export const PAGE_THEME: Record<Appearance, Record<string, string>> = {
  light: {
    "--color-bg": "#ffffff",
    "--color-line-1": "#c8c8c8",
    "--color-line-2": "#e8e8e8",
    "--color-ink": "#0a0a0a",
    "--color-ink2": "#555555",
    "--color-ink3": "#8a8a8a",
    "--color-go": "#138a5b",
    "--color-yellow": "#ffc000",
    "--color-orange": "#f26419",
    "--color-red": "#d42a1f",
    "--color-series-1": "#2a78d6",
    "--color-series-2": "#eb6834",
    "--color-series-3": "#1baf7a",
    "--color-series-4": "#eda100",
    "--color-series-5": "#e87ba4",
    "--color-series-6": "#008300",
    "--color-series-7": "#6250d6",
    "--color-series-8": "#e34948",
    ...FONTS,
  },
  dark: {
    "--color-bg": "#0d0d0d",
    "--color-line-1": "#2c2c2c",
    "--color-line-2": "#1c1c1c",
    "--color-ink": "#ededed",
    "--color-ink2": "#a1a1a1",
    "--color-ink3": "#6b6b6b",
    "--color-go": "#2a8f66",
    "--color-yellow": "#ffc000",
    "--color-orange": "#f26419",
    "--color-red": "#d42a1f",
    "--color-series-1": "#3987e5",
    "--color-series-2": "#d95926",
    "--color-series-3": "#199e70",
    "--color-series-4": "#c98500",
    "--color-series-5": "#d55181",
    "--color-series-6": "#008300",
    "--color-series-7": "#9085e9",
    "--color-series-8": "#e66767",
    ...FONTS,
  },
}

/** How a page is laid out and colored, for the tool that takes one. */
export const PAGE_GUIDE = [
  "Self-contained: inline <style> and <script>; nothing loads from elsewhere.",
  "It fills the chat's width (about 400px on a phone, more on a desktop) on the chat's background: no page background, outer card, border, title or side padding of its own (the frame keeps an 8px edge); fluid widths.",
  "Color with Switch's variables on :root, never fixed colors: --color-bg, --color-ink, --color-ink2, --color-ink3 (words, strongest to faintest), --color-line-1, --color-line-2 (lines between and within regions), --color-go, --color-yellow, --color-orange, --color-red, --color-series-1 to --color-series-8 (a chart's series, in order), --font-sans, --font-mono, --font-sign.",
  "Let content set the height: no vh units, no height:100% on html or body; charts get fixed pixel heights.",
].join(" ")

const varsCss = (vars: Record<string, string>) =>
  Object.entries(vars)
    .map(([name, value]) => `${name}:${value};`)
    .join("")

const BASE_CSS =
  "html{box-sizing:border-box;padding:8px;background:var(--color-bg);color:var(--color-ink);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}"

/** A theme's sheet: its appearance and variables on :root. A client puts its own in this way. */
export const themeCss = (appearance: Appearance, vars: Record<string, string>) =>
  `:root{color-scheme:${appearance};${varsCss(vars)}}`

// Until a client fills it: Switch's default theme, dark, light where the system is.
const DEFAULT_CSS = `${themeCss("dark", PAGE_THEME.dark)}@media (prefers-color-scheme: light){${themeCss("light", PAGE_THEME.light)}}`

const SIZE_CHANGED = "ui/notifications/size-changed"
const OPEN_LINK = "ui/open-link"

// The page's height to its host whenever it changes, and its web links to the host to open.
const BOOTSTRAP_SCRIPT = `(function(){if(window.parent===window)return;var n=0,h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"switch-link-"+(++n),method:${JSON.stringify(OPEN_LINK)},params:{url:u.href}},"*");},true);})();`

const bootstrapMarkup = (markup: string) =>
  [
    /<meta\s[^>]*charset/iu.test(markup.slice(0, 4096)) ? "" : '<meta charset="utf-8">',
    /<meta\s[^>]*name\s*=\s*["']?viewport/iu.test(markup)
      ? ""
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${THEME_ID}">${DEFAULT_CSS}</style>`,
    `<style>${BASE_CSS}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
  ].join("")

// Inert content (comments, scripts, styles, templates) blanked without shifting offsets, so the
// bootstrap never lands inside it.
export const blankNonMarkup = (html: string) => {
  const scan = html.replaceAll(
    /<!--[\s\S]*?(?:-->|$)|<(?<tag>script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\k<tag>\s*>|$)|<plaintext\b[\s\S]*$/giu,
    (match) => " ".repeat(match.length),
  )
  const parts: string[] = []
  let depth = 0
  let start = 0
  let at = 0
  for (const match of scan.matchAll(/<(?<close>\/?)template(?:\s[^>]*)?\/?>/giu)) {
    if (match.groups?.close !== "/") {
      if (depth === 0) {
        start = match.index
      }
      depth += 1
    } else if (depth > 0) {
      depth -= 1
      if (depth === 0) {
        const end = match.index + match[0].length
        parts.push(scan.slice(at, start), " ".repeat(end - start))
        at = end
      }
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), " ".repeat(scan.length - start))
    at = scan.length
  }
  parts.push(scan.slice(at))
  return parts.join("")
}

/** The page with the bootstrap first in its head. */
const withBootstrap = (html: string) => {
  const scan = blankNonMarkup(html)
  const markup = bootstrapMarkup(scan)
  const headOpen = /<head(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/iu.exec(scan)
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length
    return html.slice(0, at) + markup + html.slice(at)
  }
  const htmlOpen = /<html(?:\s(?:[^"'>]|"[^"]*"|'[^']*')*)?>/iu.exec(scan)
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html)
  if (doctype) {
    const at = doctype[0].length
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`
  }
  return `<!doctype html><head>${markup}</head>${html}`
}

// Only stylesheets and style attributes, comments skipped whole; base64 runs aren't units.
const CSS_SOURCE =
  /<!--[\s\S]*?(?:-->|$)|<style\b[^>]*(?:>|$)(?<sheet>[\s\S]*?)(?:<\/style\s*>|$)|\sstyle\s*=\s*(?:"(?<double>[^"]*)(?:"|$)|'(?<single>[^']*)(?:'|$)|(?<bare>[^\s>]+))/giu
const VIEWPORT_HEIGHT = /(?<![\w.+/])(?:\d+(?:\.\d+)?|\.\d+)[sld]?vh(?![\w-])/iu

/** A page ready to show, or what's wrong with it. */
export const preparePage = (
  html: string,
): { readonly page: string } | { readonly wrong: string } => {
  for (const match of html.matchAll(CSS_SOURCE)) {
    const g = match.groups
    const found = VIEWPORT_HEIGHT.exec(g?.sheet ?? g?.double ?? g?.single ?? g?.bare ?? "")?.[0]
    if (found !== undefined) {
      return {
        wrong: `The page uses a viewport height (${found}). Its frame grows to fit it, so a size that follows the viewport grows again and again: let content set the height, or use pixels.`,
      }
    }
  }
  return { page: withBootstrap(html) }
}

/** A prepared page with the height it opens at, before it says what it draws. */
export const withHeight = (page: string, height: number) =>
  page.replace(
    new RegExp(`<style id="${THEME_ID}">[^<]*</style>`, "u"),
    (theme) => `${theme}<meta name="switch-height" content="${Math.round(height)}">`,
  )

/** A prepared page with a theme of its own in place of the default. */
export const themedPage = (page: string, appearance: Appearance, vars: Record<string, string>) =>
  page.replace(
    new RegExp(`<style id="${THEME_ID}">[^<]*</style>`, "u"),
    () => `<style id="${THEME_ID}">${themeCss(appearance, vars)}</style>`,
  )
