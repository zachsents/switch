// The lines' inks, browser-safe. Each top-level space is a line with its own ink, for day and night
// appearance: its own when it has one, else the next one free here, in the order lines were made.

export interface Ink {
  readonly day: string
  readonly night: string
}

export const LINE_INKS: readonly Ink[] = [
  { day: "#009BBF", night: "#009BBF" },
  { day: "#9C5E31", night: "#B9794A" },
  { day: "#8F76D6", night: "#8F76D6" },
  { day: "#3A53A4", night: "#6F86D6" },
  { day: "#00A497", night: "#00A497" },
  { day: "#8E9BA6", night: "#9AA7B2" },
  { day: "#5B7C99", night: "#7D9AB6" },
  { day: "#9E6A86", night: "#9E6A86" },
]

const FALLBACK: Ink = { day: "#8E9BA6", night: "#9AA7B2" }

interface Line {
  readonly id: string
  /** Its place in the order spaces were made. */
  readonly made: number
  readonly ink: Ink | null
}

/** Each line's ink: its own, else the next one free. */
export const lineInks = (lines: readonly Line[]): ReadonlyMap<string, Ink> => {
  const sorted = lines.toSorted((a, b) => a.made - b.made)
  const taken = new Set<number>()
  const out = new Map<string, Ink>()
  for (const l of sorted) {
    if (l.ink !== null) {
      out.set(l.id, l.ink)
      const day = l.ink.day.toLowerCase()
      const i = LINE_INKS.findIndex((x) => x.day.toLowerCase() === day)
      if (i !== -1) {
        taken.add(i)
      }
    }
  }
  for (const l of sorted) {
    if (!out.has(l.id)) {
      const free = LINE_INKS.findIndex((_, i) => !taken.has(i))
      const i = free === -1 ? l.made % LINE_INKS.length : free
      taken.add(i)
      out.set(l.id, LINE_INKS[i] ?? FALLBACK)
    }
  }
  return out
}
