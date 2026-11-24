// A reaction menu's search: a small field under its tapbacks; what's typed finds emoji by meaning
// (emoji-find.ts), and they take the tapbacks' place until it's cleared. Arrows move through them,
// Enter picks the one lit (the first until moved); Esc clears it, then closes the menu (its owner,
// by `typed`).
import type { Emoji } from "@switch/brain/commands"
import { useForm, useSelector } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import type { ReactNode, Ref } from "react"
import { useState } from "react"

import { emojiQuery, findEmoji } from "./emoji-find.ts"
import { Button } from "./kit/button.tsx"

/** As many as the six tapbacks' row holds. */
const MOST = 6

export const useEmojiSearch = () => {
  const form = useForm({ defaultValues: { query: "" } })
  const typed = useSelector(form.store, (f) => f.values.query).trim() !== ""
  return {
    form,
    typed,
    clear: () => {
      form.reset()
    },
  }
}

export type EmojiSearchForm = ReturnType<typeof useEmojiSearch>["form"]

export const EmojiSearch = ({
  form,
  row,
  onPick,
  field,
}: {
  form: EmojiSearchForm
  /** The tapbacks, shown while nothing's typed. */
  row: ReactNode
  onPick: (emoji: Emoji) => void
  field?: Ref<HTMLInputElement>
}) => {
  const query = useSelector(form.store, (f) => f.values.query)
  const all = useQuery(emojiQuery).data ?? []
  const found = findEmoji(all, query, MOST)
  const [lit, setLit] = useState(0)
  const at = Math.min(lit, Math.max(found.length - 1, 0))
  return (
    <div className="flex min-w-[202px] flex-col gap-1">
      <div className="flex h-8 items-center gap-0.5">
        {query.trim() === ""
          ? row
          : found.map((e, i) => (
              <Button
                key={e}
                look="flat"
                aria-label={e}
                aria-pressed={i === at}
                onClick={() => {
                  onPick(e)
                }}
                className="size-8! rounded-full! p-0! text-[18px] outline-none! aria-pressed:held"
              >
                {e}
              </Button>
            ))}
      </div>
      <form.Field name="query">
        {(f) => (
          <input
            ref={field}
            aria-label="Emoji"
            placeholder="Search…"
            value={f.state.value}
            onChange={(e) => {
              setLit(0)
              f.handleChange(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
              if (step !== undefined && found.length > 0) {
                e.preventDefault()
                setLit((at + step + found.length) % found.length)
              } else if (e.key === "Enter") {
                e.preventDefault()
                const pick = found[at]
                if (pick !== undefined) {
                  onPick(pick)
                }
              }
            }}
            className="h-7 w-full min-w-0 rounded-key border border-line-2 bg-bg px-2 text-ui text-ink outline-none select-text placeholder:text-ink3 focus:border-ink3"
          />
        )}
      </form.Field>
    </div>
  )
}
