// What a bubble offers under the pointer, beside it on its open side: when it was said, by which
// model, and Copy.
// Nothing of it shows at rest; it takes no room. And its tapbacks, the menu a double-click off its
// words or a right-click opens.
import { Popover } from "@base-ui/react/popover"
import { useMutation } from "@tanstack/react-query"
import type { RefObject } from "react"
import { useRef } from "react"

import { reactMutation } from "../brain/mutations.ts"
import { isTapback, REACTIONS } from "@switch/brain/commands"
import type { Reaction } from "@switch/brain/commands"
import { Button } from "./kit/button.tsx"
import { FLOAT } from "./kit/float.ts"
import { EmojiSearch, useEmojiSearch } from "./emoji-search.tsx"
import { Glyph, nameOf } from "./tapback.tsx"
import { stampOf, whenOf } from "./time.ts"
import { useCopy } from "./use-copy.ts"

const CopyMark = ({ copied }: { copied: boolean }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    aria-hidden
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {copied ? (
      <path d="M3 8l3 3 7-7" />
    ) : (
      <>
        <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
        <path d="M10.5 3.5v-1h-8v8h1" />
      </>
    )}
  </svg>
)

/** The six tapbacks over the bubble, and any emoji by the search under them, focused as it opens;
 * the one chosen is pressed, and choosing it again takes it back. Opened from the bubble, so it has
 * no key of its own. */
export const Tapbacks = ({
  seq,
  mine,
  bubble,
  open,
  onOpenChange,
}: {
  seq: number
  /** The user's reaction on it now. */
  mine: Reaction | undefined
  bubble: RefObject<HTMLDivElement | null>
  open: boolean
  onOpenChange: (open: boolean) => void
}) => {
  const react = useMutation(reactMutation)
  const search = useEmojiSearch()
  const field = useRef<HTMLInputElement>(null)
  const pick = (reaction: Reaction) => {
    react.mutate({ seq, reaction, ...(mine !== undefined && { was: mine }) })
    onOpenChange(false)
  }
  const row = (
    <>
      {REACTIONS.map((r) => (
        <Button
          key={r}
          look="flat"
          aria-label={nameOf(r)}
          aria-pressed={mine === r}
          onClick={() => {
            pick(r)
          }}
          className="size-8! rounded-full! p-0! outline-none! aria-pressed:held"
        >
          <Glyph reaction={r} />
        </Button>
      ))}
      {mine !== undefined && !isTapback(mine) && (
        <Button
          look="flat"
          aria-label={mine}
          aria-pressed
          onClick={() => {
            pick(mine)
          }}
          className="size-8! rounded-full! p-0! outline-none! aria-pressed:held"
        >
          <Glyph reaction={mine} />
        </Button>
      )}
    </>
  )
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next, details) => {
        // Esc clears what's typed first.
        if (!next && details.reason === "escape-key" && search.typed) {
          search.clear()
          return
        }
        if (!next) {
          search.clear()
        }
        onOpenChange(next)
      }}
    >
      <Popover.Portal>
        <Popover.Positioner anchor={bubble} side="top" sideOffset={6}>
          <Popover.Popup initialFocus={field} className={`${FLOAT} p-1`}>
            <EmojiSearch form={search.form} row={row} onPick={pick} field={field} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

export const SaidBar = ({
  time,
  model,
  text,
  right,
  className,
}: {
  time: number
  /** The display name of the model that wrote it. */
  model: string | undefined
  text: string
  /** The bubble is on the right: the bar goes to its left. */
  right: boolean
  /** When it shows. */
  className: string
}) => {
  const { copy, copied } = useCopy()
  return (
    // The bubble's whole height, the gap beside it and a margin past Copy: the pointer crossing from
    // the bubble to Copy, straight or slanting, or overshooting it, never leaves it.
    <div
      className={`absolute inset-y-0 flex items-end ${right ? "right-full pr-1.5 pl-7" : "left-full pl-1.5 pr-7"} ${className}`}
    >
      <div
        className={`flex h-7 items-center gap-1 text-caption whitespace-nowrap text-ink2 tabular-nums ${right ? "flex-row-reverse" : ""}`}
      >
        <span className="px-1" title={whenOf(time)}>
          {stampOf(time)}
        </span>
        {model !== undefined && <span className="px-1">{model}</span>}
        <Button
          look="flat"
          aria-label="Copy"
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            copy(text)
          }}
          className="size-7! p-1.5!"
        >
          <CopyMark copied={copied} />
          <output className="sr-only">{copied ? "Copied" : ""}</output>
        </Button>
      </div>
    </div>
  )
}
