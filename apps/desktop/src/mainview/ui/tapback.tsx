// iMessage's tapbacks: the six reactions, each in its own color as iMessage draws them now, or any
// emoji; their badges on a bubble's top corner, and the row to choose one from. A badge is the
// agent's bubble's gray, the user's ringed in their ink.
import type { ReactNode } from "react"

import { isTapback } from "@switch/brain/commands"
import type { Reaction, Reactions, Tapback } from "@switch/brain/commands"

const WORD = { fontWeight: 800, fontFamily: "var(--font-sans)", textAnchor: "middle" } as const

const GLYPHS: Record<Tapback, ReactNode> = {
  love: (
    <path d="M8 13.6S2.4 10.3 2.4 6.5C2.4 4.4 3.9 3 5.7 3c1 0 1.8.5 2.3 1.3C8.5 3.5 9.3 3 10.3 3c1.8 0 3.3 1.4 3.3 3.5 0 3.8-5.6 7.1-5.6 7.1z" />
  ),
  like: (
    <path d="M2.2 7.2h2.3v6.6H2.2zM5.6 13.8h5.6c.8 0 1.4-.5 1.6-1.3l1-4.1c.2-.9-.5-1.7-1.4-1.7H9.6l.5-2.4c.2-.9-.5-1.8-1.4-1.8L5.6 6.8z" />
  ),
  dislike: (
    <path
      transform="rotate(180 8 8)"
      d="M2.2 7.2h2.3v6.6H2.2zM5.6 13.8h5.6c.8 0 1.4-.5 1.6-1.3l1-4.1c.2-.9-.5-1.7-1.4-1.7H9.6l.5-2.4c.2-.9-.5-1.8-1.4-1.8L5.6 6.8z"
    />
  ),
  laugh: (
    <>
      <text x="8" y="7.4" fontSize="6.4" style={WORD}>
        HA
      </text>
      <text x="8" y="13.6" fontSize="6.4" style={WORD}>
        HA
      </text>
    </>
  ),
  emphasize: (
    <text x="8" y="13" fontSize="12" style={WORD}>
      !!
    </text>
  ),
  question: (
    <text x="8" y="13" fontSize="12" style={WORD}>
      ?
    </text>
  ),
}

/** Each tapback's color, iMessage's (index.css). */
const colorOf = (t: Tapback) => `var(--color-tapback-${t})`

const TAPBACK_NAMES: Record<Tapback, string> = {
  love: "Love",
  like: "Like",
  dislike: "Dislike",
  laugh: "Haha",
  emphasize: "Emphasize",
  question: "Question",
}

/** A reaction's name: a tapback's, or the emoji itself. */
export const nameOf = (r: Reaction) => (isTapback(r) ? TAPBACK_NAMES[r] : r)

/** A reaction drawn: a tapback's glyph in its color, or the emoji. */
export const Glyph = ({ reaction, size = 16 }: { reaction: Reaction; size?: number }) =>
  isTapback(reaction) ? (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden
      fill="currentColor"
      style={{ color: colorOf(reaction) }}
    >
      {GLYPHS[reaction]}
    </svg>
  ) : (
    <span aria-hidden className="leading-none" style={{ fontSize: size }}>
      {reaction}
    </span>
  )

/** A reaction on a bubble: a round badge ringed in the background, on its top corner. */
export const Badge = ({
  reaction,
  mine,
  ink,
  small = false,
}: {
  reaction: Reaction
  mine: boolean
  ink: string
  /** At the end of words reacted to, not on the bubble's corner. */
  small?: boolean
}) => (
  <span
    title={nameOf(reaction)}
    className={`flex items-center justify-center rounded-full bg-bubble ${small ? "size-5" : "size-7"} ${mine ? "" : "ring-2 ring-bg"}`}
    style={mine ? { boxShadow: `0 0 0 2px ${ink}` } : undefined}
  >
    <Glyph reaction={reaction} size={small ? 11 : 14} />
    <span className="sr-only">{nameOf(reaction)}</span>
  </span>
)

/** The reactions on a bubble, on its top corner away from its side. */
export const Badges = ({
  reactions,
  right,
  ink,
}: {
  reactions: Reactions
  /** The bubble is the user's. */
  right: boolean
  ink: string
}) => (
  <span
    className={`absolute -top-4 flex gap-0.5 ${right ? "-left-3.5 flex-row-reverse" : "-right-3.5"}`}
  >
    {reactions.agent !== undefined && <Badge reaction={reactions.agent} mine={false} ink={ink} />}
    {reactions.user !== undefined && <Badge reaction={reactions.user} mine ink={ink} />}
  </span>
)
