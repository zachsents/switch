// The desktop view's look, held (apps/desktop-gpui/DESIGN.md, as the old app had it): one background, every color a token from
// index.css, every
// press is the one Button (ui/kit/button.tsx), and nothing moves but what scripts/ui-look.allow names
// (a path, a tab, the line's words). Fails listing each break.
import { Glob } from "bun"

const ROOT = "apps/desktop/src/mainview"
const allowText = await Bun.file("scripts/ui-look.allow").text()
const allow = allowText
  .split("\n")
  .filter((l) => l.trim() !== "" && !l.startsWith("#"))
  .map((l) => {
    const [path = "", words = ""] = l.split("\t")
    return { path, words }
  })
const allowed = (path: string, line: string) =>
  allow.some((a) => path.endsWith(a.path) && line.includes(a.words))

const RULES: readonly {
  readonly name: string
  readonly re: RegExp
  readonly where: (p: string) => boolean
}[] = [
  // Raw colors: only index.css's tokens and look.ts's inks (a space's line) name one.
  {
    name: "raw color",
    re: /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\b(?:bg|text|border|fill|stroke|outline|from|to|ring|shadow)-\[#/u,
    // index.css's tokens, look.ts's inks, and theme.ts, which makes the tokens from the user's theme.
    where: (p) =>
      !p.endsWith("index.css") && !p.endsWith("ui/look.ts") && !p.endsWith("ui/theme.ts"),
  },
  // One background: nothing fills a surface but `bg` (and the agent's words, their `bubble`). Black is a plate on a picture, green the key
  // that acts, inks and lamps are marks; lines are lines.
  {
    name: "second background",
    re: /\bbg-(?!(?:bg|bubble|hover|transparent|go|go-press|black|white|ink|ink2|ink3|orange|yellow|red|line-1|line-2|current)\b)[a-z][a-z0-9-]*|(?<![\w-])background(?:-color)?:(?!\s*(?:var\(--color-(?:bg|bubble|hover|go|go-press|black|ink|ink2|ink3|line-1|line-2|orange|yellow|red)\)|transparent|none))/u,
    where: () => true,
  },
  // Pointer highlights never change edges or text; focus rings remain explicit.
  {
    name: "hover edge or ink",
    re: /(?:hover|data-highlighted):(?:border|shadow|outline|text|decoration|held)(?:-|\b)/u,
    where: () => true,
  },
  // One line per element: each line utility draws its element's one ::after, so a second hides the
  // first. Lines above and below take two elements, as a widget in chat does.
  {
    name: "two lines on one element",
    re: /\bline-(?:1|2|section)-[tblr]\b[^"`]*\bline-(?:1|2|section)-[tblr]\b/u,
    where: (p) => !p.endsWith("index.css"),
  },
  // One Button: a raw <button> is a press with its own look.
  { name: "raw <button>", re: /<button\b/u, where: (p) => !p.endsWith("ui/kit/button.tsx") },
  // Motion: almost none.
  {
    name: "motion",
    re: /\btransition(?:-[a-z]+)?\b(?!:\s*none)|\banimate-[a-z]|\bduration-\d|@keyframes|\banimation\b/u,
    where: (p) => !p.endsWith(".ts") || p.endsWith(".tsx"),
  },
]

const broken: string[] = []
for await (const path of new Glob(`${ROOT}/**/*.{ts,tsx,css}`).scan(".")) {
  const text = await Bun.file(path).text()
  const lines = text.split("\n")
  for (const [n, line] of lines.entries()) {
    // Comments say what's not done; they're no break.
    if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) {
      continue
    }
    for (const rule of RULES) {
      if (rule.where(path) && rule.re.test(line) && !allowed(path, line)) {
        broken.push(`${path}:${n + 1}: ${rule.name}: ${line.trim()}`)
      }
    }
  }
}
if (broken.length > 0) {
  console.error(broken.join("\n"))
  console.error(
    `\n${broken.length} break(s) of the look (apps/desktop-gpui/DESIGN.md; scripts/ui-look.allow)`,
  )
  process.exit(1)
}
