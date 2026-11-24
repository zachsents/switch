// A page the agent made (the core's gateway/src/page.ts) in this window's theme: its theme style's
// variables, Switch's tokens, are put in from what this window paints, resolved for the appearance
// it shows, so the page's colors are the window's own. A theme or appearance changed: the pages
// shown again in the new one.
import { appearanceNow, onTheme } from "../ui/theme.ts"

/** The style a page keeps its theme in (THEME_ID in the core). */
const THEME = /<style id="switch-theme">[^<]*<\/style>/u

const COLORS = [
  "bg",
  "line-1",
  "line-2",
  "ink",
  "ink2",
  "ink3",
  "go",
  "yellow",
  "orange",
  "red",
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `series-${n}`),
]
const FONTS = ["sans", "mono", "sign"]

/** This window's theme as a page's theme style. */
const themeCss = () => {
  const probe = document.createElement("span")
  probe.hidden = true
  document.documentElement.append(probe)
  const colors = COLORS.map((name) => {
    probe.style.color = `var(--color-${name})`
    return `--color-${name}:${getComputedStyle(probe).color};`
  })
  probe.remove()
  const root = getComputedStyle(document.documentElement)
  const fonts = FONTS.map((name) => `--font-${name}:${root.getPropertyValue(`--font-${name}`)};`)
  return `<style id="switch-theme">:root{color-scheme:${appearanceNow()};${[...colors, ...fonts].join("")}}</style>`
}

/** A page with this window's theme in place of the one it carries; anything else as it is. */
export const themed = (page: string) => {
  if (!THEME.test(page)) {
    return page
  }
  const css = themeCss()
  return page.replace(THEME, () => css)
}

/** Calls `again` whenever this window's theme or the system's appearance changes. */
export const onPageTheme = (again: () => void) => {
  const system = matchMedia("(prefers-color-scheme: dark)")
  const stop = onTheme(again)
  system.addEventListener("change", again)
  return () => {
    stop()
    system.removeEventListener("change", again)
  }
}
