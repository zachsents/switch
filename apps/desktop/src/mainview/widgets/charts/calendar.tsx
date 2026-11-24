// Weeks as columns of seven days, Sunday on top, each day a square darker for more (the one-hue
// scale's five steps from zero to the most); a day with nothing, or none, in line-2. Each month over
// the week it starts in; under the weeks the scale, zero to the most. The pointer shows a day, its
// square ringed.
import { useState } from "react"

import { SCALE } from "./data.ts"
import type { Figures } from "./figures.ts"
import { figure } from "./figures.ts"
import { Key } from "./key.tsx"
import { TipBox } from "./tip-box.tsx"

/** A day with nothing. */
const EMPTY = "var(--color-line-2)"
/** A day's square at most, and the gap of the background between squares. */
const SQUARE = 12
const GAP = 2
/** Months named at least this many weeks apart, so their names don't run together. */
const APART = 4
/** The rows a day's tooltip opens under rather than over, having no room above them. */
const LOW = 3

interface Cell {
  readonly day: Temporal.PlainDate
  readonly value: number | null
  readonly color: string
  readonly col: number
  readonly row: number
}

interface Hover {
  readonly cell: Cell
  readonly x: number
  readonly y: number
  readonly align: "start" | "center" | "end"
}

/** Where a tooltip sits along from the square it's for. */
const SHIFT = { start: "-6px", center: "-50%", end: "calc(-100% + 6px)" } as const

const colorOf = (value: number | null, most: number) =>
  value === null || value <= 0 || most <= 0
    ? EMPTY
    : (SCALE[Math.min(SCALE.length - 1, Math.ceil((value / most) * SCALE.length) - 1)] ?? EMPTY)

/** The month a week starts, over it, unless too near the one before. */
const monthsOf = (cells: readonly Cell[], weeks: number) => {
  const starts = cells.filter((c, i) => i === 0 || c.day.day === 1)
  const months: { readonly col: number; readonly text: string }[] = []
  for (const [i, c] of starts.entries()) {
    const next = starts[i + 1]
    const crowdedFirst = i === 0 && next !== undefined && next.col - c.col < APART
    const crowded = months.length > 0 && c.col - (months.at(-1)?.col ?? 0) < APART
    if (!crowdedFirst && !crowded && c.col <= weeks - 2) {
      months.push({ col: c.col, text: c.day.toLocaleString(undefined, { month: "short" }) })
    }
  }
  return months
}

export const Calendar = ({
  days,
  fig,
}: {
  days: ReadonlyMap<string, { readonly day: Temporal.PlainDate; readonly value: number }>
  fig: Figures
}) => {
  const [hover, setHover] = useState<Hover | null>(null)
  const sorted = [...days.values()].toSorted((a, b) => Temporal.PlainDate.compare(a.day, b.day))
  const [first] = sorted
  const last = sorted.at(-1)
  if (!first || !last) {
    return null
  }
  let most = 0
  for (const d of sorted) {
    most = Math.max(most, d.value)
  }
  const start = first.day.subtract({ days: first.day.dayOfWeek % 7 })
  const from = start.until(first.day).days
  const to = start.until(last.day).days
  const cells = Array.from({ length: to - from + 1 }, (_, k): Cell => {
    const i = from + k
    const day = start.add({ days: i })
    const value = days.get(day.toString())?.value ?? null
    return { day, value, color: colorOf(value, most), col: Math.floor(i / 7), row: i % 7 }
  })
  const weeks = Math.floor(to / 7) + 1
  const shown = hover?.cell
  return (
    <div
      className="relative px-inset py-2"
      onPointerLeave={() => {
        setHover(null)
      }}
    >
      <div className="flex w-fit max-w-full flex-col">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${weeks}, minmax(0, ${SQUARE}px))`,
            gap: GAP,
          }}
        >
          {monthsOf(cells, weeks).map((m) => (
            <span
              key={`${m.col}-${m.text}`}
              className="trim pb-1 text-caption whitespace-nowrap text-ink3"
              style={{ gridColumn: m.col + 1, gridRow: 1 }}
            >
              {m.text}
            </span>
          ))}
          {cells.map((c) => (
            <span
              key={c.day.toString()}
              className={`block rounded-[2px] ${shown?.day.equals(c.day) === true ? "focused" : ""}`}
              style={{ gridColumn: c.col + 1, gridRow: c.row + 2 }}
              onPointerEnter={(e) => {
                const el = e.currentTarget
                const width = el.offsetParent?.clientWidth ?? 0
                const x = el.offsetLeft + el.offsetWidth / 2
                let align: Hover["align"] = "center"
                if (x < 64) {
                  align = "start"
                } else if (x > width - 64) {
                  align = "end"
                }
                setHover({
                  cell: c,
                  x,
                  y: c.row < LOW ? el.offsetTop + el.offsetHeight + 4 : el.offsetTop - 4,
                  align,
                })
              }}
            >
              <svg aria-hidden viewBox="0 0 10 10" className="block aspect-square w-full">
                <rect width={10} height={10} rx={2} fill={c.color} />
              </svg>
            </span>
          ))}
        </div>
        {most > 0 && (
          <div className="flex items-center justify-end gap-1 pt-2 text-caption text-ink3 tabular-nums">
            <span className="trim pr-1">{figure(0, fig)}</span>
            {[EMPTY, ...SCALE].map((c) => (
              <Key key={c} kind="square" color={c} />
            ))}
            <span className="trim pl-1">{figure(most, fig)}</span>
          </div>
        )}
      </div>
      {hover && shown && (
        <div
          className="pointer-events-none absolute z-10"
          style={{
            left: hover.x,
            top: hover.y,
            transform: `translate(${SHIFT[hover.align]}, ${shown.row < LOW ? "0" : "-100%"})`,
          }}
        >
          <TipBox
            title={shown.day.toLocaleString(undefined, {
              weekday: "short",
              month: "short",
              day: "numeric",
              year: "numeric",
            })}
            rows={
              shown.value === null
                ? []
                : [{ value: figure(shown.value, fig), name: "", color: shown.color }]
            }
          />
        </div>
      )}
    </div>
  )
}
