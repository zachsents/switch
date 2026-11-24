// Ink means who: each top-level space is a line (Tokyo Metro) with its own ink, and every space
// under it a station on that line ("K08"). A line takes its space's own ink when it has one, else
// the next free ink in the palette.
import type { SpaceId } from "@switch/brain"
import { HOME } from "@switch/brain/commands"
import type { SpaceRow, State } from "../brain/store.ts"

interface Ink {
  readonly day: string
  readonly night: string
}

const LINES: readonly Ink[] = [
  { day: "#009BBF", night: "#009BBF" },
  { day: "#9C5E31", night: "#B9794A" },
  { day: "#8F76D6", night: "#8F76D6" },
  { day: "#3A53A4", night: "#6F86D6" },
  { day: "#00A497", night: "#00A497" },
  { day: "#8E9BA6", night: "#9AA7B2" },
  { day: "#5B7C99", night: "#7D9AB6" },
  { day: "#9E6A86", night: "#9E6A86" },
]

export interface Station {
  /** "K", "K03"; empty for Home. */
  readonly code: string
  /** A CSS color that follows the appearance. */
  readonly ink: string
}

const css = (ink: Ink) => `light-dark(${ink.day}, ${ink.night})`

/** The grey of a space on no line: Home's station. */
export const GREY = "var(--color-ink3)"

const top = (s: State, x: SpaceRow): SpaceRow => {
  let at = x
  const seen = new Set<string>()
  while (at.parent !== null && at.parent !== HOME && !seen.has(at.id)) {
    seen.add(at.id)
    const up = s.spaces.get(at.parent)
    if (!up) {
      break
    }
    at = up
  }
  return at
}

/** Stations by the spaces they were drawn from: the state is immutable, so a new map is new spaces. */
const cache = new WeakMap<State["spaces"], Map<string, Station>>()

const FALLBACK: Ink = { day: "#8E9BA6", night: "#9AA7B2" }

const lineAt = (i: number): Ink => LINES[i] ?? FALLBACK

/** Each line's ink: its own, else the next one free. */
const inks = (lines: readonly SpaceRow[]) => {
  const taken = new Set<number>()
  const out = new Map<string, Ink>()
  for (const l of lines) {
    if (l.ink !== null) {
      out.set(l.id, l.ink)
      const i = LINES.findIndex((x) => x.day.toLowerCase() === l.ink?.day.toLowerCase())
      if (i !== -1) {
        taken.add(i)
      }
    }
  }
  for (const l of lines) {
    if (!out.has(l.id)) {
      const free = LINES.findIndex((_, i) => !taken.has(i))
      const i = free === -1 ? l.made % LINES.length : free
      taken.add(i)
      out.set(l.id, lineAt(i))
    }
  }
  return out
}

/** A line's letter: its name's first, or its first two where that's taken ("Pl"). */
const letter = (name: string, used: Set<string>) => {
  const letters = name.replaceAll(/[^A-Za-z]/gu, "")
  const first = (letters[0] ?? "S").toUpperCase()
  const code = used.has(first) ? first + (letters[1] ?? "").toLowerCase() : first
  used.add(code)
  return code
}

const build = (s: State) => {
  const map = new Map<string, Station>()
  const lines = [...s.spaces.values()]
    .filter((x) => x.parent === HOME)
    .toSorted((a, b) => a.made - b.made)
  const inkOf = inks(lines)
  const used = new Set<string>()
  for (const l of lines) {
    map.set(l.id, { code: letter(l.name, used), ink: css(inkOf.get(l.id) ?? FALLBACK) })
  }
  // Stations: numbered in the order they were made, under their own parent.
  const rest = [...s.spaces.values()]
    .filter((x) => x.parent !== null && x.parent !== HOME)
    .toSorted((a, b) => a.made - b.made)
  const counts = new Map<string, number>()
  for (const x of rest) {
    const line = map.get(top(s, x).id)
    const parent = x.parent ?? ""
    const n = (counts.get(parent) ?? 0) + 1
    counts.set(parent, n)
    map.set(x.id, {
      code: `${(line?.code ?? "").replaceAll(/\d/gu, "")}${String(n).padStart(2, "0")}`,
      ink: line?.ink ?? GREY,
    })
  }
  return map
}

const stations = (s: State) => {
  const held = cache.get(s.spaces)
  if (held) {
    return held
  }
  const made = build(s)
  cache.set(s.spaces, made)
  return made
}

export const station = (s: State, id: SpaceId): Station =>
  stations(s).get(id) ?? { code: "", ink: GREY }
