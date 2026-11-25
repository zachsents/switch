// Math on a page: KaTeX's HTML and its sheet, drawn on the server (no script on the page), its
// fonts in the sheet itself so a page and its PDF stand alone. Only a page with math carries them.
import { readFileSync } from "node:fs"
import { renderToString } from "katex"
import sheet from "katex/dist/katex.min.css" with { type: "text" }
import AMSRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2" with { type: "file" }
import CaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2" with { type: "file" }
import CaligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2" with { type: "file" }
import FrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2" with { type: "file" }
import FrakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2" with { type: "file" }
import MainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2" with { type: "file" }
import MainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2" with { type: "file" }
import MainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2" with { type: "file" }
import MainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2" with { type: "file" }
import MathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2" with { type: "file" }
import MathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2" with { type: "file" }
import SansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2" with { type: "file" }
import SansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2" with { type: "file" }
import SansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2" with { type: "file" }
import ScriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2" with { type: "file" }
import Size1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2" with { type: "file" }
import Size2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2" with { type: "file" }
import Size3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2" with { type: "file" }
import Size4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2" with { type: "file" }
import TypewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2" with { type: "file" }
import { splitMath } from "./split.ts"

const FONTS: Record<string, string> = {
  "KaTeX_AMS-Regular": AMSRegular,
  "KaTeX_Caligraphic-Bold": CaligraphicBold,
  "KaTeX_Caligraphic-Regular": CaligraphicRegular,
  "KaTeX_Fraktur-Bold": FrakturBold,
  "KaTeX_Fraktur-Regular": FrakturRegular,
  "KaTeX_Main-Bold": MainBold,
  "KaTeX_Main-BoldItalic": MainBoldItalic,
  "KaTeX_Main-Italic": MainItalic,
  "KaTeX_Main-Regular": MainRegular,
  "KaTeX_Math-BoldItalic": MathBoldItalic,
  "KaTeX_Math-Italic": MathItalic,
  "KaTeX_SansSerif-Bold": SansSerifBold,
  "KaTeX_SansSerif-Italic": SansSerifItalic,
  "KaTeX_SansSerif-Regular": SansSerifRegular,
  "KaTeX_Script-Regular": ScriptRegular,
  "KaTeX_Size1-Regular": Size1Regular,
  "KaTeX_Size2-Regular": Size2Regular,
  "KaTeX_Size3-Regular": Size3Regular,
  "KaTeX_Size4-Regular": Size4Regular,
  "KaTeX_Typewriter-Regular": TypewriterRegular,
}

let css: string | null = null

/** KaTeX's sheet, each font as data in it (woff2 alone, which every browser that runs it reads). */
export const mathCss = () => {
  css ??= sheet.replaceAll(
    /src:url\(fonts\/(?<name>KaTeX_[\w-]+)\.woff2\)[^;}]*/gu,
    (whole, name: string) => {
      const path = FONTS[name]
      return path === undefined
        ? whole
        : `src:url(data:font/woff2;base64,${readFileSync(path).toString("base64")}) format("woff2")`
    },
  )
  return css
}

const OPEN = ""
const CLOSE = ""
const TOKEN = /(?<n>\d+)/gu
const ALONE = /<p>(?<n>\d+)<\/p>/gu

/**
 * Markdown with its math (`splitMath`) drawn: each formula held out of the Markdown as a token,
 * so its `_` and `\\` stay TeX's, and put back as KaTeX's HTML once `html` has made the rest.
 * A `$$` formula on lines of its own is a paragraph of its own, drawn as a block. `math` says
 * whether there was any, for `mathCss`.
 */
export const withMath = (text: string, html: (markdown: string) => string) => {
  const segments = splitMath(text)
  if (segments.every((s) => s.kind === "text")) {
    return { html: html(text), math: false }
  }
  const formulas: { tex: string; display: boolean }[] = []
  let markdown = ""
  for (const [n, s] of segments.entries()) {
    if (s.kind === "text") {
      markdown += s.text
      continue
    }
    const token = `${OPEN}${formulas.length}${CLOSE}`
    formulas.push({ tex: s.text, display: s.kind === "display" })
    const before = segments[n - 1]
    const after = segments[n + 1]
    const own =
      s.kind === "display" &&
      (before === undefined || before.text.endsWith("\n")) &&
      (after === undefined || after.text.startsWith("\n"))
    markdown += own ? `\n\n${token}\n\n` : token
  }
  const draw = (n: string, display: boolean) => {
    const f = formulas[Number(n)]
    return f === undefined
      ? ""
      : renderToString(f.tex, { displayMode: display && f.display, throwOnError: false })
  }
  return {
    html: html(markdown)
      .replaceAll(ALONE, (_, n: string) => draw(n, true))
      .replaceAll(TOKEN, (_, n: string) => draw(n, false)),
    math: true,
  }
}
