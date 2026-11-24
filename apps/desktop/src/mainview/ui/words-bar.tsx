// Words selected in a bubble of a space's chat: a small bar over them, with Reply (it attaches them
// to the box) and the six tapbacks and any emoji by the search under them, which go on those words
// alone. The search takes the focus at the first key typed, so the words stay selected till then.
import type { SpaceId } from "@switch/brain"
import { Popover } from "@base-ui/react/popover"
import { useMutation } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"

import { partOf } from "../brain/history.ts"
import { reactMutation } from "../brain/mutations.ts"
import { REACTIONS } from "@switch/brain/commands"
import type { Reaction } from "@switch/brain/commands"
import { queryClient } from "../query.ts"
import { focusBox } from "./box.tsx"
import { Button } from "./kit/button.tsx"
import { FLOAT } from "./kit/float.ts"
import { attachReply } from "./replying.ts"
import { EmojiSearch, useEmojiSearch } from "./emoji-search.tsx"
import { Glyph, nameOf } from "./tapback.tsx"

interface Chosen {
  readonly seq: number
  readonly text: string
  readonly range: Range
  readonly bubble: Element
}

/** Typing in the search moves the selection into it: the words stay chosen. */
const inField = (field: HTMLInputElement | null, target: EventTarget | null) =>
  target instanceof Node && field?.contains(target) === true

const elementOf = (n: Node) => (n instanceof Element ? n : n.parentElement)

/** The words selected now, when they're all in one bubble of this chat. */
const chosenIn = (space: SpaceId): Chosen | null => {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return null
  }
  const range = sel.getRangeAt(0)
  const bubble = elementOf(range.startContainer)?.closest<HTMLElement>("[data-seq]")
  const text = sel.toString().trim()
  if (
    !bubble ||
    bubble !== elementOf(range.endContainer)?.closest<HTMLElement>("[data-seq]") ||
    bubble.closest<HTMLElement>("[data-chat]")?.dataset.chat !== space ||
    text === ""
  ) {
    return null
  }
  return { seq: Number(bubble.dataset.seq), text, range: range.cloneRange(), bubble }
}

export const WordsBar = ({ space }: { space: SpaceId }) => {
  const [chosen, setChosen] = useState<Chosen | null>(null)
  const react = useMutation(reactMutation)
  const search = useEmojiSearch()
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const up = (e: MouseEvent) => {
      if (inField(field.current, e.target)) {
        return
      }
      // The selection settles after the press is let go.
      requestAnimationFrame(() => {
        setChosen(chosenIn(space))
      })
    }
    const changed = () => {
      if (
        !inField(field.current, document.activeElement) &&
        window.getSelection()?.isCollapsed !== false
      ) {
        setChosen(null)
      }
    }
    document.addEventListener("mouseup", up)
    document.addEventListener("selectionchange", changed)
    return () => {
      document.removeEventListener("mouseup", up)
      document.removeEventListener("selectionchange", changed)
    }
  }, [space])
  // The first key typed while the bar is up goes to the search.
  useEffect(() => {
    const typed = (e: KeyboardEvent) => {
      if (
        e.key.length === 1 &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !inField(field.current, e.target)
      ) {
        field.current?.focus()
      }
    }
    const on = chosen === null ? null : document
    on?.addEventListener("keydown", typed)
    return () => {
      document.removeEventListener("keydown", typed)
    }
  }, [chosen])
  const done = () => {
    window.getSelection()?.removeAllRanges()
    search.clear()
    setChosen(null)
  }
  const was = chosen ? partOf(queryClient, chosen.seq, chosen.text) : undefined
  const pick = (reaction: Reaction) => {
    if (chosen) {
      react.mutate({
        seq: chosen.seq,
        reaction,
        quote: chosen.text,
        ...(was !== undefined && { was }),
      })
    }
    done()
  }
  return (
    <Popover.Root
      open={chosen !== null}
      onOpenChange={(open, details) => {
        // Esc clears what's typed first.
        if (!open && details.reason === "escape-key" && search.typed) {
          search.clear()
          return
        }
        if (!open) {
          search.clear()
          setChosen(null)
        }
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={
            chosen && {
              getBoundingClientRect: () =>
                chosen.range.getClientRects()[0] ?? chosen.range.getBoundingClientRect(),
              contextElement: chosen.bubble,
            }
          }
          side="top"
          sideOffset={6}
        >
          <Popover.Popup
            initialFocus={false}
            finalFocus={false}
            // A press on the bar keeps the words selected; one on the search goes into it.
            onMouseDown={(e) => {
              if (!inField(field.current, e.target)) {
                e.preventDefault()
              }
            }}
            className={`${FLOAT} flex items-start gap-0.5 p-1`}
          >
            <Button
              look="flat"
              onClick={() => {
                if (chosen) {
                  attachReply(space, { kind: "quote", seq: chosen.seq, text: chosen.text })
                }
                done()
                focusBox()
              }}
              className="h-8! rounded-full! px-2.5! text-ink outline-none!"
            >
              Reply
            </Button>
            <EmojiSearch
              form={search.form}
              field={field}
              onPick={pick}
              row={REACTIONS.map((r) => (
                <Button
                  key={r}
                  look="flat"
                  aria-label={nameOf(r)}
                  aria-pressed={was === r}
                  onClick={() => {
                    pick(r)
                  }}
                  className="size-8! rounded-full! p-0! outline-none! aria-pressed:held"
                >
                  <Glyph reaction={r} />
                </Button>
              ))}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
