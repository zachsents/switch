// What happened rather than what was said, in a chat: one centred line, a mark and a few words.
// A click opens the whole of it, when, and what can be done about it (Undo).
import { Popover } from "@base-ui/react/popover"
import type { ReactNode } from "react"

import { buttonLook } from "./kit/button.tsx"
import { FLOAT } from "./kit/float.ts"
import { whenOf } from "./time.ts"

/** The blips' marks, drawn alike: 12 px, one stroke. */
const MARKS = {
  /** An app's outcome. */
  event: <path d="M7 1.5L3 7h3l-1 3.5L9 5H6z" />,
  /** A memory. */
  learned: <path d="M3 1.5h6v9L6 8.5 3 10.5z" />,
} as const

export type BlipMark = keyof typeof MARKS

const Mark = ({ mark }: { mark: BlipMark }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 12 12"
    aria-hidden
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="flex-none"
  >
    {MARKS[mark]}
  </svg>
)

export const Blip = ({
  mark,
  children,
  whole,
  time,
  actions,
}: {
  mark: BlipMark
  /** Its few words. */
  children: ReactNode
  /** The whole of it, opened. */
  whole: ReactNode
  time?: number | undefined
  /** What can be done about it, opened. */
  actions?: ReactNode
}) => (
  <Popover.Root>
    <Popover.Trigger
      className={buttonLook(
        "flat",
        "max-w-[min(100%,360px)] self-center rounded-full! px-2.5! text-ink2",
      )}
    >
      <Mark mark={mark} />
      <span className="trim min-w-0 truncate">{children}</span>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" sideOffset={4}>
        <Popover.Popup
          className={`${FLOAT} flex w-[320px] flex-col gap-2 p-inset text-small text-ink`}
        >
          <div className="selectable wrap-break-word">{whole}</div>
          {(time !== undefined || actions !== undefined) && (
            <div className="flex items-center gap-2 text-ink2">
              {time !== undefined && <span className="tabular-nums">{whenOf(time)}</span>}
              <span className="ml-auto flex items-center gap-1">{actions}</span>
            </div>
          )}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
)

/** A blip's few words: its text's first clause, up to about forty characters. */
export const gist = (text: string) => {
  const [first = text] = text.split(/(?<=[.;:])\s|\s[–—]\s/u)
  const clause = first.replace(/[.;:,]$/u, "")
  return clause.length > 44 ? `${clause.slice(0, 42).replace(/\s\S*$/u, "")}…` : clause
}
