// What floats over a chart under the pointer, as what floats does: what the values are at, then each
// value first and strong, keyed by a short line of its color, its name and what else it is after it.
import { FLOAT } from "../../ui/kit/float.ts"
import { Key } from "./key.tsx"

export interface TipRow {
  readonly value: string
  readonly name: string
  readonly color: string
  /** What else it is, after its name: a slice's share. */
  readonly note?: string
}

export interface TipRead {
  /** What the values are at: a label, a range, a day. */
  readonly title: string
  readonly rows: readonly TipRow[]
}

export const TipBox = ({ title, rows }: TipRead) => (
  <div className={`${FLOAT} flex flex-col gap-1 px-2 py-1`}>
    {title !== "" && <span className="text-caption whitespace-nowrap text-ink3">{title}</span>}
    {rows.length > 0 && (
      <span className="grid grid-cols-[auto_auto_auto_auto] items-center gap-x-1.5 gap-y-1">
        {rows.map((r) => (
          <span key={`${r.name}-${r.color}-${r.value}`} className="contents">
            <Key kind="line" color={r.color} />
            <span className="text-right text-small font-semibold whitespace-nowrap text-ink tabular-nums">
              {r.value}
            </span>
            <span className="text-small whitespace-nowrap text-ink2">{r.name}</span>
            <span className="text-small whitespace-nowrap text-ink3 tabular-nums">{r.note}</span>
          </span>
        ))}
      </span>
    )}
  </div>
)
