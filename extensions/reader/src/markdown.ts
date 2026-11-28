// HTML as Markdown, the one form every document is read in: GitHub's tables and strikethrough, and
// math kept as TeX (`$…$`, `$$…$$`) from the forms pages carry it in: KaTeX's and MathJax's
// annotations, MathML's own, and Wikipedia's fallback pictures, whose words are their TeX.
import TurndownService from "turndown"
import { gfm } from "turndown-plugin-gfm"

const prop = (v: unknown, k: string): unknown =>
  typeof v === "object" && v !== null && k in v ? Reflect.get(v, k) : undefined

/** The TeX in Parsoid's data (a JSON attribute), when it holds some. */
const parsoidTex = (mw: string) => {
  try {
    const data: unknown = JSON.parse(mw)
    const src = prop(prop(data, "body"), "extsrc")
    if (typeof src === "string" && src.trim() !== "") {
      return src.trim()
    }
  } catch {
    // Not Parsoid's: its other forms below.
  }
  return ""
}

const texOf = (node: HTMLElement) => {
  const annotation =
    node.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? ""
  if (annotation !== "") {
    return annotation.trim()
  }
  // Wikipedia's MathML carries its source in its Parsoid data.
  const mw = node.getAttributeNode("data-mw")?.value ?? ""
  if (mw !== "") {
    const tex = parsoidTex(mw)
    if (tex !== "") {
      return tex
    }
  }
  const alt = node.getAttribute("alttext") ?? node.getAttribute("alt")
  return alt?.trim() ?? ""
}

const display = (node: HTMLElement) =>
  node.getAttribute("display") === "block" ||
  node.classList.contains("katex-display") ||
  node.classList.contains("mwe-math-fallback-image-display") ||
  node.parentElement?.classList.contains("katex-display") === true

/** Strips `\displaystyle` and the braces Wikipedia wraps its TeX in. */
const cleanTex = (tex: string) =>
  tex
    .replace(/^\{\\displaystyle\s*/u, "")
    .replace(/\}$/u, (end) => (tex.startsWith("{\\displaystyle") ? "" : end))
    .trim()

const mathRule = (content: string, node: HTMLElement) => {
  const tex = cleanTex(texOf(node))
  if (tex === "") {
    return content
  }
  return display(node) ? `\n\n$$${tex}$$\n\n` : `$${tex}$`
}

export const turndown = (base?: string) => {
  const t = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  })
  t.use(gfm)
  t.remove(["script", "style", "noscript", "iframe", "form", "button", "nav", "footer"])
  t.addRule("katex", {
    filter: (node) =>
      node.nodeName === "SPAN" &&
      (node.classList.contains("katex") || node.classList.contains("katex-display")),
    replacement: (content, node) => mathRule(content, node),
  })
  t.addRule("mathml", {
    filter: (node) => node.nodeName.toLowerCase() === "math",
    replacement: (content, node) => mathRule(content, node),
  })
  t.addRule("mathjax", {
    filter: (node) => node.nodeName.toLowerCase() === "mjx-container",
    replacement: (content, node) => mathRule(content, node),
  })
  t.addRule("wiki-math", {
    filter: (node) =>
      node.nodeName === "IMG" &&
      [...node.classList].some((c) => c.startsWith("mwe-math-fallback-image")),
    replacement: (content, node) => mathRule(content, node),
  })
  // Pictures at their whole address, against the page's own.
  t.addRule("image", {
    filter: "img",
    replacement: (_, node) => {
      const el = node
      const src = el.getAttribute("src") ?? ""
      if (src === "") {
        return ""
      }
      const alt = (el.getAttribute("alt") ?? "").replaceAll(/[[\]\n]/gu, " ")
      return `![${alt}](${absolute(src, base)})`
    },
  })
  t.addRule("link", {
    filter: (node) => node.nodeName === "A" && node.getAttribute("href") !== null,
    replacement: (content, node) => {
      const href = node.getAttribute("href") ?? ""
      if (content.trim() === "" || href.startsWith("#") || schemeOf(href) === "javascript") {
        return content
      }
      return `[${content}](${absolute(href, base).replaceAll(")", "%29")})`
    },
  })
  return t
}

/** A link's scheme (`https`, `mailto`), when it says one. */
const schemeOf = (href: string) =>
  /^(?<scheme>[a-z][a-z0-9+.-]*):/u.exec(href)?.groups?.scheme ?? ""

const absolute = (href: string, base?: string) => {
  if (base === undefined) {
    return href
  }
  try {
    return new URL(href, base).href
  } catch {
    return href
  }
}

/** Markdown from HTML, its runs of blank lines folded to one. */
export const htmlToMarkdown = (html: string, base?: string) =>
  turndown(base)
    .turndown(html)
    .replaceAll(/\n{3,}/gu, "\n\n")
    // TeX written in a page's words keeps its own marks, which Markdown's escapes would change.
    .replaceAll(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/gu, (tex) =>
      tex.replaceAll(/\\(?<mark>[_*[\]])/gu, "$<mark>"),
    )
    .trim()

/** Plain words as Markdown: paragraphs kept, nothing in them read as Markdown's marks. */
export const textToMarkdown = (text: string) =>
  text
    .replaceAll(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((p) =>
      p
        .replaceAll(/[\\`*_[\]<>|$]/gu, "\\$&")
        .replaceAll(/^(?<lead>\s*)(?<mark>[#>+-])(?<space>\s)/gmu, "$<lead>\\$<mark>$<space>")
        .replaceAll(/^(?<lead>\s*)(?<number>\d+)\.(?<space>\s)/gmu, "$<lead>$<number>\\.$<space>")
        .replaceAll("\n", "  \n"),
    )
    .join("\n\n")
    .trim()
