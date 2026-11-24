// The theme: the appearance, the one background (one color per appearance), the three lines (a
// color per appearance and a thickness each), what each state color means (go, needs you, running,
// danger), and the text size. The words' inks and a key's edges are worked out from
// the background, each kept readable on it. Kept in the brain (`pref theme`, for every client) and on
// this Mac (so a window paints it on its first frame); a change shows in every window at once.
import { Schema } from "effect"
import { useSyncExternalStore } from "react"

const hex = Schema.String.check(Schema.isPattern(/^#[0-9a-f]{6}$/u))
const pair = Schema.Struct({ light: hex, dark: hex })
const line = Schema.Struct({ light: hex, dark: hex, w: Schema.Literals([0.5, 1, 2]) })

export const ThemeSchema = Schema.Struct({
  appearance: Schema.Literals(["system", "light", "dark"]),
  bg: pair,
  /** Between the panes and under the band. */
  line1: line,
  /** Between a rail's sections and between widgets; a theme without it has it worked out. */
  section: Schema.optionalKey(line),
  /** Between rows, and between the chat and its box. */
  line2: line,
  go: hex,
  needs: hex,
  running: hex,
  danger: hex,
  size: Schema.Literals(["small", "default", "large"]),
})
export type Theme = typeof ThemeSchema.Type

const STATES = { go: "#1f8a5e", needs: "#ffc000", running: "#f26419", danger: "#d42a1f" } as const

export const PRESETS = {
  default: {
    appearance: "system",
    bg: { light: "#ffffff", dark: "#0d0d0d" },
    line1: { light: "#c8c8c8", dark: "#2c2c2c", w: 1 },
    line2: { light: "#e8e8e8", dark: "#1c1c1c", w: 0.5 },
    ...STATES,
    size: "default",
  },
  light: {
    appearance: "light",
    bg: { light: "#fbfbfa", dark: "#0d0d0d" },
    line1: { light: "#bdbdbd", dark: "#2c2c2c", w: 1 },
    line2: { light: "#e6e6e4", dark: "#1c1c1c", w: 0.5 },
    ...STATES,
    size: "default",
  },
  paper: {
    appearance: "light",
    bg: { light: "#f3eee3", dark: "#1b1915" },
    line1: { light: "#c9bfa9", dark: "#3a352b", w: 1 },
    line2: { light: "#e3dccc", dark: "#27241e", w: 0.5 },
    go: "#2f7d4f",
    needs: "#e0a100",
    running: "#d1561c",
    danger: "#b3261e",
    size: "default",
  },
  contrast: {
    appearance: "dark",
    bg: { light: "#ffffff", dark: "#000000" },
    line1: { light: "#000000", dark: "#ffffff", w: 1 },
    line2: { light: "#767676", dark: "#8a8a8a", w: 1 },
    go: "#00a86b",
    needs: "#ffd400",
    running: "#ff7a1a",
    danger: "#ff3b30",
    size: "large",
  },
  slate: {
    appearance: "dark",
    bg: { light: "#f4f6f8", dark: "#11161c" },
    line1: { light: "#c3cbd3", dark: "#2a3440", w: 1 },
    line2: { light: "#e1e6eb", dark: "#1b232c", w: 0.5 },
    ...STATES,
    size: "default",
  },
} as const satisfies Record<string, Theme>

export type Preset = keyof typeof PRESETS
export const PRESET_KEYS = [
  "default",
  "light",
  "paper",
  "contrast",
  "slate",
] as const satisfies readonly Preset[]
export const PRESET_NAMES: Record<Preset, string> = {
  default: "Default",
  light: "Light",
  paper: "Paper",
  contrast: "Contrast",
  slate: "Slate",
}

/** The preset the theme is, if it's one. */
export const presetOf = (t: Theme): Preset | null =>
  PRESET_KEYS.find((k) => JSON.stringify(PRESETS[k]) === JSON.stringify(t)) ?? null

// ---- Colors

const rgb = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16))
const toHex = (c: readonly number[]) =>
  `#${c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`

/** `a` moved `t` of the way to `b`. */
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)]
  return toHex(x.map((v, i) => v + ((y[i] ?? 0) - v) * t))
}

const luminance = (h: string) => {
  const [r = 0, g = 0, b = 0] = rgb(h).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast of two colors, 1 to 21. */
export const contrast = (a: string, b: string) => {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The words' three inks on a background: full, supporting and meta, each at least its contrast. */
const inks = (bg: string) => {
  const ink = luminance(bg) > 0.18 ? "#0a0a0a" : "#ededed"
  // As far toward the background as the ink may go and still read at `least`.
  const toward = (least: number) => {
    let best = ink
    for (let t = 0; t <= 0.9; t += 0.02) {
      const c = mix(ink, bg, t)
      if (contrast(c, bg) >= least) {
        best = c
      }
    }
    return best
  }
  return { ink, ink2: toward(7), ink3: toward(4.5) }
}

/** A raised key's edges on a background: its border, the light along its top, the drop under it. */
const keyEdges = (bg: string) => {
  const dark = luminance(bg) <= 0.18
  return {
    border: mix(bg, dark ? "#ffffff" : "#000000", dark ? 0.22 : 0.42),
    light: mix(bg, "#ffffff", dark ? 0.16 : 1),
    drop: mix(bg, "#000000", dark ? 1 : 0.32),
  }
}

const both = (light: string, dark: string) => `light-dark(${light}, ${dark})`

/** The section line: the theme's own, else halfway between the other two in color, at most 1 wide. */
export const sectionOf = (t: Theme) =>
  t.section ?? {
    light: mix(t.line1.light, t.line2.light, 0.5),
    dark: mix(t.line1.dark, t.line2.dark, 0.5),
    w: t.line1.w === 2 ? 1 : t.line1.w,
  }

/** How much text and everything with it are scaled. */
export const ZOOM = { small: 0.9, default: 1, large: 1.15 } as const

/** The theme as the CSS variables the tokens read. */
export const varsOf = (t: Theme): Record<string, string> => {
  const [il, id] = [inks(t.bg.light), inks(t.bg.dark)]
  const [kl, kd] = [keyEdges(t.bg.light), keyEdges(t.bg.dark)]
  const section = sectionOf(t)
  return {
    "color-scheme": t.appearance === "system" ? "light dark" : t.appearance,
    "--color-bg": both(t.bg.light, t.bg.dark),
    "--color-line-1": both(t.line1.light, t.line1.dark),
    "--color-line-section": both(section.light, section.dark),
    "--color-line-2": both(t.line2.light, t.line2.dark),
    "--line-1": `${t.line1.w}px`,
    "--line-section": `${section.w}px`,
    "--line-2": `${t.line2.w}px`,
    "--color-ink": both(il.ink, id.ink),
    "--color-ink2": both(il.ink2, id.ink2),
    "--color-ink3": both(il.ink3, id.ink3),
    // The agent's bubble: iMessage's gray, a little of the ink in the background.
    "--color-bubble": both(mix(t.bg.light, il.ink, 0.09), mix(t.bg.dark, id.ink, 0.12)),
    "--color-key-border": both(kl.border, kd.border),
    "--color-key-light": both(kl.light, kd.light),
    "--color-key-drop": both(kl.drop, kd.drop),
    "--color-go": t.go,
    "--color-go-press": mix(t.go, "#000000", 0.2),
    "--color-go-border": mix(t.go, "#000000", 0.45),
    "--color-go-drop": mix(t.go, "#000000", 0.6),
    "--color-yellow": t.needs,
    "--color-orange": t.running,
    "--color-red": t.danger,
  }
}

// ---- Held and shown

/** A copy of the brain's theme pref, to paint the first frame before the brain's comes. */
const KEY = "switch.theme"
const decode = Schema.decodeUnknownOption(Schema.fromJsonString(ThemeSchema))

const load = (): Theme => {
  const got = decode(localStorage.getItem(KEY) ?? "")
  return got._tag === "Some" ? got.value : PRESETS.default
}

let current = load()
/** Counts changes that came from elsewhere (another window, the brain): a form showing the theme
 * starts again from them. */
let outside = 0
const listeners = new Set<() => void>()

/** Paints the theme on this window's root. */
const paint = (t: Theme) => {
  const root = document.documentElement
  for (const [k, v] of Object.entries(varsOf(t))) {
    root.style.setProperty(k, v)
  }
  for (const l of listeners) {
    l()
  }
}

/** The theme on this window: painted before the first frame. */
export const startTheme = () => {
  paint(current)
  // Another window (Settings) changed it: here too, at once.
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      current = load()
      outside += 1
      paint(current)
    }
  })
}

/** Shows a theme in every window, copied for the next first frame; the brain is told by its caller. */
export const showTheme = (t: Theme, fromOutside = false) => {
  if (JSON.stringify(t) === JSON.stringify(current)) {
    return
  }
  current = t
  if (fromOutside) {
    outside += 1
  }
  localStorage.setItem(KEY, JSON.stringify(t))
  paint(t)
}

/** A theme as the brain holds it, if it's one. */
export const themeOf = (v: unknown): Theme | null => {
  const got = decode(JSON.stringify(v ?? null))
  return got._tag === "Some" ? got.value : null
}

/** How many times the theme changed from elsewhere. */
export const useOutside = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => outside,
  )

/** Calls `listener` whenever the theme on this window changes; returns how to stop. */
export const onTheme = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The appearance this window shows now: the theme's, else the system's. */
export const appearanceNow = (): "light" | "dark" => {
  if (current.appearance !== "system") {
    return current.appearance
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

export const useTheme = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    () => current,
  )
