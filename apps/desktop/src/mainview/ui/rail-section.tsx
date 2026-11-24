// A section of the rail: its heading a line tall in small capitals (its mark where the rows' rings
// are, its name where their words start, its count at the end where their times are), then its
// rows with a hairline over each, the first too. Its hierarchy is the section line above it, the
// capitals and the alignment, not height.
import type { ReactNode } from "react"

const HEADING =
  "m-0 flex h-line w-full flex-none items-center gap-[9px] px-[14px] text-caption font-semibold tracking-[0.06em] text-ink2 uppercase"

export const RailSection = ({
  mark,
  label,
  count,
  children,
}: {
  mark?: ReactNode
  label: string
  count: number
  children: ReactNode
}) => (
  <section className="flex flex-col">
    <h2 className={HEADING}>
      <span className="flex w-[18px] flex-none justify-center">{mark}</span>
      <span className="trim min-w-0 truncate">{label}</span>
      {count > 0 && (
        <span className="trim ml-auto font-normal tracking-normal tabular-nums text-ink3">
          {count}
        </span>
      )}
    </h2>
    <ul className="m-0 flex list-none flex-col p-0">{children}</ul>
  </section>
)
